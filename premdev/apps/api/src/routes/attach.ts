import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import { db, DbWorkspace } from "../lib/db.js";
import { requireUser } from "../lib/auth-helpers.js";
import { workspacePath } from "../lib/runtime.js";

// Mounted at `/api/workspaces` so the public path is
//   POST /api/workspaces/:id/attach
// — kept OUT of `/files/...` to avoid colliding with user apps that already
// expose `/files` (Next.js, Strapi, Wordpress style routes etc.) when running
// behind the same reverse proxy.
function safePath(workspaceDir: string, rel: string): string {
  const root = path.resolve(workspaceDir);
  const abs = path.resolve(root, rel.replace(/^\/+/, ""));
  const relCheck = path.relative(root, abs);
  if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
    throw new Error("Path traversal");
  }
  return abs;
}

// Hard caps as a defense-in-depth against a runaway client. Real flow is:
// FE downscales / re-encodes images before upload; text is sent raw because
// gzip+base64 is not meaningfully smaller for short messages, and we WANT
// the on-disk file to be a plain readable .txt.
//
// Text limit deliberately huge so users can attach 50MB+ logs without
// hitting an error — the AI sees only a 1-line reference, not the full text.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // 12 MB decoded
const MAX_TEXT_BYTES = 100 * 1024 * 1024;   // 100 MB raw

const Attach = z.union([
  z.object({
    kind: z.literal("image"),
    filename: z.string().min(1).max(120),
    // Either raw base64 OR gzip-then-base64 of the image bytes.
    dataBase64: z.string().min(1),
    gzipped: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("text"),
    filename: z.string().min(1).max(120).optional(),
    text: z.string().optional(),
    // Optional gzip+base64 transport for very long text. When set, `text`
    // is ignored and `dataBase64` is decoded+inflated to UTF-8.
    dataBase64: z.string().optional(),
    gzipped: z.boolean().optional(),
  }),
]);

export const attachRoutes: FastifyPluginAsync = async (app) => {
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

  app.post("/:id/attach", async (req, reply) => {
    const w = await getWorkspace(req, reply);
    if (!w) return;
    const body = Attach.parse(req.body);
    const root = workspacePath(w.id);
    const dir = path.join(root, "attached_assets");
    fs.mkdirSync(dir, { recursive: true });

    const ts = Date.now();
    let baseName: string;
    let ext: string;
    if (body.kind === "image") {
      const dot = body.filename.lastIndexOf(".");
      const stem = (dot > 0 ? body.filename.slice(0, dot) : body.filename)
        .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "image";
      const rawExt = (dot > 0 ? body.filename.slice(dot + 1) : "png")
        .toLowerCase().replace(/[^a-z0-9]/g, "");
      ext = ["png", "jpg", "jpeg", "webp", "gif"].includes(rawExt) ? rawExt : "png";
      baseName = stem;
    } else {
      const stem = (body.filename ?? "paste")
        .replace(/\.[^.]*$/, "")
        .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "paste";
      baseName = stem;
      ext = "txt";
    }
    const finalName = `${baseName}-${ts}.${ext}`;
    const rel = `attached_assets/${finalName}`;
    const abs = safePath(root, rel); // belt-and-suspenders re-check

    if (body.kind === "image") {
      let buf = Buffer.from(body.dataBase64, "base64");
      if (body.gzipped) {
        try { buf = zlib.gunzipSync(buf); }
        catch { return reply.code(400).send({ error: "Bad gzip payload" }); }
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        return reply.code(413).send({
          error: `Image too large (${(buf.length / 1024 / 1024).toFixed(1)} MB > 12 MB max)`,
        });
      }
      fs.writeFileSync(abs, buf);
    } else {
      let text: string;
      if (body.dataBase64 && body.gzipped) {
        try {
          const inflated = zlib.gunzipSync(Buffer.from(body.dataBase64, "base64"));
          text = inflated.toString("utf8");
        } catch {
          return reply.code(400).send({ error: "Bad gzip payload" });
        }
      } else if (typeof body.text === "string") {
        text = body.text;
      } else {
        return reply.code(400).send({ error: "Provide `text` or `dataBase64`+`gzipped:true`" });
      }
      if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
        return reply.code(413).send({ error: "Text too large (max 100 MB)" });
      }
      fs.writeFileSync(abs, text, "utf8");
    }

    return { ok: true, path: rel, size: fs.statSync(abs).size };
  });
};
