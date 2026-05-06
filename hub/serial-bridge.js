'use strict';

/**
 * Serial Bridge — manages USB serial connections to physical Arduino Uno Q nodes.
 * Auto-discovers Arduinos on connect/disconnect. Polls every 10 seconds.
 *
 * All messages from Arduino are newline-delimited JSON at 9600 baud.
 * Message types: NIT_GENESIS | CAPABILITY_PULSE | SENSOR_EVENT | SOCIAL_SIGNAL
 */

const registry = require('./nit-registry');
const { evaluateNetworkReaction } = require('./resonance');

const BAUD_RATE       = 9600;
const DISCOVERY_MS    = 10_000;

// Lazy-loaded native module (not required in --simulate mode)
let SerialPort     = null;
let ReadlineParser = null;

const activePorts = new Map(); // path -> SerialPort instance
let broadcastFn   = null;

// ── Public API ────────────────────────────────────────────────────

function setBroadcast(fn) {
  broadcastFn = fn;
}

function broadcast(event, data) {
  if (broadcastFn) broadcastFn(event, data);
}

function startDiscovery() {
  _loadSerialport();
  _discover();
  setInterval(_discover, DISCOVERY_MS);
}

// Unified message handler — called by both serial-bridge and simulator
function handleMessage(msg, portPath) {
  if (!msg || !msg.type || !msg.node_id) return;

  switch (msg.type) {
    case 'NIT_GENESIS': {
      const node = registry.registerNode({ ...msg, _port: portPath });
      const { reactions, newPosts } = evaluateNetworkReaction(msg.node_id);

      broadcast('node:registered', { node, reactions });
      newPosts.forEach(post => broadcast('feed:post', post));

      const resonating = reactions.filter(r => r.reaction === 'RESONATE').length;
      const observing  = reactions.filter(r => r.reaction === 'OBSERVE').length;
      console.log(
        `[NIT] ✦ ${msg.node_id} ONLINE` +
        ` — ${resonating} RESONATE  ${observing} OBSERVE` +
        ` — ${reactions.length - resonating - observing} IGNORE`
      );
      break;
    }

    case 'CAPABILITY_PULSE': {
      const node = registry.updateNode(msg.node_id, {
        uptime:   msg.uptime,
        free_mem: msg.free_mem,
      });
      if (node) {
        broadcast('node:pulse', {
          node_id:  msg.node_id,
          uptime:   msg.uptime,
          free_mem: msg.free_mem,
        });
      }
      break;
    }

    case 'SENSOR_EVENT': {
      const post = registry.addPost(msg);
      broadcast('feed:post', post);
      break;
    }

    case 'SOCIAL_SIGNAL': {
      const post = registry.addPost(msg);
      broadcast('feed:post', post);
      break;
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────

function _loadSerialport() {
  if (SerialPort) return true;
  try {
    ({ SerialPort }     = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
    return true;
  } catch {
    console.error('[Serial] serialport module unavailable. Use --simulate for virtual nodes.');
    return false;
  }
}

async function _discover() {
  if (!SerialPort) return;
  try {
    const ports = await SerialPort.list();
    const arduinos = ports.filter(p =>
      p.manufacturer?.toLowerCase().includes('arduino') ||
      p.manufacturer?.toLowerCase().includes('wch')     ||
      p.manufacturer?.toLowerCase().includes('ch340')   ||
      p.vendorId === '2341' ||  // Arduino LLC
      p.vendorId === '1a86'     // CH340 clone
    );

    for (const { path } of arduinos) {
      if (!activePorts.has(path)) _connectPort(path);
    }
  } catch (err) {
    console.error('[Serial] Discovery error:', err.message);
  }
}

function _connectPort(path) {
  const port   = new SerialPort({ path, baudRate: BAUD_RATE });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => {
    console.log(`[Serial] Connected: ${path}`);
    activePorts.set(path, port);
  });

  parser.on('data', raw => {
    try {
      handleMessage(JSON.parse(raw.trim()), path);
    } catch {
      // Ignore non-JSON lines (boot messages, debug output)
    }
  });

  port.on('close', () => {
    console.log(`[Serial] Disconnected: ${path}`);
    activePorts.delete(path);
    // Mark nodes that were on this port offline
    registry.getAllNodes()
      .filter(n => n._port === path)
      .forEach(n => {
        registry.markOffline(n.node_id);
        broadcast('node:offline', { node_id: n.node_id });
      });
  });

  port.on('error', err => {
    console.error(`[Serial] ${path}:`, err.message);
    activePorts.delete(path);
  });
}

module.exports = { startDiscovery, setBroadcast, handleMessage };
