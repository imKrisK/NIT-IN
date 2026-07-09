#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  ACIL — TypeScript 7 Phase B Upgrade Script                            ║
# ║                                                                          ║
# ║  Run when ts-jest ships TypeScript 7 API support (expected Q4 2026      ║
# ║  with TypeScript 7.1 which re-introduces the programmatic API).         ║
# ║                                                                          ║
# ║  Usage: bash scripts/upgrade-ts7.sh                                     ║
# ║  Dry run: bash scripts/upgrade-ts7.sh --dry-run                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=true
  echo "🔍 Dry run — no files will be changed"
fi

run() {
  echo "  → $*"
  if [[ "$DRY" != "true" ]]; then
    eval "$@"
  fi
}

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ACIL TypeScript 7 Phase B Upgrade                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Pre-flight check ──────────────────────────────────────────────────────────
echo "▶ Pre-flight: checking current TypeScript version..."
CURRENT_TS=$(node -e "console.log(require('$ROOT/tools/acil/node_modules/typescript/package.json').version)" 2>/dev/null || echo "unknown")
echo "  Current: $CURRENT_TS"

# ── Step 1: Upgrade all packages to TypeScript 7 ──────────────────────────────
echo ""
echo "▶ Step 1: Upgrade typescript to ^7.0.0 in all packages"
PACKAGES=("acil" "acil-vscode" "acil-mcp" "acil-learn" "acil-policy-server")
for pkg in "${PACKAGES[@]}"; do
  echo "  Upgrading tools/$pkg..."
  run "cd '$ROOT/tools/$pkg' && npm install --save-dev typescript@^7.0.0"
done

# ── Step 2: Install ts-jest TS7 compatibility shim ────────────────────────────
echo ""
echo "▶ Step 2: Install @typescript/typescript6 for ts-jest side-by-side"
echo "  (ts-jest uses TS 6 API while tsc uses TS 7 CLI)"
run "cd '$ROOT/tools/acil' && npm install --save-dev @typescript/typescript6"

# ── Step 3: Update jest config to use typescript6 package for ts-jest ─────────
echo ""
echo "▶ Step 3: Patch jest config to point ts-jest at @typescript/typescript6"
# This updates acil/package.json jest transform to use the TS6 package
run "node '$ROOT/scripts/patch-jest-ts6.js'"

# ── Step 4: Enable --checkers flag in CI ──────────────────────────────────────
echo ""
echo "▶ Step 4: TS 7 parallel type checking is automatic with tsc"
echo "  Add to CI: tsc --checkers \$(nproc) --noEmit"

# ── Step 5: Verify ────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 5: Verify all packages type-check and tests pass"
for pkg in "${PACKAGES[@]}"; do
  echo "  Type-checking tools/$pkg..."
  run "cd '$ROOT/tools/$pkg' && node_modules/.bin/tsc --noEmit"
done

echo "  Running acil tests..."
run "cd '$ROOT/tools/acil' && npm test"

echo "  Building VS Code extension..."
run "cd '$ROOT/tools/acil-vscode' && npm run build && npm run package"

echo ""
echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║  ✅ TypeScript 7 Phase B upgrade complete                           ║"
echo "║     - tsc: TypeScript 7.x (native Go, 8-12x faster)               ║"
echo "║     - ts-jest: @typescript/typescript6 (API compatibility)         ║"
echo "║     - All packages: module: Node16, moduleResolution: Node16       ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

echo "Phase C (full): When TS 7.1 ships with programmatic API:"
echo "  npm uninstall @typescript/typescript6  # in acil"
echo "  Revert ts-jest patch (standard config works natively)"
echo "  Enable: tsc --checkers \$(nproc) in CI for maximum throughput"
