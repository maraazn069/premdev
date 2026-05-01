import type { FastifyRequest, FastifyReply } from "fastify";
import { db, DbUser } from "./db.js";

export type SessionUser = { id: string; username: string; role: "admin" | "user" };

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> {
  try {
    await req.jwtVerify();
    const payload = req.user as any;
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub) as DbUser | undefined;
    if (!u) {
      reply.code(401).send({ error: "Unauthorized" });
      return null;
    }
    return { id: u.id, username: u.username, role: u.role };
  } catch {
    reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const u = await requireUser(req, reply);
  if (!u) return null;
  if (u.role !== "admin") {
    reply.code(403).send({ error: "Forbidden" });
    return null;
  }
  return u;
}
