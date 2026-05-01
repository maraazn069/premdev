#!/usr/bin/env bash
# PremDev backup — runs daily from /etc/cron.daily/premdev-backup.
#
# Dumps:
#   1. SQLite (apps/api/data/premdev.sqlite)  — uses VACUUM INTO for hot copy
#   2. MySQL (all DBs)                         — mysqldump via the mysql container
#   3. Workspaces (data/workspaces/)           — tar.gz, can be huge
#
# Uploads to Cloudflare R2 via rclone (configured by install.sh).
# Retention: keep 7 daily + 4 weekly snapshots; older purged automatically.
# Pings Telegram at the end (success or failure).
#
# Required env (sourced from /opt/premdev/.env or /etc/premdev/backup.env):
#   PREMDEV_DATA_DIR (default /opt/premdev/data)
#   R2_BUCKET (required)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID (optional — sends alert on result)

set -euo pipefail

# Load env from common locations
for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done

DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
INSTALL_DIR="${PREMDEV_INSTALL_DIR:-/opt/premdev}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
WORK_DIR="$(mktemp -d /tmp/premdev-backup-XXXXXX)"
TS="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 1..7
LOG_FILE="/var/log/premdev-backup.log"
RC_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-}"

trap 'rm -rf "$WORK_DIR"' EXIT

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"; }

notify() {
  local level="$1"; local msg="$2"
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] && return 0
  local icon="ℹ️"; [[ "$level" == "warn" ]] && icon="⚠️"; [[ "$level" == "error" ]] && icon="🚨"
  curl -sS --max-time 8 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${icon} ${msg}" >/dev/null 2>&1 || true
}

if [[ -z "$BUCKET" ]]; then
  log "ERROR: R2_BUCKET not set — backup disabled. Configure R2 in /opt/premdev/.env then re-run install.sh."
  notify error "PremDev backup *skipped* — R2_BUCKET not configured"
  exit 0
fi

if ! command -v rclone >/dev/null 2>&1; then
  log "ERROR: rclone not installed"
  notify error "PremDev backup *failed* — rclone missing on host"
  exit 1
fi

log "=== Backup start (TS=$TS) ==="

# --- 1. SQLite ---
# Production layout (set by install.sh): SQLITE_PATH=/var/lib/premdev/sqlite/premdev.sqlite
# which maps to $DATA_DIR/sqlite/premdev.sqlite on the host. The legacy "api/"
# path was wrong and silently skipped SQLite from every backup — keep the
# fallback for any pre-Fase-2.2 install so a redeploy doesn't lose data.
SQLITE_SRC="$DATA_DIR/sqlite/premdev.sqlite"
[[ -f "$SQLITE_SRC" ]] || SQLITE_SRC="$DATA_DIR/api/premdev.sqlite"
SQLITE_OUT="$WORK_DIR/premdev-sqlite-${TS}.sqlite"
if [[ -f "$SQLITE_SRC" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    log "Dumping SQLite via VACUUM INTO"
    sqlite3 "$SQLITE_SRC" "VACUUM INTO '$SQLITE_OUT'" 2>&1 | tee -a "$LOG_FILE"
  else
    # Fallback for hosts without the sqlite3 CLI (older installs).
    # The auth DB is small and uses WAL mode — flush WAL into the main file
    # via a checkpoint then copy. We do this from inside the API container,
    # which already has better-sqlite3 in node_modules.
    log "sqlite3 CLI missing on host; falling back to WAL checkpoint + cp"
    if docker compose -f "$COMPOSE_FILE" ps app 2>/dev/null | grep -q "Up"; then
      docker compose -f "$COMPOSE_FILE" exec -T app node -e "
        const Database = require('better-sqlite3');
        const db = new Database(process.env.SQLITE_PATH || '/var/lib/premdev/sqlite/premdev.sqlite');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      " 2>&1 | tee -a "$LOG_FILE" || log "WARN: WAL checkpoint failed (non-fatal)"
    fi
    cp "$SQLITE_SRC" "$SQLITE_OUT"
  fi
  gzip -9 "$SQLITE_OUT"
  log "  -> $(ls -lh "${SQLITE_OUT}.gz" | awk '{print $5}')"
else
  log "WARN: SQLite not found at $SQLITE_SRC"
fi

# --- 2. MySQL (all DBs) ---
MYSQL_OUT="$WORK_DIR/premdev-mysql-${TS}.sql"
if [[ -f "$COMPOSE_FILE" ]] && docker compose -f "$COMPOSE_FILE" ps mysql 2>/dev/null | grep -q "Up"; then
  log "Dumping MySQL"
  if [[ -n "${MYSQL_ROOT_PASSWORD:-}" ]]; then
    docker compose -f "$COMPOSE_FILE" exec -T mysql \
      mysqldump --all-databases --single-transaction --quick --routines --triggers \
      -uroot -p"$MYSQL_ROOT_PASSWORD" 2>/dev/null > "$MYSQL_OUT" || log "WARN: mysqldump failed"
    if [[ -s "$MYSQL_OUT" ]]; then
      gzip -9 "$MYSQL_OUT"
      log "  -> $(ls -lh "${MYSQL_OUT}.gz" | awk '{print $5}')"
    fi
  else
    log "WARN: MYSQL_ROOT_PASSWORD not in env — skipping MySQL dump"
  fi
else
  log "MySQL container not running — skipping"
fi

# --- 3. Workspaces tarball ---
WS_DIR="$DATA_DIR/workspaces"
WS_OUT="$WORK_DIR/premdev-workspaces-${TS}.tar.gz"
if [[ -d "$WS_DIR" ]]; then
  log "Tarring workspaces (this may take a while)"
  # Exclude common heavy + regenerable directories to keep backups small.
  tar --exclude='node_modules' \
      --exclude='.venv' \
      --exclude='__pycache__' \
      --exclude='.cache' \
      --exclude='dist' \
      --exclude='build' \
      --exclude='target' \
      -czf "$WS_OUT" -C "$(dirname "$WS_DIR")" "$(basename "$WS_DIR")" 2>>"$LOG_FILE" || log "WARN: tar reported errors"
  log "  -> $(ls -lh "$WS_OUT" | awk '{print $5}')"
fi

# --- 4. Upload to R2 ---
DAILY_PATH="${RC_REMOTE}:${BUCKET}/daily/${TS}"
log "Uploading to ${DAILY_PATH}"
if rclone copy --transfers 2 --checkers 2 "$WORK_DIR/" "$DAILY_PATH/" 2>&1 | tee -a "$LOG_FILE"; then
  log "Upload OK"
else
  log "ERROR: rclone upload failed"
  notify error "PremDev backup *upload failed* — see /var/log/premdev-backup.log"
  exit 1
fi

# Promote to weekly snapshot on Sundays (DOW=7) — server-side copy, no re-upload.
if [[ "$DOW" == "7" ]]; then
  WEEKLY_PATH="${RC_REMOTE}:${BUCKET}/weekly/${TS}"
  log "Sunday → promoting to weekly snapshot ${WEEKLY_PATH}"
  rclone copy "$DAILY_PATH/" "$WEEKLY_PATH/" 2>&1 | tee -a "$LOG_FILE" || true
fi

# --- 5. Retention: 7 daily, 4 weekly ---
# IMPORTANT: list once and reuse the same snapshot for both keep & purge
# decisions. If `rclone lsf` fails or returns empty, we abort *without*
# purging anything — losing one cycle's pruning beats catastrophic data loss.
prune() {
  local prefix="$1"; local keep="$2"
  local listing
  if ! listing="$(rclone lsf --dirs-only "${RC_REMOTE}:${BUCKET}/${prefix}/" 2>>"$LOG_FILE")"; then
    log "WARN: rclone lsf failed for ${prefix}/ — skipping prune (no data deleted)"
    return 0
  fi
  if [[ -z "$listing" ]]; then
    log "  (no ${prefix} snapshots yet — nothing to prune)"
    return 0
  fi
  local keep_list
  keep_list="$(echo "$listing" | sort -r | head -n "$keep")"
  if [[ -z "$keep_list" ]]; then
    log "WARN: empty keep_list for ${prefix}/ — skipping prune"
    return 0
  fi
  echo "$listing" | while read -r d; do
    # Defence-in-depth: refuse anything that doesn't look like our TS dirs
    # (YYYYMMDD-HHMMSS/) so a bad listing can never wipe the bucket root.
    if ! echo "$d" | grep -qE '^[0-9]{8}-[0-9]{6}/?$'; then continue; fi
    if ! echo "$keep_list" | grep -qx "$d"; then
      log "Pruning ${prefix}/${d}"
      rclone purge "${RC_REMOTE}:${BUCKET}/${prefix}/${d}" 2>&1 | tee -a "$LOG_FILE" || true
    fi
  done
}
log "Retention: keeping last 7 daily, 4 weekly snapshots"
prune daily 7
prune weekly 4

TOTAL="$(du -sh "$WORK_DIR" | awk '{print $1}')"
log "=== Backup complete ($TOTAL uploaded) ==="

# Refresh the index so the /admin Backup tab and `premdev-bot /backup` reflect
# the new snapshot immediately. Best-effort — never let a refresh failure
# mask a successful backup.
if [[ -x /usr/local/sbin/premdev-refresh-index ]]; then
  /usr/local/sbin/premdev-refresh-index 2>>"$LOG_FILE" || log "WARN: index refresh failed"
fi

notify info "PremDev backup OK — *${TS}* (${TOTAL})"
