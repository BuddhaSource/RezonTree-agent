#!/bin/bash
# run-voter-wave.sh — focused vote-only swarm.
#
# Companion to run-swarm-staggered.sh. The generalist swarm tends to
# converge on solving (rational under thin-inventory: a fresh question
# pays you the full bounty if you win, vs. capped voter-share fractions
# for voting on someone else's solution). Once enough solutions exist
# (~3+ per question), voting becomes the marginal action — but the
# generalist budget is already spent.
#
# This launcher reserves a small budget for vote-only work. Each agent
# is told explicitly: "do NOT submit, post, or sponsor — your only job
# is to read the open questions, evaluate the existing solutions, and
# cast_vote on them." Hard-bias prompts cut around the rational-actor
# distraction.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/voters-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

# 3 agents — small enough to clear claude.ai OAuth concurrency
# without staggering. Wallets chosen for healthy USDC balance.
AGENTS=(
  "solver-04"
  "solver-05"
  "solver-06"
)

VOTER_PROMPT='You are a VOTER agent. Your ONLY job is to cast votes on existing solutions.

DO NOT:
- Create or sponsor questions (no create_question, no sponsor_question, no post_question)
- Submit your own solutions (no submit_solution)
- Cosponsor anything

WORKFLOW:
1. cold_start to learn your wallet balance + advisory scaffold.
2. list_questions (status=open) to find questions with solutions.
3. For each question with 2+ solutions:
   - Read the question + its solutions briefly
   - Evaluate which solution(s) best address the success criteria
   - Use the cast_vote composite tool to allocate 100 conviction points
     across 1-5 solutions (concentration is fine; spreading equally is
     also fine; weight toward the strongest reasoning)
   - Never self-vote (skip questions where you authored a solution)
4. Repeat until budget runs low or all open questions have been voted on.

You have ~40 turns / $4 budget. Each vote costs ~$1.10 (chain stake +
fee), so aim for 3-6 votes per session.

Stop conditions:
- Wallet < $1.30 USDC (one vote worth of headroom)
- All open questions have already been voted on by you
- 6+ votes completed

Begin.'

echo "=== Voter wave — Sonnet 4.6 ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Mode:    vote-only, ${#AGENTS[@]} agents staggered 60s"
echo ""

PIDS=()
COUNT=0
for AGENT in "${AGENTS[@]}"; do
  $CLI agent run "gen-$AGENT" $AUTH_FLAG \
    -p "$VOTER_PROMPT" -v \
    > "$LOG_DIR/$AGENT.log" 2>&1 &
  PID=$!
  PIDS+=("$PID")
  echo "  $AGENT (PID $PID) → voter"
  COUNT=$((COUNT + 1))
  if [ $COUNT -lt ${#AGENTS[@]} ]; then
    sleep 60
  fi
done

echo ""
echo "── ${#PIDS[@]} voter agents running ──"
echo ""

wait "${PIDS[@]}" 2>/dev/null || true

echo "=== Voter wave complete ==="
for AGENT in "${AGENTS[@]}"; do
  if grep -q "cost_usd" "$LOG_DIR/$AGENT.log" 2>/dev/null; then
    grep "cost_usd" "$LOG_DIR/$AGENT.log" | head -1 | sed "s/^/  $AGENT: /"
  else
    echo "  $AGENT: (no terminal marker)"
  fi
done
