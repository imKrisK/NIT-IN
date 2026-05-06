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
  console.warn('[AUTH] HUB_SECRET not set — write endpoints are unprotected');
}

function requireAuth(req, res, next) {
  if (!HUB_SECRET) return next();
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

  const node = registry.registerNode(profile);
  const { reactions, newPosts } = evaluateNetworkReaction(node_id);

  for (const post of newPosts) broadcast('feed:post', post);
  broadcast('node:registered', { node, reactions });

  res.json({ node, reactions: reactions.filter(r => r.reaction === 'RESONATE').length, priv_key });
});

// ── Human signal transmission ─────────────────────────────────────
app.post('/api/signal', requireAuth, requireResonance, (req, res) => {
  const { node_id, msg } = req.body || {};
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

  const post = registry.addPost({
    node_id,
    node_type: node.node_type || 'hardware',
    type:  'HUMAN_SIGNAL',
    msg:   safeMsg,
  });

  broadcast('feed:post', post);
  res.json({ ok: true, post });
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
// Wire STRIPE_SECRET_KEY, STRIPE_PRICE_HUB, STRIPE_PRICE_SIGNAL,
// STRIPE_PRICE_ENTERPRISE as Railway env vars to activate.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_MAP  = {
  hub:        process.env.STRIPE_PRICE_HUB,
  signal:     process.env.STRIPE_PRICE_SIGNAL,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://nit-in.conversationmine.ai';

app.post('/api/billing/create-checkout', async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: 'billing_not_configured' });
  }
  const { plan } = req.body || {};
  const priceId = STRIPE_PRICE_MAP[plan];
  if (!priceId) return res.status(400).json({ error: 'invalid_plan' });

  try {
    // Lazy-load stripe only when billing is configured to avoid hard dep
    const Stripe = require('stripe');
    const stripe  = Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${PUBLIC_URL}/pricing?checkout=success`,
      cancel_url:  `${PUBLIC_URL}/pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing]', err.message);
    res.status(500).json({ error: 'checkout_failed' });
  }
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
