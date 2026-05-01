#!/bin/bash
# Push semua perubahan ke GitHub
# Jalankan: bash push-ai-improvements.sh

set -e

git config user.email "agent@premdev.local"
git config user.name "PremDev Agent"

echo "Status repo:"
git --no-optional-locks status
echo ""
echo "Log 3 commit terakhir:"
git --no-optional-locks log --oneline -3
echo ""

echo "Pushing ke GitHub..."
git push origin main

echo ""
echo "========================================="
echo "Push berhasil!"
echo "Tunggu GitHub Actions build (~3-5 menit)"
echo "Cek: https://github.com/maraazn069/premdev/actions"
echo ""
echo "Setelah build selesai, jalankan di VPS:"
echo ""
echo "  # Fix permission workspace lama (sekali saja):"
echo "  chown -R 1000:1000 /opt/premdev/data/workspaces/"
echo ""
echo "  # Lalu deploy ulang:"
echo "  cd /opt/premdev && sudo docker compose pull app && sudo docker compose up -d --force-recreate app"
echo "========================================="
