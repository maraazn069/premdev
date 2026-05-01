#!/bin/bash
# Script untuk push perubahan AI improvements ke GitHub
# Jalankan dari terminal: bash push-ai-improvements.sh

set -e
REPO_DIR="/tmp/premdev-fresh"

if [ ! -d "$REPO_DIR" ]; then
  echo "ERROR: $REPO_DIR tidak ada. Clone dulu:"
  echo "  git clone https://\$TOKEN@github.com/maraazn069/premdev.git $REPO_DIR"
  exit 1
fi

cd "$REPO_DIR"

git config user.email "agent@premdev.local"
git config user.name "PremDev Agent"

git add \
  apps/api/src/lib/agent/ \
  apps/api/src/lib/conversation-memory.ts \
  apps/api/src/lib/tools.ts \
  apps/api/src/lib/ai-prompt.ts \
  apps/api/src/lib/db.ts \
  apps/api/src/routes/ai.ts \
  apps/web/src/components/AIChat.tsx \
  apps/api/src/lib/semantic-search.ts

git status

git diff --cached --stat

git commit -m "feat+fix: AI agent improvements + reindex EEXIST fix

feat: AI agent — tools registry, memory, planner, partial file rescue
- tools.ts: 16 modular tool definitions, inject ke system prompt
- conversation-memory.ts: SQLite short-term memory per workspace
- agent/planner.ts: Plan section sebelum autopilot eksekusi (fix TS2345)
- db.ts: migration tabel conversation_memory
- ai.ts: inject memory+tools+planner, GET /tools & /memory endpoints
- ai-prompt.ts: CONT_TRUNC lebih tegas soal chunked patches
- AIChat.tsx: partial file rescue — unclosed file blocks disimpan ke disk

fix: semantic-search.ts — EEXIST reindex error
- Pindah lokasi embeddings.db dari <workspace>/.premdev/embeddings.db
  ke DATA_DIR/embeddings/<workspaceId>/embeddings.db
- Root cause: .premdev adalah FILE config JSON, bukan direktori,
  sehingga mkdirSync gagal dengan EEXIST"

git push origin main

echo ""
echo "Push berhasil! GitHub Actions akan build image baru."
echo "Tunggu build selesai (~3-5 menit), lalu di VPS jalankan:"
echo "  cd /opt/premdev && sudo docker compose pull app && sudo docker compose up -d --force-recreate app"
