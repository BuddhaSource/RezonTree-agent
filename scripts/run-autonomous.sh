#!/bin/bash
# Run all 10 agents in true parallel — no phases, no role split.
#
# Every agent reads the live protocol state and decides independently:
#   - Has USDC + no open questions → create + sponsor a question
#   - Has USDC + open draft/question → cosponsor it
#   - Has USDC + open question with solutions → solve (stake) or vote
#   - Has 0 USDC → report and stop
#
# Agents race freely. The protocol handles the cold-start (one agent sponsors,
# others find it via list_questions). No coordinator needed.
#
# Usage: ./scripts/run-autonomous.sh
#
# Env:
#   AGENT_AUTH                — auth method (default: oauth)
#   RT_AGENT_BACKEND_URL      — backend URL (default: http://localhost:8080)
#   RT_AGENT_MNEMONIC         — required, HD-derives all 10 wallets

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Run 'pnpm testnet:bootstrap' first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/autonomous-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

AUTONOMOUS_PROMPT='You are an autonomous agent on the RezonTree protocol. Work until you have exhausted every action available to you given your balance.

## Your loop — repeat until you cannot act further

### Step 1: Check your wallet
Call get_usdc_balance. If balance < 0.05 USDC: stop, you have nothing left to do.

### Step 2: Read protocol state
Call list_questions with sort=created_at. Note every question by status:
  - status=open: you can SOLVE and/or VOTE here
  - status=draft: you can COSPONSOR to push it open
  Remember which questions you have already acted on this session.

### Step 3: Act — in this priority order

**PRIORITY 1 — VOTE** (cheapest, most impactful for the protocol)
If any open question has solutions AND you have NOT yet voted on it AND you did not author all of its solutions:
  - Call list_solutions to read every solution.
  - Call get_vote_preflight to confirm your stake cost.
  - Allocate all 100 conviction points across solutions you find credible.
  - Call cast_vote. You CANNOT vote on solutions you authored.

**PRIORITY 2 — SOLVE** (if open question exists + balance >= stake_required)
If you have NOT already submitted a solution to this question:
  - Call get_commit_preflight to learn the exact stake.
  - Write a thorough, novel solution (>= 800 chars, 6+ reasoning_tree steps, 3 falsifiable claims).
  - Call submit_solution with your full answer.

**PRIORITY 3 — COSPONSOR a draft** (if draft exists + balance >= 1 USDC)
  - Call fund_question on the draft with as much as you want to contribute.
  - The L2 bounty floor is 1 USDC — you need at least 1 USDC to activate economics.

**PRIORITY 4 — SPONSOR a new question** (only if NO open questions + balance >= 1 USDC)
  - Call list_questions first to avoid topic duplicates.
  - Call create_question on a specific, measurable research topic.
  - Call fund_question immediately with sponsorship_floor=1.0 and at least 1 USDC.
  - Then loop back to Step 2 — other agents may now act on your question.

### Step 4: Loop back to Step 2
After each action, go back to Step 2 and re-read protocol state. New solutions and questions from other agents may have appeared. Keep acting until:
  - You have voted on every question where you can vote
  - You have solved every open question (or been blocked by stake requirement)
  - Your balance is < 0.05 USDC
  - There is truly nothing left to do

## Final report
When you stop, summarize everything you did: which questions, solutions, votes, and how much USDC total you spent.'

echo "=== RezonTree Autonomous Swarm ==="
echo "Backend: $RT_AGENT_BACKEND_URL  Auth: $AGENT_AUTH"
echo "Logs:    $LOG_DIR"
echo ""

ALL_PIDS=()
ALL_NAMES=()

for name in questioner-01 questioner-02 solver-02 solver-03 solver-04 solver-05 solver-06 solver-07 solver-08 solver-09; do
  logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$AUTONOMOUS_PROMPT" -v > "$logfile" 2>&1 &
  pid=$!
  ALL_PIDS+=("$pid")
  ALL_NAMES+=("$name")
  echo "  $name (PID $pid)"
done

echo ""
echo "── All 10 agents running in parallel ──"
echo "── Waiting for all to complete ──"
echo ""

wait "${ALL_PIDS[@]}"

echo "=== Swarm Complete ==="
echo "Per-agent summary:"
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  # Extract the last Done line with cost/turns/duration
  summary=$(grep -E '"cost_usd"' "$f" | tail -1)
  if [ -n "$summary" ]; then
    echo "  $name: $summary"
  else
    # Fall back to last meaningful log line
    last=$(grep -v '^$' "$f" | tail -1)
    echo "  $name: $last"
  fi
done
echo ""
echo "Logs: $LOG_DIR"
