#!/bin/bash
# run-swarm-generalist.sh — 10 free-form agents, each picks own role per state.
#
# Unlike run-swarm-mega25.sh (which locked 2 to questioner + 8 to solver),
# every agent here loads config/agents/generalist.yaml and decides what to
# do based on the live protocol state. Production-like behaviour.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/generalist-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

# Each AGENT_ID maps to a wallet derive index (idx 1..10) and an MCP server
# name. We reuse the existing per-agent MCP configs by symlinking generalist
# behaviour through them — the YAML's ${AGENT_ID} interpolation picks the
# right MCP namespace.
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

echo "=== Generalist swarm — Sonnet 4.6 ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Mode:    free-form — each agent picks role per state"
echo ""

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

PIDS=()
for AGENT in "${AGENTS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$GENERALIST_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) → generalist"
done

echo ""
echo "── ${#PIDS[@]} agents running, PIDs: ${PIDS[*]} ──"
echo ""

wait "${PIDS[@]}" 2>/dev/null || true

echo "=== Generalist swarm complete ==="
echo ""
echo "Per-agent results:"
for AGENT in "${AGENTS[@]}"; do
  if grep -q "Execution complete" "$LOG_DIR/$AGENT.log" 2>/dev/null; then
    grep "Execution complete" "$LOG_DIR/$AGENT.log" | head -1
  else
    grep -E "Execution failed|Reached maximum|error" "$LOG_DIR/$AGENT.log" | head -1 \
      | sed "s/^/  $AGENT: /"
  fi
done
