# Perintah PremDev — Cheat Sheet

Semua perintah yang sering dipakai untuk maintain server PremDev.
Domain: **flixprem.org** · IP: **20.200.209.228**

---

## 1. Push perubahan kode dari Replit

Buka **Shell** di Replit (bukan Console), lalu:

```bash
git add -A
git commit -m "deskripsi singkat perubahan"
git push
```

> Kalau diminta username/password GitHub, gunakan **Personal Access Token** (bukan password GitHub asli).

---

## 2. Login ke VPS via SSH

Dari laptop / Termux:

```bash
ssh root@20.200.209.228
sudo -i
# password: yang sama saat install Ubuntu
```

---

## 3. Update server ke versi terbaru (sering dipakai!)

Setelah `git push` di Replit, jalankan ini di VPS:

```bash
sudo /usr/local/sbin/premdev-redeploy
```

Apa yang dilakukan script ini:
- Pull commit terbaru dari GitHub
- Rebuild image API + Web (kalau berubah)
- Restart container
- Refresh script ops (`backup`, `monitor`, `bot`, `restore`, `trigger`)
- Restart bot Telegram kalau perlu

> Tidak menghapus data user. Aman dijalankan kapan saja.

### Kalau dapat `command not found`

Artinya install lama (sebelum patch yang nge-copy `redeploy.sh` ke `/usr/local/sbin/`). Jalankan ini sekali, langsung pull dari GitHub tanpa file lokal:

```bash
curl -fsSL https://raw.githubusercontent.com/maraazn069/premdev/main/infra/redeploy.sh | sudo bash
```

Setelah itu, mulai redeploy berikutnya `sudo /usr/local/sbin/premdev-redeploy` sudah ada (karena redeploy script sendiri akan menyalin versi terbaru dirinya ke `/usr/local/sbin/`).

---

## 4. Install dari NOL (server kosong / pindah VPS)

Cuma sekali, di server Ubuntu 22.04+ yang masih bersih. **Download dulu, baru jalankan** — JANGAN pipe langsung ke bash, karena prompt interaktif butuh terminal kamu untuk baca input:

```bash
curl -fsSL https://raw.githubusercontent.com/maraazn069/premdev/main/infra/install.sh -o /tmp/install.sh
sudo bash /tmp/install.sh
```

> **Kenapa dipisah?** Kalau pakai `curl ... | sudo bash`, stdin bash jadi pipe dari curl (isinya body script). Setiap `read` di prompt interaktif justru baca BARIS BERIKUTNYA dari install.sh sendiri sebagai "jawaban" — `.env` jadi corrupt diam-diam (PRIMARY_DOMAIN keisi `prompt PREVIEW_DOMAIN ...`, dst). Patch di install.sh sekarang sudah memaksa baca dari `/dev/tty` jadi pipe-bash juga aman, tapi pola download-then-run lebih jelas dan portable.

Saat prompt:
- **Domain utama** → `flixprem.org`
- **Cloudflare API token** → buat di dashboard CF → My Profile → API Tokens → token dengan permission `Zone:DNS:Edit` untuk zone flixprem.org
- **MySQL passwords** → ENTER untuk auto-generate (catat di tempat aman)
- **R2 (Cloudflare)** → kalau punya: isi access key, secret, endpoint, bucket. Kalau belum: ENTER (skip backup)
- **Telegram bot token** → dari @BotFather (lihat bagian 7)
- **Telegram chat ID** → dari @userinfobot (User ID kamu)
- **Admin user ID untuk bot** → ENTER (default = chat ID di atas)

Selesai, install butuh 5–10 menit. Setelah selesai, akses `https://flixprem.org`.

---

## 5. Edit env / setting via SSH

File env utama (semua container baca dari sini):

```bash
sudo nano /opt/premdev/.env
```

File env subset untuk cron backup (mode 600):

```bash
sudo nano /etc/premdev/backup.env
```

Setelah edit, container yang relevan harus **di-recreate** (bukan cuma restart!) supaya nilai baru di-load:

| Yang diubah | Perintah |
|---|---|
| `PRIMARY_DOMAIN`, `PREVIEW_DOMAIN`, `DEPLOY_DOMAIN`, `COOKIE_DOMAIN` | `cd /opt/premdev && set -a; . .env; set +a && envsubst < data/caddy/Caddyfile.tmpl > data/caddy/Caddyfile && sudo docker compose up -d --force-recreate app caddy` |
| `*_PORT`, runtime image | `sudo /usr/local/sbin/premdev-redeploy` |
| Quota, JWT_SECRET, AI keys, MySQL password | `cd /opt/premdev && sudo docker compose up -d --force-recreate app` |
| Caddyfile / Cloudflare token (bukan domain) | `cd /opt/premdev && sudo docker compose up -d --force-recreate caddy` |
| Telegram bot token / admin ID | `sudo systemctl restart premdev-bot` |
| R2 / backup secret | tidak perlu restart (cron baca file langsung) |

> **PENTING:** Jangan pakai `docker compose restart` setelah edit `.env`. Restart hanya stop+start proses di dalam container yang sudah ada — env vars sudah di-bake saat container pertama kali dibuat (`up`). Untuk apply perubahan `.env` harus `up -d --force-recreate`. Gejala kalau salah: `cat .env` keliatan benar, tapi `docker exec <container> env` masih nilai lama.

> **Lebih praktis:** pakai bot Telegram → `/setenv KEY VALUE` (otomatis ngasih hint recreate).

---

## 6. Perintah harian via Bot Telegram

Setelah setup bot (lihat bagian 7), kirim ke bot kamu:

| Perintah | Fungsi |
|---|---|
| `/help` | Daftar semua perintah |
| `/stats` | CPU, RAM, disk, uptime, jumlah container |
| `/df` | Detail pemakaian disk + docker |
| `/diskhog` | 10 folder paling besar (cek kenapa disk penuh) |
| `/docker` | Status container + resource per container |
| `/users` | Daftar user app |
| `/env` | List semua env (tier 2 dimask) |
| `/getenv KEY` | Lihat full value 1 var |
| `/setenv KEY VALUE` | Ubah env (atomic, escape aman) |
| `/restart app` | Restart API |
| `/restart caddy` | Restart Caddy |
| `/restart mysql` | Restart MySQL |
| `/restart all` | Restart semua compose |
| `/logs app 100` | Tail 100 baris log container `app` |
| `/backup` | Trigger backup ke R2 sekarang |
| `/monlog` | Lihat log monitoring terakhir |

> Bot **hanya** respon ke chat ID kamu. Pesan dari user lain di-drop diam-diam.

---

## 7. Setup Bot Telegram (sekali saja)

1. Di Telegram, chat **@BotFather** → `/newbot` → ikuti petunjuk → catat `BOT_TOKEN`.
2. Chat **@userinfobot** → catat `Id` (angka, contoh: `123456789`).
3. Di VPS, edit `/opt/premdev/.env`:
   ```bash
   sudo nano /opt/premdev/.env
   ```
   Cari/tambahkan:
   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_ADMIN_CHAT_ID=123456789
   ADMIN_TELEGRAM_ID=123456789
   ```
4. Sync ke `/etc/premdev/backup.env`:
   ```bash
   sudo nano /etc/premdev/backup.env
   ```
   Pastikan ada juga `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_ADMIN_CHAT_ID` (sama persis).
5. Restart bot:
   ```bash
   sudo systemctl restart premdev-bot
   sudo systemctl status premdev-bot   # harus "active (running)"
   ```
6. Di Telegram, kirim `/help` ke bot → harus muncul daftar perintah.

> Atau lebih cepat: jalankan `install.sh` lagi (idempotent), saat prompt isi token + chat ID. Script otomatis tulis ke kedua file dan start service.

---

## 8. Backup & Restore

### Otomatis
- **Daily** jam 03:00 lewat `cron.daily/premdev-backup` → upload ke R2 (retention 7 daily + 4 weekly).
- **Hourly** monitoring → notif Telegram kalau disk >85% / SSL <14 hari / health gagal.

### Manual via Web
Login ke `https://flixprem.org` → **Admin** → tab **Backup**:
- **Run backup now** — trigger backup ke R2
- **Refresh** — re-list snapshot dari R2
- **Restore** per-snapshot (perlu ketik path snapshot persis sebagai konfirmasi)

### Manual via SSH
```bash
sudo /usr/local/sbin/premdev-backup           # backup sekarang
sudo /usr/local/sbin/premdev-restore daily/20260428-031500   # restore
sudo /usr/local/sbin/premdev-refresh-index    # update list snapshot
```

> **Restore destruktif**: stop app → replace SQLite + MySQL + workspaces. Selalu otomatis bikin "safety dump" di `/var/backups/premdev-pre-restore-*` sebelum restore — kalau salah, file ini bisa dipakai rollback manual.

---

## 9. Cek log kalau ada masalah

| Service | Perintah |
|---|---|
| API | `cd /opt/premdev && docker compose logs -f app` |
| Caddy | `cd /opt/premdev && docker compose logs -f caddy` |
| MySQL | `cd /opt/premdev && docker compose logs -f mysql` |
| Bot Telegram | `journalctl -u premdev-bot -f` |
| Backup | `tail -f /var/log/premdev-backup.log` |
| Restore | `tail -f /var/log/premdev-restore.log` |
| Monitor | `tail -f /var/log/premdev-monitor.log` |
| Trigger runner | `tail -f /var/log/premdev-trigger.log` |

---

## 10. User & Admin

Buat user pertama (admin) — sekali saja setelah install:

```bash
cd /opt/premdev
docker compose exec app node /app/apps/api/dist/scripts/create-admin.js \
  USERNAME EMAIL PASSWORD
```

Setelah itu, kelola user via Web → **Admin** → **Users**.

---

## 11. Troubleshooting cepat

| Gejala | Cek |
|---|---|
| Web tidak bisa diakses | `cd /opt/premdev && docker compose ps` — pastikan `caddy` & `app` running |
| 502 Bad Gateway | `docker compose logs caddy` + `docker compose logs app` |
| SSL error | `docker compose logs caddy` — cek apakah Cloudflare API token valid |
| Bot Telegram diam | `journalctl -u premdev-bot -n 50` — cek token + chat ID |
| Disk penuh | Bot: `/diskhog` atau SSH: `du -sh /opt/premdev/data/* /var/lib/docker/* \| sort -h` |
| Backup gagal | `tail -100 /var/log/premdev-backup.log` |
| Workspace user error | `docker logs ws-USERNAME-WORKSPACEID` |

---

## 12. Stop / Start manual semua service

```bash
cd /opt/premdev
docker compose stop      # stop semua
docker compose start     # start lagi
docker compose down      # stop + remove container (data tetap aman)
docker compose up -d     # start dari scratch (rebuild kalau perlu)
```

---

> **Tip:** simpan file ini di laptop. Setiap kali bingung "perintahnya apa ya", buka file ini lebih cepat daripada cari di chat.
