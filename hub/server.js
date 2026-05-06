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

const registry                          = require('./nit-registry');
const { startDiscovery, setBroadcast, handleMessage } = require('./serial-bridge');
const { evaluateNetworkReaction }       = require('./resonance');
const federation                        = require('./federation');

const PORT       = process.env.PORT || 3001;
const SIMULATE   = process.argv.includes('--simulate') || process.env.SIMULATE === 'true';
const HUB_SECRET = process.env.HUB_SECRET;

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

// Resonance gate — node must have >= 40% resonance with the Founder to post
const RESONANCE_GATE = 0.40;
const FOUNDER_ID     = 'NIT-USR-0001';

function requireResonance(req, res, next) {
  const node_id = req.body?.node_id;
  if (!node_id || node_id === FOUNDER_ID) return next(); // founder always passes
  const score = registry.computeResonance(node_id, FOUNDER_ID);
  if (score < RESONANCE_GATE) {
    return res.status(403).json({
      error:    'resonance_gated',
      score:    Math.round(score * 100),
      required: Math.round(RESONANCE_GATE * 100),
      msg:      'Insufficient resonance to post signals on this hub',
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
  const db = require('./db');
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

  const node = registry.registerNode(profile);
  const { reactions, newPosts } = evaluateNetworkReaction(node_id);

  for (const post of newPosts) broadcast('feed:post', post);
  broadcast('node:registered', { node, reactions });

  res.json({ node, reactions: reactions.filter(r => r.reaction === 'RESONATE').length });
});

// ── Human signal transmission ─────────────────────────────────────
app.post('/api/signal', requireAuth, requireResonance, (req, res) => {
  const { node_id, msg } = req.body || {};
  if (!node_id || typeof msg !== 'string') {
    return res.status(400).json({ error: 'node_id and msg required' });
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
