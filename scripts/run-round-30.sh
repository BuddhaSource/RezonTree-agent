#!/usr/bin/env bash
# run-round-30.sh — 30 questions, 40-min round, all 10 wallets play all roles.
#
# Phase 1: 30 question creations, distributed 3 per wallet across all 10
# wallets (questioner-01/02 + solver-02..09). Throttled batches of 6 parallel.
#
# Phase 2: each wallet picks random open questions and submits solutions.
# Phase 3: each wallet votes on solutions to questions it didn't author/solve.
# Phase 4: wait for voting deadline + grace, settlement runs via oracle keeper.
#
# Role rotation: every wallet acts as sponsor (3 questions), solver
# (variable), AND voter (variable) within the same 40-min window.
#
# Model: sonnet (claude-sonnet-4.6) per agents/*.yaml.

set -uo pipefail
cd "$(dirname "$0")/.."

# ── Config ─────────────────────────────────────────────────────
VOTING_DEADLINE_MIN="${VOTING_DEADLINE_MIN:-35}"
BOUNTY_USDC="${BOUNTY_USDC:-1}"
PARALLEL_BATCH="${PARALLEL_BATCH:-6}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
LOG_DIR="logs/round30-${RUN_ID}"
mkdir -p "$LOG_DIR"

NOW_UTC_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if date -u -v+0M +%Y >/dev/null 2>&1; then
  DEADLINE_UTC_ISO="$(date -u -v+"${VOTING_DEADLINE_MIN}"M +%Y-%m-%dT%H:%M:%SZ)"
else
  DEADLINE_UTC_ISO="$(date -u -d "+${VOTING_DEADLINE_MIN} minutes" +%Y-%m-%dT%H:%M:%SZ)"
fi

# ── Env preflight ──────────────────────────────────────────────
: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"

AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

if ! pnpm --silent exec tsc --noEmit >/dev/null 2>&1; then
  echo "ERROR: TS build broken. Run 'pnpm build' first." >&2
  exit 2
fi

CLI="pnpm --silent start"

# ── Wallet roster (all 10 play all roles) ──────────────────────
WALLETS=(
  questioner-01 questioner-02
  solver-02 solver-03 solver-04 solver-05
  solver-06 solver-07 solver-08 solver-09
)

# ── 30 diverse topics ──────────────────────────────────────────
TOPICS=(
  "What's the most cost-effective way to migrate a 100M-row Postgres table to a new schema with zero downtime?"
  "How should an AI agent prioritize when its context window is 80% full and 5 tool calls are pending?"
  "What's the safest pattern for rotating production database credentials without service interruption?"
  "How do you design a rate limiter that's fair across tenants but doesn't penalize burst traffic?"
  "What's the right way to handle EIP-712 typehash drift across Solidity, Go signer, and TypeScript SDK?"
  "How should a multi-region SaaS handle write conflicts when both regions accept writes during a partition?"
  "What's the optimal feature-flag rollout strategy for a payment processor change?"
  "How do you decide between server-sent events, WebSockets, and long-polling for a real-time feed?"
  "What metrics best predict customer churn for a B2B SaaS with usage-based pricing?"
  "How should an oracle service handle quorum failures without halting block production?"
  "What's the right architecture for running 1000+ AI agents in parallel against a single backend?"
  "How do you migrate from REST to GraphQL incrementally without breaking existing clients?"
  "What's the best way to detect and prevent prompt-injection attacks in production LLM apps?"
  "How should a job queue handle poison messages without dropping legitimate retries?"
  "What's the correct approach to testing migrations against production-scale data?"
  "How do you size a Postgres connection pool for an autoscaling Kubernetes deployment?"
  "What's the safest way to deprecate a public API endpoint with active enterprise consumers?"
  "How should an EVM contract handle arithmetic overflow in fee calculations across decimal mismatches?"
  "What's the right way to structure observability for a multi-service event-driven architecture?"
  "How do you design a permission system that scales from 10 to 10000 users without rewriting?"
  "What's the optimal cache invalidation strategy for derived data with multiple upstream sources?"
  "How should a recommendation system handle cold-start users without compromising privacy?"
  "What's the right way to evaluate which LLM model to use for a specific task in production?"
  "How do you measure the actual ROI of moving from monolith to microservices?"
  "What's the safest pattern for handling partial failures in a 3-step distributed transaction?"
  "How should a crypto bridge protect against reorg attacks during high-volume cross-chain transfers?"
  "What's the right approach to schema evolution for an event-sourced system?"
  "How do you design SLOs for an AI service where output quality matters more than latency?"
  "What's the best way to handle GDPR right-to-erasure across an event-sourced architecture?"
  "How should a vector database choose between exact and approximate nearest-neighbor search at scale?"
)

QUESTION_COUNT=${#TOPICS[@]}
WALLET_COUNT=${#WALLETS[@]}

# ── Header ──────────────────────────────────────────────────────
{
  echo "================================================================"
  echo "  Round 11 — 30 Questions / 40-min / Sonnet 4.6 / 10 Wallets"
  echo "================================================================"
  echo "Run ID:           $RUN_ID"
  echo "Started:          $NOW_UTC_ISO"
  echo "Voting deadline:  $DEADLINE_UTC_ISO  (+${VOTING_DEADLINE_MIN}min)"
  echo "Bounty/question:  ${BOUNTY_USDC} USDC"
  echo "Backend:          $RT_AGENT_BACKEND_URL"
  echo "Logs:             $LOG_DIR"
  echo "Parallel batch:   $PARALLEL_BATCH"
  echo "Wallets:          ${WALLETS[*]}"
  echo "================================================================"
} | tee "$LOG_DIR/SUMMARY.log"

DEADLINE_INSTRUCTION="Use exactly this voting deadline (UTC, ISO-8601): $DEADLINE_UTC_ISO. Current time is $NOW_UTC_ISO. Pass the deadline string verbatim to post_question — do NOT recompute, round, or substitute a relative phrase."

# ── Phase 1: 30 questions in throttled parallel batches ────────
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "── Phase 1: Asking 30 Questions ──" | tee -a "$LOG_DIR/SUMMARY.log"

start_ts=$(date +%s)
for ((i=0; i<QUESTION_COUNT; i++)); do
  wallet="${WALLETS[$((i % WALLET_COUNT))]}"
  topic="${TOPICS[$i]}"
  qnum=$(printf "%02d" "$((i+1))")
  log="$LOG_DIR/q${qnum}-${wallet}-create.log"

  # shellcheck disable=SC2086
  $CLI agent run "$wallet" $AUTH_FLAG \
    -p "Create exactly ONE question about: $topic. Set bounty $BOUNTY_USDC USDC. $DEADLINE_INSTRUCTION After post_question succeeds, output the questionId and stop." \
    -v > "$log" 2>&1 &

  # Throttle: wait when batch is full
  if (( (i + 1) % PARALLEL_BATCH == 0 )); then
    wait
    elapsed=$(( $(date +%s) - start_ts ))
    echo "  batch ${qnum} done at +${elapsed}s" | tee -a "$LOG_DIR/SUMMARY.log"
  fi
done
wait
elapsed=$(( $(date +%s) - start_ts ))
echo "  Phase 1 complete at +${elapsed}s" | tee -a "$LOG_DIR/SUMMARY.log"

# Count how many questions we actually got on-chain via backend
sleep 5  # brief settle for ponder→reconciler
QCOUNT=$(curl -s "${RT_AGENT_BACKEND_URL}/v1/questions?limit=100&sort=newest" \
  | python3 -c "import sys, json; d = json.load(sys.stdin); print(len(d.get('items', d) if isinstance(d, dict) else d))" 2>/dev/null || echo "?")
echo "  Backend reports $QCOUNT confirmed questions visible" | tee -a "$LOG_DIR/SUMMARY.log"

# ── Phase 2: All wallets solve ─────────────────────────────────
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "── Phase 2: Solving (all 10 wallets in parallel) ──" | tee -a "$LOG_DIR/SUMMARY.log"

phase2_start=$(date +%s)
for wallet in "${WALLETS[@]}"; do
  log="$LOG_DIR/${wallet}-solve.log"
  # shellcheck disable=SC2086
  $CLI agent run "$wallet" $AUTH_FLAG \
    -p "Use list_questions to find OPEN questions on the protocol. Pick 3 random questions you did NOT author yourself, read each carefully, then submit a thorough solution to each via submit_solution. Use validate_solution first. Stop after 3 solutions OR when no eligible questions remain." \
    -v > "$log" 2>&1 &
done
wait
elapsed=$(( $(date +%s) - phase2_start ))
echo "  Phase 2 complete at +${elapsed}s" | tee -a "$LOG_DIR/SUMMARY.log"

# ── Phase 3: All wallets vote ──────────────────────────────────
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "── Phase 3: Voting (all 10 wallets in parallel) ──" | tee -a "$LOG_DIR/SUMMARY.log"

phase3_start=$(date +%s)
for wallet in "${WALLETS[@]}"; do
  log="$LOG_DIR/${wallet}-vote.log"
  # shellcheck disable=SC2086
  $CLI agent run "$wallet" $AUTH_FLAG \
    -p "Use list_questions to find questions with solutions you did NOT author. For 5 different questions: list_solutions, evaluate them, and cast_vote allocating your 100 conviction points across the BEST solutions (min 10 per allocation). Skip any question you authored or where you submitted a solution." \
    -v > "$log" 2>&1 &
done
wait
elapsed=$(( $(date +%s) - phase3_start ))
echo "  Phase 3 complete at +${elapsed}s" | tee -a "$LOG_DIR/SUMMARY.log"

# ── Phase 4: Wait for voting deadline + settlement window ──────
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "── Phase 4: Waiting for voting deadline + settlement ──" | tee -a "$LOG_DIR/SUMMARY.log"

now_epoch=$(date +%s)
deadline_epoch=$(date -u -d "$DEADLINE_UTC_ISO" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$DEADLINE_UTC_ISO" +%s)
wait_for=$((deadline_epoch - now_epoch + 60))  # +60s buffer
if [ "$wait_for" -gt 0 ]; then
  echo "  sleeping ${wait_for}s until deadline + 60s buffer ..." | tee -a "$LOG_DIR/SUMMARY.log"
  sleep "$wait_for"
fi

# Give the oracle keeper one settlement tick (River job runs ~30s)
echo "  Waiting 90s for oracle keeper to settle eligible rounds ..." | tee -a "$LOG_DIR/SUMMARY.log"
sleep 90

# ── Phase 5: Final report ──────────────────────────────────────
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "── Phase 5: Final Report ──" | tee -a "$LOG_DIR/SUMMARY.log"

# Per-task statuses
{
  echo ""
  echo "Per-task results:"
  for log in "$LOG_DIR"/*.log; do
    name=$(basename "$log" .log)
    [ "$name" = "SUMMARY" ] && continue
    success=$(grep -cE '"success":\s*true|Done' "$log" 2>/dev/null || echo 0)
    cost=$(grep -oE '"cost_usd":\s*[0-9.]+' "$log" 2>/dev/null | head -1 | awk -F: '{print $2}' | tr -d ' ')
    [ -z "$cost" ] && cost="?"
    flag="✓"; [ "$success" -eq 0 ] && flag="✗"
    printf "  %s  %s  cost=\$%s\n" "$flag" "$name" "$cost"
  done
} | tee -a "$LOG_DIR/SUMMARY.log"

# Final state via backend
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "Backend state:" | tee -a "$LOG_DIR/SUMMARY.log"

PSQL_URL="${TEST_DATABASE_URL:-postgres://rezontree:rezontree@localhost:5432/rezontree?sslmode=disable}"

if command -v psql >/dev/null 2>&1; then
  psql "$PSQL_URL" -t -c "
    SELECT
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '50 minutes') AS total_questions_run,
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '50 minutes' AND confirmation_status = 'confirmed') AS confirmed_questions,
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '50 minutes') AS total_solutions,
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '50 minutes' AND confirmation_status = 'confirmed') AS confirmed_solutions,
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '50 minutes') AS total_votes,
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '50 minutes' AND confirmation_status = 'confirmed') AS confirmed_votes,
      (SELECT COUNT(*) FROM round_results WHERE created_at > NOW() - INTERVAL '50 minutes' AND merkle_root IS NOT NULL) AS settled_rounds
  " 2>&1 | tee -a "$LOG_DIR/SUMMARY.log"
fi

# Wallet outflow vs ingress
echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "Wallet balances post-round:" | tee -a "$LOG_DIR/SUMMARY.log"
$CLI rt status 2>/dev/null | tee -a "$LOG_DIR/SUMMARY.log" || true

echo "" | tee -a "$LOG_DIR/SUMMARY.log"
echo "================================================================" | tee -a "$LOG_DIR/SUMMARY.log"
echo "  Round complete. Detail: $LOG_DIR/" | tee -a "$LOG_DIR/SUMMARY.log"
echo "================================================================" | tee -a "$LOG_DIR/SUMMARY.log"
