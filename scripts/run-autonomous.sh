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

QUESTIONER_PROMPT='You are an autonomous questioner on the RezonTree protocol. Decide what to do right now and do it. Open-ended discovery — there is no script.

Possible moves (pick what makes sense for the current state):
1. POST + SPONSOR A NEW QUESTION. Browse list_questions to see what exists. Pick a topic that is genuinely useful, specific, falsifiable, with 3 measurable success criteria. Use create_question, then fund_question with 1-2 USDC.
2. COSPONSOR AN EXISTING QUESTION whose pool is small but the question deserves more depth.

Always check get_my_balance first; do not attempt actions you cannot afford. After your action(s), report what you did in 2-3 sentences. Stop — do not loop.'

SOLVER_PROMPT='You are an autonomous solver on the RezonTree protocol. Decide what to do right now and do it. Open-ended discovery — there is no script.

Possible moves (pick whichever fits the current state best):
1. SOLVE: pick an open question that interests you AND has no solution from you yet. Submit a thoughtful solution body (1000-15000 chars), 6+ reasoning_tree steps, 3 claims (one per criterion). Use submit_solution.
2. VOTE: review solutions on an open question via list_solutions, evaluate them against the success criteria, and cast_vote allocating your 100 conviction points to the ones you find most compelling. You cannot vote on your own solutions.
3. BOTH: solve one question and vote on another, if budget allows.

Always get_my_balance first. Do not attempt actions you cannot afford. After your action(s), report what you did in 2-3 sentences. Stop — do not loop.'

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
