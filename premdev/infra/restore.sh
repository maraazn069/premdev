#!/usr/bin/env bash
# ============================================================================
# PremDev Restore — pulls a snapshot from R2 and applies it.
#
# Usage:   premdev-restore <prefix>/<TS>     e.g. daily/20260428-031500
# Or env:  SNAPSHOT=<prefix>/<TS> premdev-restore
#
# DESTRUCTIVE. Stops the app, replaces:
#   1. SQLite at $DATA_DIR/premdev.sqlite           (from sqlite/premdev.sqlite)
#   2. ALL MySQL DBs                                (from mysql/all-databases.sql.gz)
#   3. $DATA_DIR/workspaces/                        (from workspaces.tar.gz)
#
# A *pre-restore* safety snapshot is dumped to /var/backups/premdev-pre-restore-<TS>/
# so a botched restore can still be rolled back manually.
# Pings Telegram on success / failure.
# ============================================================================
set -Eeuo pipefail

# Load env (tolerant — both files may exist)
for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done

DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
INSTALL_DIR="${PREMDEV_INSTALL_DIR:-/opt/premdev}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
RC_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-}"
LOG_FILE="/var/log/premdev-restore.log"
SAFETY_DIR="/var/backups/premdev-pre-restore-$(date +%Y%m%d-%H%M%S)"

SNAPSHOT="${1:-${SNAPSHOT:-}}"
[[ -n "$SNAPSHOT" ]] || { echo "Usage: $0 <prefix>/<TS>  (e.g. daily/20260428-031500)"; exit 2; }
# Strict guard: only allow `daily/<TS>` or `weekly/<TS>` shapes — same as
# the on-disk regex in backup.sh's prune. Refuses path traversal.
if ! [[ "$SNAPSHOT" =~ ^(daily|weekly)/[0-9]{8}-[0-9]{6}/?$ ]]; then
  echo "Refusing: snapshot must match (daily|weekly)/YYYYMMDD-HHMMSS"
  exit 2
fi
SNAPSHOT="${SNAPSHOT%/}"   # strip trailing /
[[ -n "$BUCKET" ]] || { echo "R2_BUCKET not configured — abort"; exit 3; }

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"; }

notify() {
  local level="$1" msg="$2"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] || return 0
  local prefix; case "$level" in error) prefix="🛑 ";; warn) prefix="⚠️ ";; *) prefix="✅ ";; esac
  curl -fsS -o /dev/null -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    --data-urlencode "text=${prefix}${msg}" || true
}

trap 'rc=$?; if [[ $rc -ne 0 ]]; then notify error "Restore *FAILED* — snapshot \`$SNAPSHOT\` (exit $rc). Pre-restore safety dump at \`$SAFETY_DIR\`."; fi; rm -rf "${DL_DIR:-}"' EXIT

WORK_DIR="$(mktemp -d /tmp/premdev-restore-XXXXXX)"
DL_DIR="$WORK_DIR"

log "=== Restore start: snapshot=$SNAPSHOT ==="
notify info "Restore *starting* — snapshot \`$SNAPSHOT\`"

# --- 1. Download snapshot from R2 ---
log "Downloading from r2:${BUCKET}/${SNAPSHOT}/"
rclone copy "${RC_REMOTE}:${BUCKET}/${SNAPSHOT}/" "$DL_DIR/" --progress 2>&1 | tee -a "$LOG_FILE"
[[ -f "$DL_DIR/sqlite/premdev.sqlite" ]] || { log "ERROR: sqlite missing in snapshot"; exit 4; }
[[ -f "$DL_DIR/mysql/all-databases.sql.gz" ]] || { log "ERROR: mysql dump missing"; exit 4; }
[[ -f "$DL_DIR/workspaces.tar.gz" ]] || log "WARN: workspaces.tar.gz missing — skipping that part"

# --- 2. Pre-restore safety dump (so a bad restore is still recoverable) ---
# Resolve SQLite path the same way backup.sh does — primary location is
# $DATA_DIR/sqlite/premdev.sqlite; fall back to legacy ./api/ for old installs.
SQLITE_DST="$DATA_DIR/sqlite/premdev.sqlite"
[[ -f "$SQLITE_DST" || -d "$DATA_DIR/sqlite" ]] || SQLITE_DST="$DATA_DIR/api/premdev.sqlite"
mkdir -p "$(dirname "$SQLITE_DST")"

log "Writing safety snapshot of CURRENT state to $SAFETY_DIR"
mkdir -p "$SAFETY_DIR"
cp -f "$SQLITE_DST" "$SAFETY_DIR/premdev.sqlite" 2>/dev/null || true
# Pass the password via MYSQL_PWD so it never appears on the command line and
# so a `"` inside the password can't break shell quoting. -p"$PASS" was both
# vulnerable and visible in `ps`.
[[ -n "${MYSQL_ROOT_PASSWORD:-}" ]] || { log "ERROR: MYSQL_ROOT_PASSWORD missing — cannot proceed"; exit 5; }
docker compose -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
  mysqldump -uroot --all-databases --single-transaction --quick \
  | gzip > "$SAFETY_DIR/all-databases.sql.gz" 2>>"$LOG_FILE" || log "WARN: safety mysqldump failed"
# Workspaces are huge — only list, don't copy. Operator can rebuild from R2 if needed.
( cd "$DATA_DIR" && find workspaces -maxdepth 2 -type d > "$SAFETY_DIR/workspaces.list" 2>/dev/null || true )
log "Safety dump done: $SAFETY_DIR"

# --- 3. Stop app (do NOT stop mysql — we need it for the import) ---
log "Stopping app container"
docker compose -f "$COMPOSE_FILE" stop app 2>&1 | tee -a "$LOG_FILE"

# --- 4. Restore SQLite ---
# Use install(1) for an atomic clobber with the right ownership in one syscall —
# avoids the "Text file busy" hazard if anything still has the old file open.
log "Restoring SQLite to $SQLITE_DST"
install -m 644 -o 1000 -g 1000 "$DL_DIR/sqlite/premdev.sqlite" "$SQLITE_DST" 2>/dev/null \
  || install -m 644 "$DL_DIR/sqlite/premdev.sqlite" "$SQLITE_DST"

# --- 5. Restore MySQL ---
log "Restoring MySQL (dropping & re-importing all DBs)"
gunzip -c "$DL_DIR/mysql/all-databases.sql.gz" | \
  docker compose -f "$COMPOSE_FILE" exec -T -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql \
    mysql -uroot

# --- 6. Restore workspaces ---
if [[ -f "$DL_DIR/workspaces.tar.gz" ]]; then
  log "Restoring workspaces (this can take a while)"
  # Move old aside, extract new, then rm old. This avoids a window where
  # workspaces/ is partially populated.
  if [[ -d "$DATA_DIR/workspaces" ]]; then
    mv "$DATA_DIR/workspaces" "$DATA_DIR/workspaces.old.$$"
  fi
  mkdir -p "$DATA_DIR/workspaces"
  tar -xzf "$DL_DIR/workspaces.tar.gz" -C "$DATA_DIR/workspaces" 2>&1 | tail -3 | tee -a "$LOG_FILE"
  chown -R 1000:1000 "$DATA_DIR/workspaces" 2>/dev/null || true
  rm -rf "$DATA_DIR/workspaces.old.$$" &
fi

# --- 7. Restart app ---
log "Restarting app"
docker compose -f "$COMPOSE_FILE" up -d app 2>&1 | tee -a "$LOG_FILE"

log "=== Restore complete: snapshot=$SNAPSHOT ==="
notify info "Restore *OK* — snapshot \`$SNAPSHOT\` applied. Safety dump kept at \`$SAFETY_DIR\` (delete when verified)."
