// Per-workspace semantic code search backed by SQLite.
//
// One database per workspace lives at:
//   <workspace_root>/.premdev/embeddings.db
//
// Why per-workspace and not a global DB?
//   - Privacy: a workspace's embeddings live alongside its files, so when
//     the workspace is deleted the embeddings vanish with it.
//   - Locality: index work happens on the same disk as the source files.
//   - No cross-workspace cardinality blow-up — each DB is small.
//
// Schema:
//   chunks(
//     id        INTEGER PRIMARY KEY,
//     path      TEXT NOT NULL,    -- workspace-relative file path
//     chunk_idx INTEGER NOT NULL, -- 0-based chunk index within the file
//     start_line INTEGER NOT NULL,
//     end_line   INTEGER NOT NULL,
//     content   TEXT NOT NULL,    -- raw text of the chunk
//     vec       BLOB NOT NULL,    -- 384 × float32 = 1536 bytes
//     mtime_ms  INTEGER NOT NULL, -- file mtime when this chunk was indexed
//     UNIQUE(path, chunk_idx)
//   )
//
// Search is plain in-memory cosine similarity — we load all rows for the
// workspace and rank them. This is FINE for typical projects (a few thousand
// chunks). If a workspace ever exceeds ~50k chunks, we'd switch to
// sqlite-vec or a HNSW index, but we don't need to pay that complexity tax
// today.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { embed, embedBatch, cosineSim, EMBEDDING_DIM } from "./embeddings.js";
import { workspacePath } from "./runtime.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Indexable file detection
// ---------------------------------------------------------------------------

// Whitelist of extensions worth indexing. Anything else (binaries, images,
// archives, lock files, etc.) is skipped to keep the index small and useful.
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".scala", ".cs", ".swift",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  ".md", ".mdx", ".txt", ".rst",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env",
  ".sql", ".graphql", ".gql", ".proto",
  ".sh", ".bash", ".zsh", ".fish",
  ".dockerfile", ".containerfile",
  ".tf", ".hcl",
  ".c", ".h", ".cc", ".cpp", ".hpp",
]);

// Directories never worth indexing — generated, vendor, or VCS metadata.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea", ".vscode",
  ".premdev", "vendor", "bower_components", "coverage", ".nuxt", ".output",
  ".turbo", ".parcel-cache",
]);

// Hard upper bound on file size we'll bother reading. Files larger than this
// are almost always generated (bundles, source maps, fixtures) and would
// waste tokens.
const MAX_FILE_BYTES = 200 * 1024;

// Chunk parameters. ~30 lines per chunk fits comfortably under the model's
// 512-token window for most languages. 5-line overlap means a function that
// straddles a chunk boundary is still findable.
const CHUNK_LINES = 30;
const CHUNK_OVERLAP = 5;

// Ceiling on how many files we'll embed in one indexWorkspace() pass to
// keep the first-chat latency bounded. Subsequent passes pick up where this
// one left off (only changed files anyway).
const MAX_FILES_PER_PASS = 500;

function isTextExt(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) {
    // No extension: try common dotless filenames worth indexing.
    const base = path.basename(filename).toLowerCase();
    return base === "dockerfile" || base === "makefile" || base === "rakefile" || base === "gemfile" || base === "procfile";
  }
  return TEXT_EXTS.has(filename.slice(dot).toLowerCase());
}

function looksBinary(buf: Buffer): boolean {
  // NUL byte in the first 8 KB is a strong "binary" signal.
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-workspace DB lifecycle
// ---------------------------------------------------------------------------

const dbCache = new Map<string, Database.Database>();

function dbPath(workspaceId: string): string {
  // Simpan di DATA_DIR/embeddings/<workspaceId>/ — BUKAN di dalam workspace root
  // karena .premdev sudah ada sebagai FILE config JSON, bukan direktori.
  return path.join(config.DATA_DIR, "embeddings", workspaceId, "embeddings.db");
}

function openDb(workspaceId: string): Database.Database {
  const cached = dbCache.get(workspaceId);
  if (cached) return cached;

  const file = dbPath(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      vec BLOB NOT NULL,
      mtime_ms INTEGER NOT NULL,
      UNIQUE(path, chunk_idx)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  dbCache.set(workspaceId, db);
  return db;
}

/** Close + drop the cached handle. Used after destructive ops like deleteWorkspace. */
export function closeWorkspaceDb(workspaceId: string) {
  const d = dbCache.get(workspaceId);
  if (d) {
    try { d.close(); } catch {}
    dbCache.delete(workspaceId);
  }
}

// ---------------------------------------------------------------------------
// Float32 ↔ Buffer codec for storing vectors as BLOBs
// ---------------------------------------------------------------------------

function vecToBuf(v: Float32Array): Buffer {
  // Copy to ensure we get exactly EMBEDDING_DIM*4 bytes regardless of
  // whether `v` is a subarray view of a larger buffer.
  const b = Buffer.alloc(EMBEDDING_DIM * 4);
  const view = new Float32Array(b.buffer, b.byteOffset, EMBEDDING_DIM);
  view.set(v.subarray(0, EMBEDDING_DIM));
  return b;
}

function bufToVec(b: Buffer): Float32Array {
  // Buffer.from() so we own a copy; the .buffer underlying a sqlite BLOB
  // can be reused across rows otherwise.
  const copy = Buffer.from(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

interface IndexableFile {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

function walkWorkspace(root: string): IndexableFile[] {
  const out: IndexableFile[] = [];
  function walk(dir: string, rel: string) {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of items) {
      if (SKIP_DIRS.has(e.name)) continue;
      // Allow dotfiles whose extensions are still indexable (e.g. .env).
      if (e.name.startsWith(".") && !isTextExt(e.name)) continue;
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue; // never follow — could escape workspace
      if (e.isDirectory()) { walk(child, childRel); continue; }
      if (!e.isFile()) continue;
      if (!isTextExt(e.name)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(child); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      if (stat.size === 0) continue;
      out.push({ relPath: childRel, absPath: child, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
    }
  }
  walk(root, "");
  return out;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

interface Chunk { idx: number; startLine: number; endLine: number; content: string; }

function chunkFile(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let i = 0;
  let idx = 0;
  while (i < lines.length) {
    const end = Math.min(i + CHUNK_LINES, lines.length);
    const slice = lines.slice(i, end);
    const text = slice.join("\n").trim();
    if (text.length > 0) {
      chunks.push({ idx, startLine: i + 1, endLine: end, content: slice.join("\n") });
      idx++;
    }
    if (end >= lines.length) break;
    i = end - CHUNK_OVERLAP;
    if (i <= chunks[chunks.length - 1]?.startLine) i = end; // safety against overlap > step
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bring a workspace's index up to date with its filesystem.
 *
 * - Files whose mtime matches the indexed mtime are skipped entirely.
 * - Files whose mtime changed have all their old chunks dropped and re-embedded.
 * - Files that no longer exist on disk have their chunks dropped.
 *
 * Returns a summary suitable for logging or admin UI.
 */
// In-flight indexing guard: dedupes concurrent indexWorkspace() calls for
// the same workspace. Without this, the chat handler's lazy "kick off
// reindex if no hits" path could fire repeated full scans when a workspace
// is empty, indexing is disabled, or the model is still downloading.
const indexingInFlight = new Map<string, Promise<IndexResult>>();

interface IndexResult {
  scanned: number;
  indexed: number;
  reused: number;
  removed: number;
  chunks: number;
  durationMs: number;
}

export async function indexWorkspace(workspaceId: string): Promise<IndexResult> {
  const existing = indexingInFlight.get(workspaceId);
  if (existing) return existing;
  const p = indexWorkspaceInner(workspaceId).finally(() => {
    indexingInFlight.delete(workspaceId);
  });
  indexingInFlight.set(workspaceId, p);
  return p;
}

async function indexWorkspaceInner(workspaceId: string): Promise<IndexResult> {
  const start = Date.now();
  const root = workspacePath(workspaceId);
  if (!fs.existsSync(root)) {
    return { scanned: 0, indexed: 0, reused: 0, removed: 0, chunks: 0, durationMs: 0 };
  }
  const db = openDb(workspaceId);
  const files = walkWorkspace(root);

  // Map<path, mtime_ms> of what's currently indexed, so we can decide skip
  // vs re-embed without re-reading file contents.
  const existing = new Map<string, number>();
  const allChunkRows = db.prepare("SELECT DISTINCT path, mtime_ms FROM chunks").all() as Array<{ path: string; mtime_ms: number }>;
  for (const r of allChunkRows) existing.set(r.path, r.mtime_ms);

  const onDiskPaths = new Set(files.map((f) => f.relPath));

  // 1) Drop chunks for files that disappeared.
  let removed = 0;
  const deleteStmt = db.prepare("DELETE FROM chunks WHERE path = ?");
  for (const indexedPath of existing.keys()) {
    if (!onDiskPaths.has(indexedPath)) {
      const r = deleteStmt.run(indexedPath);
      removed += r.changes;
    }
  }

  // 2) Decide which files need (re-)indexing.
  const stale: IndexableFile[] = [];
  let reused = 0;
  for (const f of files) {
    const known = existing.get(f.relPath);
    if (known === f.mtimeMs) { reused++; continue; }
    stale.push(f);
  }

  // Cap how much work one pass does so the first chat doesn't hang.
  const todo = stale.slice(0, MAX_FILES_PER_PASS);

  // 3) Read + chunk + embed + insert.
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO chunks (path, chunk_idx, start_line, end_line, content, vec, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  let totalChunks = 0;
  let indexed = 0;
  // Process files one-at-a-time but embed their chunks in batches per file
  // — keeps peak memory low and lets us commit incrementally.
  for (const f of todo) {
    let buf: Buffer;
    try { buf = fs.readFileSync(f.absPath); } catch { continue; }
    if (looksBinary(buf)) continue;
    const text = buf.toString("utf8");
    const chunks = chunkFile(text);
    if (chunks.length === 0) continue;

    let vectors: Float32Array[];
    try {
      vectors = await embedBatch(chunks.map((c) => c.content));
    } catch (e: any) {
      // If the model fails (e.g. download failed, OOM), abort the whole
      // pass — partial state is fine, we'll retry next time.
      throw new Error(`embed failed for ${f.relPath}: ${e?.message || e}`);
    }

    const tx = db.transaction(() => {
      // Replace any old chunks for this file outright.
      deleteStmt.run(f.relPath);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        insertStmt.run(f.relPath, c.idx, c.startLine, c.endLine, c.content, vecToBuf(vectors[i]), f.mtimeMs);
      }
    });
    tx();
    totalChunks += chunks.length;
    indexed++;
  }

  // Persist last-indexed timestamp for the admin UI.
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run("last_indexed_ms", String(Date.now()));

  return {
    scanned: files.length,
    indexed,
    reused,
    removed,
    chunks: totalChunks,
    durationMs: Date.now() - start,
  };
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/**
 * Top-K semantic hits for a query in a workspace. Returns [] if the index
 * is empty (caller should kick off indexWorkspace() and try again next turn).
 */
export async function search(workspaceId: string, query: string, k = 5): Promise<SearchHit[]> {
  const root = workspacePath(workspaceId);
  if (!fs.existsSync(root)) return [];
  const db = openDb(workspaceId);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  if (count === 0) return [];

  const qVec = await embed(query);

  // Plain in-memory scan. For a few thousand chunks this is sub-millisecond.
  const rows = db.prepare("SELECT path, start_line, end_line, content, vec FROM chunks").all() as Array<{
    path: string; start_line: number; end_line: number; content: string; vec: Buffer;
  }>;

  const scored: SearchHit[] = rows.map((r) => ({
    path: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    score: cosineSim(qVec, bufToVec(r.vec)),
  }));

  scored.sort((a, b) => b.score - a.score);
  // Deduplicate: at most 1 hit per file in the top-K, so the snippet
  // budget isn't burned on overlapping chunks of the same file.
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of scored) {
    if (out.length >= k) break;
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    out.push(hit);
  }
  return out;
}

/** Cheap stats for admin UI. Does NOT trigger model load. */
export function workspaceIndexStats(workspaceId: string): {
  exists: boolean;
  chunks: number;
  files: number;
  lastIndexedMs: number | null;
  dbBytes: number;
} {
  const file = dbPath(workspaceId);
  if (!fs.existsSync(file)) {
    return { exists: false, chunks: 0, files: 0, lastIndexedMs: null, dbBytes: 0 };
  }
  let dbBytes = 0;
  try { dbBytes = fs.statSync(file).size; } catch {}
  const db = openDb(workspaceId);
  const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  const files = (db.prepare("SELECT COUNT(DISTINCT path) AS n FROM chunks").get() as { n: number }).n;
  const lastRow = db.prepare("SELECT value FROM meta WHERE key = 'last_indexed_ms'").get() as { value?: string } | undefined;
  const lastIndexedMs = lastRow?.value ? parseInt(lastRow.value, 10) : null;
  return { exists: true, chunks, files, lastIndexedMs, dbBytes };
}

/** Remove the entire index for a workspace (used by `Reset` button). */
export function clearWorkspaceIndex(workspaceId: string) {
  closeWorkspaceDb(workspaceId);
  const file = dbPath(workspaceId);
  try { fs.unlinkSync(file); } catch {}
  // WAL/SHM siblings.
  try { fs.unlinkSync(file + "-wal"); } catch {}
  try { fs.unlinkSync(file + "-shm"); } catch {}
}
