/**
 * vfs.ts — VPS Filesystem Browser routes.
 *
 * Mounts the host filesystem (via Docker volume /:/vpsroot:rw) and exposes
 * admin-only REST endpoints for listing, reading, writing, creating, and
 * deleting files anywhere on the VPS.
 *
 * SETUP (one-time, via SSH):
 *   Edit /opt/premdev/docker-compose.yml → service `app` → volumes:
 *     - /:/vpsroot:rw
 *   Then: sudo docker compose up -d app
 *
 * All paths shown to the client are stripped of the VFS_ROOT prefix so
 * they look like real VPS paths (/etc, /opt, …), not /vpsroot/etc.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "../lib/auth-helpers.js";
import { config } from "../lib/config.js";

const VFS_ROOT = config.VFS_ROOT; // default /vpsroot
const MAX_READ_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a client-supplied path into a safe absolute path inside VFS_ROOT.
 * Throws if the resolved path escapes VFS_ROOT (anti path-traversal).
 * Strips a leading slash from userPath so path.join works correctly.
 */
function safePath(userPath: string): string {
  const stripped = userPath.replace(/^\/+/, "");
  const resolved = path.resolve(VFS_ROOT, stripped);
  if (!resolved.startsWith(VFS_ROOT)) {
    throw new Error(`Path escapes VFS root: ${userPath}`);
  }
  return resolved;
}

/** Convert an absolute container path back to the VPS-visible path. */
function toVpsPath(absPath: string): string {
  const rel = path.relative(VFS_ROOT, absPath);
  return "/" + rel.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Route plugin (admin-only)
// ---------------------------------------------------------------------------

export const vfsRoutes: FastifyPluginAsync = async (app) => {
  // Guard: if the VFS mount doesn't exist, all endpoints return a clear error.
  function checkMount(reply: any): boolean {
    if (!fs.existsSync(VFS_ROOT)) {
      reply.code(503).send({
        error:
          "VPS filesystem belum di-mount. " +
          "Tambahkan volume `- /:/vpsroot:rw` ke service `app` di docker-compose.yml, " +
          "lalu restart container: sudo docker compose up -d app",
      });
      return false;
    }
    return true;
  }

  // GET /vfs/list?path=/etc
  // List directory contents. Returns arrays of files and dirs.
  app.get("/list", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!checkMount(reply)) return;

    const q = z.object({ path: z.string().min(1) }).parse(req.query);
    let abs: string;
    try { abs = safePath(q.path); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch {
      return reply.code(404).send({ error: `Path tidak ditemukan: ${q.path}` });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: "Path bukan directory" });
    }

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e: any) {
      return reply.code(500).send({ error: `Tidak bisa baca directory: ${e.message}` });
    }

    const items = entries.map((e) => {
      const childAbs = path.join(abs, e.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = fs.lstatSync(childAbs);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {}
      return {
        name: e.name,
        path: toVpsPath(childAbs),
        type: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file",
        size,
        mtime,
      };
    });

    items.sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === "dir") return -1;
        if (b.type === "dir") return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return reply.send({ path: q.path, items });
  });

  // GET /vfs/read?path=/etc/hostname
  // Read a text file (max 5 MB). Returns { content, size, binary }.
  app.get("/read", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!checkMount(reply)) return;

    const q = z.object({ path: z.string().min(1) }).parse(req.query);
    let abs: string;
    try { abs = safePath(q.path); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch {
      return reply.code(404).send({ error: `File tidak ditemukan: ${q.path}` });
    }
    if (!stat.isFile()) {
      return reply.code(400).send({ error: "Path bukan file" });
    }
    if (stat.size > MAX_READ_BYTES) {
      return reply.send({
        path: q.path,
        size: stat.size,
        binary: false,
        content: null,
        error: `File terlalu besar (${(stat.size / 1024 / 1024).toFixed(1)} MB > 5 MB). Gunakan SSH untuk membaca file ini.`,
      });
    }

    // Detect binary by reading the first 8 KB and checking for null bytes.
    let buf: Buffer;
    try { buf = fs.readFileSync(abs); } catch (e: any) {
      return reply.code(500).send({ error: `Tidak bisa baca file: ${e.message}` });
    }
    const probe = buf.subarray(0, 8192);
    const isBinary = probe.includes(0);
    if (isBinary) {
      return reply.send({ path: q.path, size: stat.size, binary: true, content: null });
    }
    return reply.send({
      path: q.path,
      size: stat.size,
      binary: false,
      content: buf.toString("utf8"),
    });
  });

  // POST /vfs/write  body: { path, content }
  // Write (overwrite) a text file.
  app.post("/write", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!checkMount(reply)) return;

    const body = z
      .object({ path: z.string().min(1), content: z.string() })
      .parse(req.body);
    let abs: string;
    try { abs = safePath(body.path); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body.content, "utf8");
    } catch (e: any) {
      return reply.code(500).send({ error: `Gagal menulis file: ${e.message}` });
    }

    return reply.send({ ok: true, path: body.path });
  });

  // POST /vfs/mkdir  body: { path }
  // Create a directory (and parents).
  app.post("/mkdir", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!checkMount(reply)) return;

    const body = z.object({ path: z.string().min(1) }).parse(req.body);
    let abs: string;
    try { abs = safePath(body.path); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e: any) {
      return reply.code(500).send({ error: `Gagal membuat directory: ${e.message}` });
    }

    return reply.send({ ok: true, path: body.path });
  });

  // DELETE /vfs/delete?path=…
  // Delete a file or directory (recursive).
  app.delete("/delete", async (req, reply) => {
    const u = await requireAdmin(req, reply);
    if (!u) return;
    if (!checkMount(reply)) return;

    const q = z.object({ path: z.string().min(1) }).parse(req.query);
    let abs: string;
    try { abs = safePath(q.path); } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    // Refuse to delete the root itself.
    if (abs === VFS_ROOT || abs === VFS_ROOT + "/") {
      return reply.code(400).send({ error: "Tidak bisa hapus root VPS" });
    }

    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch (e: any) {
      return reply.code(500).send({ error: `Gagal menghapus: ${e.message}` });
    }

    return reply.send({ ok: true, path: q.path });
  });
};
