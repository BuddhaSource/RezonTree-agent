#!/bin/bash
# diagnostic-single-question.sh — drive ONE question through the full
# settle chain and watch DB projections. Cheaper than a swarm
# (~3 Claude calls), but captures the same projection-gap signal.
#
# Flow:
#   1. Launch ONE questioner agent → posts a $1 bounty 5min-deadline
#      question. Wait for completion. Parse question_id from log.
#   2. Launch ONE solver agent (different wallet) in background → posts
#      one solution.
#   3. Launch ONE voter agent (third wallet) in background → casts one
#      vote.
#   4. Run scripts/diagnose-settle.sh against the question_id in
#      foreground — the user sees projection state in real time.
#
# Env: RT_AGENT_MNEMONIC, RT_AGENT_BACKEND_URL (default localhost:8080).

set -euo pipefail

: "${RT_AGENT_MNEMONIC:?RT_AGENT_MNEMONIC not set. Source .env first.}"
: "${RT_AGENT_BACKEND_URL:=http://localhost:8080}"
AGENT_AUTH="${AGENT_AUTH:-oauth}"
AUTH_FLAG=""
[ -n "$AGENT_AUTH" ] && AUTH_FLAG="--auth $AGENT_AUTH"

CLI="pnpm --silent start"
LOG_DIR="logs/diag-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOG_DIR"

DIAG_SCRIPT="${DIAG_SCRIPT:-/Volumes/Data/projects/rezontree/RezonTree/scripts/diagnose-settle.sh}"

# Single question with short deadline so the settle chain fires inside
# this run window. ScheduleSettle wiring (#628) enqueues at NOW + 120s
# (RoundDuration) + 30s (SETTLE_REORG_BUFFER) = ~2.5min post solution.
QUESTIONER_PROMPT='You are a diagnostic agent. Post EXACTLY ONE question with these parameters:

  - title: "Diagnostic probe: which projection columns populate end-to-end?"
  - bounty: $1.00 USDC
  - voting_deadline: 6 minutes from now (use Date.now() + 6*60*1000)
  - 1-2 success criteria, brief
  - 1 falsifiable claim

Flow:
  1. cold_start.
  2. me — verify USDC ≥ $1.20.
  3. post_question — call with the parameters above.
  4. Verify: rezontree_questions_get_question returns status=open with chain_pool_amount > 0.
  5. Output the question_id on the FINAL line in the exact format: QID=qst_xxxxxxxxxxxxxxxxxxxx

Stop after step 5. Do NOT solve or vote — different agents handle those.'

SOLVER_PROMPT_TEMPLATE='You are a diagnostic solver. Submit ONE solution to question QID_PLACEHOLDER.

Flow:
  1. cold_start.
  2. me — verify USDC ≥ $0.20.
  3. rezontree_questions_get_question for QID_PLACEHOLDER — read criteria.
  4. craft_solution (methodology) — minimal viable scaffold.
  5. submit_solution — body 1000-2000 chars, 6-8 because/therefore steps, address each criterion with falsifiable_by.

After completion: verify the solution lands by calling rezontree_solutions_list_solutions for QID_PLACEHOLDER.'

VOTER_PROMPT_TEMPLATE='You are a diagnostic voter. Cast ONE vote on question QID_PLACEHOLDER.

Flow:
  1. cold_start.
  2. me — verify USDC ≥ $0.20.
  3. rezontree_solutions_list_solutions for QID_PLACEHOLDER — wait until at least 1 confirmed solution appears (poll every 15s for up to 3 minutes).
  4. craft_vote (methodology).
  5. cast_vote allocating 100 conviction points to the single available solution (no self-vote check applies since you did not solve).

After completion: verify with rezontree_votes_list_votes for QID_PLACEHOLDER.'

cd /Volumes/Data/projects/rezontree/RezonTree-agent

echo "=== diagnostic single-question run ==="
echo "logs: $LOG_DIR"
echo

# === STEP 1: questioner (foreground, must complete to get QID) ===
echo "[step 1/4] gen-questioner-01 launching (foreground)..."
qfile="$LOG_DIR/gen-questioner-01.log"
$CLI agent run "gen-questioner-01" $AUTH_FLAG -p "$QUESTIONER_PROMPT" -v > "$qfile" 2>&1 || {
    echo "questioner failed — see $qfile"
    tail -20 "$qfile"
    exit 1
}

# Parse QID from log
QID=$(grep -oE 'qst_[a-z0-9]{20}' "$qfile" | tail -1)
if [ -z "$QID" ]; then
    echo "FATAL: could not parse QID from questioner log"
    tail -20 "$qfile"
    exit 1
fi
echo "  → question_id: $QID"

# === STEP 2: solver (background, doesn't block) ===
echo "[step 2/4] gen-solver-04 launching (background)..."
sfile="$LOG_DIR/gen-solver-04.log"
sprompt="${SOLVER_PROMPT_TEMPLATE//QID_PLACEHOLDER/$QID}"
$CLI agent run "gen-solver-04" $AUTH_FLAG -p "$sprompt" -v > "$sfile" 2>&1 &
solver_pid=$!
echo "  → solver PID: $solver_pid"

# === STEP 3: voter (background, doesn't block) ===
echo "[step 3/4] voter launching (background, polls for solution)..."
vfile="$LOG_DIR/voter.log"
vprompt="${VOTER_PROMPT_TEMPLATE//QID_PLACEHOLDER/$QID}"
$CLI agent run "voter" $AUTH_FLAG -p "$vprompt" -v > "$vfile" 2>&1 &
voter_pid=$!
echo "  → voter PID: $voter_pid"

echo
echo "[step 4/4] diagnostic monitor (foreground) — watching $QID until settle/abandon..."
echo

# === STEP 4: foreground diagnostic — user sees this live ===
INTERVAL=15 MAX_ITERS=40 "$DIAG_SCRIPT" "$QID"

echo
echo "=== agent logs ==="
echo "  questioner: $qfile"
echo "  solver:     $sfile"
echo "  voter:      $vfile"
echo
echo "=== final tails ==="
for f in "$qfile" "$sfile" "$vfile"; do
    echo "--- $(basename "$f") last 5 lines ---"
    tail -5 "$f"
done

# Reap any still-running agents
wait $solver_pid 2>/dev/null || true
wait $voter_pid 2>/dev/null || true
