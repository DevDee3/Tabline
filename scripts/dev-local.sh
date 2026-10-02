#!/usr/bin/env bash
# One-command local stack: anvil -> deploy contracts -> seed two demo plans -> start the keeper API.
# Requires: foundry (forge/anvil/cast) on PATH, node 18+.
#
# Usage:
#   ./scripts/dev-local.sh
# Then in another terminal:
#   cd app && NEXT_PUBLIC_KEEPER_URL=http://localhost:8787 npm run dev
# Open the printed URL (usually http://localhost:5173) -- IS_DEMO turns off automatically once
# NEXT_PUBLIC_KEEPER_URL is set, so the app talks to this real local stack instead of the simulated backend.
# Use one of the demo subscriber addresses below for "My tabs", and the printed merchant key for the
# Merchant dashboard. Opening a real tab from the Shop page still needs an actual MetaMask wallet on a
# chain MetaMask itself supports (Arbitrum Sepolia/One) -- this local anvil chain is for everything else
# (dashboard, My tabs, plan reads), not for the live wallet-permission flow.
#
# This uses the EOA-sequential redeemer with anvil's well-known dev account #0 acting as both merchant and
# keeper, for convenience -- fine for a local demo, not how production should be run (see keeper/README.md's
# note on keeper key isolation).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
echo "==> workdir: $(pwd)"

ANVIL_PORT=8545
RPC_URL="http://127.0.0.1:$ANVIL_PORT"
ANVIL_PID=""
KEEPER_PID=""
cleanup() {
  [ -n "$KEEPER_PID" ] && kill "$KEEPER_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> starting anvil on :$ANVIL_PORT"
anvil --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
for i in $(seq 1 50); do
  curl -s -o /dev/null -X POST "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' && break
  sleep 0.1
done

# Anvil's well-known dev account #0 (test-only, worthless key, printed on every anvil start).
DEV_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEV_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
# Anvil dev accounts #1-3, usable as demo subscriber addresses in the app's "My tabs" page.
SUBSCRIBERS=(0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC 0x90F79bf6EB2c4f870365E785982E1f101E93b906)

echo "==> building contracts"
forge build --silent

echo "==> deploying MockUSDC"
USDC_ADDR=$(cast send --rpc-url "$RPC_URL" --private-key "$DEV_PK" --create \
  "$(forge inspect MockUSDC bytecode)" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])")
echo "    MockUSDC: $USDC_ADDR"

echo "==> deploying Tabline"
TABLINE_ADDR=$(cast send --rpc-url "$RPC_URL" --private-key "$DEV_PK" --create \
  "$(forge inspect Tabline bytecode)" --json | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])")
echo "    Tabline: $TABLINE_ADDR"

echo "==> creating demo plan #1 (fixed: 9 USDC / 30 days -- matches the app's Shop 'Editor' plan)"
cast send --rpc-url "$RPC_URL" --private-key "$DEV_PK" "$TABLINE_ADDR" \
  "createPlan(address,address,address,uint96,uint32,uint8)" \
  "$USDC_ADDR" "$DEV_ADDR" "$DEV_ADDR" 9000000 2592000 0 >/dev/null

echo "==> creating demo plan #2 (metered: 5 USDC cap per settlement -- matches the app's 'Pay as you go' / Agent page)"
cast send --rpc-url "$RPC_URL" --private-key "$DEV_PK" "$TABLINE_ADDR" \
  "createPlan(address,address,address,uint96,uint32,uint8)" \
  "$USDC_ADDR" "$DEV_ADDR" "$DEV_ADDR" 5000000 0 1 >/dev/null

echo "==> minting 1000 test USDC to demo subscriber accounts"
for ACCT in "${SUBSCRIBERS[@]}"; do
  cast send --rpc-url "$RPC_URL" --private-key "$DEV_PK" "$USDC_ADDR" "mint(address,uint256)" "$ACCT" 1000000000 >/dev/null
  echo "    minted to $ACCT"
done

echo "==> installing keeper deps (first run only)"
(cd keeper && [ -d node_modules ] || npm install --silent)
(cd keeper && node scripts/gen-abi.mjs)

echo "==> starting keeper API on :8787"
(cd keeper && CHAIN=foundry RPC_URL="$RPC_URL" TABLINE_ADDRESS="$TABLINE_ADDR" KEEPER_PK="$DEV_PK" \
  CORS_ORIGIN="*" npm start) &
KEEPER_PID=$!
sleep 1

echo ""
echo "Stack is up."
echo "  Keeper API:       http://localhost:8787  (chain: $RPC_URL)"
echo "  Merchant key:     local-dev-key-not-for-prod"
echo "  Tabline contract: $TABLINE_ADDR"
echo "  MockUSDC:         $USDC_ADDR"
echo "  Demo plans:       1 (fixed, 9 USDC / 30 days), 2 (metered, 5 USDC cap)"
echo "  Demo subscribers: ${SUBSCRIBERS[*]}"
echo ""
echo "Next: in another terminal, run"
echo "  cd app && NEXT_PUBLIC_KEEPER_URL=http://localhost:8787 npm run dev"
echo "Ctrl+C to stop this stack."
wait "$KEEPER_PID"
