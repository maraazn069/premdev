import fs from "node:fs";
import path from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__",
  "target", "dist", "build", ".next", ".replit-cache", ".idea",
]);

export type ListingEntry = string;

/**
 * Walk a workspace directory (depth-limited, entry-capped) and return the
 * relative paths in dirs-first sorted order. Skips dotfiles and well-known
 * heavy build/dependency dirs. Never follows symlinks.
 */
export function listWorkspace(root: string, maxEntries = 80, maxDepth = 4): ListingEntry[] {
  const lines: string[] = [];
  if (!fs.existsSync(root)) return lines;
  function walk(dir: string, rel: string, depth: number) {
    if (lines.length >= maxEntries || depth > maxDepth) return;
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
        if (lines.length >= maxEntries) return;
        if (e.isSymbolicLink()) return;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          lines.push(`${childRel}/`);
          walk(path.join(dir, e.name), childRel, depth + 1);
        } else if (e.isFile()) {
          lines.push(childRel);
        }
      });
  }
  walk(root, "", 0);
  return lines;
}

/**
 * Heuristically pick a run command for an unknown project. Returns null when
 * we can't confidently guess. The caller should pass the result through to
 * a shell that has $PORT in env (startLocal/startContainer set PORT).
 */
export function detectRunCommand(root: string): string | null {
  const lines = listWorkspace(root);
  const has = (name: string) => lines.some((l) => l === name);
  const hasAny = (re: RegExp) => lines.some((l) => re.test(l));

  // Node.js — read package.json scripts to be smart.
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.dev) return "npm install --silent && npm run dev";
      if (scripts.start) return "npm install --silent && npm start";
      if (pkg.main) return `npm install --silent && node ${pkg.main}`;
    } catch {}
    return "npm install --silent && node index.js";
  }

  // PHP — built-in dev server. Pick the best document root so `/` actually
  // resolves to an index file. Order: project root → common public dirs →
  // first subdir that has an index.php. We deliberately do NOT auto-pass
  // router.php because many projects ship a file named router.php that isn't
  // actually a PHP-S compatible front controller (it would 404 every request).
  // Users who need a router can set it explicitly in .premdev.
  if (hasAny(/\.php$/)) {
    const docRoot = pickWebDocRoot(root, "index.php") ?? ".";
    return `php -S 0.0.0.0:$PORT -t ${docRoot}`;
  }

  // Python — common entry files.
  if (has("requirements.txt") || hasAny(/\.py$/)) {
    let entry: string | null = null;
    for (const cand of ["app.py", "main.py", "server.py", "run.py", "manage.py"]) {
      if (has(cand)) { entry = cand; break; }
    }
    if (!entry) return null;
    const install = has("requirements.txt") ? "pip install -q -r requirements.txt && " : "";
    return `${install}python3 ${entry}`;
  }

  if (has("Gemfile")) {
    return "bundle install --quiet && bundle exec rackup -o 0.0.0.0 -p $PORT";
  }
  if (has("go.mod")) return "go run .";
  if (has("Cargo.toml")) return "cargo run";

  // Static site — only when it's clearly the only thing. Pick the doc root
  // that actually contains index.html (root, public/, web/, dist/, etc.).
  if (hasAny(/index\.html?$/)) {
    const docRoot = pickWebDocRoot(root, "index.html") ?? ".";
    return `python3 -m http.server $PORT --bind 0.0.0.0 --directory ${docRoot}`;
  }

  return null;
}

/**
 * Pick the best document root (relative to `root`) that contains `indexFile`.
 * Order: project root → common conventional public dirs → first immediate
 * subdirectory that has the index file. Symlink-safe: rejects symlinked
 * directories and symlinked index files so the dev server can't be tricked
 * into serving files outside the workspace tree. Returns null when none.
 */
function pickWebDocRoot(root: string, indexFile: string): string | null {
  const isRealDir = (abs: string) => {
    try {
      return fs.lstatSync(abs).isDirectory();
    } catch { return false; }
  };
  const indexIsRealFile = (dirAbs: string) => {
    try {
      return fs.lstatSync(path.join(dirAbs, indexFile)).isFile();
    } catch { return false; }
  };
  if (indexIsRealFile(root)) return ".";
  for (const cand of ["public", "web", "htdocs", "www", "dist", "build"]) {
    const abs = path.join(root, cand);
    if (isRealDir(abs) && indexIsRealFile(abs)) return cand;
  }
  // Fallback: first immediate REAL (non-symlinked) subdirectory containing
  // a real (non-symlinked) index file.
  try {
    const items = fs.readdirSync(root, { withFileTypes: true });
    for (const e of items) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      const abs = path.join(root, e.name);
      if (indexIsRealFile(abs)) return e.name;
    }
  } catch {}
  return null;
}
