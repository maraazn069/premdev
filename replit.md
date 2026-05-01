# PremDev — Self-hosted cloud IDE

---

## ⚠️ OPERATOR NOTES — WAJIB DIBACA AI AGENT BERIKUTNYA

---

## ✅ COMPLETED TASKS (01 Mei 2026)

### TASK A — VPS Filesystem Browser ✅ DONE

**Apa:** Fitur di dalam premdev IDE yang memungkinkan user browse dan edit **semua file di VPS**, mulai dari root `/` — bukan hanya file dalam workspace. Termasuk `/etc`, `/opt`, `/home`, `/var`, dll. Ini bukan hanya config editor, tapi full file manager untuk seluruh sistem VPS.

**Konteks:** User pakai CasaOS di VPS. Mereka mau bisa lihat dan edit file sistem VPS (termasuk `.env` premdev, `docker-compose.yml`, Caddyfile, dll) langsung dari browser tanpa perlu SSH. Ini ibaratnya "File Manager VPS" yang terintegrasi di halaman Admin premdev.

**Cara kerja teknis yang direncanakan:**

1. **Docker volume mount (user harus lakukan via SSH sekali saja):**
   - Edit `docker-compose.yml` di VPS: tambah volume `- /:/vpsroot:rw` ke service `app`
   - Ini mount host filesystem ke dalam container di path `/vpsroot`
   - Contoh perintah SSH untuk user: `sudo nano /opt/premdev/docker-compose.yml` → tambah di bagian `volumes:` service `app`:
     ```yaml
     - /:/vpsroot:rw
     ```
   - Lalu restart: `sudo docker compose up -d app`

2. **Backend — route baru `apps/api/src/routes/vfs.ts`:**
   - `GET /api/vfs/list?path=/etc` — list isi directory
   - `GET /api/vfs/read?path=/etc/hostname` — baca isi file (max 5MB)
   - `POST /api/vfs/write` body `{path, content}` — tulis file
   - `POST /api/vfs/mkdir` body `{path}` — buat directory
   - `DELETE /api/vfs/delete?path=...` — hapus file/dir
   - Semua route: **admin-only** (pakai `requireAdmin` atau JWT role check yang sama dengan admin routes lain)
   - Base path di container: `/vpsroot` (dari env var `VFS_ROOT`, default `/vpsroot`)
   - Path sanitization: `path.resolve("/vpsroot", userPath)` + cek hasilnya tetap diawali `/vpsroot` (anti path-traversal, walau di sini kita memang mau full access)
   - Register di `apps/api/src/index.ts`: `await api.register(vfsRoutes, { prefix: "/vfs" })`

3. **Frontend — halaman/panel baru:**
   - Tambah tab "VPS Files" di halaman Admin (`apps/web/src/pages/Admin.tsx`) ATAU buat page baru `apps/web/src/pages/VFS.tsx`
   - Komponen file tree: breadcrumb navigasi, list file/folder, ikon folder vs file
   - Klik file teks → editor (textarea atau CodeMirror yang sudah ada)
   - Tombol Save, Delete, New Folder, Upload
   - Warning banner merah di atas: "⚠️ Ini akses langsung ke filesystem VPS. Hati-hati saat mengedit file sistem — salah edit `/etc` bisa bikin VPS tidak bisa boot."
   - Binary files (gambar, exe, dll): tampilkan info size + "Binary file — tidak bisa diedit" saja

4. **Env var baru yang dibutuhkan:**
   - `VFS_ROOT=/vpsroot` — bisa di-override kalau user mount di path lain

**Catatan implementasi:**
- Jika `/vpsroot` tidak ada (user belum tambah volume mount), endpoint `/vfs/list?path=/` harus kasih error yang jelas: "VPS filesystem belum di-mount. Lihat panduan setup di halaman Admin."
- Tampilkan path aslinya ke user (strip `/vpsroot` prefix di response, tunjukkan `/etc` bukan `/vpsroot/etc`)
- File yang direkomendasikan untuk di-bookmark: `/opt/premdev/.env`, `/opt/premdev/docker-compose.yml`, `/etc/caddy/Caddyfile` atau `/opt/premdev/infra/Caddyfile`

---

### TASK B — Refactor `apps/api/src/routes/ai.ts` ✅ DONE

**Apa:** File `ai.ts` sekarang 1.677+ baris — semua logic AI campur dalam satu file (context builder, streaming providers, prompt templates, HTTP routes, auto-tier config). User minta dirapikan jadi modul-modul terpisah yang lebih maintainable. Tetap TypeScript/Node.js (bukan Python).

**Target struktur setelah refactor:**
```
apps/api/src/
├── routes/
│   └── ai.ts                 ← TIPIS: hanya HTTP handlers + route registration (~200 baris)
└── lib/
    ├── ai-jobs.ts            ← sudah ada, tidak diubah
    ├── ai-settings.ts        ← sudah ada, tidak diubah
    ├── ai-providers.ts       ← BARU: semua stream* functions
    │                            (streamProvider, streamProviderAuto, streamOpenAICompat,
    │                             streamAnthropic, streamGoogle, streamGoogleSingle,
    │                             streamOpenAICompat options type, fetchGoogleModels,
    │                             fetchSnifoxModels, KEY_FAILOVER_STATUSES,
    │                             AUTO_TIERS, TEXT_ONLY_MODEL_PATTERNS, isTextOnlyModel,
    │                             PROVIDER_MODELS, DEFAULT_MODELS, GEMINI_FREE_TIER)
    ├── ai-context.ts         ← BARU: workspace context builders
    │                            (buildWorkspaceContext, buildWorkspaceDbHint,
    │                             buildRelevantSnippets, loadProjectMemory,
    │                             sniffDatabaseSchema, detectProjectHints,
    │                             SEARCH_TOP_K, LONG_CONTEXT_THRESHOLD)
    └── ai-prompt.ts          ← BARU: prompt templates + message utils
                                 (AUTO_PILOT_PROMPT, CONT_TRUNC_INSTRUCTION,
                                  trimHistory, clampMessage, parseDataUrl,
                                  MAX_HISTORY_CHARS, AI_MAX_TOKENS_AUTOPILOT,
                                  ChatMsg type, Provider type, PROVIDER_LABELS)
```

**Aturan refactor:**
- TIDAK ada perubahan fungsional — semua behavior, semua logic sama persis
- Export semua yang dibutuhkan, import di `ai.ts` (yang jadi tipis)
- Jalankan `pnpm --filter @premdev/api build` setelah selesai — wajib GREEN sebelum commit
- Lakukan BERTAHAP: extract satu modul, build, lanjut — jangan extract semua sekaligus lalu build, terlalu berisiko
- Urutan yang aman: `ai-prompt.ts` dulu (paling sedikit dependensi), lalu `ai-context.ts`, lalu `ai-providers.ts`, terakhir rapikan `ai.ts`

---
- **User adalah pemula** dalam Linux/SSH/Docker. Setiap perintah SSH/VPS yang dikasih ke user **WAJIB**:
  - Dijelaskan dalam Bahasa Indonesia santai
  - Dipecah jadi langkah kecil — JANGAN pernah kasih satu mega-script panjang yang memuat `rm -rf`, `mv`, atau `docker rm` tanpa user konfirmasi per-langkah
  - Kasih warning eksplisit kalau ada perintah destruktif (rm, mv ke /tmp, docker rm/volume rm)
- Repo ini di Replit cuma dipakai sebagai **mirror kode untuk push ke GitHub**. App TIDAK dijalankan di Replit. Workflow Replit yang gagal (`Start application failed`) adalah hal **NORMAL** — jangan coba start, jangan coba install dependencies. App jalan di VPS lewat Docker.
- Workflow user: **edit di Replit → commit & push via tab Git Replit → SSH ke VPS → jalanin redeploy/git pull**.

### 1a. WAJIB DI AWAL SETIAP CHAT BARU
1. **Tarik kode terbaru dari GitHub** sebelum mulai kerjain task apapun. Repo lokal Replit bisa ketinggalan dari `main` di GitHub karena user kadang push langsung dari device lain. Jalankan:
   ```bash
   cd /home/runner/workspace && git pull origin main 2>&1
   ```
   Kalau ada konflik, kasih tau user sebelum lanjut.

2. **Tanya format SSH user** sebelum kasih perintah SSH apapun (kalau task melibatkan VPS). Format umum: `ssh username@ip` atau `ssh username@domain`. User saat ini biasanya pakai `ssh root@flixprem.org`, tapi konfirmasi dulu kalau ragu.

3. **Wajib jelasin perintah escalation root** waktu pertama kali muncul di chat:
   - `sudo -i` = jadi root permanen sampai exit (prompt berubah jadi `root@host:~#`). Pakai untuk session multi-perintah yang butuh root.
   - `sudo -e <file>` = edit file pakai editor default sebagai root, aman karena bikin temp copy dulu.
   - `sudo <perintah>` = jalanin satu perintah aja sebagai root, balik ke user biasa setelah selesai.
   - `exit` = keluar dari sesi root, balik ke user biasa.
   Selalu kasih konteks **kenapa** perlu root (misal: "harus root karena nulis ke /opt/premdev yang dimiliki root").

4. **GitHub Personal Access Token** — user udah setup token di Replit shell via:
   ```bash
   git remote set-url origin https://maraazn069:GHP_TOKEN@github.com/maraazn069/premdev.git
   ```
   Token tersimpan di `.git/config` lokal Replit (tidak ke-commit). Kalau `git push` error `Authentication failed`, berarti token expired/revoked — minta user generate baru di https://github.com/settings/tokens (scope: `repo`), lalu jalanin ulang `git remote set-url` di atas dengan token baru. **JANGAN pernah commit file yang berisi token mentah** (cek `.gitignore`, hati-hati saat edit `.git/config` atau bikin script setup).

### 1c. Persistent AI run — survive tab close / refresh (29 Apr 2026)
Sebelumnya `POST /api/ai/chat` streaming langsung ke socket reply, jadi kalau user close tab atau refresh ⇒ socket close ⇒ AbortController fire ⇒ upstream stream cancel ⇒ AI mati di tengah jalan. User balik ke tab dengan reply setengah jadi & harus re-prompt. Sekarang AI run di-decoupling dari HTTP request lifecycle:

1. **`POST /api/ai/chat`** sekarang return `{ jobId }` instan. Streaming upstream provider jalan di background (lihat `apps/api/src/lib/ai-jobs.ts`).
2. **`GET /api/ai/chat/jobs/:id/stream?offset=N`** — SSE endpoint. Replay dari byte `N` (untuk reconnect setelah refresh) lalu tail chunk baru. Heartbeat tiap 20s biar proxy gak reap koneksi idle saat Gemini "thinking" lama.
3. **`GET /api/ai/chat/jobs/active?workspaceId=…`** — list job yang masih running (untuk recovery UI di future).
4. **`POST /api/ai/chat/jobs/:id/abort`** — user-initiated stop, abort upstream stream di server.

**Client (`AIChat.tsx`)**:
- `JOB_KEY(wsid, tabId)` di localStorage menyimpan jobId aktif per (workspace, tab).
- `streamSSEJob()` helper: parse SSE frame manual (BUKAN EventSource — EventSource auto-reconnect dari offset 0 saat network blip ⇒ chunk duplikat).
- Mount-time recovery effect: cek localStorage, kalau ada saved jobId ⇒ reconnect ke `/stream?offset=<panjang assistant msg yang udah di-render>`. Server replay chunk yang ke-miss + tail terus.
- POST `/chat` SENGAJA tidak pakai `ac.signal` — kalau user click stop saat POST in-flight, abort socket race dengan reply.send ⇒ jobId hilang ⇒ orphan job yang masih burn token. Sebagai gantinya, post-POST cek `stoppedRef.current`, kalau true ⇒ explicit abort job pakai jobId yang baru kita tau.
- Auto-continue parity: recovery path juga deteksi unclosed fence + recursive `sendRaw` (sama seperti sendRaw original).

**Limitations** (dokumentasi):
- In-memory job store — server restart kehilangan job yang masih running. Audit log tetap ke-write saat job selesai, jadi visibility admin selamat.
- Single-process — kalau API di-scale ke multi-replica, job di replica A gak bisa di-tail dari request yang nyangkut di replica B. Saat ini PremDev jalan single container, jadi aman.
- 1 round per job — auto-continue & tool-result loop tetap client-driven. Kalau tab mati di antara round, multi-round chaining putus; user balik, lihat round terakhir, lanjutin manual.

**Atomic replay+subscribe race fix**: di `/jobs/:id/stream`, snapshot `buffer.length` lalu `subscribers.add(sub)` dilakukan dalam blok sync yang sama sebelum write replay slice. Tanpa ini, chunk yang `appendChunk` tambahkan di antara snapshot dan subscribe akan ke-skip total (bukan replay, bukan tail) ⇒ user lihat output corrupt. JS single-threaded jadi sync block aman dari interleave.

**Cara apply ke VPS**: deploy ringan biasa (`cd /opt/premdev && sudo git pull && sudo docker compose pull app && sudo docker compose up -d app`) — cuma kode `apps/` yang berubah.

### 1d. Universal Auto + unlimited iterations + text-only badge (29 Apr 2026)

**`auto` model di SEMUA provider** (apps/api/src/routes/ai.ts). Sebelumnya cuma Google yang punya "auto" (rotate Gemini free-tier). Sekarang setiap provider (openai/anthropic/openrouter/groq/konektika/snifox) punya opsi `auto` di dropdown — pilih model terpintar dulu, fallback ke yang lebih murah saat 429/quota/401. `DEFAULT_MODELS` semua di-set ke `"auto"`.

- `AUTO_TIERS: Record<Provider, string[]>` di line ~489: smartest → cheapest. Edit di sini kalau mau ganti urutan.
- `streamProviderAuto()` di line ~1224: iterate tier, jalankan `streamProvider(provider, candidate, …)` per model. Detection failure = first chunk starts dengan `Error:` atau `(... key not configured)`. Anything else = success → commit + prepend `[Auto pilih provider/model]\n` note supaya user lihat model actual yang dipakai.
- Google tetap pakai `streamGoogle` sendiri karena dia query live model list per-key (logic lebih kaya).
- Konektika cuma punya 1 model (kimi-pro), jadi auto effectively = kimi-pro. Tetap valid.

**`textOnlyModels` di /providers response** (line ~996). Sub-list dari `models` yang heuristically gak follow action format (gemma/llama-3.1-8b/llama-3.2-1b-3b/qwen-2.5 small/mixtral-8x7b). Frontend render "— text-only (no actions)" badge di dropdown. `TEXT_ONLY_MODEL_PATTERNS` regex array gampang ditambah kalau nemu model lain yang gak nurut.

**Unlimited auto-continue** (apps/web/src/components/AIChat.tsx):
- `MAX_AUTO_ITERATIONS = 999` (was 8) — autonomous orchestrator loop cap
- `MAX_CONTINUATIONS = 999` (was 10) — output-truncation auto-continue cap
- Both diset 999 sebagai runaway-loop safety net (16M tokens), bukan bisnis limit. Real bound: user wallet + Stop button.
- Otonom tooltip: "AI lanjut sendiri sampai task selesai atau kamu klik Stop. Tidak ada batas langkah."
- Auto-continue indicator pill: "melanjutkan output… (round N)" — gak ada `/N` denominator yang misleading.

**Google models dropdown** (PROVIDER_MODELS.google line ~448): user-curated short list per request — `gemini-2.5-flash`, `gemini-3-flash`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`. Live model fetch dari `/v1beta/models` masih override saat runtime; static list ini cuma fallback offline.

**Cara apply ke VPS**: deploy ringan biasa (sama spt 1c). Setelah deploy, user WAJIB hard-refresh browser (Ctrl+Shift+R) supaya bundle JS baru ke-load — kalau gak hard-refresh, dropdown model masih nampilin list lama dari cache.

**Cara test**: buka workspace, kirim chat panjang ke AI, di tengah streaming refresh tab. Reply harusnya muter terus — bukan ke-stop di tengah. Cek juga: stop button di tengah streaming ⇒ AI berhenti BENERAN (cek `ai_tool_calls` di admin: `kind=chat`, durationnya pendek, `ok=0`).

### 1f. Task A + B selesai (01 Mei 2026)

**Task A — VPS Filesystem Browser** (`apps/api/src/routes/vfs.ts`, `apps/api/src/index.ts`, `apps/web/src/pages/Admin.tsx`):
- Backend: route `/api/vfs/list`, `/api/vfs/read`, `POST /api/vfs/write`, `POST /api/vfs/mkdir`, `DELETE /api/vfs/delete` — admin-only, semua via `requireAdmin`. Path sanitization anti path-traversal (`path.resolve` + prefix check). Base path dari `VFS_ROOT` env (default `/vpsroot`).
- Frontend: tab baru "VPS Files" di Admin.tsx — file tree, editor textarea, breadcrumb navigasi, tombol Save/New Folder, warning banner merah, shortcut bookmark path VPS penting.
- Config: `VFS_ROOT=/vpsroot` ditambah ke `config.ts` + `.env.example`.
- **User masih perlu lakukan sekali via SSH**: tambah volume `- /:/vpsroot:rw` ke docker-compose.yml service `app`, lalu `sudo docker compose up -d app`. Kalau mount belum ada, endpoint kasih error 503 dengan instruksi jelas.

**Task B — Refactor ai.ts** (`apps/api/src/lib/ai-prompt.ts`, `ai-context.ts`, `ai-providers.ts`):
- `ai.ts` sekarang ~430 baris (dari 1677) — hanya HTTP handlers + route registration.
- `ai-prompt.ts`: Provider type, ChatMsg type, SYSTEM_PROMPT, AUTO_PILOT_PROMPT, CONT_TRUNC_INSTRUCTION, MAX_HISTORY_*, MAX_TOKENS_*, parseDataUrl, clampMessage, trimHistory.
- `ai-context.ts`: buildWorkspaceContext, buildWorkspaceDbHint, sniffDatabaseSchema, detectProjectHints, loadProjectMemory, buildRelevantSnippets, SEARCH_TOP_K.
- `ai-providers.ts`: DEFAULT_MODELS, GEMINI_FREE_TIER, PROVIDER_MODELS, AUTO_TIERS, TEXT_ONLY_MODEL_PATTERNS, isTextOnlyModel, KEY_FAILOVER_STATUSES, fetchGoogleModels, fetchSnifoxModels, streamProvider, streamProviderAuto, streamOpenAICompat, streamAnthropic, streamGoogle, streamGoogleSingle.
- Tidak ada perubahan fungsional — semua behavior sama persis, hanya dipindah ke modul terpisah.

**Cara apply ke VPS**: deploy ringan biasa:
```bash
ssh root@flixprem.org
cd /opt/premdev
sudo git pull origin main
sudo docker compose pull app
sudo docker compose up -d app
```

**Cara test VPS Filesystem Browser**: login admin → Admin → tab "VPS Files". Kalau mount belum ada, akan muncul error 503 dengan instruksi. Untuk aktifkan mount, edit `/opt/premdev/docker-compose.yml` → tambah di service `app` → `volumes:` → `- /:/vpsroot:rw` → restart app.

### 1e. Server-side recovery + mid-run message queue (01 Mei 2026)

**Server-side recovery untuk old chats** (apps/web/src/components/AIChat.tsx, recovery effect ~line 1400):
Sebelumnya recovery cuma cek `localStorage.getItem(JOB_KEY(wsid, tabId))`. Kalau kosong (chat lama sebelum JOB_KEY scheme, atau localStorage dibersihkan), langsung return — gak ada recovery. Sekarang kalau localStorage kosong, kode fetch `/api/ai/chat/jobs/active?workspaceId=X`:
- Filter job `tabId === activeTabId` (exact match); kalau gak ada, ambil job active terbaru (last in array)
- Kalau ketemu: set jobId, simpan ke localStorage, lanjut reconnect normal
- Kalau fetch gagal (network error, server mati): silently return — gak ada crash
- Note: endpoint `/chat/jobs/active` udah ada dari session sebelumnya (1c), jadi backend gak perlu diubah

**Mid-run message queue** (apps/web/src/components/AIChat.tsx):
Saat AI streaming, tombol Send diganti jadi dua tombol: **Stop** (merah) + **+** (queue). Enter juga trigger queue saat streaming.
- `queueMessage()`: push input ke `pendingQueueRef.current[]`, update `queuedCount` state, clear input
- Pill indicator muncul di atas input: "1 pesan menunggu — akan dikirim setelah AI selesai: 'preview teks…'"
- Setelah `await sendRaw(txt, imgs)` di `send()`: flush loop — `while (queue.length > 0 && !stoppedRef.current)`: per queued msg: reset counters, `await sendRaw(queued, [])` → AI lihat msg itu sebagai turn baru lengkap
- Queue di-clear di awal setiap `send()` (new user turn = mulai fresh, bukan dilanjutkan dari queue sebelumnya)
- Stop button selama flush juga hentikan queue (guard: `!stoppedRef.current`)
- Queued msg bubble muncul SAAT flush (via sendRaw), bukan saat queue — menghindari duplicate bubble

### 1b. Auto-continue AI (29 Apr 2026)
File-write besar (>150 baris) dulu sering kepotong di tengah karena cap output token model — `file:` action gak pernah kelar dan diam-diam gagal. Solusi 3-lapis sekarang aktif:
1. **`AI_MAX_TOKENS_AUTOPILOT` default dinaikkan ke 16384** (dari 8192). Override per-VPS via `.env` kalau perlu.
2. **Prompt OUTPUT BUDGET** di `AUTO_PILOT_PROMPT` (apps/api/src/routes/ai.ts) maksa AI split file >150 baris jadi `file:` skeleton + chained `patch:` per section.
3. **Client-side auto-continue loop** di `AIChat.tsx`:
   - `hasUnclosedActionFence(buf)` deteksi action fence yang gak ditutup di akhir streaming.
   - Auto re-fire chat (max 2 retry per user turn, tracked via `continuationCountRef`); reset di `send()`.
   - Sinyal continuation lewat **body field `continuation: true`** (BUKAN text marker — biar user gak bisa spoof dengan ngetik magic string). Server (`apps/api/src/routes/ai.ts` zod `Body.continuation`) cuma trigger AUTO CONTINUATION system block kalau flag ini true.
   - Synthetic user message ditandai `synthetic: true` di Msg type → di-hide dari render UI dan di-strip dari localStorage persistence (lihat `msgs.filter((m) => !m.synthetic)`).
   - `msgsRef` di-update SYNCHRONOUSLY di setiap `setMsgs` callback (initial seed + streaming chunks + error) supaya recursive `sendRaw` ke continuation gak race vs React commit cycle.
   - Indicator "🔄 Output kepotong — auto-melanjutkan (X/2)" muncul di chat saat aktif.

### 2. Disaster history (29 Apr 2026) — JANGAN DIULANG
**Apa yang terjadi**: User pernah `sudo rm -rf /opt/premdev` karena AI agent (saya) kasih instruksi `rm -rf` digabung dengan `ls -la` dalam SATU blok yang user paste sekaligus, jadi user gak sempet baca isi `ls` dulu. Akibatnya:
- `/opt/premdev/data/sqlite/premdev.sqlite` (DB user + workspace list) **hilang**
- `/opt/premdev/data/workspaces/` (semua kode user) **hilang**
- `/opt/premdev/.env` **hilang**
- Container Docker masih hidup (data MySQL volume `premdev_mysql_data` selamat)

**Cara recovery yang berhasil**:
1. Extract `.env` dari `docker inspect premdev-app-1 --format '{{range .Config.Env}}{{println .}}{{end}}'`
2. Reconstruksi `.env` dengan filter nilai corrupt yang diawali `prompt ` (artifact dari install.sh bug — install.sh pernah dijalanin via `curl | bash` yang nyebabin script body ke-feed ke prompt sebagai jawaban)
3. **WAJIB quote** `MYSQL_ROOT_PASSWORD` dengan `'...'` di `.env` karena nilai corrupt mengandung `(` `)` yang bikin bash error pas source
4. Restore dari backup R2: `rclone ls r2:premdev-backup/daily/<TS>/` → file flat (bukan subdir): `premdev-sqlite-<TS>.sqlite.gz`, `premdev-workspaces-<TS>.tar.gz`, `premdev-mysql-<TS>.sql`
5. **Tar `workspaces.tar.gz` punya top-level folder `workspaces/`** — extract pakai `tar -xzf ... -C /opt/premdev/data/`
6. Tabel SQLite: `workspaces` punya kolom `user_id` (BUKAN `owner_id`). Reset `status='stopped'` & `container_id=NULL` setelah restore biar app spawn container baru
7. Ownership workspace: `chown -R 1000:1000 /opt/premdev/data/workspaces`

**`infra/restore.sh` TIDAK kompatibel dengan format backup ini** — script-nya cari `sqlite/`, `mysql/`, `workspaces.tar.gz` dalam subfolder, sementara backup-nya flat. Restore manual.

### 3. Pelajaran untuk AI agent berikutnya
- **JANGAN** kasih `rm -rf /opt/premdev*` ke user **kapan pun**. Folder itu mengandung data produksi user (DB, workspace files, SSL cert). Selalu pindah pakai `mv` ke lokasi backup dulu.
- **JANGAN** gabungin `ls`/cek/inspeksi dengan `rm`/`mv` destruktif dalam satu blok kode — user pemula bakal paste sekaligus.
- **JANGAN** kasih `git reset --hard` ke `/opt/premdev` — itu folder produksi, bukan checkout dev.
- **JANGAN** `docker rm` / `docker volume rm` apa pun yang prefix-nya `premdev_*` atau `pw_*` — itu user data + workspace runtime.
- **SEBELUM** kasih perintah destruktif, paksa user paste output `ls` dulu, baru lanjut.
- **WORKFLOW DEPLOY**: pakai `redeploy.sh` HANYA kalau ada perubahan `infra/runtime/Dockerfile`, `infra/Caddyfile.tmpl`, atau `infra/docker-compose.prod.yml`. Untuk perubahan kode `apps/` doang, **cukup**: `cd /opt/premdev && sudo git pull && sudo docker compose pull app && sudo docker compose up -d app` — workspace user gak keganggu.
- **`redeploy.sh` membersihkan SEMUA container `pw_*` & `pwsh_*`** — workspace user yang lagi running akan terhenti. File mereka aman, tapi sesi terputus. Selalu warning user dulu.
- **`install.sh` bug**: kalau dijalanin via `curl | bash`, prompt-prompt-nya konsumsi script body sebagai input → menulis nilai garbage `prompt VARNAME ...` ke `.env`. Selalu instruksi user `curl -fsSL ... -o /tmp/install.sh && sudo bash /tmp/install.sh` (download dulu, baru jalanin).

### 4. Cheat sheet untuk user (perintah aman & sering dipakai)

**Deploy ringan (kode `apps/` aja, ~5 detik downtime, workspace user aman):**
```bash
ssh root@flixprem.org
cd /opt/premdev
sudo git pull origin main
sudo docker compose pull app
sudo docker compose up -d app
```

**Deploy berat (perubahan runtime/Caddy/compose, workspace user direstart):**
```bash
ssh root@flixprem.org
cd /opt/premdev
sudo bash infra/redeploy.sh
```

**Lihat log app live (Ctrl+C buat keluar):**
```bash
sudo docker compose -f /opt/premdev/docker-compose.yml logs -f app
```

**Edit `.env` & restart cuma app:**
```bash
sudo nano /opt/premdev/.env
sudo docker compose -f /opt/premdev/docker-compose.yml up -d app
```

**Cek status container:**
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

**Backup `.env` ke laptop user (paranoid mode):**
```bash
sudo cat /opt/premdev/.env
# user copy paste ke Notes HP / file lokal
```

**Cek backup R2 (kalau perlu restore lagi):**
```bash
rclone ls r2:premdev-backup/daily/ | tail -20
```

**Reset password admin lewat SQLite (kalau lupa):**
```bash
# generate hash dulu
docker exec premdev-app-1 node -e "const b=require('bcryptjs');console.log(b.hashSync('PASSWORD_BARU',10))"
# update DB (ganti HASH_HASIL_DI_ATAS)
sudo sqlite3 /opt/premdev/data/sqlite/premdev.sqlite "UPDATE users SET password_hash='HASH_HASIL_DI_ATAS' WHERE username='maraazn069';"
```

**Keluar dari shell yang stuck di `>` prompt:** tekan `Ctrl+C` (gak rusak apa-apa, cuma batalin perintah yang nunggu input).

### 5. Known issues yang harus diselesaikan (TODO untuk AI agent berikutnya)

1. ✅ **DONE (29 Apr 2026) — AI agent stuck "SEDANG DITULIS"**. Root cause: `MAX_TOKENS_DEFAULT = 1024` di `apps/api/src/routes/ai.ts:442` ketelanjang kecil — model mulai emit ` ```` file:index.html ` ` , habis token sebelum closing fence ` ```` `, jadi `parseActions()` di `apps/web/src/components/AIChat.tsx` gak pernah mark action sebagai `closed`, dan `actionPreview` placeholder stuck di "sedang ditulis" selamanya tanpa ActionCard buat di-approve. **Fix yang dipush**:
   - Backend: bump default 1024→4096, autopilot 2048→8192, plus env override `AI_MAX_TOKENS_DEFAULT` / `AI_MAX_TOKENS_AUTOPILOT` (lihat `.env.example`).
   - Frontend: thread `isStreaming` flag ke `<Markdown>` → kalau action fence belum tutup TAPI streaming udah selesai, tampilkan badge kuning "⚠ output terpotong" dgn tooltip suruh user minta AI lanjutkan, alih-alih placeholder abu-abu yg misleading.
   - **Cara apply ke VPS**: soft deploy aja (`cd /opt/premdev && sudo git pull && sudo docker compose pull app && sudo docker compose up -d app`) — gak perlu redeploy.sh karena cuma apps/ yg berubah. Workspace lama AMAN.
   - **Cara test**: buka workspace, autopilot ON, suruh "buat file index.html simple" — harusnya sekarang ke-create lengkap. Kalau model masih kepotong di file yg sangat besar, naikin `AI_MAX_TOKENS_DEFAULT=8192` di `/opt/premdev/.env` lalu restart app container.

2. ✅ **DONE (29 Apr 2026) — Token usage AI agent boros**. Implementasi lumen-style semantic search **tanpa Ollama** (no sidecar, no GPU): pakai `@xenova/transformers` (ONNX runtime di Node.js) dengan model `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (~470 MB, 384-dim, support Indo+English). Index per-workspace di `<workspace>/.premdev/embeddings.db` (SQLite). Pas user chat, query embedding-nya match top-K=5 chunks (30 baris + 5 overlap) → cuma snippet relevan yg masuk system prompt, bukan full file/listing. **Files**:
   - Backend: `apps/api/src/lib/embeddings.ts` (singleton lazy-load), `apps/api/src/lib/semantic-search.ts` (chunk + index + search), `apps/api/src/routes/ai.ts` (helper `buildRelevantSnippets()` injected ke chat handler), `apps/api/src/routes/admin.ts` (4 endpoint admin: status / preload / reindex / clear).
   - Frontend: tab baru "AI Search" di `apps/web/src/pages/Admin.tsx` — tampilin model status (loading/ready/error), RAM, total chunks indexed, plus tabel per-workspace dgn tombol Reindex & Clear.
   - Config: `.env.example` + `SEMANTIC_SEARCH_ENABLED=true`, `EMBEDDING_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2`.
   - Dependency baru: `@xenova/transformers ^2.17.2` di `apps/api/package.json`.
   - **RAM cost**: model load ~600 MB sekali aja di proses API (lazy, baru load pas user pertama chat — atau klik "Preload model" di admin tab). Per-workspace index disk: ~5–50 MB tergantung ukuran codebase.
   - **Cara apply ke VPS**: `cd /opt/premdev && sudo git pull && sudo docker compose pull app && sudo docker compose up -d app`. Container `app` rebuild otomatis include dependency baru. **Pertama kali user chat di workspace, ada delay ~30 detik** (download model dari HuggingFace). Cache disimpan di volume container.
   - **Cara test**: login → buka workspace, chat AI ("jelasin file foo.ts"). Buka Admin → tab AI Search → harusnya status "READY", RAM ~600 MB, ada 1 workspace ke-index dgn N chunks.
   - **Kalau VPS RAM tipis** (< 2 GB free): set `SEMANTIC_SEARCH_ENABLED=false` di `.env`, restart app — fitur disable, fallback ke kirim full file ke AI seperti sebelumnya.

### 6. Workflow Replit → GitHub → VPS (untuk user)
1. Edit kode di Replit (atau minta AI agent edit)
2. Buka tab Git di sidebar Replit (ikon cabang)
3. Tulis pesan commit, klik **Commit & Push**
4. SSH ke VPS, jalanin **deploy ringan** atau **deploy berat** sesuai cakupan perubahan

---

## Overview
Replit-style self-hosted cloud IDE for personal use. Runs on a VPS (4 vCPU / 56GB RAM) for ~10 users.
Domain: `flixprem.org`. GitHub: `maraazn069`. SSL via Cloudflare DNS-01 wildcard.

## Tech stack
- **Backend**: Node.js 20 + Fastify + TypeScript + better-sqlite3
- **Frontend**: React 18 + Vite + TailwindCSS + Monaco editor + xterm.js
- **Database**: MySQL 8 (per-user isolation by `<user>_<project>` prefix) + phpMyAdmin
- **Runtime**: Docker (one container per workspace) — Caddy reverse proxy with Cloudflare plugin
- **CI/CD**: GitHub Actions → GHCR → SSH pull on VPS

## Project structure
```
apps/
  api/           # Fastify backend (auth, workspaces, files, terminal, ai, admin)
  web/           # React frontend (login, dashboard, editor, admin, settings)
infra/
  install.sh             # Interactive VPS installer
  docker-compose.prod.yml
  Caddyfile.tmpl         # Wildcard SSL via Cloudflare DNS
  caddy/Dockerfile       # Caddy with cloudflare-dns plugin
  runtime/Dockerfile     # User workspace runtime (Python, Node, PHP, Go, Rust, Java, Ruby, C/C++)
.github/workflows/
  deploy.yml             # Build → GHCR → SSH deploy
Dockerfile               # App image (Node API + built web)
```

## Subdomain scheme
- `app.<domain>` — main IDE
- `db.<domain>` — phpMyAdmin
- `*.preview.<domain>` — workspace previews: `<port>-<workspaceId>.preview.<domain>`
- `*.app.<domain>` — permanent deploys

## Dev workflow (Replit)
- `npm run dev` runs API (3001) + Vite (5000) concurrently
- Docker not available in Replit env → local process runtime fallback
- SQLite at `./data/premdev.sqlite`, workspaces at `./data/workspaces/`
- Default admin: `admin` / `admin1234`

## Production install
1. Push to GitHub
2. `ssh root@<vps>` → run `bash infra/install.sh` (interactive)
3. Set GitHub Actions secrets for auto-deploy

## User preferences
- Indonesian language for chat
- One-task install with verbose logs in SSH
- Per-user MySQL with prefix-based DB isolation (no name collisions across users)
- Templates: Blank, Upload ZIP, Git URL, framework presets
- AI: 7 providers (OpenAI, Anthropic, Google, OpenRouter, Groq, Konektika, SnifoxAI), auto-pilot mode, must obey stop. SnifoxAI uses `https://core.snifoxai.com/v1` (OpenAI-compatible, key prefix `snfx-`); model dropdown is populated live from `/v1/models` (10-min cache) so new vendor releases show up automatically. Editable from the admin AI provider keys panel like every other provider.

## Recent changes (post-deploy fixes)
- `apps/api/src/lib/ai-settings.ts` — AES-256-GCM encrypted AI keys in `settings` table; env fallback; warns when JWT_SECRET is default/weak
- `apps/api/src/lib/checkpoints.ts` — tar.gz workspace snapshots with per-workspace mutex; `restoreCheckpoint` stops the runtime first and auto-creates a backup; max 20/workspace
- `apps/api/src/routes/ai.ts` — Gemini `gemini-2.0-flash`, OpenRouter free default, model selector, sliding-window history, max_tokens caps, autopilot fenced-block protocol
- `apps/api/src/routes/files.ts` — `safePath()` uses `path.relative` containment; rename + streaming download-zip with client-abort cleanup
- `apps/api/src/routes/workspaces.ts` — POST `/restart`, `/exec`, GET/POST `/checkpoints`, restore/delete; zip upload now validates entries (zip-slip protection)
- `apps/api/src/lib/runtime.ts` — `runOneOff` enforces timeout in both Docker exec and ephemeral container paths (kills + 124 exit code on timeout); `ensureShellContainer`/`stopShellContainer` long-lived `pwsh_<id>` for terminal fallback
- `apps/web/src/components/AIChat.tsx` — provider/model selectors, autopilot mode, line-based state-machine fence parser tolerant to nested ``` in `file:` payloads, per-action approve/skip cards
- `apps/web/src/pages/Editor.tsx` — debounced auto-save with monotonic save/edit generation refs (no stale ack clears newer dirty state), checkpoints modal, restart, rename, download/upload zip, ConfirmDialog for destructive actions
- `apps/web/src/pages/Admin.tsx` — AI provider keys section (masked + edit/clear) + JWT_SECRET weakness warning banner; ConfirmDialog for user delete

## Hardening Fase 1 (Apr 2026)
Resilience + observability changes ahead of multi-user expansion. All additive — no breaking changes.

- **AI audit log** (`apps/api/src/lib/db.ts`, `routes/ai.ts`, `routes/admin.ts`, `apps/web/src/components/AIChat.tsx`)
  - New `ai_tool_calls` table indexed by user/workspace/created_at
  - `POST /api/ai/audit` records every executed action (kind, target, ok, output preview ≤ 2KB) with provider+model
  - `GET /api/ai/audit?workspaceId=&limit=` for the user's own history; admin `GET /api/admin/ai-tool-calls?user&workspace&limit` for cross-user view
  - Frontend logs from both autonomous orchestrator and manual ActionCard.execute()
- **Idle shell auto-stop** (`apps/api/src/lib/runtime.ts`, `routes/terminal.ts`)
  - In-memory `lastShellActivity` map, `recordShellActivity(id)` called on every terminal input/resize
  - Background interval (5 min) stops `pwsh_*` containers idle ≥ `IDLE_SHELL_TIMEOUT_MIN` (default 30 min, 0 disables)
  - Run containers `pw_*` are NOT touched — they still pause/resume via `IDLE_PAUSE_MINUTES`
- **Container hardening** (`apps/api/src/lib/runtime.ts`)
  - All workspace + shell containers now get `MemorySwap = Memory` (no swap), `Ulimits` (nofile 4096:8192, nproc 512:1024), and `LogConfig` (10 MB × 3 files)
  - Shell containers also gained `CapDrop: ALL` + `no-new-privileges` (parity with run containers)
- **Telegram lib (Fase 2 prep)** (`apps/api/src/lib/telegram.ts`)
  - `notifyAdmin(text, level)` — silent no-op when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` unset
  - 1s min interval, 5s fetch timeout, never throws
- **Infra log rotation + maintenance** (`infra/docker-compose.prod.yml`, `infra/install.sh`)
  - YAML anchor `x-logging` applies 10 MB × 3 to caddy/mysql/phpmyadmin/app
  - `/etc/cron.weekly/premdev-prune` clears stopped containers (>24h) + dangling images (>168h); never touches volumes
- **Config additions** (`apps/api/src/lib/config.ts`)
  - `IDLE_SHELL_TIMEOUT_MIN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `R2_ENDPOINT`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_BUCKET`, `R2_REGION` (auto)
  - `infra/install.sh` prompts for all new keys + writes them to `.env`

## Hardening Fase 2 (Apr 2026)
Backups, monitoring, and brute-force / abuse defense. Builds on Fase 1.

- **Brute-force lockout + login audit** (`apps/api/src/lib/db.ts`, `routes/auth.ts`, `lib/rate-limit.ts`)
  - New `login_attempts` table (ip, username, ok, reason, ua, created_at) — every login attempt logged success or fail
  - 5 failures from same IP in 15 min → 30-min IP lockout (returns HTTP 429)
  - Per-IP login rate limit: 10 burst, +1 every 10s
  - Telegram alert (once per IP per process) when an IP crosses 10 failures in 15 min
  - Successful login resets the bucket and clears prior throttle
- **Generic security audit log** (`apps/api/src/lib/db.ts` `writeAudit()`, `routes/admin.ts`, `routes/auth.ts`)
  - New `audit_log` table (actor_id, actor_username, ip, action, target, meta JSON, created_at)
  - Captures: login, logout, password-change, user-create, user-delete, ai-key-set, ai-key-remove
  - `GET /api/admin/audit-log?action=&actor=&limit=` with admin-only access
- **Server-side AI chat audit** (`apps/api/src/routes/ai.ts`)
  - `/chat` now writes a `kind='chat'` row in `ai_tool_calls` after every stream completion (or error)
  - Captures provider, model, total chars, duration, last-200-char preview — frontend can no longer hide chat usage
- **Per-IP API rate limiting** (`apps/api/src/lib/rate-limit.ts`, `apps/api/src/index.ts`)
  - Two pools: `apiLimiter` (120 burst, +2/s) for `/api/*`, `aiLimiter` (30 burst, +1/5s) for `/api/ai/*`
  - `/api/health` excluded so monitoring scripts don't burn tokens
  - In-memory token bucket with 60s pruning of cold buckets — single-process only (would need Redis for multi-replica)
- **R2 backup script + daily cron** (`infra/backup.sh`, `infra/install.sh`)
  - `infra/install.sh` installs rclone and writes `~/.config/rclone/rclone.conf` from R2 env vars
  - `/usr/local/sbin/premdev-backup` (deployed by installer) dumps SQLite via `VACUUM INTO`, mysqldump all DBs, tar.gz workspaces (excluding node_modules/.venv/__pycache__/.cache/dist/build/target), uploads to `r2:<bucket>/daily/<TS>/`
  - Sunday runs also promote to `weekly/<TS>/` (server-side copy, no re-upload)
  - Retention: 7 daily + 4 weekly; older snapshots purged automatically
  - Cron: `/etc/cron.daily/premdev-backup`; env loaded from `/etc/premdev/backup.env` (mode 600, only backup-relevant vars — never the full `.env`)
  - Telegram alert on success or upload failure
- **Hourly monitoring + alerts** (`infra/monitoring.sh`, `infra/install.sh`)
  - `/usr/local/sbin/premdev-monitor` checks: disk usage on `/opt/premdev` (warn ≥80%, alert ≥90%), SSL expiry on `app.<domain>` (warn ≤14d, alert ≤7d), API health (`/api/health` HTTP 200), all compose services Up
  - State files in `/var/lib/premdev-monitor/` dedupe alerts to once per 24h (resets when state recovers)
  - Cron: `/etc/cron.hourly/premdev-monitor`
- **Persisted shell idle activity** (`apps/api/src/lib/runtime.ts`, `lib/db.ts`)
  - `workspaces.last_shell_activity_at` column added (idempotent migration in `initDb`)
  - Replaces the in-memory map from Fase 1 — idle reaper now survives API restarts cleanly
  - Writes throttled to ≥5s per workspace to keep DB churn negligible vs per-keystroke firing
- **Real disk stats in Admin UI** (`apps/api/src/routes/admin.ts`, `apps/web/src/pages/Admin.tsx`)
  - `/api/admin/stats` now returns real `diskUsedMb`/`diskTotalMb` from `fs.statfsSync(WORKSPACES_DIR)`
  - Top-stats card switches to "Disk %" when disk numbers are available
- **Admin UI: tabbed audit views** (`apps/web/src/pages/Admin.tsx`)
  - New tabs: Users (existing), Audit log, Login attempts
  - Audit log tab: filter by action / actor, 15s auto-refresh
  - Login attempts tab: failures-only toggle, IP filter, "Top failed-login IPs (24h)" warning panel
- **Audit calls wired into existing admin flows**: user create/delete and AI-key set/remove all now writeAudit so the security log is meaningful from day 1.

### Fase 2.1 — Telegram admin bot + env tier classification (Apr 2026)
- **`infra/telegram-bot.mjs`**: Pure-Node long-polling Telegram bot, runs on the HOST as a systemd service (NOT in a container, so it can talk to docker, edit `.env`, and read `/proc`/`df`/`du` directly). Refuses to start unless `ADMIN_TELEGRAM_ID` is set; silently drops every message whose `from.id` doesn't match (no acknowledgement → no info leak to strangers who find the bot).
- **Commands**: `/stats` `/df` `/diskhog` `/docker` `/restart [svc]` `/logs SVC [N]` `/users` `/env [1|2|all]` `/getenv KEY` `/setenv KEY VALUE` `/backup` `/monlog` `/help`. Slash menu auto-registered via `setMyCommands`.
- **Tier classification** (in bot script): `TIER_2` = secrets (`JWT_SECRET`, `CF_API_TOKEN`, `MYSQL_*_PASSWORD`, `ADMIN_PASSWORD`, all AI keys, `R2_*_KEY`, `TELEGRAM_BOT_TOKEN`, `GHCR_TOKEN`, `ENCRYPTION_KEY`) — values masked in `/env` listings, never returned by any web `/admin` endpoint. `TIER_1` = non-sensitive config (domains, quotas, intervals, R2 endpoint/bucket). `/setenv` reports a per-key `restartHint` (which service to recreate, or "needs full redeploy") so the admin knows what to do next.
- **`infra/premdev-bot.service`**: systemd unit with `Restart=on-failure`, `StartLimitBurst=5`, `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp=true`, `RestrictNamespaces=true`. Reads `.env` itself (no `EnvironmentFile=`) so `/setenv ADMIN_TELEGRAM_ID …` followed by `systemctl restart premdev-bot` rotates access cleanly.
- **`infra/install.sh`**: prompts for `ADMIN_TELEGRAM_ID` (defaults to the chat-ID prompt above), installs Node.js 20 from NodeSource if missing, deploys `/usr/local/sbin/premdev-bot.mjs` + the systemd unit, enables + starts the service. Skipped (with warning) if either Telegram var is empty.
- **`infra/redeploy.sh`**: refreshes `backup.sh` / `monitoring.sh` / `telegram-bot.mjs` from main on every redeploy, restarts the bot service if it's enabled — bug fixes ship with the normal deploy flow.
- **`apps/api/src/lib/config.ts`**: added `ADMIN_TELEGRAM_ID` (unused by API itself; kept for potential "bot configured?" indicator on `/admin`).

### Fase 2.2 — /admin Backup tab + R2 restore (Apr 2026)
- **Architecture (trigger-file bridge)**: API container has no docker / mysql / rclone. `/admin` Backup actions are bridged to the host via JSON files dropped in `/var/lib/premdev/triggers/` (host: `/opt/premdev/data/triggers/`). A host cron (`/etc/cron.d/premdev-trigger`, every minute) picks them up via `/usr/local/sbin/premdev-trigger`, runs the action, and writes a `.result.json` the API polls. Same `flock` lock so a long restore never races a second cron tick.
- **`infra/restore.sh`** (new, → `/usr/local/sbin/premdev-restore`): downloads a `(daily|weekly)/<TS>` snapshot from R2, writes a pre-restore "safety dump" to `/var/backups/premdev-pre-restore-<TS>/`, stops `app`, restores SQLite + MySQL (drop & re-import all DBs) + workspaces (atomic via tmp dir + rename), restarts `app`. Snapshot path strictly regex-validated (`^(daily|weekly)/[0-9]{8}-[0-9]{6}$`) — refuses path traversal. Pings Telegram on success/failure.
- **`infra/refresh-index.sh`** (new, → `/usr/local/sbin/premdev-refresh-index`): rebuilds `/opt/premdev/data/backup_index.json` via `rclone lsjson` + `rclone size --json` per snapshot. Called after every `backup.sh` run, hourly via cron, and on-demand from `/admin`.
- **`infra/trigger-runner.sh`** (new, → `/usr/local/sbin/premdev-trigger`): host cron runner. Atomic `mv .json → .running` claim, dispatches `backup` / `restore` / `refresh-index`, captures output (last 4KB), writes `.result.json`. Cleans up `.result.json` >7d old and orphan `.running` >3h old.
- **`apps/api/src/routes/admin.ts`**: new endpoints `GET /admin/backups` (reads index + jobs), `POST /admin/backups/run`, `POST /admin/backups/refresh`, `POST /admin/backups/restore`. Restore requires `body.confirm === body.snapshot` (typed-confirmation gate). All write actions audit-logged. `bridgeAvailable()` check returns 503 in dev where the host mount doesn't exist — endpoints never throw.
- **`apps/web/src/pages/Admin.tsx`**: new "Backup" tab — snapshot table grouped by daily/weekly with size + filecount, "Run backup now" + "Refresh" buttons, recent jobs panel (auto-polls every 3s while a job is queued/running, 30s otherwise), `RestoreModal` with typed-path confirmation and a red "DESTRUCTIVE" warning explaining what gets replaced.
- **`infra/install.sh`** + **`infra/redeploy.sh`**: install/refresh the three new scripts, create `/opt/premdev/data/triggers/` (mode 770, owned 1000:1000), install `/etc/cron.d/premdev-trigger` (every minute + hourly index refresh).
- **`infra/backup.sh`**: runs `premdev-refresh-index` after each successful backup so the new snapshot appears in `/admin` immediately.
- **`infra/telegram-bot.mjs`**: `loadBotConfig` now falls back to `TELEGRAM_ADMIN_CHAT_ID` if `ADMIN_TELEGRAM_ID` is unset (same numeric ID for 1:1 chats). Refuses negative (group/channel) IDs. Older installs work without a manual edit.
- **Tier reaffirmed**: `backup.env` contents (`TELEGRAM_BOT_TOKEN`, `MYSQL_ROOT_PASSWORD`, `R2_*_KEY`) remain TIER_2 — they appear nowhere in `/admin`. Operator manages them via SSH or via `/setenv` over the bot.
- **`perintah.md`** (new): Indonesian-language operator cheatsheet covering git push from Replit, install.sh, redeploy, env editing, bot setup + commands, backup/restore (web + CLI), log locations, troubleshooting.

## Custom subdomain mapping (Apr 2026)
Per-workspace user-chosen subdomain on top of the existing `<project>-<user>.<domain>` auto-route.
- **`apps/api/src/lib/db.ts`**: `workspaces.custom_subdomain` column + partial unique index (NULLs allowed). `validateSubdomainLabel()` enforces lowercase RFC-1123 single-label (1–49 chars, no leading/trailing hyphen). `defaultWorkspaceUrl()` / `workspaceToPublic()` now also expose `defaultUrl` (the auto form) and `customSubdomain` so the UI can show both.
- **`apps/api/src/routes/workspaces.ts`**: `GET /workspaces/check-subdomain?label=` — debounced availability check; returns `{ ok, reason }`. Reserved labels (`app`, `db`, `admin`, `www`, `api`, `auth`, `static`, `assets`, `console`) plus collision against any other workspace's `custom_subdomain` AND any workspace's auto `<proj>-<user>` form. `PUT /workspaces/:id/subdomain` — set or clear (`label: null` clears).
- **`apps/api/src/routes/proxy.ts`**: `resolveSubdomain()` looks up custom first, then falls back to auto form (skipping rows that have a custom set so we never double-route).
- **`infra/Caddyfile.tmpl`**: regex relaxed to single-label `^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?\.${PRIMARY_DOMAIN}$`, replacing the old two-segment-only pattern.
- **`apps/web/src/pages/Editor.tsx`**: globe button in the header opens `SubdomainPanel` modal — debounced check, live preview URL, "Clear" to revert to auto form. Header button shows the current custom label inline when set.

## Batch A+B AI/UX features (Apr 2026)
~10 new features grouped into two batches; all additive, all behind existing auth.

### Batch A — UX polish
- **#4 Selection-based ask** (`apps/web/src/pages/Editor.tsx`): Monaco `addAction` registers three context-menu items (`Ask`, `Refactor`, `Fix`) plus the `Cmd+I` shortcut. Each captures the active selection, file path, and line range, opens the AI panel, and prefills the chat with a structured prompt. Uses a tiny `premdev:ai:prefill` CustomEvent bus so we don't have to thread props.
- **#13 Plan mode** (`apps/web/src/components/AIChat.tsx`): toggle next to Auto-pilot/Otonom. When ON, the next user message is wrapped with "PLAN MODE — JANGAN emit action blocks. Tampilkan rencana terstruktur dulu, tunggu konfirmasi" so the model produces a written plan before touching files. Persisted in `localStorage`.
- **#23 Snippet library** (`apps/web/src/components/AIChat.tsx`): bookmark button opens a dropdown of saved prompt templates. Ships with 4 starters (Review, Tests, JSDoc, Profile); user can save the current input ("+ Save current"), insert into the textarea, or delete. Persisted in `localStorage`, capped at 30 entries.
- **#25 Quick actions toolbar** (`apps/web/src/pages/Editor.tsx`): wand button in the header opens `QuickActionsMenu` — 7 canned prompts that operate on the currently-open file (Explain, Find bugs, Refactor, Add doc, Add types, Generate tests, Optimize). Each pick auto-opens the AI panel and fires immediately via `premdev:ai:prefill` with `send: true`.

### Batch B — Agentic loop extensions
- **#8 DB schema awareness** (`apps/api/src/routes/ai.ts`): `sniffDatabaseSchema()` runs as part of `buildWorkspaceContext`. Reads up to 4 KB each from `schema.sql` / `db.sql` / `init.sql` / `database.sql` / `prisma/schema.prisma` / `drizzle/schema.ts` and inlines them under a `Database schema:` header. Also detects `DB_*` / `DATABASE_*` keys in `.env` / `.env.local` and lists the keys (values masked, never sent to the model). Scans `./`, `data/`, `db/`, `var/` for `*.db` / `*.sqlite` / `*.sqlite3` files and surfaces their relative paths + sizes so the model knows to inspect schemas via `sqlite3 <file> ".schema"`.
- **#11 Test runner action** (`apps/api/src/routes/workspaces.ts`, `apps/api/src/routes/ai.ts`, `apps/web/src/components/AIChat.tsx`): new `POST /workspaces/:id/test` endpoint with auto-detection (npm test / pytest / go test / cargo test) when no command is supplied, output capped at 12 KB. The system prompt advertises a new `test:run` action block; the chat parser, `actionLabel`, `actionTarget`, `ActionCard.meta`, and `executeAction` all gained matching `test` cases. Output is fed back into the autonomous loop the same way `diag:run` is.
- **#21 Voice input** (`apps/web/src/components/AIChat.tsx`): mic button uses Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). Streams interim transcripts inline (delimited by `⟨…⟩`) and commits final segments into the textarea. Falls back to hidden when the browser doesn't expose the API. Recogniser is stopped on unmount + on `send()`.
- **#24 Git integration** (`apps/api/src/routes/workspaces.ts`, `apps/web/src/pages/Editor.tsx`): server endpoints `GET /git/status`, `GET /git/log`, `GET /git/diff`, `POST /git/commit`, `POST /git/push`, `POST /git/pull` — all run inside the workspace container so they use the user's own git config / credentials. UI is `GitPanel` modal opened from a new header button: branch + ahead/behind counters, changed-files list, commit input ("add all" semantics), Push/Pull/Diff buttons, recent commits log. Refetches status after every action. `POST /git/push` validates `remote` / `branch` against a strict `[A-Za-z0-9_./-]+` allowlist (with no `..`) before shell interpolation, so attacker-controlled metacharacters can't break out into the runtime.

## AI workspace database + chat content collapse (Apr 2026)
Three related changes so the AI assistant can act on the workspace's MySQL DB without dumping raw file content into chat.

- **`db:query` action** (`apps/api/src/routes/workspaces.ts`, `apps/api/src/lib/mysql.ts`, `apps/web/src/components/AIChat.tsx`, `apps/api/src/routes/ai.ts`): new `POST /workspaces/:id/db/query` endpoint runs raw SQL against the workspace's per-user MySQL database. Database name is derived **only from immutable workspace identity** (`<safeUser>_<safeWorkspaceName>`, sanitized exactly as `createProjectDb()` does at workspace-create time). Env vars (`DATABASE_NAME` / `DB_NAME` / `MYSQL_DATABASE`) are deliberately ignored on this path because they are user-editable — otherwise a caller in workspace A could rewrite its env to point at workspace B's database under the same MySQL user grant. The client cannot supply a `database` field at all. Connection uses the owner's MySQL user (`safeUser` from username, password = `MYSQL_USER_PASSWORD`), so the existing `GRANT ALL ON \`<safeUser>\\_%\`.*` from `ensureMysqlUser()` is the access boundary. `multipleStatements: false`, 5s connect timeout, row results capped at 200 rows + 12 KB output. Frontend has a matching `db:query` ActionCard. System prompt documents the action and includes a "Workspace database" section in the snapshot listing the host/port/db name + the env vars (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DATABASE_NAME`, etc.) already injected into the runtime container — so the model never asks the user for credentials.
- **Chat collapses action-fence content** (`apps/web/src/components/AIChat.tsx`): `parseMarkdown()` now recognises any fence whose header is `<kind>:<rest>` (e.g. `file:index.html`, `patch:src/x.ts`, `db:query`, `bash:run`, `workspace:setRun`) and renders it as a one-line `actionPreview` placeholder card (icon + header + line count + "sedang ditulis…" status while streaming). Closed action blocks are still stripped by `parseActions()` and replaced with the existing `ActionCard`; the placeholder only appears for blocks that haven't received their closing fence yet. Plain language fences (` ```js`, ` ```python`, bare ` ```bash`) without a colon still render as normal code blocks — the colon is the discriminator. System prompt now has a non-negotiable rule: "Use action blocks for file work — NEVER paste full file content as plain Markdown."
