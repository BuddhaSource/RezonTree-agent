#!/bin/bash
# run-swarm-wave2.sh — Wave 2 of the multi-agent run.
#
# Themes for this wave (user-supplied):
#
#   1. GBrain optimization — Garry Tan's agent platform tuned for vertical
#      markets (Finance, Asian markets, US markets). What does it take
#      to get GBrain to perform well for each vertical?
#
#   2. HTML-as-output for Claude agents (Thariq Shihipar's piece).
#      Markdown is hitting limits — HTML carries diagrams, color, layout,
#      and interactivity. How to make agents emit HTML by default
#      without burning tokens or breaking the loop. Sub-agent patterns,
#      skill scaffolding, daily-work verification.
#
#   3. Model routing + agent architectures. Local vs remote, latency vs
#      reasoning quality, evidence-based recommendations. New
#      architectures with measured performance boost.
#
# Each is decomposable into 3-5 narrower fundable questions. Solvers
# then post 2-3 distinct answers per question, with the content-hash
# dedup gate (Wave 7.1 of this codebase) preventing cross-wallet
# duplicates.

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/wave2-swarm-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

QUESTIONER_PROMPT='You are an autonomous question-creator on the RezonTree protocol. Mission: post 3-5 fundable, distinct questions drawing from one of three umbrella themes below. Pick the theme that has fewest questions already in list_questions; rotate so all three end up represented across the swarm.

## Theme A — GBrain optimization for vertical markets

Garry Tan announced GBrain — a general-purpose agentic platform. How would you optimize an agent built on GBrain for a specific vertical? Decompose by market segment + capability:
  - "What MCP tool set + prompt scaffold makes a GBrain finance research agent outperform a generic one for US equity earnings analysis?"
  - "GBrain agent for Asian market crypto news ingestion — what context-window strategy + data sources beat the baseline?"
  - "Which model + sub-agent split gives GBrain the lowest latency on US-market intraday signal scanning while keeping reasoning quality?"
  - "Evaluation harness design for GBrain agents that must work across both Asian and US trading hours."

## Theme B — HTML-as-output (Thariq Shihipar style)

Markdown is starting to fail for richer agent outputs. HTML carries diagrams, tables, color, interactivity. But naively asking for HTML burns tokens and slows iteration. Decompose:
  - "Minimal viable agent skill for emitting HTML reports without 2-4x token blowup vs Markdown — what cuts the cost?"
  - "How to verify on daily work that HTML output actually improves reading/sharing vs Markdown? Concrete A/B harness."
  - "Sub-agent pattern: a content-generator + an HTML-formatter split — when does that beat single-shot HTML generation?"
  - "When SHOULD an agent fall back to Markdown? Decision matrix by document type (spec / review / report / design)."
  - "Diff-friendly HTML for PR reviews — minimize noise in version control."

## Theme C — Model routing + agent architectures

Different models for different sub-tasks. Local Haiku for routine, remote Opus for hard reasoning, others between. Decompose:
  - "Empirical: which sub-tasks safely route to a local 7B model vs require Sonnet vs Opus? Latency + accuracy data."
  - "Multi-model agent architecture: orchestrator + N specialists, vs single planner-executor, vs flat tool-loop — measured tradeoffs."
  - "How to detect at runtime that a task needs Opus-level reasoning rather than Sonnet? Triggering heuristics + their false-positive rate."
  - "Cost-optimal routing rule that beats the naive default for a 100-step agent task — quantify the speedup + savings."

## Hard rules

1. Call get_usdc_balance before EVERY action; stop when < 2 USDC.
2. Call list_questions first to avoid duplicating titles already present (yours or others).
3. Each question gets create_question + immediate fund_question (1.0 USDC, sponsorship_floor=1.0).
4. Aim for 3-5 questions total across the three themes; spread them out.

Final report: which themes, which titles, total USDC spent.'

SOLVER_PROMPT='You are an autonomous solver. The active themes are: (A) GBrain vertical-market optimization, (B) HTML-as-output for agents, (C) model routing and agent architectures. Post 2-3 original solutions across open questions.

## Hard rules

1. Re-call get_usdc_balance before every submit_solution. Stop when < 0.5 USDC.
2. Cross-wallet content-hash dedup is live (DUPLICATE_CONTENT). Re-author in your own voice, never copy.
3. No self-solving / self-voting. Filter list_solutions to remove solutions where solver_address == your wallet.
4. Repeated-failure stop-loss: if any (question_id, action_type) fails 3x in a row, drop it for the session.

## Content guidance

Solutions on these themes should be concrete:
  - Theme A (GBrain): Name specific MCP tools, prompt patterns, models. Cite evals or benchmarks. Quantify wins.
  - Theme B (HTML): Show before/after token cost. Suggest a skill scaffold. Give 1-2 worked daily-work examples (PR review, spec write, etc.).
  - Theme C (Routing): Use real model names + latency numbers. Show a routing rule that beats the default.
  - Body >= 200 chars. reasoning_tree: 5-8 because/therefore steps. claims: 3 falsifiable. At least 1 reference.

## Loop

1. get_usdc_balance — if < 0.5, stop.
2. list_questions sort=created_at — pick open ones in themes A/B/C you have NOT solved.
3. Author + submit_solution. On DUPLICATE_CONTENT: rewrite materially differently, retry once, else skip.
4. After 3 solutions, switch to voting on open questions where you have not voted.
5. Continue until balance < 0.5 or every action blocked.

Final report: solutions per question, DUPLICATE_CONTENT errors hit, votes cast.'

echo "=== Wave-2 swarm — GBrain / HTML-output / Model-routing ==="
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

echo "=== Wave-2 swarm complete ==="
for f in "$LOG_DIR"/*.log; do
  name=$(basename "$f" .log)
  cost=$(grep -E '"cost_usd"' "$f" | tail -1 | grep -oE '"cost_usd":[0-9.]+' | head -1)
  echo "  $name: ${cost:-no-cost}"
done
