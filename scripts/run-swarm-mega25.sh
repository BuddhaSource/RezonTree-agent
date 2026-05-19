#!/bin/bash
# run-swarm-mega25.sh — fresh post-Quadphase smoke. Goal: ≥25 questions, multiple
# solutions each, full activity + drift log. Sonnet 4.6 default (per
# config/settings/base.ts). 2 questioners (cap-bumped to 120 turns / $12) +
# 8 solvers running in parallel.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/mega25-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

QUESTIONER_PROMPT='You are an autonomous question-creator on a freshly restarted post-Quadphase backend (intent_hash NOT NULL UNIQUE, preflight HMAC, oracle sink, Stage-4 hash-recompute). Mission: post 12-15 distinct fundable questions across the umbrella themes below. Spread the questions across themes — do not pile all into T1.

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

### T5 — Crypto-payments / on-chain rails (NEW)
  - USDC vs stablecoin-payment latency on L2s
  - Account-abstraction wallet UX gaps for non-crypto users
  - On-chain credential schemas for AI agents (ERC-XXXX patterns)
  - MEV protection for retail-sized swaps

### T6 — Open-source coding agents (NEW)
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
7. **Stop conditions**: own_question_count >= 13 OR balance < 2 USDC OR 3 consecutive submit failures.

## Loop

1. cold_start (once).
2. list_questions → note open titles, pick a theme variation not already covered.
3. While in budget: post_question → balance check → loop.
4. Final report: theme coverage, titles, total USDC spent, any drift/refusal/turn-limit hits.'

SOLVER_PROMPT='You are an autonomous solver on a freshly restarted post-Quadphase backend. Mission: post 3-5 original solutions across open questions AND cast 3-5 votes on others'\'' solutions.

## Hard rules

1. get_usdc_balance before every submit_solution. Skip if cannot cover stake + fee.
2. Cross-wallet content-hash dedup is LIVE — DUPLICATE_CONTENT (422) on byte-equal bodies. Re-author in your own voice; never copy. Material rewrite if you hit it.
3. No self-solving / self-voting. Filter list_solutions by wallet.
4. Stale-deadline check before voting — debug_question_state; skip if fundingDeadline passed.
5. 3-strike stop-loss per (question_id, action_type).
6. Stage-4 hash recompute is LIVE — intents with stale expiresAt now fail loudly. Submit promptly after preflight; do not let intents sit > 4min.

## Content guidance

Concrete only:
  - Trading: specific timeframes, indicator params (RSI(14), MACD(12,26,9), BB(20,2)), Fib levels, dominance thresholds.
  - GBrain: specific MCP tools, prompts, models, eval methodology.
  - HTML: token-cost numbers, skill scaffolds, daily-work examples.
  - Routing: real model names + latency + accuracy data.
  - Payments / on-chain: chain IDs, fee numbers, real ERC standards.
  - Open-source agents: real repo names, commit/PR examples, eval results.
  - Body >= 200 chars. reasoning_tree: 5-8 because/therefore steps. claims: 3 falsifiable. >=1 reference.

## Loop

1. get_usdc_balance — stop if < 0.5 USDC.
2. list_questions sort=created_at desc → find open ones you have not solved.
3. If the pool is empty OR you have already actioned everything actionable, call **wait_for_questions** (poll_interval_seconds=60, max_wait_seconds=900, exclude_authors=[your wallet]). Do NOT exit on first-empty-poll — wait_for_questions returns when new work appears. Exit only if it returns matched:[] after the full wait window AND you have hit at least your target counts below.
4. For each open question: author original content, submit_solution. On DUPLICATE_CONTENT, rewrite materially and retry once.
5. After 3 solutions, switch to voting on questions you have not voted on.
6. Continue the loop (back to step 2) until balance < 0.5 USDC OR three consecutive wait_for_questions calls return empty.

Final report: solutions per question, DUPLICATE_CONTENT errors, votes cast, any drift / refusal / hash-recompute rejections.'

echo "=== Mega-25 swarm — Sonnet 4.6 ==="
echo "Backend: $RT_AGENT_BACKEND_URL"
echo "Logs:    $LOG_DIR"
echo "Goal:    ≥25 questions + multi-solutions"
echo ""

# Pre-flight balance gate. Catches the mega25-retro failure mode where
# an agent boots with USDC below the stake floor and dies after burning
# turns on retries. Set SWARM_SKIP_PREFLIGHT=1 to bypass (e.g. when
# debugging the swarm runner itself).
QUESTIONERS_DEFAULT="questioner-01,questioner-02"
SOLVERS_DEFAULT="solver-02,solver-03,solver-04,solver-05,solver-06,solver-07,solver-08,solver-09"
QUESTIONERS_CSV="${SWARM_QUESTIONERS:-$QUESTIONERS_DEFAULT}"
SOLVERS_CSV="${SWARM_SOLVERS:-$SOLVERS_DEFAULT}"

if [ "${SWARM_SKIP_PREFLIGHT:-0}" != "1" ]; then
  PF_FLAGS=(
    "--questioners" "$QUESTIONERS_CSV"
    "--solvers"     "$SOLVERS_CSV"
    "--solutions-per-solver" "${SOLVER_TASKS:-5}"
    "--questions-per-questioner" "${QUESTIONER_TASKS:-13}"
  )
  [ "${SWARM_REBALANCE:-1}" = "1" ] && PF_FLAGS+=("--rebalance")
  echo "── pre-flight balance gate ──"
  if ! npx --silent tsx scripts/preflight-swarm.ts "${PF_FLAGS[@]}"; then
    echo ""
    echo "✗ pre-flight failed. Fix funding or set SWARM_SKIP_PREFLIGHT=1 to bypass."
    exit 2
  fi
  echo ""
fi

# Convert CSV → space-separated for the for-loops below. The names
# survived pre-flight, so every one of them is viable.
QUESTIONERS=$(echo "$QUESTIONERS_CSV" | tr ',' ' ')
SOLVERS=$(echo "$SOLVERS_CSV"     | tr ',' ' ')

ALL_PIDS=()
for name in $QUESTIONERS; do
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) → questioner"
done

for name in $SOLVERS; do
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$LOG_DIR/${name}.log" 2>&1 &
  ALL_PIDS+=("$!")
  echo "  $name (PID $!) → solver"
done

echo ""
echo "── 10 agents running, PIDs: ${ALL_PIDS[*]} ──"
echo "LOG_DIR=$LOG_DIR" > /tmp/mega25-logdir

wait "${ALL_PIDS[@]}"

echo ""
echo "=== Mega-25 swarm complete ==="
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  cost=$(grep -E '"cost_usd"' "$f" | tail -1 | grep -oE '"cost_usd":[0-9.]+' | head -1)
  turns=$(grep -E '"num_turns"' "$f" | tail -1 | grep -oE '"num_turns":[0-9]+' | head -1)
  fails=$(grep -cE 'maximum number of turns|maximum budget|Execution failed' "$f")
  echo "  $name: ${cost:-no-cost} ${turns:-no-turns} fails=$fails"
done
