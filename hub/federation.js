'use strict';

/**
 * NIT-IN Hub Federation — Peer discovery over LAN
 *
 * Protocol:
 *   1. UDP broadcast every 12s → HUB_ANNOUNCE packet (port 3002)
 *   2. When a peer is heard for the first time → connect to its WebSocket
 *   3. Relay peer's feed:post + node:registered events into local broadcast
 *   4. Mark remote posts/nodes with remote_hub so the UI can badge them
 *
 * This creates a zero-config mesh: start two NIT-IN hubs on the same LAN
 * and they will find each other and start sharing the feed automatically.
 */

const dgram     = require('dgram');
const crypto    = require('crypto');
const WebSocket = require('ws');

const DISCOVER_PORT  = 3002;
const ANNOUNCE_EVERY = 12_000; // ms

// Stable hub ID for this process lifetime
const HUB_ID = crypto.randomBytes(6).toString('hex').toUpperCase();

const peers = new Map(); // hub_id -> { hub_id, ws_url, ws, last_seen, name }

let _registry  = null;
let _broadcast = null;
let _wsPort    = 3001;
let _hubName   = 'NIT-IN Hub';

// ── Public init ───────────────────────────────────────────────────
function init({ registry, broadcast, port = 3001, name = 'NIT-IN Hub' }) {
  _registry  = registry;
  _broadcast = broadcast;
  _wsPort    = port;
  _hubName   = name;

  _startUDP();
  console.log(`[Federation] ◎ Hub ${HUB_ID} — listening for peers on UDP :${DISCOVER_PORT}`);
}

// ── UDP layer ─────────────────────────────────────────────────────
function _startUDP() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', err => {
    // Federation is non-critical — log and continue without it
    console.log(`[Federation] ⚠ UDP unavailable (${err.code}) — federation disabled`);
    sock.close();
  });

  sock.bind(DISCOVER_PORT, () => {
    try { sock.setBroadcast(true); } catch (_) {}
    _announce(sock);
    setInterval(() => _announce(sock), ANNOUNCE_EVERY);
  });

  sock.on('message', (msg, rinfo) => {
    try {
      const pkt = JSON.parse(msg.toString());
      if (pkt.type !== 'HUB_ANNOUNCE') return;
      if (pkt.hub_id === HUB_ID)       return; // ignore self

      if (peers.has(pkt.hub_id)) {
        peers.get(pkt.hub_id).last_seen = Date.now();
      } else {
        console.log(`[Federation] ↯ Peer discovered: ${pkt.hub_id} "${pkt.name}" @ ${pkt.ws_url}`);
        _connectPeer(pkt);
      }
    } catch (_) {}
  });
}

function _announce(sock) {
  try {
    const payload = Buffer.from(JSON.stringify({
      type:       'HUB_ANNOUNCE',
      hub_id:     HUB_ID,
      name:       _hubName,
      ws_url:     `ws://localhost:${_wsPort}`,
      node_count: _registry?.getAllNodes().length || 0,
      ts:         Date.now(),
    }));
    sock.send(payload, 0, payload.length, DISCOVER_PORT, '255.255.255.255');
  } catch (_) {}
}

// ── WebSocket bridge to a peer hub ───────────────────────────────
function _connectPeer(pkt) {
  const { hub_id, ws_url, name } = pkt;
  let ws;

  try {
    ws = new WebSocket(ws_url, { handshakeTimeout: 6000 });
  } catch (_) { return; }

  ws.on('open', () => {
    console.log(`[Federation] ✓ Bridged to ${hub_id} "${name}"`);
    peers.set(hub_id, { hub_id, ws_url, ws, name, last_seen: Date.now() });
  });

  ws.on('message', raw => {
    try {
      const { event, data } = JSON.parse(raw);

      // On init, ingest peer's existing feed (but not nodes — avoid registry pollution)
      if (event === 'init') {
        const feed = data?.feed || [];
        for (const post of feed) {
          if (post.remote_hub) continue; // don't re-relay already-remote posts
          _broadcast?.('feed:post', { ...post, remote_hub: hub_id });
        }
      }

      // Relay new posts in real time
      if (event === 'feed:post' && data && !data.remote_hub) {
        _broadcast?.('feed:post', { ...data, remote_hub: hub_id });
      }

      // Relay new node registrations (view only — don't write into local registry)
      if (event === 'node:registered' && data?.node && !data.node.remote_hub) {
        _broadcast?.('node:registered', {
          node:     { ...data.node, remote_hub: hub_id },
          reactions: data.reactions || [],
        });
      }

      if (peers.has(hub_id)) peers.get(hub_id).last_seen = Date.now();
    } catch (_) {}
  });

  ws.on('close', () => {
    console.log(`[Federation] ✗ Peer ${hub_id} disconnected`);
    peers.delete(hub_id);
    // Retry with exponential backoff capped at 60s
    const delay = Math.min(60_000, 10_000 + Math.random() * 5_000);
    setTimeout(() => _connectPeer(pkt), delay);
  });

  ws.on('error', () => {}); // handled by 'close'
}

// ── Introspection API ─────────────────────────────────────────────
function getPeers() {
  return [...peers.values()].map(p => ({
    hub_id:    p.hub_id,
    name:      p.name,
    ws_url:    p.ws_url,
    last_seen: p.last_seen,
    connected: p.ws?.readyState === 1,
  }));
}

module.exports = { init, getPeers, HUB_ID };
