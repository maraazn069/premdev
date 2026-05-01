#!/bin/bash
# Push fix semantic-search.ts ke GitHub
# Jalankan: bash push-ai-improvements.sh

set -e

git config user.email "agent@premdev.local"
git config user.name "PremDev Agent"

git add apps/api/src/lib/semantic-search.ts

git status
echo ""
git diff --cached --stat
echo ""

if git diff --cached --quiet; then
  echo "Tidak ada perubahan baru untuk di-commit."
else
  git commit -m "fix: semantic-search — pindah lokasi embeddings.db (#EEXIST)

Root cause: .premdev di workspace root adalah FILE config JSON,
bukan direktori. mkdirSync gagal EEXIST saat reindex.

Fix: simpan embeddings di DATA_DIR/embeddings/<workspaceId>/embeddings.db
bukan di <workspace_root>/.premdev/embeddings.db"

  git push origin main

  echo ""
  echo "========================================="
  echo "Push berhasil!"
  echo "Tunggu GitHub Actions build (~3-5 menit)"
  echo "Cek: https://github.com/maraazn069/premdev/actions"
  echo ""
  echo "Setelah build selesai, jalankan di VPS:"
  echo "  cd /opt/premdev && sudo docker compose pull app && sudo docker compose up -d --force-recreate app"
  echo "========================================="
fi
