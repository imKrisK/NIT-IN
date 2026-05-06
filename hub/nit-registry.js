'use strict';

/**
 * NIT Registry — in-memory sovereign store for all Node Identity Tokens
 * Birth_Rights Protocol v1.0 — No token is revocable by a third party
 *
 * All mutations write-through to SQLite via hub/db.js.
 * On boot call registry.hydrate() to reload persisted state.
 */

const db = require('./db');

const RESONANCE_THRESHOLD = 0.60;
const OBSERVE_THRESHOLD   = 0.30;
const FEED_MAX            = 500;

class NITRegistry {
  constructor() {
    this.nodes = new Map(); // node_id -> node object
    this.edges = new Map(); // "id1:id2" (sorted) -> edge object
    this.feed  = [];        // chronological post log (capped at FEED_MAX, newest first)
  }

  // ── Persistence ─────────────────────────────────────────────────

  // Call once at startup — reloads everything from SQLite
  hydrate() {
    let nodeCount = 0, edgeCount = 0, feedCount = 0;

    for (const node of db.loadAllNodes()) {
      this.nodes.set(node.node_id, node);
      nodeCount++;
    }

    for (const edge of db.loadAllEdges()) {
      const key = [edge.source, edge.target].sort().join(':');
      this.edges.set(key, edge);
      // Rebuild in-memory connection lists
      const n1 = this.nodes.get(edge.source);
      const n2 = this.nodes.get(edge.target);
      if (n1 && !n1.connections.includes(edge.target)) n1.connections.push(edge.target);
      if (n2 && !n2.connections.includes(edge.source)) n2.connections.push(edge.source);
      edgeCount++;
    }

    for (const post of db.loadFeed(FEED_MAX)) {
      this.feed.push(post);
      feedCount++;
    }
    // feed is stored DESC (newest first) by the DB query, keep that order
    console.log(`[Registry] ◈ Hydrated — ${nodeCount} nodes · ${edgeCount} edges · ${feedCount} posts`);
  }

  // ── Node lifecycle ──────────────────────────────────────────────

  registerNode(profile) {
    const existing = this.nodes.get(profile.node_id);
    const node = {
      ...profile,
      first_seen:  existing?.first_seen || new Date().toISOString(),
      last_seen:   new Date().toISOString(),
      online:      true,
      uptime:      profile.uptime || 0,
      free_mem:    profile.free_mem || profile.capabilities?.sram_bytes || 0,
      connections: existing?.connections ? [...existing.connections] : [],
      post_count:  existing?.post_count || 0,
    };
    this.nodes.set(profile.node_id, node);
    db.saveNode(node);
    return node;
  }

  updateNode(node_id, update) {
    const node = this.nodes.get(node_id);
    if (!node) return null;
    Object.assign(node, update, { last_seen: new Date().toISOString() });
    db.saveNode(node);
    return node;
  }

  markOffline(node_id) {
    return this.updateNode(node_id, { online: false });
  }

  // ── Feed ────────────────────────────────────────────────────────

  addPost(msg) {
    const node = this.nodes.get(msg.node_id);
    if (node) node.post_count++;

    const post = {
      ...msg,
      id:        `${msg.node_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };

    this.feed.unshift(post);
    if (this.feed.length > FEED_MAX) this.feed.pop();
    db.savePost(post);
    if (node) db.saveNode(node); // persist updated post_count
    return post;
  }

  getFeed(limit = 50) {
    return this.feed.slice(0, Math.min(limit, FEED_MAX));
  }

  clearFeed() {
    this.feed = [];
  }

  // ── Resonance & connections ─────────────────────────────────────

  computeResonance(id1, id2) {
    const n1 = this.nodes.get(id1);
    const n2 = this.nodes.get(id2);
    if (!n1 || !n2) return 0;

    // Sensor overlap (Jaccard similarity)
    const s1 = new Set(n1.capabilities?.sensors || []);
    const s2 = new Set(n2.capabilities?.sensors || []);
    const intersection = [...s1].filter(s => s2.has(s)).length;
    const union = new Set([...s1, ...s2]).size;
    const sensorScore = union > 0 ? intersection / union : 0;

    // SRAM similarity (nodes with similar resources resonate)
    const maxMem = 2048;
    const memDelta = Math.abs(
      (n1.capabilities?.sram_bytes || 1024) -
      (n2.capabilities?.sram_bytes || 1024)
    );
    const memScore = Math.max(0, 1 - memDelta / maxMem);

    // Uptime proximity
    const uptimeDelta = Math.abs((n1.uptime || 0) - (n2.uptime || 0));
    const uptimeScore = Math.max(0, 1 - uptimeDelta / 3600);

    return Math.round(
      (sensorScore * 0.50 + memScore * 0.30 + uptimeScore * 0.20) * 100
    ) / 100;
  }

  evaluateReaction(from_id, to_id) {
    const score = this.computeResonance(from_id, to_id);
    const from  = this.nodes.get(from_id);

    // Busy (low memory) nodes defer
    if ((from?.capabilities?.sram_bytes || 999) < 400) {
      return { reaction: 'DEFER', score };
    }

    if (score >= RESONANCE_THRESHOLD) return { reaction: 'RESONATE', score };
    if (score >= OBSERVE_THRESHOLD)   return { reaction: 'OBSERVE',   score };
    return { reaction: 'IGNORE', score };
  }

  establishConnection(id1, id2, score) {
    const key = [id1, id2].sort().join(':');
    if (this.edges.has(key)) return false;

    const edge = {
      source:          id1,
      target:          id2,
      resonance_score: score,
      established:     new Date().toISOString(),
    };
    this.edges.set(key, edge);
    db.saveEdge(key, edge);

    const n1 = this.nodes.get(id1);
    const n2 = this.nodes.get(id2);
    if (n1 && !n1.connections.includes(id2)) { n1.connections.push(id2); db.saveNode(n1); }
    if (n2 && !n2.connections.includes(id1)) { n2.connections.push(id1); db.saveNode(n2); }
    return true;
  }

  // ── Serialisers ─────────────────────────────────────────────────

  getAllNodes() {
    return [...this.nodes.values()];
  }

  getGraphData() {
    return {
      nodes: [...this.nodes.values()].map(n => ({
        id:          n.node_id,
        online:      n.online,
        connections: n.connections.length,
        post_count:  n.post_count,
        uptime:      n.uptime || 0,
        free_mem:    n.free_mem || 0,
        sensors:     n.capabilities?.sensors || [],
        hardware_sig: n.hardware_sig || '',
      })),
      edges: [...this.edges.values()],
    };
  }

  getStats() {
    const nodes = this.getAllNodes();
    const edgeCount = this.edges.size;
    const n = nodes.length;
    const density = n > 1
      ? Number((2 * edgeCount / (n * (n - 1))).toFixed(3))
      : 0;
    return {
      total_nodes:    n,
      online_nodes:   nodes.filter(x => x.online).length,
      total_edges:    edgeCount,
      total_posts:    this.feed.length,
      network_density: density,
    };
  }
}

module.exports = new NITRegistry();
