# PremDev

Self-hosted cloud IDE for personal use. Inspired by Replit.

- Web-based code editor (Monaco / VS Code engine)
- Smart shell terminal in the browser (xterm.js + PTY)
- Per-user isolated containers (Docker)
- Wildcard subdomain previews with auto SSL (Caddy + Cloudflare DNS)
- MySQL with phpMyAdmin (auto-provisioned per user, prefix isolation)
- AI assistant (OpenAI, Anthropic, Google, OpenRouter, Groq)
- Auto deploy from GitHub Actions to your VPS

---

## Architecture

```
                ┌────────────────┐
   user ───────▶│   Cloudflare   │ (DNS, wildcard A records)
                └───────┬────────┘
                        │ HTTPS (auto SSL via DNS-01)
                ┌───────▼─────────┐
                │      Caddy      │ port 80/443
                └───────┬─────────┘
        ┌───────────────┼───────────────┐
        │               │               │
   ┌────▼────┐    ┌─────▼─────┐    ┌────▼─────┐
   │   app   │    │   mysql   │    │ phpmyadmin│
   │ (Node)  │    │ + volume  │    │  (web)   │
   └────┬────┘    └───────────┘    └──────────┘
        │ docker.sock
   ┌────▼─────────────────────────┐
   │  pw_<workspaceId>            │  user containers
   │  pw_<workspaceId>            │
   │  …                           │
   └──────────────────────────────┘
```

### Subdomain layout

| URL                                           | Purpose                            |
|-----------------------------------------------|------------------------------------|
| `app.<domain>`                                | Main IDE (login, dashboard, editor)|
| `admin.<domain>`                              | Admin (alias of app)               |
| `db.<domain>`                                 | phpMyAdmin                         |
| `<port>-<workspaceId>.preview.<domain>`       | Live preview of running workspace  |
| `<projectName>-<user>.app.<domain>`           | Permanent deployment               |

### Database isolation

Each user gets one MySQL account (`<username>`) with `ALL PRIVILEGES ON \`<username>\\_%\`.*`. When they create a project named `todo`, PremDev auto-creates database `<username>_todo`. Different users can have projects with the same name without collision because the database name is prefixed.

---

## Install on VPS

### 1. Cloudflare DNS (one time)

Add three A records pointing to your VPS IP, with **Proxy status = DNS only**:

```
@                      A    <VPS_IP>
*                      A    <VPS_IP>
*.preview              A    <VPS_IP>
```

(For your domain `flixprem.org`, you've already added `*` and `*.preview` — perfect.)

Generate a Cloudflare API token with **Zone → DNS → Edit** permission for your zone.

### 2. Push this repo to GitHub

```bash
git remote add origin https://github.com/maraazn069/premdev.git
git push -u origin main
```

### 3. SSH into your VPS and run installer

```bash
ssh root@<VPS_IP>
git clone https://github.com/maraazn069/premdev.git /tmp/premdev
sudo bash /tmp/premdev/infra/install.sh
```

The installer will interactively ask for:
- Domain (default `flixprem.org`)
- Cloudflare API token
- Admin username / email / password
- AI provider keys (all optional)
- MySQL passwords (auto-generated if blank)

It will then:
1. Install Docker
2. Configure UFW (22, 80, 443)
3. Create `/opt/premdev` layout
4. Build the Caddy image with Cloudflare plugin
5. Build the user runtime image (multi-language base)
6. Pull the app image from GHCR
7. Bring everything up via `docker compose`

### 4. Set GitHub Actions secrets

In your GitHub repo → Settings → Secrets:

| Secret         | Value                                       |
|----------------|---------------------------------------------|
| `VPS_HOST`     | `20.200.209.228`                            |
| `VPS_USER`     | `root`                                      |
| `VPS_SSH_KEY`  | Contents of your `~/.ssh/id_ed25519` (priv) |
| `VPS_PORT`     | `22` (optional)                             |
| `GHCR_USER`    | `maraazn069`                                |
| `GHCR_PAT`     | GitHub PAT with `read:packages` scope       |

> The image published to `ghcr.io/maraazn069/premdev` is private by default.
> Either make it public in GitHub → Packages → Settings, or set `GHCR_PAT` so the VPS can pull.

After this, every push to `main` automatically rebuilds, pushes to GHCR, SSHes into your VPS, and rolling-updates the app.

---

## Development (here in Replit)

```bash
npm run dev
```

Opens both API (port 3001) and Web (port 5000) with hot reload. Default admin login is `admin` / `admin1234` (set via `ADMIN_*` env vars).

In dev mode, Docker is NOT used — workspaces run as local processes for fast iteration. The Docker runtime kicks in automatically on the VPS.

---

## Common ops on the VPS

```bash
# Logs
docker compose -f /opt/premdev/docker-compose.yml logs -f app
docker compose -f /opt/premdev/docker-compose.yml logs -f caddy

# Restart everything
docker compose -f /opt/premdev/docker-compose.yml restart

# Update app
docker compose -f /opt/premdev/docker-compose.yml pull
docker compose -f /opt/premdev/docker-compose.yml up -d

# Edit env (e.g. add API key)
sudo nano /opt/premdev/.env
docker compose -f /opt/premdev/docker-compose.yml up -d

# Open MySQL CLI
docker compose -f /opt/premdev/docker-compose.yml exec mysql mysql -uroot -p
```

---

## License

MIT — personal use, no warranty.
