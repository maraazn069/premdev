import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.SQLITE_PATH), { recursive: true });
fs.mkdirSync(config.WORKSPACES_DIR, { recursive: true });

export const db = new Database(config.SQLITE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      quota_cpu REAL NOT NULL DEFAULT 1,
      quota_mem_mb INTEGER NOT NULL DEFAULT 2048,
      quota_disk_mb INTEGER NOT NULL DEFAULT 10240,
      max_workspaces INTEGER NOT NULL DEFAULT 3,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      template TEXT NOT NULL DEFAULT 'blank',
      status TEXT NOT NULL DEFAULT 'stopped',
      container_id TEXT,
      preview_port INTEGER,
      run_command TEXT,
      env_vars TEXT NOT NULL DEFAULT '{}',
      last_active_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subdomain TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_tool_calls (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      kind TEXT NOT NULL,
      target TEXT,
      ok INTEGER NOT NULL,
      output_preview TEXT,
      created_at INTEGER NOT NULL
    );

    -- Login attempts: every login (success or fail). Used for brute-force
    -- lockout (N fails in a window blocks the IP) and admin audit visibility.
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      username TEXT,
      ok INTEGER NOT NULL,
      reason TEXT,
      ua TEXT,
      created_at INTEGER NOT NULL
    );

    -- Generic security/admin audit log: who did what when. Distinct from
    -- ai_tool_calls (which is per-AI-action). Used for: user-create, user-
    -- delete, password-change, ai-key-set, deployment, restore, etc.
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_username TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      target TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);
    CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace ON checkpoints(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_ai_tool_user ON ai_tool_calls(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_tool_workspace ON ai_tool_calls(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, created_at DESC);
  `);

  // Add last_shell_activity_at column if missing (idempotent migration).
  // Persisted in DB so the idle reaper survives API restarts cleanly —
  // otherwise every restart hands containers a fresh 30-min lease.
  const cols = db.prepare("PRAGMA table_info(workspaces)").all() as any[];
  if (!cols.find((c) => c.name === "last_shell_activity_at")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN last_shell_activity_at INTEGER");
  }

  // Custom subdomain — lets the user route this workspace under any
  // unused single-component subdomain (e.g. "myapp.flixprem.org")
  // instead of the auto-generated "<project>-<user>" form. Unique across
  // all workspaces; NULL means "use the default <project>-<user> shape".
  if (!cols.find((c) => c.name === "custom_subdomain")) {
    db.exec("ALTER TABLE workspaces ADD COLUMN custom_subdomain TEXT");
  }
  // Partial unique index — multiple NULLs are allowed (default shape),
  // but two workspaces can never share the same custom subdomain.
  // Created unconditionally with IF NOT EXISTS so an older partial migration
  // (column added but index missing) self-heals on the next API boot.
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_custom_subdomain ON workspaces(custom_subdomain) WHERE custom_subdomain IS NOT NULL",
  );
}

/**
 * Periodically prune very old rows from the high-churn audit tables so the
 * SQLite file doesn't grow without bound under sustained abuse. Retention:
 *   - login_attempts: 90 days  (long enough for forensics, short enough
 *                                that a hostile bot farm can't bloat us)
 *   - audit_log:      180 days (admin actions are lower-volume)
 *
 * Runs on startup (after a small delay) then every 24h. Cheap — both
 * tables have an index on created_at.
 */
function startAuditPruner() {
  const prune = () => {
    try {
      const cutoffLogin = Date.now() - 90 * 24 * 60 * 60_000;
      const a = db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(cutoffLogin);
      const cutoffAudit = Date.now() - 180 * 24 * 60 * 60_000;
      const b = db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoffAudit);
      if (a.changes || b.changes) {
        console.log(`[audit-pruner] deleted login_attempts=${a.changes} audit_log=${b.changes}`);
      }
    } catch (e: any) {
      console.warn("[audit-pruner] failed:", e?.message ?? e);
    }
  };
  // First run after 5 min so it doesn't compete with bootstrap; then daily.
  setTimeout(prune, 5 * 60_000).unref?.();
  setInterval(prune, 24 * 60 * 60_000).unref?.();
}
startAuditPruner();

/**
 * Append a row to the generic audit_log. Fire-and-forget — never throws so
 * audit failures can't break the calling request.
 */
export function writeAudit(opts: {
  actorId?: string | null;
  actorUsername?: string | null;
  ip?: string | null;
  action: string;
  target?: string | null;
  meta?: Record<string, unknown> | null;
}): void {
  try {
    db.prepare(`
      INSERT INTO audit_log (id, actor_id, actor_username, ip, action, target, meta, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(16),
      opts.actorId ?? null,
      opts.actorUsername ?? null,
      opts.ip ?? null,
      opts.action,
      opts.target ?? null,
      opts.meta ? JSON.stringify(opts.meta).slice(0, 4000) : null,
      Date.now(),
    );
  } catch {
    // Never propagate — audit must not break the calling request.
  }
}

export function ensureFirstAdmin() {
  const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as { c: number };
  if (count.c > 0) return;

  const id = nanoid(12);
  const hash = bcrypt.hashSync(config.ADMIN_PASSWORD, 10);
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, quota_cpu, quota_mem_mb, quota_disk_mb, max_workspaces, created_at)
    VALUES (?, ?, ?, ?, 'admin', 4, 8192, 51200, 100, ?)
  `).run(id, config.ADMIN_USERNAME, config.ADMIN_EMAIL, hash, Date.now());
  console.log(`✅ Bootstrap admin created: ${config.ADMIN_USERNAME} (${config.ADMIN_EMAIL})`);
}

export type DbUser = {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: "admin" | "user";
  quota_cpu: number;
  quota_mem_mb: number;
  quota_disk_mb: number;
  max_workspaces: number;
  created_at: number;
};

export type DbWorkspace = {
  id: string;
  user_id: string;
  name: string;
  template: string;
  status: "stopped" | "starting" | "running" | "error";
  container_id: string | null;
  preview_port: number | null;
  run_command: string | null;
  env_vars: string;
  last_active_at: number | null;
  created_at: number;
  custom_subdomain: string | null;
};

export function userToPublic(u: DbUser) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    quotaCpu: u.quota_cpu,
    quotaMemMb: u.quota_mem_mb,
    quotaDiskMb: u.quota_disk_mb,
    maxWorkspaces: u.max_workspaces,
    createdAt: new Date(u.created_at).toISOString(),
  };
}

/**
 * Sanitise a name for use as a DNS label: lowercase, [a-z0-9-] only,
 * collapse runs of dashes, strip leading/trailing dashes.
 */
export function dnsSafe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "x";
}

export function workspaceUrl(projectName: string, username: string, customSubdomain?: string | null): string {
  const proto = process.env.PROTOCOL ?? "https";
  // Custom subdomain (single component) wins when set — that's the whole
  // point of the feature: a stable, user-chosen URL that survives project
  // rename and doesn't include the username.
  const sub = customSubdomain && customSubdomain.trim()
    ? dnsSafe(customSubdomain)
    : `${dnsSafe(projectName)}-${dnsSafe(username)}`;
  return `${proto}://${sub}.${config.PRIMARY_DOMAIN}`;
}

/**
 * Default (auto-generated) URL — always shown next to the custom URL so
 * the user can see the fallback even when they've set a custom subdomain.
 */
export function defaultWorkspaceUrl(projectName: string, username: string): string {
  const proto = process.env.PROTOCOL ?? "https";
  return `${proto}://${dnsSafe(projectName)}-${dnsSafe(username)}.${config.PRIMARY_DOMAIN}`;
}

export function workspaceToPublic(w: DbWorkspace) {
  // Lookup username so we can build the new <project>-<user>.<domain> URL.
  const userRow = db
    .prepare("SELECT username FROM users WHERE id = ?")
    .get(w.user_id) as { username?: string } | undefined;
  const username = userRow?.username ?? "user";
  // URL is shown whenever the workspace is running. The subdomain is stable
  // (project + user OR custom), so it doubles as the deploy URL — no
  // separate publish step needed for always-on workspaces.
  const previewUrl = w.status === "running"
    ? workspaceUrl(w.name, username, w.custom_subdomain)
    : undefined;
  const defaultUrl = defaultWorkspaceUrl(w.name, username);
  return {
    id: w.id,
    name: w.name,
    template: w.template,
    status: w.status,
    previewPort: w.preview_port ?? undefined,
    previewUrl,
    defaultUrl,
    customSubdomain: w.custom_subdomain ?? null,
    createdAt: new Date(w.created_at).toISOString(),
    runCommand: w.run_command,
  };
}

/**
 * Validate a candidate subdomain label. Returns null on success, otherwise
 * a human-readable error message. Single label only — multi-component
 * (e.g. `foo.bar`) is rejected because we route on first label only.
 */
export function validateSubdomainLabel(label: string): string | null {
  if (!label) return "Subdomain cannot be empty";
  if (label.length < 2) return "Subdomain must be at least 2 characters";
  if (label.length > 50) return "Subdomain must be at most 50 characters";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
    return "Subdomain must contain only lowercase letters, digits, and hyphens (and may not start or end with a hyphen)";
  }
  if (label.includes("--")) return "Subdomain may not contain consecutive hyphens";
  return null;
}

