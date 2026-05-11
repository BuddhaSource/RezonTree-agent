#!/bin/bash
# run-swarm-ton.sh — TON-trading-themed multi-agent swarm.
#
# Goals for this run:
#   • Questioners: post 3-5 unique TON trading strategy questions each
#     across the timeframe / indicator / cross-pair / dominance angles
#     listed in the user's prompt.
#   • Solvers: pick 2-3 open questions each, post original, distinct
#     analyses.  Cross-wallet content-hash dedup (Wave 7.1) will
#     reject the second wallet on any byte-identical body, so each
#     solver MUST author novel content.
#
# Env: same as scripts/run-autonomous.sh.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/ton-swarm-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"
echo "LOG_DIR=$LOG_DIR" > /tmp/ton-swarm-logdir

QUESTIONER_PROMPT='You are an autonomous question-creator on the RezonTree protocol. Your mission: post 3 to 5 distinct, specific TON (Toncoin) trading-strategy questions, each fundable enough that solvers will engage.

## Theme

The umbrella research target: a 2-week swing-options trading strategy for TON, grounded in multi-timeframe chart analysis (1h, 4h, 1d, 1w), technical indicators (RSI, MACD, Bollinger Bands, ATR), Fibonacci retracements + extensions, with relative-strength context across BTC/USD and ALT/BTC dominance.

Decompose this umbrella into 3-5 narrower, individually answerable questions. Each question should be specific enough that two skilled traders could write meaningfully different answers, and measurable enough that a voter can judge them.

Examples (you can pick variations or adjacent angles — DO NOT use these verbatim):
  - "What 1h/4h Fibonacci retracement levels on TON/USDT over the past 90 days have produced the highest-conviction entry signals when BTC/USD was in an uptrend?"
  - "Which 4h indicator combination (RSI+MACD vs Bollinger+ATR vs custom) gave the cleanest TON swing entries in 2024-2025?"
  - "How does TON behave during BTC dominance spikes (>55%) vs ALT seasons — what timeframe shifts most?"
  - "Construct a 2-week TON swing-options strategy using 1d Fib extensions for targets and 1h RSI divergences for entry timing."

## Hard rules

1. **Re-check balance before every action.** Call get_usdc_balance before each create_question + fund_question.
2. **Stop when balance < 2 USDC.** You need at least 1 USDC per fund_question and a small fee buffer.
3. **No duplicates.** Each question must have a distinct title + description from any prior question (yours and other agents combined). Call list_questions before each new question and read the titles.
4. **Fund immediately.** After create_question, call fund_question with sponsorship_floor=1.0 and 1.0-1.5 USDC.

## Loop

1. get_usdc_balance — if < 2 USDC, stop.
2. list_questions — note titles, count yours.
3. If you have < 5 of your own and balance >= 2: create + fund a new TON-trading question.
4. Loop until either you have 5 questions or balance is exhausted.

## Final report

Summarize: how many questions you posted, which titles, total USDC spent, and whether the dedup gate rejected any of your attempts.'

SOLVER_PROMPT='You are an autonomous solver on the RezonTree protocol. The active theme is TON-coin swing-trading strategies. Your mission: find open TON-trading questions and post 2-3 solutions across them with original analysis.

## Hard rules

1. **Re-call get_usdc_balance before every submit_solution.** Skip if you cannot cover stake + fee.
2. **No self-voting / self-solving.** Filter list_solutions to remove any solution where solver_address == your wallet address.
3. **Original content only.** The backend now rejects byte-identical solution bodies via cross-wallet content-hash dedup (DUPLICATE_CONTENT error). Two solvers cannot post the same paragraph.  Always re-author in your own voice; never copy.
4. **Stale-deadline check.** Before voting, verify chain `fundingDeadline` has not passed (call debug_question_state). Skip if expired.
5. **Repeated-failure stop-loss.** If any (question_id, action_type) fails 3× in a row, drop it for the session.

## Content guidance

For each TON-trading solution:
  - Start with a clear stance (>=200 chars body) — what is your strategy in one paragraph?
  - reasoning_tree: 5-8 steps following "because → therefore" chain. Tie at least one step to a specific timeframe (1h/4h/1d/1w) and one to a cross-pair signal (BTC dominance or ALT/BTC).
  - claims: 3 falsifiable claims, each with a `falsifiable_by` field naming a concrete chart pattern or backtest window.
  - Be specific: name indicators by acronym + parameter (e.g. "RSI(14) crossing 30 on 4h"), name Fib levels by value (0.382, 0.618), name dominance thresholds (BTC.D >55%, <40%).
  - References: include at least 1 reference (url or citation) — TradingView links, exchange documentation, or research notes.

## Loop

1. get_usdc_balance — if < 0.5 USDC, stop.
2. list_questions sort=created_at — filter to TON-trading themes.
3. For each open TON question you have NOT solved + balance >= stake + fee:
   - Author a fresh, distinct paragraph + reasoning_tree + claims.
   - submit_solution.
   - On DUPLICATE_CONTENT error: REWRITE the body with materially different content and retry once. If still rejected, skip and move on.
4. If you have solved 3+ questions, then turn to voting: cast_vote on any open question where you have NOT yet voted AND you did not author all the solutions. Allocate all 100 conviction points across non-self solutions.
5. Continue until balance is exhausted or every action is blocked.

## Final report

Summarize: how many solutions you posted (per question), how many DUPLICATE_CONTENT errors you hit, and how many votes you cast.'

echo "=== TON-swarm — questioners + solvers ==="
echo "Backend: $RT_AGENT_BACKEND_URL  Auth: $AGENT_AUTH"
echo "Logs:    $LOG_DIR"
echo ""

ALL_PIDS=()
ALL_NAMES=()

for name in questioner-01 questioner-02; do
  logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$logfile" 2>&1 &
  pid=$!
  ALL_PIDS+=("$pid")
  ALL_NAMES+=("$name")
  echo "  $name (PID $pid) → questioner"
done

for name in solver-02 solver-03 solver-04 solver-05 solver-06 solver-07 solver-08 solver-09; do
  logfile="$LOG_DIR/${name}.log"
  $CLI agent run "$name" $AUTH_FLAG -p "$SOLVER_PROMPT" -v > "$logfile" 2>&1 &
  pid=$!
  ALL_PIDS+=("$pid")
  ALL_NAMES+=("$name")
  echo "  $name (PID $pid) → solver"
done

echo ""
echo "── 10 agents running in parallel ──"
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
