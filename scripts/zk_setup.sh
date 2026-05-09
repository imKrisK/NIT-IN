#!/usr/bin/env bash
# Phase 28 — ZK Trusted Setup for compliance_batch.circom
# Run ONCE on your development machine (not on the Arduino).
# Outputs proving/verification keys to circuits/build/.
# Copy circuits/build/ to the Arduino Uno Q Linux core before running zk_prover.js.
#
# Prerequisites:
#   • Rust + cargo  (for circom compiler)
#   • Node.js ≥ 18  (for snarkjs)
#   • npm packages: snarkjs circomlib  (installed by this script if absent)
#   • openssl       (for entropy)
#
# Usage: bash scripts/zk_setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_DIR="$ROOT_DIR/circuits"
BUILD_DIR="$CIRCUITS_DIR/build"
PTAU_DIR="$BUILD_DIR/ptau"
CIRCUIT="$CIRCUITS_DIR/compliance_batch.circom"

echo "══════════════════════════════════════════════"
echo " Phase 28 ZK Setup — compliance_batch.circom"
echo "══════════════════════════════════════════════"
echo "ROOT:    $ROOT_DIR"
echo "BUILD:   $BUILD_DIR"

mkdir -p "$BUILD_DIR" "$PTAU_DIR"

# ── 1. Install circom compiler ─────────────────────────────────────
if ! command -v circom &>/dev/null; then
  echo ""
  echo "[1/6] Installing circom via cargo..."
  cargo install circom
else
  echo "[1/6] circom $(circom --version 2>/dev/null | head -1) — already installed"
fi

# ── 2. Install node deps (circomlib + snarkjs) ─────────────────────
echo ""
echo "[2/6] Checking node dependencies..."
cd "$ROOT_DIR"
if [ ! -d "node_modules/circomlib" ]; then
  echo "      Installing circomlib..."
  npm install circomlib --save-dev
fi
if [ ! -d "node_modules/snarkjs" ]; then
  echo "      Installing snarkjs..."
  npm install snarkjs --save-dev
fi
echo "      OK"

# ── 3. Compile circuit → r1cs + wasm ──────────────────────────────
echo ""
echo "[3/6] Compiling compliance_batch.circom..."
circom "$CIRCUIT" \
  --r1cs --wasm --sym \
  --output "$BUILD_DIR" \
  --prime bn128

echo "      r1cs:  $BUILD_DIR/compliance_batch.r1cs"
echo "      wasm:  $BUILD_DIR/compliance_batch_js/compliance_batch.wasm"

# ── 4. Powers of Tau (pot14 = 2^14 = 16 384 constraints) ──────────
# 64 events × ~5 constraints/event = ~320 constraints — pot14 is generous.
echo ""
if [ -f "$PTAU_DIR/pot14_final.ptau" ]; then
  echo "[4/6] Powers of Tau already generated — skipping"
else
  echo "[4/6] Generating Powers of Tau (pot14, bn128)..."
  ENTROPY1="$(openssl rand -hex 32)"
  ENTROPY2="$(openssl rand -hex 32)"

  npx snarkjs powersoftau new bn128 14 \
    "$PTAU_DIR/pot14_0000.ptau" -v

  npx snarkjs powersoftau contribute \
    "$PTAU_DIR/pot14_0000.ptau" \
    "$PTAU_DIR/pot14_0001.ptau" \
    --name="NIT-IN Phase28 init" -v \
    -e="$ENTROPY1"

  npx snarkjs powersoftau prepare phase2 \
    "$PTAU_DIR/pot14_0001.ptau" \
    "$PTAU_DIR/pot14_final.ptau" -v

  # Remove intermediate — only final needed
  rm -f "$PTAU_DIR/pot14_0000.ptau" "$PTAU_DIR/pot14_0001.ptau"
  echo "      pot14_final.ptau written"
fi

# ── 5. Groth16 circuit-specific setup ─────────────────────────────
echo ""
echo "[5/6] Groth16 phase2 setup (circuit-specific proving key)..."
ENTROPY3="$(openssl rand -hex 32)"

npx snarkjs groth16 setup \
  "$BUILD_DIR/compliance_batch.r1cs" \
  "$PTAU_DIR/pot14_final.ptau" \
  "$BUILD_DIR/compliance_batch_0000.zkey"

npx snarkjs zkey contribute \
  "$BUILD_DIR/compliance_batch_0000.zkey" \
  "$BUILD_DIR/compliance_batch_final.zkey" \
  --name="NIT-IN Phase28 contribution" \
  -e="$ENTROPY3"

# Remove intermediate zkey
rm -f "$BUILD_DIR/compliance_batch_0000.zkey"
echo "      compliance_batch_final.zkey written"

# ── 6. Export verification key ────────────────────────────────────
echo ""
echo "[6/6] Exporting verification key..."
npx snarkjs zkey export verificationkey \
  "$BUILD_DIR/compliance_batch_final.zkey" \
  "$BUILD_DIR/verification_key.json"

echo "      verification_key.json written"

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo " Setup complete. Artifacts:"
echo "   $BUILD_DIR/compliance_batch.r1cs"
echo "   $BUILD_DIR/compliance_batch_js/compliance_batch.wasm"
echo "   $BUILD_DIR/compliance_batch_final.zkey   ← KEEP SECRET (proving key)"
echo "   $BUILD_DIR/verification_key.json          ← safe to publish"
echo ""
echo " Next steps:"
echo "   1. Copy circuits/build/ to Arduino Uno Q Linux core"
echo "      (rsync -av circuits/build/ arduino:/opt/nit-in/zk/build/)"
echo "   2. Deploy hub changes: git push → Railway redeploy"
echo "   3. Start the prover on the Arduino:"
echo "      node arduino/zk_prover.js --nit-in-url https://nit-in-production.up.railway.app"
echo "══════════════════════════════════════════════"
