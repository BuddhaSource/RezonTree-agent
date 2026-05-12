#!/bin/bash
# audit-run.sh — comprehensive snapshot of agent run state.
#
# Captures into one JSON: per-wallet ETH+USDC, escrow totals,
# question/solution counts by status, recent ponder events,
# duplicate-title detection. Used as before/after diff bookends
# around an agent swarm to compute true cost-per-action.
#
# Usage: ./scripts/audit-run.sh <label>
#   ./scripts/audit-run.sh pre-rich-swarm
#   ./scripts/audit-run.sh post-rich-swarm
# Writes audits/<timestamp>-<label>.json

set -euo pipefail
LABEL="${1:?usage: audit-run.sh <label>}"
TS=$(date +%Y%m%d_%H%M%S)
OUT_DIR="$(dirname "$0")/../audits"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${TS}-${LABEL}.json"

cd "$(dirname "$0")/.."

# Source env from the BACKEND directory; DATABASE_URL + RT_AGENT_MNEMONIC live there.
set -a
source "$(pwd)/.env" 2>/dev/null || true
source "$(realpath ../RezonTree/.env)" 2>/dev/null || true
set +a

DATABASE_URL="${DATABASE_URL:?DATABASE_URL not set; source backend .env}"

# Wallet balances (via the tsx helper)
WALLETS_JSON=$(pnpm --silent tsx scripts/print-wallets.ts 2>/dev/null \
  | grep -E "^[ 0-9]+   0x" \
  | awk '{ printf "{\"idx\":%d,\"address\":\"%s\",\"eth\":%s,\"usdc\":%s,\"role\":\"%s\"},", $1, $2, $3, $4, $5 }' \
  | sed 's/,$//' )

# DB stats — questions
QUESTIONS_JSON=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT status, COUNT(*),
       COALESCE(SUM(chain_pool_amount::numeric)/1e6, 0)::numeric(12,4) AS pool_usdc
FROM questions GROUP BY status;
" | awk -F'|' 'BEGIN{ORS=","} { printf "{\"status\":\"%s\",\"count\":%d,\"pool_usdc\":%s}", $1, $2, $3 }' | sed 's/,$//')

# Solutions
SOLUTIONS_JSON=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT confirmation_status, COUNT(*),
       COALESCE(SUM(stake_amount::numeric)/1e6, 0)::numeric(12,4),
       COALESCE(SUM(fee_amount::numeric)/1e6, 0)::numeric(12,4)
FROM solutions GROUP BY confirmation_status;
" | awk -F'|' 'BEGIN{ORS=","} { printf "{\"status\":\"%s\",\"count\":%d,\"stake_usdc\":%s,\"fee_usdc\":%s}", $1, $2, $3, $4 }' | sed 's/,$//')

# Votes (no stake_amount column on votes — it's fee_amount only here)
VOTES_JSON=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT confirmation_status, COUNT(*),
       COALESCE(SUM(fee_amount::numeric)/1e6, 0)::numeric(12,4)
FROM votes GROUP BY confirmation_status;
" | awk -F'|' 'BEGIN{ORS=","} { printf "{\"status\":\"%s\",\"count\":%d,\"fee_usdc\":%s}", $1, $2, $3 }' | sed 's/,$//')

# Contributions
CONTRIB_JSON=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT confirmation_status,
       CASE WHEN refunded_at IS NULL THEN 'unrefunded' ELSE 'refunded' END,
       COUNT(*), COALESCE(SUM(amount::numeric)/1e6, 0)::numeric(12,4)
FROM contributions GROUP BY confirmation_status, refunded_at IS NULL;
" | awk -F'|' 'BEGIN{ORS=","} { printf "{\"status\":\"%s\",\"refund\":\"%s\",\"count\":%d,\"amount_usdc\":%s}", $1, $2, $3, $4 }' | sed 's/,$//')

# Duplicate question titles (suggests agents not reading list_questions)
DUPES_JSON=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT COUNT(*) FROM (
  SELECT title FROM questions GROUP BY title HAVING COUNT(*) > 1
) sq;
")

# Recent reverted solutions — what are agents doing wrong?
REVERTED_REASONS=$(psql "$DATABASE_URL" -At -F'|' -c "
SELECT COALESCE(lifecycle_reason, 'no reason'), COUNT(*)
FROM solutions WHERE confirmation_status='reverted'
  AND created_at > NOW() - INTERVAL '2 hours'
GROUP BY lifecycle_reason ORDER BY 2 DESC LIMIT 5;
" | awk -F'|' 'BEGIN{ORS=","} { printf "{\"reason\":\"%s\",\"count\":%d}", $1, $2 }' | sed 's/,$//')

cat > "$OUT" <<EOF
{
  "timestamp": "$TS",
  "label": "$LABEL",
  "wallets": [$WALLETS_JSON],
  "questions": [$QUESTIONS_JSON],
  "solutions": [$SOLUTIONS_JSON],
  "votes": [$VOTES_JSON],
  "contributions": [$CONTRIB_JSON],
  "duplicate_titles": $DUPES_JSON,
  "reverted_solution_reasons_recent": [$REVERTED_REASONS]
}
EOF

echo "audit written: $OUT"
cat "$OUT" | python3 -m json.tool 2>/dev/null | head -60
