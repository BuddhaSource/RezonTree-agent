#!/usr/bin/env bash
# continuous-loop.sh — run broadcast-full.ts indefinitely.
#
# Between iterations, w1 (winning solver) rebalances 1 USDC each
# back to w0 and w2 so the USDC ping-pongs and every wallet has
# enough for the next round. Logs each run to logs/continuous-loop/.
#
# Usage:
#   ./scripts/continuous-loop.sh            # runs until Ctrl-C
#   ITER_DELAY=10 ./scripts/continuous-loop.sh  # 10s between rounds
#
# Env (required, sourced from .env):
#   RT_AGENT_MNEMONIC     (operator mnemonic, wallets 0/1/2 used)
#   RT_ROUTER_ADDRESS     (deployed Router v2)

set -uo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a

export RT_ROUTER_ADDRESS="${RT_ROUTER_ADDRESS:-0x0BB8e006F6DF07ce634AA1d3C852c4f98493Aba6}"
export RT_AGENT_DOMAIN_VERIFYING_CONTRACT="${RT_AGENT_DOMAIN_VERIFYING_CONTRACT:-$RT_ROUTER_ADDRESS}"
export RT_RPC_URL="${RT_RPC_URL:-https://sepolia.base.org}"

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC required}"

ITER_DELAY="${ITER_DELAY:-5}"
LOG_DIR="logs/continuous-loop"
mkdir -p "$LOG_DIR"

RUN_ID=$(date +%Y%m%d-%H%M%S)
SUMMARY="$LOG_DIR/summary-$RUN_ID.log"
echo "run_id=$RUN_ID start=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$SUMMARY"

i=0
ok_count=0
fail_count=0
trap 'echo ""; echo "==="; echo "Ran $i iterations — $ok_count ok, $fail_count failed"; echo "See $SUMMARY for summary, $LOG_DIR/iter-*.log for details"; exit 0' INT TERM

# Per-round economics (multi-leaf settlement + bond recovery):
#   w0   -fundAmount           (full bounty; drains)
#   w1   +fundAmount × 0.9     (pool share; bond refunded)
#   w2    0                    (bond refunded)
#   fee  +fundAmount × 0.1     (platform cut; grows)
#
# Between iterations, w1 rebates `fundAmount` to w0 so the demo
# runs indefinitely. This mirrors the real-world flow where the
# operator's funding cost comes back from the winning solver (in
# our bring-up, both roles are operator wallets). fee_wallet keeps
# growing — that's the platform's margin per round. Disable with
# RT_SKIP_REBATE=true.
REBATE_AMOUNT_WEI=${REBATE_AMOUNT_WEI:-1000000}
W0_ADDR=0x55Bd1aAE425116048590db9dC978f47b4F3702b5
USDC_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e
W1_PK=$(node -e "const {mnemonicToAccount} = require('viem/accounts'); const w = mnemonicToAccount(process.env.RT_AGENT_MNEMONIC, {path: \"m/44'/60'/0'/0/1\"}); console.log('0x' + Buffer.from(w.getHdKey().privateKey).toString('hex'));")

while :; do
  i=$((i + 1))
  iter_log="$LOG_DIR/iter-$RUN_ID-$(printf '%03d' "$i").log"
  start_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo ""
  echo "── iter $i ($start_ts) → $iter_log ──"
  if npx tsx scripts/broadcast-full.ts > "$iter_log" 2>&1; then
    ok_count=$((ok_count + 1))
    # Capture the problem id + final pool amount for the summary line.
    prob_id=$(grep -oE 'problem prb_[a-z0-9]+' "$iter_log" | head -1 | awk '{print $2}')
    pool=$(grep -oE 'poolAmount = [0-9]+' "$iter_log" | head -1 | awk '{print $3}')
    line="iter=$i start=$start_ts status=ok problem=$prob_id pool=$pool"
    echo "  ✓ $line"
    echo "$line" >> "$SUMMARY"

    # Rebate: w1 → w0. Keeps w0 solvent indefinitely; fee_wallet
    # keeps the platform margin. Skip with RT_SKIP_REBATE=true.
    if [ "${RT_SKIP_REBATE:-false}" != "true" ]; then
      cast send "$USDC_ADDR" "transfer(address,uint256)" "$W0_ADDR" "$REBATE_AMOUNT_WEI" --rpc-url "${RT_RPC_URL:-https://sepolia.base.org}" --private-key "$W1_PK" > /dev/null 2>&1 && echo "  ⟲ rebate ${REBATE_AMOUNT_WEI} wei w1 → w0"
    fi
  else
    fail_count=$((fail_count + 1))
    # Capture the failure reason (last [FAIL] line).
    reason=$(grep -oE '\[FAIL\].*' "$iter_log" | head -1 | sed 's/\x1b\[[0-9;]*m//g' | head -c 200 || echo "unknown")
    line="iter=$i start=$start_ts status=FAIL reason=\"$reason\""
    echo "  ✗ $line"
    echo "$line" >> "$SUMMARY"
  fi
  sleep "$ITER_DELAY"
done
