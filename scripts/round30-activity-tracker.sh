#!/usr/bin/env bash
# round30-activity-tracker.sh — non-invasive observability for run-round-30.sh.
#
# Watches the round30-* log directory for completed agent tasks. For each
# completed task, extracts a structured activity row and appends it to
# activity.jsonl. Also snapshots wallet balances + DB counts on a timer.
#
# Goal: enable post-round analysis of WHY agents were focused or drifted —
# correlate prompt shape, turns used, tool calls, cost, and outcomes.
#
# Schema per row (activity.jsonl):
#   ts            UTC ISO-8601
#   kind          agent_complete | balance_snapshot | db_snapshot | round_start | round_end
#   wallet        e.g. solver-04 (agent_complete only)
#   phase         create | solve | vote | claim (agent_complete only)
#   title         first 100 chars of the prompt
#   duration_s    wall-clock from start to completion
#   turns         turns consumed
#   tool_calls    count of tool invocations
#   cost_usd      OAuth/API cost
#   outcome       success | partial | failure | timeout
#   key_artifacts list of qst_/sol_/vot_ ids touched
#   tx_hashes     on-chain hashes seen
#   notes         free-text annotations (errors, retries)
#
# Runs until the round directory's MARKER_DONE file exists (written by
# run-round-30.sh on completion) OR until --duration seconds elapse.

set -uo pipefail
cd "$(dirname "$0")/.."

# ── Locate active round dir ────────────────────────────────────
ROUND_DIR=""
for _ in $(seq 1 30); do
  ROUND_DIR=$(ls -dt logs/round30-*/ 2>/dev/null | head -1)
  [ -n "$ROUND_DIR" ] && break
  sleep 2
done
if [ -z "$ROUND_DIR" ]; then
  echo "ERROR: no round30-* dir found after 60s" >&2
  exit 1
fi
ROUND_DIR="${ROUND_DIR%/}"
echo "tracker: watching $ROUND_DIR"

ACTIVITY="$ROUND_DIR/activity.jsonl"
SEEN="$ROUND_DIR/.tracker_seen"
: > "$SEEN"
mkdir -p "$ROUND_DIR"

PSQL_URL="${TEST_DATABASE_URL:-postgres://rezontree:rezontree@localhost:5432/rezontree?sslmode=disable}"

# ── Helpers ────────────────────────────────────────────────────
ts_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

emit_jsonl() {
  # Compact-emit one JSON object — args are key=value pairs (string scalars).
  # Special: keys ending with _list are joined into JSON arrays from a comma list.
  python3 -c '
import json, sys
out = {"ts": sys.argv[1]}
for kv in sys.argv[2:]:
  if "=" not in kv: continue
  k, v = kv.split("=", 1)
  if k.endswith("_list"):
    arr = [x for x in v.split(",") if x]
    out[k[:-5]] = arr
  elif v == "":
    continue
  else:
    try:
      out[k] = json.loads(v)
    except Exception:
      out[k] = v
print(json.dumps(out, ensure_ascii=False))
' "$@"
}

infer_phase() {
  # Map filename to phase (create|solve|vote)
  case "$1" in
    *q[0-9][0-9]-*-create.log) echo "create" ;;
    *-solve.log) echo "solve" ;;
    *-vote.log) echo "vote" ;;
    *-claim.log) echo "claim" ;;
    *) echo "unknown" ;;
  esac
}

infer_wallet() {
  # Extract wallet name (questioner-NN | solver-NN) from filename.
  base=$(basename "$1")
  # strip leading qNN- if present
  base="${base#q[0-9][0-9]-}"
  # take the agent prefix up to -create/-solve/-vote/-claim
  echo "${base%-create.log}" | sed -E 's/-(solve|vote|claim)\.log$//'
}

extract_field() {
  # extract_field <log> <regex> — first capture group
  grep -oE "$2" "$1" 2>/dev/null | head -1 | awk -F'[: ]+' '{print $NF}' | tr -d '",'
}

extract_first_prompt() {
  # The agentkit verbose log echoes the prompt early. Grab a 100-char excerpt.
  grep -m1 -E "prompt:" "$1" 2>/dev/null | head -1 | sed -E 's/.*prompt: *//;s/^"//;s/"$//' | cut -c1-100
}

scan_completed_log() {
  local log="$1"
  local mtime
  mtime=$(stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%SZ" "$log" 2>/dev/null \
         || stat -c "%y" "$log" 2>/dev/null | sed -E 's/ /T/;s/\..*$/Z/' | tr -d ' ')

  local wallet phase title cost turns toolcalls outcome qids txs durations
  wallet=$(infer_wallet "$log")
  phase=$(infer_phase "$log")
  title=$(extract_first_prompt "$log")
  cost=$(grep -oE '"cost_usd":\s*[0-9.]+' "$log" 2>/dev/null | head -1 | awk -F: '{print $2}' | tr -d ' ' | head -c 10)
  turns=$(grep -oE '"num_turns":\s*[0-9]+|"turns":\s*[0-9]+' "$log" 2>/dev/null | head -1 | awk -F: '{print $2}' | tr -d ' ')
  toolcalls=$(grep -cE 'tool_use|"name":' "$log" 2>/dev/null || echo 0)
  outcome="success"
  grep -qE '"is_error":\s*true|FAILED|Error:|exception' "$log" 2>/dev/null && outcome="failure"
  grep -qE '"success":\s*true|"is_error":\s*false' "$log" 2>/dev/null && outcome="success"
  qids=$(grep -oE 'qst_[a-z0-9]+|sol_[a-z0-9]+|vot_[a-z0-9]+' "$log" 2>/dev/null | sort -u | head -8 | paste -sd "," -)
  txs=$(grep -oE '0x[a-fA-F0-9]{64}' "$log" 2>/dev/null | sort -u | head -4 | paste -sd "," -)

  emit_jsonl "$mtime" \
    "kind=agent_complete" \
    "wallet=$wallet" \
    "phase=$phase" \
    "title=$title" \
    "log_file=$(basename "$log")" \
    "cost_usd=$cost" \
    "turns=$turns" \
    "tool_calls=$toolcalls" \
    "outcome=$outcome" \
    "key_artifacts_list=$qids" \
    "tx_hashes_list=$txs" \
    >> "$ACTIVITY"
}

snapshot_db() {
  command -v psql >/dev/null 2>&1 || return 0
  local row
  row=$(psql "$PSQL_URL" -tA -F"," -c "
    SELECT
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '60 minutes'),
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '60 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '60 minutes'),
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '60 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '60 minutes'),
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '60 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM round_results WHERE created_at > NOW() - INTERVAL '60 minutes' AND merkle_root IS NOT NULL)
  " 2>/dev/null | tr -d ' ')
  IFS=',' read -r q_total q_conf s_total s_conf v_total v_conf settled <<< "$row"

  emit_jsonl "$(ts_now)" \
    "kind=db_snapshot" \
    "questions_total=${q_total:-0}" \
    "questions_confirmed=${q_conf:-0}" \
    "solutions_total=${s_total:-0}" \
    "solutions_confirmed=${s_conf:-0}" \
    "votes_total=${v_total:-0}" \
    "votes_confirmed=${v_conf:-0}" \
    "rounds_settled=${settled:-0}" \
    >> "$ACTIVITY"
}

snapshot_balances() {
  # Pulls 10-wallet USDC balances via `rt status`. Slow (~10s, reads chain).
  local out
  out=$(pnpm --silent start rt status 2>/dev/null | grep -E "^(questioner|solver)-" || true)
  [ -z "$out" ] && return 0
  while IFS= read -r line; do
    local wallet usdc eth
    wallet=$(echo "$line" | awk '{print $1}')
    usdc=$(echo "$line" | grep -oE 'USDC=\s*[0-9.]+' | awk -F= '{print $2}' | tr -d ' ')
    eth=$(echo "$line" | grep -oE 'ETH=\s*[0-9.]+' | awk -F= '{print $2}' | tr -d ' ')
    emit_jsonl "$(ts_now)" \
      "kind=balance_snapshot" \
      "wallet=$wallet" \
      "usdc=${usdc:-0}" \
      "eth=${eth:-0}" \
      >> "$ACTIVITY"
  done <<< "$out"
}

# ── Round-start marker ─────────────────────────────────────────
emit_jsonl "$(ts_now)" \
  "kind=round_start" \
  "round_dir=$ROUND_DIR" \
  >> "$ACTIVITY"

# ── Initial snapshot ──────────────────────────────────────────
snapshot_balances
snapshot_db

# ── Main loop ─────────────────────────────────────────────────
TICK=0
DURATION="${DURATION:-2700}"  # default 45 min
END=$(($(date +%s) + DURATION))

while [ "$(date +%s)" -lt "$END" ]; do
  TICK=$((TICK + 1))

  # Detect agent log files that have been newly stable (no growth in 5s)
  for log in "$ROUND_DIR"/*.log; do
    [ -f "$log" ] || continue
    base=$(basename "$log")
    [ "$base" = "SUMMARY.log" ] && continue
    grep -qx "$base" "$SEEN" 2>/dev/null && continue

    # mtime stability check — file hasn't been touched in 5s
    mt=$(stat -f "%m" "$log" 2>/dev/null || stat -c "%Y" "$log" 2>/dev/null)
    age=$(( $(date +%s) - mt ))
    if [ "$age" -ge 5 ]; then
      # require a result-shaped sentinel before declaring done
      if grep -qE '"cost_usd"|"is_error"|"num_turns"|FAILED|Done' "$log" 2>/dev/null; then
        scan_completed_log "$log"
        echo "$base" >> "$SEEN"
      fi
    fi
  done

  # Every 4th tick (~2 min): DB snapshot
  if (( TICK % 4 == 0 )); then
    snapshot_db
  fi

  # Every 10th tick (~5 min): balance snapshot (slow)
  if (( TICK % 10 == 0 )); then
    snapshot_balances &
  fi

  # Exit if SUMMARY shows round complete
  if grep -q "Round complete" "$ROUND_DIR/SUMMARY.log" 2>/dev/null; then
    break
  fi

  sleep 30
done

# ── Final snapshots ───────────────────────────────────────────
snapshot_db
wait
snapshot_balances
emit_jsonl "$(ts_now)" \
  "kind=round_end" \
  >> "$ACTIVITY"

echo "tracker: done. activity.jsonl at $ACTIVITY"
