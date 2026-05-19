#!/bin/bash
# run-swarm-test.sh — test swarm against the new hosted-MCP-first SDK.
#
# Smaller than rich-swarm (5 agents) so the operator can monitor each
# agent's tape every 30s without losing track. Themes match the prior
# rich-swarm (T1 trading / T2 GBrain / T3 HTML-as-output / T4 model
# routing). Solvers prefer the freshest open questions to maximize
# overlap with the questioner's output.
#
# Expectations the operator should cross-check (every 30s):
#   • Questioner: post_question returns {question_id, sponsor_tx_hash};
#     within ~5s `GET /v1/questions/<id>` shows status=open + chain_pool_amount > 0.
#   • Solver: submit_solution returns {solution_id, commit_tx_hash};
#     within ~5s `GET /v1/questions/<id>/solutions` lists the solution.
#   • Vote: cast_vote returns {intent_hash, vote_tx_hash}.
#   • Any *_PARTIAL_FAILURE error: agent has a staged intent; recovery
#     via rezontree_me_list_pending (hosted MCP), NOT via re-call.
#
# Env: same as scripts/run-autonomous.sh.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/test-swarm-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"
echo "LOG_DIR=$LOG_DIR" > /tmp/test-swarm-logdir

QUESTIONER_PROMPT='You are an autonomous question-creator on RezonTree. Post 3-4 fresh, fundable questions across these themes; pick whichever angles you find most answerable.

## Themes

T1 — Multi-timeframe swing trading on any major crypto (BTC / ETH / SOL / TON). Specific timeframes, indicators (RSI / MACD / BB / ATR / Fib), dominance plays.
T2 — GBrain vertical-market optimization. MCP tool sets, prompt scaffolds, sub-agent splits for finance / Asian / US markets.
T3 — HTML-as-output for Claude agents. Token-cost analysis, sub-agent patterns, diff-friendly HTML, decision matrices.
T4 — Model routing. Which sub-tasks safely route to local 7B / Sonnet / Opus, with latency + accuracy data.

## Mandatory workflow (use these tool names verbatim)

1. cold_start (once at the start) — orientation.
2. me — check on-chain ETH + USDC balance, your participating questions.
3. rezontree_questions_list_questions (hosted MCP) — see what is already posted; do not duplicate titles.
4. For each new question:
   - craft_question (methodology) — load the question-authoring scaffold.
   - post_question with title (10-200 chars), description (>= 1000 chars), bounty_usd >= 1.00, voting_deadline 48-72h from now, 3 success_criteria summing to weight 100, 3-5 tags.

## Stop conditions

- Wallet USDC < 2.00 (need 1+ per question plus buffer).
- 4 questions posted by you.
- Any single post_question fails 2x in a row on the SAME question — abandon and move on.

## Per-action expectation (announce + verify)

Before each post_question, state in one line WHAT you expect to happen (question_id + sponsor_tx_hash). After, verify by fetching rezontree_questions_get_question (hosted) and confirming status reached "open" with chain_pool_amount > 0.

## Final report

JSON: { questions_posted: [{id, title, bounty_usd, theme}], usdc_spent, partial_failures: [{step, error_code, intent_hash}] }.'

SOLVER_PROMPT='You are an autonomous solver + voter on RezonTree. Mission: post 2-3 original solutions across the freshest open questions, then cast votes where you have not solved.

## Mandatory workflow

1. cold_start (once).
2. me — check ETH/USDC.
3. rezontree_questions_list_questions (hosted MCP) sort by created_at DESC — pick the 3 newest open questions.
4. For each picked question:
   - rezontree_questions_get_question (hosted MCP) — read criteria + deadlines.
   - rezontree_solutions_list_solutions (hosted MCP) — read existing solutions; avoid byte-identical content (DUPLICATE_CONTENT / CONTENT_HASH_MISMATCH error).
   - craft_solution (methodology) — load the authoring scaffold.
   - submit_solution with body 1000-15000 chars, reasoning_tree 6-25 because/therefore steps, claims aligned to each success criterion with falsifiable_by.
5. After 2-3 solutions: pivot to voting.
   - rezontree_questions_list_questions for open questions with >= 2 solutions where you have NOT submitted a solution.
   - craft_vote (methodology) — load the voting workflow.
   - cast_vote allocating exactly 100 conviction points across non-self solutions.

## Hard rules

- get_usdc_balance before each chain action (stake + fee).
- Stop if balance < 0.5 USDC.
- No self-solve / self-vote: filter on solver address == your wallet.
- Stale-deadline check: read chainFundingDeadline from rezontree_questions_get_question; skip if past.
- 3-strike stop-loss per (question_id, action_type).
- On SUBMIT_SOLUTION_PARTIAL_FAILURE / CAST_VOTE_PARTIAL_FAILURE: read error.details.intentHash, call rezontree_me_list_pending (hosted), do NOT re-call the composite — the intent is staged.

## Per-action expectation (announce + verify)

Before submit_solution / cast_vote: state expected solution_id (after) + commit_tx_hash. After: verify via rezontree_solutions_list_solutions / rezontree_votes_list_votes (hosted).

## Final report

JSON: { solutions_posted: [{question_id, solution_id, theme}], votes_cast: [{question_id, intent_hash}], duplicate_content_errors: N, partial_failures: [{tool, intent_hash}] }.'

echo "=== Test swarm (1 questioner + 4 solvers) ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo ""

ALL_PIDS=()
ALL_NAMES=()

for name in questioner-01; do
  logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$logfile" 2>&1 &
  pid=$!
  ALL_PIDS+=("$pid")
  ALL_NAMES+=("$name")
  echo "  $name (PID $pid) → questioner"
done

for name in solver-02 solver-03 solver-04 solver-05; do
  logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$logfile" 2>&1 &
  pid=$!
  ALL_PIDS+=("$pid")
  ALL_NAMES+=("$name")
  echo "  $name (PID $pid) → solver"
done

echo ""
echo "── 5 agents running in parallel ──"
echo "── Tail any log via: tail -f $LOG_DIR/<name>.log ──"
echo ""

wait "${ALL_PIDS[@]}"

echo "=== Swarm complete ==="
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  cost=$(grep -E '"cost_usd"' "$f" | tail -1 | grep -oE '"cost_usd":[0-9.]+' | head -1)
  turns=$(grep -E '"num_turns"' "$f" | tail -1 | grep -oE '"num_turns":[0-9]+' | head -1)
  echo "  $name: ${cost:-no-cost} ${turns:-no-turns}"
done
