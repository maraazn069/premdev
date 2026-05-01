#!/usr/bin/env bash
# ============================================================================
# PremDev Trigger Runner
# ----------------------------------------------------------------------------
# Lives on the HOST. Runs every minute via /etc/cron.d/premdev-trigger.
# Picks up "trigger files" written by the API container (which is sandboxed
# and can't shell out to docker / mysql / rclone directly), executes the
# requested operation on the host, and writes a result file the API can poll.
#
# The trigger directory is /opt/premdev/data/triggers/ on the host, which is
# bind-mounted into the API container as /var/lib/premdev/triggers/.
#
# Trigger file naming:
#   <action>-<jobId>.json           pending (created by API)
#   <action>-<jobId>.running        being processed (atomic rename so a
#                                    second cron pass won't re-pick it up)
#   <action>-<jobId>.result.json    final outcome (read by API, then
#                                    removed by the cleanup pass)
#
# Supported actions: backup, restore, refresh-index, cleanup
# ============================================================================
set -Eeuo pipefail
TRIG_DIR="${PREMDEV_TRIGGER_DIR:-/opt/premdev/data/triggers}"
INDEX_FILE="${PREMDEV_INDEX_FILE:-/opt/premdev/data/backup_index.json}"
mkdir -p "$TRIG_DIR"

# Single-instance lock so two cron passes don't trample each other (e.g. a
# slow restore that takes >1min).
LOCK="/var/lock/premdev-trigger.lock"
exec 9>"$LOCK" || { echo "could not open lock"; exit 0; }
flock -n 9 || exit 0

# --- Cleanup: remove result files older than 7 days so the trigger dir
#     doesn't accumulate forever ---
find "$TRIG_DIR" -maxdepth 1 -name '*.result.json' -mtime +7 -delete 2>/dev/null || true
# Also clean up orphan .running files from previous crashes (>3h old).
find "$TRIG_DIR" -maxdepth 1 -name '*.running' -mmin +180 -delete 2>/dev/null || true

# --- Pick up pending triggers ---
shopt -s nullglob
for f in "$TRIG_DIR"/*.json; do
  base="$(basename "$f")"
  # Skip results — they're not work, they're output
  [[ "$base" == *.result.json ]] && continue
  # Atomic claim
  running="${f%.json}.running"
  if ! mv "$f" "$running" 2>/dev/null; then continue; fi

  # Parse action from filename: <action>-<jobId>.json
  action="${base%%-*}"
  jobId="${base#*-}"; jobId="${jobId%.json}"
  result="${TRIG_DIR}/${action}-${jobId}.result.json"
  started="$(date +%s)"

  # Read body (JSON with optional `snapshot` field)
  body="$(cat "$running" 2>/dev/null || echo '{}')"
  snapshot="$(echo "$body" | grep -oE '"snapshot"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"

  status="ok"; output=""; exit_code=0
  case "$action" in
    backup)
      if /usr/local/sbin/premdev-backup >/tmp/_pdj.log 2>&1; then
        output="$(tail -c 4000 /tmp/_pdj.log)"
      else
        exit_code=$?
        status="error"
        output="$(tail -c 4000 /tmp/_pdj.log)"
      fi
      # Always refresh the index after a backup attempt.
      /usr/local/sbin/premdev-refresh-index || true
      ;;
    restore)
      if [[ -z "$snapshot" ]]; then
        status="error"; output="missing 'snapshot' field"
      elif /usr/local/sbin/premdev-restore "$snapshot" >/tmp/_pdj.log 2>&1; then
        output="$(tail -c 4000 /tmp/_pdj.log)"
      else
        exit_code=$?
        status="error"
        output="$(tail -c 4000 /tmp/_pdj.log)"
      fi
      ;;
    refresh-index)
      if /usr/local/sbin/premdev-refresh-index >/tmp/_pdj.log 2>&1; then
        output="$(tail -c 2000 /tmp/_pdj.log)"
      else
        exit_code=$?
        status="error"
        output="$(tail -c 2000 /tmp/_pdj.log)"
      fi
      ;;
    cleanup)
      if /usr/local/sbin/premdev-docker-cleanup >/tmp/_pdj.log 2>&1; then
        output="$(tail -c 4000 /tmp/_pdj.log)"
      else
        exit_code=$?
        status="error"
        output="$(tail -c 4000 /tmp/_pdj.log)"
      fi
      ;;
    *)
      status="error"; output="unknown action: $action"; exit_code=99
      ;;
  esac

  finished="$(date +%s)"
  # Emit result file. Pass `output` via env (PD_OUTPUT) instead of argv —
  # output can contain anything (newlines, NULs, leading hyphens, MBs of
  # log data) and stuffing it into argv risks E2BIG, word splitting, or
  # ARG_MAX. Other fields are bounded and safe as argv.
  PD_OUTPUT="$output" python3 - "$result" "$action" "$jobId" "$status" "$exit_code" "$started" "$finished" <<'PY'
import json, os, sys
result, action, jobId, status, code, started, finished = sys.argv[1:]
output = os.environ.get("PD_OUTPUT", "")
with open(result, "w") as f:
    json.dump({
        "action": action, "jobId": jobId, "status": status,
        "exitCode": int(code), "startedAt": int(started),
        "finishedAt": int(finished), "durationSec": int(finished) - int(started),
        "output": output,
    }, f)
PY
  rm -f "$running"
done
