import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import archiver from "archiver";
import { db, DbWorkspace } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { workspacePath } from "../lib/runtime.js";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea",
]);

function safePath(workspaceDir: string, rel: string): string {
  const root = path.resolve(workspaceDir);
  const abs = path.resolve(root, rel.replace(/^\/+/, ""));
  const relCheck = path.relative(root, abs);
  if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error("Path traversal");
  }
  return abs;
}

/**
 * Like `safePath()` but additionally rejects any path that crosses a symlink
 * inside the workspace, so a malicious user can't `rename foo bar` where
 * `foo -> /etc/passwd` and then write through it. Walks each path component
 * with `lstat` so it works whether or not the target itself exists yet.
 *
 * Use this for ANY mutating operation (write, patch, delete, rename, mkdir);
 * read-only file fetches keep using `safePath()` so workspaces containing
 * intentional symlinks (e.g. cached node_modules) still load.
 */
function safeWritePath(workspaceDir: string, rel: string): string {
  const root = path.resolve(workspaceDir);
  const abs = safePath(root, rel);
  const parts = path.relative(root, abs).split(path.sep).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e: any) {
      // Components past the first missing one will also be missing — and
      // since they don't exist yet they can't be symlinks. Bail out.
      if (e?.code === "ENOENT") break;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Symlinks are not allowed inside workspace paths: ${path.relative(root, cur)}`);
    }
  }
  return abs;
}

function buildTree(dir: string, base = "", showHidden = false): any[] {
  if (!fs.existsSync(dir)) return [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  return items
    .filter((e) => {
      if (SKIP_DIRS.has(e.name)) return false;
      // .git is always skipped via SKIP_DIRS above, even when showHidden=true.
      if (!showHidden && e.name.startsWith(".")) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => {
      const rel = base ? `${base}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        return { name: e.name, path: rel, type: "dir", children: buildTree(full, rel, showHidden) };
      }
      return { name: e.name, path: rel, type: "file" };
    });
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  async function getWorkspace(req: any, reply: any) {
    const u = await requireUser(req, reply);
    if (!u) return null;
    const id = req.params.id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, u.id) as DbWorkspace | undefined;
    if (!w) {
      reply.code(404).send({ error: "Not found" });
      return null;
    }
    return w;
  }

  app.get("/:id/tree", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const dir = workspacePath(w.id);
    fs.mkdirSync(dir, { recursive: true });
    const q = req.query as any;
    const showHidden = q?.showHidden === "1" || q?.showHidden === "true";
    return { tree: buildTree(dir, "", showHidden) };
  });

  app.get("/:id/files", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const q = req.query as any;
    if (!q.path) return reply.code(400).send({ error: "path required" });
    const abs = safePath(workspacePath(w.id), q.path);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return reply.code(404).send({ error: "File not found" });
    }
    const stats = fs.statSync(abs);
    if (stats.size > 5 * 1024 * 1024) return reply.code(413).send({ error: "File too large" });
    const buf = fs.readFileSync(abs);
    // Try utf-8
    return { content: buf.toString("utf8"), size: stats.size };
  });

  const Update = z.object({ path: z.string().min(1), content: z.string() });
  app.put("/:id/files", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = Update.parse(req.body);
    let abs: string;
    try { abs = safeWritePath(workspacePath(w.id), body.path); }
    catch (e: any) { return reply.code(400).send({ error: e?.message ?? "Invalid path" }); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.content);
    return { ok: true };
  });

  const Create = z.object({ path: z.string().min(1), type: z.enum(["file", "dir"]) });
  app.post("/:id/files/create", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = Create.parse(req.body);
    let abs: string;
    try { abs = safeWritePath(workspacePath(w.id), body.path); }
    catch (e: any) { return reply.code(400).send({ error: e?.message ?? "Invalid path" }); }
    if (body.type === "dir") {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!fs.existsSync(abs)) fs.writeFileSync(abs, "");
    }
    return { ok: true };
  });

  // Accept either { path } (legacy single) or { paths: [...] } (bulk).
  // Returning per-path success lets the FE show a partial-failure toast
  // when one of many paths is invalid, without aborting the whole batch.
  const Del = z.union([
    z.object({ path: z.string().min(1) }),
    z.object({ paths: z.array(z.string().min(1)).min(1).max(500) }),
  ]);
  app.post("/:id/files/delete", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = Del.parse(req.body);
    const root = workspacePath(w.id);
    const targets = "paths" in body ? body.paths : [body.path];
    const results: Array<{ path: string; ok: boolean; error?: string }> = [];
    for (const p of targets) {
      try {
        // safeWritePath rejects paths that would delete through a symlink
        // (e.g. workspace/link -> /etc), preventing host-FS escape.
        const abs = safeWritePath(root, p);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        results.push({ path: p, ok: true });
      } catch (e: any) {
        results.push({ path: p, ok: false, error: e?.message ?? "delete failed" });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  });

  const Rename = z.object({ from: z.string().min(1), to: z.string().min(1) });
  app.post("/:id/files/rename", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = Rename.parse(req.body);
    const root = workspacePath(w.id);
    let fromAbs: string, toAbs: string;
    try {
      fromAbs = safeWritePath(root, body.from);
      toAbs = safeWritePath(root, body.to);
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? "Invalid path" });
    }
    if (!fs.existsSync(fromAbs)) return reply.code(404).send({ error: "Source not found" });
    if (fs.existsSync(toAbs)) return reply.code(409).send({ error: "Target already exists" });
    fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    fs.renameSync(fromAbs, toAbs);
    return { ok: true };
  });

  // ---------------------------------------------------------------------
  // Codebase search (grep)
  // ---------------------------------------------------------------------
  // Walks the workspace tree (skipping node_modules/.git/etc) and returns
  // up to MAX_HITS lines that match `pattern`. Used by the AI's `search:`
  // action so it can find code without the user pasting files.
  // Pattern is interpreted as a literal substring by default; pass
  // `regex: true` to treat it as a JS RegExp (case-sensitive). The path
  // glob is a simple suffix match like ".ts" or "src/" — no full glob
  // engine to keep the surface area tiny and predictable.
  // ---------------------------------------------------------------------
  const SearchBody = z.object({
    pattern: z.string().min(1).max(500),
    regex: z.boolean().optional().default(false),
    pathGlob: z.string().max(200).optional(),
    maxHits: z.number().int().positive().max(500).optional().default(100),
  });
  app.post("/:id/files/search", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = SearchBody.parse(req.body);
    const root = workspacePath(w.id);
    let matcher: (line: string) => boolean;
    try {
      if (body.regex) {
        // V8's regex engine is backtracking-based and has no built-in time
        // limit, so a single `(a+)+$` style pattern on a long line can pin
        // the CPU for tens of seconds before any deadline check runs. Until
        // we bring in RE2 (linear-time engine) or run matches in a worker
        // we kill the obvious foot-guns up-front:
        //   1. Reject patterns with nested unbounded quantifiers, the
        //      classic catastrophic-backtracking shape: `(...+)+`, `(...*)*`.
        //   2. Hard-cap regex pattern length to 200 chars (lower than the
        //      literal-mode 500 — the smaller the regex, the smaller the
        //      blow-up exponent).
        // Combined with the 256-char per-line cap further down, the worst
        // case becomes bounded enough that the wall-clock deadline can
        // actually catch it.
        if (body.pattern.length > 200) {
          return reply.code(400).send({ error: "Regex pattern too long (max 200 chars in regex mode)." });
        }
        // Catastrophic-backtracking prefilter. Rejects any quantified group
        // whose body contains an ambiguity-inducing token (`+ * ? |`) and
        // is itself followed by an unbounded outer quantifier (`+ * ? {m,}`).
        // Covers the four classic ReDoS shapes:
        //   (a+)+      – nested quantifier
        //   (a|aa)+    – alternation under repeat
        //   (a|a?)+    – optionality under repeat
        //   (a|aa){1,} – {m,} unbounded outer quantifier
        // False positives (e.g. legitimate `(foo|bar)+`) are an accepted
        // trade — users can switch to literal mode or unroll the alternation.
        const CATASTROPHIC = /\([^)]*[+*?|][^)]*\)\s*(?:[+*?]|\{\d+,\})/;
        if (CATASTROPHIC.test(body.pattern)) {
          return reply.code(400).send({
            error: "Regex shape can cause catastrophic backtracking. Avoid unbounded-quantified groups containing `+ * ? |`, e.g. `(a+)+`, `(a|aa)+`, `(x?){2,}`. Use literal search instead, or simplify the pattern.",
          });
        }
        const re = new RegExp(body.pattern);
        matcher = (l) => re.test(l);
      } else {
        const needle = body.pattern;
        matcher = (l) => l.includes(needle);
      }
    } catch (e: any) {
      return reply.code(400).send({ error: `Invalid regex: ${e.message}` });
    }
    const hits: Array<{ path: string; line: number; text: string }> = [];
    let filesScanned = 0;
    const MAX_FILES = 2000;
    const MAX_FILE_BYTES = 1024 * 1024; // 1 MB per file
    // Tighter wall-clock budget for regex mode (where ReDoS is possible) than
    // for literal mode (which is O(n) and harmless).
    const SEARCH_DEADLINE = Date.now() + (body.regex ? 750 : 1500);
    let timedOut = false;
    function walk(dir: string, rel: string) {
      if (hits.length >= body.maxHits || filesScanned >= MAX_FILES) return;
      if (Date.now() > SEARCH_DEADLINE) { timedOut = true; return; }
      let items: fs.Dirent[];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of items) {
        if (hits.length >= body.maxHits) return;
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (e.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(childAbs, childRel);
          continue;
        }
        if (!e.isFile()) continue;
        if (body.pathGlob && !childRel.includes(body.pathGlob)) continue;
        try {
          const stats = fs.statSync(childAbs);
          if (stats.size > MAX_FILE_BYTES) continue;
          // Skip obvious binaries by sniffing first 1KB for null byte.
          const fd = fs.openSync(childAbs, "r");
          const sniffBuf = Buffer.alloc(Math.min(1024, stats.size));
          fs.readSync(fd, sniffBuf, 0, sniffBuf.length, 0);
          fs.closeSync(fd);
          if (sniffBuf.includes(0)) continue;
          filesScanned++;
          const text = fs.readFileSync(childAbs, "utf8");
          const lines = text.split("\n");
          // Cap individual line length before matching: a 50KB minified line
          // + a catastrophic-backtracking pattern can spin for seconds even
          // though we hit the deadline check above only between files. The
          // cap is much tighter for regex mode (where blow-up is exponential
          // in input size) than for literal substring search (O(n) and safe).
          const MAX_LINE_LEN = body.regex ? 256 : 4096;
          for (let i = 0; i < lines.length; i++) {
            // Inner deadline check every 64 lines so a single huge file can't
            // outlive the overall search budget.
            if ((i & 63) === 0 && Date.now() > SEARCH_DEADLINE) {
              timedOut = true;
              return;
            }
            const ln = lines[i].length > MAX_LINE_LEN ? lines[i].slice(0, MAX_LINE_LEN) : lines[i];
            if (matcher(ln)) {
              hits.push({ path: childRel, line: i + 1, text: ln.slice(0, 300) });
              if (hits.length >= body.maxHits) return;
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
    walk(root, "");
    return {
      ok: true,
      hits,
      filesScanned,
      truncated: hits.length >= body.maxHits,
      timedOut,
    };
  });

  // ---------------------------------------------------------------------
  // Targeted patch (search-and-replace within an existing file)
  // ---------------------------------------------------------------------
  // Used by the AI's `patch:` action. Lets the model emit just the changed
  // hunk instead of re-uploading a whole 500-line file every time, which
  // saves tokens and avoids the "AI overwrote my unrelated lines" class of
  // bug. The match must be unique unless replaceAll=true.
  // ---------------------------------------------------------------------
  const PatchBody = z.object({
    path: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
    replaceAll: z.boolean().optional().default(false),
  });
  app.post("/:id/files/patch", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = PatchBody.parse(req.body);
    let abs: string;
    try { abs = safeWritePath(workspacePath(w.id), body.path); }
    catch (e: any) { return reply.code(400).send({ error: e?.message ?? "Invalid path" }); }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return reply.code(404).send({ error: "File not found" });
    }
    const original = fs.readFileSync(abs, "utf8");
    const occurrences = original.split(body.find).length - 1;
    if (occurrences === 0) {
      return reply.code(422).send({
        error: "Find string not found",
        hint: "The 'find' text must match the file contents EXACTLY (whitespace included). Read the file again with bash:run cat to see its current contents.",
      });
    }
    if (occurrences > 1 && !body.replaceAll) {
      return reply.code(422).send({
        error: `Find string is ambiguous — matches ${occurrences} places`,
        hint: "Add more surrounding context so the match is unique, or set replaceAll=true to replace every occurrence.",
        occurrences,
      });
    }
    const updated = body.replaceAll
      ? original.split(body.find).join(body.replace)
      : original.replace(body.find, body.replace);
    fs.writeFileSync(abs, updated);
    return {
      ok: true,
      occurrences,
      bytesBefore: Buffer.byteLength(original, "utf8"),
      bytesAfter: Buffer.byteLength(updated, "utf8"),
    };
  });

  // ---------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------
  // Cheap static analysis the AI can poll instead of running a full build.
  // Tries common linters in priority order and returns the first one that
  // produces output. Each spawn is capped at 15s and 256KB so a runaway
  // tsc on a huge repo can't block the API. The host runs the shell
  // commands directly (no docker exec) — they only need read access to
  // workspace files which is already available.
  // ---------------------------------------------------------------------
  const DiagBody = z.object({
    tool: z.enum(["auto", "tsc", "eslint", "ruff", "pyflakes"]).optional().default("auto"),
  });
  app.post("/:id/files/diagnostics", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = DiagBody.parse(req.body ?? {});
    const root = workspacePath(w.id);
    // Async exec so a 15-second tsc run on a large repo doesn't block the
    // Node event loop (and therefore every other API request) the way
    // spawnSync would. The execFile promise still honours the timeout and
    // maxBuffer caps below.
    async function tryRun(tool: string, cmd: string, args: string[]): Promise<{ tool: string; output: string; exitCode: number; ran: boolean }> {
      try {
        const r = await execFileAsync(cmd, args, {
          cwd: root,
          timeout: 15_000,
          maxBuffer: 256 * 1024,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        });
        return { tool, output: ((r.stdout ?? "") + (r.stderr ?? "")).slice(0, 64 * 1024), exitCode: 0, ran: true };
      } catch (e: any) {
        // execFile throws on non-zero exit OR timeout. Differentiate so the
        // AI sees the actual linter complaints instead of a generic failure.
        if (e?.code === "ENOENT") return { tool, output: "", exitCode: -1, ran: false };
        const out = ((e?.stdout ?? "") + (e?.stderr ?? "")).slice(0, 64 * 1024);
        return {
          tool,
          output: out || (e?.message ?? "(no output)"),
          exitCode: typeof e?.code === "number" ? e.code : -1,
          ran: true,
        };
      }
    }
    const tools: Array<{ name: "tsc"|"eslint"|"ruff"|"pyflakes"; trigger: () => boolean; cmd: string; args: string[] }> = [
      { name: "tsc",      trigger: () => fs.existsSync(path.join(root, "tsconfig.json")), cmd: "npx", args: ["--no-install", "tsc", "--noEmit", "--pretty", "false"] },
      { name: "eslint",   trigger: () => fs.existsSync(path.join(root, ".eslintrc.json")) || fs.existsSync(path.join(root, ".eslintrc.js")) || fs.existsSync(path.join(root, "eslint.config.js")), cmd: "npx", args: ["--no-install", "eslint", "--no-color", "."] },
      { name: "ruff",     trigger: () => fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "ruff.toml")), cmd: "ruff", args: ["check", "."] },
      { name: "pyflakes", trigger: () => { try { return fs.readdirSync(root).some((f) => f.endsWith(".py")); } catch { return false; } }, cmd: "pyflakes", args: ["."] },
    ];
    if (body.tool !== "auto") {
      const t = tools.find((x) => x.name === body.tool);
      if (!t) return { ok: false, error: `Tool not found: ${body.tool}` };
      const r = await tryRun(t.name, t.cmd, t.args);
      return { ok: r.exitCode === 0, ...r };
    }
    for (const t of tools) {
      if (!t.trigger()) continue;
      const r = await tryRun(t.name, t.cmd, t.args);
      if (r.ran) return { ok: r.exitCode === 0, ...r };
    }
    return { ok: true, tool: "none", output: "(no linter applicable to this project — install tsc/eslint/ruff/pyflakes to enable diagnostics)", exitCode: 0, ran: false };
  });

  app.get("/:id/download-zip", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const root = workspacePath(w.id);
    const safeName = w.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "workspace";
    reply.raw.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName}.zip"`,
      "Cache-Control": "no-store",
    });
    const archive = archiver("zip", { zlib: { level: 6 } });
    let aborted = false;
    const onClientClose = () => {
      aborted = true;
      try { archive.abort(); } catch {}
    };
    req.raw.on("close", onClientClose);
    req.raw.on("aborted", onClientClose);
    archive.on("error", (err) => {
      try { reply.raw.end(); } catch {}
      req.log.error({ err }, "zip stream error");
    });
    archive.pipe(reply.raw);
    archive.glob("**/*", {
      cwd: root,
      dot: false,
      ignore: [
        "node_modules/**", ".git/**", ".cache/**", ".venv/**", "venv/**",
        "__pycache__/**", "dist/**", "build/**", ".next/**", "target/**",
      ],
    });
    try {
      await archive.finalize();
    } catch (err) {
      if (!aborted) req.log.error({ err }, "zip finalize error");
    } finally {
      req.raw.off("close", onClientClose);
      req.raw.off("aborted", onClientClose);
    }
  });
};
