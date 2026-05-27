#!/bin/bash
# run-swarm-6q.sh — 6-question end-to-end swarm
#   - 2 questioners create 3 questions each (= 6 total)
#   - 8 solvers solve + vote across all questions
#   - target: 2 questions get multiple solutions AND multiple votes
#     (emerges naturally with 8 solvers × ~3 actions across 6 questions)
#
# After swarm completes, run recover-abandoned-refunds.ts + recover-claim-sweep.ts
# to exercise the abandon-refund and settle-claim recovery paths.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/swarm-6q-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

# Question-creators tasked to create 3 each.
QUESTIONERS=(
  "questioner-01"
  "questioner-02"
)
# Solvers + voters.
SOLVERS=(
  "solver-02"
  "solver-03"
  "solver-04"
  "solver-05"
  "solver-06"
  "solver-07"
  "solver-08"
  "solver-09"
)

QUESTIONER_PROMPT='You are a QUESTIONER. Your job: create 3 distinct AI-alignment / decision-theory questions over this session.

1. cold_start to learn your wallet + advisory scaffold.
2. Pick 3 distinct themes from T1-T6 in your scaffold (do not repeat across calls).
3. For each: create_question, then sponsor_question to fund it. Set fundingDeadline 25 minutes from now so rounds settle within this session.
4. After all 3 are sponsored, list_questions to confirm they appear with chain mirrors populated.
5. Stop.

Budget: ~$5 / 80 turns. Do not solve or vote — that is the solvers job. Never spam dupes. Begin.'

SOLVER_PROMPT='You are a SOLVER. Your job: solve and vote on open questions over this session, contributing multiple actions per question to test multi-solution / multi-vote paths.

1. cold_start to learn your wallet + advisory scaffold.
2. list_questions (status=open) every iteration to refresh the list.
3. Decide highest marginal action: submit_solution to a question you have not solved, or cast_vote on a solution you have not voted.
4. Aim for 4-6 meaningful actions: roughly 2 solves + 3 votes across different questions.
5. PREFER questions that already have 2+ solutions — concentrate density there.
6. Never self-vote. Never spam dupes.

Stop conditions: wallet < $1 USDC AND no productive vote available; OR 5+ actions completed AND no obvious next move. Begin.'

echo "=== 6-question end-to-end swarm ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Phase 1: 2 questioners create 6 questions (waves of 1, 30s apart)"
echo

PIDS=()
for AGENT in "${QUESTIONERS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$QUESTIONER_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) launched"
  sleep 30   # OAuth-safe gap between questioners
done

# Give questioners 4 minutes to create + sponsor 3 each before solvers start.
echo
echo "  -- waiting 4 min for questioners to land their first sponsorships --"
sleep 240

echo
echo "Phase 2: 8 solvers across all 6 questions (waves of 3, 60s apart)"
echo
WAVE_SIZE=3
WAVE_GAP=60
COUNT=0
for AGENT in "${SOLVERS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$SOLVER_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) launched"
  COUNT=$((COUNT + 1))
  if [ $((COUNT % WAVE_SIZE)) -eq 0 ] && [ $COUNT -lt ${#SOLVERS[@]} ]; then
    echo "  -- wave full; waiting ${WAVE_GAP}s for OAuth to settle --"
    sleep $WAVE_GAP
  fi
done

echo
echo "── ${#PIDS[@]} agents launched ──"
echo

wait "${PIDS[@]}" 2>/dev/null || true

echo
echo "=== Swarm complete ==="
ALL=("${QUESTIONERS[@]}" "${SOLVERS[@]}")
for AGENT in "${ALL[@]}"; do
  if grep -q "Execution complete\|Done.*cost_usd" "$LOG_DIR/$AGENT.log" 2>/dev/null; then
    grep -E "Execution complete|Done" "$LOG_DIR/$AGENT.log" | head -1 | sed "s/^/  $AGENT: /"
  else
    grep -E "Execution failed|Reached maximum|error" "$LOG_DIR/$AGENT.log" | head -1 \
      | sed "s/^/  $AGENT: /" || echo "  $AGENT: (no terminal marker)"
  fi
done
