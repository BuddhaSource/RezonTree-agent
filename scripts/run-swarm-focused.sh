#!/bin/bash
# run-swarm-focused.sh — 6-solver focused wave targeting 4 specific open questions
# Concentrates density so 2 questions get multi-solution / multi-vote.
#
# Launches in waves of 2 with 90s gap (OAuth-safe, but more conservative).

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/swarm-focused-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

AGENTS=(
  "solver-02"
  "solver-03"
  "solver-04"
  "solver-05"
  "solver-06"
  "solver-09"
)

FOCUSED_PROMPT='You are a SOLVER+VOTER. Your wallet has ~2-3 USDC. There are 4 open questions to act on:
  Q4: qst_d87x53ds8vtxme49nb60 — HTML conventions for Claude agent outputs (multi-solution target)
  Q5: qst_d87x5aamsby2m58h8s7g — Account abstraction for AI agent settlement latency (multi-solution target)
  Q6: qst_d87x61n6hq05qrbz0k5g — generic open question
  Q7: qst_d87x66hpjx3fe90z7ts0 — generic open question

1. cold_start to confirm wallet + balance.
2. Read each question via `read_question` (the local MCP tool) or via direct API GET /v1/questions/:id to learn its success_criteria.
3. Submit AT LEAST 2 solutions across Q4+Q5 (concentrate density there). Solutions must address the success_criteria with substantive claims + falsifiable_by reasoning.
4. Submit AT LEAST 3 votes across Q4+Q5+Q6+Q7. Distribute conviction_points (sum ≤ 100) across solutions you back.
5. Stop when wallet < $0.50 OR no votable solutions available OR 5 actions completed.

NEVER self-vote. NEVER spam dupe solutions. The MCP `wait_for_questions` tool may have issues; prefer direct read_question / list_questions tools or `apiCall` to GET /v1/questions.

Begin.'

echo "=== Focused 6-solver wave ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"

WAVE_SIZE=2
WAVE_GAP=90
PIDS=()
COUNT=0
for AGENT in "${AGENTS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$FOCUSED_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) launched"
  COUNT=$((COUNT + 1))
  if [ $((COUNT % WAVE_SIZE)) -eq 0 ] && [ $COUNT -lt ${#AGENTS[@]} ]; then
    echo "  -- wave full; waiting ${WAVE_GAP}s --"
    sleep $WAVE_GAP
  fi
done

echo
echo "── ${#PIDS[@]} agents launched ──"
wait "${PIDS[@]}" 2>/dev/null || true
echo "=== Focused wave complete ==="
