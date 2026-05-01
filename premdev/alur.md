# Alur PremDev — Panduan Detail Isi Repository

Dokumen ini menjelaskan **semua isi folder Git** PremDev secara berurutan: apa fungsinya, bagaimana saling terhubung, dan bagaimana alur jalannya dari kode di Replit sampai aplikasi hidup di VPS `flixprem.org`.

---

## 1. Gambaran Besar (1 Menit)

PremDev adalah klon Replit untuk dipakai sendiri (~10 user) yang dipasang di satu VPS Ubuntu.

```
Anda ngoding di Replit
        │
        │  git push
        ▼
   GitHub (maraazn069/premdev)
        │
        │  GitHub Actions otomatis:
        │  - Build Docker image
        │  - Push ke GHCR (ghcr.io/maraazn069/premdev)
        │  - SSH ke VPS, jalankan `docker compose pull && up -d`
        ▼
   VPS 20.200.209.228
        │
        │  Caddy (port 80/443) ─ SSL wildcard via Cloudflare DNS
        ├── app  : aplikasi Node (API + frontend React)
        ├── mysql: database user (per-user dengan prefix nama)
        ├── phpmyadmin: UI MySQL di db.flixprem.org
        └── pw_<workspaceId> : container per workspace user (dibuat on-demand)
        ▼
   User akhir buka https://app.flixprem.org
```

---

## 2. Struktur Folder Top-Level

```
premdev/
├── apps/                     ← KODE APLIKASI
│   ├── api/                  ← Backend Node + Fastify
│   └── web/                  ← Frontend React + Vite
├── infra/                    ← KONFIGURASI VPS
│   ├── install.sh            ← Installer interaktif untuk VPS
│   ├── docker-compose.prod.yml
│   ├── Caddyfile.tmpl        ← Template reverse-proxy + SSL
│   ├── caddy/Dockerfile      ← Image Caddy + plugin Cloudflare
│   └── runtime/Dockerfile    ← Image untuk container workspace user
├── .github/workflows/
│   └── deploy.yml            ← CI/CD: build → push GHCR → deploy VPS
├── Dockerfile                ← Image aplikasi utama (API + web build)
├── .dockerignore
├── .env.example              ← Contoh variabel lingkungan
├── package.json              ← Skrip dev untuk Replit
├── README.md                 ← Dokumentasi user akhir
└── replit.md                 ← Memori jangka panjang untuk asisten Replit
```

---

## 3. `apps/api/` — Backend (Otak Aplikasi)

Stack: **Node.js 20 + Fastify + TypeScript + better-sqlite3 + Dockerode**.

```
apps/api/
├── package.json
├── tsconfig.json
├── data/                       ← (runtime) sqlite + workspaces user di mode dev
└── src/
    ├── index.ts                ← Entry point: bootstrap Fastify + register routes
    ├── lib/                    ← Helper / business logic
    │   ├── config.ts           ← Baca env (.env), validasi, default
    │   ├── db.ts               ← SQLite (users, workspaces, sessions, settings, checkpoints)
    │   ├── mysql.ts            ← Provisioning DB user dengan prefix
    │   ├── auth-helpers.ts     ← JWT, hash bcrypt, requireUser, requireAdmin
    │   ├── runtime.ts          ← Bicara ke Docker (start/stop container, exec, log)
    │   ├── checkpoints.ts      ← Snapshot tar.gz workspace + restore + mutex
    │   ├── ai-settings.ts      ← Enkripsi AES-256-GCM API key AI di DB
    │   └── templates.ts        ← Template starter (blank, node, python, dll.)
    └── routes/                 ← Endpoint HTTP/WebSocket
        ├── auth.ts             ← /api/auth/login, /me, /logout
        ├── workspaces.ts       ← CRUD workspace + restart/exec/checkpoints
        ├── files.ts            ← Read/write/rename/delete file, upload/download zip
        ├── terminal.ts         ← WebSocket /ws/terminal/:id (PTY ke container)
        ├── ai.ts               ← /api/ai/chat (5 provider) + autopilot
        ├── admin.ts            ← /admin/users, /admin/ai-keys
        ├── db.ts               ← Endpoint terkait MySQL user
        └── proxy.ts            ← Proxy preview port di mode dev
```

### Alur Request Khas
1. Browser kirim `POST /api/auth/login` → `routes/auth.ts` cek bcrypt → set cookie JWT.
2. Browser kirim `GET /api/workspaces` → middleware `requireUser` (auth-helpers) → `routes/workspaces.ts` query SQLite → balas JSON.
3. User buka workspace → frontend pasang WebSocket ke `/ws/terminal/:id` → `routes/terminal.ts` panggil `runtime.ts` untuk `docker exec` ke `pw_<id>` dan stream stdout/stdin.
4. User minta AI → `routes/ai.ts` ambil key (DB dulu, fallback `.env`) → forward ke OpenAI/Anthropic/Google/OpenRouter/Groq.
5. AI autopilot menyarankan tindakan → frontend tampilkan kartu Approve/Skip → bila disetujui memanggil `/exec`, `/restart`, atau `/checkpoint`.

### Catatan Keamanan
- `safePath()` di `files.ts` memakai `path.relative` untuk anti path-traversal.
- Upload zip diperiksa zip-slip di `workspaces.ts`.
- API key AI tersimpan terenkripsi (AES-256-GCM) di tabel `settings`.
- `ai-settings.ts` mengingatkan bila `JWT_SECRET` masih lemah/default.
- Eksekusi shell user dibungkus `timeout --kill-after=2s Ns` agar benar-benar terhenti.

---

## 4. `apps/web/` — Frontend (Antarmuka User)

Stack: **React 18 + Vite + TailwindCSS + Monaco editor + xterm.js + Zustand + React Query**.

```
apps/web/
├── package.json
├── vite.config.ts             ← `server.allowedHosts: true` agar preview Replit jalan
├── tailwind.config.js
├── index.html
├── dist/                      ← Hasil build (di-serve oleh Fastify di production)
└── src/
    ├── main.tsx               ← Mount React + router
    ├── App.tsx                ← Router (Login → Layout → halaman)
    ├── styles/global.css
    ├── components/
    │   ├── Layout.tsx         ← Shell: sidebar + header
    │   ├── AIChat.tsx         ← Panel asisten AI + parser autopilot
    │   ├── Terminal.tsx       ← xterm.js terhubung ke /ws/terminal
    │   └── ConfirmDialog.tsx  ← Modal konfirmasi (ganti window.confirm)
    └── pages/
        ├── Login.tsx
        ├── Dashboard.tsx      ← Daftar workspace + tombol "Buat baru"
        ├── Editor.tsx         ← Monaco + file tree + terminal + AI chat
        ├── Admin.tsx          ← Kelola user + edit API key AI
        └── Settings.tsx       ← Profil + ganti password
```

### Alur Editor (Halaman Paling Padat)
1. `Editor.tsx` mount → fetch daftar file via `/files` → render file tree.
2. Pilih file → fetch isi → tampilkan di Monaco.
3. User mengetik → onChange men-debounce 1.5 dtk → kirim `PUT /files`.
   - Pakai `saveGenRef` & `lastEditGenRef` agar ACK lama tidak menghapus status "dirty" dari edit baru (anti race condition).
4. Tombol Run/Restart → `POST /workspaces/:id/restart`.
5. Tombol Checkpoints → modal daftar snapshot → restore membuat backup otomatis dulu.
6. Klik kanan file → menu Rename / Hapus / Download zip / Upload zip (pakai `ConfirmDialog` untuk yang destruktif).
7. Panel AI di kanan: pilih provider+model, mode autopilot, lihat kartu aksi yang bisa Approve/Skip per langkah.

---

## 5. `infra/` — Semua Konfigurasi VPS

### `infra/install.sh`
Installer interaktif satu kali untuk VPS Ubuntu 22.04/24.04. Dijalankan via `sudo bash infra/install.sh`. Menanyakan:
- Domain (default `flixprem.org`)
- Cloudflare API token (untuk wildcard SSL DNS-01)
- Admin username / email / password
- API key AI (opsional)
- Password MySQL (auto-generate kalau kosong)

Lalu otomatis:
1. Pasang Docker + Compose
2. Buka firewall UFW (22, 80, 443)
3. Buat folder `/opt/premdev` & `/opt/premdev/data`
4. Build image Caddy custom (dengan plugin Cloudflare DNS)
5. Build image runtime user (multi-bahasa)
6. Tarik image aplikasi dari GHCR
7. `docker compose up -d`

### `infra/docker-compose.prod.yml`
Definisi 4 service yang saling terhubung di network `premdev_net`:

| Service | Image | Tugas |
|---|---|---|
| `caddy` | build dari `caddy/Dockerfile` | Reverse proxy + SSL wildcard. Mount socket Docker (read-only) untuk resolusi container preview. |
| `mysql` | `mysql:8.4` | Database user. Volume `mysql_data`. |
| `phpmyadmin` | `phpmyadmin:5-apache` | UI MySQL di `db.flixprem.org`. |
| `app` | `${GHCR_IMAGE}` (image kita) | Aplikasi PremDev. Mount socket Docker (RW) untuk membuat container workspace + folder data. |

### `infra/Caddyfile.tmpl`
Template yang disubstitusi `install.sh` jadi `Caddyfile` aktif. Routing:

| Domain | Tujuan |
|---|---|
| `flixprem.org`, `app.flixprem.org` | container `app:3001` |
| `admin.flixprem.org` | container `app:3001` (alias) |
| `db.flixprem.org` | container `phpmyadmin:80` |
| `<port>-<id>.preview.flixprem.org` | container `pw_<id>:<port>` (regex extract) |
| `<name>.app.flixprem.org` | container `deploy_<name>:3000` |

SSL otomatis via DNS-01 Cloudflare → bisa wildcard tanpa harus expose port 80 untuk verifikasi.

### `infra/caddy/Dockerfile`
Build custom Caddy + plugin `caddy-dns/cloudflare` agar bisa wildcard SSL.

### `infra/runtime/Dockerfile`
Image `pw_runtime` yang dipakai semua container workspace user. Berisi: Python, Node.js, PHP, Go, Rust, Java, Ruby, C/C++ — sehingga user bisa langsung jalan tanpa install.

---

## 6. `Dockerfile` (root) — Image Aplikasi Utama

Dua tahap (multi-stage):
1. **builder**: `node:20-bookworm-slim` + python3/g++ untuk compile native module (better-sqlite3). Install dependency, build frontend (`vite build`), build backend (`tsc`), tambahkan `node-pty`.
2. **runtime**: `node:20-bookworm-slim` + ca-certificates, curl, tini, **docker.io** (CLI untuk operasi container), git. Copy hasil build saja. Healthcheck ke `/api/health`. Entry pakai `tini` agar PID 1 bersih.

Image ini yang dipakai service `app` di `docker-compose.prod.yml`.

---

## 7. `.github/workflows/deploy.yml` — Pipeline CI/CD

Trigger: setiap push ke `main` (atau manual via `workflow_dispatch`).

**Job 1: build**
1. Checkout
2. Login ke GHCR pakai token bawaan
3. Tag: `latest` + SHA commit
4. Build image dengan cache GitHub Actions
5. Push ke `ghcr.io/maraazn069/premdev`

**Job 2: deploy** (hanya pada push, bukan dispatch)
1. SSH ke VPS pakai `appleboy/ssh-action`
2. `cd /opt/premdev`
3. Login GHCR (kalau image private, pakai `GHCR_PAT`)
4. `docker compose pull app`
5. `docker compose up -d app` (rolling restart)
6. `docker image prune -f`
7. Cek health di `/api/health`

Secret yang harus diset di GitHub repo:

| Secret | Isi |
|---|---|
| `VPS_HOST` | `20.200.209.228` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | isi file `~/.ssh/id_ed25519` privat |
| `VPS_PORT` | `22` (opsional) |
| `GHCR_USER` | `maraazn069` |
| `GHCR_PAT` | PAT dengan scope `read:packages` |

---

## 8. File Pendukung di Root

| File | Fungsi |
|---|---|
| `package.json` | Skrip `dev` (jalankan API+Web paralel di Replit), `build`, `start`. Hanya `concurrently` di devDeps. |
| `package-lock.json` | Lock dependency level workspace. |
| `.env.example` | Template variabel lingkungan: `JWT_SECRET`, `ADMIN_*`, `MYSQL_*`, key AI, `CF_API_TOKEN`, `LE_EMAIL`, dll. |
| `.dockerignore` | Hindari `node_modules`, `data/`, `.git` masuk image. |
| `.gitignore` | Standar Node + `data/` + `.env`. |
| `README.md` | Dokumen user akhir: arsitektur, install, ops harian. |
| `replit.md` | "Memori" untuk asisten Replit (saya). Diperbarui setiap perubahan signifikan. |
| `.replit` | Konfigurasi workflow Replit (perintah `npm run dev`). |

---

## 9. Alur Lengkap dari Kode ke Production

### A. Mode Pengembangan (di Replit ini)
```
npm run dev
   ├── apps/api : tsx watch src/index.ts  → Fastify port 3001
   └── apps/web : vite --host 0.0.0.0 --port 5000
```
- Tidak ada Docker → `runtime.ts` mendeteksi tidak ada socket Docker dan jatuh ke "local process runtime" (workspace berjalan sebagai proses Node biasa di disk Replit).
- SQLite di `apps/api/data/premdev.sqlite`.
- Login default: `admin` / `admin1234`.

### B. Push ke GitHub
```bash
git add -A
git commit -m "deskripsi perubahan"
git push origin main
```

### C. GitHub Actions Otomatis Berjalan
1. Build image multi-stage (5–8 menit pertama, <2 menit selanjutnya berkat cache).
2. Push ke `ghcr.io/maraazn069/premdev:latest` + tag SHA.
3. SSH ke VPS, jalankan `docker compose pull app && up -d app`.
4. Kirim ping ke `/api/health` untuk konfirmasi sukses.

### D. Di VPS (`/opt/premdev`)
- Caddy sudah berjalan permanen → trafik HTTPS langsung diterima.
- Service `app` berhenti ~2 detik lalu hidup pakai image baru. Healthcheck memastikan ready.
- Container workspace user (`pw_<id>`) tidak ikut restart.

### E. User Akhir
Buka `https://app.flixprem.org` → Login → buat workspace → kode + jalankan + dapat URL preview `https://3000-<workspaceId>.preview.flixprem.org` otomatis SSL.

---

## 10. Perintah Penting Sehari-hari

### Di Replit
```bash
npm run dev                    # jalankan dev
npm run build                  # build manual (validasi sebelum push)
git add -A && git commit -m "x" && git push
```

### Di VPS
```bash
cd /opt/premdev

docker compose ps                       # status semua service
docker compose logs -f app              # log aplikasi
docker compose logs -f caddy            # log proxy/SSL
docker compose pull app && docker compose up -d app   # update manual

sudo nano /opt/premdev/.env             # ubah env (mis. tambah API key)
docker compose up -d                    # apply env baru

docker compose exec mysql mysql -uroot -p   # masuk MySQL CLI
```

### Mengelola Container Workspace User
```bash
docker ps --filter name=pw_              # lihat workspace aktif
docker logs pw_<workspaceId>             # log workspace tertentu
docker stop pw_<workspaceId>             # paksa stop
```

---

## 11. Hal Penting yang Tidak Boleh Terlupa

1. **Cloudflare DNS harus DNS only** (ikon awan abu-abu), bukan Proxied — supaya DNS-01 challenge berhasil dan trafik WS jalan.
2. **`JWT_SECRET` wajib diganti** jadi string acak ≥ 32 karakter di `/opt/premdev/.env`. Banner kuning di Admin akan muncul kalau masih lemah.
3. **API key AI bisa diisi via Admin UI** (lebih aman, terenkripsi di DB) — tidak harus diset di `.env`.
4. **Image GHCR private**: pastikan `GHCR_PAT` ada di GitHub Secrets, atau ubah image jadi public di GitHub → Packages → Settings.
5. **Backup**: volume `mysql_data`, `caddy_data`, dan folder `/opt/premdev/data/workspaces` adalah aset berharga. Backup berkala pakai `tar` atau snapshot VPS.
6. **Firewall**: hanya 22/80/443 yang dibuka. MySQL hanya diakses internal lewat `phpmyadmin`.
7. **Bahasa default chat AI Indonesia** — diatur di `replit.md` dan diingat asisten.

---

## 12. Ringkasan Satu Halaman

| Bagian | Lokasi | Apa yang Terjadi |
|---|---|---|
| Anda ngoding | Replit | Edit di `apps/api/src/...` & `apps/web/src/...` |
| Push | `git push origin main` | Kode masuk GitHub |
| Build & publish | `.github/workflows/deploy.yml` | Image dibuat & disimpan di GHCR |
| Deploy | SSH ke VPS otomatis | `docker compose pull && up -d` |
| Hidup | VPS `/opt/premdev` | Caddy ⇄ App ⇄ MySQL ⇄ Workspace containers |
| Akses user | `https://app.flixprem.org` | Login, ngoding, terminal, AI, preview |

Selesai. Kalau butuh bagian tertentu diperdalam (mis. detail kode `runtime.ts`, format checkpoint, atau cara Caddy resolve hostname container), tinggal bilang bagian mana.
