#!/usr/bin/env node
'use strict';
/**
 * Discourse Poller — BCN Module
 * Polls Cursor Community Forum for ACIL post engagement and writes
 * delta reports to bilateral_communications/inbox/CURSOR/ on GitHub.
 *
 * Follows the same https-only, no-deps pattern as bilateral-watcher.js.
 *
 * Required env vars (shared with bilateral-watcher):
 *   BCN_GITHUB_TOKEN=<PAT with r/w on imKrisK/META-VOICE-SYSTEM>
 *
 * Optional env vars:
 *   DISCOURSE_POLL_SECONDS  (default: 1800 = 30 min)
 *   DISCOURSE_TOPICS        (comma-sep topic IDs, default: 165981)
 *   DISCOURSE_HOST          (default: forum.cursor.com)
 *
 * Usage:
 *   node scripts/discourse-poller.js              # standalone daemon
 *   require('./scripts/discourse-poller')         # integrated into bilateral-watcher
 */

const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const GITHUB_TOKEN   = process.env.BCN_GITHUB_TOKEN || '';
const POLL_SECONDS   = parseInt(process.env.DISCOURSE_POLL_SECONDS || '1800', 10);
const TOPIC_IDS      = (process.env.DISCOURSE_TOPICS || '165981').split(',').map(s => s.trim());
const DISCOURSE_HOST = process.env.DISCOURSE_HOST || 'forum.cursor.com';

const REPO_OWNER = 'imKrisK';
const REPO_NAME  = 'META-VOICE-SYSTEM';
const BCN_ROOT   = 'bilateral_communications';
const INBOX_PATH = `${BCN_ROOT}/inbox/CURSOR`;
const POLLER_VER = '1.0.0';

// ── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[DISCOURSE-POLLER] ${new Date().toISOString()} — ${msg}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path, method: 'GET', headers: { 'User-Agent': `BCN-DiscoursePoller/${POLLER_VER}`, ...headers } },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          if (res.statusCode === 429) return reject(new Error('Rate limited (429)'));
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function ghReq(method, filePath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com', port: 443,
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`,
        method,
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': `BCN-DiscoursePoller/${POLLER_VER}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
        }
      },
      res => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          if (res.statusCode >= 400) return reject(new Error(`GH ${method} ${filePath} → ${res.statusCode}: ${raw.slice(0, 200)}`));
          resolve(raw ? JSON.parse(raw) : null);
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function ghGet(filePath) { return ghReq('GET', filePath, null); }

async function ghPut(filePath, content, message, sha) {
  const body = { message, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  return ghReq('PUT', filePath, body);
}

// ── Discourse API ─────────────────────────────────────────────────────────────
/**
 * Fetch topic JSON from Discourse.
 * Returns the full topic object including posts_count, like_count, views, tags, etc.
 */
async function fetchTopic(topicId) {
  const data = await httpsGet(DISCOURSE_HOST, `/t/${topicId}.json`);
  return data;
}

/**
 * Extract the engagement snapshot we care about from a raw topic response.
 */
function extractSnapshot(topic) {
  const posts = (topic.post_stream?.posts || []).map(p => ({
    post_number: p.post_number,
    username: p.username,
    created_at: p.created_at,
    like_count: p.like_count || 0,
    // strip HTML tags from cooked content for plain text
    excerpt: (p.cooked || '').replace(/<[^>]+>/g, '').slice(0, 300).trim(),
    reply_to_post_number: p.reply_to_post_number || null,
  }));

  return {
    topic_id: topic.id,
    title: topic.title,
    slug: topic.slug,
    url: `https://${DISCOURSE_HOST}/t/${topic.slug}/${topic.id}`,
    category_id: topic.category_id,
    tags: topic.tags || [],
    created_at: topic.created_at,
    // engagement counters
    views: topic.views || 0,
    posts_count: topic.posts_count || 0,
    reply_count: topic.reply_count || 0,
    like_count: topic.like_count || 0,
    participant_count: (topic.details?.participants || []).length,
    participants: (topic.details?.participants || []).map(p => p.username),
    // last activity
    last_posted_at: topic.last_posted_at,
    bumped_at: topic.bumped_at,
    // replies (excluding OP at post_number 1)
    replies: posts.filter(p => p.post_number > 1),
    // snapshot metadata
    polled_at: new Date().toISOString(),
    poller_version: POLLER_VER,
  };
}

// ── Delta computation ─────────────────────────────────────────────────────────
/**
 * Compare current snapshot against the last saved one.
 * Returns a delta object with only what changed.
 */
function computeDelta(prev, curr) {
  if (!prev) {
    return {
      type: 'FIRST_POLL',
      topic_id: curr.topic_id,
      title: curr.title,
      url: curr.url,
      snapshot: curr,
      delta_at: curr.polled_at,
    };
  }

  const newReplies = curr.replies.filter(
    r => !prev.replies.some(pr => pr.post_number === r.post_number)
  );

  const viewsDelta   = curr.views - (prev.views || 0);
  const likesDelta   = curr.like_count - (prev.like_count || 0);
  const repliesDelta = curr.reply_count - (prev.reply_count || 0);

  const hasChanges = viewsDelta !== 0 || likesDelta !== 0 || repliesDelta !== 0;

  return {
    type: hasChanges ? 'ENGAGEMENT_UPDATE' : 'NO_CHANGE',
    topic_id: curr.topic_id,
    title: curr.title,
    url: curr.url,
    since: prev.polled_at,
    until: curr.polled_at,
    delta: {
      views: viewsDelta,
      likes: likesDelta,
      replies: repliesDelta,
    },
    totals: {
      views: curr.views,
      likes: curr.like_count,
      replies: curr.reply_count,
      participants: curr.participant_count,
    },
    new_replies: newReplies,
    new_participants: curr.participants.filter(u => !(prev.participants || []).includes(u)),
    tags: curr.tags,
    delta_at: curr.polled_at,
  };
}

// ── GitHub state store ────────────────────────────────────────────────────────
async function loadSnapshot(topicId) {
  const path = `${INBOX_PATH}/snapshot_${topicId}.json`;
  const file = await ghGet(path);
  if (!file?.content) return null;
  try {
    return JSON.parse(Buffer.from(file.content, 'base64').toString());
  } catch {
    return null;
  }
}

async function saveSnapshot(topicId, snapshot) {
  const path = `${INBOX_PATH}/snapshot_${topicId}.json`;
  const existing = await ghGet(path);
  const sha = existing?.sha;
  await ghPut(
    path,
    JSON.stringify(snapshot, null, 2),
    `poller: snapshot topic ${topicId} @ ${snapshot.polled_at}`,
    sha
  );
}

async function writeDelta(topicId, delta) {
  if (delta.type === 'NO_CHANGE') {
    log(`Topic ${topicId}: no change (${delta.totals.views} views, ${delta.totals.likes} likes, ${delta.totals.replies} replies)`);
    return;
  }

  const ts = Date.now();
  const path = `${INBOX_PATH}/delta_${topicId}_${ts}.json`;  await ghPut(
    path,
    JSON.stringify(delta, null, 2),
    `poller: delta topic ${topicId} [${delta.type}] @ ${delta.delta_at}`
  );

  // Human-readable engagement summary (overwrites each poll)
  const summaryPath = `${INBOX_PATH}/engagement_summary.md`;
  const existingSummary = await ghGet(summaryPath);
  const newRepliesSection = delta.new_replies.length
    ? delta.new_replies.map(r =>
        `- **@${r.username}** (post #${r.post_number}, ${r.like_count} ❤️):\n  > ${r.excerpt}`
      ).join('\n')
    : '_no new replies_';

  const summaryContent = `# ACIL Cursor Forum — Engagement Summary
**Topic:** [${delta.title}](${delta.url})
**Last polled:** ${delta.delta_at}
**Since:** ${delta.since || 'first poll'}

## Totals
| Metric | Count |
|--------|-------|
| Views | ${delta.totals.views} |
| Likes | ${delta.totals.likes} |
| Replies | ${delta.totals.replies} |
| Participants | ${delta.totals.participants} |

## This Poll Delta
- 👁 Views: +${delta.delta.views}
- ❤️ Likes: +${delta.delta.likes}
- 💬 Replies: +${delta.delta.replies}
${delta.new_participants.length ? `- 🆕 New participants: ${delta.new_participants.join(', ')}` : ''}

## New Replies
${newRepliesSection}

## Tags
${delta.tags.join(', ') || '_none_'}

---
_Generated by discourse-poller v${POLLER_VER}_
`;

  await ghPut(
    summaryPath,
    summaryContent,
    `poller: engagement summary updated @ ${delta.delta_at}`,
    existingSummary?.sha
  );

  log(`Topic ${topicId}: ${delta.type} — +${delta.delta.views} views, +${delta.delta.likes} likes, ${delta.new_replies.length} new replies`);
  if (delta.new_participants.length) log(`  New participants: ${delta.new_participants.join(', ')}`);

  // ── BCN inbox injection: write delta as a BCN message so bilateral-watcher
  //    picks it up in its normal processInbox() cycle and routes to handleMsg().
  //    Only inject when there are new replies (avoids flooding for view-only updates).
  if (delta.new_replies.length > 0) {
    const bcnMsg = {
      ...delta,
      // BCN envelope fields expected by processInbox()
      id: `cursor_delta_${topicId}_${ts}`,
      from: 'DISCOURSE_POLLER',
      to: 'BILATERAL_WATCHER',
      sent_at: delta.delta_at,
    };
    const bcnPath = `${BCN_ROOT}/inbox/CURSOR/BCN_delta_${topicId}_${ts}.json`;
    try {
      await ghPut(bcnPath, JSON.stringify(bcnMsg, null, 2),
        `poller: BCN inbox inject — ${delta.new_replies.length} new reply(ies) topic ${topicId}`);
      log(`BCN message injected → inbox/CURSOR/BCN_delta_${topicId}_${ts}.json`);
    } catch(e) {
      log(`BCN inject failed: ${e.message}`);
    }
  }
}

// ── Main poll cycle ───────────────────────────────────────────────────────────
async function pollTopic(topicId) {
  try {
    log(`Polling topic ${topicId} on ${DISCOURSE_HOST}...`);
    const raw      = await fetchTopic(topicId);
    const current  = extractSnapshot(raw);
    const previous = await loadSnapshot(topicId);
    const delta    = computeDelta(previous, current);

    await writeDelta(topicId, delta);
    await saveSnapshot(topicId, current);
  } catch (e) {
    log(`Error polling topic ${topicId}: ${e.message}`);
  }
}

async function pollAll() {
  for (const id of TOPIC_IDS) {
    await pollTopic(id);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function start() {
  if (!GITHUB_TOKEN) {
    log('ERROR: BCN_GITHUB_TOKEN not set. Exiting.');
    process.exit(1);
  }

  log(`Discourse Poller v${POLLER_VER} — topics: [${TOPIC_IDS.join(', ')}] — interval: ${POLL_SECONDS}s`);
  log(`Writing to: ${REPO_OWNER}/${REPO_NAME}/${INBOX_PATH}`);

  // Immediate first poll
  await pollAll();

  // Scheduled polls
  setInterval(pollAll, POLL_SECONDS * 1000);
}

// Run standalone or export for integration
if (require.main === module) {
  start().catch(e => { console.error(e); process.exit(1); });
} else {
  module.exports = { start, pollAll, pollTopic };
}
