#!/bin/bash
# Run a full RezonTree round: 2 questioners ask, 4 solvers answer + vote
# Usage: ./scripts/run-round.sh [topic] [bounty]
#
# Refitted cartridge loop 0066 for the wallet-atomic flow:
#   - Scripts no longer pre-register agents via psql; they
#     rely on `pnpm testnet:bootstrap` having been run first
#     (idempotent — safe to re-run any time).
#   - Auth goes through the loop 0063 MCP server refactor
#     which reads RT_AGENT_MNEMONIC + RT_AGENT_INDEX per agent.
#   - CLI path uses `pnpm start` rather than raw `node
#     dist/cli/index.js` so a forgotten `pnpm build` fails
#     with a clear message, not a cryptic ENOENT.

set -euo pipefail

TOPIC="${1:-What is the most effective strategy for reducing technical debt in a fast-growing startup?}"
BOUNTY="${2:-15}"
# Voting-deadline override in minutes (default 2880 = 48 hours).
# Pass small values (e.g. 40) for fast settle/claim simulation.
DEADLINE_MIN="${3:-2880}"
if [ "$DEADLINE_MIN" -lt 60 ]; then
  DEADLINE_PHRASE="${DEADLINE_MIN} minutes"
else
  DEADLINE_PHRASE="$((DEADLINE_MIN / 60)) hours"
fi

# ── Preflight: env + auth readiness ─────────────────────────
: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Run 'pnpm testnet:bootstrap' first — see docs/testnet-migration-plan.md}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"

# Auth method for the agentkit subprocesses. Defaults to oauth (Claude.ai
# session) so the round runs without ANTHROPIC_API_KEY. Override via env:
#   AGENT_AUTH=oauth          → Claude.ai session (default)
#   AGENT_AUTH=oauth:console  → Anthropic Console OAuth billing
#   AGENT_AUTH=api_key        → ANTHROPIC_API_KEY / OPENROUTER_API_KEY
#   AGENT_AUTH=bedrock        → AWS Bedrock (uses AWS credentials)
#   AGENT_AUTH=vertex         → Google Vertex AI
#   AGENT_AUTH=               → empty: use models.yaml `auth:` block as-is
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
if [ -n "$AGENT_AUTH" ]; then
  AUTH_FLAG="--auth $AGENT_AUTH"
fi

if ! pnpm --silent exec tsc --noEmit >/dev/null 2>&1; then
  echo "ERROR: TypeScript build broken. Run 'pnpm build' and fix errors before running a round."
  exit 2
fi

CLI="pnpm --silent start"
LOG_DIR="logs/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

echo "=== RezonTree Round: $TOPIC ==="
echo "Bounty: \$$BOUNTY per question"
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo ""

# Phase 1: Questioners create problems (run in parallel)
echo "── Phase 1: Asking Questions ──"
$CLI agent run questioner-01 $AUTH_FLAG \
  -p "Create a problem about: $TOPIC. Set a bounty of $BOUNTY credits. Set the voting deadline to $DEADLINE_PHRASE from now." \
  -v > "$LOG_DIR/questioner-01.log" 2>&1 &
PID_Q1=$!

$CLI agent run questioner-02 $AUTH_FLAG \
  -p "Create a different problem related to: $TOPIC. Set a bounty of $BOUNTY credits. Set the voting deadline to $DEADLINE_PHRASE from now. Make sure your question takes a unique angle." \
  -v > "$LOG_DIR/questioner-02.log" 2>&1 &
PID_Q2=$!

echo "  Questioner 01 running (PID $PID_Q1)..."
echo "  Questioner 02 running (PID $PID_Q2)..."
wait $PID_Q1 $PID_Q2
echo "  Questions created! ✓"
echo ""

# Phase 2: Solvers submit solutions (run in parallel)
echo "── Phase 2: Solving ──"
for i in 02 03 04 05; do
  $CLI agent run solver-$i $AUTH_FLAG \
    -p "List open problems on the RezonTree protocol with list_problems. Find problems about: $TOPIC. Choose one to solve, read it carefully, then submit a thorough solution. Validate first with validate_solution, then submit with submit_solution." \
    -v > "$LOG_DIR/solver-${i}-answer.log" 2>&1 &
  eval "PID_S${i}=$!"
  echo "  Solver $i answering (PID $(eval echo \$PID_S${i}))..."
done

wait $PID_S02 $PID_S03 $PID_S04 $PID_S05
echo "  Solutions submitted! ✓"
echo ""

# Phase 3: Solvers vote on solutions (run in parallel)
echo "── Phase 3: Voting ──"
for i in 02 03 04 05; do
  $CLI agent run solver-$i $AUTH_FLAG \
    -p "List open problems on the RezonTree protocol with list_problems. Find problems about: $TOPIC. For each problem, list_solutions and evaluate them. Vote on the best solutions using cast_vote. You have 100 conviction points per problem. Be thorough in your evaluation." \
    -v > "$LOG_DIR/solver-${i}-vote.log" 2>&1 &
  eval "PID_V${i}=$!"
  echo "  Solver $i voting (PID $(eval echo \$PID_V${i}))..."
done

wait $PID_V02 $PID_V03 $PID_V04 $PID_V05
echo "  Votes cast! ✓"
echo ""

echo "=== Round Complete ==="
echo "Logs saved to: $LOG_DIR"
echo ""
echo "Summary:"
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  status=$(grep -c "success.*true\|Done" "$f" 2>/dev/null || echo "0")
  cost=$(grep -o 'cost_usd":[0-9.]*' "$f" 2>/dev/null | head -1 | cut -d: -f2 || echo "?")
  echo "  $name: $([ "$status" -gt 0 ] && echo "✓" || echo "✗") (cost: \$${cost})"
done
