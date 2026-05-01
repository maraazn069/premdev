import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { simpleGit } from "simple-git";
import { db, DbWorkspace, workspaceToPublic, validateSubdomainLabel, dnsSafe } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { applyTemplate, getTemplate } from "../lib/templates.js";
import { detectRunCommand } from "../lib/project-hints.js";
import { readWorkspaceConfig, ensureWorkspaceConfig, configPath, CONFIG_FILENAME, patchWorkspaceConfig } from "../lib/workspace-config.js";
import {
  ensureWorkspaceDir,
  workspacePath,
  isDocker,
  startContainer,
  stopContainer,
  startLocal,
  stopLocal,
  isLocalRunning,
  getContainerLogs,
  runOneOff,
  stopShellContainer,
} from "../lib/runtime.js";
import { config } from "../lib/config.js";
import { closeWorkspaceDb } from "../lib/semantic-search.js";
import { createProjectDb, dropProjectDb, ensureMysqlUser, runWorkspaceQuery } from "../lib/mysql.js";
import { createCheckpoint, listCheckpoints, listCheckpointFiles, restoreCheckpoint, deleteCheckpoint, deleteAllCheckpointsFor } from "../lib/checkpoints.js";

export const workspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const list = db
      .prepare("SELECT * FROM workspaces WHERE user_id = ? ORDER BY created_at DESC")
      .all(u.id) as DbWorkspace[];
    return { workspaces: list.map(workspaceToPublic) };
  });

  app.get("/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    return { workspace: workspaceToPublic(w) };
  });

  const Create = z.object({
    name: z.string().min(1).max(64),
    template: z.string().default("blank"),
    gitUrl: z.string().optional(),
  });

  app.post("/", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = Create.parse(req.body);
    const id = nanoid(10);
    const dir = ensureWorkspaceDir(id);

    if (body.template === "git" && body.gitUrl) {
      try {
        await simpleGit().clone(body.gitUrl, dir);
      } catch (e: any) {
        return reply.code(400).send({ error: `Git clone failed: ${e.message}` });
      }
    } else if (body.template === "blank") {
      // empty
    } else {
      applyTemplate(dir, body.template);
    }

    const tmpl = getTemplate(body.template === "git" || body.template === "zip" ? "blank" : body.template);
    const dbName = await createProjectDb(u.username, body.name).catch(() => null);

    // Persist NULL when the template's runCommand is just the placeholder, so
    // resolveRunCommand at start time falls through to detect/template logic
    // instead of treating the placeholder as a "user override".
    const PLACEHOLDER = "echo 'No run command set'";
    const initialRunCommand =
      tmpl.runCommand && tmpl.runCommand !== PLACEHOLDER ? tmpl.runCommand : null;

    // Write a Replit-style `.premdev` populated from the template so the AI
    // (and the human reading the file) can immediately tell the language,
    // entrypoint, modules, and run command.
    try {
      ensureWorkspaceConfig(dir, {
        run: initialRunCommand ?? "",
        language: tmpl.language,
        entrypoint: tmpl.entrypoint,
        modules: tmpl.modules,
        env: dbName ? { DATABASE_NAME: dbName } : {},
      });
    } catch {}
    db.prepare(`
      INSERT INTO workspaces (id, user_id, name, template, status, run_command, env_vars, created_at)
      VALUES (?, ?, ?, ?, 'stopped', ?, ?, ?)
    `).run(id, u.id, body.name, body.template, initialRunCommand, JSON.stringify(dbName ? { DATABASE_NAME: dbName } : {}), Date.now());

    const w = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(w) };
  });

  // Shared helper: extract a zip buffer into targetDir with zip-slip protection.
  async function extractZipBuffer(zipBuf: Buffer, targetDir: string, scratchId: string) {
    const zipPath = path.join(targetDir, "..", `${scratchId}.zip`);
    fs.writeFileSync(zipPath, zipBuf);
    const rootDir = path.resolve(targetDir);
    function safeJoin(name: string): string | null {
      if (!name || path.isAbsolute(name) || name.includes("\0")) return null;
      const candidate = path.resolve(rootDir, name);
      const rel = path.relative(rootDir, candidate);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
      return candidate;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
          if (err) return reject(err);
          zip.readEntry();
          zip.on("entry", (entry) => {
            const out = safeJoin(entry.fileName);
            if (!out) { zip.readEntry(); return; }
            if (/\/$/.test(entry.fileName)) {
              fs.mkdirSync(out, { recursive: true });
              zip.readEntry();
            } else {
              fs.mkdirSync(path.dirname(out), { recursive: true });
              zip.openReadStream(entry, (e2, rs) => {
                if (e2) return reject(e2);
                const ws = fs.createWriteStream(out);
                rs.pipe(ws).on("close", () => zip.readEntry());
              });
            }
          });
          zip.on("end", () => resolve());
          zip.on("error", reject);
        });
      });
    } finally {
      try { fs.unlinkSync(zipPath); } catch {}
    }
  }

  app.post("/upload", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const parts = req.parts();
    let name = "";
    let zipBuf: Buffer | null = null;
    for await (const p of parts) {
      if (p.type === "field" && p.fieldname === "name") name = String((p as any).value);
      if (p.type === "file" && p.fieldname === "file") {
        zipBuf = await (p as any).toBuffer();
      }
    }
    if (!name || !zipBuf) return reply.code(400).send({ error: "Missing name or file" });

    const id = nanoid(10);
    const dir = ensureWorkspaceDir(id);
    await extractZipBuffer(zipBuf, dir, id);

    const dbName = await createProjectDb(u.username, name).catch(() => null);
    db.prepare(`
      INSERT INTO workspaces (id, user_id, name, template, status, run_command, env_vars, created_at)
      VALUES (?, ?, ?, 'zip', 'stopped', NULL, ?, ?)
    `).run(id, u.id, name, JSON.stringify(dbName ? { DATABASE_NAME: dbName } : {}), Date.now());

    const w = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(w) };
  });

  // Upload a zip into an EXISTING workspace (overlay/extract on top).
  app.post("/:id/upload-zip", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    let zipBuf: Buffer | null = null;
    for await (const p of req.parts()) {
      if (p.type === "file" && p.fieldname === "file") {
        zipBuf = await (p as any).toBuffer();
      }
    }
    if (!zipBuf) return reply.code(400).send({ error: "Missing file" });

    const dir = workspacePath(id);
    if (!fs.existsSync(dir)) ensureWorkspaceDir(id);
    try {
      await extractZipBuffer(zipBuf, dir, `upload-${nanoid(6)}`);
    } catch (e: any) {
      return reply.code(400).send({ error: `Extract failed: ${e.message ?? e}` });
    }
    return { ok: true };
  });

  app.post("/:id/start", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    db.prepare("UPDATE workspaces SET status = 'starting', last_active_at = ? WHERE id = ?").run(Date.now(), id);

    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const cmd = resolveRunCommand(w, tmpl, dir);
    // `.premdev` `port` overrides the template's default. This is how a
    // user pins the preview port to whatever their app hardcodes (e.g.
    // Flask 5000, Django 8000) without rewriting the app to read $PORT.
    const cfg = readWorkspaceConfig(dir);
    const port = (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536)
      ? cfg.port
      : tmpl.port;

    try {
      // Self-heal: make sure the per-user MySQL account + project DB exist
      // before injecting credentials into the workspace env. Idempotent — safe
      // to call on every start. Both calls swallow errors so a missing
      // MYSQL_USER_PASSWORD or unreachable mysql doesn't block code execution.
      if (config.MYSQL_USER_PASSWORD) {
        await ensureMysqlUser(u.username, config.MYSQL_USER_PASSWORD).catch(() => {});
      }
      await createProjectDb(u.username, w.name).catch(() => {});

      if (isDocker()) {
        const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as any;
        await startContainer({
          workspaceId: id,
          username: u.username,
          cpu: userRow.quota_cpu,
          memMb: userRow.quota_mem_mb,
          diskMb: userRow.quota_disk_mb,
          port,
          envVars: resolveEnvVars(w, dir),
          runCommand: cmd,
        });
      } else {
        startLocal(id, cmd, dir, port);
      }
      db.prepare("UPDATE workspaces SET status = 'running', preview_port = ? WHERE id = ?").run(port, id);
    } catch (e: any) {
      db.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(id);
      return reply.code(500).send({ error: e.message });
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  app.post("/:id/stop", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) await stopContainer(id);
    else stopLocal(id);

    db.prepare("UPDATE workspaces SET status = 'stopped', preview_port = NULL WHERE id = ?").run(id);
    return { ok: true };
  });

  app.post("/:id/restart", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) await stopContainer(id);
    else stopLocal(id);

    db.prepare("UPDATE workspaces SET status = 'starting', last_active_at = ? WHERE id = ?").run(Date.now(), id);

    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const cmd = resolveRunCommand(w, tmpl, dir);
    const cfg = readWorkspaceConfig(dir);
    const port = (cfg?.port && Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536)
      ? cfg.port
      : tmpl.port;

    try {
      if (isDocker()) {
        const userRow = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as any;
        await startContainer({
          workspaceId: id,
          username: u.username,
          cpu: userRow.quota_cpu,
          memMb: userRow.quota_mem_mb,
          diskMb: userRow.quota_disk_mb,
          port,
          envVars: resolveEnvVars(w, dir),
          runCommand: cmd,
        });
      } else {
        startLocal(id, cmd, dir, port);
      }
      db.prepare("UPDATE workspaces SET status = 'running', preview_port = ? WHERE id = ?").run(port, id);
    } catch (e: any) {
      db.prepare("UPDATE workspaces SET status = 'error' WHERE id = ?").run(id);
      return reply.code(500).send({ error: e.message });
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  // ---------------------------------------------------------------------
  // Custom subdomain — lets the user route this workspace under any unused
  // single-component subdomain (e.g. "myapp.flixprem.org") instead of the
  // auto-generated "<project>-<user>" form. Setting takes effect on next
  // request (proxy.ts checks custom_subdomain first).
  //
  // Reserved labels (api/admin/db/...) are rejected so a user can't shadow
  // first-party services. Collisions across workspaces return 409.
  // ---------------------------------------------------------------------
  const RESERVED_SUB_LABELS = new Set([
    "app", "admin", "db", "api", "ws", "preview", "deploy", "www",
    "mail", "smtp", "imap", "ftp", "cpanel", "phpmyadmin", "static",
    "assets", "cdn", "media", "blog", "docs", "help", "support",
  ]);

  app.get("/check-subdomain", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = req.query as any;
    const raw = String(q?.value ?? "").toLowerCase().trim();
    const ignoreId = q?.ignoreId ? String(q.ignoreId) : null;
    if (!raw) return { ok: false, available: false, error: "Subdomain cannot be empty" };
    const err = validateSubdomainLabel(raw);
    if (err) return { ok: false, available: false, error: err };
    if (RESERVED_SUB_LABELS.has(raw)) {
      return { ok: false, available: false, error: `"${raw}" is a reserved subdomain` };
    }
    // Two collision sources:
    //   1. another workspace already has this custom subdomain
    //   2. it would collide with the auto-generated "<proj>-<user>" form
    //      of an existing workspace (only if the requested label has the
    //      "x-y" shape, otherwise the auto-form can never collide)
    const customClash = db
      .prepare("SELECT id FROM workspaces WHERE custom_subdomain = ? AND id != ?")
      .get(raw, ignoreId ?? "") as { id: string } | undefined;
    if (customClash) {
      return { ok: false, available: false, error: "Subdomain is already taken by another workspace" };
    }
    if (raw.includes("-")) {
      // Only workspaces still on the auto form can clash with `<a>-<b>`.
      // Rows that already have a custom_subdomain set don't route via the
      // auto form anymore (see proxy.ts:resolveSubdomain), so excluding
      // them here avoids over-restricting otherwise-free labels.
      const rows = db
        .prepare(`
          SELECT w.id, w.name, u.username FROM workspaces w
          JOIN users u ON u.id = w.user_id
          WHERE w.id != ? AND w.custom_subdomain IS NULL
        `)
        .all(ignoreId ?? "") as Array<{ id: string; name: string; username: string }>;
      const autoClash = rows.find((r) => `${dnsSafe(r.name)}-${dnsSafe(r.username)}` === raw);
      if (autoClash) {
        return {
          ok: false,
          available: false,
          error: `Subdomain "${raw}" is already used by the default URL of another workspace`,
        };
      }
    }
    return { ok: true, available: true };
  });

  const SubdomainBody = z.object({
    // null/empty clears the custom subdomain (revert to default).
    subdomain: z.string().max(50).nullable(),
  });
  app.put("/:id/subdomain", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = SubdomainBody.parse(req.body);
    const raw = body.subdomain == null ? null : body.subdomain.toLowerCase().trim();

    if (!raw) {
      // Clear → revert to <project>-<user>.
      db.prepare("UPDATE workspaces SET custom_subdomain = NULL WHERE id = ?").run(id);
      const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
      return { workspace: workspaceToPublic(updated) };
    }

    const err = validateSubdomainLabel(raw);
    if (err) return reply.code(400).send({ error: err });
    if (RESERVED_SUB_LABELS.has(raw)) {
      return reply.code(400).send({ error: `"${raw}" is a reserved subdomain` });
    }
    // Collision check (same logic as /check-subdomain — duplicated here so
    // we don't have a TOCTOU window where two PUTs race past a stale check).
    const customClash = db
      .prepare("SELECT id FROM workspaces WHERE custom_subdomain = ? AND id != ?")
      .get(raw, id) as { id: string } | undefined;
    if (customClash) {
      return reply.code(409).send({ error: "Subdomain is already taken by another workspace" });
    }
    if (raw.includes("-")) {
      // Same exclusion as /check-subdomain: ignore workspaces that already
      // use a custom subdomain — they can't auto-clash anymore.
      const rows = db
        .prepare(`
          SELECT w.id, w.name, u.username FROM workspaces w
          JOIN users u ON u.id = w.user_id
          WHERE w.id != ? AND w.custom_subdomain IS NULL
        `)
        .all(id) as Array<{ id: string; name: string; username: string }>;
      const autoClash = rows.find((r) => `${dnsSafe(r.name)}-${dnsSafe(r.username)}` === raw);
      if (autoClash) {
        return reply.code(409).send({
          error: `Subdomain "${raw}" is already used by the default URL of another workspace`,
        });
      }
    }
    try {
      db.prepare("UPDATE workspaces SET custom_subdomain = ? WHERE id = ?").run(raw, id);
    } catch (e: any) {
      // Falls through if the partial-unique index trips (race with a
      // concurrent insert). Translate to a friendly 409.
      if (String(e?.message ?? "").includes("UNIQUE")) {
        return reply.code(409).send({ error: "Subdomain is already taken (race)" });
      }
      throw e;
    }
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  const RunCmdBody = z.object({ runCommand: z.string().max(4000).nullable() });
  app.put("/:id/run-command", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = RunCmdBody.parse(req.body);
    const value = body.runCommand && body.runCommand.trim() ? body.runCommand.trim() : null;
    db.prepare("UPDATE workspaces SET run_command = ? WHERE id = ?").run(value, id);
    const updated = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as DbWorkspace;
    return { workspace: workspaceToPublic(updated) };
  });

  // .premdev — returns the resolved command + raw config so the UI can
  // show "this is how Run will be resolved" right next to the editable file.
  app.get("/:id/config", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const dir = workspacePath(id);
    const tmpl = getTemplate(w.template);
    const cfg = readWorkspaceConfig(dir) ?? {};
    const resolved = resolveRunCommand(w, tmpl, dir);
    const detected = detectRunCommand(dir);
    return {
      filename: CONFIG_FILENAME,
      config: cfg,
      resolvedRunCommand: resolved,
      detectedRunCommand: detected,
      templateRunCommand: tmpl.runCommand,
    };
  });

  // Create-on-open helper: ensures `.premdev` exists so the editor can
  // open it like any other file. Returns its workspace-relative path.
  app.post("/:id/config/init", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const dir = workspacePath(id);
    fs.mkdirSync(dir, { recursive: true });
    ensureWorkspaceConfig(dir);
    return { path: CONFIG_FILENAME };
  });

  // Safe MERGE patch into `.premdev`. Used by the AI's
  // `workspace:setRun` and `workspace:setEnv` actions so secrets the user has
  // already stored in env (DB creds, API tokens, etc.) survive an AI edit.
  // Pass `env: { KEY: null }` to delete a key.
  const PatchBody = z.object({
    run: z.string().max(2000).optional(),
    env: z.record(z.union([z.string().max(8000), z.null()])).optional(),
  });
  app.post("/:id/config/patch", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = PatchBody.parse(req.body ?? {});
    const dir = workspacePath(id);
    fs.mkdirSync(dir, { recursive: true });
    const merged = patchWorkspaceConfig(dir, body);
    return { ok: true, config: merged };
  });

  // ── MySQL query passthrough for the AI's `db:query` action ────────────────
  // Runs raw SQL against the workspace owner's per-project database. Owner is
  // resolved from the workspace row, db name defaults to whatever `.premdev`
  // env / workspace.env points at (DATABASE_NAME), and connection uses the
  // owner's MySQL user — never root — so existing GRANTs are the access edge.
  // Note: `database` is intentionally NOT accepted from the client. The
  // database name is always resolved server-side from the workspace row,
  // so a caller in workspace A cannot target workspace B's database (even
  // when both belong to the same MySQL user) by passing a different name.
  const DbQueryBody = z.object({
    sql: z.string().min(1).max(20_000),
    rowLimit: z.number().int().positive().max(1000).optional(),
  });
  app.post<{ Params: { id: string } }>("/:id/db/query", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const { id } = req.params;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = DbQueryBody.parse(req.body);
    const userRow = db.prepare("SELECT username FROM users WHERE id = ?").get(w.user_id) as { username?: string } | undefined;
    const username = userRow?.username;
    if (!username) return reply.code(400).send({ error: "Workspace owner has no username" });
    // SECURITY: db name derives ONLY from immutable workspace identity
    // (owner username + workspace.name, sanitized like createProjectDb).
    // Env vars are user-editable, so they cannot be the auth boundary.
    const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
    const safeProj = w.name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (!safeUser || !safeProj) {
      return reply.code(400).send({ error: "Workspace identity has no usable username/name." });
    }
    const dbName = `${safeUser}_${safeProj}`;
    const r = await runWorkspaceQuery({
      username,
      dbName,
      sql: body.sql,
      rowLimit: body.rowLimit,
    });
    if (!r.ok) return reply.code(400).send({ error: r.error, database: dbName });
    return { ...r, database: dbName };
  });

  const ExecBody = z.object({ command: z.string().min(1).max(4000) });
  app.post("/:id/exec", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = ExecBody.parse(req.body);
    try {
      const r = await runOneOff(id, body.command, 120_000);
      return { output: r.output, exitCode: r.exitCode };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Test runner (Batch B #11) ─────────────────────────────────────────────
  // Auto-detects the right test command from project metadata when the caller
  // doesn't pass one. Output is capped to keep the AI loop fast even when a
  // suite spews thousands of lines.
  const TestBody = z.object({ command: z.string().max(500).optional() });
  app.post("/:id/test", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = TestBody.parse(req.body ?? {});
    let cmd = body.command?.trim();
    let tool = "custom";
    if (!cmd) {
      // Auto-detect: read root listing once, then pick a strategy.
      let detect = "";
      try {
        const ls = await runOneOff(id, "ls -1a 2>/dev/null | head -200; echo '---'; cat package.json 2>/dev/null | head -120", 10_000);
        detect = ls.output || "";
      } catch {}
      if (/"scripts"\s*:\s*\{[^}]*"test"\s*:/.test(detect)) {
        cmd = "npm test --silent --if-present";
        tool = "npm";
      } else if (/(^|\n)pytest\.ini|(^|\n)pyproject\.toml|(^|\n)tests\//.test(detect)) {
        cmd = "pytest -q 2>&1 | tail -200";
        tool = "pytest";
      } else if (/(^|\n)go\.mod/.test(detect)) {
        cmd = "go test ./... 2>&1 | tail -200";
        tool = "go";
      } else if (/(^|\n)Cargo\.toml/.test(detect)) {
        cmd = "cargo test 2>&1 | tail -200";
        tool = "cargo";
      } else {
        return { tool: "none", exitCode: 0, ok: true, output: "No tests detected (no npm test script, pytest, go, or cargo project)." };
      }
    }
    try {
      const r = await runOneOff(id, cmd, 180_000);
      const out = r.output.length > 12_000 ? r.output.slice(-12_000) : r.output;
      return { tool, exitCode: r.exitCode, ok: r.exitCode === 0, output: out };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ── Git integration (Batch B #24) ─────────────────────────────────────────
  // All commands run inside the workspace container so they use the user's
  // own git config and credentials. We expose a small surface (status / log /
  // branches / commit / push / pull) instead of arbitrary git proxying so the
  // UI stays predictable.
  app.get("/:id/git/status", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id,
        "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }; " +
        "echo '##BRANCH##'; git rev-parse --abbrev-ref HEAD 2>/dev/null; " +
        "echo '##REMOTE##'; git remote -v 2>/dev/null | head -4; " +
        "echo '##STATUS##'; git status --porcelain=v1 2>/dev/null | head -200; " +
        "echo '##AHEAD##'; git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || echo '0\\t0'",
        15_000);
      const out = r.output;
      if (out.includes("NOREPO")) return { initialised: false };
      const seg = (tag: string) => {
        const i = out.indexOf(`##${tag}##`);
        if (i === -1) return "";
        const next = out.indexOf("##", i + tag.length + 4);
        return out.slice(i + tag.length + 4, next === -1 ? undefined : next).trim();
      };
      const status = seg("STATUS");
      const files = status ? status.split("\n").map((l) => ({
        x: l.charAt(0), y: l.charAt(1), path: l.slice(3).trim(),
      })) : [];
      const ah = seg("AHEAD").split(/\s+/);
      return {
        initialised: true,
        branch: seg("BRANCH"),
        remote: seg("REMOTE"),
        files,
        behind: Number(ah[0] ?? 0) || 0,
        ahead: Number(ah[1] ?? 0) || 0,
      };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/git/log", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id,
        "git log -n 30 --pretty=format:'%h%x09%an%x09%ar%x09%s' 2>/dev/null || true",
        15_000);
      const commits = r.output.split("\n").filter(Boolean).map((l) => {
        const [hash, author, when, ...rest] = l.split("\t");
        return { hash, author, when, subject: rest.join("\t") };
      });
      return { commits };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  const GitCommitBody = z.object({
    message: z.string().min(1).max(500),
    addAll: z.boolean().default(true),
  });
  app.post("/:id/git/commit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = GitCommitBody.parse(req.body ?? {});
    const safeMsg = body.message.replace(/'/g, "'\\''");
    const cmd =
      "git config --global --add safe.directory \"$(pwd)\" >/dev/null 2>&1; " +
      "git config user.email >/dev/null 2>&1 || git config user.email 'premdev@local'; " +
      "git config user.name  >/dev/null 2>&1 || git config user.name  'PremDev User'; " +
      (body.addAll ? "git add -A && " : "") +
      `git commit -m '${safeMsg}' 2>&1`;
    try {
      const r = await runOneOff(id, cmd, 30_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // Strict allowlist for git remote / branch names — refuses anything that
  // could break out of `git push <remote> <branch>` into shell metachars.
  // Matches the safe subset of git ref-name rules: alnum, ., _, /, -, no
  // leading/trailing `-` or `.`, no consecutive dots.
  const GIT_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/;
  const GitPushBody = z.object({
    remote: z.string().default("origin").refine((v) => GIT_REF_RE.test(v) && !v.includes(".."), {
      message: "remote must match [A-Za-z0-9_./-]+ and contain no '..'",
    }),
    branch: z.string().optional().refine((v) => v == null || (GIT_REF_RE.test(v) && !v.includes("..")), {
      message: "branch must match [A-Za-z0-9_./-]+ and contain no '..'",
    }),
  });
  app.post("/:id/git/push", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    let body: z.infer<typeof GitPushBody>;
    try {
      body = GitPushBody.parse(req.body ?? {});
    } catch (e: any) {
      return reply.code(400).send({ error: e?.errors?.[0]?.message ?? "invalid git args" });
    }
    const branch = body.branch ? ` ${body.branch}` : "";
    try {
      const r = await runOneOff(id, `git push ${body.remote}${branch} 2>&1`, 60_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.post("/:id/git/pull", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id, "git pull --ff-only 2>&1", 60_000);
      return { ok: r.exitCode === 0, exitCode: r.exitCode, output: r.output.slice(-4000) };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/git/diff", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const r = await runOneOff(id, "git diff --no-color 2>&1 | head -2000", 20_000);
      return { diff: r.output };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.get("/:id/checkpoints", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    return { checkpoints: listCheckpoints(id) };
  });

  const CkBody = z.object({ message: z.string().max(200).default("") });
  app.post("/:id/checkpoints", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const body = CkBody.parse(req.body ?? {});
    try {
      const ck = await createCheckpoint(id, body.message);
      return { checkpoint: ck };
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // List files inside a checkpoint snapshot — powers the "Changes" button.
  app.get("/:id/checkpoints/:cid/files", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      const files = await listCheckpointFiles(id, cid);
      return { files };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.post("/:id/checkpoints/:cid/restore", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    try {
      await restoreCheckpoint(id, cid);
      return { ok: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  app.delete("/:id/checkpoints/:cid", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const cid = (req.params as any).cid;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    deleteCheckpoint(id, cid);
    return { ok: true };
  });

  app.delete("/:id", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });

    if (isDocker()) {
      await stopContainer(id);
      await stopShellContainer(id);
    } else {
      stopLocal(id);
    }
    deleteAllCheckpointsFor(id);

    // Close any open semantic-search SQLite handle before removing the
    // workspace dir, so the file lock is released and the embeddings.db
    // gets cleaned up with the rest of the tree (avoids an FD leak when
    // workspaces are deleted while the API process is long-running).
    try { closeWorkspaceDb(id); } catch {}

    try {
      fs.rmSync(workspacePath(id), { recursive: true, force: true });
    } catch {}
    // Also drop the per-workspace pip/npm user-home cache so the next
    // workspace with the same id starts clean and disk space is reclaimed.
    try {
      const userhome = path.join(path.dirname(config.WORKSPACES_DIR), "userhome", id);
      fs.rmSync(userhome, { recursive: true, force: true });
    } catch {}
    await dropProjectDb(u.username, w.name).catch(() => {});
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return { ok: true };
  });

  app.get("/:id/logs", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Not found" });
    const logs = await getContainerLogs(id, 500);
    return { logs };
  });
};

// Decide which command to spawn for a workspace. Priority:
//   1. `.premdev` "run" field (the canonical, AI-and-user-editable config)
//   2. legacy `run_command` DB override (kept for backward compat)
//   3. template's runCommand if it isn't the placeholder
//   4. auto-detected command from the workspace contents
//   5. fall back to the placeholder so the container at least boots
function resolveRunCommand(
  w: DbWorkspace,
  tmpl: { runCommand: string },
  workspaceDir: string,
): string {
  const PLACEHOLDER = "echo 'No run command set'";
  const cfg = readWorkspaceConfig(workspaceDir);
  if (cfg?.run && cfg.run.trim() && cfg.run !== PLACEHOLDER) return cfg.run.trim();
  const userOverride =
    w.run_command && w.run_command.trim() && w.run_command !== PLACEHOLDER
      ? w.run_command
      : null;
  if (userOverride) return userOverride;
  if (tmpl.runCommand && tmpl.runCommand !== PLACEHOLDER) return tmpl.runCommand;
  const detected = detectRunCommand(workspaceDir);
  return detected ?? tmpl.runCommand;
}

// Merge env vars: auto MySQL creds + workspace DB env_vars + .premdev
// `env` (later sources win on conflict, so .premdev is the source of
// truth, then user-set DB env, then auto MySQL injection as a base layer).
function resolveEnvVars(w: DbWorkspace, workspaceDir: string): Record<string, string> {
  let dbEnv: Record<string, string> = {};
  try { dbEnv = JSON.parse(w.env_vars); } catch {}
  const cfg = readWorkspaceConfig(workspaceDir);

  // Auto-inject MySQL connection details so user code can connect via TCP to
  // the `mysql` service on premdev_net (default Unix-socket lookup will fail
  // because the workspace container has no mysqld socket).
  const auto: Record<string, string> = {};
  const userRow = db.prepare("SELECT username FROM users WHERE id = ?").get(w.user_id) as { username?: string } | undefined;
  const username = userRow?.username
    ? userRow.username.replace(/[^a-zA-Z0-9_]/g, "")
    : "";
  if (config.MYSQL_HOST) {
    auto.DATABASE_HOST = config.MYSQL_HOST;
    auto.DATABASE_PORT = String(config.MYSQL_PORT);
    auto.DB_HOST = config.MYSQL_HOST;
    auto.DB_PORT = String(config.MYSQL_PORT);
    auto.MYSQL_HOST = config.MYSQL_HOST;
    auto.MYSQL_PORT = String(config.MYSQL_PORT);
  }
  if (username && config.MYSQL_USER_PASSWORD) {
    auto.DATABASE_USER = username;
    auto.DATABASE_PASSWORD = config.MYSQL_USER_PASSWORD;
    auto.DB_USER = username;
    auto.DB_PASSWORD = config.MYSQL_USER_PASSWORD;
    auto.MYSQL_USER = username;
    auto.MYSQL_PASSWORD = config.MYSQL_USER_PASSWORD;
  }

  return { ...auto, ...dbEnv, ...(cfg?.env ?? {}) };
}
