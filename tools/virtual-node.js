#!/usr/bin/env node
'use strict';

/**
 * NIT-IN Virtual Node — Hardware Emulator
 *
 * Emulates exactly what the Arduino firmware transmits over USB serial,
 * but instead of a physical cable it POSTs JSON to the hub's /api/ingest
 * endpoint. Identical telemetry pipeline — zero hardware required.
 *
 * Usage:
 *   node tools/virtual-node.js
 *   node tools/virtual-node.js --hub=http://localhost:3001
 *   node tools/virtual-node.js --id=NIT-DEMO-001 --sensors=light,temperature
 *   node tools/virtual-node.js --count=3   (spawns 3 independent virtual nodes)
 *
 * Each instance runs as a single persistent process.
 * Multiple nodes can run simultaneously; each gets its own identity.
 */

const http   = require('http');
const crypto = require('crypto');

// ── CLI args ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v || true]; })
);

const HUB      = args.hub      || 'http://localhost:3001';
const COUNT    = parseInt(args.count || '1', 10);
const FIXED_ID = args.id       || null;
const FIXED_SN = args.sensors  ? args.sensors.split(',') : null;

// ── Sensor catalogue (mirrors Arduino firmware) ───────────────────
const SENSOR_POOL = ['light', 'ultrasonic', 'temperature', 'humidity', 'motion', 'sound', 'pressure', 'gas'];

// ── Node factory ──────────────────────────────────────────────────
function createVirtualNode(index) {
  const suffix = FIXED_ID
    ? (COUNT > 1 ? `${FIXED_ID}-${String(index + 1).padStart(2, '0')}` : FIXED_ID)
    : `NIT-VIRT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  const hw_sig   = crypto.randomBytes(8).toString('hex').toUpperCase();
  const sensors  = FIXED_SN
    ? [...FIXED_SN]
    : SENSOR_POOL.sort(() => Math.random() - .5).slice(0, 2 + Math.floor(Math.random() * 3));
  const sram     = 512 + Math.floor(Math.random() * 1536);   // 512–2048 bytes
  const adc      = Object.fromEntries(sensors.map(s => [s, 300 + Math.floor(Math.random() * 600)]));

  let uptime = 0;
  let memUsed = 0;

  // ── HTTP POST to hub ─────────────────────────────────────────────
  function post(payload) {
    return new Promise(resolve => {
      const body = JSON.stringify(payload);
      const url  = new URL('/api/ingest', HUB);
      const req  = http.request({
        hostname: url.hostname,
        port:     Number(url.port) || 80,
        path:     url.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-NIT-Virtual':  '1',
        },
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.write(body);
      req.end();
    });
  }

  // ── Genesis — sent once on boot ───────────────────────────────────
  async function genesis() {
    console.log(`[${suffix}] ◈ Booting — sensors: ${sensors.join(', ')}  hw_sig: ${hw_sig}`);
    await post({
      type:    'NIT_GENESIS',
      node_id: suffix,
      hw_sig,
      sensors,
      sram,
      uptime:  0,
    });
    console.log(`[${suffix}] ✓ Genesis transmitted to ${HUB}`);
  }

  // ── Capability pulse — every 30s ─────────────────────────────────
  async function pulse() {
    uptime++;
    memUsed += 2 + Math.floor(Math.random() * 4);
    await post({
      type:     'CAPABILITY_PULSE',
      node_id:  suffix,
      hw_sig,
      sensors,
      sram,
      uptime,
      free_mem: Math.max(64, sram - memUsed),
    });
  }

  // ── Sensor event — when ADC delta > 25 ───────────────────────────
  async function sensorTick() {
    const sensor = sensors[Math.floor(Math.random() * sensors.length)];
    const delta  = Math.floor(Math.random() * 200) - 100; // ±100
    const newVal = Math.max(0, Math.min(1023, adc[sensor] + delta));
    adc[sensor]  = newVal;

    if (Math.abs(delta) > 25) {
      await post({
        type:       'SENSOR_EVENT',
        node_id:    suffix,
        hw_sig,
        sensor,
        value:      newVal,
        delta:      Math.abs(delta),
        confidence: Number(Math.min(1, Math.abs(delta) / 100).toFixed(2)),
      });
      console.log(`[${suffix}] ⬡ ${sensor}  Δ${delta > 0 ? '+' : ''}${delta}  val=${newVal}`);
    }
  }

  // ── Run ───────────────────────────────────────────────────────────
  async function run() {
    // Stagger startup so multiple nodes don't all genesis at the same second
    await new Promise(r => setTimeout(r, index * 800));

    await genesis();

    // Pulse every 30s
    setInterval(pulse, 30_000);

    // Sensor tick every 3–8s (randomised per node)
    const tickInterval = 3_000 + Math.random() * 5_000;
    setInterval(sensorTick, tickInterval);

    console.log(`[${suffix}] ◎ Online — tick every ${Math.round(tickInterval / 1000)}s`);
  }

  return { run, id: suffix };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  NIT-IN Virtual Node Emulator        ║`);
  console.log(`║  Hub   → ${HUB.padEnd(27)}║`);
  console.log(`║  Count → ${String(COUNT).padEnd(27)}║`);
  console.log(`╚══════════════════════════════════════╝\n`);

  const nodes = Array.from({ length: COUNT }, (_, i) => createVirtualNode(i));
  await Promise.all(nodes.map(n => n.run()));
}

main().catch(err => {
  console.error('[VirtualNode] Fatal:', err.message);
  process.exit(1);
});
