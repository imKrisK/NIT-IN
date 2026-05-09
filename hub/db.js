'use strict';

/**
 * NIT-IN Persistence Layer — SQLite via better-sqlite3
 * Writes through on every mutation; loads back on hub boot.
 * The registry keeps its fast in-memory Maps — SQLite is the durable mirror.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// Prefer Railway Volume mount (/app/data) when present; fall back to local ./data
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'nit.db'));

// WAL mode — safe concurrent reads while writing
db.pragma('journal_mode = WAL');
db.pragma('synchronous   = NORMAL');

// ── Schema ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    node_id    TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS edges (
    edge_key   TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS feed (
    id         TEXT PRIMARY KEY,
    node_id    TEXT NOT NULL,
    data       TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_feed_created ON feed(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_feed_node    ON feed(node_id);

  CREATE TABLE IF NOT EXISTS dms (
    id         TEXT    PRIMARY KEY,
    from_id    TEXT    NOT NULL,
    to_id      TEXT    NOT NULL,
    msg        TEXT    NOT NULL,
    sig        TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_dms_to   ON dms(to_id,   created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dms_from ON dms(from_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS waitlist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL,
    plan       TEXT    NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(email, plan)
  );

  CREATE TABLE IF NOT EXISTS challenges (
    id         TEXT    PRIMARY KEY,
    nit_id     TEXT    NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_challenges_nit ON challenges(nit_id, created_at DESC);

  -- Phase 28: ZK compliance proof commitments from Arduino Uno Q Linux core
  CREATE TABLE IF NOT EXISTS zk_commitments (
    id               TEXT    PRIMARY KEY,
    principle_id     TEXT    NOT NULL,
    batch_time_start INTEGER NOT NULL,
    batch_time_end   INTEGER NOT NULL,
    event_count      INTEGER NOT NULL,
    blocked_count    INTEGER NOT NULL,
    approved_count   INTEGER NOT NULL,
    batch_commitment TEXT    NOT NULL,   -- Poseidon(principle_id_hash, time_start, time_end)
    proof            TEXT    NOT NULL,   -- JSON: snarkjs Groth16 proof object
    public_signals   TEXT    NOT NULL,   -- JSON: string[] of public signal field elements
    verified         INTEGER NOT NULL DEFAULT 0,  -- 1 = NIT-IN re-ran verifier and passed
    circuit_vkey_hash TEXT,             -- SHA-256 of verification_key.json used by prover
    hub_vkey_hash     TEXT,             -- SHA-256 of verification_key.json on Hub at commit time
    vkey_match        INTEGER NOT NULL DEFAULT 0, -- 1 = hashes matched (no desync)
    arduino_node_id  TEXT,
    twin_instance    TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_zk_principle ON zk_commitments(principle_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_zk_verified  ON zk_commitments(verified, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_zk_node      ON zk_commitments(arduino_node_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS platform_bindings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nit_id     TEXT    NOT NULL,
    platform   TEXT    NOT NULL,
    bound_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(nit_id, platform)
  );
  CREATE INDEX IF NOT EXISTS idx_bindings_nit ON platform_bindings(nit_id);
`);

// Phase 28.1 migration — add vkey hash columns to existing zk_commitments rows.
// ALTER TABLE IF NOT EXISTS COLUMN is unavailable pre-SQLite 3.37 — use pragma introspection.
{
  const cols = db.pragma('table_info(zk_commitments)').map(c => c.name);
  if (!cols.includes('circuit_vkey_hash')) {
    db.exec("ALTER TABLE zk_commitments ADD COLUMN circuit_vkey_hash TEXT");
    db.exec("ALTER TABLE zk_commitments ADD COLUMN hub_vkey_hash TEXT");
    db.exec("ALTER TABLE zk_commitments ADD COLUMN vkey_match INTEGER NOT NULL DEFAULT 0");
    console.log('[DB] Migrated zk_commitments: added circuit_vkey_hash, hub_vkey_hash, vkey_match');
  }
}

// ── Prepared statements ───────────────────────────────────────────
const S = {
  upsertNode:  db.prepare('INSERT OR REPLACE INTO nodes  (node_id, data, updated_at) VALUES (?, ?, unixepoch())'),
  getAllNodes:  db.prepare('SELECT data FROM nodes'),

  upsertEdge:  db.prepare('INSERT OR REPLACE INTO edges  (edge_key, data)            VALUES (?, ?)'),
  getAllEdges:  db.prepare('SELECT data FROM edges'),

  insertPost:  db.prepare('INSERT OR IGNORE  INTO feed   (id, node_id, data)         VALUES (?, ?, ?)'),
  loadFeed:    db.prepare('SELECT data FROM feed ORDER BY created_at DESC LIMIT ?'),
  countFeed:   db.prepare('SELECT COUNT(*) AS cnt FROM feed'),
  pruneFeed:   db.prepare(`
    DELETE FROM feed WHERE id IN (
      SELECT id FROM feed ORDER BY created_at ASC LIMIT ?
    )
  `),

  insertDm:    db.prepare('INSERT OR IGNORE INTO dms (id, from_id, to_id, msg, sig) VALUES (?, ?, ?, ?, ?)'),
  loadDmsTo:   db.prepare('SELECT id, from_id, to_id, msg, sig, created_at FROM dms WHERE to_id = ? ORDER BY created_at DESC LIMIT ?'),
  loadDmsFrom: db.prepare('SELECT id, from_id, to_id, msg, sig, created_at FROM dms WHERE from_id = ? ORDER BY created_at DESC LIMIT ?'),

  insertWaitlist: db.prepare('INSERT OR IGNORE INTO waitlist (email, plan) VALUES (?, ?)'),
  loadWaitlist:   db.prepare('SELECT email, plan, created_at FROM waitlist ORDER BY created_at DESC'),

  insertChallenge:     db.prepare('INSERT INTO challenges (id, nit_id) VALUES (?, ?)'),
  loadChallenge:       db.prepare('SELECT id, nit_id, used, created_at FROM challenges WHERE id = ?'),
  markChallengeUsed:   db.prepare('UPDATE challenges SET used = 1 WHERE id = ?'),
  pruneOldChallenges:  db.prepare('DELETE FROM challenges WHERE created_at < ?'),

  insertBinding:       db.prepare('INSERT OR IGNORE INTO platform_bindings (nit_id, platform) VALUES (?, ?)'),
  loadBindings:        db.prepare('SELECT platform, bound_at FROM platform_bindings WHERE nit_id = ? ORDER BY bound_at ASC'),

  // Phase 28: ZK commitments
  insertZkCommit:  db.prepare(`
    INSERT OR IGNORE INTO zk_commitments
      (id, principle_id, batch_time_start, batch_time_end, event_count, blocked_count, approved_count,
       batch_commitment, proof, public_signals, verified, circuit_vkey_hash, hub_vkey_hash, vkey_match,
       arduino_node_id, twin_instance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateZkVerified: db.prepare('UPDATE zk_commitments SET verified = ? WHERE id = ?'),
  loadZkCommit:     db.prepare('SELECT * FROM zk_commitments WHERE id = ?'),
  loadZkLog:        db.prepare('SELECT * FROM zk_commitments ORDER BY created_at DESC LIMIT ?'),
  loadZkByPrinciple: db.prepare('SELECT * FROM zk_commitments WHERE principle_id = ? ORDER BY created_at DESC LIMIT ?'),
};

const FEED_CAP = 2000; // max rows kept in DB

// ── Public API ────────────────────────────────────────────────────
module.exports = {
  // Nodes
  saveNode(node) {
    S.upsertNode.run(node.node_id, JSON.stringify(node));
  },
  loadAllNodes() {
    return S.getAllNodes.all().map(r => JSON.parse(r.data));
  },

  // Edges
  saveEdge(key, edge) {
    S.upsertEdge.run(key, JSON.stringify(edge));
  },
  loadAllEdges() {
    return S.getAllEdges.all().map(r => JSON.parse(r.data));
  },

  // Feed
  savePost(post) {
    S.insertPost.run(post.id, post.node_id, JSON.stringify(post));
    // Prune if over cap
    const { cnt } = S.countFeed.get();
    if (cnt > FEED_CAP) S.pruneFeed.run(cnt - FEED_CAP);
  },
  loadFeed(limit = 500) {
    return S.loadFeed.all(limit).map(r => JSON.parse(r.data));
  },
  clearFeed() {
    db.prepare('DELETE FROM feed').run();
  },

  // DMs
  saveDm({ from_id, to_id, msg, sig }) {
    const id = `dm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = new Date().toISOString();
    S.insertDm.run(id, from_id, to_id, msg, sig);
    return { id, from_id, to_id, msg, sig, timestamp };
  },
  loadDms(nit_id, limit = 50) {
    return S.loadDmsTo.all(nit_id, limit).map(r => ({
      ...r,
      timestamp: new Date(r.created_at * 1000).toISOString(),
    }));
  },
  loadSentDms(nit_id, limit = 50) {
    return S.loadDmsFrom.all(nit_id, limit).map(r => ({
      ...r,
      timestamp: new Date(r.created_at * 1000).toISOString(),
    }));
  },

  // Waitlist
  addWaitlist(email, plan) {
    const info = S.insertWaitlist.run(email.trim().toLowerCase(), plan);
    return info.changes > 0; // false = already signed up
  },
  loadWaitlist() {
    return S.loadWaitlist.all().map(r => ({
      ...r,
      created_at: new Date(r.created_at * 1000).toISOString(),
    }));
  },

  // Challenges
  saveChallenge(nit_id, challenge) {
    // Prune challenges older than 10 minutes before inserting
    S.pruneOldChallenges.run(Math.floor(Date.now() / 1000) - 600);
    S.insertChallenge.run(challenge, nit_id);
  },
  loadChallenge(challenge) {
    return S.loadChallenge.get(challenge) || null;
  },
  markChallengeUsed(challenge) {
    S.markChallengeUsed.run(challenge);
  },

  // Platform bindings
  savePlatformBinding(nit_id, platform) {
    S.insertBinding.run(nit_id, platform);
  },
  loadPlatformBindings(nit_id) {
    return S.loadBindings.all(nit_id).map(r => ({
      platform: r.platform,
      bound_at: new Date(r.bound_at * 1000).toISOString(),
    }));
  },

  // Phase 28: ZK commitment storage
  saveZkCommit({ id, principle_id, batch_time_start, batch_time_end, event_count, blocked_count,
                 batch_commitment, proof, public_signals, verified, circuit_vkey_hash, hub_vkey_hash,
                 vkey_match, arduino_node_id, twin_instance }) {
    S.insertZkCommit.run(
      id, principle_id, batch_time_start, batch_time_end,
      event_count, blocked_count, event_count - blocked_count,
      batch_commitment,
      JSON.stringify(proof),
      JSON.stringify(public_signals),
      verified ? 1 : 0,
      circuit_vkey_hash || null,
      hub_vkey_hash     || null,
      vkey_match        ? 1 : 0,
      arduino_node_id   || null,
      twin_instance     || null,
    );
  },
  markZkVerified(id, verified) {
    S.updateZkVerified.run(verified ? 1 : 0, id);
  },
  loadZkCommit(id) {
    const row = S.loadZkCommit.get(id);
    if (!row) return null;
    return {
      ...row,
      proof:          JSON.parse(row.proof),
      public_signals: JSON.parse(row.public_signals),
      created_at:     new Date(row.created_at * 1000).toISOString(),
    };
  },
  loadZkLog(limit = 50) {
    return S.loadZkLog.all(Math.min(limit, 200)).map(row => ({
      ...row,
      proof:          JSON.parse(row.proof),
      public_signals: JSON.parse(row.public_signals),
      created_at:     new Date(row.created_at * 1000).toISOString(),
    }));
  },
  loadZkByPrinciple(principle_id, limit = 20) {
    return S.loadZkByPrinciple.all(principle_id, Math.min(limit, 100)).map(row => ({
      ...row,
      proof:          JSON.parse(row.proof),
      public_signals: JSON.parse(row.public_signals),
      created_at:     new Date(row.created_at * 1000).toISOString(),
    }));
  },

  // Raw db instance for migrations / diagnostics
  db,
};
