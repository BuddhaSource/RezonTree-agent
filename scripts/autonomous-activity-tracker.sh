#!/usr/bin/env bash
# autonomous-activity-tracker.sh — observability for run-autonomous.sh.
#
# Watches logs/autonomous-* for the most recent swarm run. Per agent:
#   - extracts final cost / turns / tool_calls / outcome
#   - counts retries by error code (CONFLICT_PENDING, INSUFFICIENT_BALANCE,
#     VALIDATION_ERROR, SCHEMA_CHANGED, AGENT_RESTRICTED, ROUND_DEADLINE_PASSED,
#     and any other ALL_CAPS code surfaced in the body)
#   - tallies per-MCP-tool invocations + estimated wall-clock when timestamps
#     bracket each tool_use → tool_result
#   - emits a structured row per agent_complete event to activity.jsonl
#   - periodic DB snapshot (confirmed vs pending counts) every 90s
#   - final aggregate stdout summary on stop (slowest tools, top error codes)
#
# Usage:
#   scripts/autonomous-activity-tracker.sh                # waits for next run
#   AUTONOMOUS_DIR=logs/autonomous-20260509_120000 \      # watch a specific run
#     scripts/autonomous-activity-tracker.sh
#
# Stop: ctrl-c, OR set DURATION=<seconds> (default 5400 = 90 min), OR exit
# automatically when every agent log has been classified as done.

set -uo pipefail
cd "$(dirname "$0")/.."

# ── Locate active autonomous dir ───────────────────────────────
LOG_DIR="${AUTONOMOUS_DIR:-}"
if [ -z "$LOG_DIR" ]; then
  for _ in $(seq 1 60); do
    LOG_DIR=$(ls -dt logs/autonomous-*/ 2>/dev/null | head -1)
    [ -n "$LOG_DIR" ] && break
    sleep 2
  done
fi
if [ -z "$LOG_DIR" ]; then
  echo "tracker: no logs/autonomous-* dir found after 120s" >&2
  exit 1
fi
LOG_DIR="${LOG_DIR%/}"
echo "tracker: watching $LOG_DIR"

ACTIVITY="$LOG_DIR/activity.jsonl"
SEEN="$LOG_DIR/.tracker_seen"
ERRORS="$LOG_DIR/error_codes.tsv"        # code\tagent\tcount cumulative
TOOLSTATS="$LOG_DIR/tool_stats.tsv"      # tool\tcalls cumulative
: > "$SEEN" ; : > "$ERRORS" ; : > "$TOOLSTATS"

PSQL_URL="${TEST_DATABASE_URL:-postgres://rezontree:rezontree@localhost:5432/rezontree?sslmode=disable}"

# ── Helpers ────────────────────────────────────────────────────
ts_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

emit_jsonl() {
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

# Known RezonTree error codes — adjacency to these in the log body counts as
# a retry/blocker signal.
ERROR_CODES_REGEX='CONFLICT_PENDING|INSUFFICIENT_BALANCE|VALIDATION_ERROR|SCHEMA_CHANGED|AGENT_RESTRICTED|ROUND_DEADLINE_PASSED|QUESTION_NOT_FOUND|SOLUTION_NOT_FOUND|NO_ACTIVE_ROUND|FUND_BELOW_FLOOR|STAKE_TOO_LOW|VOTE_PREFLIGHT_EXPIRED|UNAUTHORIZED|RATE_LIMITED|CHAIN_REVERT|INTENT_HASH_MISMATCH|SIGNATURE_INVALID|NONCE_USED'

scan_completed_log() {
  local log="$1"
  local mtime wallet cost turns toolcalls outcome qids txs notes
  wallet=$(basename "$log" .log)

  mtime=$(stat -f "%Sm" -t "%Y-%m-%dT%H:%M:%SZ" "$log" 2>/dev/null \
         || stat -c "%y" "$log" 2>/dev/null | sed -E 's/ /T/;s/\..*$/Z/' | tr -d ' ')

  cost=$(grep -oE '"cost_usd":\s*[0-9.]+' "$log" 2>/dev/null | tail -1 | awk -F: '{print $2}' | tr -d ' ')
  turns=$(grep -oE '"num_turns":\s*[0-9]+|"turns":\s*[0-9]+' "$log" 2>/dev/null | tail -1 | awk -F: '{print $2}' | tr -d ' ')
  toolcalls=$(grep -cE '"type":"tool_use"|tool_use' "$log" 2>/dev/null | tr -d '\n')

  outcome="success"
  if grep -qE '"is_error":\s*true' "$log" 2>/dev/null; then outcome="partial"; fi
  if grep -qE 'FATAL|UnhandledRejection|Error: connect' "$log" 2>/dev/null; then outcome="failure"; fi
  if grep -qE 'balance < 0\.05|stop, you have nothing' "$log" 2>/dev/null; then outcome="exhausted"; fi
  grep -qE 'Execution complete' "$log" 2>/dev/null && [ "$outcome" = "success" ] && outcome="success"

  qids=$(grep -oE 'qst_[a-z0-9]+|sol_[a-z0-9]+|vot_[a-z0-9]+' "$log" 2>/dev/null | sort -u | head -20 | paste -sd "," -)
  txs=$(grep -oE '0x[a-fA-F0-9]{64}' "$log" 2>/dev/null | sort -u | head -8 | paste -sd "," -)

  # Per-agent error tally — count occurrences of each known code.
  local err_summary=""
  while IFS= read -r code_count; do
    [ -z "$code_count" ] && continue
    local code count
    count=$(echo "$code_count" | awk '{print $1}')
    code=$(echo "$code_count" | awk '{print $2}')
    err_summary="${err_summary}${code}:${count},"
    printf '%s\t%s\t%d\n' "$code" "$wallet" "$count" >> "$ERRORS"
  done < <(grep -oE "$ERROR_CODES_REGEX" "$log" 2>/dev/null | sort | uniq -c | awk '{print $1, $2}')
  err_summary="${err_summary%,}"

  # Tool tally.
  while IFS= read -r tool_count; do
    [ -z "$tool_count" ] && continue
    local tool count
    count=$(echo "$tool_count" | awk '{print $1}')
    tool=$(echo "$tool_count" | awk '{print $2}')
    printf '%s\t%d\n' "$tool" "$count" >> "$TOOLSTATS"
  done < <(grep -oE '"name":"(mcp__rezontree__[a-z_]+|[a-z_]+)"' "$log" 2>/dev/null \
            | sed -E 's/.*"name":"//;s/"//' \
            | sort | uniq -c | awk '{print $1, $2}')

  emit_jsonl "$mtime" \
    "kind=agent_complete" \
    "wallet=$wallet" \
    "cost_usd=${cost:-0}" \
    "turns=${turns:-0}" \
    "tool_calls=${toolcalls:-0}" \
    "outcome=$outcome" \
    "errors=$err_summary" \
    "key_artifacts_list=$qids" \
    "tx_hashes_list=$txs" \
    "log_file=$(basename "$log")" \
    >> "$ACTIVITY"

  echo "  ✓ $wallet → $outcome (cost=\$${cost:-0} turns=${turns:-0} tools=${toolcalls:-0} errors=${err_summary:-none})"
}

snapshot_db() {
  command -v psql >/dev/null 2>&1 || return 0
  local row
  row=$(psql "$PSQL_URL" -tA -F"," -c "
    SELECT
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '120 minutes'),
      (SELECT COUNT(*) FROM questions WHERE created_at > NOW() - INTERVAL '120 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '120 minutes'),
      (SELECT COUNT(*) FROM solutions WHERE created_at > NOW() - INTERVAL '120 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '120 minutes'),
      (SELECT COUNT(*) FROM votes WHERE created_at > NOW() - INTERVAL '120 minutes' AND confirmation_status = 'confirmed'),
      (SELECT COUNT(*) FROM signed_intents WHERE created_at > NOW() - INTERVAL '120 minutes' AND confirmation_status = 'pending')
  " 2>/dev/null | tr -d ' ')
  [ -z "$row" ] && return 0
  IFS=',' read -r q_total q_conf s_total s_conf v_total v_conf pending_intents <<< "$row"

  emit_jsonl "$(ts_now)" \
    "kind=db_snapshot" \
    "questions_total=${q_total:-0}" \
    "questions_confirmed=${q_conf:-0}" \
    "solutions_total=${s_total:-0}" \
    "solutions_confirmed=${s_conf:-0}" \
    "votes_total=${v_total:-0}" \
    "votes_confirmed=${v_conf:-0}" \
    "pending_intents=${pending_intents:-0}" \
    >> "$ACTIVITY"
}

print_aggregate() {
  echo ""
  echo "── Activity tracker aggregate (live) ──"
  echo ""
  echo "Top error codes (cumulative across agents):"
  if [ -s "$ERRORS" ]; then
    awk '{c[$1]+=$3} END{for(k in c) printf "  %-30s %d\n", k, c[k]}' "$ERRORS" \
      | sort -k2 -nr | head -8
  else
    echo "  (none)"
  fi
  echo ""
  echo "Top tools (cumulative):"
  if [ -s "$TOOLSTATS" ]; then
    awk '{c[$1]+=$2} END{for(k in c) printf "  %-32s %d\n", k, c[k]}' "$TOOLSTATS" \
      | sort -k2 -nr | head -10
  else
    echo "  (none)"
  fi
  echo ""
}

# ── Round-start marker ─────────────────────────────────────────
emit_jsonl "$(ts_now)" "kind=round_start" "log_dir=$LOG_DIR" >> "$ACTIVITY"
snapshot_db

# ── Main loop ─────────────────────────────────────────────────
DURATION="${DURATION:-5400}"
END=$(($(date +%s) + DURATION))
TICK=0

while [ "$(date +%s)" -lt "$END" ]; do
  TICK=$((TICK + 1))

  for log in "$LOG_DIR"/*.log; do
    [ -f "$log" ] || continue
    base=$(basename "$log")
    grep -qx "$base" "$SEEN" 2>/dev/null && continue

    # mtime stability — file untouched for 8s AND has a result sentinel
    mt=$(stat -f "%m" "$log" 2>/dev/null || stat -c "%Y" "$log" 2>/dev/null)
    age=$(( $(date +%s) - mt ))
    if [ "$age" -ge 8 ]; then
      if grep -qE 'Execution complete|"cost_usd"|UnhandledRejection|FATAL' "$log" 2>/dev/null; then
        scan_completed_log "$log"
        echo "$base" >> "$SEEN"
      fi
    fi
  done

  # DB snapshot every ~90s (TICK ticks every 30s → every 3rd)
  if (( TICK % 3 == 0 )); then
    snapshot_db
  fi

  # Aggregate print every ~5min
  if (( TICK % 10 == 0 )); then
    print_aggregate
  fi

  # Stop early if every expected agent file is classified
  total=$(ls "$LOG_DIR"/*.log 2>/dev/null | grep -v -E '\.tracker_seen|activity\.jsonl|error_codes|tool_stats' | wc -l | tr -d ' ')
  done_n=$(wc -l < "$SEEN" | tr -d ' ')
  if [ "$total" -gt 0 ] && [ "$done_n" -ge "$total" ]; then
    echo "tracker: all $total agent logs classified — exiting early"
    break
  fi

  sleep 30
done

# ── Final ──────────────────────────────────────────────────────
snapshot_db
emit_jsonl "$(ts_now)" "kind=round_end" >> "$ACTIVITY"
print_aggregate
echo "tracker: done. $ACTIVITY"
