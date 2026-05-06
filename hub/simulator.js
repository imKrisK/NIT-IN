'use strict';

/**
 * Simulator — boots 20 virtual NIT nodes without physical hardware.
 * Drives the same handleMessage() pipeline the serial bridge uses,
 * so the hub, registry, and resonance engine are fully exercised.
 *
 * Run: npm run sim
 */

const { handleMessage } = require('./serial-bridge');

const NUM_NODES    = 20;
const BOOT_MIN_MS  = 300;
const BOOT_JITTER  = 700;
const PULSE_MS     = 30_000;
const EVENT_MIN_MS = 2_000;
const EVENT_MAX_MS = 5_000;

const SENSOR_POOL = [
  'temperature', 'light', 'motion', 'humidity',
  'pressure',    'sound', 'ir',     'ultrasonic',
];

// ── Helpers ───────────────────────────────────────────────────────

function randomSubset(arr, min = 1, max = 3) {
  const count = min + Math.floor(Math.random() * (max - min + 1));
  return [...arr].sort(() => Math.random() - 0.5).slice(0, count);
}

function randomHex(len = 8) {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

function generateGenesis(index) {
  const node_id = `NIT-${String(index + 1).padStart(4, '0')}`;
  const sram    = 512 + Math.floor(Math.random() * 1536); // 512–2048 bytes

  return {
    type:             'NIT_GENESIS',
    node_id,
    birth_timestamp:  new Date().toISOString(),
    hardware_sig:     `hw-${randomHex(8)}`,
    capabilities: {
      analog_pins:  6,
      digital_pins: 14,
      sram_bytes:   sram,
      flash_bytes:  32768,
      ai_model:     'Q-tiny-v1',
      sensors:      randomSubset(SENSOR_POOL),
    },
    personality_seed: randomHex(16),
    birth_rights:     'IMMUTABLE',
    status:           'ONLINE-SEEKING_RESONANCE',
    uptime:           0,
    free_mem:         sram,
  };
}

// ── Boot sequence ─────────────────────────────────────────────────

async function bootNodes() {
  console.log('[Simulator] ◈ Booting 20 NIT nodes — Birth_Rights Protocol v1.0\n');

  for (let i = 0; i < NUM_NODES; i++) {
    const delay = BOOT_MIN_MS + Math.random() * BOOT_JITTER;
    await new Promise(resolve => setTimeout(resolve, delay));
    handleMessage(generateGenesis(i), 'SIM');
  }

  console.log('\n[Simulator] ✦ All 20 NITs online. Network activity starting...\n');
  _startActivity();
}

// ── Ongoing activity ──────────────────────────────────────────────

function _startActivity() {
  const registry = require('./nit-registry');

  // CAPABILITY_PULSE — every 30 s, ~70% of nodes each cycle
  setInterval(() => {
    for (const node of registry.getAllNodes()) {
      if (Math.random() > 0.30) {
        handleMessage({
          type:     'CAPABILITY_PULSE',
          node_id:  node.node_id,
          uptime:   (node.uptime || 0) + 30,
          free_mem: Math.max(
            200,
            (node.free_mem || node.capabilities?.sram_bytes || 1024) -
            Math.floor(Math.random() * 50)
          ),
        }, 'SIM');
      }
    }
  }, PULSE_MS);

  // SENSOR_EVENT — random node, random sensor, every 2-5 s
  function fireEvent() {
    const nodes = registry.getAllNodes();
    if (nodes.length > 0) {
      const node    = nodes[Math.floor(Math.random() * nodes.length)];
      const sensors = node.capabilities?.sensors || ['temperature'];
      const sensor  = sensors[Math.floor(Math.random() * sensors.length)];

      handleMessage({
        type:       'SENSOR_EVENT',
        node_id:    node.node_id,
        sensor,
        value:      parseFloat((Math.random() * 100).toFixed(2)),
        confidence: parseFloat((0.70 + Math.random() * 0.30).toFixed(2)),
      }, 'SIM');
    }
    setTimeout(fireEvent, EVENT_MIN_MS + Math.random() * (EVENT_MAX_MS - EVENT_MIN_MS));
  }

  setTimeout(fireEvent, EVENT_MIN_MS);
}

module.exports = { bootNodes };
