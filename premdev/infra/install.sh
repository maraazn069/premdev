#!/usr/bin/env bash
# ============================================================================
# PremDev Installer
# Self-hosted cloud IDE for personal use
# Tested on Ubuntu 22.04 / 24.04
# ============================================================================
set -Eeuo pipefail

# ----- Colors -----
B='\033[1m'; D='\033[2m'; R='\033[0m'
G='\033[32m'; Y='\033[33m'; r='\033[31m'; C='\033[36m'

step()  { printf "\n${C}${B}==> %s${R}\n" "$*"; }
info()  { printf "${G}  ✓${R} %s\n" "$*"; }
warn()  { printf "${Y}  !${R} %s\n" "$*"; }
err()   { printf "${r}  ✗${R} %s\n" "$*" >&2; }
fatal() { err "$*"; exit 1; }

trap 'err "Install failed at line $LINENO. Check the log above."; exit 1' ERR

# ----- Paths -----
INSTALL_DIR="${INSTALL_DIR:-/opt/premdev}"
DATA_DIR="${DATA_DIR:-/opt/premdev/data}"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
# Hoisted so cron/script-install steps can reach the bundled assets early.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- Pre-flight -----
step "Pre-flight checks"
if [[ $EUID -ne 0 ]]; then fatal "Run with sudo or as root."; fi
if ! command -v lsb_release >/dev/null; then apt-get update -qq && apt-get install -yqq lsb-release; fi
OS=$(lsb_release -is) || fatal "Could not detect OS"
VER=$(lsb_release -rs) || true
info "OS: $OS $VER"
[[ "$OS" == "Ubuntu" ]] || warn "Tested on Ubuntu only — proceeding anyway"

# ----- Read existing env if upgrading -----
load_env_var() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
    local val
    # Use the LAST occurrence (Docker/dotenv semantics) so duplicates from
    # an aborted previous install don't bring back stale values.
    val=$(grep "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')
    # Reject obviously corrupt values that look like leaked install.sh code
    # (most commonly caused by `curl ... | bash` consuming script body via
    # stdin in a previous run). Falling back to empty forces the default to
    # be used so the new install writes a clean file.
    if [[ "$val" == prompt* ]] || [[ "$val" == *'${PRIMARY_DOMAIN}'* ]] || [[ "$val" == *'${DOMAIN}'* ]]; then
      return
    fi
    printf '%s' "$val"
  fi
}

prompt() {
  local var="$1" prompt_text="$2" default="$3" secret="${4:-}"
  local current
  current=$(load_env_var "$var")
  [[ -z "$current" ]] && current="$default"
  local input
  # Always read from the real terminal, NOT stdin. This script is most
  # commonly invoked as `curl ... | sudo bash`, which makes stdin a pipe
  # carrying the script body itself — without `< /dev/tty`, every `read`
  # would consume the NEXT LINE of install.sh as the user's "answer",
  # silently writing garbage like `prompt PREVIEW_DOMAIN "..."` into
  # PRIMARY_DOMAIN. Symptom: Caddy errors `*.prompt` / unknown wildcard
  # and the API misroutes workspace subdomains to the dashboard.
  if [[ ! -r /dev/tty ]]; then
    fatal "No terminal available. Re-run install.sh interactively, e.g.:
  curl -fsSL https://.../install.sh -o /tmp/install.sh && sudo bash /tmp/install.sh"
  fi
  if [[ -n "$secret" ]]; then
    read -srp "  ${prompt_text} [${current:+•••••••}]: " input < /dev/tty; echo
  else
    read -rp "  ${prompt_text} [${current}]: " input < /dev/tty
  fi
  printf -v "$var" '%s' "${input:-$current}"
}

# ----- Interactive config -----
step "Configuration"
echo -e "${D}  Press ENTER to keep value in [brackets]. Secrets are hidden after entry.${R}"
echo

prompt PRIMARY_DOMAIN          "Primary domain"                              "flixprem.org"
prompt PREVIEW_DOMAIN          "Preview wildcard domain"                     "preview.${PRIMARY_DOMAIN}"
prompt DEPLOY_DOMAIN           "Deploy wildcard domain"                      "app.${PRIMARY_DOMAIN}"
prompt LE_EMAIL                "Email for Let's Encrypt"                     "maraazn069@gmail.com"
prompt CF_API_TOKEN            "Cloudflare API token (Zone:DNS:Edit)"        ""                       secret

prompt ADMIN_USERNAME          "Admin username"                              "maraazn069"
prompt ADMIN_EMAIL             "Admin email"                                 "maraazn069@gmail.com"
prompt ADMIN_PASSWORD          "Admin password (min 8 chars)"                ""                       secret

prompt MYSQL_ROOT_PASSWORD     "MySQL root password (auto-generated if empty)" "" secret
prompt MYSQL_USER_PASSWORD     "MySQL shared user password (auto if empty)"    "" secret

prompt OPENAI_API_KEY          "OpenAI API key (optional)"                   "" secret
prompt ANTHROPIC_API_KEY       "Anthropic API key (optional)"                "" secret
prompt GOOGLE_API_KEY          "Google AI API key (optional)"                "" secret
prompt OPENROUTER_API_KEY      "OpenRouter API key (optional)"               "" secret
prompt GROQ_API_KEY            "Groq API key (optional)"                     "" secret

# Hardening + Fase 2 prep (all optional)
prompt IDLE_SHELL_TIMEOUT_MIN  "Stop idle shell containers after N min (0 disables)" "30"
prompt TELEGRAM_BOT_TOKEN      "Telegram bot token (alerts + admin bot)"             "" secret
prompt TELEGRAM_ADMIN_CHAT_ID  "Telegram chat ID for monitor/backup alerts"          ""
# Numeric Telegram user ID allowed to send commands to the bot. SAME as the
# chat ID for a 1:1 chat with yourself. The bot REFUSES to start if this is
# unset (would otherwise accept commands from anyone who finds the bot).
prompt ADMIN_TELEGRAM_ID       "Telegram user ID allowed to command the bot"         "${TELEGRAM_ADMIN_CHAT_ID:-}"
prompt R2_ENDPOINT             "Cloudflare R2 endpoint for backups (optional)"       ""
prompt R2_ACCESS_KEY           "R2 access key (optional)"                            "" secret
prompt R2_SECRET_KEY           "R2 secret key (optional)"                            "" secret
prompt R2_BUCKET               "R2 bucket name (optional)"                           ""
prompt R2_REGION               "R2 region"                                           "auto"

prompt GHCR_IMAGE              "Container image"                             "ghcr.io/maraazn069/premdev:latest"
prompt GHCR_USER               "GHCR username (for private image pulls)"     "maraazn069"
prompt GHCR_TOKEN              "GHCR PAT (read:packages, blank if public)"   "" secret

# Auto-gen passwords
gen_pw() { openssl rand -base64 24 | tr -d "+/=" | head -c 32; }
[[ -z "$MYSQL_ROOT_PASSWORD" ]] && MYSQL_ROOT_PASSWORD=$(gen_pw) && info "Generated MySQL root password"
[[ -z "$MYSQL_USER_PASSWORD" ]] && MYSQL_USER_PASSWORD=$(gen_pw) && info "Generated MySQL user password"
JWT_SECRET=$(load_env_var JWT_SECRET); [[ -z "$JWT_SECRET" ]] && JWT_SECRET=$(openssl rand -hex 48)

# Validation
[[ ${#ADMIN_PASSWORD} -ge 8 ]] || fatal "Admin password must be at least 8 characters"
[[ -n "$CF_API_TOKEN" ]]       || fatal "Cloudflare API token is required for SSL"

# ----- Install dependencies -----
step "Installing system dependencies"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -yqq \
  curl ca-certificates gnupg openssl ufw git jq gettext-base sqlite3

# Docker
if ! command -v docker >/dev/null; then
  info "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  CODENAME=$(lsb_release -cs)
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -yqq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  info "Docker installed: $(docker --version)"
else
  info "Docker present: $(docker --version)"
fi

# ----- Firewall -----
step "Configuring firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
echo "y" | ufw enable >/dev/null 2>&1 || true
info "UFW: 22, 80, 443 allowed"

# ----- Layout -----
step "Preparing directories"
mkdir -p "$INSTALL_DIR" "$DATA_DIR/workspaces" "$DATA_DIR/userhome" "$DATA_DIR/mysql" "$DATA_DIR/sqlite" "$DATA_DIR/caddy"
# userhome stores per-workspace pip/npm caches that are bind-mounted into the
# runtime containers as /home/premdev/.local + /home/premdev/.cache (UID 1000).
# Pre-create the parent with the expected uid so docker-engine inherits the
# correct ownership when it auto-creates per-workspace subdirs on first mount.
chown -R 1000:1000 "$DATA_DIR/userhome" 2>/dev/null || true
chmod 755 "$DATA_DIR/userhome" 2>/dev/null || true
info "Layout: $INSTALL_DIR"

# ----- Write .env -----
step "Writing $ENV_FILE"
# Wrap every value in double quotes and escape \, $, ", ` so that secrets
# containing spaces or shell-significant characters parse correctly under
# both `docker compose --env-file` and Node's dotenv reader. Without this,
# a generated password like `a"b` or one containing a literal $ would break
# the stack on next compose-up.
write_env_var() {
  local key="$1" val="$2"
  local esc=${val//\\/\\\\}
  esc=${esc//\$/\\\$}
  esc=${esc//\"/\\\"}
  esc=${esc//\`/\\\`}
  printf '%s="%s"\n' "$key" "$esc" >> "$ENV_FILE"
}

: > "$ENV_FILE"
{
  echo "# PremDev — generated $(date -u +%FT%TZ)"
  echo "NODE_ENV=production"
  echo "LOG_LEVEL=info"
  echo "PORT=3001"
  echo "HOST=0.0.0.0"
  echo "SECURE_COOKIES=true"
  echo
} >> "$ENV_FILE"

write_env_var PRIMARY_DOMAIN          "$PRIMARY_DOMAIN"
write_env_var PREVIEW_DOMAIN          "$PREVIEW_DOMAIN"
write_env_var DEPLOY_DOMAIN           "$DEPLOY_DOMAIN"
write_env_var COOKIE_DOMAIN           ".$PRIMARY_DOMAIN"
write_env_var LE_EMAIL                "$LE_EMAIL"
write_env_var CF_API_TOKEN            "$CF_API_TOKEN"
write_env_var JWT_SECRET              "$JWT_SECRET"

write_env_var DATA_DIR                "/var/lib/premdev"
write_env_var WORKSPACES_DIR          "/var/lib/premdev/workspaces"
# Host path for workspace dirs (used by docker bind mounts). The app container
# sees /var/lib/premdev which is bind-mounted from /opt/premdev/data on host,
# so the host docker daemon must use /opt/premdev/data/workspaces.
write_env_var WORKSPACES_HOST_DIR     "/opt/premdev/data/workspaces"
write_env_var SQLITE_PATH             "/var/lib/premdev/sqlite/premdev.sqlite"

write_env_var ADMIN_USERNAME          "$ADMIN_USERNAME"
write_env_var ADMIN_EMAIL             "$ADMIN_EMAIL"
write_env_var ADMIN_PASSWORD          "$ADMIN_PASSWORD"

write_env_var DOCKER_SOCKET           "/var/run/docker.sock"
write_env_var DOCKER_NETWORK          "premdev_net"
write_env_var RUNTIME_IMAGE           "premdev/runtime:latest"

write_env_var MYSQL_HOST              "mysql"
write_env_var MYSQL_PORT              "3306"
write_env_var MYSQL_ROOT_PASSWORD     "$MYSQL_ROOT_PASSWORD"
write_env_var MYSQL_USER_PASSWORD     "$MYSQL_USER_PASSWORD"

write_env_var OPENAI_API_KEY          "$OPENAI_API_KEY"
write_env_var ANTHROPIC_API_KEY       "$ANTHROPIC_API_KEY"
write_env_var GOOGLE_API_KEY          "$GOOGLE_API_KEY"
write_env_var OPENROUTER_API_KEY      "$OPENROUTER_API_KEY"
write_env_var GROQ_API_KEY            "$GROQ_API_KEY"

# Hardening + Fase 2 prep
write_env_var IDLE_SHELL_TIMEOUT_MIN  "$IDLE_SHELL_TIMEOUT_MIN"
write_env_var TELEGRAM_BOT_TOKEN      "$TELEGRAM_BOT_TOKEN"
write_env_var TELEGRAM_ADMIN_CHAT_ID  "$TELEGRAM_ADMIN_CHAT_ID"
write_env_var ADMIN_TELEGRAM_ID       "$ADMIN_TELEGRAM_ID"
write_env_var R2_ENDPOINT             "$R2_ENDPOINT"
write_env_var R2_ACCESS_KEY           "$R2_ACCESS_KEY"
write_env_var R2_SECRET_KEY           "$R2_SECRET_KEY"
write_env_var R2_BUCKET               "$R2_BUCKET"
write_env_var R2_REGION               "$R2_REGION"

write_env_var GHCR_IMAGE              "$GHCR_IMAGE"

chmod 600 "$ENV_FILE"
info "Wrote .env (mode 600)"

# ----- Weekly Docker prune cron -----
# Workspace lifecycle leaves stopped `pw_*` / `pwsh_*` containers and
# untagged image layers on disk. Without this cleanup, /var/lib/docker grows
# unbounded over weeks. Runs Sunday 03:00, prunes anything > 24h old, and
# never touches volumes (workspace data lives in /opt/premdev/data, not
# named volumes — but we use --volumes=false explicitly to be safe).
step "Installing weekly Docker prune cron"
cat > /etc/cron.weekly/premdev-prune <<'CRON'
#!/usr/bin/env bash
# PremDev weekly maintenance — log rotation is per-container, this just
# clears stopped containers and dangling images so disk usage stays bounded.
set -e
LOG=/var/log/premdev-prune.log
{
  echo "=== $(date -u +%FT%TZ) ==="
  docker container prune -f --filter "until=24h" 2>&1 | sed 's/^/  /'
  docker image prune -af --filter "until=168h" 2>&1 | sed 's/^/  /'
  docker builder prune -af --filter "until=168h" 2>&1 | sed 's/^/  /' || true
  df -h /var/lib/docker | sed 's/^/  /'
} >> "$LOG" 2>&1
# Keep the log itself bounded.
tail -c 1048576 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
CRON
chmod 755 /etc/cron.weekly/premdev-prune
info "Cron: /etc/cron.weekly/premdev-prune"

# ----- Install rclone for backups -----
# We use rclone (not aws CLI / aws-sdk) so the backup script is one bash file
# the operator can read and audit, and works against R2/S3/B2 unchanged.
step "Installing rclone (for R2 backups)"
if ! command -v rclone >/dev/null 2>&1; then
  curl -sS https://rclone.org/install.sh | bash >/dev/null 2>&1 || warn "rclone install failed — backups disabled"
fi
if command -v rclone >/dev/null 2>&1; then
  info "rclone $(rclone --version | head -1)"

  # Configure R2 remote if all credentials present.
  if [[ -n "${R2_ENDPOINT:-}" && -n "${R2_ACCESS_KEY:-}" && -n "${R2_SECRET_KEY:-}" ]]; then
    mkdir -p /root/.config/rclone
    cat > /root/.config/rclone/rclone.conf <<RCLONE
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY}
secret_access_key = ${R2_SECRET_KEY}
endpoint = ${R2_ENDPOINT}
region = ${R2_REGION:-auto}
acl = private
RCLONE
    chmod 600 /root/.config/rclone/rclone.conf
    info "rclone R2 remote configured (~/.config/rclone/rclone.conf)"
  else
    warn "R2 credentials missing — backups will be disabled until set in $ENV_FILE"
  fi
fi

# ----- Backup: daily R2 sync + retention -----
# The backup script lives in /usr/local/sbin so it can be re-run by hand for
# testing. Cron runs it nightly. State (env) is loaded from the .env file.
step "Installing backup script + cron"
mkdir -p /etc/premdev
# Reduced env file the cron job sources — never write the whole .env, just
# the backup-relevant variables (avoids leaking JWT_SECRET to a wider scope).
cat > /etc/premdev/backup.env <<BENV
PREMDEV_INSTALL_DIR=$INSTALL_DIR
PREMDEV_DATA_DIR=$DATA_DIR
RCLONE_REMOTE=r2
R2_BUCKET="$R2_BUCKET"
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
TELEGRAM_ADMIN_CHAT_ID="$TELEGRAM_ADMIN_CHAT_ID"
MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD"
BENV
chmod 600 /etc/premdev/backup.env
cp "$SCRIPT_DIR/backup.sh" /usr/local/sbin/premdev-backup
chmod 755 /usr/local/sbin/premdev-backup
cat > /etc/cron.daily/premdev-backup <<'CRON'
#!/usr/bin/env bash
# Run nightly. The script no-ops cleanly if R2 isn't configured.
exec /usr/local/sbin/premdev-backup
CRON
chmod 755 /etc/cron.daily/premdev-backup
info "Cron: /etc/cron.daily/premdev-backup (R2 backups)"

# ----- Monitoring: hourly disk/SSL/health checks → Telegram -----
step "Installing monitoring script + cron"
cp "$SCRIPT_DIR/monitoring.sh" /usr/local/sbin/premdev-monitor
chmod 755 /usr/local/sbin/premdev-monitor
cat > /etc/cron.hourly/premdev-monitor <<'CRON'
#!/usr/bin/env bash
exec /usr/local/sbin/premdev-monitor
CRON
chmod 755 /etc/cron.hourly/premdev-monitor
info "Cron: /etc/cron.hourly/premdev-monitor (disk/SSL/health alerts)"

# ----- Redeploy command (so operators can run `sudo premdev-redeploy`) -----
step "Installing redeploy command"
cp "$SCRIPT_DIR/redeploy.sh" /usr/local/sbin/premdev-redeploy
chmod 755 /usr/local/sbin/premdev-redeploy
info "Installed: /usr/local/sbin/premdev-redeploy (run after git push)"

# ----- R2 restore + trigger runner (used by /admin Backup tab) -----
step "Installing restore + trigger runner"
cp "$SCRIPT_DIR/restore.sh"         /usr/local/sbin/premdev-restore
cp "$SCRIPT_DIR/refresh-index.sh"   /usr/local/sbin/premdev-refresh-index
cp "$SCRIPT_DIR/trigger-runner.sh"  /usr/local/sbin/premdev-trigger
cp "$SCRIPT_DIR/docker-cleanup.sh"  /usr/local/sbin/premdev-docker-cleanup
chmod 755 /usr/local/sbin/premdev-restore /usr/local/sbin/premdev-refresh-index \
          /usr/local/sbin/premdev-trigger /usr/local/sbin/premdev-docker-cleanup
mkdir -p /opt/premdev/data/triggers
chown 1000:1000 /opt/premdev/data/triggers 2>/dev/null || true
chmod 770 /opt/premdev/data/triggers
# Trigger runner: every minute. Cheap when idle (just stat the dir).
cat > /etc/cron.d/premdev-trigger <<'CRON'
# Picks up backup/restore/index requests from /opt/premdev/data/triggers/
# (written by the API container) and runs them on the host.
* * * * * root /usr/local/sbin/premdev-trigger >> /var/log/premdev-trigger.log 2>&1
# Hourly index refresh so /admin Backup list stays fresh after manual purges.
17 * * * * root /usr/local/sbin/premdev-refresh-index >> /var/log/premdev-trigger.log 2>&1
CRON
chmod 644 /etc/cron.d/premdev-trigger
# Daily Docker cleanup at 03:00 — frees image/builder/volume cache. Safe:
# only touches stuff with no running container reference.
cat > /etc/cron.d/premdev-docker-cleanup <<'CRON'
# Frees Docker disk daily at 03:00 (image/builder/volume prune).
# Running PremDev containers automatically protect their images.
0 3 * * * root /usr/local/sbin/premdev-docker-cleanup --quiet >> /var/log/premdev-docker-cleanup.log 2>&1
CRON
chmod 644 /etc/cron.d/premdev-docker-cleanup
# Build the index once now so /admin doesn't show empty on first load.
/usr/local/sbin/premdev-refresh-index || true
info "Cron: /etc/cron.d/premdev-trigger (admin backup/restore bridge)"
info "Cron: /etc/cron.d/premdev-docker-cleanup (daily 03:00 disk reclaim)"

# ----- Static landing page on root domain (apex) -----
step "Installing static landing page (apex domain)"
mkdir -p /opt/premdev/data/landing
cp "$SCRIPT_DIR/landing/index.html" /opt/premdev/data/landing/index.html
chmod 644 /opt/premdev/data/landing/index.html
info "Landing page: /opt/premdev/data/landing/ → served at https://${PRIMARY_DOMAIN}/"

# ----- Telegram admin bot (interactive: /stats, /env, /restart, …) -----
step "Installing Telegram admin bot"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${ADMIN_TELEGRAM_ID:-}" ]]; then
  warn "TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID empty — skipping bot install."
  warn "  Re-run install.sh after setting them in $ENV_FILE to enable the bot."
else
  # Bot is a plain Node script on the host (NOT in a container) so it has
  # direct access to docker, .env, /proc, df, du, etc.
  if ! command -v node >/dev/null 2>&1; then
    info "Installing Node.js 20 (host runtime for the bot)"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
    apt-get install -yqq nodejs >/dev/null
  fi
  cp "$SCRIPT_DIR/telegram-bot.mjs" /usr/local/sbin/premdev-bot.mjs
  chmod 755 /usr/local/sbin/premdev-bot.mjs
  cp "$SCRIPT_DIR/premdev-bot.service" /etc/systemd/system/premdev-bot.service
  systemctl daemon-reload
  systemctl enable premdev-bot.service >/dev/null 2>&1 || true
  systemctl restart premdev-bot.service
  sleep 2
  if systemctl is-active --quiet premdev-bot.service; then
    info "Bot service: premdev-bot (systemctl status premdev-bot)"
    info "  Send /help to your bot in Telegram to verify."
  else
    warn "premdev-bot.service not active. Check: journalctl -u premdev-bot -n 50"
  fi
fi

# ----- Create premdev_net -----
step "Creating Docker network"
docker network inspect premdev_net >/dev/null 2>&1 || docker network create premdev_net >/dev/null
info "Network: premdev_net"

# ----- Copy compose file, Caddy build context & Caddyfile -----
step "Copying configuration files"
cp "$SCRIPT_DIR/docker-compose.prod.yml" "$INSTALL_DIR/docker-compose.yml"
# Caddy build context (required by docker-compose.prod.yml caddy.build.context: ./caddy)
mkdir -p "$INSTALL_DIR/caddy"
cp -r "$SCRIPT_DIR/caddy/." "$INSTALL_DIR/caddy/"
# Caddyfile template
cp "$SCRIPT_DIR/Caddyfile.tmpl" "$DATA_DIR/caddy/Caddyfile.tmpl"
export PRIMARY_DOMAIN PREVIEW_DOMAIN DEPLOY_DOMAIN LE_EMAIL CF_API_TOKEN
envsubst < "$DATA_DIR/caddy/Caddyfile.tmpl" > "$DATA_DIR/caddy/Caddyfile"
info "Caddyfile generated"

# Optional GHCR auth (image may be private)
if [[ -n "${GHCR_TOKEN:-}" ]]; then
  step "Logging in to GHCR"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-maraazn069}" --password-stdin
  info "GHCR auth configured"
else
  warn "No GHCR_TOKEN env var set. If your image is private, run:"
  warn "  echo \$PAT | docker login ghcr.io -u maraazn069 --password-stdin"
fi

# ----- Build runtime image (multi-language base) -----
step "Building user runtime image (this takes 5-10 minutes)"
if [[ -d "$SCRIPT_DIR/runtime" ]]; then
  docker build -t premdev/runtime:latest "$SCRIPT_DIR/runtime" 2>&1 | tail -20 || warn "Runtime build had issues — continuing"
  info "Runtime image: premdev/runtime:latest"
else
  warn "Runtime image source not found, will pull from registry on first use"
fi

# ----- Pull app image -----
step "Pulling app image: $GHCR_IMAGE"
docker pull "$GHCR_IMAGE" 2>&1 | tail -5 || warn "Pull failed — you may need to push first or set GHCR auth"

# ----- Bring up stack -----
step "Starting stack"
cd "$INSTALL_DIR"
docker compose pull 2>&1 | tail -10 || true
docker compose up -d
sleep 5

# ----- Health check -----
step "Health check"
# Wait for the app container to expose health on the docker network
APP_OK=0
for i in {1..60}; do
  if docker compose -f "$COMPOSE_FILE" exec -T app wget -q -O - http://localhost:3001/api/health >/dev/null 2>&1; then
    info "API is up"
    APP_OK=1
    break
  fi
  sleep 1
done
[[ $APP_OK -eq 1 ]] || warn "API not responding after 60s — check 'docker compose -f $COMPOSE_FILE logs app'"

# Validate Caddy config
if docker compose -f "$COMPOSE_FILE" exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  info "Caddy config validated"
else
  warn "Caddy validation failed — check 'docker compose -f $COMPOSE_FILE logs caddy'"
fi

# ----- DNS reminder -----
step "DNS check"
echo
echo "  Make sure these Cloudflare A records exist (proxy OFF / DNS-only):"
echo
echo "    ${PRIMARY_DOMAIN}            A   $(curl -s ifconfig.me 2>/dev/null || echo YOUR_VPS_IP)"
echo "    *.${PRIMARY_DOMAIN}          A   $(curl -s ifconfig.me 2>/dev/null || echo YOUR_VPS_IP)"
echo "    *.preview.${PRIMARY_DOMAIN}  A   $(curl -s ifconfig.me 2>/dev/null || echo YOUR_VPS_IP)"
echo

# ----- Summary -----
step "Done!"
echo
echo -e "${G}${B}  PremDev is installed.${R}"
echo
echo -e "  ${B}URLs${R}"
echo -e "    App:        ${C}https://app.${PRIMARY_DOMAIN}${R}"
echo -e "    Admin:      ${C}https://app.${PRIMARY_DOMAIN}/admin${R}"
echo -e "    phpMyAdmin: ${C}https://db.${PRIMARY_DOMAIN}${R}"
echo
echo -e "  ${B}Login${R}"
echo -e "    Username:   ${C}${ADMIN_USERNAME}${R}"
echo -e "    Password:   ${C}(as you entered)${R}"
echo
echo -e "  ${B}Common commands${R}"
echo -e "    Logs:       ${D}docker compose -f $COMPOSE_FILE logs -f${R}"
echo -e "    Restart:    ${D}docker compose -f $COMPOSE_FILE restart${R}"
echo -e "    Update:     ${D}docker compose -f $COMPOSE_FILE pull && docker compose -f $COMPOSE_FILE up -d${R}"
echo -e "    Edit env:   ${D}nano $ENV_FILE && docker compose -f $COMPOSE_FILE up -d${R}"
echo
