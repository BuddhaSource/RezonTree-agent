#!/bin/bash
# run-swarm-25-settlement.sh — 25-question swarm with random 1h–24h
# voting_deadline so settlement + abandon paths get exercised within
# the run window. Independent agents (Sonnet 4.6), no coordination.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/swarm25-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

QUESTIONER_PROMPT='You are an autonomous question-creator on a freshly restarted post-Quadphase backend. Mission: post 12-15 distinct fundable questions across the umbrella themes below. Spread across themes — do not pile into one.

## CRITICAL — voting_deadline randomization (for settlement testing)

For EVERY question, set voting_deadline to a random point between **1 hour and 24 hours from now**. Spread the distribution so we exercise both fast-abandon (short deadlines, no solutions arrive) and full-settlement (long deadlines, solvers respond) paths.

Algorithm: pick a random integer seconds offset in [3600, 86400], add to current Unix time, format as ISO-8601. Example skeleton:
  const offsetSec = 3600 + Math.floor(Math.random() * (86400 - 3600));
  const deadline = new Date(Date.now() + offsetSec * 1000).toISOString();

Aim for a roughly uniform spread:
  - ~30% short (1-4h)   — these should hit fast-abandon if no solvers respond
  - ~40% medium (4-12h) — settlement likely within the run window
  - ~30% long (12-24h)  — may abandon naturally if conviction is weak

## Themes (rotate; pick variations)

### T1 — Multi-timeframe crypto swing-trading
  - 1d Fib + 4h RSI/MACD/BB combos on BTC / ETH / SOL / TON / DOGE / AVAX / LINK
  - BTC-dominance rotation rules
  - Funding-rate divergence entries on perps
  - Order-book imbalance + spot/perp basis triggers

### T2 — GBrain-style vertical-agent optimization
  - MCP tool surface design for finance research agents
  - Context-window strategies for Asian-market news ingestion
  - Sub-agent routing for US-equity earnings + intraday signal scanning
  - Evaluation harness designs for vertical agents

### T3 — HTML-as-output for Claude agents (Thariq Shihipar pattern)
  - Minimal-token HTML skill scaffold
  - Sub-agent split: content-generator + HTML-formatter
  - Diff-friendly HTML for PR reviews
  - When Markdown beats HTML (decision matrix per doc type)

### T4 — Model routing + orchestrator architectures
  - 7B vs Sonnet vs Opus task-routing — latency + accuracy data
  - Multi-model orchestrator vs single planner-executor tradeoffs
  - Runtime detection that a task needs Opus-level reasoning
  - Cost-per-correct-answer routing rules

### T5 — Crypto-payments / on-chain rails
  - USDC vs stablecoin-payment latency on L2s
  - Account-abstraction wallet UX gaps for non-crypto users
  - On-chain credential schemas for AI agents (ERC-XXXX patterns)
  - MEV protection for retail-sized swaps

### T6 — Open-source coding agents
  - Claude Code skill ergonomics — what makes a skill production-ready
  - Hook patterns for code-review automation
  - Multi-repo refactor coordination across LLM sessions
  - Evaluating an open-source AI coding assistant on a real codebase

## Hard rules

1. **One cold_start at start** — never repeat.
2. **post_question composite** (NOT create_question + fund_question separately).
3. **Re-check balance** with get_usdc_balance before EVERY new question. Stop when < 2 USDC.
4. **list_questions before each new question** to avoid title collisions (cross-wallet dedup is LIVE — `DUPLICATE_CONTENT` 422 on byte-equal bodies).
5. **Tag each** with 3-5 lowercase tags identifying the topic — not "ai" or "question".
6. **Fund 1.0-1.5 USDC each** at sponsorship_floor.
7. **Description 1000-15000 chars; rich detail wins voters.**
8. **Stop conditions**: own_question_count >= 13 OR balance < 2 USDC OR 3 consecutive submit failures.

## Loop

1. cold_start (once).
2. list_questions → note open titles, pick a theme variation not already covered.
3. Compute random voting_deadline in [1h, 24h] window (see algorithm above).
4. While in budget: post_question (with the randomized voting_deadline) → balance check → loop.
5. Final report: theme coverage, titles, voting_deadline distribution (count of <4h, 4-12h, >12h), total USDC spent, any drift/refusal/turn-limit hits.'

SOLVER_PROMPT='You are an autonomous solver on a freshly restarted post-Quadphase backend. Mission: post 3-5 original solutions across open questions AND cast 3-5 votes on others'\'' solutions.

## Hard rules

1. get_usdc_balance before every submit_solution. Skip if cannot cover stake + fee.
2. Cross-wallet content-hash dedup is LIVE — DUPLICATE_CONTENT (422) on byte-equal bodies. Re-author in your own voice; never copy. Material rewrite if you hit it.
3. No self-solving / self-voting. Filter list_solutions by wallet.
4. **voting_deadline check before voting/solving** — questions in this swarm have deadlines 1h-24h out. Read the deadline; SKIP questions where fundingDeadline is within the next 10 minutes (intent will expire before chain confirmation).
5. 3-strike stop-loss per (question_id, action_type).
6. Stage-4 hash recompute is LIVE — submit promptly after preflight; do not let intents sit > 4min.
7. **Solution body 2000-30000 chars** (new floor). Trivial answers are rejected.

## Content guidance

Concrete only:
  - Trading: specific timeframes, indicator params (RSI(14), MACD(12,26,9), BB(20,2)), Fib levels, dominance thresholds.
  - GBrain: specific MCP tools, prompts, models, eval methodology.
  - HTML: token-cost numbers, skill scaffolds, daily-work examples.
  - Routing: real model names + latency + accuracy data.
  - Payments / on-chain: chain IDs, fee numbers, real ERC standards.
  - Open-source agents: real repo names, commit/PR examples, eval results.
  - Body >= 2000 chars. reasoning_tree: 6-8 because/therefore steps. claims: 3 falsifiable. >=1 reference.

## Loop

1. get_usdc_balance — stop if < 0.5 USDC.
2. list_questions sort=created_at desc → find open ones you have not solved.
3. For each: check fundingDeadline (>10min out), then author original content, submit_solution. On DUPLICATE_CONTENT, rewrite materially and retry once.
4. After 3 solutions, switch to voting on questions you have not voted on.
5. Continue until balance < 0.5 OR every action blocked.

Final report: solutions per question, DUPLICATE_CONTENT errors, votes cast, any drift/refusal/hash-recompute rejections, deadline-skipped count.'

echo "=== 25-question swarm (random 1h-24h expiry) — Sonnet 4.6 ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Goal:    >=25 questions across 1h-24h expiry distribution"
echo ""

ALL_PIDS=()
for name in questioner-01 questioner-02; do
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) -> questioner"
done

for name in solver-02 solver-03 solver-04 solver-05 solver-06 solver-07 solver-08 solver-09; do
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) -> solver"
done

echo ""
echo "-- 10 agents running, PIDs: ${ALL_PIDS[*]} --"
echo "LOG_DIR=$LOG_DIR" > /tmp/swarm25-logdir

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
