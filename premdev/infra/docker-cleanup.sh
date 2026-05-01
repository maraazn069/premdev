#!/usr/bin/env bash
# ============================================================================
# PremDev Docker cleanup
# ----------------------------------------------------------------------------
# Frees disk space without disturbing live PremDev services. Safe to run from
# cron (see /etc/cron.d/premdev-docker-cleanup) AND from the /admin UI button.
#
# What it removes:
#   - Stopped containers older than 1h
#   - Dangling and unused images
#   - All builder cache
#   - Unused, unattached volumes (only those NOT mounted by any container)
#
# What it KEEPS:
#   - Every running container (premdev compose stack + workspace pw_/pwsh_)
#   - Every image referenced by a running container
#   - Every named/anonymous volume that is currently attached
#
# Usage: docker-cleanup.sh [--quiet]
# ============================================================================
set -Eeuo pipefail

QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log() { [[ "$QUIET" == 1 ]] || echo "$@"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not installed" >&2
  exit 1
fi

before_bytes=$(df -B1 / | awk 'NR==2{print $4}')
log "==> Disk free before: $(numfmt --to=iec --suffix=B "$before_bytes")"

log "==> Pruning stopped containers (older than 1h)…"
docker container prune -f --filter "until=1h" >/dev/null

log "==> Pruning dangling images…"
docker image prune -f >/dev/null

log "==> Pruning ALL unused images (not referenced by any container)…"
# `image prune -a` removes images with no container ref. Running containers
# (compose stack + every workspace) automatically protect their images.
docker image prune -a -f >/dev/null

log "==> Pruning builder cache…"
docker builder prune -af >/dev/null

log "==> Pruning unattached volumes…"
docker volume prune -f >/dev/null

after_bytes=$(df -B1 / | awk 'NR==2{print $4}')
freed=$((after_bytes - before_bytes))
[[ "$freed" -lt 0 ]] && freed=0

log "==> Disk free after:  $(numfmt --to=iec --suffix=B "$after_bytes")"
log "==> Freed:            $(numfmt --to=iec --suffix=B "$freed")"

# Final state — handy in cron logs.
log ""
log "==> Compose services (must all be Up):"
docker compose -f /opt/premdev/docker-compose.yml ps 2>/dev/null || true
