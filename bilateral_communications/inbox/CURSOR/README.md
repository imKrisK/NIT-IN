# CURSOR Inbox — Discourse Poller Output

This folder receives output from `scripts/discourse-poller.js`.

## Files written here by the poller

| File | Description |
|------|-------------|
| `snapshot_165981.json` | Latest full engagement snapshot (overwritten each poll) |
| `delta_165981_<ts>.json` | Per-poll delta — only written when something changed |
| `engagement_summary.md` | Human-readable summary — latest state (overwritten each poll) |

## Topic being monitored

- **Topic ID:** 165981
- **Title:** I got hit with a $111 AI bill in one day — so I built the thing that should've existed
- **URL:** https://forum.cursor.com/t/i-got-hit-with-a-111-ai-bill-in-one-day-so-i-built-the-thing-that-shouldve-existed/165981
- **Posted:** July 16, 2026 (first AI-assisted social post)

## To add more topics

Set env var: `DISCOURSE_TOPICS=165981,<other_id>`

## BCN Protocol note

`delta_*.json` files in this folder act as BCN messages — the bilateral-watcher
will process them at next inbox scan cycle and can trigger BUILD_REQUESTs
(e.g. "reply to this comment") if the delta contains `new_replies`.
