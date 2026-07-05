/**
 * ACIL — Policy Server
 *
 * Serves .acil.json team policies over HTTP to developer IDE instances.
 * Designed for enterprise deployment — runs as a sidecar on CI, internal
 * tooling server, or Railway/Fly.io.
 *
 * Routes:
 *   GET  /policy/:team          → returns ACILWorkspaceConfig JSON for team
 *   GET  /policy/:team/hmac     → returns policy + HMAC signature (verify at client)
 *   POST /policy/:team          → update policy (requires ADMIN_SECRET header)
 *   GET  /health                → liveness check
 *   GET  /teams                 → list registered team IDs (no sensitive data)
 *
 * Security:
 *   - All mutating routes require `X-ACIL-Admin-Secret` header
 *   - Policy delivery is unsigned GET (low sensitivity — no secrets in policy)
 *   - Signed variant (/hmac) uses HMAC-SHA256 over policy JSON + timestamp
 *
 * Author: imKrisK — Wave 11 Enterprise Feature
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { PolicyStore } from './PolicyStore';
import { signPolicy } from './HMACPolicySigner';

const PORT    = parseInt(process.env.PORT    ?? '4242', 10);
const SECRET  = process.env.ADMIN_SECRET     ?? 'dev-secret-change-in-prod';
const HMAC_KEY = process.env.HMAC_SIGNING_KEY ?? 'acil-hmac-key-change-in-prod';

const store = new PolicyStore();

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function requireAdmin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.headers['x-acil-admin-secret'] !== SECRET) {
    send(res, 401, { error: 'Unauthorized — X-ACIL-Admin-Secret required' });
    return false;
  }
  return true;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = req.method ?? 'GET';
  const parts  = url.pathname.replace(/^\//, '').split('/');

  // GET /health
  if (method === 'GET' && parts[0] === 'health') {
    return send(res, 200, { status: 'ok', teams: store.listTeams().length });
  }

  // GET /teams
  if (method === 'GET' && parts[0] === 'teams') {
    return send(res, 200, { teams: store.listTeams() });
  }

  // GET /policy/:team
  if (method === 'GET' && parts[0] === 'policy' && parts[1] && !parts[2]) {
    const policy = store.get(parts[1]);
    if (!policy) return send(res, 404, { error: `No policy for team: ${parts[1]}` });
    return send(res, 200, policy);
  }

  // GET /policy/:team/hmac  — signed delivery
  if (method === 'GET' && parts[0] === 'policy' && parts[1] && parts[2] === 'hmac') {
    const policy = store.get(parts[1]);
    if (!policy) return send(res, 404, { error: `No policy for team: ${parts[1]}` });
    const signed = signPolicy(policy, HMAC_KEY);
    return send(res, 200, signed);
  }

  // POST /policy/:team  — create or update
  if (method === 'POST' && parts[0] === 'policy' && parts[1]) {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    try {
      const policy = JSON.parse(body);
      if (typeof policy.version !== 'number') {
        return send(res, 400, { error: 'Policy must include numeric version field' });
      }
      store.set(parts[1], policy);
      return send(res, 200, { ok: true, team: parts[1] });
    } catch {
      return send(res, 400, { error: 'Invalid JSON body' });
    }
  }

  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`ACIL Policy Server listening on :${PORT}`);
  console.log(`  Admin secret: ${SECRET === 'dev-secret-change-in-prod' ? '⚠️  DEFAULT (set ADMIN_SECRET env)' : '✓ custom'}`);
  console.log(`  HMAC key:     ${HMAC_KEY === 'acil-hmac-key-change-in-prod' ? '⚠️  DEFAULT (set HMAC_SIGNING_KEY env)' : '✓ custom'}`);
});

export default server;
