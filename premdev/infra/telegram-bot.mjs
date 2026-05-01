#!/usr/bin/env node
// ============================================================================
// PremDev Telegram Admin Bot
// ----------------------------------------------------------------------------
// Runs on the HOST (not inside any container) as a systemd service.
// Long-polls Telegram getUpdates — no webhook / public endpoint required.
//
// Security:
//   * Only replies to messages whose `from.id` matches ADMIN_TELEGRAM_ID.
//     Everything else is silently ignored (no acknowledgement, no error reply,
//     so a stranger that finds the bot can't probe its existence).
//   * Reads ADMIN_TELEGRAM_ID + TELEGRAM_BOT_TOKEN from /opt/premdev/.env;
//     refuses to start if ADMIN_TELEGRAM_ID isn't set (prevents an unconfigured
//     bot from accidentally accepting commands from anyone).
//
// Capabilities:
//   * Resource stats (CPU, mem, load, uptime, disk, top processes).
//   * Disk diagnostics (df -h, du for top space hogs, docker system df).
//   * Docker (ps, stats, restart, logs).
//   * .env management with TIER_1 / TIER_2 classification:
//       - TIER_1 = non-sensitive config (domains, quotas, intervals).
//       - TIER_2 = secrets (JWT, passwords, API keys). NEVER displayed on
//         the web /admin page; values are masked even in /env unless the
//         admin explicitly /getenv KEY.
//   * Trigger an on-demand backup or open the most recent monitor log.
// ----------------------------------------------------------------------------
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Paths / env ----------
const ENV_FILE     = process.env.PREMDEV_ENV_FILE || "/opt/premdev/.env";
const COMPOSE_FILE = process.env.PREMDEV_COMPOSE  || "/opt/premdev/docker-compose.yml";
const BACKUP_BIN   = "/usr/local/sbin/premdev-backup";
const MONITOR_LOG  = "/var/log/premdev-monitor.log";

/** Parse the .env file preserving order + comments. Returns array of
 *  `{kind: 'kv'|'raw', key?, value?, raw}`.
 *
 *  Mirrors `write_env_var` in install.sh which always quotes values like
 *  `KEY="..."` after escaping `\`, `$`, `"`, `` ` `` to backslash-prefixed
 *  forms. We must reverse that escape on read so /getenv shows the real
 *  value, not the on-disk literal. */
function parseEnv(text) {
  // Strip a leading UTF-8 BOM if present — some editors (Windows Notepad,
  // VS Code with "files.encoding": "utf8bom") add one and it would
  // otherwise break the first line's KEY regex match.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  return lines.map((raw) => {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) return { kind: "raw", raw };
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1);
      // Reverse install.sh's escapes: \\ \$ \" \` → \ $ " `
      v = v.replace(/\\([\\$"`])/g, "$1");
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
      v = v.slice(1, -1); // single-quoted is literal in shell
    }
    return { kind: "kv", key: m[1], value: v, raw };
  });
}
/** Encode a value using the EXACT same scheme install.sh's write_env_var
 *  uses, so anything we /setenv survives a `source .env` round-trip in
 *  redeploy.sh / backup.sh without bash performing variable expansion or
 *  command substitution on it. Ordering matters — escape `\` first or you
 *  double-escape the backslashes added by later steps. */
function encodeEnvValue(v) {
  return '"' + v
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`") + '"';
}
function envToMap(parsed) {
  const m = new Map();
  for (const p of parsed) if (p.kind === "kv") m.set(p.key, p.value);
  return m;
}
function loadEnv() {
  if (!fs.existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} not found`);
  const text = fs.readFileSync(ENV_FILE, "utf8");
  const parsed = parseEnv(text);
  return { text, parsed, map: envToMap(parsed) };
}

// ---------- Telegram tier classification ----------
// TIER_2 = never expose values to anything web-facing. The bot can read/write
// them but defaults to mask; admin must explicitly /getenv KEY to see one.
//
// Classification is RULE-BASED (suffix patterns), NOT just an allowlist, so
// any *future* env var following standard naming conventions (FOO_API_KEY,
// FOO_PASSWORD, FOO_SECRET, FOO_TOKEN) is automatically treated as a secret
// even before someone remembers to add it here. The explicit set below
// covers the exceptions and the legacy non-suffixed names.
const TIER_2_EXPLICIT = new Set([
  "JWT_SECRET", "ENCRYPTION_KEY",
  "CF_API_TOKEN",
  "MYSQL_ROOT_PASSWORD", "MYSQL_USER_PASSWORD", "ADMIN_PASSWORD",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY", "GROQ_API_KEY", "KONEKTIKA_API_KEY", "SNIFOX_API_KEY",
  "R2_ACCESS_KEY", "R2_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN", "GHCR_TOKEN",
]);
// Suffix rules: any of these endings forces tier 2. Order doesn't matter.
const TIER_2_SUFFIXES = [
  /_PASSWORD$/, /_API_KEY$/, /_SECRET$/, /_TOKEN$/,
  /_ACCESS_KEY$/, /_SECRET_KEY$/,
];
// TIER_1_EXPLICIT only used for the "show me everything I can configure"
// branch in /env so unset-but-known keys still appear. Display-tier for an
// unknown key falls through to tier 2 (safe-by-default — when in doubt, MASK).
const TIER_1 = new Set([
  "PRIMARY_DOMAIN", "PREVIEW_DOMAIN", "DEPLOY_DOMAIN", "LE_EMAIL",
  "ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_TELEGRAM_ID",
  "IDLE_PAUSE_MINUTES", "IDLE_SHELL_TIMEOUT_MIN",
  "DEFAULT_CPU", "DEFAULT_MEM_MB", "DEFAULT_DISK_MB", "DEFAULT_MAX_WORKSPACES",
  "R2_ENDPOINT", "R2_BUCKET", "R2_REGION",
  "TELEGRAM_ADMIN_CHAT_ID",
  "RUNTIME_IMAGE", "LOG_LEVEL", "MAX_USERS",
  "GHCR_USER", "GHCR_IMAGE",
  "NODE_ENV", "PORT", "HOST",
  "COOKIE_DOMAIN", "DATA_DIR", "WORKSPACES_DIR", "SQLITE_PATH",
  "DOCKER_NETWORK", "MYSQL_HOST", "MYSQL_PORT", "PHPMYADMIN_URL",
  "RUNTIME_DEFAULT_PORT",
]);
const TIER_2 = TIER_2_EXPLICIT; // alias retained for callers that listed it
function classify(key) {
  if (TIER_2_EXPLICIT.has(key)) return 2;
  for (const re of TIER_2_SUFFIXES) if (re.test(key)) return 2;
  if (TIER_1.has(key)) return 1;
  // Unknown key: default to TIER 2 (safe-by-default — never accidentally
  // unmask something just because it isn't in our allowlist yet).
  return 2;
}
function maskValue(v) {
  if (!v) return "(empty)";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 3) + "•".repeat(Math.min(8, v.length - 6)) + v.slice(-3);
}

// ---------- Restart hints ----------
// Some keys, when changed, need specific services restarted to take effect.
// We don't auto-restart (could disrupt active sessions); we tell the admin
// what to run.
const RESTART_HINT = {
  PRIMARY_DOMAIN: "redeploy", PREVIEW_DOMAIN: "redeploy", DEPLOY_DOMAIN: "redeploy",
  LE_EMAIL: "caddy", CF_API_TOKEN: "caddy",
  // Anything that lives in process.env of the API container needs `app` recreate
  JWT_SECRET: "app", ADMIN_USERNAME: "app", ADMIN_EMAIL: "app", ADMIN_PASSWORD: "app",
  IDLE_PAUSE_MINUTES: "app", IDLE_SHELL_TIMEOUT_MIN: "app",
  DEFAULT_CPU: "app", DEFAULT_MEM_MB: "app", DEFAULT_DISK_MB: "app", DEFAULT_MAX_WORKSPACES: "app",
  OPENAI_API_KEY: "app", ANTHROPIC_API_KEY: "app", GOOGLE_API_KEY: "app",
  OPENROUTER_API_KEY: "app", GROQ_API_KEY: "app", KONEKTIKA_API_KEY: "app", SNIFOX_API_KEY: "app",
  TELEGRAM_BOT_TOKEN: "bot", ADMIN_TELEGRAM_ID: "bot",
  MYSQL_ROOT_PASSWORD: "mysql", MYSQL_USER_PASSWORD: "mysql",
  RUNTIME_IMAGE: "redeploy",
};
function restartHint(key) {
  const tag = RESTART_HINT[key];
  if (!tag) return "no restart needed";
  if (tag === "redeploy") return "needs full redeploy: `bash /opt/premdev/redeploy.sh` (or curl one-liner)";
  if (tag === "bot")      return "restart THIS bot: `systemctl restart premdev-bot`";
  if (tag === "caddy")    return "restart caddy: `docker compose -f " + COMPOSE_FILE + " restart caddy`";
  if (tag === "mysql")    return "restart mysql + app: `docker compose -f " + COMPOSE_FILE + " up -d --force-recreate mysql app`";
  return "recreate app: `docker compose -f " + COMPOSE_FILE + " up -d --force-recreate app`";
}

// ---------- .env writer (preserves comments, atomic) ----------
function setEnvKey(key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("invalid key");
  // Reject control characters; allow anything printable in the value. NUL
  // would corrupt the file, CR/LF would split into two lines. Tabs OK.
  if (/[\r\n\0]/.test(value)) throw new Error("value must be a single line (no CR/LF/NUL)");
  const { parsed } = loadEnv();
  // Always quote + escape using the SAME scheme install.sh's write_env_var
  // uses (see encodeEnvValue above). Critical: redeploy.sh and backup.sh
  // both `source .env`, so an unescaped `$(...)` or backtick would execute
  // shell code on the host. Quoting alone isn't enough — we must also
  // escape `\`, `$`, `"`, `` ` `` inside the quotes.
  const newLine = `${key}=${encodeEnvValue(value)}`;
  let found = false;
  const out = parsed.map((p) => {
    if (p.kind === "kv" && p.key === key) { found = true; return { ...p, raw: newLine, value }; }
    return p;
  });
  if (!found) out.push({ kind: "kv", key, value, raw: newLine });
  const newText = out.map((p) => p.raw).join("\n");
  // Atomic write: write to temp file in the SAME directory then rename, so
  // we never leave a half-written .env even if the host loses power. mode
  // 0600 is set on the temp file before rename, preserving the secret-file
  // perms that install.sh established.
  const tmp = ENV_FILE + ".tmp";
  fs.writeFileSync(tmp, newText, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, ENV_FILE);
  return { found, newLine };
}

// ---------- Telegram HTTPS helper ----------
function tgRequest(token, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${token}/${method}`,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 60_000,
    }, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(chunks);
          if (!j.ok) return reject(new Error(`tg ${method}: ${j.description}`));
          resolve(j);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("tg timeout")));
    req.write(body); req.end();
  });
}

// ---------- Shell helpers ----------
async function sh(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { maxBuffer: 5 * 1024 * 1024, timeout: 30_000, ...opts });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e) {
    return { ok: false, stdout: (e.stdout || "").toString(), stderr: (e.stderr || e.message || "").toString() };
  }
}

// ---------- Command handlers ----------
function fmtBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "K";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + "M";
  return (n / 1024 / 1024 / 1024).toFixed(2) + "G";
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}
async function cmdStats() {
  const cpus = os.cpus();
  const load = os.loadavg();
  const mem = { total: os.totalmem(), free: os.freemem() };
  const memUsedPct = ((mem.total - mem.free) / mem.total * 100).toFixed(1);
  const cpuPct = Math.min(100, (load[0] / cpus.length * 100)).toFixed(1);
  const df = await sh("df", ["-h", "/"]);
  const dfLine = df.stdout.trim().split("\n").slice(-1)[0] || "(unknown)";
  const dockerPs = await sh("docker", ["ps", "--format", "{{.Names}}\t{{.Status}}"]);
  const containers = dockerPs.stdout.trim().split("\n").filter(Boolean);
  const wsCount = containers.filter((l) => /^pw_|^pwsh_|^pwx_/.test(l)).length;
  return [
    "*PremDev — host stats*",
    `CPU:   ${cpuPct}%  (load ${load.map((n) => n.toFixed(2)).join("/")} on ${cpus.length} cores)`,
    `Mem:   ${memUsedPct}%  (${fmtBytes(mem.total - mem.free)} / ${fmtBytes(mem.total)})`,
    `Disk:  ${dfLine}`,
    `Up:    ${fmtUptime(os.uptime())}`,
    `Stack: ${containers.length} containers running, ${wsCount} workspaces`,
  ].join("\n");
}
async function cmdDocker() {
  const ps = await sh("docker", ["ps", "--format", "table {{.Names}}\t{{.Status}}\t{{.Image}}"]);
  const stats = await sh("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]);
  return "*Docker ps*\n```\n" + ps.stdout.trim() + "\n```\n*Stats*\n```\n" + stats.stdout.trim() + "\n```";
}
async function cmdDf() {
  const df = await sh("df", ["-h", "-x", "tmpfs", "-x", "devtmpfs"]);
  const dockerDf = await sh("docker", ["system", "df"]);
  return "*df -h*\n```\n" + df.stdout.trim() + "\n```\n*docker system df*\n```\n" + dockerDf.stdout.trim() + "\n```";
}
async function cmdDiskhog() {
  // Top 15 largest dirs under /opt/premdev and /var/lib/docker
  const a = await sh("bash", ["-c", "du -sh /opt/premdev/* 2>/dev/null | sort -rh | head -10"]);
  const b = await sh("bash", ["-c", "du -sh /opt/premdev/data/* 2>/dev/null | sort -rh | head -10"]);
  const c = await sh("bash", ["-c", "du -sh /var/lib/docker/* 2>/dev/null | sort -rh | head -10"]);
  return [
    "*/opt/premdev/* (top 10)*", "```\n" + a.stdout.trim() + "\n```",
    "*/opt/premdev/data/* (top 10)*", "```\n" + b.stdout.trim() + "\n```",
    "*/var/lib/docker/* (top 10)*", "```\n" + c.stdout.trim() + "\n```",
    "_Reclaim space:_ `docker system prune -af --volumes` (CAREFUL — removes unused images/networks/volumes)",
  ].join("\n");
}
async function cmdEnv(args) {
  const tier = (args[0] || "all").toLowerCase();
  const { parsed, map } = loadEnv();
  const seen = new Set();
  const lines = [];
  for (const p of parsed) {
    if (p.kind !== "kv") continue;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    const t = classify(p.key);
    if (tier === "1" && t !== 1) continue;
    if (tier === "2" && t !== 2) continue;
    const v = t === 2 ? maskValue(p.value) : (p.value || "(empty)");
    lines.push(`T${t}  ${p.key}=${v}`);
  }
  // Also include any TIER_1/2 keys missing from .env so admin can /setenv them.
  for (const k of [...TIER_1, ...TIER_2]) {
    if (!seen.has(k)) {
      const t = classify(k);
      if (tier === "1" && t !== 1) continue;
      if (tier === "2" && t !== 2) continue;
      lines.push(`T${t}  ${k}=(unset)`);
    }
  }
  return "*Env (" + tier + ")*\n```\n" + lines.join("\n") + "\n```\n_T2 values masked. Use_ `/getenv KEY` _for full value._";
}
function cmdHelp() {
  return [
    "*PremDev Admin Bot — commands*",
    "`/stats` — CPU/mem/disk/load/uptime + container count",
    "`/df` — disk usage + docker system df",
    "`/diskhog` — top space hogs in /opt/premdev + /var/lib/docker",
    "`/docker` — docker ps + docker stats",
    "`/restart [app|caddy|mysql|all]` — restart compose service",
    "`/logs SERVICE [N]` — last N lines of compose service logs (default 80)",
    "`/users` — list app users",
    "`/env [1|2|all]` — list env keys (T2 values masked)",
    "`/getenv KEY` — show full value (logged)",
    "`/setenv KEY VALUE` — set env value (atomic .env write)",
    "`/backup` — trigger off-site backup now",
    "`/monlog` — last 30 lines of monitoring log",
    "`/help` — this help",
  ].join("\n");
}
async function cmdRestart(args) {
  const svc = args[0] || "all";
  const allowed = ["app", "caddy", "mysql", "phpmyadmin", "all"];
  if (!allowed.includes(svc)) return `Unknown service \`${svc}\`. Allowed: ${allowed.join(", ")}.`;
  const dargs = svc === "all"
    ? ["compose", "-f", COMPOSE_FILE, "restart"]
    : ["compose", "-f", COMPOSE_FILE, "restart", svc];
  const r = await sh("docker", dargs, { timeout: 90_000 });
  return r.ok
    ? `Restart *${svc}* ✓\n\`\`\`\n${(r.stdout + r.stderr).trim().slice(-1500)}\n\`\`\``
    : `Restart *${svc}* failed:\n\`\`\`\n${(r.stdout + r.stderr).trim().slice(-1500)}\n\`\`\``;
}
async function cmdLogs(args) {
  const svc = args[0];
  if (!svc) return "Usage: `/logs SERVICE [N]` — e.g. `/logs app 100`";
  const n = Math.min(500, Math.max(10, Number(args[1]) || 80));
  const r = await sh("docker", ["compose", "-f", COMPOSE_FILE, "logs", "--tail", String(n), svc], { timeout: 30_000 });
  const txt = (r.stdout + r.stderr).trim().slice(-3500);
  return `*Logs ${svc} (last ${n})*\n\`\`\`\n${txt || "(empty)"}\n\`\`\``;
}
async function cmdUsers() {
  // Read sqlite via the API container (which has better-sqlite3) — keeps host clean.
  const r = await sh("docker", ["compose", "-f", COMPOSE_FILE, "exec", "-T", "app",
    "node", "-e",
    "const db=require('better-sqlite3')(process.env.SQLITE_PATH||'/var/lib/premdev/premdev.sqlite',{readonly:true});" +
    "const r=db.prepare('SELECT username,email,role,created_at FROM users ORDER BY created_at DESC').all();" +
    "console.log(r.map(u=>`${u.role==='admin'?'[A]':'   '} ${u.username.padEnd(20)} ${u.email}`).join('\\n'));"
  ], { timeout: 15_000 });
  return r.ok ? "*Users*\n```\n" + (r.stdout.trim() || "(none)") + "\n```" : "Failed: " + r.stderr.slice(-400);
}
async function cmdBackup() {
  if (!fs.existsSync(BACKUP_BIN)) return `Backup script not installed at ${BACKUP_BIN}.`;
  // Run detached so the bot doesn't block on a multi-minute backup.
  const child = spawn(BACKUP_BIN, [], { detached: true, stdio: "ignore" });
  child.unref();
  return `Backup kicked off in background (PID ${child.pid}). Watch \`${MONITOR_LOG}\` or wait for the Telegram notification.`;
}
async function cmdMonlog() {
  if (!fs.existsSync(MONITOR_LOG)) return `${MONITOR_LOG} not found.`;
  const r = await sh("tail", ["-n", "30", MONITOR_LOG]);
  return "*Monitor log (last 30)*\n```\n" + (r.stdout.trim() || "(empty)") + "\n```";
}
async function cmdGetenv(args) {
  const key = args[0];
  if (!key) return "Usage: `/getenv KEY`";
  const { map } = loadEnv();
  if (!map.has(key)) return `\`${key}\` not set.`;
  const t = classify(key);
  return `*${key}* (T${t})\n\`\`\`\n${map.get(key) || "(empty)"}\n\`\`\``;
}
async function cmdSetenv(args, raw) {
  const key = args[0];
  if (!key || args.length < 2) return "Usage: `/setenv KEY VALUE`";
  // Re-parse raw to capture VALUE-with-spaces (everything after `/setenv KEY `)
  const m = /^\/setenv\s+([A-Z_][A-Z0-9_]*)\s+([\s\S]+)$/.exec(raw.trim());
  if (!m) return "Bad syntax. KEY must match `[A-Z_][A-Z0-9_]*`.";
  const [, k, v] = m;
  try {
    setEnvKey(k, v);
    const t = classify(k);
    const masked = t === 2 ? maskValue(v) : v;
    return `✓ Set *${k}* (T${t}) = \`${masked}\`\n_${restartHint(k)}_`;
  } catch (e) {
    return "Failed: " + (e.message || e);
  }
}

// ---------- Dispatcher ----------
async function handle(text) {
  const trimmed = text.trim();
  const [head, ...rest] = trimmed.split(/\s+/);
  const cmd = head.toLowerCase().split("@")[0]; // strip @BotName mention suffix
  try {
    switch (cmd) {
      case "/start":
      case "/help":     return cmdHelp();
      case "/stats":    return await cmdStats();
      case "/df":       return await cmdDf();
      case "/diskhog":  return await cmdDiskhog();
      case "/docker":   return await cmdDocker();
      case "/restart":  return await cmdRestart(rest);
      case "/logs":     return await cmdLogs(rest);
      case "/users":    return await cmdUsers();
      case "/env":      return await cmdEnv(rest);
      case "/getenv":   return await cmdGetenv(rest);
      case "/setenv":   return await cmdSetenv(rest, trimmed);
      case "/backup":   return await cmdBackup();
      case "/monlog":   return await cmdMonlog();
      default:          return cmd.startsWith("/") ? `Unknown command. Try /help.` : null;
    }
  } catch (e) {
    return "Error: " + (e.message || String(e)).slice(0, 800);
  }
}

// ---------- Bootstrap ----------
function loadBotConfig() {
  const { map } = loadEnv();
  const token = map.get("TELEGRAM_BOT_TOKEN");
  // Prefer ADMIN_TELEGRAM_ID, but fall back to TELEGRAM_ADMIN_CHAT_ID — in
  // a 1:1 chat between the admin and the bot they are the same numeric ID,
  // so requiring two separate values is just paperwork. The fallback keeps
  // older installs (and anyone who skipped the new prompt) working without
  // a manual edit.
  const adminId = map.get("ADMIN_TELEGRAM_ID") || map.get("TELEGRAM_ADMIN_CHAT_ID");
  if (!token) { console.error("[bot] TELEGRAM_BOT_TOKEN not set in", ENV_FILE); process.exit(2); }
  if (!adminId || !/^-?\d+$/.test(adminId)) {
    console.error("[bot] Neither ADMIN_TELEGRAM_ID nor TELEGRAM_ADMIN_CHAT_ID set",
      "(or non-numeric) in", ENV_FILE,
      "— refusing to start (would accept commands from anyone).");
    process.exit(2);
  }
  // Strip leading minus (group chat IDs are negative, but for command auth
  // we only ever care about a positive user ID — refuse group IDs).
  if (adminId.startsWith("-")) {
    console.error("[bot] ADMIN_TELEGRAM_ID looks like a group/channel ID (negative).",
      "Use your personal Telegram USER ID, not a group chat ID.");
    process.exit(2);
  }
  return { token, adminId: Number(adminId) };
}

async function main() {
  const { token, adminId } = loadBotConfig();
  console.log(`[bot] starting — admin ${adminId}, env ${ENV_FILE}`);
  let me;
  try { me = (await tgRequest(token, "getMe", {})).result; }
  catch (e) { console.error("[bot] getMe failed:", e.message); process.exit(3); }
  console.log(`[bot] connected as @${me.username} (${me.id})`);

  // Best-effort: register slash commands so the Telegram UI shows the menu.
  await tgRequest(token, "setMyCommands", {
    commands: [
      { command: "stats",    description: "CPU/mem/disk/uptime" },
      { command: "df",       description: "Disk usage breakdown" },
      { command: "diskhog",  description: "Top space hogs" },
      { command: "docker",   description: "Containers + stats" },
      { command: "restart",  description: "Restart compose service" },
      { command: "logs",     description: "Tail service logs" },
      { command: "users",    description: "List app users" },
      { command: "env",      description: "List env keys" },
      { command: "getenv",   description: "Get env value" },
      { command: "setenv",   description: "Set env value" },
      { command: "backup",   description: "Run backup now" },
      { command: "monlog",   description: "Tail monitoring log" },
      { command: "help",     description: "Show help" },
    ],
  }).catch(() => {});

  // Drop any pending updates older than now (avoid replaying stale commands
  // queued while the bot was down).
  let offset = 0;
  try {
    const drop = await tgRequest(token, "getUpdates", { timeout: 0, offset: -1 });
    if (drop.result?.length) offset = drop.result[drop.result.length - 1].update_id + 1;
  } catch {}

  // Long-polling loop.
  while (true) {
    let updates;
    try {
      updates = await tgRequest(token, "getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
    } catch (e) {
      console.warn("[bot] getUpdates error:", e.message);
      await sleep(5000); continue;
    }
    for (const u of updates.result) {
      offset = u.update_id + 1;
      const msg = u.message; if (!msg || !msg.text) continue;
      // The single most important access check in this whole file:
      if (msg.from?.id !== adminId) {
        console.log(`[bot] denied: from=${msg.from?.id} (@${msg.from?.username}) text=${msg.text.slice(0, 60)}`);
        continue; // silent drop
      }
      const reply = await handle(msg.text);
      if (reply == null) continue;
      try {
        await tgRequest(token, "sendMessage", {
          chat_id: msg.chat.id, text: reply, parse_mode: "Markdown",
          reply_to_message_id: msg.message_id,
          disable_web_page_preview: true,
        });
      } catch (e) {
        // Markdown can fail on stray underscores / brackets — retry plain.
        await tgRequest(token, "sendMessage", {
          chat_id: msg.chat.id, text: reply, reply_to_message_id: msg.message_id,
          disable_web_page_preview: true,
        }).catch(() => {});
      }
    }
  }
}

main().catch((e) => { console.error("[bot] fatal:", e); process.exit(1); });
