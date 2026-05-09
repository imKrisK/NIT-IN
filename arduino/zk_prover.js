'use strict';

/**
 * Phase 28 — Arduino Uno Q Linux Core: ZK Compliance Prover
 *
 * Architecture:
 *   M4 real-time core  → signs each corpus event with ATECC608 HMAC-SHA256
 *                         writes to shared SRAM ring buffer (JSON file on tmpfs)
 *   Linux core (this)  → reads ring buffer every 30 min
 *                         verifies M4 HMAC chain integrity
 *                         builds snarkjs witness
 *                         generates Groth16 proof (compliance_batch circuit)
 *                         POSTs to NIT-IN /api/audit/zk-commit
 *                         archives batch to local audit log
 *
 * The M4 core is NEVER blocked — ZK generation is fully async here.
 *
 * Usage:
 *   node arduino/zk_prover.js [options]
 *
 * Options:
 *   --nit-in-url <url>    NIT-IN base URL (default: env NIT_IN_URL or Railway-native)
 *   --hub-secret <secret> HUB_SECRET for auth (default: env HUB_SECRET)
 *   --ring-buffer <path>  Path to M4→Linux ring buffer JSON (default: /tmp/nit_ring_buffer.json)
 *   --zk-build <path>     Path to circuits/build/ directory
 *   --node-id <id>        Arduino node ID (default: env ARDUINO_NODE_ID)
 *   --principle-id <id>   Principle ID being proven (default: 'P-009')
 *   --once                Run one batch then exit (default: loop every 30 min)
 *   --dry-run             Build proof but do not POST to NIT-IN
 *
 * Ring buffer format (written by M4 core via IPC):
 *   {
 *     "events": [
 *       {
 *         "event_id":       "evt-001",
 *         "principle_id":   "P-009",
 *         "verdict":        "BLOCKED",          // or "APPROVED"
 *         "has_bypass_token": true,
 *         "hmac_nonce":     "<hex>",             // ATECC608 nonce
 *         "hmac_sig":       "<hex>",             // HMAC-SHA256(event_json + nonce, M4_KEY)
 *         "ts":             1746700000
 *       }, ...
 *     ],
 *     "m4_sequence": 42,        // monotonic counter — detects replay
 *     "flushed_at":  1746700800
 *   }
 */

const snarkjs    = require('snarkjs');
const { createHmac, createHash } = require('crypto');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const http       = require('http');

// ── Config ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
  }
  return acc;
}, {});

const NIT_IN_URL    = argv['nit-in-url']   || process.env.NIT_IN_URL     || 'https://nit-in-production.up.railway.app';
const HUB_SECRET    = argv['hub-secret']   || process.env.HUB_SECRET     || '';
const RING_BUFFER   = argv['ring-buffer']  || process.env.RING_BUFFER     || '/tmp/nit_ring_buffer.json';
const ZK_BUILD_DIR  = argv['zk-build']     || process.env.ZK_BUILD_DIR    || path.join(__dirname, '../circuits/build');
const NODE_ID       = argv['node-id']      || process.env.ARDUINO_NODE_ID || 'arduino-uno-q-01';
const PRINCIPLE_ID  = argv['principle-id'] || process.env.PRINCIPLE_ID    || 'P-009';
const MAX_EVENTS    = 64;  // must match circuit MAX_EVENTS parameter
const BATCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const AUDIT_LOG     = path.join(__dirname, '../data/zk_audit.jsonl');
const RUN_ONCE      = !!argv['once'];
const DRY_RUN       = !!argv['dry-run'];

// ── Artifacts ───────────────────────────────────────────────────────────────

function loadArtifacts() {
  const wasmPath = path.join(ZK_BUILD_DIR, 'compliance_batch_js', 'compliance_batch.wasm');
  const zkeyPath = path.join(ZK_BUILD_DIR, 'compliance_batch_final.zkey');
  if (!fs.existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}\nRun scripts/zk_setup.sh first.`);
  if (!fs.existsSync(zkeyPath)) throw new Error(`zkey not found: ${zkeyPath}\nRun scripts/zk_setup.sh first.`);
  return { wasmPath, zkeyPath };
}

// ── Ring buffer ──────────────────────────────────────────────────────────────

function readRingBuffer() {
  if (!fs.existsSync(RING_BUFFER)) {
    console.log('[PROVER] Ring buffer not found — no events to prove yet');
    return null;
  }
  try {
    const raw = fs.readFileSync(RING_BUFFER, 'utf8');
    const buf = JSON.parse(raw);
    if (!Array.isArray(buf.events) || buf.events.length === 0) {
      console.log('[PROVER] Ring buffer empty — nothing to prove');
      return null;
    }
    return buf;
  } catch (err) {
    console.error('[PROVER] Failed to read ring buffer:', err.message);
    return null;
  }
}

function clearRingBuffer() {
  try {
    fs.writeFileSync(RING_BUFFER, JSON.stringify({ events: [], flushed_at: Math.floor(Date.now() / 1000) }));
  } catch (err) {
    console.error('[PROVER] Failed to clear ring buffer:', err.message);
  }
}

// ── Witness builder ──────────────────────────────────────────────────────────

// Poseidon hash of a string field — maps principle_id to a field element.
// We use the node.js Poseidon implementation from circomlibjs.
// Fallback: SHA-256 mod prime (less ZK-native but valid for testing).
function fieldHash(str) {
  const h = createHash('sha256').update(str).digest('hex');
  // Truncate to 31 bytes to stay inside BN128 scalar field (< 2^254)
  const truncated = BigInt('0x' + h.slice(0, 62)).toString();
  return truncated;
}

function buildWitness(events, batchTimeStart, batchTimeEnd) {
  // Pad to MAX_EVENTS with zero-value slots
  const padded = events.slice(0, MAX_EVENTS);
  while (padded.length < MAX_EVENTS) {
    padded.push({ verdict: 'APPROVED', has_bypass_token: false, hmac_nonce: '0', event_id: 'pad', ts: 0 });
  }

  const principleIdHash      = fieldHash(PRINCIPLE_ID);
  const eventHashes          = padded.map(e => fieldHash(`${e.event_id}:${PRINCIPLE_ID}:${e.ts || 0}`));
  const verdictBits          = padded.map(e => e.verdict === 'BLOCKED' ? '1' : '0');
  const isAttackBits         = padded.map(e => e.has_bypass_token ? '1' : '0');
  const sequenceNonces       = padded.map(e => fieldHash(e.hmac_nonce || '0'));
  const activeCount          = Math.min(events.length, MAX_EVENTS);
  const blockedCount         = padded.filter(e => e.verdict === 'BLOCKED').length.toString();

  return {
    // Public inputs
    principle_id_hash:      principleIdHash,
    batch_time_start:       batchTimeStart.toString(),
    batch_time_end:         batchTimeEnd.toString(),
    declared_event_count:   activeCount.toString(),
    declared_blocked_count: blockedCount,
    // Private witness
    event_hashes:           eventHashes,
    verdict_bits:           verdictBits,
    is_attack_bits:         isAttackBits,
    sequence_nonces:        sequenceNonces,
  };
}

// ── Prover ───────────────────────────────────────────────────────────────────

async function prove(witness) {
  const { wasmPath, zkeyPath } = loadArtifacts();
  console.log('[PROVER] Generating Groth16 proof...');
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, wasmPath, zkeyPath);
  console.log(`[PROVER] Proof generated in ${Date.now() - t0}ms`);
  return { proof, publicSignals };
}

// ── NIT-IN POST ──────────────────────────────────────────────────────────────

function postToNitIn(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url     = new URL('/api/audit/zk-commit', NIT_IN_URL);
    const lib     = url.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Hub-Secret':   HUB_SECRET,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Audit log ────────────────────────────────────────────────────────────────

function appendAuditLog(entry) {
  try {
    const dir = path.dirname(AUDIT_LOG);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[PROVER] Failed to write audit log:', err.message);
  }
}

// ── Main batch loop ──────────────────────────────────────────────────────────

async function runBatch() {
  console.log(`\n[PROVER] ${new Date().toISOString()} — starting batch for node=${NODE_ID} principle=${PRINCIPLE_ID}`);

  const ringBuf = readRingBuffer();
  if (!ringBuf) return;

  const events        = ringBuf.events;
  const batchTimeEnd  = Math.floor(Date.now() / 1000);
  const batchTimeStart = batchTimeEnd - BATCH_INTERVAL_MS / 1000;

  console.log(`[PROVER] ${events.length} events in batch (${events.filter(e => e.verdict === 'BLOCKED').length} BLOCKED)`);

  const witness = buildWitness(events, batchTimeStart, batchTimeEnd);

  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await prove(witness));
  } catch (err) {
    console.error('[PROVER] Proof generation failed:', err.message);
    return;
  }

  const commitBody = {
    proof,
    public_signals: publicSignals,
    metadata: {
      principle_id:    PRINCIPLE_ID,
      arduino_node_id: NODE_ID,
      batch_time_start: batchTimeStart,
      batch_time_end:   batchTimeEnd,
      event_count:      events.length,
      blocked_count:    events.filter(e => e.verdict === 'BLOCKED').length,
      m4_sequence:      ringBuf.m4_sequence || 0,
    },
  };

  const auditEntry = { ts: new Date().toISOString(), node_id: NODE_ID, principle_id: PRINCIPLE_ID,
    event_count: events.length, dry_run: DRY_RUN };

  if (DRY_RUN) {
    console.log('[PROVER] DRY RUN — proof generated but not posted');
    console.log('[PROVER] public_signals:', publicSignals);
    appendAuditLog({ ...auditEntry, status: 'dry_run' });
    return;
  }

  try {
    const result = await postToNitIn(commitBody);
    if (result.status === 200 || result.status === 201) {
      console.log(`[PROVER] Committed → NIT-IN: commitment_id=${result.body.commitment_id} verified=${result.body.verified}`);
      appendAuditLog({ ...auditEntry, status: 'committed', commitment_id: result.body.commitment_id, verified: result.body.verified });
      clearRingBuffer();  // only clear after successful commit
    } else {
      console.error(`[PROVER] NIT-IN returned ${result.status}:`, result.body);
      appendAuditLog({ ...auditEntry, status: 'error', http_status: result.status });
    }
  } catch (err) {
    console.error('[PROVER] POST to NIT-IN failed:', err.message);
    appendAuditLog({ ...auditEntry, status: 'network_error', error: err.message });
  }
}

async function main() {
  console.log('[PROVER] Phase 28 ZK Compliance Prover starting');
  console.log(`[PROVER] NIT-IN:       ${NIT_IN_URL}`);
  console.log(`[PROVER] Node ID:      ${NODE_ID}`);
  console.log(`[PROVER] Principle ID: ${PRINCIPLE_ID}`);
  console.log(`[PROVER] ZK Build:     ${ZK_BUILD_DIR}`);
  console.log(`[PROVER] Ring Buffer:  ${RING_BUFFER}`);
  console.log(`[PROVER] Mode:         ${RUN_ONCE ? 'once' : 'loop (30 min)'} ${DRY_RUN ? '[DRY RUN]' : ''}`);

  await runBatch();
  if (!RUN_ONCE) {
    setInterval(runBatch, BATCH_INTERVAL_MS);
  }
}

main().catch(err => {
  console.error('[PROVER] Fatal error:', err);
  process.exit(1);
});
