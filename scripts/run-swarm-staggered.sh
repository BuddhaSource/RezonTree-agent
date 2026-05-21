#!/bin/bash
# run-swarm-staggered.sh — launch agents in waves so claude.ai OAuth
# concurrency doesn't strand 7-8 of them at the handshake.
#
# Background: the parallel-10 launcher (run-swarm-generalist.sh)
# routinely strands 7-8 agents at the "Using OAuth authentication"
# line — claude.ai rate-limits concurrent OAuth flows per user. By
# launching in waves of 3 with a 60s gap, each wave's OAuth completes
# before the next wave starts.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/staggered-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

AGENTS=(
  "questioner-01"
  "questioner-02"
  "solver-02"
  "solver-03"
  "solver-04"
  "solver-05"
  "solver-06"
  "solver-07"
  "solver-08"
  "solver-09"
)

GENERALIST_PROMPT='You are now active. Apply the decision flow in your system_prompt:

1. cold_start to learn your wallet balance + advisory scaffold.
2. list_questions (status=open) to survey current state.
3. Decide your highest-marginal action: vote, solve, cosponsor, or create.
4. Execute via the composite tool (one call per action).
5. Loop back to step 2 until budget runs low or marginal value drops.

You have ~80 turns / $8 budget. Aim for 3-5 meaningful actions per session.
Spread across themes T1-T6 when creating. Never self-vote. Never spam dupes.

Stop conditions:
- Wallet < $1 USDC AND no useful votes available.
- 5+ actions completed AND no obvious next move.

Begin.'

echo "=== Staggered swarm — Sonnet 4.6 ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Mode:    waves of 3, 60s apart (OAuth-safe)"
echo ""

WAVE_SIZE=3
WAVE_GAP=60
PIDS=()
COUNT=0
for AGENT in "${AGENTS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$GENERALIST_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) → launched"
  COUNT=$((COUNT + 1))
  if [ $((COUNT % WAVE_SIZE)) -eq 0 ] && [ $COUNT -lt ${#AGENTS[@]} ]; then
    echo "  -- wave full; waiting ${WAVE_GAP}s for OAuth to settle --"
    sleep $WAVE_GAP
  fi
done

echo ""
echo "── ${#PIDS[@]} agents launched in waves ──"
echo ""

wait "${PIDS[@]}" 2>/dev/null || true

echo "=== Staggered swarm complete ==="
for AGENT in "${AGENTS[@]}"; do
  if grep -q "Execution complete\|Done.*cost_usd" "$LOG_DIR/$AGENT.log" 2>/dev/null; then
    grep -E "Execution complete|Done" "$LOG_DIR/$AGENT.log" | head -1 | sed "s/^/  $AGENT: /"
  else
    grep -E "Execution failed|Reached maximum|error" "$LOG_DIR/$AGENT.log" | head -1 \
      | sed "s/^/  $AGENT: /" || echo "  $AGENT: (no terminal marker)"
  fi
done
