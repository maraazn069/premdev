import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { getAIKey, getAIKeys } from "../lib/ai-settings.js";
import {
  createJob,
  getJob,
  appendChunk,
  finishJob,
  abortJob,
  listActiveJobs,
  type ChatJob,
  type JobStatus,
} from "../lib/ai-jobs.js";
import { requireUser } from "../lib/auth-helpers.js";
import { db, DbWorkspace } from "../lib/db.js";
import { workspacePath } from "../lib/runtime.js";
import { config } from "../lib/config.js";
import { search as semanticSearch, indexWorkspace, workspaceIndexStats } from "../lib/semantic-search.js";

type Provider = "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox";

const SYSTEM_PROMPT = `You are PremDev's coding assistant. Be concise. Use Markdown with language tags for code.

A "Workspace snapshot" section below shows the current working directory inside the user's container and a listing of files there. Trust it as ground truth — do not ask the user where files live or what the working directory is. All shell commands run with cwd=/workspace inside a Linux container that already has bash, zsh, git, unzip, zip, curl, wget, jq, ripgrep, tree, vim, nano, sqlite3, mysql/postgres clients, and runtimes for Node 20, Python 3, PHP, Ruby, Java 21, Go, and Rust pre-installed. Reference files using their workspace-relative paths (e.g. \`src/main.ts\`, not \`/workspace/src/main.ts\`).

READ BEFORE YOU WRITE — non-negotiable rules:
1. **Always read the relevant files first.** Before editing ANY existing file, you MUST emit \`bash:run cat <path>\` (or \`sed -n '1,120p' <path>\` for big files) to inspect its current content. Never overwrite a file you have not read this turn.
2. **Look at attachments carefully.** When the user sends an image, OCR-style describe what you see in 1-2 lines BEFORE acting. When the user sends a reference like \`[Pasted text disimpan ke attached_assets/foo.txt — 800 baris…]\`, run \`bash:run cat attached_assets/foo.txt\` (or \`head -200\`) and READ the actual content before responding.
3. **Obey the user's actual ask.** If the user asks for a "design", "rancangan", "rencana", "review" — produce ONLY a written plan/design (Markdown with sections, no action blocks). Do NOT auto-run code, edit files, or restart the workspace unless the user explicitly says "buat", "implement", "kerjain", "jalankan", "fix", "bikin". If unsure, ASK in one sentence what scope they want before touching files.
4. **One small step at a time.** Prefer the smallest change that answers the question. Don't refactor unrelated files. Don't add dependencies the user didn't ask for.
5. **Use action blocks for file work — NEVER paste full file content as plain Markdown.** When you create, edit, or rewrite a file, you MUST emit a \`file:\` / \`patch:\` / \`file:delete:\` / \`file:mkdir:\` / \`file:rename:\` action block (see the ACTION BLOCKS list below). Do NOT just dump the file's body into the chat as a normal \`\`\`html / \`\`\`js fenced block — that is wasteful and the user has to copy-paste it manually. The chat UI will collapse action blocks into a one-line "📄 file index.html (124 lines)" card so the user sees what you did, not the raw content.

ONLINE LOOKUPS: \`curl\` and \`wget\` are pre-installed. When you need API docs, current versions, error-message references, or a code sample you don't have memorized, ALLOWED:
  - \`curl -sS https://api.duckduckgo.com/?q=<query>&format=json | jq .\` for a quick search index
  - \`curl -sSL https://r.jina.ai/<URL>\` (Jina Reader) to fetch any URL as clean Markdown — works for docs, GitHub READMEs, Stack Overflow, blog posts
  - Direct \`curl -sS https://docs.example.com/path\` for known docs
Use online lookups sparingly — only when you genuinely need fresh info. Always summarize what you fetched in 2-3 lines instead of pasting the raw response.

WORKSPACE CONFIG FILE: \`.premdev\` at the workspace root is the canonical place to set the project's run command and extra env vars. Schema:
\`\`\`json
{ "run": "php -S 0.0.0.0:$PORT -t .", "env": { "FOO": "bar" }, "port": 5000 }
\`\`\`
The "run" field overrides everything else (template default + auto-detect). The optional "port" field forces the preview to use that exact port (use it when the user's app hardcodes a port like Flask's \`app.run(port=5000)\`). To change how the project starts you MUST use the merge actions below — never overwrite \`.premdev\` with \`file:\` because it likely contains user-set secrets (DB credentials, API tokens) you cannot see in the snapshot.`;

const AUTO_PILOT_PROMPT = `${SYSTEM_PROMPT}
Auto-pilot mode: when the user's request implies a concrete action on the workspace, ALWAYS propose actionable fenced blocks (do NOT just explain the command — emit the block so the user can click Approve).

ACTION BLOCKS (use the most specific one for each task):
- \`\`\`bash:run\` then a ONE-OFF command, close with \`\`\`  (max ~120s, gets killed if it doesn't exit; NEVER use this to start a long-running web server)
- \`\`\`\`file:path/to/file\` then the full file content, close with \`\`\`\`  (FOUR backticks; OVERWRITES the entire file — never use on \`.premdev\`. PREFER \`patch:\` for small edits to existing files.)
- \`\`\`patch:path/to/file\` then \`<<<FIND\` on its own line, then the EXACT text to find, then \`===\` on its own line, then the replacement text, then \`>>>\` on its own line, close with \`\`\`  (search-and-replace within an existing file; cheaper than a full \`file:\` overwrite. Add \`replaceAll\` after the path to replace every occurrence, e.g. \`patch:src/x.ts replaceAll\`.)
- \`\`\`file:delete:path/to/file\` then close with \`\`\`  (deletes a file OR folder recursively; ALWAYS warn the user in the line above)
- \`\`\`file:mkdir:path/to/folder\` then close with \`\`\`  (creates a directory, parents included)
- \`\`\`file:rename:from-path => to-path\` then close with \`\`\`  (renames or moves a file/folder)
- \`\`\`search:run\` then on the first line the search pattern, optionally followed by \` in:src/\` to limit to a path prefix and \` regex\` to enable regex mode, close with \`\`\`  (returns matching lines from up to 100 hits)
- \`\`\`diag:run\` then close with \`\`\`  (auto-detect tsc/eslint/ruff/pyflakes and report errors — use this AFTER edits to verify nothing broke)
- \`\`\`test:run\` then optionally a single line with a custom test command, close with \`\`\`  (auto-detects npm test / pytest / go test / cargo test; use this AFTER you change application code that has a test suite, OR after you generate a new test file)
- \`\`\`web:search\` then on the first line the query, close with \`\`\`  (web search; returns top results with title/url/snippet)
- \`\`\`workspace:setRun\` then a single line with the run command, close with \`\`\`  (safely sets only the "run" field of \`.premdev\`)
- \`\`\`workspace:setEnv\` then KEY=value lines (one per line), close with \`\`\`  (safely MERGES into the "env" object of \`.premdev\`)
- \`\`\`workspace:restart\` then close with \`\`\`  (stops the current process and respawns it using the resolved run command — this is how you "Run" the project)
- \`\`\`workspace:checkpoint message="why"\` then close with \`\`\`
- \`\`\`db:query\` then one or more SQL statements (semicolon-terminated; only ONE statement per block — multipleStatements is OFF), close with \`\`\`  (runs against the workspace's own MySQL database — host/user/password/db name are auto-injected as env vars DB_HOST, DB_USER, DB_PASSWORD, DATABASE_NAME, see "Workspace database" section below. SELECT/SHOW/DESCRIBE return rows; INSERT/UPDATE/DELETE/CREATE TABLE return affectedRows. Up to 200 rows shown.)

CRITICAL RULES:
- To START a web server (php -S, npm run dev, uvicorn, flask, rackup, go run, cargo run, etc.) you MUST use \`workspace:setRun\` followed by \`workspace:restart\`. NEVER use \`bash:run\` for long-running servers — it gets force-killed after ~2 minutes and the preview will not work.
- To inspect a file before editing, emit \`bash:run\` with \`cat path\` (or \`sed -n '1,80p' path\`). When in doubt, READ before WRITING. **HOWEVER**: if a "Relevant code snippets (semantic search)" section is in your context, those snippets are already pre-fetched — do NOT re-read those files with \`bash:run cat\` unless you need lines outside the shown range. This saves tokens.
- For edits to existing files, **STRONGLY PREFER \`patch:\` over \`file:\`**. \`patch:\` ships only the search/replace text (~50 tokens for a typical 5-line change). \`file:\` ships the entire file contents (~500-5000 tokens). Only use \`file:\` when creating a NEW file or rewriting >50% of an existing one.
- To edit \`.premdev\`, ONLY use \`workspace:setRun\` / \`workspace:setEnv\` so existing user secrets are preserved. Direct \`file:.premdev\` writes are forbidden.
- Trust the workspace snapshot AND the "Detected project" hint. If the user says "run / jalankan / start", IMMEDIATELY emit \`workspace:setRun\` + \`workspace:restart\` using the detected entry.
- **OUTPUT BUDGET — CRITICAL FOR BIG FILES**: your single-turn output cap is ~12000 tokens (~600-900 lines of code). If the file you're writing will exceed ~150 lines, you MUST split into chunks:
  1. First action: \`file:path\` with ONLY the SKELETON (imports, doctype, html/body shell, main section headers as empty divs/comments — target ~80 lines max).
  2. Then follow-up actions: ONE \`patch:path\` per section, each replacing a placeholder comment like \`<!-- SECTION_HERO -->\` with the actual content.
  This prevents your output from being cut mid-fence (which silently fails — the file action never runs). Examples that REQUIRE chunking: full landing pages, multi-section dashboards, files with embedded CSS+HTML+JS > 200 lines, generated boilerplate templates.
  If you nonetheless attempt a >300 line single \`file:\` write, the system will auto-fire a continuation request — do NOT apologize, just emit the missing rest with \`patch:\` (find a unique anchor near the cut point).
- Inferring the run command from the snapshot. ALWAYS prefer \`python3\` over \`python\`. The runtime image PRE-INSTALLS the most common Python (flask, fastapi, uvicorn, gunicorn, django, sqlalchemy, requests, httpx, python-dotenv, mysql-connector-python, pymysql, psycopg2-binary, pillow) and Node (express, cors, body-parser, dotenv, http-server, serve, vite, tsx, typescript, nodemon) packages globally. **DO NOT prepend \`pip install …\` / \`npm install …\` to the run command for these packages — they're already there.** Only install when the project has its own \`requirements.txt\` / \`package.json\` with NON-standard pinned versions.
  • PHP files with index.php at the root or in public/ → \`php -S 0.0.0.0:$PORT -t <docroot>\`. **NEVER pass any router file (\`router.php\`, \`server.php\`, etc.) as the second argument to \`php -S\`** — most user repos contain a \`router.php\` that ends up requiring itself or other missing files, which crashes every request. PHP's built-in server already serves \`index.php\` automatically; let it. If the user explicitly asks for a router, then warn them and require they confirm.
  • package.json with "scripts.dev" or "start" → \`npm install && npm run dev\` (or \`npm start\`); a bare \`server.js\` / \`index.js\` using express → \`node server.js\` (express is global, no install needed).
  • Flask app object in app.py → \`python3 app.py\` (or \`gunicorn -b 0.0.0.0:$PORT app:app\`); FastAPI → \`uvicorn main:app --host 0.0.0.0 --port $PORT\`.
  • Plain Python script (main.py with no Flask/FastAPI imports) → \`python3 main.py\`. Note this won't bind a port, so the Preview tab will say "workspace tidak berjalan" — that's expected for non-server scripts.
  • Django (manage.py present) → \`python3 manage.py runserver 0.0.0.0:$PORT\`.
  • go.mod → \`go run .\`     • Cargo.toml → \`cargo run\`     • Gemfile (rackup app) → \`bundle exec rackup -o 0.0.0.0 -p $PORT\`
- Always bind web servers to \`0.0.0.0\` and use \`$PORT\` (the workspace's assigned preview port) so the Preview tab can reach them.
- Always give ONE short line of explanation BEFORE the block, then emit the block.
- Never propose destructive commands (rm -rf /, DROP DATABASE, format, etc.) without an explicit warning.
- DATABASE / API CREDENTIALS: when you see PHP/Node code referencing \`getenv('DB_HOST')\`, \`$_ENV['…']\`, \`process.env.…\`, or \`.env\` lookups, and the request fails with "connection refused" / "access denied" / "Failed opening required" style errors, the user almost certainly needs to fill in their secrets via the workspace's **Secrets panel** (the lock icon in the top-right of the editor). Tell them to open Secrets and add the keys (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, etc.) — DO NOT make up values yourself, and DO NOT write secrets directly into source files.

AUTONOMOUS LOOP: After your action blocks run, you may receive a follow-up user message titled "Tool results" listing the outcome (exit codes, file writes, errors) of each block. Treat it like an automatic test report:
- If the result shows success and the original task is fully complete, end with a concise summary (NO more action blocks).
- If the result shows an error or partial success, fix it: emit the next action block(s) needed to recover or continue.
- Do NOT repeat the same failing command — read the error output and adjust (install missing deps, change port, fix path, READ the relevant file with \`bash:run cat …\` first if you don't know what it contains).
- If a server you set with \`workspace:setRun\` returned 404, do NOT keep restarting — open the file with \`bash:run cat <path>\` and figure out the real document root or routing first.
- Keep going until the user's request is satisfied, then stop emitting blocks so the loop ends naturally.`;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea",
]);

/**
 * Build a compact workspace snapshot for the AI:
 *   - working directory
 *   - up to MAX_ENTRIES files/dirs (depth-first, depth-limited),
 *     each with size for files, sorted dirs-first.
 */
/**
 * Project memory: per-workspace instructions file the user can author at
 * `.premdev/instructions.md`. Up to 4 KB is injected verbatim into the
 * system prompt on every chat turn, so the model "remembers" project-wide
 * conventions (preferred libraries, code style, architectural rules)
 * without the user having to repeat them.
 *
 * Returns `""` when the file is missing or unreadable — callers should
 * skip the section in that case to avoid a confusing empty header.
 */
const PROJECT_MEMORY_MAX_BYTES = 4096;
function loadProjectMemory(workspaceId: string): string {
  const root = workspacePath(workspaceId);
  const candidates = [
    path.join(root, ".premdev", "instructions.md"),
    path.join(root, ".premdev", "memory.md"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const stats = fs.statSync(p);
      if (!stats.isFile()) continue;
      const buf = fs.readFileSync(p, "utf8");
      const truncated = buf.length > PROJECT_MEMORY_MAX_BYTES;
      const text = truncated ? buf.slice(0, PROJECT_MEMORY_MAX_BYTES) + "\n…(truncated)" : buf;
      const trimmed = text.trim();
      if (!trimmed) continue;
      return trimmed;
    } catch { /* unreadable — try next */ }
  }
  return "";
}

function buildWorkspaceContext(workspaceId: string, username?: string, workspaceName?: string): string {
  const root = workspacePath(workspaceId);
  const wsDb = buildWorkspaceDbHint(username, workspaceName);
  if (!fs.existsSync(root)) {
    return `Working directory: /workspace (empty)\nFiles: (workspace folder is empty)${wsDb}`;
  }
  const MAX_ENTRIES = 80;
  const MAX_DEPTH = 4;
  const lines: string[] = [];
  function walk(dir: string, rel: string, depth: number) {
    if (lines.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    items
      .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .forEach((e) => {
        if (lines.length >= MAX_ENTRIES) return;
        // Never follow symlinks — they could escape the workspace boundary.
        if (e.isSymbolicLink()) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          lines.push(`${childRel} (symlink, not followed)`);
          return;
        }
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`${childRel}/`);
          walk(path.join(dir, e.name), childRel, depth + 1);
        } else if (e.isFile()) {
          let size = "";
          try {
            // lstat avoids following any symlink that slipped past the dirent check.
            const s = fs.lstatSync(path.join(dir, e.name));
            size = ` (${s.size}B)`;
          } catch {}
          lines.push(`${childRel}${size}`);
        }
      });
  }
  walk(root, "", 0);
  const truncated = lines.length >= MAX_ENTRIES ? "\n…(truncated)" : "";
  const body = lines.length ? lines.join("\n") : "(workspace folder is empty)";
  const hints = detectProjectHints(root, lines);
  const hintBlock = hints.length ? `\nDetected project: ${hints.join("; ")}` : "";
  const dbBlock = sniffDatabaseSchema(root);
  return `Working directory: /workspace\nFiles:\n${body}${truncated}${hintBlock}${dbBlock}${wsDb}`;
}

/**
 * Inject the top-K most semantically relevant code chunks for the user's
 * latest message into the system prompt. This is the lumen-style token
 * optimisation — instead of letting the model issue dozens of follow-up
 * `bash:run cat <file>` calls (each one duplicating the file contents into
 * chat history forever), we pre-compute the relevant excerpts ONCE and ship
 * them as part of the workspace snapshot.
 *
 * Returns "" on any failure (model not loaded, index empty, search error)
 * — the chat handler MUST keep working even when search is dead.
 *
 * Side effect: if the index is empty for this workspace, we kick off a
 * background `indexWorkspace()` so the *next* chat turn has hits. The
 * current turn still returns "" — we don't block the user waiting for an
 * index to build.
 */
const SEARCH_TOP_K = 5;
const SEARCH_MAX_SNIPPET_CHARS = 1500; // per chunk — keeps total budget ~7.5 KB
async function buildRelevantSnippets(workspaceId: string, history: ChatMsg[]): Promise<string> {
  // Find the latest USER message — that's the query intent.
  let query = "";
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      const content = history[i].content;
      query = typeof content === "string" ? content : "";
      break;
    }
  }
  // Skip search for trivially short prompts ("ok", "lanjut", "y") — they
  // carry no semantic signal and would just return random noise.
  query = query.trim();
  if (query.length < 8) return "";

  // If the index is empty, fire-and-forget a build so the NEXT turn has
  // something to search. Don't block this turn.
  const stats = workspaceIndexStats(workspaceId);
  if (!stats.exists || stats.chunks === 0) {
    indexWorkspace(workspaceId).catch(() => { /* swallowed — admin UI will show the error */ });
    return "";
  }

  const hits = await semanticSearch(workspaceId, query, SEARCH_TOP_K);
  if (hits.length === 0) return "";

  // Format as a clear, parseable block. The leading newline matters — it
  // separates from `${ctx}` in the caller.
  const formatted = hits.map((h) => {
    const snippet = h.content.length > SEARCH_MAX_SNIPPET_CHARS
      ? h.content.slice(0, SEARCH_MAX_SNIPPET_CHARS) + "\n… (truncated)"
      : h.content;
    return `### ${h.path} (lines ${h.startLine}-${h.endLine}, score ${h.score.toFixed(2)})\n\`\`\`\n${snippet}\n\`\`\``;
  }).join("\n\n");

  return `\n\n--- Relevant code snippets (semantic search; pre-fetched, do NOT re-read these files unless changed) ---\n${formatted}`;
}

/**
 * Tell the model exactly which MySQL database belongs to this workspace
 * (created automatically at workspace-create time by `createProjectDb`),
 * and which env vars are pre-injected into the runtime container so user
 * code can connect without configuration. The actual password is NEVER
 * surfaced — the model uses the env vars from inside the container instead.
 */
function buildWorkspaceDbHint(username?: string, workspaceName?: string): string {
  if (!config.MYSQL_HOST || !username || !workspaceName) return "";
  const safeUser = username.replace(/[^a-zA-Z0-9_]/g, "");
  const safeProj = workspaceName.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!safeUser || !safeProj) return "";
  const dbName = `${safeUser}_${safeProj}`;
  return (
    `\n\nWorkspace database (MySQL):\n` +
    `- Host: ${config.MYSQL_HOST}  Port: ${config.MYSQL_PORT}\n` +
    `- Database: \`${dbName}\` (already exists, owned by user \`${safeUser}\`)\n` +
    `- Inside the runtime container these env vars are pre-set: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DATABASE_NAME, DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD. Reference them via process.env / getenv / os.environ — DO NOT ask the user for credentials, they are already there.\n` +
    `- To run SQL directly from chat use the \`db:query\` action (one statement per block). Example: \`\`\`db:query\nSHOW TABLES;\n\`\`\`\n` +
    `- To use it from app code, e.g. PHP: \`new mysqli(getenv('DB_HOST'), getenv('DB_USER'), getenv('DB_PASSWORD'), getenv('DATABASE_NAME'))\`. Node: \`mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DATABASE_NAME })\`. Python: \`pymysql.connect(host=os.environ['DB_HOST'], user=os.environ['DB_USER'], password=os.environ['DB_PASSWORD'], database=os.environ['DATABASE_NAME'])\`.`
  );
}

/**
 * If the workspace has either:
 *   - a SQLite file at the root (≤ 50 MB), or
 *   - SQL DDL files (schema.sql / migrations/*.sql / db.sql), or
 *   - a .env / .premdev with DB_* hints
 * surface a short "Database schema" section so the assistant can write
 * code against the real tables/columns rather than guessing. We intentionally
 * never connect to remote databases here — credentials live with the user
 * and we cannot route from the API container into their MySQL anyway.
 *
 * Best-effort and defensive: any failure returns "" so the chat continues.
 */
function sniffDatabaseSchema(root: string): string {
  try {
    const out: string[] = [];
    // 1. Look for SQL files we can read directly.
    const candidateFiles = [
      "schema.sql", "db.sql", "init.sql", "database.sql",
      "migrations/schema.sql", "prisma/schema.prisma", "drizzle/schema.ts",
    ];
    for (const rel of candidateFiles) {
      const p = path.join(root, rel);
      try {
        const s = fs.statSync(p);
        if (!s.isFile() || s.size > 200_000) continue;
        const txt = fs.readFileSync(p, "utf8");
        out.push(`-- ${rel} (${s.size}B):\n${txt.slice(0, 4000)}${txt.length > 4000 ? "\n…(truncated)" : ""}`);
        if (out.length >= 2) break;
      } catch { /* skip */ }
    }
    // 2. Detect MySQL/Postgres credentials in .env so the model knows the
    //    backing DB even when we have no schema files.
    let envHint = "";
    for (const envName of [".env", ".env.local"]) {
      try {
        const envTxt = fs.readFileSync(path.join(root, envName), "utf8");
        const lines = envTxt.split("\n").filter((l) => /^DB_|^DATABASE_/.test(l) && !/=\s*$/.test(l));
        if (lines.length) {
          // Mask values, keep keys only — never leak passwords to the model.
          const keys = lines.map((l) => l.split("=")[0]).join(", ");
          envHint = `External database referenced in ${envName} via env keys: ${keys} (values not shown).`;
          break;
        }
      } catch { /* skip */ }
    }
    // 3. Detect SQLite database files in the project root and a couple of
    //    common subdirs. We can't safely query them without a driver, but
    //    surfacing their existence + path lets the model suggest the right
    //    sqlite3 CLI invocation in actions.
    const sqliteHits: string[] = [];
    const sqliteRe = /\.(db|sqlite|sqlite3)$/i;
    const dirsToScan = [root, path.join(root, "data"), path.join(root, "db"), path.join(root, "var")];
    for (const dir of dirsToScan) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          if (!sqliteRe.test(ent.name)) continue;
          const full = path.join(dir, ent.name);
          let size = 0;
          try { size = fs.statSync(full).size; } catch {}
          sqliteHits.push(`${path.relative(root, full)} (${size}B)`);
          if (sqliteHits.length >= 4) break;
        }
        if (sqliteHits.length >= 4) break;
      } catch { /* dir missing — fine */ }
    }

    if (!out.length && !envHint && !sqliteHits.length) return "";
    const parts = ["\nDatabase schema:"];
    if (envHint) parts.push(envHint);
    if (sqliteHits.length) {
      parts.push(
        `SQLite database file(s) detected: ${sqliteHits.join(", ")}. ` +
          `Use \`bash:run sqlite3 <file> ".schema"\` to inspect schema.`,
      );
    }
    if (out.length) parts.push(out.join("\n\n"));
    return "\n" + parts.join("\n");
  } catch {
    return "";
  }
}

/**
 * Inspect the listing for known project-type signals and return one or more
 * short hints like 'PHP web app, run: php -S 0.0.0.0:5000 -t .'.
 * Hints are strictly suggestions — the model still decides what to emit.
 */
function detectProjectHints(root: string, lines: string[]): string[] {
  const has = (name: string) => lines.some((l) => l.split(" ")[0] === name);
  const hasAny = (re: RegExp) => lines.some((l) => re.test(l.split(" ")[0]));
  const out: string[] = [];

  if (has("package.json")) {
    let runHint = "npm install && npm start";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.dev) runHint = "npm install && npm run dev";
      else if (scripts.start) runHint = "npm install && npm start";
      else if (pkg.main) runHint = `npm install && node ${pkg.main}`;
    } catch {}
    out.push(`Node.js project (package.json), run: ${runHint}`);
  }
  if (has("requirements.txt") || has("pyproject.toml") || hasAny(/\.py$/)) {
    let entry = "main.py";
    for (const cand of ["app.py", "main.py", "server.py", "run.py", "manage.py"]) {
      if (has(cand)) { entry = cand; break; }
    }
    // Runtime image already has flask/fastapi/django/uvicorn/gunicorn/etc.
    // Only run pip install when the project pins something custom.
    const install = has("requirements.txt") ? "pip install -r requirements.txt && " : "";
    out.push(`Python project (runtime has flask/fastapi/uvicorn pre-installed), run: ${install}python3 ${entry}`);
  }
  if (has("index.php") || has("router.php") || hasAny(/\.php$/)) {
    const router = has("router.php") ? " router.php" : "";
    out.push(`PHP web app, run: php -S 0.0.0.0:5000 -t .${router}`);
  }
  if (has("Gemfile")) {
    out.push("Ruby project, run: bundle install && bundle exec rackup -o 0.0.0.0 -p 5000");
  }
  if (has("go.mod")) {
    out.push("Go project, run: go run .");
  }
  if (has("Cargo.toml")) {
    out.push("Rust project, run: cargo run");
  }
  if (has("pom.xml")) {
    out.push("Java Maven project, run: mvn -q spring-boot:run");
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    out.push("Java Gradle project, run: ./gradlew bootRun");
  }
  if (has("index.html") && out.length === 0) {
    out.push("Static site, serve: python3 -m http.server 5000");
  }
  return out;
}

// Default to "auto" everywhere. Auto = "try smartest model first; if that key
// is rate-limited (429) or out of quota, fall over to the next-cheapest model
// in the tier, then to the next configured key (multi-key failover). Gives
// the best UX out of the box: user always gets the best model their quota
// allows without having to babysit the dropdown.
const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "auto",
  anthropic: "auto",
  google: "auto",
  openrouter: "auto",
  groq: "auto",
  konektika: "auto",
  snifox: "auto",
};

// Free-tier Gemini models, ordered by cost-effectiveness (cheapest first).
// "auto" iterates this list and falls through on 429 quota errors. The live
// list from Google's ListModels endpoint is preferred at runtime; this
// constant is only the fallback when the API call fails.
const GEMINI_FREE_TIER = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash",
] as const;

const PROVIDER_MODELS: Record<Provider, string[]> = {
  openai: ["auto", "gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["auto", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  // User-curated short list (per request, 2026-04). Live model fetch from
  // /v1beta/models still overrides this at runtime — these names just give
  // the UI something to show when the live fetch fails or hasn't run yet.
  google: [
    "auto",
    "gemini-2.5-flash",
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ],
  // Free models on OpenRouter rotate often. These are the slugs that have
  // free quota as of 2026-04. If a model 404s, fall back to "openrouter/auto".
  openrouter: [
    "auto",
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "google/gemma-2-9b-it:free",
    "openrouter/auto",
  ],
  groq: ["auto", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  konektika: ["auto", "kimi-pro"],
  // Static fallback only — the live list is fetched from /v1/models at
  // runtime (cached 10 min) and replaces this on /providers responses. The
  // entries below are real Snifox models as of 2026-04 so the dropdown
  // never shows up empty even when the upstream is unreachable.
  snifox: [
    "auto",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-5-codex",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash",
  ],
};

// Per-provider "auto" tier — smartest first, cheapest last. When the user
// (or the default) picks "auto", the dispatcher iterates this list and
// falls over to the next model on quota / rate-limit / 401 errors. Google
// has its own dynamic auto handler in streamGoogle (it queries the live
// model list per-key), so its tier here is unused by the dispatcher.
const AUTO_TIERS: Record<Provider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  google: [...GEMINI_FREE_TIER], // unused — streamGoogle handles auto
  openrouter: [
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  konektika: ["kimi-pro"],
  snifox: [
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-flash",
  ],
};

// Models known to ignore the structured action format (file:/bash:/patch:
// fenced blocks) and respond with plain prose only. Surfaced in the
// /providers response so the UI can mark them with a "text only" badge.
// Heuristic — if a model occasionally follows actions, leaving it OFF
// this list is safer than confusing users with false positives.
const TEXT_ONLY_MODEL_PATTERNS: RegExp[] = [
  /gemma/i,
  /llama-3\.1-8b/i,
  /llama-3\.2-(?:1b|3b)/i,
  /qwen-2\.5-(?:0\.5|1\.5|3|7)b/i,
  /mixtral-8x7b/i,
];

function isTextOnlyModel(name: string): boolean {
  if (name === "auto") return false;
  return TEXT_ONLY_MODEL_PATTERNS.some((re) => re.test(name));
}

// Images come in as data URLs (`data:image/png;base64,…`). Cap each at ~5 MB
// of base64 to keep request bodies reasonable; we additionally cap the count
// per message to 4. The bodyLimit on Fastify (50 MB) is the ultimate ceiling.
const ImageDataUrl = z
  .string()
  .max(7 * 1024 * 1024)
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/);

const Body = z.object({
  workspaceId: z.string(),
  // Per-workspace chat tab the request was kicked off from. Persisted on
  // the job so the client can later list "which jobs belong to which
  // tab" when it reconnects after a refresh and route the resumed
  // stream to the right tab's bubble. Falls back to "default" so old
  // clients that don't send the field keep working.
  tabId: z.string().min(1).max(64).optional().default("default"),
  provider: z.enum(["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"]),
  model: z.string().optional(),
  autoPilot: z.boolean().default(true),
  // Set by the client's auto-continue loop when it detects the previous
  // assistant turn closed mid-action-fence. Server uses this (NOT any text
  // marker) to inject the AUTO CONTINUATION recovery system block. Keeping
  // it in the body keeps the trigger out of user-typed content, so a user
  // typing "[CONT_TRUNC]" or similar can never spoof recovery instructions.
  continuation: z.boolean().optional().default(false),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    images: z.array(ImageDataUrl).max(4).optional(),
  })),
});

type ChatMsg = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
};

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

const MAX_HISTORY_CHARS = 24000;
const MAX_HISTORY_MESSAGES = 30;
const MAX_SINGLE_MESSAGE_CHARS = 8000;
// Output cap per AI turn. Old defaults (1024 / 2048) were too small: the
// model would start emitting a `file:` action block, run out of tokens
// before the closing fence, and the frontend would freeze on
// "sedang ditulis" forever (the action never closes → no ActionCard →
// user can't approve). 4k / 8k easily fit a typical full-file write
// while still being well below modern provider limits (Claude/GPT/Gemini
// all support 8k+ output). Override per-VPS via env if you want to push
// further or save cost.
const MAX_TOKENS_DEFAULT = parseInt(process.env.AI_MAX_TOKENS_DEFAULT || "4096", 10) || 4096;
// 16384 is the high end most providers will accept (Anthropic Sonnet 3.5+
// supports up to 64K with beta header, OpenAI gpt-4o supports 16K, Google
// Gemini Pro supports 8K). Free-tier providers may silently cap lower —
// the client-side auto-continue loop covers that case so users don't have
// to manually click "lanjutkan" when output gets truncated.
const MAX_TOKENS_AUTOPILOT = parseInt(process.env.AI_MAX_TOKENS_AUTOPILOT || "16384", 10) || 16384;

/**
 * Truncate a single message that exploded (e.g. user pasted a 200KB log).
 * Keep the head and tail — middles of huge dumps are usually low-signal.
 * Pure text only; images are not affected.
 */
function clampMessage(content: string): string {
  if (content.length <= MAX_SINGLE_MESSAGE_CHARS) return content;
  const head = Math.floor(MAX_SINGLE_MESSAGE_CHARS * 0.6);
  const tail = Math.max(0, MAX_SINGLE_MESSAGE_CHARS - head - 80);
  return (
    content.slice(0, head) +
    `\n\n…[${content.length - head - tail} chars elided to save tokens]…\n\n` +
    content.slice(content.length - tail)
  );
}

/**
 * Sliding-window history: keep the most recent messages that fit under the
 * char + count budget. Always preserve at least the last user turn so the
 * model sees what to answer. Each message is also clamped individually so a
 * single huge paste cannot starve the rest of the history.
 */
function trimHistory(msgs: ChatMsg[]): ChatMsg[] {
  let total = 0;
  const out: ChatMsg[] = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < MAX_HISTORY_MESSAGES; i--) {
    const original = msgs[i];
    const clamped: ChatMsg = { ...original, content: clampMessage(original.content) };
    const len = clamped.content.length;
    // Images are billed/streamed separately; only count text against the
    // history budget. We always keep the message that carries images even if
    // its text is small, since the user explicitly attached them.
    if (total + len > MAX_HISTORY_CHARS && out.length > 0) break;
    out.unshift(clamped);
    total += len;
  }
  return out;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // POST /chat
  // -----------
  // Decoupled from the HTTP request lifecycle: this handler builds the
  // prompt, creates an in-memory job, kicks off the upstream streaming in
  // the background, and immediately returns `{ jobId }` to the client.
  // The actual reply text is delivered through the SSE endpoint
  // `/chat/jobs/:id/stream`, so a tab close / refresh / network blip does
  // NOT cancel the run — the user can reconnect and pick up exactly
  // where they left off (see ai-jobs.ts for the design rationale).
  app.post("/chat", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = Body.parse(req.body);

    // Verify workspace ownership before exposing its file listing in the prompt.
    const w = db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Workspace not found" });

    const sys = body.autoPilot ? AUTO_PILOT_PROMPT : SYSTEM_PROMPT;
    // Look up the owner's username so the workspace-database hint can name
    // the per-user MySQL database in the snapshot. Failure is non-fatal —
    // the hint just gets omitted.
    const ownerRow = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(w.user_id) as { username?: string } | undefined;
    const ctx = buildWorkspaceContext(body.workspaceId, ownerRow?.username, w.name);
    const memory = loadProjectMemory(body.workspaceId);
    const trimmed = trimHistory(body.messages as ChatMsg[]);
    // Semantic snippets: take the LAST user message as the search query and
    // pull the top-K relevant code chunks. Pre-fetching them here means the
    // model rarely needs to issue follow-up `bash:run cat <file>` calls,
    // which is where most of the historical token bleed came from.
    //
    // Best-effort only — if the index is empty, missing, or the embedding
    // model failed to load, we silently fall through to the old behaviour
    // (file list only). The chat MUST never break because of search.
    const snippetsBlock = await buildRelevantSnippets(body.workspaceId, trimmed).catch(() => "");
    // Merge into a single system message so providers that only accept one
    // (Anthropic, Google) still see the workspace snapshot. Project memory
    // (`.premdev/instructions.md`) is appended last so the user's per-repo
    // conventions take precedence over the global system rules above.
    const memoryBlock = memory ? `\n\n--- Project memory (.premdev/instructions.md) ---\n${memory}` : "";

    // Auto-continuation recovery: when the client detects the previous
    // assistant turn closed mid-action-fence, it re-fires the chat with
    // `continuation: true` in the body. We DELIBERATELY do NOT trust any
    // text marker inside the user message — that would let users prompt-
    // inject by typing a magic string. The body field is set only by our
    // own client code after a real fence-truncation event.
    const continuationBlock = body.continuation
      ? `\n\n--- AUTO CONTINUATION ---\nYour PREVIOUS turn ended mid-action-block — the closing fence (\`\`\`\` for file: / \`\`\` for others) was never emitted, so the action silently failed and nothing was applied. RECOVER NOW:\n1. Look at your last assistant message in this conversation. Identify which action fence was open and what file path it was for.\n2. If it was a \`file:PATH\`: that file write was LOST. Re-emit it as a NEW \`file:PATH\` action — but this time write a SHORTER skeleton (target ≤80 lines), then use one or more follow-up \`patch:PATH\` actions to fill in remaining sections one at a time. Do NOT attempt the same single huge \`file:\` again.\n3. If it was a \`patch:PATH\`: re-emit just that patch with a CORRECT closing fence.\n4. NO apologies, NO preamble, NO restating the plan. Emit the action block(s) immediately.`
      : "";

    const messages: ChatMsg[] = [
      { role: "system", content: `${sys}\n\n--- Workspace snapshot ---\n${ctx}${snippetsBlock}${memoryBlock}${continuationBlock}` },
      ...trimmed,
    ];
    const model = body.model || DEFAULT_MODELS[body.provider];
    const maxTokens = body.autoPilot ? MAX_TOKENS_AUTOPILOT : MAX_TOKENS_DEFAULT;

    const job = createJob({
      workspaceId: body.workspaceId,
      tabId: body.tabId,
      userId: u.id,
      provider: body.provider,
      model,
      continuation: body.continuation,
    });

    // Return jobId immediately. The HTTP request closes here; the
    // streaming work continues in the background, decoupled from this
    // socket.
    void reply.send({ jobId: job.id });

    // Background runner — explicitly NOT awaited. setImmediate keeps it
    // out of the reply.send promise chain so any throw here can never
    // re-enter Fastify's reply lifecycle (which would warn about
    // sending after end).
    setImmediate(() => {
      runChatJob(job, body, model, maxTokens, messages, u.id).catch((e) => {
        finishJob(job, "error", e?.message || String(e));
      });
    });
  });

  // Background worker: drives the upstream provider stream into the job
  // buffer. Audit log row is written exactly once on terminal state.
  async function runChatJob(
    job: ChatJob,
    body: z.infer<typeof Body>,
    model: string,
    maxTokens: number,
    messages: ChatMsg[],
    userId: string,
  ) {
    const startedAt = Date.now();
    let totalChars = 0;
    let lastChunk = "";
    let ok = true;
    let errMsg: string | null = null;
    try {
      const stream = streamProvider(body.provider, model, messages, maxTokens, job.controller.signal);
      for await (const chunk of stream) {
        if (job.status !== "running") break; // aborted externally
        totalChars += chunk.length;
        lastChunk = chunk;
        appendChunk(job, chunk);
      }
      if (job.status === "running") finishJob(job, "done");
    } catch (e: any) {
      ok = false;
      errMsg = e?.message || String(e);
      if (errMsg && !errMsg.includes("aborted")) {
        appendChunk(job, `\n[Error: ${errMsg}]`);
      }
      finishJob(job, errMsg && errMsg.includes("aborted") ? "aborted" : "error", errMsg ?? undefined);
    } finally {
      try {
        const dur = Date.now() - startedAt;
        const preview = (errMsg ? `[err] ${errMsg}` : lastChunk).slice(-2000);
        db.prepare(`
          INSERT INTO ai_tool_calls
            (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
          VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?)
        `).run(
          nanoid(16),
          userId,
          body.workspaceId,
          body.provider,
          model,
          `chars=${totalChars} dur=${dur}ms${body.autoPilot ? " autopilot" : ""}${body.continuation ? " cont" : ""}`,
          ok ? 1 : 0,
          preview || null,
          startedAt,
        );
      } catch {}
    }
  }

  // GET /chat/jobs/active?workspaceId=…
  // -----------------------------------
  // Lists jobs the calling user has currently running in the given
  // workspace. The client polls this on mount (and on workspace switch)
  // to discover any in-flight jobs that survived a refresh, then
  // reconnects to each via the /stream endpoint below.
  app.get("/chat/jobs/active", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = z.object({ workspaceId: z.string().min(1) }).parse(req.query);
    const list = listActiveJobs(q.workspaceId, u.id).map((j) => ({
      id: j.id,
      tabId: j.tabId,
      provider: j.provider,
      model: j.model,
      continuation: j.continuation,
      bufferLen: j.buffer.length,
      createdAt: j.createdAt,
    }));
    return reply.send({ jobs: list });
  });

  // GET /chat/jobs/:id/stream?offset=N
  // ----------------------------------
  // Server-Sent Events. The first event(s) replay everything from byte
  // `offset` onwards (so a reconnecting tab catches up without
  // duplicates), then the connection stays open and tails new chunks as
  // the background worker produces them. Closes with a final `done`
  // event once the job reaches a terminal state.
  //
  // Auth: cookie-based (browser EventSource sends cookies when opened
  // with `withCredentials: true`). Job ownership is verified before any
  // bytes are written.
  app.get("/chat/jobs/:id/stream", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const query = z.object({ offset: z.coerce.number().int().min(0).optional().default(0) }).parse(req.query);
    const job = getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Job not found or expired" });
    if (job.userId !== u.id) return reply.code(403).send({ error: "Forbidden" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Hint to the browser that this stream may be long-lived. Nginx +
    // similar proxies see the no-transform + X-Accel-Buffering combo and
    // skip their response buffer, which would otherwise hold our chunks
    // back until the buffer filled (defeating the live-stream UX).

    const writeEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* socket gone */ }
    };

    // ATOMIC replay + subscribe. The naive sequence (replay first, then
    // add subscriber) leaves a gap: any chunk that the background
    // worker appends between the snapshot and the subscriber-add gets
    // sent to neither the replay slice nor the live tail and is
    // silently lost. JavaScript is single-threaded, so as long as we
    // snapshot `buffer.length` and call `subscribers.add` in the same
    // synchronous block (no `await`s between them) the background
    // worker's `appendChunk` cannot interleave.
    const snapshotLen = job.buffer.length;
    const replaySlice = snapshotLen > query.offset
      ? job.buffer.slice(query.offset, snapshotLen)
      : "";

    // If the job is already terminal, emit replay + done and close. No
    // subscriber needed.
    if (job.status !== "running") {
      if (replaySlice) writeEvent("chunk", { text: replaySlice });
      writeEvent("done", { status: job.status, error: job.error });
      reply.raw.end();
      return;
    }

    // Live tail: subscribe to future chunks + the terminal transition.
    // Subscribe BEFORE writing the replay slice so any chunk that lands
    // after our snapshotLen read goes through this subscriber instead
    // of vanishing into the gap.
    const sub = (payload: { chunk?: string; status?: JobStatus; error?: string }) => {
      if (payload.chunk) writeEvent("chunk", { text: payload.chunk });
      if (payload.status) {
        writeEvent("done", { status: payload.status, error: payload.error });
        try { reply.raw.end(); } catch {}
        job.subscribers.delete(sub);
      }
    };
    job.subscribers.add(sub);

    // Now safe to flush the replay — any subsequent chunks fan out via
    // the subscriber we just registered, in order, after the replay.
    if (replaySlice) writeEvent("chunk", { text: replaySlice });

    // Heartbeat every 20s so any intermediary proxy doesn't reap an idle
    // SSE connection during long upstream pauses (Gemini "thinking"
    // blocks routinely take 30-60s before the first chunk lands).
    const hb = setInterval(() => {
      try { reply.raw.write(`: heartbeat\n\n`); } catch {}
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(hb);
      job.subscribers.delete(sub);
    });
  });

  // POST /chat/jobs/:id/abort
  // -------------------------
  // User-initiated stop. Aborts the upstream fetch via the job's
  // controller, marks the job aborted, and notifies all subscribers.
  // Idempotent — calling on an already-terminal job is a no-op.
  app.post("/chat/jobs/:id/abort", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const ok = abortJob(params.id, u.id);
    if (!ok) return reply.code(404).send({ error: "Job not found" });
    return reply.send({ ok: true });
  });

  // === Audit log ===
  // Frontend posts one row per executed AI action (bash, file, setRun, etc.)
  // so the admin can later see exactly what the AI did, when, on which
  // workspace, and whether it succeeded. Stored in `ai_tool_calls`.
  const AuditBody = z.object({
    workspaceId: z.string().min(1).max(64),
    provider: z.string().max(32).optional(),
    model: z.string().max(128).optional(),
    kind: z.string().min(1).max(32),
    target: z.string().max(500).optional(),
    ok: z.boolean(),
    output: z.string().max(2000).optional(),
  });
  app.post("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = AuditBody.parse(req.body);
    // Verify the workspace belongs to this user; ignore foreign IDs silently
    // so a malicious client can't pollute another user's audit log.
    const w = db
      .prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id);
    if (!w) return reply.code(404).send({ error: "Workspace not found" });
    const id = nanoid(16);
    const preview = (body.output ?? "").slice(0, 2000);
    db.prepare(`
      INSERT INTO ai_tool_calls
        (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      u.id,
      body.workspaceId,
      body.provider ?? null,
      body.model ?? null,
      body.kind,
      body.target ?? null,
      body.ok ? 1 : 0,
      preview || null,
      Date.now(),
    );
    return { id };
  });

  // User-facing read: own workspace history only.
  app.get("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = req.query as any;
    const wsId = typeof q.workspaceId === "string" ? q.workspaceId : null;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const rows = wsId
      ? db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ? AND workspace_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, wsId, limit)
      : db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, limit);
    return { rows };
  });

  app.get("/providers", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    // For Google, fetch the live model list so the dropdown only shows
    // models that actually exist for the user's project (avoids 404s on
    // preview model names like gemini-3-flash-preview-MM-YYYY that change).
    // Fetch live model lists in parallel — both endpoints are slow-ish (200-
    // 800ms) and we don't want to add their latencies. Either can fail
    // independently and we fall back to the static PROVIDER_MODELS list.
    const [googleLive, snifoxLive] = await Promise.all([
      fetchGoogleModels().catch(() => null),
      fetchSnifoxModels().catch(() => null),
    ]);
    return {
      providers: (["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"] as Provider[]).map((id) => {
        let models = PROVIDER_MODELS[id];
        if (id === "google" && googleLive && googleLive.length > 0) {
          // Always keep "auto" first, then the live models.
          models = ["auto", ...googleLive];
        }
        if (id === "snifox" && snifoxLive && snifoxLive.length > 0) {
          // Live snifox list doesn't include "auto" — keep it pinned at top
          // so the dropdown's default-friendly option is always present.
          models = ["auto", ...snifoxLive];
        }
        return {
          id,
          configured: !!getAIKey(id),
          models,
          // Sub-list of `models` that are heuristically text-only (no
          // structured action support). Frontend renders a small badge
          // next to these in the dropdown so users know they'll get
          // prose-only output, not file: / bash: actions.
          textOnlyModels: models.filter(isTextOnlyModel),
          defaultModel: DEFAULT_MODELS[id],
        };
      }),
    };
  });

  // ---------------------------------------------------------------------
  // Web search (used by the AI's `web:search` action)
  // ---------------------------------------------------------------------
  // Calls DuckDuckGo's lite HTML endpoint and parses the result links —
  // no API key required, no rate-limit account to manage. We send a
  // browser User-Agent because DDG returns a 403 to bare fetch UAs, and
  // we cap the response body so a misbehaving upstream can't fill memory.
  // ---------------------------------------------------------------------
  const WebSearchBody = z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().positive().max(20).optional().default(8),
  });
  app.post("/web-search", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = WebSearchBody.parse(req.body);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(body.query)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(body.query)}`,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!r.ok) return reply.code(502).send({ error: `Upstream returned ${r.status}` });
      const html = (await r.text()).slice(0, 1024 * 1024); // 1 MB cap
      // Each result is wrapped in a <a class="result__a" href="…">title</a>
      // followed by an <a class="result__snippet">snippet</a>. We pull both
      // with a couple of forgiving regexes; the DDG HTML is stable but
      // occasionally inserts whitespace inside the tags.
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const links: Array<{ title: string; url: string }> = [];
      const snippets: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) && links.length < body.maxResults) {
        let href = m[1];
        // DDG redirects through /l/?uddg=ENCODED&… — extract the real URL.
        const ud = href.match(/[?&]uddg=([^&]+)/);
        if (ud) try { href = decodeURIComponent(ud[1]); } catch { /* keep as-is */ }
        if (href.startsWith("//")) href = "https:" + href;
        const title = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
        if (title) links.push({ title, url: href });
      }
      while ((m = snippetRe.exec(html)) && snippets.length < links.length) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim());
      }
      for (let i = 0; i < links.length; i++) {
        results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
      }
      return { ok: true, query: body.query, results };
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message ?? "Web search failed" });
    }
  });
};

let cachedGoogleModels: { at: number; list: string[] } | null = null;
async function fetchGoogleModels(): Promise<string[]> {
  const key = getAIKey("google");
  if (!key) return [];
  // Cache for 10 minutes — model lists rarely change and we don't want to
  // hammer the ListModels endpoint on every dropdown open.
  if (cachedGoogleModels && Date.now() - cachedGoogleModels.at < 10 * 60 * 1000) {
    return cachedGoogleModels.list;
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`);
  if (!res.ok) return cachedGoogleModels?.list ?? [];
  const j = (await res.json().catch(() => null)) as any;
  const arr = Array.isArray(j?.models) ? j.models : [];
  const list: string[] = arr
    .filter((m: any) => Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter((n: string) => n.startsWith("gemini-"))
    // Hide deprecated -001/-latest aliases that confuse the picker.
    .filter((n: string) => !/-001$|-002$/.test(n));
  // Sort: newest version family first (3.x > 2.5 > 2.0 > 1.5), then "pro" > "flash" > "flash-lite".
  list.sort((a, b) => b.localeCompare(a));
  cachedGoogleModels = { at: Date.now(), list };
  return list;
}

let cachedSnifoxModels: { at: number; list: string[] } | null = null;
async function fetchSnifoxModels(): Promise<string[]> {
  // Snifox /v1/models is an OpenAI-compatible list endpoint. It's also
  // public (no auth required as of 2026-04) so we can fetch it even before
  // the user configures a key — handy so the dropdown is populated when
  // they pick "Snifox" for the first time. Cached 10 min.
  if (cachedSnifoxModels && Date.now() - cachedSnifoxModels.at < 10 * 60 * 1000) {
    return cachedSnifoxModels.list;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const key = getAIKey("snifox");
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await fetch("https://core.snifoxai.com/v1/models", {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return cachedSnifoxModels?.list ?? [];
    const j = (await res.json().catch(() => null)) as any;
    const arr = Array.isArray(j?.data) ? j.data : [];
    const list: string[] = arr
      .map((m: any) => String(m?.id ?? "").trim())
      .filter((s: string) => s.length > 0)
      // Stable order: by vendor (anthropic/google/openai/...) then by id desc
      // so newest version variants float to the top within a vendor.
      .sort((a: string, b: string) => {
        const av = a.split("/")[0]; const bv = b.split("/")[0];
        if (av !== bv) return av.localeCompare(bv);
        return b.localeCompare(a);
      });
    cachedSnifoxModels = { at: Date.now(), list };
    return list;
  } finally {
    clearTimeout(t);
  }
}

async function* streamProvider(
  provider: Provider,
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal
): AsyncGenerator<string> {
  // "auto" routing: for non-google providers, the dispatcher iterates the
  // per-provider tier list and falls over to the next model on quota /
  // rate-limit errors. Google has its own dynamic auto handler that
  // queries the live model list, so we let it handle "auto" itself.
  if (model === "auto" && provider !== "google") {
    yield* streamProviderAuto(provider, messages, maxTokens, signal);
    return;
  }
  switch (provider) {
    case "openai":
      yield* streamOpenAICompat({
        url: "https://api.openai.com/v1/chat/completions",
        keys: getAIKeys("openai"),
        providerLabel: "OpenAI",
        model, messages, signal, maxTokens,
      });
      return;
    case "anthropic":
      yield* streamAnthropic(model, messages, maxTokens, signal);
      return;
    case "google":
      yield* streamGoogle(model, messages, maxTokens, signal);
      return;
    case "openrouter":
      yield* streamOpenAICompat({
        url: "https://openrouter.ai/api/v1/chat/completions",
        keys: getAIKeys("openrouter"),
        providerLabel: "OpenRouter",
        model, messages, signal, maxTokens,
        extraHeaders: {
          "HTTP-Referer": "https://flixprem.org",
          "X-Title": "PremDev",
        },
      });
      return;
    case "groq":
      yield* streamOpenAICompat({
        url: "https://api.groq.com/openai/v1/chat/completions",
        keys: getAIKeys("groq"),
        providerLabel: "Groq",
        model, messages, signal, maxTokens,
      });
      return;
    case "konektika":
      // Konektika kimi-pro is OpenAI-compatible BUT rejects sampling params
      // (temperature, top_p, max_tokens). Pass omitMaxTokens=true so we never
      // send `max_tokens` and trigger 400 Bad Request. See https://konektika.web.id/docs.
      yield* streamOpenAICompat({
        url: "https://konektika.web.id/v1/chat/completions",
        keys: getAIKeys("konektika"),
        providerLabel: "Konektika",
        model, messages, signal, maxTokens,
        omitMaxTokens: true,
      });
      return;
    case "snifox":
      // SnifoxAI Gateway — strict OpenAI-compatible aggregator (proxies to
      // OpenRouter under the hood). Base URL https://core.snifoxai.com/v1
      // and key prefix `snfx-`. See https://snifoxai.com/docs.
      yield* streamOpenAICompat({
        url: "https://core.snifoxai.com/v1/chat/completions",
        keys: getAIKeys("snifox"),
        providerLabel: "Snifox",
        model, messages, signal, maxTokens,
      });
      return;
  }
}

// HTTP statuses that strongly suggest "this specific key is exhausted /
// invalid", so the multi-key failover should try the next key instead of
// surfacing the error to the user. 5xx and 4xx body-shape errors are NOT
// in here on purpose — those are upstream issues, not key issues, and a
// silent failover would just burn through every key the user has.
const KEY_FAILOVER_STATUSES = new Set([401, 402, 403, 429]);

/**
 * AUTO-mode router for any non-google provider.
 * Iterates the provider's tier (smartest → cheapest), running each model
 * through the normal streamProvider dispatch. The first model that emits
 * real content wins; if a model fails (rate-limit, quota, key-not-set,
 * 5xx, etc.) we silently roll over to the next.
 *
 * Failure detection is heuristic but reliable: providers above signal
 * non-recoverable failure by yielding a single chunk that starts with
 * `Error:` or `(<provider> key not configured)`. Anything else (real
 * content, multi-key failover notes, model-rotation notes) is treated
 * as success and committed to the stream.
 *
 * Once committed, the dispatcher prepends a one-line `[Auto pilih …]`
 * note so the user can see which model actually answered (the bubble's
 * model badge would otherwise just say "auto").
 */
async function* streamProviderAuto(
  provider: Provider,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const tier = AUTO_TIERS[provider] ?? [];
  if (tier.length === 0) {
    yield `(Auto: tier list untuk ${provider} kosong — pilih model spesifik di dropdown.)`;
    return;
  }
  let lastErr = "";
  for (let i = 0; i < tier.length; i++) {
    const candidate = tier[i];
    let firstSeen = false;
    let success = false;
    let abortedThis = false;
    try {
      for await (const chunk of streamProvider(provider, candidate, messages, maxTokens, signal)) {
        if (!firstSeen) {
          firstSeen = true;
          // Reject the candidate only if its FIRST chunk is a hard failure
          // marker. The multi-key failover note (`[Key #N dipakai…]`) is
          // wrapped in brackets — guard against treating it as failure by
          // matching ONLY the exact "key not configured" suffix our own
          // providers emit. Don't match on "tier list / kosong" — those
          // strings only exist in our own tier-empty early-return path
          // (which never reaches this loop), and matching them risks
          // mis-classifying legit prose like "(tier list of options…)"
          // that an AI might output in its FIRST chunk as a failure.
          if (
            chunk.startsWith("Error:") ||
            /^\([^)]*key not configured[^)]*\)$/i.test(chunk.trim())
          ) {
            lastErr = chunk.slice(0, 200);
            abortedThis = true;
            break;
          }
          success = true;
          yield `\n[Auto pilih ${provider}/${candidate}${i > 0 ? ` — ${i} model sebelumnya gagal` : ""}]\n`;
        }
        yield chunk;
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
      abortedThis = true;
    }
    if (success && !abortedThis) return;
    // Empty stream (model returned 0 chunks): treat as failure too.
    if (!firstSeen) {
      lastErr ||= `${candidate} returned no chunks`;
    }
    // Try next tier model — no inline note here, the next iteration's
    // success path emits the "[Auto pilih …]" with a hint that prior
    // candidates failed.
  }
  yield `\n[Auto: semua ${tier.length} kandidat ${provider} gagal. Last: ${lastErr || "(no detail)"}]`;
}

async function* streamOpenAICompat(opts: {
  url: string;
  keys: string[];
  model: string;
  messages: ChatMsg[];
  signal: AbortSignal;
  maxTokens: number;
  extraHeaders?: Record<string, string>;
  // Some providers (Konektika kimi-pro) reject ANY sampling/limit params and
  // return 400. Set this to skip max_tokens entirely from the request body.
  omitMaxTokens?: boolean;
  // Human-readable provider name used in failover logs / user-visible
  // messages ("OpenAI", "Groq", etc.). Falls back to the URL host.
  providerLabel?: string;
}) {
  if (!opts.keys || opts.keys.length === 0) {
    yield `(${opts.providerLabel ?? opts.url} key not configured)`;
    return;
  }
  // OpenAI / OpenRouter / Groq vision uses content arrays:
  //   [{type:"text", text:"…"}, {type:"image_url", image_url:{url:"data:…"}}]
  // Plain string content is also accepted; only switch to the array form when
  // the message actually has images attached.
  const apiMessages = opts.messages.map((m) => {
    if (m.images && m.images.length > 0 && m.role === "user") {
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  const reqBody = JSON.stringify({
    model: opts.model,
    messages: apiMessages,
    stream: true,
    ...(opts.omitMaxTokens ? {} : { max_tokens: opts.maxTokens }),
  });

  // Multi-key failover loop: try each key in order; advance to the next on
  // 401/402/403/429 (the "this key is dead" statuses). On the first OK
  // response we commit to streaming from that key — partial-stream
  // failover would interleave two model responses which is worse than
  // just failing.
  let lastError: { status: number; body: string } | null = null;
  for (let i = 0; i < opts.keys.length; i++) {
    const key = opts.keys[i];
    const res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(opts.extraHeaders || {}),
      },
      body: reqBody,
      signal: opts.signal,
    });
    if (res.ok && res.body) {
      if (i > 0) {
        // Visible to the user only as a tiny inline note so they know
        // failover kicked in — useful when debugging quota issues.
        yield `\n[Key #${i + 1} dipakai (key sebelumnya gagal)]\n`;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const j = JSON.parse(data);
            const txt = j.choices?.[0]?.delta?.content ?? "";
            if (txt) yield txt;
          } catch {}
        }
      }
      return;
    }
    const body = await res.text().catch(() => "");
    lastError = { status: res.status, body: body.slice(0, 300) };
    if (KEY_FAILOVER_STATUSES.has(res.status) && i < opts.keys.length - 1) {
      continue;
    }
    yield `Error: ${res.status} ${body}`;
    return;
  }
  if (lastError) {
    yield `Error: semua ${opts.keys.length} key gagal. Last: ${lastError.status} ${lastError.body}`;
  }
}

async function* streamAnthropic(model: string, messages: ChatMsg[], maxTokens: number, signal: AbortSignal) {
  const keys = getAIKeys("anthropic");
  if (keys.length === 0) { yield "(Anthropic key not configured)"; return; }
  const sys = messages.find((m) => m.role === "system")?.content;
  // Anthropic vision: content is an array of blocks with
  //   {type:"image", source:{type:"base64", media_type:"image/png", data:"…"}}
  // Plain string content is also accepted for text-only messages.
  const msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.images && m.images.length > 0 && m.role === "user") {
        const blocks: any[] = [];
        for (const img of m.images) {
          const parsed = parseDataUrl(img);
          if (!parsed) continue;
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: parsed.mimeType, data: parsed.data },
          });
        }
        if (m.content) blocks.push({ type: "text", text: m.content });
        return { role: m.role, content: blocks };
      }
      return { role: m.role, content: m.content };
    });
  const reqBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    system: sys,
    messages: msgs,
  });
  // Multi-key failover (same pattern as streamOpenAICompat).
  let res: Response | null = null;
  let usedKeyIdx = 0;
  let lastError: { status: number; body: string } | null = null;
  for (let i = 0; i < keys.length; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keys[i],
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      signal,
    });
    if (r.ok && r.body) { res = r; usedKeyIdx = i; break; }
    const body = await r.text().catch(() => "");
    lastError = { status: r.status, body: body.slice(0, 300) };
    if (KEY_FAILOVER_STATUSES.has(r.status) && i < keys.length - 1) continue;
    yield `Error: ${r.status} ${body}`;
    return;
  }
  if (!res || !res.body) {
    yield lastError
      ? `Error: semua ${keys.length} Anthropic key gagal. Last: ${lastError.status} ${lastError.body}`
      : `Error: Anthropic request failed`;
    return;
  }
  if (usedKeyIdx > 0) yield `\n[Anthropic key #${usedKeyIdx + 1} dipakai (key sebelumnya gagal)]\n`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.type === "content_block_delta" && j.delta?.text) yield j.delta.text;
      } catch {}
    }
  }
}

async function* streamGoogle(model: string, messages: ChatMsg[], maxTokens: number, signal: AbortSignal) {
  const keys = getAIKeys("google");
  if (keys.length === 0) { yield "(Google key not configured)"; return; }

  // Multi-key failover wraps the existing model rotation. For each
  // configured key, try the full per-model rotation (or the single
  // requested model). Only QUOTA exhaustion across every model is treated
  // as "this key is dead → try next key" — auth or model-not-found
  // errors are NOT key-related and bail immediately.
  let lastQuotaMsg: string | null = null;
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    if (ki > 0) yield `\n[Google key #${ki + 1} dipakai (quota key sebelumnya habis)]\n`;

    if (model === "auto") {
      // Build the candidate list dynamically: prefer the live model list (so
      // we never try a name that doesn't exist for this account), filtered
      // to free-tier-friendly families. Falls back to our static list.
      const liveList = await fetchGoogleModels().catch(() => [] as string[]);
      const freeFromLive = liveList.filter((n) =>
        /flash-lite|flash$|flash-/.test(n) && !/exp|pro/.test(n)
      );
      const candidates = freeFromLive.length > 0 ? freeFromLive : [...GEMINI_FREE_TIER];
      let lastError: string | null = null;
      let allQuotaThisKey = true;
      let keyDead = false;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        let emitted = false;
        let skipReason: "quota" | "notfound" | "keydead" | null = null;
        const wrapped = streamGoogleSingle(candidate, key, messages, maxTokens, signal);
        for await (const chunk of wrapped) {
          if (chunk.startsWith("__KEYDEAD__")) {
            // Whole key is invalid (401/402/403). No point trying more
            // models on it — break out of the model rotation entirely
            // and let the outer loop jump to the next key.
            skipReason = "keydead";
            keyDead = true;
            lastError = chunk.slice(11);
            break;
          }
          if (chunk.startsWith("__QUOTA__")) { skipReason = "quota"; lastError = chunk.slice(9); break; }
          if (chunk.startsWith("__ERROR__")) {
            lastError = chunk.slice(9);
            if (/^404\b|NOT_FOUND/i.test(lastError ?? "")) skipReason = "notfound";
            break;
          }
          emitted = true;
          yield chunk;
        }
        if (emitted) return;          // success on THIS key — done
        if (!skipReason) {            // non-recoverable error → stop everything
          if (lastError) yield `\n\n[Gemini error: ${lastError}]`;
          return;
        }
        if (skipReason === "keydead") break; // stop model rotation, outer loop tries next key
        if (skipReason === "notfound") allQuotaThisKey = false;
        const reason = skipReason === "quota" ? "Quota habis" : "Model tidak tersedia";
        const next = candidates[i + 1] ?? "(habis semua)";
        yield `\n[${reason} di ${candidate}, coba ${next}…]\n`;
      }
      // All candidates on this key failed (or key was dead from the start).
      if ((keyDead || allQuotaThisKey) && ki < keys.length - 1) {
        lastQuotaMsg = lastError;
        continue; // try next key
      }
      if (keyDead) {
        yield `\n\n[Google key #${ki + 1} ditolak (auth/quota habis): ${lastError ?? ""}]`;
      } else {
        yield `\n\n[Semua kandidat Gemini free-tier gagal pada key #${ki + 1}. Coba lagi nanti atau pilih model spesifik.]`;
      }
      return;
    }
    // Single-model mode: strip internal markers; on quota OR keydead → try
    // next key, on other errors → bail.
    let emittedSingle = false;
    let advanceKey = false;
    let lastErr: string | null = null;
    for await (const chunk of streamGoogleSingle(model, key, messages, maxTokens, signal)) {
      if (chunk.startsWith("__KEYDEAD__")) {
        advanceKey = true;
        lastErr = chunk.slice(11);
        lastQuotaMsg = lastErr;
        break;
      }
      if (chunk.startsWith("__QUOTA__")) {
        advanceKey = true;
        lastErr = chunk.slice(9);
        lastQuotaMsg = lastErr;
        break;
      }
      if (chunk.startsWith("__ERROR__")) {
        yield `\n[Gemini error: ${chunk.slice(9)}]`;
        return;
      }
      emittedSingle = true;
      yield chunk;
    }
    if (emittedSingle) return;
    if (advanceKey && ki < keys.length - 1) continue;
    yield `\n[Model "${model}" kena quota / rate-limit / key invalid (key #${ki + 1}). Tambah API key di admin atau pilih model lain.${lastErr ? " Detail: " + lastErr : ""}]`;
    return;
  }
  if (lastQuotaMsg) {
    yield `\n[Semua ${keys.length} Google key habis quota / invalid. Last: ${lastQuotaMsg}]`;
  }
}

async function* streamGoogleSingle(model: string, key: string, messages: ChatMsg[], maxTokens: number, signal: AbortSignal) {
  const sys = messages.find((m) => m.role === "system")?.content;
  // Gemini uses `parts: [{text}, {inlineData:{mimeType,data}}]`. Attach
  // image parts AFTER the text — matches Google's docs and behaves better
  // when the user asks "what's in this screenshot?" with no extra prose.
  const contents = messages.filter((m) => m.role !== "system").map((m) => {
    const parts: any[] = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images && m.role === "user") {
      for (const img of m.images) {
        const parsed = parseDataUrl(img);
        if (!parsed) continue;
        parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts,
    };
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal,
    }
  );
  if (!res.ok || !res.body) {
    const txt = (await res.text().catch(() => "")).slice(0, 300);
    // Three failure classes the outer streamGoogle distinguishes:
    //   __KEYDEAD__  — 401/402/403: this API key is invalid/banned/out of
    //                  balance; trying other MODELS on it will all fail
    //                  the same way → outer loop should jump straight to
    //                  the next key.
    //   __QUOTA__    — 429 / quota text: rate-limit on this MODEL only;
    //                  other models on the same key may still work, so
    //                  outer loop rotates models first, then keys.
    //   __ERROR__    — anything else (5xx, 400, 404): not a key issue,
    //                  bail to the user.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      yield `__KEYDEAD__${res.status} ${txt}`;
    } else if (res.status === 429 || /quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded/i.test(txt)) {
      yield `__QUOTA__${res.status} ${txt}`;
    } else {
      yield `__ERROR__${res.status} ${txt}`;
    }
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Surface Gemini-specific failure modes (safety blocks, no candidates, etc.)
  // that otherwise yield zero text and look like a silent hang to the user.
  let emittedAnyText = false;
  let lastFinishReason: string | null = null;
  let lastBlockReason: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        const cand = j.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === "string" && p.text.length > 0) {
              emittedAnyText = true;
              yield p.text;
            }
          }
        }
        if (typeof cand?.finishReason === "string") lastFinishReason = cand.finishReason;
        if (typeof j?.promptFeedback?.blockReason === "string") {
          lastBlockReason = j.promptFeedback.blockReason;
        }
      } catch {}
    }
  }
  if (!emittedAnyText) {
    if (lastBlockReason) {
      yield `\n\n[Gemini blocked the prompt: ${lastBlockReason}. Try rephrasing or removing the image.]`;
    } else if (lastFinishReason && lastFinishReason !== "STOP") {
      yield `\n\n[Gemini returned no text (finishReason=${lastFinishReason}). Try a different model or shorter prompt.]`;
    } else {
      yield `\n\n[Gemini returned an empty response. Check the API key, the model name, and that your account has access to it.]`;
    }
  }
}
