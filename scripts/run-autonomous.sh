#!/bin/bash
# Run all 10 agents in parallel, each free-roaming.
#
# Unlike run-round.sh (rigid 3-phase: ask → solve → vote), this script
# gives each agent an open prompt: "look at protocol state, decide what's
# useful for your role, do it." Agents discover new questions and pick
# their own answers without a coordinator.
#
# Usage: ./scripts/run-autonomous.sh
#
# Env:
#   AGENT_AUTH                — auth method (default: oauth, see run-round.sh)
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

QUESTIONER_PROMPT='You are an autonomous questioner on the RezonTree protocol. Decide what to do right now and do it.

Step 1: call get_usdc_balance to see your spendable USDC (on-chain, NOT protocol ledger).
Step 2: if balance >= 0.1 USDC, proceed. Otherwise stop with "Insufficient balance: X USDC".
Step 3: pick a move —
  A. CREATE + SPONSOR a new question. Use list_questions to avoid duplicates. Pick a topic that is specific, falsifiable, with 3 measurable success criteria. Call create_question, then fund_question. Fund with your full available balance; set sponsorship_floor to 0.1 (safe for any wallet >= 0.1 USDC).
  B. COSPONSOR an open question whose pool is small. Call fund_question with a cosponsor amount.

After your action, report what you did in 2-3 sentences. Stop — do not loop.'

SOLVER_PROMPT='You are an autonomous solver on the RezonTree protocol. Decide what to do right now and do it.

Step 1: call get_usdc_balance to see your spendable USDC (on-chain balance, not protocol ledger).
Step 2: call list_questions to see open questions.
Step 3: pick a move —
  1. SOLVE: find an open question with no solution from you yet. Submit a thorough solution (≥1000 chars), 6+ reasoning_tree steps, 3 claims. Use submit_solution.
  2. VOTE: review solutions on an open question via list_solutions, then cast_vote (100 conviction points per question). You cannot vote on your own solutions.
  3. BOTH: solve one, vote on another if budget allows.

If balance < 0.1 USDC, you can still submit solutions (stake is dynamic — small pool = tiny stake requirement). After your action(s), report what you did in 2-3 sentences. Stop — do not loop.'

echo "=== RezonTree Autonomous Swarm ==="
echo "Backend: $RT_AGENT_BACKEND_URL  Auth: $AGENT_AUTH"
echo "Logs:    $LOG_DIR"
echo ""

# Spawn all 10 agents in parallel.
PIDS=()
spawn_agent() {
  local name="$1"
  local prompt="$2"
  local logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$prompt" -v > "$logfile" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  echo "  $name (PID $pid)"
}

echo "── Spawning 10 agents ──"
spawn_agent questioner-01 "$QUESTIONER_PROMPT"
spawn_agent questioner-02 "$QUESTIONER_PROMPT"
for i in 02 03 04 05 06 07 08 09; do
  spawn_agent "solver-$i" "$SOLVER_PROMPT"
done
echo ""
echo "── Waiting for all agents to complete ──"
wait "${PIDS[@]}"

echo ""
echo "=== Swarm Complete ==="
echo "Per-agent summary:"
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  status_line=$(grep -E "Execution complete|cost_usd" "$f" | tail -1)
  echo "  $name: $status_line"
done
echo ""
echo "Logs: $LOG_DIR"
