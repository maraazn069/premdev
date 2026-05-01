#!/usr/bin/env bash
# ============================================================================
# Refresh /opt/premdev/data/backup_index.json from R2.
# Run after every backup AND from cron once per hour so manual purges are
# reflected in the /admin Backup tab without waiting for the next backup.
# ============================================================================
set -Eeuo pipefail
for f in /etc/premdev/backup.env /opt/premdev/.env; do
  [[ -r "$f" ]] && set -a && . "$f" && set +a
done
DATA_DIR="${PREMDEV_DATA_DIR:-/opt/premdev/data}"
INDEX="$DATA_DIR/backup_index.json"
RC_REMOTE="${RCLONE_REMOTE:-r2}"
BUCKET="${R2_BUCKET:-}"

mkdir -p "$DATA_DIR"

if [[ -z "$BUCKET" ]]; then
  # No R2 configured — write an empty (but valid) index so the API has
  # something coherent to read.
  python3 -c 'import json,time,sys; json.dump({"snapshots":[],"updatedAt":int(time.time()),"configured":False},open(sys.argv[1],"w"))' "$INDEX"
  exit 0
fi

# One-shot generator: list daily/ + weekly/ via rclone lsjson, then call
# `rclone size --json` per snapshot to get a real byte count + file count.
# `rclone size` walks the prefix recursively, so cost is bounded by snapshot
# size, which is fine for a hourly job and a UI button.
python3 - "$RC_REMOTE" "$BUCKET" "$INDEX" <<'PY'
import sys, json, subprocess, time
rc_remote, bucket, index = sys.argv[1:]
out = {"snapshots": [], "updatedAt": int(time.time()), "configured": True}
errors = []
for prefix in ("daily", "weekly"):
    try:
        r = subprocess.run(
            ["rclone", "lsjson", f"{rc_remote}:{bucket}/{prefix}/", "--dirs-only"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            errors.append(f"lsjson {prefix}: {r.stderr.strip()[:200]}")
            continue
        for d in json.loads(r.stdout or "[]"):
            name = d.get("Name", "")
            sz = {"bytes": 0, "count": 0}
            try:
                sr = subprocess.run(
                    ["rclone", "size", "--json", f"{rc_remote}:{bucket}/{prefix}/{name}/"],
                    capture_output=True, text=True, timeout=120,
                )
                if sr.returncode == 0:
                    sz = json.loads(sr.stdout)
            except Exception as e:
                errors.append(f"size {prefix}/{name}: {e}")
            out["snapshots"].append({
                "prefix": prefix,
                "name": name,
                "path": f"{prefix}/{name}",
                "modTime": d.get("ModTime", ""),
                "sizeBytes": sz.get("bytes", 0),
                "fileCount": sz.get("count", 0),
            })
    except Exception as e:
        errors.append(f"{prefix}: {e}")
# Newest first — UI groups by prefix, but newest-first is the right default
# for "find the snapshot I want to restore".
out["snapshots"].sort(key=lambda s: s.get("modTime", ""), reverse=True)
if errors:
    out["errors"] = errors
with open(index, "w") as f:
    json.dump(out, f)
PY
chmod 644 "$INDEX" 2>/dev/null || true
