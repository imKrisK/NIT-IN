'use strict';

/**
 * NIT-IN Persistence Layer — SQLite via better-sqlite3
 * Writes through on every mutation; loads back on hub boot.
 * The registry keeps its fast in-memory Maps — SQLite is the durable mirror.
 */

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
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
`);

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
  // Raw db instance for migrations / diagnostics
  db,
};
