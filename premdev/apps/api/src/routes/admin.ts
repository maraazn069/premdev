import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { db, DbUser, userToPublic, writeAudit } from "../lib/db.js";
import { requireAdmin } from "../lib/auth-helpers.js";
import { ensureMysqlUser } from "../lib/mysql.js";
import { config } from "../lib/config.js";
import { listAIKeysMasked, setAIKey, isEncryptionKeyWeak } from "../lib/ai-settings.js";
import { clientIp } from "../lib/rate-limit.js";
import { embeddingStatus, preloadModel } from "../lib/embeddings.js";
import { indexWorkspace, workspaceIndexStats, clearWorkspaceIndex } from "../lib/semantic-search.js";

// ---------------------------------------------------------------------------
// Backup / restore bridge.
//
// The API container has NO direct access to docker, mysql, or rclone, so we
// can't run backups from here. Instead we use a "trigger file" pattern: write
// a small JSON file into a host-mounted directory; a cron job on the host
// (`premdev-trigger`) picks it up, executes the action, and writes a result
// file we can read back.
//
// Mount: host /opt/premdev/data ↔ container /var/lib/premdev (compose).
// All paths below assume /var/lib/premdev exists in production. In dev (when
// running outside compose) /var/lib/premdev does not exist — endpoints
// gracefully report "not configured" instead of crashing.
// ---------------------------------------------------------------------------
const BACKUP_DATA_DIR = process.env.PREMDEV_DATA_DIR_INSIDE || "/var/lib/premdev";
const TRIGGER_DIR = path.join(BACKUP_DATA_DIR, "triggers");
const INDEX_FILE = path.join(BACKUP_DATA_DIR, "backup_index.json");

function bridgeAvailable(): boolean {
  try { return fs.statSync(TRIGGER_DIR).isDirectory(); } catch { return false; }
}

// Same regex as restore.sh — accept only well-formed snapshot paths.
const SNAPSHOT_RE = /^(daily|weekly)\/[0-9]{8}-[0-9]{6}$/;

function writeTrigger(action: "backup" | "restore" | "refresh-index" | "cleanup", body: Record<string, unknown>): { jobId: string; file: string } {
  if (!bridgeAvailable()) {
    throw Object.assign(new Error("backup bridge not available (host trigger dir missing)"), { statusCode: 503 });
  }
  const jobId = `${Date.now()}-${nanoid(8)}`;
  const file = path.join(TRIGGER_DIR, `${action}-${jobId}.json`);
  // Atomic write: tmp + rename so a half-written file is never picked up.
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ action, jobId, ...body, queuedAt: Date.now() }));
  fs.renameSync(tmp, file);
  return { jobId, file };
}

function readJobs(limit = 20): any[] {
  if (!bridgeAvailable()) return [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(TRIGGER_DIR); } catch { return []; }
  const jobs: any[] = [];
  for (const name of entries) {
    const full = path.join(TRIGGER_DIR, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (name.endsWith(".result.json")) {
      try {
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        jobs.push({ ...j, state: "done", _mtime: stat.mtimeMs });
      } catch { /* skip malformed */ }
    } else if (name.endsWith(".running")) {
      const m = name.match(/^(\w[\w-]*)-(.+)\.running$/);
      if (m) jobs.push({ action: m[1], jobId: m[2], state: "running", _mtime: stat.mtimeMs });
    } else if (name.endsWith(".json")) {
      const m = name.match(/^(\w[\w-]*)-(.+)\.json$/);
      if (m) jobs.push({ action: m[1], jobId: m[2], state: "queued", _mtime: stat.mtimeMs });
    }
  }
  jobs.sort((a, b) => b._mtime - a._mtime);
  return jobs.slice(0, limit).map(({ _mtime, ...rest }) => rest);
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/users", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all() as DbUser[];
    const result = users.map((u) => {
      const c = db.prepare("SELECT COUNT(*) as c FROM workspaces WHERE user_id = ?").get(u.id) as any;
      return { ...userToPublic(u), workspaceCount: c.c };
    });
    return { users: result };
  });

  const NewUser = z.object({
    username: z.string().min(2).regex(/^[a-zA-Z0-9_]+$/),
    email: z.string().email(),
    password: z.string().min(8),
    role: z.enum(["admin", "user"]).default("user"),
    quotaCpu: z.number().min(0.25).default(1),
    quotaMemMb: z.number().int().min(128).default(2048),
    quotaDiskMb: z.number().int().min(512).default(10240),
    maxWorkspaces: z.number().int().min(1).default(3),
  });

  app.post("/users", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = NewUser.parse(req.body);
    const exists = db.prepare("SELECT 1 FROM users WHERE username = ? OR email = ?").get(body.username, body.email);
    if (exists) return reply.code(400).send({ error: "User already exists" });
    const id = nanoid(12);
    const hash = bcrypt.hashSync(body.password, 10);
    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, quota_cpu, quota_mem_mb, quota_disk_mb, max_workspaces, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, body.username, body.email, hash, body.role, body.quotaCpu, body.quotaMemMb, body.quotaDiskMb, body.maxWorkspaces, Date.now());
    // Provision MySQL user with shared password
    if (config.MYSQL_USER_PASSWORD) {
      await ensureMysqlUser(body.username, config.MYSQL_USER_PASSWORD).catch((e) => {
        app.log.warn({ e }, "MySQL user provisioning failed");
      });
    }
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as DbUser;
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "user-create", target: u.username,
      meta: { role: u.role, quotaCpu: u.quota_cpu, quotaMemMb: u.quota_mem_mb },
    });
    return { user: userToPublic(u) };
  });

  app.delete("/users/:id", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const id = (req.params as any).id;
    if (id === a.id) return reply.code(400).send({ error: "Cannot delete yourself" });
    const target = db.prepare("SELECT username FROM users WHERE id = ?").get(id) as any;
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "user-delete", target: target?.username ?? id,
    });
    return { ok: true };
  });

  app.get("/ai-keys", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    return { keys: listAIKeysMasked(), encryptionWeak: isEncryptionKeyWeak() };
  });

  const KeyBody = z.object({
    provider: z.enum(["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"]),
    value: z.string().max(500),
  });
  app.put("/ai-keys", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = KeyBody.parse(req.body);
    const trimmed = body.value.trim();
    setAIKey(body.provider, trimmed);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: trimmed ? "ai-key-set" : "ai-key-remove",
      target: body.provider,
    });
    return { ok: true, keys: listAIKeysMasked(), encryptionWeak: isEncryptionKeyWeak() };
  });

  // === AI tool-call audit (admin view) ===
  // Filterable across all users. The frontend uses this for the admin's
  // "what did the AI do for everyone" dashboard.
  app.get("/ai-tool-calls", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const userFilter = typeof q.user === "string" && q.user ? q.user : null;
    const wsFilter = typeof q.workspace === "string" && q.workspace ? q.workspace : null;
    const where: string[] = [];
    const args: any[] = [];
    if (userFilter) { where.push("user_id = ?"); args.push(userFilter); }
    if (wsFilter)   { where.push("workspace_id = ?"); args.push(wsFilter); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT t.*, u.username
      FROM ai_tool_calls t
      LEFT JOIN users u ON u.id = t.user_id
      ${whereSql}
      ORDER BY t.created_at DESC LIMIT ?
    `).all(...args);
    return { rows };
  });

  app.get("/stats", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const totalUsers = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any).c;
    const totalWorkspaces = (db.prepare("SELECT COUNT(*) as c FROM workspaces").get() as any).c;
    const runningWorkspaces = (db.prepare("SELECT COUNT(*) as c FROM workspaces WHERE status = 'running'").get() as any).c;

    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const cpus = os.cpus();
    const load = os.loadavg()[0];
    const cpuPercent = Math.min(100, (load / cpus.length) * 100);

    // Real disk usage on the workspaces volume (best-effort; statvfs via fs).
    let diskUsedMb = 0;
    let diskTotalMb = 0;
    try {
      const s: any = (fs as any).statfsSync?.(config.WORKSPACES_DIR);
      if (s) {
        diskTotalMb = Math.round((s.blocks * s.bsize) / (1024 * 1024));
        diskUsedMb  = Math.round(((s.blocks - s.bavail) * s.bsize) / (1024 * 1024));
      }
    } catch {}

    return {
      totalUsers,
      totalWorkspaces,
      runningWorkspaces,
      cpuPercent,
      memUsedMb: Math.round((totalmem - freemem) / (1024 * 1024)),
      memTotalMb: Math.round(totalmem / (1024 * 1024)),
      diskUsedMb,
      diskTotalMb,
    };
  });

  // === Login attempts (admin view) ===
  // Includes both successes and failures so admins can spot brute-force
  // attempts (many fails from one IP) and verify legitimate logins.
  app.get("/login-attempts", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const ipFilter = typeof q.ip === "string" && q.ip ? q.ip : null;
    const onlyFails = q.onlyFails === "1" || q.onlyFails === "true";
    const where: string[] = [];
    const args: any[] = [];
    if (ipFilter) { where.push("ip = ?"); args.push(ipFilter); }
    if (onlyFails) { where.push("ok = 0"); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT * FROM login_attempts ${whereSql}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args);
    // Aggregate fails per IP in last 24h to flag suspect attackers.
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const topFails = db.prepare(`
      SELECT ip, COUNT(*) as fails
      FROM login_attempts
      WHERE ok = 0 AND created_at > ?
      GROUP BY ip ORDER BY fails DESC LIMIT 10
    `).all(cutoff);
    return { rows, topFails };
  });

  // === Generic security/admin audit log (admin view) ===
  app.get("/audit-log", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const q = req.query as any;
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const action = typeof q.action === "string" && q.action ? q.action : null;
    const actor = typeof q.actor === "string" && q.actor ? q.actor : null;
    const where: string[] = [];
    const args: any[] = [];
    if (action) { where.push("action = ?"); args.push(action); }
    if (actor)  { where.push("actor_username = ?"); args.push(actor); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    args.push(limit);
    const rows = db.prepare(`
      SELECT * FROM audit_log ${whereSql}
      ORDER BY created_at DESC LIMIT ?
    `).all(...args);
    return { rows };
  });

  // ===== Backups (R2) =====================================================
  // List of snapshots — read from the index file maintained by
  // /usr/local/sbin/premdev-refresh-index (cron + post-backup hook).
  app.get("/backups", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    if (!bridgeAvailable()) {
      return { configured: false, snapshots: [], jobs: [], reason: "host bridge not mounted (dev mode?)" };
    }
    let index: any = { configured: false, snapshots: [], updatedAt: 0 };
    try {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    } catch {
      // No index yet — common right after install. Tell the UI so it can
      // offer a "Refresh" button rather than failing silently.
      return { configured: false, snapshots: [], jobs: readJobs(), reason: "index not built yet — click Refresh" };
    }
    return { ...index, jobs: readJobs() };
  });

  // Trigger a backup now (queues a job for the host runner).
  app.post("/backups/run", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const j = writeTrigger("backup", { requestedBy: a.username });
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "backup-run", target: j.jobId,
      });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Refresh the snapshot index from R2 (cheap; just rclone lsjson).
  app.post("/backups/refresh", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const j = writeTrigger("refresh-index", { requestedBy: a.username });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // ===== System maintenance =================================================
  // Trigger an on-demand Docker cleanup (prune containers/images/builder/
  // volumes). The host runner executes /usr/local/sbin/premdev-docker-cleanup
  // and returns the freed bytes. Same daily script also runs from cron.
  app.post("/system/cleanup", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    try {
      const j = writeTrigger("cleanup", { requestedBy: a.username });
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "system-cleanup", target: j.jobId,
      });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // Restore from a specific snapshot. DESTRUCTIVE — gated by an explicit
  // confirmation phrase the UI requires the operator to type.
  app.post("/backups/restore", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const body = z.object({
      snapshot: z.string().regex(SNAPSHOT_RE, "snapshot must be (daily|weekly)/YYYYMMDD-HHMMSS"),
      confirm:  z.string(),
    }).parse(req.body);
    // Belt-and-braces: require typed confirmation matching the snapshot
    // path. Stops "click the wrong row" mishaps.
    if (body.confirm !== body.snapshot) {
      return reply.code(400).send({ error: "confirm must equal snapshot path" });
    }
    try {
      const j = writeTrigger("restore", { snapshot: body.snapshot, requestedBy: a.username });
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "backup-restore", target: body.snapshot, meta: { jobId: j.jobId },
      });
      return { ok: true, jobId: j.jobId };
    } catch (e: any) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // -------------------------------------------------------------------------
  // Semantic search admin (TODO #2 — token-saving feature).
  //
  // The embedding model is loaded lazily on first /chat call. These endpoints
  // give the operator visibility (status + per-workspace stats) and manual
  // controls (preload, reindex, clear) without having to SSH into the box.
  // -------------------------------------------------------------------------

  app.get("/semantic-search/status", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const model = embeddingStatus();
    // Per-workspace breakdown joined with the user that owns each workspace.
    const rows = db.prepare(`
      SELECT w.id, w.name, w.user_id, u.username
      FROM workspaces w
      LEFT JOIN users u ON u.id = w.user_id
      ORDER BY u.username, w.name
    `).all() as Array<{ id: string; name: string; user_id: string; username: string | null }>;
    const workspaces = rows.map((r) => {
      const stats = workspaceIndexStats(r.id);
      return {
        id: r.id,
        name: r.name,
        username: r.username,
        ...stats,
      };
    });
    const totals = workspaces.reduce(
      (acc, w) => ({
        chunks: acc.chunks + w.chunks,
        files: acc.files + w.files,
        dbBytes: acc.dbBytes + w.dbBytes,
        indexed: acc.indexed + (w.exists && w.chunks > 0 ? 1 : 0),
      }),
      { chunks: 0, files: 0, dbBytes: 0, indexed: 0 }
    );
    return { model, workspaces, totals: { ...totals, totalWorkspaces: workspaces.length } };
  });

  app.post("/semantic-search/preload", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    // Fire-and-forget — model load can take ~30s on first run (download).
    // The status endpoint will report state="loading" → "ready".
    preloadModel().catch((e) => {
      // Errors are surfaced via embeddingStatus().error on the next status poll.
      // Logging here is best-effort.
      // eslint-disable-next-line no-console
      console.error("[semantic-search] preload failed:", e);
    });
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "semantic-preload", target: "model",
    });
    return { ok: true, started: true };
  });

  // Workspace IDs are nanoid(16) — strict allowlist defends path joining in
  // semantic-search helpers from `../`-style escapes if a malformed param
  // ever slips past the SQL existence check.
  const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  app.post("/semantic-search/reindex/:workspaceId", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { workspaceId } = req.params as { workspaceId: string };
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return reply.code(400).send({ error: "invalid workspaceId" });
    }
    // Verify the workspace exists; gives a clean 404 instead of an empty
    // index DB getting created in /tmp by mistake.
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id?: string } | undefined;
    if (!w?.id) return reply.code(404).send({ error: "workspace not found" });
    try {
      const result = await indexWorkspace(workspaceId);
      writeAudit({
        actorId: a.id, actorUsername: a.username, ip: clientIp(req),
        action: "semantic-reindex", target: workspaceId,
        // Spread into a fresh object literal so the named IndexResult
        // interface widens to the Record<string, unknown> writeAudit expects.
        meta: { ...result } as Record<string, unknown>,
      });
      return { ok: true, ...result };
    } catch (e: any) {
      return reply.code(500).send({ error: e?.message || "reindex failed" });
    }
  });

  app.delete("/semantic-search/index/:workspaceId", async (req, reply) => {
    const a = await requireAdmin(req, reply);
    if (!a) return;
    const { workspaceId } = req.params as { workspaceId: string };
    if (!WORKSPACE_ID_RE.test(workspaceId)) {
      return reply.code(400).send({ error: "invalid workspaceId" });
    }
    // Match reindex semantics: 404 for unknown ids so the audit log doesn't
    // record fake "success" entries (and so we don't silently no-op when an
    // operator typos a workspace id).
    const w = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId) as { id?: string } | undefined;
    if (!w?.id) return reply.code(404).send({ error: "workspace not found" });
    clearWorkspaceIndex(workspaceId);
    writeAudit({
      actorId: a.id, actorUsername: a.username, ip: clientIp(req),
      action: "semantic-clear", target: workspaceId,
    });
    return { ok: true };
  });
};
