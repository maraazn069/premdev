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
  apps/web/src/components/AIChat.tsx

git status

git diff --cached --stat

git commit -m "feat: AI agent — tools registry, memory, planner, partial file rescue + fix TS2345

- tools.ts: 16 modular tool definitions, inject ke system prompt
- conversation-memory.ts: SQLite short-term memory per workspace
- agent/planner.ts: Plan section sebelum autopilot eksekusi
  fix: AbortSignal | undefined -> AbortSignal ?? new AbortController().signal (TS2345)
- db.ts: migration tabel conversation_memory
- ai.ts: inject memory+tools+planner ke context, GET /tools & /memory endpoints
- ai-prompt.ts: CONT_TRUNC_INSTRUCTION lebih tegas soal chunked patches
- AIChat.tsx: partial file rescue — unclosed file blocks disimpan ke disk
  sebelum auto-continuation, badge biru untuk rescued files"

git push origin main

echo ""
echo "Push berhasil! GitHub Actions akan build image baru."
echo "Tunggu build selesai, lalu di VPS jalankan:"
echo "  cd /opt/premdev && sudo docker compose pull app && sudo docker compose up -d --force-recreate app"
