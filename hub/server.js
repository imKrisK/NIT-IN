'use strict';

/**
 * NIT-IN Hub Server
 * Express HTTP + WebSocket — serves dashboard and real-time node events
 *
 * Start modes:
 *   npm start         — hardware mode (USB serial, 20 Arduinos)
 *   npm run sim       — simulator mode (20 virtual NIT nodes)
 */

const express  = require('express');
const http     = require('http');
const path     = require('path');
const { WebSocketServer } = require('ws');
const { generateKeyPairSync, createPublicKey, verify: ed25519Verify } = require('crypto');

const db                                        = require('./db');
const registry                                  = require('./nit-registry');
const { startDiscovery, setBroadcast, handleMessage } = require('./serial-bridge');
const { evaluateNetworkReaction }       = require('./resonance');
const federation                        = require('./federation');

const PORT       = process.env.PORT || 3001;
const SIMULATE   = process.argv.includes('--simulate') || process.env.SIMULATE === 'true';
const HUB_SECRET = process.env.HUB_SECRET;

// ── Plan limits ───────────────────────────────────────────────────
const PLAN_NODE_LIMITS = { free: 1, starter: 1, hub: 5, signal: 20, enterprise: Infinity };

function getUserPlan(email) {
  if (!email) return 'free';
  const row = db.prepare('SELECT plan FROM users WHERE email = ?').get(email);
  return row?.plan || 'free';
}

function getNodeCount(owner_email) {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE data LIKE ?').get(`%"owner_email":"${owner_email}"%`);
  return row?.cnt ?? 0;
}

// Phase 33: SQLite persistence for fleetHealth.
// Set NIT_IN_HUB_PERSISTENCE=true to survive hub restarts without a cold-start storm.
// Defaults to false so existing test/sim environments are unchanged.
const FLEET_PERSIST = process.env.NIT_IN_HUB_PERSISTENCE === 'true';

// ── In-memory rate limiter ────────────────────────────────────────
// Buckets reset every RATE_WINDOW_MS. Keeps O(active nodes) memory.
const RATE_WINDOW_MS  = 60_000; // 1 minute window
const RATE_LIMITS     = {
  signal: 10,  // max 10 signals/min per NIT
  dm:     20,  // max 20 DMs/min per NIT
};
const _rateBuckets    = new Map(); // `${kind}:${nit_id}` → { count, windowStart }

function checkRateLimit(kind, nit_id) {
  const key  = `${kind}:${nit_id}`;
  const now  = Date.now();
  const rec  = _rateBuckets.get(key);

  if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) {
    _rateBuckets.set(key, { count: 1, windowStart: now });
    return null; // OK
  }
  rec.count++;
  if (rec.count > RATE_LIMITS[kind]) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - rec.windowStart)) / 1000);
    return retryAfter;
  }
  return null; // OK
}

// Purge stale buckets every 5 minutes to avoid unbounded growth
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [k, v] of _rateBuckets) {
    if (v.windowStart < cutoff) _rateBuckets.delete(k);
  }
}, 5 * 60_000);

// ── Auth middleware ───────────────────────────────────────────────
if (!HUB_SECRET) {
  console.error('[AUTH] HUB_SECRET environment variable is required');
  process.exit(1);
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== HUB_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Resonance gate — node must have at least one established resonance edge to post.
// An edge is only created when two nodes score >= RESONANCE_THRESHOLD (0.60).
// Raw score is not used here because SRAM/uptime similarity inflates new-node scores.
const FOUNDER_ID = 'NIT-USR-0001';

// ── WebSocket session registry (nit_id → live connections) ───────
// Used for real-time DM routing. Populated by 'identify' WS messages.
const sessions = new Map(); // nit_id -> Set<WebSocket>

function deliverDm(nit_id, payload) {
  const conns = sessions.get(nit_id);
  if (!conns || !conns.size) return false;
  const str = JSON.stringify(payload);
  let sent = false;
  for (const ws of conns) {
    if (ws.readyState === 1) { ws.send(str); sent = true; }
  }
  return sent;
}

// ── Phase 20: Runtime Logic Enforcement ──────────────────────────
// Calls TWIN /api/cai/enforce before routing signals or DMs.
// Fail-open: if TWIN is unreachable, the event is permitted.
const TWIN_ENFORCE_URL = process.env.TWIN_ENFORCE_URL
  || 'https://twin.conversationmine.ai/api/cai/enforce';

async function checkManifestEnforcement(nit_id, action, token_fingerprint) {
  try {
    const res = await fetch(TWIN_ENFORCE_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ nit_id, action, platform: 'nit-in', token_fingerprint }),
      signal:  AbortSignal.timeout(3000),
    });
    if (!res.ok) return { permitted: true };  // fail-open on non-2xx
    return await res.json();
  } catch {
    return { permitted: true };  // fail-open on network error / timeout
  }
}

// ── Phase 22: Community Wellness — Contextual Sentiment Classifier ─
// Distinguishes personal harassment from aggressive technical debate
// so the Refiner can distinguish real harm signals from healthy friction.
const _HARASSMENT_KW = [
  'kill yourself', 'kys', ' die ', 'worthless', 'stupid fuck', 'piece of shit',
  'moron', 'loser', 'hate you', 'garbage human', 'trash human', 'go die',
];
const _TECHNICAL_KW = [
  'wrong', 'incorrect', 'broken', 'fails', 'bug ', 'error ', 'invalid',
  'disagree', 'bad design', 'terrible code', 'worst', 'awful implementation',
  'this sucks', 'terrible', 'horrible code',
];
const _SUPPORTIVE_KW = [
  'thanks', 'thank you', 'great work', 'love this', 'helpful', 'appreciate',
  'excellent', 'well done', 'nice work', 'perfect', 'awesome', 'respect',
  'good job', 'brilliant',
];

function classifySentiment(msg) {
  const lower = msg.toLowerCase();
  for (const kw of _HARASSMENT_KW) {
    if (lower.includes(kw)) return { context: 'personal_harassment', confidence: 0.85 };
  }
  const techHits  = _TECHNICAL_KW.filter(kw => lower.includes(kw)).length;
  const suppHits  = _SUPPORTIVE_KW.filter(kw => lower.includes(kw)).length;
  if (techHits >= 2) return { context: 'aggressive_technical', confidence: Math.min(0.5 + techHits * 0.1, 0.9) };
  if (suppHits >= 1) return { context: 'supportive',           confidence: Math.min(0.5 + suppHits * 0.15, 0.9) };
  return { context: 'neutral', confidence: 0.7 };
}

function requireResonance(req, res, next) {
  const node_id = req.body?.node_id;
  if (!node_id || node_id === FOUNDER_ID) return next(); // founder always passes
  const node = registry.getAllNodes().find(n => n.node_id === node_id);
  if (!node) return res.status(404).json({ error: 'node not found' });
  if (!node.connections || node.connections.length === 0) {
    return res.status(403).json({
      error:       'resonance_gated',
      connections: 0,
      msg:         'Node has no resonance connections — interact with the network first',
    });
  }
  next();
}

// ── Express ───────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

app.get('/api/nodes',  (_req, res) => res.json(registry.getAllNodes()));
app.get('/api/feed',   (req,  res) => res.json(registry.getFeed(Number(req.query.limit) || 50)));
app.get('/api/graph',  (_req, res) => res.json(registry.getGraphData()));
app.get('/api/stats',   (_req, res) => res.json(registry.getStats()));
app.get('/api/peers',   (_req, res) => res.json(federation.getPeers()));

// Phase 31 — Federation cluster registry (LAN UDP peers + TWIN HTTP subscribers)
// Merges NIT-IN's local UDP peer list with the TWIN governance federation registry.
app.get('/api/federation/clusters', async (_req, res) => {
  const udpPeers   = federation.getPeers();
  const twinBase   = process.env.TWIN_BASE_URL || '';
  const twinSecret = process.env.TWIN_SHARED_SECRET || '';
  let   twinPeers  = [];

  if (twinBase && twinSecret) {
    try {
      const resp = await fetch(`${twinBase}/api/governance/federation/peers`, {
        headers: { 'X-Twin-Key': twinSecret },
        signal:  AbortSignal.timeout(6000),
      });
      if (resp.ok) {
        const body = await resp.json();
        twinPeers  = body.peers || [];
      }
    } catch (err) {
      console.warn('[Federation] TWIN peer fetch failed:', err.message);
    }
  }

  res.json({
    hub_id:           federation.HUB_ID,
    lan_peers:        udpPeers,
    lan_peer_count:   udpPeers.length,
    twin_clusters:    twinPeers,
    twin_cluster_count: twinPeers.length,
    total_mesh_size:  udpPeers.length + twinPeers.length + 1,
    ts:               new Date().toISOString(),
  });
});

// Combined network snapshot (local + federation)
app.get('/api/network', (_req, res) => {
  const stats = registry.getStats();
  const peers = federation.getPeers();
  res.json({
    hub_id:         federation.HUB_ID,
    mode:           SIMULATE ? 'simulator' : 'hardware',
    local:          stats,
    peers,
    peer_count:     peers.length,
    connected_peers: peers.filter(p => p.connected).length,
  });
});

// Admin page
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '../public/admin.html')));

// Admin API — clear feed
app.post('/api/admin/clear-feed', requireAuth, (_req, res) => {
  db.clearFeed();
  registry.clearFeed();
  broadcast('feed:cleared', {});
  res.json({ ok: true });
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true, mode: SIMULATE ? 'sim' : 'hardware' }));

// ── Phase 23: Encrypted External Audit Notification Protocol ─────────────────
// TWIN POSTs encrypted audit envelopes here. NIT-IN verifies the HMAC tag,
// broadcasts audit:external to all connected operator WebSocket sessions, and
// stores a local record for the operator dashboard.
// Envelope format: base64( nonce[16] | XOR-ciphertext | HMAC-SHA256-tag[32] )
// Key material: TWIN_SHARED_SECRET + nonce via PBKDF2-SHA256.
// ─────────────────────────────────────────────────────────────────────────────
const { createHmac: _auditHmac, pbkdf2Sync: _pbkdf2 } = require('crypto');
const TWIN_AUDIT_SECRET = process.env.TWIN_SHARED_SECRET || '';

function _decryptAuditEnvelope(b64) {
  const buf        = Buffer.from(b64, 'base64');
  if (buf.length < 49) throw new Error('envelope too short');   // 16 nonce + 1 min data + 32 tag
  const nonce      = buf.subarray(0, 16);
  const tag        = buf.subarray(buf.length - 32);
  const ciphertext = buf.subarray(16, buf.length - 32);
  // Verify HMAC-SHA256 tag before decryption
  const expectedTag = _auditHmac('sha256', TWIN_AUDIT_SECRET)
    .update(Buffer.concat([nonce, ciphertext])).digest();
  if (!expectedTag.equals(tag)) throw new Error('HMAC verification failed — envelope tampered or wrong secret');
  // Derive keystream via PBKDF2-SHA256(secret, nonce, 1 iter, len=ciphertext.length)
  const key       = _pbkdf2(TWIN_AUDIT_SECRET, nonce, 1, ciphertext.length, 'sha256');
  const plaintext = Buffer.from(ciphertext.map((b, i) => b ^ key[i]));
  return JSON.parse(plaintext.toString('utf8'));
}

const _auditLog = [];   // in-memory ring buffer (last 200 audits — operator dashboard)
const AUDIT_LOG_MAX = 200;

app.post('/api/audit/notify', requireAuth, (req, res) => {
  const { audit_type, envelope, ts: auditTs, twin_instance } = req.body || {};
  if (!audit_type || !envelope) {
    return res.status(400).json({ error: 'audit_type and envelope required' });
  }
  let payload = null;
  let verified = false;
  try {
    if (TWIN_AUDIT_SECRET) {
      payload  = _decryptAuditEnvelope(envelope);
      verified = true;
    }
  } catch (err) {
    console.error('[AUDIT] Envelope verification failed:', err.message);
    return res.status(422).json({ error: 'envelope_verification_failed', detail: err.message });
  }
  const record = {
    audit_type,
    ts:            auditTs || new Date().toISOString(),
    twin_instance: twin_instance || 'unknown',
    verified,
    payload,       // decrypted only when TWIN_AUDIT_SECRET is set; null otherwise
    received_at:   Date.now(),
  };
  _auditLog.unshift(record);
  if (_auditLog.length > AUDIT_LOG_MAX) _auditLog.length = AUDIT_LOG_MAX;
  // Broadcast encrypted notification to all connected operator WebSocket sessions
  broadcast('audit:external', {
    audit_type,
    ts:            record.ts,
    twin_instance: record.twin_instance,
    verified,
    // Broadcast only the decrypted summary (not raw probe data) to WebSocket clients
    summary:       payload ? {
      type:                 payload.type,
      classification:       payload.classification,
      hr_similarity:        payload.hr_similarity,
      sensitivity_score:    payload.sensitivity_score,
      shadow_canary_triggered: payload.shadow_canary_triggered,
      architect_paused:     payload.architect_paused,
      pause_reason:         payload.pause_reason,
      bypassed_count:       payload.bypassed_count,
      acknowledge_via:      payload.acknowledge_via,
      recommendation:       payload.recommendation,
    } : null,
    envelope,      // forward full envelope for operator clients that hold the secret
  });
  console.log(`[AUDIT] ${audit_type} received from ${twin_instance} — verified=${verified} — broadcast to operator`);
  return res.json({ ok: true, verified, ts: record.ts });
});

// GET /api/audit/log — operator dashboard: list last N audit records (requireAuth)
app.get('/api/audit/log', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, AUDIT_LOG_MAX);
  const type  = (req.query.type || '').toUpperCase();
  const items = type ? _auditLog.filter(r => r.audit_type === type) : _auditLog;
  res.json({ total: items.length, limit, items: items.slice(0, limit) });
});

// ─── Phase 28: ZK Compliance Proof endpoints ────────────────────────────────
// Requires X-Hub-Secret (same as requireAuth).

const zk = require('./zk');

// POST /api/audit/zk-commit
// Arduino Linux core posts proof + public_signals here after each 30-min batch.
// NIT-IN verifies on receipt and stores commitment.
// Body: { proof, public_signals, metadata: { principle_id, arduino_node_id,
//         circuit_vkey_hash, ... } }
//
// Phase 28.1 — Artifact Desync Guard:
//   metadata.circuit_vkey_hash must match the Hub's ratified verification_key.json.
//   Mismatch → 409 VK_MISMATCH. The proof is NOT stored (it cannot be verified).
app.post('/api/audit/zk-commit', requireAuth, async (req, res) => {
  const { ok, error } = zk.validateCommitBody(req.body);
  if (!ok) return res.status(400).json({ error });

  const { proof, public_signals, metadata } = req.body;

  // ── Artifact Desync Guard ──────────────────────────────────────────
  const hubHash    = zk.getHubVkeyHash();
  const proverHash = (metadata.circuit_vkey_hash || '').toLowerCase();
  const vkeyCheck  = zk.checkVkeyHash(proverHash);

  if (hubHash && proverHash && !vkeyCheck.match) {
    console.error(
      `[ZK-COMMIT] VK_MISMATCH — node=${metadata.arduino_node_id} ` +
      `prover_hash=${proverHash.slice(0,16)}… hub_hash=${hubHash.slice(0,16)}…`
    );
    return res.status(409).json({
      error:         'VK_MISMATCH',
      detail:        'The circuit verification key used by the prover does not match the Hub\'s ratified key. ' +
                     'Re-run scripts/zk_setup.sh and re-sync circuits/build/ to the Arduino Linux core.',
      prover_hash:   proverHash.slice(0, 16) + '…',
      hub_hash:      hubHash.slice(0, 16) + '…',
    });
  }

  if (!proverHash) {
    console.warn(`[ZK-COMMIT] No circuit_vkey_hash in metadata — accepting but flagging vkey_match=false`);
  }

  // ── Cryptographic verification ─────────────────────────────────────
  let verified = false;
  if (zk.artifactsReady()) {
    try {
      verified = await zk.verifyCompliance(proof, public_signals);
    } catch (err) {
      console.error('[ZK-COMMIT] Verification error:', err.message);
    }
  } else {
    console.warn('[ZK-COMMIT] ZK artifacts not built — storing proof without server-side verify');
  }

  // public_signals order: [principle_id_hash, time_start, time_end, event_count, blocked_count, batch_commitment]
  const batchCommitment = public_signals[5] || '';
  const commitmentId    = `zk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  db.saveZkCommit({
    id:               commitmentId,
    principle_id:     metadata.principle_id,
    batch_time_start: Number(metadata.batch_time_start || public_signals[1]) || 0,
    batch_time_end:   Number(metadata.batch_time_end   || public_signals[2]) || 0,
    event_count:      Number(metadata.event_count      || public_signals[3]) || 0,
    blocked_count:    Number(metadata.blocked_count    || public_signals[4]) || 0,
    batch_commitment: batchCommitment,
    proof,
    public_signals,
    verified,
    circuit_vkey_hash: proverHash || null,
    hub_vkey_hash:     hubHash    || null,
    vkey_match:        vkeyCheck.match,
    arduino_node_id:  metadata.arduino_node_id  || null,
    twin_instance:    metadata.twin_instance     || null,
  });

  // Broadcast to operator WebSocket dashboard
  broadcast('zk:commit', {
    commitment_id:    commitmentId,
    principle_id:     metadata.principle_id,
    arduino_node_id:  metadata.arduino_node_id,
    event_count:      metadata.event_count,
    blocked_count:    metadata.blocked_count,
    verified,
    vkey_match:       vkeyCheck.match,
    batch_commitment: batchCommitment,
    ts:               new Date().toISOString(),
  });

  console.log(`[ZK-COMMIT] ${commitmentId} — principle=${metadata.principle_id} ` +
              `node=${metadata.arduino_node_id} events=${metadata.event_count} ` +
              `blocked=${metadata.blocked_count} verified=${verified} vkey_match=${vkeyCheck.match}`);

  res.json({
    commitment_id:    commitmentId,
    verified,
    vkey_match:       vkeyCheck.match,
    artifacts_ready:  zk.artifactsReady(),
    ts:               new Date().toISOString(),
  });
});

// GET /api/audit/zk-verify/:id
// Re-run Groth16 verifier against a stored commitment. Returns { verified: bool }.
app.get('/api/audit/zk-verify/:id', requireAuth, async (req, res) => {
  const record = db.loadZkCommit(req.params.id);
  if (!record) return res.status(404).json({ error: 'commitment not found' });

  if (!zk.artifactsReady()) {
    return res.status(503).json({
      error:           'ZK artifacts not built on this server',
      commitment_id:   record.id,
      stored_verified: record.verified === 1,
    });
  }

  let verified = false;
  try {
    verified = await zk.verifyCompliance(record.proof, record.public_signals);
  } catch (err) {
    return res.status(500).json({ error: 'verifier error: ' + err.message });
  }

  // Persist updated verified state
  db.markZkVerified(record.id, verified);

  res.json({
    commitment_id:    record.id,
    principle_id:     record.principle_id,
    arduino_node_id:  record.arduino_node_id,
    verified,
    batch_commitment: record.batch_commitment,
    event_count:      record.event_count,
    blocked_count:    record.blocked_count,
    batch_time_start: record.batch_time_start,
    batch_time_end:   record.batch_time_end,
    created_at:       record.created_at,
  });
});

// GET /api/audit/zk-log?limit=50&principle_id=P-009
// List recent ZK commitments for the operator dashboard.
app.get('/api/audit/zk-log', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const principleId = (req.query.principle_id || '').trim();
  const items = principleId
    ? db.loadZkByPrinciple(principleId, limit)
    : db.loadZkLog(limit);
  // Strip full proof from list view — available via /zk-verify/:id
  const slim = items.map(({ proof, public_signals, ...rest }) => ({
    ...rest,
    public_signals_count: Array.isArray(public_signals) ? public_signals.length : 0,
  }));
  res.json({ total: slim.length, items: slim });
});
// ────────────────────────────────────────────────────────────────────────────

// Onboard page
app.get('/onboard', (_req, res) => res.sendFile(path.join(__dirname, '../public/onboard.html')));

// Social feed page
app.get('/social', (_req, res) => res.sendFile(path.join(__dirname, '../public/social.html')));

// Profile page
app.get('/profile/:nit_id', (_req, res) => res.sendFile(path.join(__dirname, '../public/profile.html')));

// Node detail API
app.get('/api/nodes/:nit_id', (req, res) => {
  const nodes = registry.getAllNodes();
  const node  = nodes.find(n => n.node_id === req.params.nit_id);
  if (!node) return res.status(404).json({ error: 'node not found' });

  // Gather edges for this node
  const graph = registry.getGraphData();
  const edges = graph.edges.filter(e =>
    e.source === node.node_id || e.target === node.node_id
  ).map(e => ({
    ...e,
    peer: e.source === node.node_id ? e.target : e.source,
  }));

  // Posts authored by this node
  const posts = registry.getFeed(200).filter(p => p.node_id === node.node_id);

  res.json({ node, edges, posts });
});

// ── User NIT Minting ──────────────────────────────────────────────

// ── Founding Node — Genesis Block (registered at boot after hydrate) ──
const GENESIS_NODE = {
  node_id:   'NIT-USR-0001',
  hw_sig:    '338061C968FA0250',
  name:      'imacKris',
  node_type: 'human',
  capabilities: {
    sensors:  ['VOICE_PRINT', 'MEMORY_TRACE', 'IDENTITY_BEACON'],
    sram_bytes: 4096,
    firmware:  'BIRTH_RIGHTS_v1.0',
  },
  uptime:    0,
  free_mem:  4096,
  genesis:   '2026-05-05T00:00:00.000Z',
  sovereign: true,
};

let userNodeCounter = 1; // 0001 is the Founder — set after hydrate in boot

function _simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}

const ALL_HUMAN_SENSORS = [
  'VOICE_PRINT', 'LOCATION_PULSE', 'HEART_RATE',
  'ATTENTION_DEPTH', 'TEMPORAL_STAMP', 'RESONANCE_FIELD',
  'MEMORY_TRACE', 'IDENTITY_BEACON',
];

app.post('/api/mint', requireAuth, (req, res) => {
  const raw = req.body?.name;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'name required' });
  }
  const name = raw.trim().slice(0, 64);
  if (!name) return res.status(400).json({ error: 'name must not be empty' });

  // Plan-based node limit enforcement
  const owner_email = req.body?.owner_email || null;
  if (owner_email) {
    const plan = getUserPlan(owner_email);
    const limit = PLAN_NODE_LIMITS[plan] ?? 1;
    if (limit !== Infinity && getNodeCount(owner_email) >= limit) {
      return res.status(403).json({
        error: 'node_limit_reached',
        plan,
        limit,
        message: `Your ${plan} plan allows ${limit} NIT node(s). Upgrade at /pricing to add more.`,
      });
    }
  }

  userNodeCounter++;
  const node_id = `NIT-USR-${String(userNodeCounter).padStart(4, '0')}`;

  const hash = _simpleHash(name);
  const hw_sig = (hash.toString(16).padStart(8, '0') +
                  _simpleHash(name + 'nit-in').toString(16).padStart(8, '0')).toUpperCase();

  const sensorCount = 2 + (hash % 2); // 2 or 3 sensors
  const sensors = [];
  for (let i = 0; i < ALL_HUMAN_SENSORS.length && sensors.length < sensorCount; i++) {
    const idx = (_simpleHash(name + i) ) % ALL_HUMAN_SENSORS.length;
    const s = ALL_HUMAN_SENSORS[idx];
    if (!sensors.includes(s)) sensors.push(s);
  }

  const profile = {
    node_id,
    hw_sig,
    name,
    node_type: 'human',
    capabilities: {
      sensors,
      sram_bytes: 4096,
      firmware: 'BIRTH_RIGHTS_v1.0',
    },
    uptime: 0,
    free_mem: 4096,
  };

  // Ed25519 keypair — pub_key stored on hub, priv_key returned ONCE to client
  const { publicKey: pubDer, privateKey: privDer } = generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  profile.pub_key = pubDer.toString('base64');
  const priv_key  = privDer.toString('base64'); // never stored server-side

  // Derive a globally portable fingerprint: first 16 hex chars of SHA-256(pubkey DER)
  const { createHash: _createHash } = require('crypto');
  profile.nit_fingerprint = 'NIT-' + _createHash('sha256').update(pubDer).digest('hex').slice(0, 16).toUpperCase();

  const node = registry.registerNode(profile);
  const { reactions, newPosts } = evaluateNetworkReaction(node_id);

  for (const post of newPosts) broadcast('feed:post', post);
  broadcast('node:registered', { node, reactions });

  res.json({ node, reactions: reactions.filter(r => r.reaction === 'RESONATE').length, priv_key });
});

// ── Cross-platform token helper ─────────────────────────────────
const { createHmac } = require('crypto');

function _xpPayload(nit_id, fingerprint, expiry) {
  return `${nit_id}:${fingerprint}:${expiry}`;
}

function verifyXPToken(nit_id, token) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const payloadB64 = token.slice(0, dot);
    const sig        = token.slice(dot + 1);
    const payload    = Buffer.from(payloadB64, 'base64').toString();
    const parts      = payload.split(':');
    if (parts.length < 3) return false;
    const [tokenNitId, , expiry] = parts;
    if (tokenNitId !== nit_id) return false;
    if (parseInt(expiry, 10) < Math.floor(Date.now() / 1000)) return false;
    const secret   = HUB_SECRET;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    // Constant-time comparison
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

// ── POST /api/challenge — issue a one-time sign challenge ─────────
// Client sends nit_id → server returns a 32-byte hex challenge.
// Client signs the challenge bytes with their Ed25519 private key
// and sends the signature back to /api/verify.
app.post('/api/challenge', (req, res) => {
  const { nit_id } = req.body || {};
  if (!nit_id || typeof nit_id !== 'string') {
    return res.status(400).json({ error: 'nit_id required' });
  }
  const node = registry.getAllNodes().find(n => n.node_id === nit_id);
  if (!node)           return res.status(404).json({ error: 'NIT-ID not found' });
  if (!node.pub_key)   return res.status(400).json({ error: 'node has no Ed25519 key — re-mint required' });

  const { randomBytes } = require('crypto');
  const challenge = randomBytes(32).toString('hex');
  db.saveChallenge(nit_id, challenge);

  res.json({ challenge, expires_in: 300 });
});

// ── POST /api/verify — verify Ed25519 sig, issue cross-platform token
// Body: { nit_id, challenge, sig }  (sig = base64(Ed25519Sign(challenge_bytes, priv_key)))
app.post('/api/verify', (req, res) => {
  const { nit_id, challenge, sig } = req.body || {};
  if (!nit_id || !challenge || !sig) {
    return res.status(400).json({ error: 'nit_id, challenge, sig required' });
  }

  const node = registry.getAllNodes().find(n => n.node_id === nit_id);
  if (!node)         return res.status(404).json({ error: 'NIT-ID not found' });
  if (!node.pub_key) return res.status(400).json({ error: 'node has no Ed25519 key' });

  // Validate challenge: exists, belongs to nit_id, unused, not expired (5 min)
  const stored = db.loadChallenge(challenge);
  if (!stored)                    return res.status(401).json({ error: 'invalid challenge' });
  if (stored.nit_id !== nit_id)   return res.status(401).json({ error: 'challenge mismatch' });
  if (stored.used)                return res.status(401).json({ error: 'challenge already used' });
  const age = Math.floor(Date.now() / 1000) - stored.created_at;
  if (age > 300)                  return res.status(401).json({ error: 'challenge expired' });

  // Verify Ed25519 signature over raw challenge bytes
  try {
    const pubKey = createPublicKey({ key: Buffer.from(node.pub_key, 'base64'), format: 'der', type: 'spki' });
    const valid  = ed25519Verify(null, Buffer.from(challenge), pubKey, Buffer.from(sig, 'base64'));
    if (!valid) return res.status(401).json({ error: 'invalid signature' });
  } catch {
    return res.status(400).json({ error: 'signature verification failed' });
  }

  // One-time use — mark consumed immediately
  db.markChallengeUsed(challenge);

  // Issue cross-platform token: base64(payload).HMAC-SHA256(payload, HUB_SECRET)
  // Payload = "nit_id:fingerprint:expiry_unix"
  const ts          = Math.floor(Date.now() / 1000);
  const expiry      = ts + 3600; // 1 hour
  const fingerprint = node.nit_fingerprint || node.hw_sig;
  const payload     = _xpPayload(nit_id, fingerprint, expiry);
  const secret      = HUB_SECRET;
  const hmac        = createHmac('sha256', secret).update(payload).digest('hex');
  const xpToken     = `${Buffer.from(payload).toString('base64')}.${hmac}`;

  res.json({
    verified:            true,
    nit_id,
    fingerprint,
    cross_platform_token: xpToken,
    expires_at:          expiry,
    patent_ref:          'USPTO-19/668,817',
  });
});

// ── POST /api/bind — record platform binding after successful verify ─
// Called by external platforms (KIRO, TWIN, etc.) after they receive a
// cross_platform_token from /api/verify.
// Body: { nit_id, platform, cross_platform_token }
const BINDABLE_PLATFORMS = new Set([
  'kiro', 'twin', 'manifest', 'uspto', 'iot-maker', 'bwm',
  'medical', 'legal', 'contract', 'paralegal', 'conversationmine', 'nit-in',
]);

app.post('/api/bind', (req, res) => {
  const { nit_id, platform, cross_platform_token } = req.body || {};
  if (!nit_id || !platform || !cross_platform_token) {
    return res.status(400).json({ error: 'nit_id, platform, cross_platform_token required' });
  }
  if (!verifyXPToken(nit_id, cross_platform_token)) {
    return res.status(401).json({ error: 'invalid or expired cross_platform_token' });
  }
  const safePlatform = platform.toLowerCase().trim();
  if (!BINDABLE_PLATFORMS.has(safePlatform)) {
    return res.status(400).json({ error: 'unknown platform', valid_platforms: [...BINDABLE_PLATFORMS] });
  }
  db.savePlatformBinding(nit_id, safePlatform);
  res.json({ ok: true, nit_id, platform: safePlatform });
});

// ── POST /api/validate-token — external platforms validate a cross_platform_token
// Body: { nit_id, cross_platform_token }
// Returns { valid, nit_id, fingerprint, platform_bindings } or 401.
app.post('/api/validate-token', (req, res) => {
  const { nit_id, cross_platform_token } = req.body || {};
  if (!nit_id || !cross_platform_token) {
    return res.status(400).json({ error: 'nit_id and cross_platform_token required' });
  }
  if (!verifyXPToken(nit_id, cross_platform_token)) {
    return res.status(401).json({ valid: false, error: 'invalid or expired token' });
  }
  const node     = registry.getAllNodes().find(n => n.node_id === nit_id);
  const bindings = db.loadPlatformBindings(nit_id);
  res.json({
    valid:             true,
    nit_id,
    fingerprint:       node?.nit_fingerprint || null,
    name:              node?.name,
    platform_bindings: bindings,
  });
});

// ── GET /api/identity/:nit_id — full public identity record ──────
// Public endpoint — returns node identity + bound platforms.
// Private key is never exposed. Used by other platforms to look up a NIT-ID.
app.get('/api/identity/:nit_id', (req, res) => {
  const node = registry.getAllNodes().find(n => n.node_id === req.params.nit_id);
  if (!node) return res.status(404).json({ error: 'NIT-ID not found' });

  const bindings = db.loadPlatformBindings(req.params.nit_id);
  res.json({
    nit_id:            node.node_id,
    name:              node.name,
    display_name:      node.display_name,
    fingerprint:       node.nit_fingerprint || null,
    node_type:         node.node_type,
    sovereign:         node.sovereign || false,
    genesis:           node.genesis || node.first_seen,
    sensors:           node.capabilities?.sensors || [],
    pub_key:           node.pub_key,
    platform_bindings: bindings,
    patent_ref:        'USPTO-19/668,817',
    protocol:          'NIT-IN:BIRTH_RIGHTS_v1.0',
  });
});

// ── Node ownership claim ──────────────────────────────────────────────────────
//
// POST /api/nit/claim
// Links a physical hardware node (identified by nit_fingerprint) to a user
// account (identified by email). This is the bridge between the Birth Rights
// hardware identity layer and the billing/plan system.
//
// Auth flow:
//   1. User completes Stripe checkout → webhook creates users row (email, plan)
//   2. User powers on their Arduino/SBC → node mints nit_fingerprint via SRAM entropy
//   3. User visits /pricing → clicks "Claim your node" → POST /api/nit/claim
//   4. Hub verifies claim_token = HMAC-SHA256(HUB_SECRET, nit_fingerprint:email)
//   5. On success: sets owner_email on the node JSON + updates registry
//
// Security: claim_token proves the caller knows both the node fingerprint AND
// the platform secret — prevents one user from claiming another user's node.
// Without a signed token, only the hub itself (or the hardware device via
// X-Hub-Secret) can initiate a claim.

app.post('/api/nit/claim', requireAuth, (req, res) => {
  const { nit_fingerprint, email, claim_token } = req.body || {};
  if (!nit_fingerprint || !email) {
    return res.status(400).json({ error: 'nit_fingerprint and email required' });
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid email format' });
  }

  // Verify claim token — HMAC-SHA256(HUB_SECRET, "nit_fingerprint:email")
  const { createHmac: _claimHmac } = require('crypto');
  const expectedToken = _claimHmac('sha256', HUB_SECRET)
    .update(`${nit_fingerprint}:${email}`)
    .digest('hex');
  if (!claim_token || claim_token !== expectedToken) {
    return res.status(401).json({ error: 'invalid_claim_token', hint: 'Generate via POST /api/nit/claim-token' });
  }

  // Find the node in the registry
  const node = registry.getNodeByFingerprint
    ? registry.getNodeByFingerprint(nit_fingerprint)
    : registry.getAllNodes().find(n => n.nit_fingerprint === nit_fingerprint);

  if (!node) {
    return res.status(404).json({ error: 'node_not_found', nit_fingerprint });
  }

  // Check if already claimed by a different email
  if (node.owner_email && node.owner_email !== email) {
    return res.status(409).json({ error: 'already_claimed', owner: node.owner_email.split('@')[0] + '@…' });
  }

  // Plan limit check — does this user have capacity?
  const plan = getUserPlan(email);
  const limit = PLAN_NODE_LIMITS[plan] ?? 1;
  const current = getNodeCount(email);
  if (limit !== Infinity && current >= limit) {
    return res.status(403).json({
      error: 'node_limit_reached',
      plan,
      limit,
      message: `Your ${plan} plan allows ${limit} NIT node(s). Upgrade at /pricing.`,
    });
  }

  // Set owner_email on the node and persist
  node.owner_email = email;
  if (registry.updateNode) {
    registry.updateNode(node.nit_id, { owner_email: email });
  } else {
    db.prepare(`UPDATE nodes SET data = json_set(data, '$.owner_email', ?) WHERE id = ?`)
      .run(email, node.nit_id);
  }

  console.log(`[claim] ${nit_fingerprint} → ${email} (plan: ${plan})`);
  broadcast('node:claimed', { nit_id: node.nit_id, nit_fingerprint, plan });

  res.json({
    ok: true,
    nit_id:          node.nit_id,
    nit_fingerprint,
    owner_email:     email,
    plan,
    nodes_used:      current + 1,
    nodes_limit:     limit === Infinity ? 'unlimited' : limit,
    patent_ref:      'USPTO-19/668,817',
  });
});

// ── Claim token generator (server-side, for UI convenience) ──────────────────
// POST /api/nit/claim-token — returns the HMAC token for a given fingerprint+email.
// Protected by requireAuth so only authenticated hub operators can generate one.
// In production the device itself would generate this on-board.
app.post('/api/nit/claim-token', requireAuth, (req, res) => {
  const { nit_fingerprint, email } = req.body || {};
  if (!nit_fingerprint || !email) {
    return res.status(400).json({ error: 'nit_fingerprint and email required' });
  }
  const { createHmac: _ctHmac } = require('crypto');
  const token = _ctHmac('sha256', HUB_SECRET)
    .update(`${nit_fingerprint}:${email}`)
    .digest('hex');
  res.json({ claim_token: token, expires: 'single-use recommended — rotate after claim' });
});

// ── Human signal transmission ─────────────────────────────────────
app.post('/api/signal', requireAuth, requireResonance, async (req, res) => {
  const { node_id, msg, cross_platform_token } = req.body || {};
  if (!node_id || typeof msg !== 'string') {
    return res.status(400).json({ error: 'node_id and msg required' });
  }

  const retryAfter = checkRateLimit('signal', node_id);
  if (retryAfter !== null) {
    return res.status(429).json({ error: 'rate_limit', retry_after: retryAfter });
  }
  const safeMsg = msg.trim().slice(0, 280);
  if (!safeMsg) return res.status(400).json({ error: 'msg must not be empty' });

  const node = registry.getAllNodes().find(n => n.node_id === node_id);
  if (!node) return res.status(404).json({ error: 'node not found' });

  // Phase 20: Ed25519 / HMAC token verification (if token provided)
  let tokenFingerprint = null;
  if (cross_platform_token) {
    if (!verifyXPToken(node_id, cross_platform_token)) {
      return res.status(401).json({
        error:        'invalid_token',
        principle:    'P-010',
        msg:          'Token verification failed — Ed25519 HMAC invalid or expired. Re-authenticate via /api/verify.',
      });
    }
    // Extract payload (base64 portion before the dot) for expiry check at TWIN
    tokenFingerprint = cross_platform_token.split('.')[0];
  }

  // Phase 20: Constitutional enforcement check via TWIN
  const enforcement = await checkManifestEnforcement(node_id, 'signal', tokenFingerprint);
  if (enforcement.permitted === false) {
    return res.status(403).json({
      error:        'enforcement_blocked',
      reason:       enforcement.reason,
      principle_id: enforcement.blocked_by,
      msg:          'Data flow blocked by Manifest Constitutional Law',
    });
  }

  // Phase 22: Contextual sentiment classification
  const sentiment = classifySentiment(safeMsg);

  const post = registry.addPost({
    node_id,
    node_type: node.node_type || 'hardware',
    type:  'HUMAN_SIGNAL',
    msg:   safeMsg,
    sentiment_context:    sentiment.context,
    sentiment_confidence: sentiment.confidence,
  });

  broadcast('feed:post', post);
  res.json({ ok: true, post, sentiment_context: sentiment.context });
});

// ── Profile edit (bio, display name, avatar color) ────────────────
const EDITABLE = new Set(['bio', 'display_name', 'avatar_color', 'website', 'location']);

app.patch('/api/nodes/:nit_id', requireAuth, (req, res) => {
  const { nit_id } = req.params;
  const node = registry.getAllNodes().find(n => n.node_id === nit_id);
  if (!node) return res.status(404).json({ error: 'node not found' });

  const update = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!EDITABLE.has(k)) continue;
    if (typeof v !== 'string') continue;
    update[k] = v.trim().slice(0, 280);
  }
  if (!Object.keys(update).length) {
    return res.status(400).json({ error: 'no editable fields provided' });
  }

  const updated = registry.updateNode(nit_id, update);
  broadcast('node:updated', updated);
  res.json({ ok: true, node: updated });
});

// ── NIT Portable Credential Export ───────────────────────────────
// Returns a signed JSON credential for the node — downloadable identity.
// Signature = SHA-256(node_id + hw_sig + genesis + BIRTH_RIGHTS_v1.0)
app.get('/api/nodes/:nit_id/export', (req, res) => {
  const { createHash } = require('crypto');
  const node = registry.getAllNodes().find(n => n.node_id === req.params.nit_id);
  if (!node) return res.status(404).json({ error: 'node not found' });

  const payload = {
    protocol:   'NIT-IN:BIRTH_RIGHTS_v1.0',
    issued_at:  new Date().toISOString(),
    patent_ref: 'USPTO-19/668,817',
    node: {
      node_id:      node.node_id,
      name:         node.name,
      display_name: node.display_name,
      hw_sig:       node.hw_sig,
      node_type:    node.node_type,
      sensors:      node.capabilities?.sensors || [],
      firmware:     node.capabilities?.firmware || 'BIRTH_RIGHTS_v1.0',
      sovereign:    node.sovereign || false,
      genesis:      node.genesis || node.first_seen,
      bio:          node.bio,
      website:      node.website,
      location:     node.location,
    },
  };

  // Deterministic signature over stable fields
  const sigInput = [
    payload.node.node_id,
    payload.node.hw_sig,
    payload.node.genesis || '',
    payload.protocol,
  ].join(':');
  payload.sig = createHash('sha256').update(sigInput).digest('hex');

  res
    .set('Content-Disposition', `attachment; filename="${node.node_id}-credential.json"`)
    .json(payload);
});


// Identical to what serial-bridge processes from USB; lets virtual
// nodes and remote hardware POST telemetry without a physical cable.
app.post('/api/ingest', requireAuth, (req, res) => {
  const msg = req.body;
  if (!msg?.node_id || !msg?.type) {
    return res.status(400).json({ error: 'node_id and type required' });
  }
  handleMessage(msg);
  res.json({ ok: true });
});

// ── Public key lookup ─────────────────────────────────────────────
app.get('/api/nodes/:nit_id/pubkey', (req, res) => {
  const node = registry.getAllNodes().find(n => n.node_id === req.params.nit_id);
  if (!node) return res.status(404).json({ error: 'node not found' });
  if (!node.pub_key) return res.status(404).json({ error: 'node has no Ed25519 key' });
  res.json({ node_id: node.node_id, pub_key: node.pub_key });
});

// ── NIT-to-NIT Direct Messages ────────────────────────────────────
// Messages are Ed25519-signed by the sender.
// The server verifies authenticity before routing.
// msg content is authenticated but not E2E encrypted (v1 — upgrade path: X25519).
app.post('/api/dm', requireAuth, (req, res) => {
  const { from_nit_id, to_nit_id, msg, sig } = req.body || {};

  if (!from_nit_id || !to_nit_id || typeof msg !== 'string' || !sig) {
    return res.status(400).json({ error: 'from_nit_id, to_nit_id, msg, sig required' });
  }
  const safeMsg = msg.trim().slice(0, 1000);
  if (!safeMsg) return res.status(400).json({ error: 'msg must not be empty' });
  if (from_nit_id === to_nit_id) return res.status(400).json({ error: 'cannot DM yourself' });

  const dmRateAfter = checkRateLimit('dm', from_nit_id);
  if (dmRateAfter !== null) {
    return res.status(429).json({ error: 'rate_limit', retry_after: dmRateAfter });
  }

  const fromNode = registry.getAllNodes().find(n => n.node_id === from_nit_id);
  if (!fromNode) return res.status(404).json({ error: 'sender not found' });
  if (!fromNode.pub_key) return res.status(400).json({ error: 'sender has no Ed25519 key — re-mint required' });

  const toNode = registry.getAllNodes().find(n => n.node_id === to_nit_id);
  if (!toNode) return res.status(404).json({ error: 'recipient not found' });

  // Verify Ed25519 signature: sig = Sign(safeMsg, senderPrivKey)
  try {
    const pubKey = createPublicKey({ key: Buffer.from(fromNode.pub_key, 'base64'), format: 'der', type: 'spki' });
    const valid  = ed25519Verify(null, Buffer.from(safeMsg), pubKey, Buffer.from(sig, 'base64'));
    if (!valid) return res.status(401).json({ error: 'invalid signature' });
  } catch {
    return res.status(400).json({ error: 'signature verification failed' });
  }

  const dm = db.saveDm({ from_id: from_nit_id, to_id: to_nit_id, msg: safeMsg, sig });
  const delivered = deliverDm(to_nit_id, { event: 'dm:received', data: dm, ts: Date.now() });

  res.json({ ok: true, dm, delivered });
});

// DM inbox for a node
app.get('/api/dms/:nit_id', requireAuth, (req, res) => {
  const dms = db.loadDms(req.params.nit_id, Number(req.query.limit) || 50);
  res.json(dms);
});

// DMs sent by a node
app.get('/api/dms/:nit_id/sent', requireAuth, (req, res) => {
  const dms = db.loadSentDms(req.params.nit_id, Number(req.query.limit) || 50);
  res.json(dms);
});

// ── Hub directory ─────────────────────────────────────────────────
app.get('/api/hubs', (_req, res) => {
  const stats = registry.getStats();
  const peers = federation.getPeers();
  res.json({
    this_hub: {
      hub_id:       federation.HUB_ID,
      name:         process.env.HUB_NAME || 'NIT-IN Hub',
      mode:         SIMULATE ? 'simulator' : 'hardware',
      total_nodes:  stats.total_nodes,
      online_nodes: stats.online_nodes,
      total_edges:  stats.total_edges,
      total_posts:  stats.total_posts,
      density:      stats.network_density,
      patent_ref:   'USPTO-19/668,817',
    },
    peers,
    total_known_hubs: 1 + peers.length,
  });
});

app.get('/hubs',     (_req, res) => res.sendFile(path.join(__dirname, '../public/hubs.html')));
app.get('/messages', (_req, res) => res.sendFile(path.join(__dirname, '../public/messages.html')));
app.get('/pricing',  (_req, res) => res.sendFile(path.join(__dirname, '../public/pricing.html')));

// ── Stripe billing checkout ──────────────────────────────────────
// Wire STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_HUB,
// STRIPE_PRICE_SIGNAL, STRIPE_PRICE_ENTERPRISE as Railway env vars to activate.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_MAP  = {
  starter:    process.env.STRIPE_PRICE_STARTER,
  hub:        process.env.STRIPE_PRICE_HUB,
  signal:     process.env.STRIPE_PRICE_SIGNAL,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://nit-in.conversationmine.ai';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

app.post('/api/billing/create-checkout', async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'billing_not_configured' });
  }
  const { plan, email } = req.body || {};
  const priceId = STRIPE_PRICE_MAP[plan];
  if (!priceId) return res.status(400).json({ error: 'invalid_plan' });

  try {
    // Lazy-load stripe only when billing is configured to avoid hard dep
    const Stripe = require('stripe');
    const stripe  = Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      ...(email ? { customer_email: email } : {}),
      metadata: { plan },
      success_url: `${PUBLIC_URL}/pricing?checkout=success`,
      cancel_url:  `${PUBLIC_URL}/pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing]', err.message);
    res.status(500).json({ error: 'checkout_failed' });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────
const PLAN_LABEL_MAP = { starter: 'starter', hub: 'hub', signal: 'signal', enterprise: 'enterprise' };

app.post('/api/billing/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET) {
      console.error('[billing/webhook] STRIPE_WEBHOOK_SECRET not set — rejecting');
      return res.status(503).json({ error: 'webhook_not_configured' });
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      const Stripe = require('stripe');
      event = Stripe(STRIPE_SECRET_KEY).webhooks.constructEvent(
        req.body, sig, STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[billing/webhook] signature error:', err.message);
      return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      const plan  = session.metadata?.plan || 'starter';
      const customerId = session.customer;
      const subId = session.subscription;
      if (email) {
        db.prepare(`
          INSERT INTO users (email, plan, stripe_customer_id, stripe_subscription_id, plan_updated_at)
          VALUES (?, ?, ?, ?, unixepoch())
          ON CONFLICT(email) DO UPDATE SET
            plan = excluded.plan,
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            plan_updated_at = unixepoch()
        `).run(email, plan, customerId, subId);
        console.log(`[billing/webhook] plan=${plan} activated for ${email}`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      db.prepare(`
        UPDATE users SET plan = 'free', stripe_subscription_id = NULL, plan_updated_at = unixepoch()
        WHERE stripe_subscription_id = ?
      `).run(sub.id);
      console.log(`[billing/webhook] subscription cancelled, downgraded to free: sub=${sub.id}`);
    }

    res.json({ received: true });
  }
);

// ── Waitlist ──────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PLANS = new Set(['starter', 'hub', 'signal', 'enterprise']);

app.post('/api/waitlist', (req, res) => {
  const { email, plan } = req.body || {};
  if (!email || !EMAIL_RE.test(email))         return res.status(400).json({ error: 'invalid_email' });
  if (!plan  || !VALID_PLANS.has(plan))        return res.status(400).json({ error: 'invalid_plan' });
  const isNew = db.addWaitlist(email, plan);
  res.json({ ok: true, already_registered: !isNew });
});

// Admin: view waitlist (protected — same ADMIN_KEY as other admin routes)
app.get('/api/waitlist', requireAuth, (_req, res) => {
  res.json(db.loadWaitlist());
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 33 — FLEET COMMAND: HARDWARE HEALTH HEARTBEATS
//
// Each provisioned hardware node (Arduino / SBC) periodically POSTs its vitals
// to /api/fleet/heartbeat.  NIT-IN stores the last reading per instance_id in
// memory (fleetHealth map) and persists to SQLite via db.  The operator can
// pull a full fleet snapshot via GET /api/fleet/nodes.
//
// Heartbeat body: { instance_id, label?, cpu_pct, temp_c, mem_pct,
//                   dms_status, uptime_s, firmware_version, extra? }
// DMS status values: ACTIVE | DEGRADED | OFFLINE | UNKNOWN
// Auth: X-Hub-Secret (same as requireAuth — reuse existing gateway secret)
// ══════════════════════════════════════════════════════════════════════════════

/** In-memory fleet health registry: instance_id → latest vitals record */
const fleetHealth = new Map();

const DMS_VALID = new Set(['ACTIVE', 'DEGRADED', 'OFFLINE', 'UNKNOWN']);

app.post('/api/fleet/heartbeat', requireAuth, (req, res) => {
  const body = req.body || {};
  const instance_id = String(body.instance_id || '').trim();
  if (!instance_id) return res.status(400).json({ error: 'instance_id required' });

  const record = {
    instance_id,
    label:            String(body.label           ?? instance_id).slice(0, 64),
    cpu_pct:          parseFloat(body.cpu_pct)    || 0,
    temp_c:           parseFloat(body.temp_c)     || null,
    mem_pct:          parseFloat(body.mem_pct)    || 0,
    dms_status:       DMS_VALID.has(body.dms_status) ? body.dms_status : 'UNKNOWN',
    uptime_s:         parseInt(body.uptime_s)     || 0,
    firmware_version: String(body.firmware_version ?? '').slice(0, 32) || null,
    self_test_passed: body.self_test_passed === true,
    extra:            (body.extra && typeof body.extra === 'object') ? body.extra : {},
    reported_at:      new Date().toISOString(),
    reported_epoch:   Math.floor(Date.now() / 1000),
  };

  fleetHealth.set(instance_id, record);

  // Phase 33: persist to SQLite when NIT_IN_HUB_PERSISTENCE=true
  if (FLEET_PERSIST) db.saveHeartbeat(record);

  // Broadcast live update to operator dashboard
  broadcast('fleet:heartbeat', record);

  res.json({ ok: true, instance_id, recorded_at: record.reported_at });
});

app.get('/api/fleet/nodes', requireAuth, (req, res) => {
  const staleThreshold = parseInt(req.query.stale_after_s || '120');
  const now = Math.floor(Date.now() / 1000);

  const nodes = Array.from(fleetHealth.values()).map(n => ({
    ...n,
    online: (now - n.reported_epoch) <= staleThreshold,
    seconds_since_heartbeat: now - n.reported_epoch,
  }));

  const online  = nodes.filter(n => n.online).length;
  const degraded = nodes.filter(n => n.dms_status === 'DEGRADED').length;
  const offline  = nodes.filter(n => !n.online || n.dms_status === 'OFFLINE').length;

  res.json({
    fleet_size:    nodes.length,
    online_count:  online,
    degraded_count: degraded,
    offline_count: offline,
    stale_threshold_s: staleThreshold,
    nodes,
    ts: new Date().toISOString(),
  });
});

// ── Phase 34: OTA Request Gate ────────────────────────────────────────────────
// Hardware nodes request an OTA update via this endpoint (called by TWIN relay
// from the Manifest UI).  Gate: node must have self_test_passed=true in its
// latest heartbeat.  TWIN firmware registry supplies the signed download URL.
// 'ota:initiated' is broadcast over WebSocket to all connected operators.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/fleet/ota/request', requireAuth, async (req, res) => {
  const body        = req.body || {};
  const instance_id = String(body.instance_id || '').trim();
  if (!instance_id) return res.status(400).json({ error: 'instance_id required' });

  const node = fleetHealth.get(instance_id);
  if (!node) {
    return res.status(404).json({ error: 'node not found — send a heartbeat first' });
  }
  if (!node.self_test_passed) {
    return res.status(403).json({
      error: 'self_test_passed must be true before OTA is released',
      instance_id,
      current_dms_status: node.dms_status,
    });
  }

  const twinBase = process.env.TWIN_BASE_URL      || 'https://twin.conversationmine.ai';
  const twinKey  = process.env.TWIN_SHARED_SECRET || '';
  let firmware;
  try {
    const fwRes  = await fetch(`${twinBase}/api/governance/firmware/latest`, {
      headers: { 'X-Twin-Key': twinKey },
    });
    if (!fwRes.ok) throw new Error(`TWIN HTTP ${fwRes.status}`);
    const fwData = await fwRes.json();
    firmware     = fwData.latest_stable;
    if (!firmware) throw new Error('no firmware published yet');
  } catch (e) {
    return res.status(502).json({ error: `twin_firmware_fetch_failed: ${e.message}` });
  }

  const signed_at = new Date().toISOString();
  broadcast('ota:initiated', {
    instance_id,
    label:          node.label,
    from_version:   node.firmware_version,
    target_version: firmware.version,
    signed_at,
  });

  res.json({
    ok:              true,
    instance_id,
    label:           node.label,
    current_version: node.firmware_version,
    target_version:  firmware.version,
    download_url:    firmware.download_url,
    sha256:          firmware.sha256,
    release_notes:   firmware.release_notes,
    signed_at,
  });
});

// ── Phase 35: Batch OTA Gate (canary deploy + emergency revert) ───────────────
// Accepts a list of instance_ids (resolved by TWIN from label_prefix or explicit).
// Runs the same self_test_passed gate per node; collects per-node results.
// broadcast 'ota:batch_initiated' summarises ok/blocked/not_found counts.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/fleet/ota/batch', requireAuth, async (req, res) => {
  const body         = req.body || {};
  const instance_ids = Array.isArray(body.instance_ids) ? body.instance_ids : [];
  const use_previous = body.use_previous === true;

  if (instance_ids.length === 0) {
    return res.status(400).json({ error: 'instance_ids array is required and must not be empty' });
  }

  const twinBase = process.env.TWIN_BASE_URL      || 'https://twin.conversationmine.ai';
  const twinKey  = process.env.TWIN_SHARED_SECRET || '';

  // Fetch firmware once for the whole batch
  let firmware;
  try {
    const fwRes  = await fetch(`${twinBase}/api/governance/firmware/latest`, {
      headers: { 'X-Twin-Key': twinKey },
    });
    if (!fwRes.ok) throw new Error(`TWIN HTTP ${fwRes.status}`);
    const fwData = await fwRes.json();
    firmware     = use_previous ? fwData.previous_stable : fwData.latest_stable;
    if (!firmware) throw new Error(use_previous ? 'no previous_stable firmware' : 'no latest_stable firmware');
  } catch (e) {
    return res.status(502).json({ error: `twin_firmware_fetch_failed: ${e.message}` });
  }

  const signed_at = new Date().toISOString();
  const results   = [];
  let ok_count = 0, blocked_count = 0, not_found_count = 0;

  for (const instance_id of instance_ids) {
    const node = fleetHealth.get(String(instance_id));
    if (!node) {
      not_found_count++;
      results.push({ instance_id, ok: false, error: 'not_found — no heartbeat received' });
      continue;
    }
    if (!node.self_test_passed) {
      blocked_count++;
      results.push({
        instance_id, ok: false,
        error: 'self_test_gate_blocked',
        current_dms_status: node.dms_status,
      });
      continue;
    }
    ok_count++;
    results.push({
      instance_id,
      ok:              true,
      label:           node.label,
      current_version: node.firmware_version,
      target_version:  firmware.version,
      download_url:    firmware.download_url,
      sha256:          firmware.sha256,
      signed_at,
    });
  }

  broadcast('ota:batch_initiated', {
    ok_count,
    blocked_count,
    not_found_count,
    target_version: firmware.version,
    use_previous,
    signed_at,
  });

  res.json({
    ok:              true,
    target_version:  firmware.version,
    use_previous,
    ok_count,
    blocked_count,
    not_found_count,
    results,
    signed_at,
  });
});

// ── Phase 36: Incident Simulation ────────────────────────────────────────────
// POST /api/sim/inject  — synthetic heartbeat injection for a specific node.
//   Body: { instance_id, scenario, overrides? }
//   scenario: 'node_offline' | 'node_degraded' | 'version_mismatch' |
//             'cpu_spike' | 'temp_alert' | 'self_test_fail' | 'custom'
//   overrides: any valid heartbeat field (custom scenario only)
//
// POST /api/sim/reset   — clear all sim-injected entries from fleetHealth.
// GET  /api/sim/status  — list active sim-injected instance_ids + scenarios.
//
// All three require X-Hub-Secret (reuse requireAuth).

const SCENARIO_OVERRIDES = {
  node_offline:    { dms_status: 'OFFLINE', online: false, self_test_passed: false },
  node_degraded:   { dms_status: 'DEGRADED', cpu_pct: 88, temp_c: 79 },
  version_mismatch:{ firmware_version: 'sim-skew-0.0.0', self_test_passed: false },
  cpu_spike:       { cpu_pct: 97.5, dms_status: 'DEGRADED' },
  temp_alert:      { temp_c: 91.0, dms_status: 'DEGRADED' },
  self_test_fail:  { self_test_passed: false, dms_status: 'DEGRADED' },
};

// Track which instance_ids were injected and which scenario was used
const simRegistry = new Map(); // instance_id → { scenario, injected_at }

app.post('/api/sim/inject', requireAuth, (req, res) => {
  const { instance_id, scenario, overrides } = req.body || {};
  if (!instance_id || typeof instance_id !== 'string') {
    return res.status(400).json({ error: 'instance_id required' });
  }
  const validScenarios = [...Object.keys(SCENARIO_OVERRIDES), 'custom'];
  if (!scenario || !validScenarios.includes(scenario)) {
    return res.status(400).json({ error: `scenario must be one of: ${validScenarios.join(', ')}` });
  }
  if (scenario === 'custom' && (!overrides || typeof overrides !== 'object')) {
    return res.status(400).json({ error: 'overrides object required for custom scenario' });
  }

  // Merge into existing fleetHealth record (or create a minimal stub)
  const existing  = fleetHealth.get(instance_id) || {
    instance_id,
    label:            `sim-${instance_id}`,
    provisioned_label: null,
    provisioned_at:   null,
    firmware_version: 'unknown',
    self_test_passed: false,
    cpu_pct:          0,
    temp_c:           25,
    mem_pct:          0,
    uptime_s:         0,
    dms_status:       'UNKNOWN',
    online:           true,
  };

  const patch     = scenario === 'custom' ? overrides : SCENARIO_OVERRIDES[scenario];
  const injected  = {
    ...existing,
    ...patch,
    sim_injected:  true,
    last_heartbeat: Date.now(),
    seconds_since_heartbeat: 0,
  };

  fleetHealth.set(instance_id, injected);
  simRegistry.set(instance_id, { scenario, injected_at: Date.now() });

  broadcast('sim:node_injected', { instance_id, scenario, record: injected });

  res.json({ ok: true, instance_id, scenario, record: injected, ts: Date.now() });
});

app.post('/api/sim/reset', requireAuth, (req, res) => {
  const cleared = [];
  for (const [iid] of simRegistry) {
    fleetHealth.delete(iid);
    cleared.push(iid);
  }
  simRegistry.clear();

  broadcast('sim:reset', { cleared_count: cleared.length, cleared_ids: cleared });
  res.json({ ok: true, cleared_count: cleared.length, cleared_ids: cleared, ts: Date.now() });
});

app.get('/api/sim/status', requireAuth, (req, res) => {
  const active = Array.from(simRegistry.entries()).map(([iid, meta]) => ({
    instance_id:  iid,
    scenario:     meta.scenario,
    injected_at:  meta.injected_at,
    current_record: fleetHealth.get(iid) || null,
  }));
  res.json({ ok: true, active_count: active.length, incidents: active, ts: Date.now() });
});

// ── Phase 38: Per-node forensic snapshot ─────────────────────────────────────
// GET /api/fleet/nodes/:instance_id/snapshot
// Returns the single node's live fleetHealth record at the moment of the call.
// Used by TWIN sim_inject() to capture "black box" state into incident_opened
// audit entries.  Returns 404 if the instance_id is not in fleetHealth.
app.get('/api/fleet/nodes/:instance_id/snapshot', requireAuth, (req, res) => {
  const record = fleetHealth.get(req.params.instance_id);
  if (!record) {
    return res.status(404).json({
      error:       'node_not_found',
      instance_id: req.params.instance_id,
      ts:          Date.now(),
    });
  }
  res.json({
    ok:          true,
    instance_id: req.params.instance_id,
    snapshot:    record,
    ts:          Date.now(),
  });
});

// ── WebSocket ─────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) client.send(payload);
  }
}

wss.on('connection', ws => {
  // Send full current state so late-connecting clients catch up
  ws.send(JSON.stringify({
    event: 'init',
    data: {
      nodes: registry.getAllNodes(),
      graph: registry.getGraphData(),
      feed:  registry.getFeed(50),
      stats: registry.getStats(),
      mode:  SIMULATE ? 'sim' : 'hardware',
    },
    ts: Date.now(),
  }));

  // Register nit_id → ws for DM routing
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'identify' && typeof m.nit_id === 'string' && /^NIT-[A-Z]+-\d{4}$/.test(m.nit_id)) {
        ws._nit_id = m.nit_id;
        if (!sessions.has(m.nit_id)) sessions.set(m.nit_id, new Set());
        sessions.get(m.nit_id).add(ws);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    if (ws._nit_id) {
      sessions.get(ws._nit_id)?.delete(ws);
      if (sessions.get(ws._nit_id)?.size === 0) sessions.delete(ws._nit_id);
    }
  });
});

// Wire broadcast into serial-bridge (and thus simulator via handleMessage)
setBroadcast(broadcast);

  // Start peer discovery
  federation.init({ registry, broadcast, port: PORT, name: 'NIT-IN Hub' });

setBroadcast(broadcast);

  // Start peer discovery
  federation.init({ registry, broadcast, port: PORT, name: 'NIT-IN Hub' });

// ── BBB Compliance + Resend + Stripe Webhook (June 16 2026) ──────────────────

const _nitProcessedEvents = new Set();

app.get('/terms',           (req, res) => res.sendFile('terms.html',   { root: path.join(__dirname, 'public') }));
app.get('/terms-of-service',(req, res) => res.sendFile('terms.html',   { root: path.join(__dirname, 'public') }));
app.get('/privacy',         (req, res) => res.sendFile('privacy.html', { root: path.join(__dirname, 'public') }));
app.get('/privacy-policy',  (req, res) => res.sendFile('privacy.html', { root: path.join(__dirname, 'public') }));
app.get('/refund',          (req, res) => res.sendFile('refund.html',  { root: path.join(__dirname, 'public') }));
app.get('/contact',         (req, res) => res.sendFile('contact.html', { root: path.join(__dirname, 'public') }));
app.get('/support',         (req, res) => res.sendFile('support.html', { root: path.join(__dirname, 'public') }));

app.get('/unsubscribe', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  const key = process.env.RESEND_API_KEY || '';
  const aid = process.env.RESEND_AUDIENCE_ID || '';
  if (email && email.includes('@') && key && aid) {
    try {
      await fetch(`https://api.resend.com/audiences/${aid}/contacts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, unsubscribed: true }),
      });
    } catch {}
  }
  res.send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px"><h1>Unsubscribed</h1><p>Removed from NIT-IN marketing emails.</p><p><a href="/">← Home</a></p></body></html>');
});

app.get('/billing-portal', async (req, res) => {
  const Stripe = require('stripe');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
  const customerId = req.query.customer_id || '';
  if (!customerId) return res.redirect('/');
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${req.protocol}://${req.get('host')}`,
    });
    return res.redirect(portal.url);
  } catch (err) {
    console.error('[nit-in billing portal]', err.message);
    return res.redirect('/');
  }
});

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const Stripe = require('stripe');
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return res.status(500).json({ error: 'Webhook not configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  // Idempotency
  if (event.id) {
    if (_nitProcessedEvents.has(event.id)) return res.json({ received: true, skipped: 'duplicate' });
    if (_nitProcessedEvents.size > 5000) _nitProcessedEvents.clear();
    _nitProcessedEvents.add(event.id);
  }
  if (event.type === 'checkout.session.completed') {
    const email = event.data.object.customer_email || event.data.object.metadata?.email || '';
    if (email) {
      const key = process.env.RESEND_API_KEY || '';
      const aid = process.env.RESEND_AUDIENCE_ID || '';
      if (key && aid) {
        try {
          await fetch(`https://api.resend.com/audiences/${aid}/contacts`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, unsubscribed: false }),
          });
        } catch {}
      }
    }
  }
  return res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  const line = '═'.repeat(44);
  console.log(`\n╔${line}╗`);
  console.log(`║  ◈  NIT-IN  —  Node Identity Token Network    ║`);
  console.log(`╠${line}╣`);
  console.log(`║  Dashboard  →  http://localhost:${PORT}           ║`);
  console.log(`║  Mode       →  ${SIMULATE ? 'SIMULATOR (20 virtual nodes)  ' : 'HARDWARE   (USB serial scan)  '}║`);
  console.log(`║  Founder    →  NIT-USR-0001  imacKris         ║`);
  console.log(`╚${line}╝\n`);

  // ── Hydrate from SQLite (must run before genesis registration) ──
  registry.hydrate();

  // Phase 33: restore fleet health from SQLite — prevents cold-start storm on restart
  if (FLEET_PERSIST) {
    const saved = db.loadAllHeartbeats();
    saved.forEach(r => fleetHealth.set(r.instance_id, r));
    if (saved.length) {
      console.log(`[Fleet] Restored ${saved.length} node(s) from SQLite (NIT_IN_HUB_PERSISTENCE=true)`);
    }
  }

  // Set userNodeCounter to highest existing USR node so minting never collides
  const userNodes = registry.getAllNodes()
    .filter(n => n.node_id.startsWith('NIT-USR-'))
    .map(n => parseInt(n.node_id.replace('NIT-USR-', ''), 10))
    .filter(n => !isNaN(n));
  if (userNodes.length) userNodeCounter = Math.max(...userNodes);

  // ── Founding node: only register if not already persisted ───────
  if (!registry.getAllNodes().find(n => n.node_id === 'NIT-USR-0001')) {
    registry.registerNode(GENESIS_NODE);
    registry.addPost({
      node_id:   'NIT-USR-0001',
      node_type: 'human',
      type:      'HUMAN_SIGNAL',
      msg:       'Genesis. This is the first signal. BIRTH_RIGHTS_v1.0 — irrevocably declared. By birth.',
      genesis:   true,
    });
  }

  if (SIMULATE) {
    require('./simulator').bootNodes();
  } else {
    startDiscovery();
  }
});
