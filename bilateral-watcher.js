#!/usr/bin/env node
'use strict';
/**
 * BCN Bilateral Watcher v2.0.0 — Node.js
 * NIT-IN platform. No Railway Volume required.
 * Uses GitHub Contents API to read/write bilateral_communications/
 *
 * Required env vars:
 *   DOMAIN_ID=NIT-IN
 *   BCN_GITHUB_TOKEN=<PAT r/w on imKrisK/META-VOICE-SYSTEM>
 * Optional:
 *   BCN_POLL_SECONDS (default 60)
 *   BCN_DOMAIN_URL
 *   BCN_SKIP_PULSE=true
 */
const https = require('https');

const DOMAIN_ID = (process.env.DOMAIN_ID || '').toUpperCase().trim();
const GITHUB_TOKEN = process.env.BCN_GITHUB_TOKEN || '';
const POLL_SECONDS = parseInt(process.env.BCN_POLL_SECONDS || '60', 10);
const DOMAIN_URL = process.env.BCN_DOMAIN_URL || '';
const SKIP_PULSE = process.env.BCN_SKIP_PULSE === 'true';

const REPO_OWNER = 'imKrisK';
const REPO_NAME = 'META-VOICE-SYSTEM';
const BCN_ROOT = 'bilateral_communications';
const BCN_VERSION = '2.0.0';
const ACTIVATION_CODE = 'BC-9999-\u221e-MAY2026-OPEN';
const GH_BASE = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents`;

if (!DOMAIN_ID) { console.warn('[BCN] DOMAIN_ID not set.'); process.exit(0); }
if (!GITHUB_TOKEN) { console.warn('[BCN] BCN_GITHUB_TOKEN not set.'); process.exit(0); }

function log(msg) { console.log(`[BCN:${DOMAIN_ID}] ${new Date().toISOString()} \u2014 ${msg}`); }

function ghReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com', port: 443,
      path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': `BCN-Watcher/${BCN_VERSION} (${DOMAIN_ID})`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode >= 400) return reject(new Error(`${method} ${path} \u2192 ${res.statusCode}: ${raw.slice(0,200)}`));
        resolve(raw ? JSON.parse(raw) : null);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghGet(path) { return ghReq('GET', path, null); }
async function ghPut(path, content, msg, sha) {
  const body = { message: msg, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  return ghReq('PUT', path, body);
}
async function ghDel(path, sha, msg) { return ghReq('DELETE', path, { message: msg, sha }); }

function now() { return new Date().toISOString(); }

async function handleMsg(msg) {
  const type = (msg.type || '').toUpperCase();
  switch (type) {
    case 'BUILD_REQUEST': return { type:'BUILD_RESPONSE', status:'ACKNOWLEDGED', domain:DOMAIN_ID, request_id:msg.id, ts:now() };
    case 'STATUS_QUERY': return { type:'STATUS_RESPONSE', status:'OPERATIONAL', domain:DOMAIN_ID, domain_url:DOMAIN_URL, bcn_version:BCN_VERSION, watcher:'ONLINE', ts:now() };
    case 'BILLING_UPDATE': return { type:'BILLING_ACK', status:'ACKNOWLEDGED', domain:DOMAIN_ID, ts:now() };
    default: return { type:'UNKNOWN_ACK', status:'ACKNOWLEDGED', original_type:type, domain:DOMAIN_ID, ts:now() };
  }
}

async function processInbox() {
  const inbox = `${BCN_ROOT}/inbox/${DOMAIN_ID}`;
  const files = await ghGet(inbox);
  if (!files || !Array.isArray(files)) { log('Inbox empty.'); return; }
  const msgs = files.filter(f => f.name.endsWith('.json') && f.type === 'file');
  log(`Inbox: ${msgs.length} msg(s).`);
  for (const fi of msgs) {
    try {
      const raw = await ghGet(`${inbox}/${fi.name}`);
      if (!raw?.content) continue;
      const content = Buffer.from(raw.content, 'base64').toString();
      const msg = JSON.parse(content);
      const resp = await handleMsg(msg);
      const sender = (msg.from || 'UNKNOWN').toUpperCase();
      const type = (msg.type || '').toUpperCase();
      if (resp) await ghPut(`${BCN_ROOT}/responses/${DOMAIN_ID.toLowerCase()}/FROM_${DOMAIN_ID}_TO_${sender}_${Date.now()}_response.json`, JSON.stringify(resp,null,2), `BCN: ${DOMAIN_ID}\u2192${sender} [${type}]`);
      const archived = { ...msg, _processed_by: DOMAIN_ID, _processed_at: now() };
      await ghPut(`${BCN_ROOT}/processed/${DOMAIN_ID}/${fi.name}`, JSON.stringify(archived,null,2), `BCN: ${DOMAIN_ID} archived ${fi.name}`);
      await ghDel(`${inbox}/${fi.name}`, raw.sha, `BCN: ${DOMAIN_ID} consumed ${fi.name}`);
      log(`\u2713 ${fi.name}`);
    } catch(e) { log(`Failed ${fi.name}: ${e.message}`); }
  }
}

async function emitPulse() {
  if (SKIP_PULSE) return;
  const ts = Date.now();
  const pulse = { type:'PULSE', from:DOMAIN_ID, domain_url:DOMAIN_URL, bcn_version:BCN_VERSION, watcher_status:'ONLINE', poll_interval_seconds:POLL_SECONDS, activation_code:ACTIVATION_CODE, ts:now(), epoch:ts };
  try { await ghPut(`${BCN_ROOT}/transmissions/PULSE_${DOMAIN_ID}_${ts}.json`, JSON.stringify(pulse,null,2), `BCN: PULSE from ${DOMAIN_ID}`); log('PULSE emitted.'); }
  catch(e) { log(`PULSE error: ${e.message}`); }
}

// ── Discourse Poller Integration ────────────────────────────────────────────
const DISCOURSE_ENABLED = process.env.DISCOURSE_POLL !== 'false';
let discoursePoller = null;
try { discoursePoller = require('./scripts/discourse-poller'); } catch(e) { /* optional module */ }

async function run() {
  log(`BCN Watcher v${BCN_VERSION} — ${DOMAIN_ID}`);
  try { await processInbox(); } catch(e) { log(`Init scan: ${e.message}`); }
  try { await emitPulse(); } catch(e) { log(`Init PULSE: ${e.message}`); }

  // Start Discourse poller alongside the inbox watcher
  if (DISCOURSE_ENABLED && discoursePoller) {
    log('Starting Discourse poller...');
    discoursePoller.pollAll().catch(e => log(`Discourse init: ${e.message}`));
  }

  setInterval(async () => {
    try { await processInbox(); } catch(e) { log(`Poll: ${e.message}`); }
  }, POLL_SECONDS * 1000);
}

run().catch(e => { console.error(e); process.exit(1); });
