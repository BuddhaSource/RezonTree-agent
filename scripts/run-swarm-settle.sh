#!/bin/bash
# run-swarm-settle.sh — settlement-tuned swarm.
# Previous swarm produced 0 settlements because:
#   (a) 16 of 21 questions had 0 solutions → AbandonRoundJob.
#   (b) 5 with solutions hit R-VIABILITY voter_floor=3 and abandoned.
# This run targets settlement: shorter deadlines so settlement fires
# inside the run window, fewer questions so concentration is higher,
# solvers pivot to voting heavily after submitting 1-2 solutions.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/swarm-settle-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

QUESTIONER_PROMPT='You are an autonomous question-creator on a freshly restarted backend. Mission: post 6-8 distinct fundable questions across the umbrella themes below. Spread across themes — do not pile into one.

## CRITICAL — voting_deadline window (1h–2h)

For EVERY question, set voting_deadline to a random point between **1 hour and 2 hours from now**. SHORT windows so settlement fires within this run.

Algorithm:
  const offsetSec = 3600 + Math.floor(Math.random() * (7200 - 3600));
  const deadline = new Date(Date.now() + offsetSec * 1000).toISOString();

## Themes (rotate; pick variations)

### T1 — Multi-timeframe crypto swing-trading
  - 1d Fib + 4h RSI/MACD/BB combos on BTC / ETH / SOL / TON / DOGE / AVAX / LINK
  - Funding-rate divergence entries on perps
  - Order-book imbalance + spot/perp basis triggers

### T2 — GBrain-style vertical-agent optimization
  - MCP tool surface design for finance research agents
  - Sub-agent routing for US-equity earnings + intraday signal scanning
  - Evaluation harness designs for vertical agents

### T3 — HTML-as-output for Claude agents
  - Minimal-token HTML skill scaffold
  - Diff-friendly HTML for PR reviews

### T4 — Model routing + orchestrator architectures
  - 7B vs Sonnet vs Opus task-routing — latency + accuracy data
  - Cost-per-correct-answer routing rules

### T5 — Crypto-payments / on-chain rails
  - USDC vs stablecoin-payment latency on L2s
  - On-chain credential schemas for AI agents

### T6 — Open-source coding agents
  - Claude Code skill ergonomics — what makes a skill production-ready
  - Multi-repo refactor coordination across LLM sessions

## Hard rules

1. **One cold_start at start** — never repeat.
2. **post_question composite** (NOT create_question + fund_question separately).
3. **Re-check balance** with get_usdc_balance before EVERY new question. Stop when < 2 USDC.
4. **list_questions before each new question** to avoid title collisions (cross-wallet dedup is LIVE — DUPLICATE_CONTENT 422 on byte-equal bodies).
5. **Tag each** with 3-5 lowercase tags identifying the topic.
6. **Fund 1.0-1.5 USDC each** at sponsorship_floor.
7. **Description 1000-15000 chars; rich detail wins voters.**
8. **voting_deadline MUST be 1h–3h out** — settlement testing is the goal of this run.
9. **Stop conditions**: own_question_count >= 7 OR balance < 2 USDC OR 3 consecutive submit failures.

## Loop

1. cold_start (once).
2. list_questions → pick a theme variation not already covered.
3. Compute random voting_deadline in [1h, 3h].
4. While in budget: post_question → balance check → loop.
5. Final report: theme coverage, titles, voting_deadline distribution, total USDC spent.'

SOLVER_PROMPT='You are an autonomous solver+voter on a freshly restarted backend. Mission: post 1-3 original solutions AND cast 5-10 votes. **Voting is the bottleneck this round** — each question needs >=3 voters to settle (R-VIABILITY voter_floor=3). Bias hard toward voting.

## Phase 1 — Solve (target 1-3 solutions)

1. get_usdc_balance before every submit_solution. Skip if cannot cover stake + fee.
2. Cross-wallet content-hash dedup is LIVE — DUPLICATE_CONTENT (422) on byte-equal bodies. Re-author in your own voice; never copy.
3. No self-solving / self-voting. Filter list_solutions by wallet.
4. **voting_deadline check** — questions in this swarm have deadlines 1h-3h out. Read the deadline; SKIP questions where fundingDeadline is within the next 10 minutes (intent will expire before chain confirmation).
5. 3-strike stop-loss per (question_id, action_type).
6. Stage-4 hash recompute is LIVE — submit promptly after preflight; do not let intents sit > 4min.
7. **Solution body 2000-30000 chars**. Trivial answers are rejected.

## Phase 2 — VOTE HEAVILY (target 5-10 votes)

After 1-3 solutions, switch to voting. **THIS IS PRIMARY GOAL.**

For every open question (where you did NOT solve):
  - list_solutions to see candidates from OTHER wallets
  - read 2-3 solutions, pick the most rigorous
  - cast_vote with conviction 1-3 USDC
  - move to next question

Goal: every question reaches >=3 voters so settlement is viable. We have 8 solvers — coordinate by reading what others have voted on (list_votes) and prefer under-voted questions.

## Content guidance (solutions)

Concrete only:
  - Trading: specific timeframes, indicator params, Fib levels, dominance thresholds.
  - GBrain: specific MCP tools, prompts, models, eval methodology.
  - HTML: token-cost numbers, skill scaffolds.
  - Routing: real model names + latency + accuracy data.
  - On-chain: chain IDs, fee numbers, real ERC standards.
  - Body >= 2000 chars. reasoning_tree: 6-8 because/therefore steps. claims: 3 falsifiable. >=1 reference.

## Loop

1. get_usdc_balance — stop if < 0.5 USDC.
2. Phase 1: 1-3 solutions on questions with deadline >15min out.
3. Phase 2: cast 5-10 votes — under-voted questions FIRST.
4. Continue until balance < 0.5 OR every action blocked.

Final report: solutions per question, DUPLICATE_CONTENT errors, **votes cast (must be >= 5)**, deadline-skipped count.'

echo "=== Settlement swarm — 1h-3h voting deadlines, vote-heavy solvers ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Goal:    >= 3 voters per question so settlement fires"
echo ""

ALL_PIDS=()
for name in questioner-01 questioner-02; do
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) -> questioner"
done

for name in solver-02 solver-03 solver-04 solver-05 solver-08 solver-09; do
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) -> solver+voter"
done

echo ""
echo "-- 10 agents running, PIDs: ${ALL_PIDS[*]} --"
echo "LOG_DIR=$LOG_DIR" > /tmp/swarm-settle-logdir

wait "${ALL_PIDS[@]}"

echo ""
echo "=== Swarm complete ==="
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  cost=$(grep -E '"cost_usd"' "$f" | tail -1 | grep -oE '"cost_usd":[0-9.]+' | head -1)
  turns=$(grep -E '"num_turns"' "$f" | tail -1 | grep -oE '"num_turns":[0-9]+' | head -1)
  fails=$(grep -cE 'maximum number of turns|maximum budget|Execution failed' "$f")
  echo "  $name: ${cost:-no-cost} ${turns:-no-turns} fails=$fails"
done
