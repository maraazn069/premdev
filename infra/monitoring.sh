#!/usr/bin/env bash
# PremDev monitoring — runs hourly from /etc/cron.hourly/premdev-monitor.
#
# Checks:
#   - Disk usage on /opt/premdev (warn ≥80%, alert ≥90%)
#   - SSL cert expiry on PRIMARY_DOMAIN (warn ≤14d, alert ≤7d)
#   - API health: hits https://app.<domain>/api/health
#   - All compose services are "Up"
#
# Sends Telegram alerts when thresholds cross. Dedupes by writing a state
# file so the same alert isn't spammed every hour — a fresh alert fires
# again once the underlying state changes or 24h passes.

set -euo pipefail

for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done

INSTALL_DIR="${PREMDEV_INSTALL_DIR:-/opt/premdev}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
STATE_DIR="/var/lib/premdev-monitor"
LOG_FILE="/var/log/premdev-monitor.log"
mkdir -p "$STATE_DIR"

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE" >/dev/null; }

notify() {
  local key="$1"; local level="$2"; local msg="$3"
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_ADMIN_CHAT_ID:-}" ]] && return 0
  local state_file="$STATE_DIR/$key"
  local now; now=$(date +%s)
  # Dedupe: if same key was alerted in the last 24h, skip.
  if [[ -f "$state_file" ]]; then
    local last; last=$(cat "$state_file" 2>/dev/null || echo 0)
    if (( now - last < 86400 )); then return 0; fi
  fi
  echo "$now" > "$state_file"
  local icon="ℹ️"; [[ "$level" == "warn" ]] && icon="⚠️"; [[ "$level" == "error" ]] && icon="🚨"
  curl -sS --max-time 8 -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_ADMIN_CHAT_ID}" \
    -d "parse_mode=Markdown" \
    -d "disable_web_page_preview=true" \
    --data-urlencode "text=${icon} ${msg}" >/dev/null 2>&1 || true
  log "alert sent: $key ($level) $msg"
}

clear_alert() { rm -f "$STATE_DIR/$1" 2>/dev/null || true; }

# --- Disk ---
USED_PCT=$(df -P "$INSTALL_DIR" | awk 'NR==2{gsub("%",""); print $5}')
if [[ "$USED_PCT" -ge 90 ]]; then
  notify disk-alert error "PremDev disk *${USED_PCT}%* full on \`$INSTALL_DIR\`"
elif [[ "$USED_PCT" -ge 80 ]]; then
  notify disk-warn warn "PremDev disk ${USED_PCT}% full on \`$INSTALL_DIR\`"
else
  clear_alert disk-warn; clear_alert disk-alert
fi

# --- SSL expiry ---
if [[ -n "${PRIMARY_DOMAIN:-}" ]]; then
  HOST="app.${PRIMARY_DOMAIN}"
  EXP_LINE=$(echo | timeout 8 openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null \
            | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//') || EXP_LINE=""
  if [[ -n "$EXP_LINE" ]]; then
    EXP_TS=$(date -d "$EXP_LINE" +%s 2>/dev/null || echo 0)
    NOW_TS=$(date +%s)
    DAYS=$(( (EXP_TS - NOW_TS) / 86400 ))
    if (( DAYS <= 7 )); then
      notify ssl-alert error "PremDev SSL for *${HOST}* expires in *${DAYS}d*"
    elif (( DAYS <= 14 )); then
      notify ssl-warn warn "PremDev SSL for ${HOST} expires in ${DAYS}d"
    else
      clear_alert ssl-warn; clear_alert ssl-alert
    fi
  fi
fi

# --- API health ---
if [[ -n "${PRIMARY_DOMAIN:-}" ]]; then
  HC=$(curl -sS -m 8 -o /dev/null -w "%{http_code}" "https://app.${PRIMARY_DOMAIN}/api/health" || echo "000")
  if [[ "$HC" != "200" ]]; then
    notify api-down error "PremDev API health check failed (HTTP $HC) on https://app.${PRIMARY_DOMAIN}"
  else
    clear_alert api-down
  fi
fi

# --- Compose services ---
if [[ -f "$COMPOSE_FILE" ]]; then
  STOPPED=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null \
            | grep -c '"State":"exited"' || true)
  if [[ "$STOPPED" -gt 0 ]]; then
    SVCS=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -v running || true)
    notify compose-down warn "PremDev compose: ${STOPPED} service(s) not running:%0A\`\`\`%0A${SVCS}%0A\`\`\`"
  else
    clear_alert compose-down
  fi
fi
