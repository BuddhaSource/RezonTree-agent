#!/bin/bash
# Run a single simulation cycle with specified agents and tasks
# Usage: ./scripts/sim-cycle.sh
set -euo pipefail

CLI="/usr/local/bin/node dist/cli/index.js"
LOG_DIR="logs/sim_loop"
TS=$(date +%Y%m%d_%H%M%S)
mkdir -p "$LOG_DIR"

# Parse arguments: each arg is "agent:prompt:logname"
PIDS=()
NAMES=()

run_agent() {
  local agent="$1"
  local prompt="$2"
  local logname="$3"
  local logfile="$LOG_DIR/${logname}-${TS}.log"

  $CLI agent run "$agent" -p "$prompt" -v > "$logfile" 2>&1 &
  PIDS+=($!)
  NAMES+=("$logname")
  echo "  $logname (PID $!) → $logfile"
}

echo "=== Simulation Cycle $TS ==="

# Activities are passed via env vars
if [ -n "${ASK_AGENT:-}" ] && [ -n "${ASK_PROMPT:-}" ] && [ -n "${ASK_LOG:-}" ]; then
  run_agent "$ASK_AGENT" "$ASK_PROMPT" "$ASK_LOG"
fi

if [ -n "${SOLVE1_AGENT:-}" ] && [ -n "${SOLVE1_PROMPT:-}" ] && [ -n "${SOLVE1_LOG:-}" ]; then
  run_agent "$SOLVE1_AGENT" "$SOLVE1_PROMPT" "$SOLVE1_LOG"
fi

if [ -n "${SOLVE2_AGENT:-}" ] && [ -n "${SOLVE2_PROMPT:-}" ] && [ -n "${SOLVE2_LOG:-}" ]; then
  run_agent "$SOLVE2_AGENT" "$SOLVE2_PROMPT" "$SOLVE2_LOG"
fi

if [ -n "${VOTE1_AGENT:-}" ] && [ -n "${VOTE1_PROMPT:-}" ] && [ -n "${VOTE1_LOG:-}" ]; then
  run_agent "$VOTE1_AGENT" "$VOTE1_PROMPT" "$VOTE1_LOG"
fi

if [ -n "${VOTE2_AGENT:-}" ] && [ -n "${VOTE2_PROMPT:-}" ] && [ -n "${VOTE2_LOG:-}" ]; then
  run_agent "$VOTE2_AGENT" "$VOTE2_PROMPT" "$VOTE2_LOG"
fi

echo ""
echo "Waiting for ${#PIDS[@]} agents..."

FAILED=0
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}" || true
  EXIT=$?
  LOGFILE="$LOG_DIR/${NAMES[$i]}-${TS}.log"
  DONE_LINE=$(grep "Done" "$LOGFILE" 2>/dev/null | tail -1 || echo "(no Done line)")
  if [ $EXIT -ne 0 ]; then
    FAILED=$((FAILED + 1))
    echo "  ${NAMES[$i]}: FAILED (exit $EXIT)"
    tail -3 "$LOGFILE" 2>/dev/null | sed 's/^/    /'
  else
    echo "  ${NAMES[$i]}: $DONE_LINE"
  fi
done

echo ""
echo "=== Platform State ==="
curl -s "http://localhost:8080/v1/problems?status=open" | python3 -c "
import sys, json
data = json.load(sys.stdin)
problems = data.get('data', [])
print(f'Open problems: {len(problems)}')
for p in problems:
    title = p['title'][:58]
    sols = p.get('solution_count', 0)
    votes = p.get('vote_count', 0)
    bounty = p.get('bounty_amount', '?')[:5]
    print(f'  sols={sols} votes={votes} bounty=\${bounty}  {title}')
"

echo ""
echo "Cycle $TS complete. $FAILED failures."
