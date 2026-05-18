#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# NIT-IN — Railway start script
# Forks BCN bilateral watcher before launching Node hub server
# ──────────────────────────────────────────────────────────────────────────────
set -e

# Fork BCN watcher in background (no Railway Volume needed)
if [ -n "$BCN_GITHUB_TOKEN" ] && [ -n "$DOMAIN_ID" ]; then
  echo "[START] Forking BCN Bilateral Watcher (domain: $DOMAIN_ID)..."
  node bilateral-watcher.js &
  echo "[START] BCN watcher forked — PID $!"
else
  echo "[START] BCN_GITHUB_TOKEN or DOMAIN_ID not set — skipping BCN watcher"
fi

# Start NIT-IN hub server (primary process — Railway monitors this)
echo "[START] Starting NIT-IN hub server..."
exec node hub/server.js
