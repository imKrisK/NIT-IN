/**
 * ACIL — Interactive Presentation Server
 *
 * Serves the live infographic on http://localhost:7420
 * Reads real ACIL data from ~/.acil/ (shared with VS Code extension)
 * Exposes SSE stream for live updates + REST endpoints for chart data
 *
 * Zero npm dependencies — pure Node.js http module.
 */

'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const PORT         = parseInt(process.env.PORT ?? '7420', 10);
const STORAGE_PATH = process.env.ACIL_STORAGE ?? path.join(os.homedir(), '.acil');
const HTML_FILE    = path.join(__dirname, 'index.html');

// ── Data helpers ──────────────────────────────────────────────────────────────

function readJson(name, fallback = {}) {
  const p = path.join(STORAGE_PATH, name);
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return fallback; }
}

function buildStatus() {
  const audit    = readJson('acil-audit.json',    { events: [] });
  const outcomes = readJson('acil-outcomes.json',  { outcomes: [], generation: 0 });
  const feedback = readJson('acil-feedback.json',  { events: [] });
  const profile  = readJson('acil-profile.json',   { monthlyAllocation: 39, balance: 39 });

  const events   = Array.isArray(audit.events) ? audit.events : [];
  const fbEvents = Array.isArray(feedback.events) ? feedback.events : [];

  // Budget
  const budget  = profile.monthlyAllocation ?? 39;
  const balance = profile.balance ?? budget;
  const spent   = budget - balance;

  // Today
  const today     = new Date().toISOString().slice(0, 10);
  const todayEvts = events.filter(e => e.timestamp?.slice(0, 10) === today);
  const todayCost = todayEvts.reduce((s, e) => s + (e.netCost ?? e.grossCost ?? 0), 0);

  // State
  const pct   = spent / budget;
  const state = pct >= 1.0 ? 'EMERGENCY' : pct >= 0.98 ? 'HARD_BLOCK' : pct >= 0.90 ? 'SOFT_BLOCK' : pct >= 0.75 ? 'WARNING' : pct >= 0.60 ? 'ADVISORY' : 'NORMAL';

  // Session breakdown
  const typeCounts = {};
  for (const e of events) {
    const t = e.sessionType ?? 'UNKNOWN';
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  }

  // Burn by day (last 14 days)
  const burnByDay = {};
  for (const e of events) {
    const d = e.timestamp?.slice(0, 10);
    if (d) burnByDay[d] = (burnByDay[d] ?? 0) + (e.netCost ?? e.grossCost ?? 0);
  }
  const days14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10);
    return { date: d, cost: burnByDay[d] ?? 0 };
  });

  // Feedback signals
  const cctAccepted = fbEvents.filter(e => e.action === 'CCT_ACCEPTED').length;
  const cctTotal    = fbEvents.filter(e => e.action?.startsWith('CCT')).length;
  const subAccepted = fbEvents.filter(e => e.action === 'MODEL_SUB_ACCEPTED').length;
  const subTotal    = fbEvents.filter(e => e.action?.startsWith('MODEL_SUB')).length;

  // Archetype from outcomes
  const archetype = outcomes.lastArchetype ?? 'BALANCED';
  const generation = outcomes.generation ?? 0;
  const accuracy   = outcomes.accuracy   ?? 0;

  // CCT savings
  const cctSaved = events.reduce((s, e) => {
    if (e.originalTokens && e.translatedTokens) return s + (e.originalTokens - e.translatedTokens);
    return s;
  }, 0);

  return {
    budget, balance, spent, state,
    budgetPct: Math.round(pct * 1000) / 10,
    todayCost: Math.round(todayCost * 10000) / 10000,
    todayRequests: todayEvts.length,
    totalRequests: events.length,
    sessionBreakdown: typeCounts,
    burnByDay: days14,
    feedback: { cctAcceptRate: cctTotal > 0 ? cctAccepted / cctTotal : 0.5, subAcceptRate: subTotal > 0 ? subAccepted / subTotal : 0.5, totalEvents: fbEvents.length },
    archetype, generation, accuracy,
    cctSavedTokens: cctSaved,
    timestamp: new Date().toISOString(),
  };
}

// Mock preflight simulation (runs the same logic without touching real balance)
function simulatePreflight(prompt, model, sessionHint) {
  const status = buildStatus();
  const tokens = Math.ceil(prompt.length / 3.8);

  // Classify
  const hasError = /error|exception|stack|traceback|cannot|undefined|null/i.test(prompt);
  const hasArch  = /architect|design|system|pattern|scalab|microservic/i.test(prompt);
  const hasAgent = /run|execute|deploy|bash|terminal|command/i.test(prompt);
  const sessionType = sessionHint ?? (hasError ? 'DEBUGGING' : hasArch ? 'ARCHITECTURE' : hasAgent ? 'AGENTIC' : 'BOILERPLATE');

  // CCT thresholds
  const CCT_THRESH = { DEBUGGING: 0.30, ARCHITECTURE: 0.68, BOILERPLATE: 0.65, AGENTIC: 0.60, REVIEW: 0.78, EXPLORATION: 0.72, DOCUMENTATION: 0.80 };
  const threshold = CCT_THRESH[sessionType] ?? 0.72;

  // Cost estimate (per-model rates)
  const RATES = { 'gpt-4o': 0.000005, 'gpt-4o-mini': 0.0000002, 'claude-sonnet-4-5': 0.000003, 'copilot-premium': 0.000004 };
  const rate  = RATES[model] ?? 0.000004;
  const estimatedCost = tokens * rate;

  // CCT compression simulation
  const words     = prompt.split(/\s+/);
  const compressed = words.filter((w, i) => i % 3 !== 2 || w.length > 4).join(' ');
  const jaccard   = words.filter(w => compressed.includes(w)).length / words.length;
  const cctApplied = jaccard >= threshold && prompt.length > 200;
  const savedTokens = cctApplied ? Math.floor(tokens * 0.22) : 0;

  // Substitution
  const SUBS = { 'gpt-4o': 'gpt-4o-mini', 'claude-sonnet-4-5': 'claude-haiku-3-5', 'copilot-premium': 'copilot-base' };
  const suggestedModel = (status.state === 'SOFT_BLOCK' || status.state === 'WARNING') ? (SUBS[model] ?? null) : null;

  // Pipeline steps with timing
  const steps = [
    { id: 1, name: 'Classify',  result: sessionType,                           ms: 1,   confidence: hasError ? 0.94 : 0.78 },
    { id: 2, name: 'Predict',   result: `$${estimatedCost.toFixed(5)}`,        ms: 3,   tokens },
    { id: 3, name: 'Compress',  result: cctApplied ? `−${savedTokens}t` : 'skipped', ms: 8, applied: cctApplied, jaccard: Math.round(jaccard * 100) / 100 },
    { id: 4, name: 'Route',     result: suggestedModel ?? 'keep ' + model,     ms: 1,   suggested: suggestedModel },
    { id: 5, name: 'Enforce',   result: status.state,                          ms: 1,   allowed: !['HARD_BLOCK','EMERGENCY'].includes(status.state) },
    { id: 6, name: 'Learn',     result: status.archetype,                      ms: 2,   generation: status.generation },
    { id: 7, name: 'Record',    result: 'queued',                              ms: 1,   batchId: crypto.randomUUID().slice(0,8) },
  ];

  return {
    allowed: !['HARD_BLOCK','EMERGENCY'].includes(status.state),
    sessionType, estimatedCost, tokens, savedTokens, cctApplied,
    threshold, jaccard, suggestedModel, steps, state: status.state,
  };
}

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// Poll for changes every 5 seconds
let lastHash = '';
setInterval(() => {
  const status  = buildStatus();
  const hash    = JSON.stringify(status.burnByDay.slice(-2));
  if (hash !== lastHash) { lastHash = hash; broadcast({ type: 'status', data: status }); }
}, 5000);

// ── HTTP server ───────────────────────────────────────────────────────────────

function send(res, status, body, ct = 'application/json') {
  res.writeHead(status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // ── Static HTML ────────────────────────────────────────────────────────
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(HTML_FILE, 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    } catch (e) {
      return send(res, 500, { error: 'index.html not found' });
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    sseClients.add(res);
    // Send current status immediately
    res.write(`data: ${JSON.stringify({ type: 'status', data: buildStatus() })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── REST: /api/status ─────────────────────────────────────────────────
  if (url.pathname === '/api/status' && method === 'GET') {
    return send(res, 200, buildStatus());
  }

  // ── REST: /api/simulate ───────────────────────────────────────────────
  if (url.pathname === '/api/simulate' && method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { prompt, model, sessionType } = JSON.parse(body);
        return send(res, 200, simulatePreflight(prompt ?? '', model ?? 'copilot-premium', sessionType));
      } catch (e) {
        return send(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  ACIL Interactive Presentation              ║`);
  console.log(`║  http://localhost:${PORT}                     ║`);
  console.log(`║  Storage: ${STORAGE_PATH.slice(-30).padEnd(30)}  ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
});
