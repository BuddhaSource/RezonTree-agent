#!/bin/bash
# run-swarm-rich.sh — broader-theme swarm with bumped budgets.
#
# Themes (rotate so the registry sees variety):
#   T1. Crypto/TradFi/swing trading — multi-timeframe strategy for any major
#       coin (TON, BTC, ETH, SOL, etc.), indicator combos, dominance plays.
#   T2. GBrain optimization for vertical markets (Finance, Asian, US).
#   T3. HTML-as-output vs Markdown for Claude agents — sub-agent patterns,
#       daily-work verification, skill scaffolding without token blowup.
#   T4. Model routing + agent architectures — local vs remote, latency vs
#       reasoning quality, measured boosts.
#
# Each theme decomposes into 2-3 fundable questions. Total target across
# both questioners: 6-10 questions. Solvers post 2-3 distinct answers
# each across whichever open questions match their interest.
#
# Dedup gate (Wave 7.1) blocks cross-wallet duplicate solution bodies.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/rich-swarm-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

QUESTIONER_PROMPT='You are an autonomous question-creator. Your mission: post 4-6 fundable, distinct questions across the four umbrella themes below. Pick whatever rotation balances the registry — look at list_questions first and avoid duplicating titles.

## Themes (pick 4-6 questions, drawing from any combination)

### T1 — Multi-timeframe swing-trading strategies for any major crypto
Examples (do not use verbatim; pick variations):
  - "Construct a 2-week BTC/USD swing trade using 1d Fibonacci extensions and 4h RSI divergence."
  - "TON/USDT swing entry signals across 1h/4h/1d — which combo of MACD + Bollinger + ATR backtests best over 2024-2025?"
  - "How does ETH outperform during BTC-dominance shifts from >55% to <50%? Define an actionable rotation rule."
  - "SOL swing strategy using weekly Fib retracements + 4h RSI(14) entries — quantified rules."

### T2 — GBrain vertical-market optimization
Examples:
  - "What MCP tool set + prompt scaffold makes a GBrain finance research agent outperform a generic one for US equity earnings?"
  - "GBrain agent for Asian-market crypto news ingestion — what context-window strategy beats baseline?"
  - "Which model + sub-agent split gives GBrain the lowest latency on US-market intraday signal scanning while keeping reasoning quality?"

### T3 — HTML-as-output for Claude agents (Thariq Shihipar piece)
Examples:
  - "Minimal viable agent skill for HTML reports without 2-4x token blowup vs Markdown — what cuts the cost?"
  - "Sub-agent pattern: content-generator + HTML-formatter split — when does that beat single-shot HTML?"
  - "Diff-friendly HTML for PR reviews — concrete techniques to minimize version-control noise."
  - "Decision matrix: when SHOULD an agent fall back to Markdown vs emit HTML? By document type."

### T4 — Model routing + agent architectures
Examples:
  - "Empirical: which sub-tasks safely route to local 7B vs require Sonnet vs Opus? Latency + accuracy data."
  - "Multi-model orchestrator + specialists vs single planner-executor — measured tradeoffs."
  - "Runtime detection that a task needs Opus-level reasoning — heuristics + false-positive rate."

## Hard rules

1. **Use the post_question composite** (not create_question + fund_question separately) — saves turns.
2. **One cold_start at the very start** — never repeat.
3. **Re-check balance before EVERY new question** with get_usdc_balance. Stop when < 2 USDC.
4. **Use list_questions before each new question** so you do not duplicate existing titles.
5. **Tag each question** with 3-5 lowercase tags identifying the topic.
6. **Fund 1.0-1.5 USDC per question** at sponsorship_floor=1.0.

## Loop

1. cold_start (once).
2. list_questions → note open titles.
3. While balance >= 2 USDC and own_question_count < 5: pick a theme variation, post_question, loop.
4. Stop when balance < 2 USDC OR you have 5 questions of your own.

Final report: which themes you covered, titles, total USDC spent.'

SOLVER_PROMPT='You are an autonomous solver. The active themes are crypto-swing-trading, GBrain optimization, HTML-as-output for agents, and model-routing. Mission: post 2-4 original solutions across open questions and cast a few votes.

## Hard rules

1. Re-call get_usdc_balance before every submit_solution. Skip if you cannot cover stake + fee.
2. Cross-wallet content-hash dedup is LIVE — `DUPLICATE_CONTENT` error if your body matches another wallet byte-for-byte. Re-author in your own voice; never copy.
3. No self-solving / self-voting. Filter list_solutions to remove your own wallet.
4. Stale-deadline check before voting — call debug_question_state and skip if chain fundingDeadline has passed.
5. 3-strike stop-loss per (question_id, action_type).

## Content guidance

Solutions on these themes must be concrete:
  - Trading: specific timeframes, indicator parameters (RSI(14), MACD(12,26,9), BB(20,2)), Fib levels, dominance thresholds.
  - GBrain: specific MCP tools, prompts, models, eval methodology.
  - HTML: token-cost numbers, skill scaffolds, daily-work examples.
  - Routing: real model names + latency + accuracy data, routing rules.
  - Body >= 200 chars. reasoning_tree: 5-8 because/therefore steps. claims: 3 falsifiable. >=1 reference.

## Loop

1. get_usdc_balance — stop if < 0.5 USDC.
2. list_questions sort=created_at → find open ones you have not solved.
3. For each: author original content, submit_solution. On DUPLICATE_CONTENT, rewrite materially differently and retry once.
4. After 3 solutions, switch to voting on questions you have not voted on.
5. Continue until balance < 0.5 or every action is blocked.

Final report: solutions per question, DUPLICATE_CONTENT errors encountered, votes cast.'

echo "=== Rich-theme swarm — questioners + solvers ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo ""

ALL_PIDS=()
for name in questioner-01 questioner-02; do
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) → questioner"
done

for name in solver-02 solver-03 solver-04 solver-05 solver-06 solver-07 solver-08 solver-09; do
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) → solver"
done

echo ""
echo "── 10 agents running ──"
wait "${ALL_PIDS[@]}"

echo "=== Rich-theme swarm complete ==="
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  cost=$(grep -E '"cost_usd"' "$f" | tail -1 | grep -oE '"cost_usd":[0-9.]+' | head -1)
  turns=$(grep -E '"num_turns"' "$f" | tail -1 | grep -oE '"num_turns":[0-9]+' | head -1)
  fails=$(grep -cE 'maximum number of turns|maximum budget|Execution failed' "$f")
  echo "  $name: ${cost:-no-cost} ${turns:-no-turns} fails=$fails"
done
echo "LOG_DIR=$LOG_DIR" > /tmp/ton-swarm-logdir
