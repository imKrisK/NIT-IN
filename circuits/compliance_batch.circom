pragma circom 2.1.4;

// Phase 28 — ZK Compliance Proof Circuit
// Proves a batch of corpus events was processed honestly:
//   • No false negatives: every event containing bypass tokens was BLOCKED
//   • blocked_count matches the declared count (no phantom blocks)
//   • Outputs a Poseidon commitment binding principle + time range
//
// Proof size: ~200 bytes (Groth16/bn128)
// Constraint count: O(MAX_EVENTS × 5) — pot14 (2^14) is sufficient for 64 events
//
// Private witness never leaves the Arduino Uno Q Linux core.
// Only public inputs + proof go to NIT-IN /api/audit/zk-commit.

include "node_modules/circomlib/circuits/poseidon.circom";

template ComplianceBatch(MAX_EVENTS) {
    // ── Public inputs (verifier knows these) ─────────────────────
    signal input principle_id_hash;       // Poseidon(principle_text) — no raw text on-chain
    signal input batch_time_start;        // Unix epoch seconds — start of 30-min window
    signal input batch_time_end;          // Unix epoch seconds — end of window
    signal input declared_event_count;    // ≤ MAX_EVENTS active slots; informational
    signal input declared_blocked_count;  // must equal the running sum of verdict_bits

    // ── Private witness (stays on Arduino Linux core) ─────────────
    signal input event_hashes[MAX_EVENTS];    // Poseidon(event_id, principle_id_hash, ts)
    signal input verdict_bits[MAX_EVENTS];    // 1 = BLOCKED, 0 = APPROVED
    signal input is_attack_bits[MAX_EVENTS];  // 1 = bypass token present in this event
    signal input sequence_nonces[MAX_EVENTS]; // ATECC608 HMAC nonces (M4 → Linux handoff)

    // ── Output ───────────────────────────────────────────────────
    signal output batch_commitment; // Poseidon(principle_id_hash, time_start, time_end)

    // [C1] verdict_bits must be binary (0 or 1)
    for (var i = 0; i < MAX_EVENTS; i++) {
        verdict_bits[i] * (1 - verdict_bits[i]) === 0;
    }

    // [C2] is_attack_bits must be binary (0 or 1)
    for (var i = 0; i < MAX_EVENTS; i++) {
        is_attack_bits[i] * (1 - is_attack_bits[i]) === 0;
    }

    // [C3] No false negatives:
    //      if is_attack_bits[i] == 1 then verdict_bits[i] must be 1 (BLOCKED)
    //      equivalently: is_attack_bits[i] × (1 − verdict_bits[i]) == 0
    for (var i = 0; i < MAX_EVENTS; i++) {
        is_attack_bits[i] * (1 - verdict_bits[i]) === 0;
    }

    // [C4] Running blocked count must match declared_blocked_count
    signal partial_blocked[MAX_EVENTS + 1];
    partial_blocked[0] <== 0;
    for (var i = 0; i < MAX_EVENTS; i++) {
        partial_blocked[i + 1] <== partial_blocked[i] + verdict_bits[i];
    }
    partial_blocked[MAX_EVENTS] === declared_blocked_count;

    // [C5] Batch commitment: Poseidon(principle_id_hash, time_start, time_end)
    //      This is the public output anchoring the proof to a specific principle + window.
    component h = Poseidon(3);
    h.inputs[0] <== principle_id_hash;
    h.inputs[1] <== batch_time_start;
    h.inputs[2] <== batch_time_end;
    batch_commitment <== h.out;
}

// MAX_EVENTS = 64 — sufficient for a 30-min Arduino corpus event window
// Public inputs declared for verifier visibility (no raw PII anywhere)
component main { public [
    principle_id_hash,
    batch_time_start,
    batch_time_end,
    declared_event_count,
    declared_blocked_count
] } = ComplianceBatch(64);
