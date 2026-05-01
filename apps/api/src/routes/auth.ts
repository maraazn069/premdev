import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db, DbUser, userToPublic, writeAudit } from "../lib/db.js";
import { config } from "../lib/config.js";
import { requireUser } from "../lib/auth-helpers.js";
import { loginLimiter, clientIp } from "../lib/rate-limit.js";
import { notifyAdmin } from "../lib/telegram.js";

// Brute-force lockout: ≥ FAIL_THRESHOLD *credential* failures from the
// same IP within FAIL_WINDOW_MS blocks further attempts for LOCKOUT_MS.
//
// Crucially we DO NOT count `locked-out` / `rate-limited` rows toward the
// fail threshold: otherwise an attacker who keeps hammering during the
// lockout would self-extend it forever, and a legitimate user behind the
// same NAT could never recover. Only real bad-credential failures count.
const FAIL_THRESHOLD = 5;
const FAIL_WINDOW_MS = 15 * 60_000;       // 15 min sliding window
const LOCKOUT_MS = 30 * 60_000;           // ban duration after threshold crossed
const ALERT_THRESHOLD = 10;               // notify Telegram once IP hits this
const recentAlertedIPs = new Set<string>(); // dedupe alerts in-process

function realFailCount(ip: string, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT COUNT(*) as c FROM login_attempts
       WHERE ip = ? AND ok = 0 AND created_at > ?
         AND (reason IS NULL OR reason = 'invalid-credentials')`,
    )
    .get(ip, cutoff) as { c: number };
  return row.c;
}

function isLockedOut(ip: string): boolean {
  // Locked iff there were ≥ THRESHOLD real failures inside the LOCKOUT
  // window. Once the window slides past, the IP recovers automatically.
  // (Lockout window > fail window means hitting the threshold late in the
  // 15-min window still gives ~30 min of cool-off.)
  return realFailCount(ip, LOCKOUT_MS) >= FAIL_THRESHOLD;
}

function recordAttempt(ip: string, username: string | null, ok: boolean, reason: string | null, ua: string | null) {
  try {
    db.prepare(
      "INSERT INTO login_attempts (ip, username, ok, reason, ua, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ip, username, ok ? 1 : 0, reason, ua?.slice(0, 200) ?? null, Date.now());
  } catch {}
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  const Login = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    // Optional "remember me". When true (or omitted, for backward compat
    // with old clients that always wanted persistence), set a 30-day
    // persistent cookie. When false, omit maxAge so the cookie is a
    // session cookie that the browser drops when the user closes it.
    remember: z.boolean().optional().default(true),
  });

  app.post("/login", async (req, reply) => {
    const ip = clientIp(req);
    const ua = (req.headers["user-agent"] as string) || null;

    // Per-IP rate limit (short bursts) AND brute-force lockout (sustained).
    if (!loginLimiter.take(`login:${ip}`)) {
      recordAttempt(ip, null, false, "rate-limited", ua);
      return reply.code(429).send({ error: "Too many requests. Please slow down." });
    }
    if (isLockedOut(ip)) {
      recordAttempt(ip, null, false, "locked-out", ua);
      return reply.code(429).send({
        error: "Too many failed attempts. Try again in 30 minutes.",
      });
    }

    const body = Login.parse(req.body);
    const u = db
      .prepare("SELECT * FROM users WHERE username = ? OR email = ?")
      .get(body.username, body.username) as DbUser | undefined;

    if (!u || !bcrypt.compareSync(body.password, u.password_hash)) {
      recordAttempt(ip, body.username, false, "invalid-credentials", ua);
      const fails = realFailCount(ip, FAIL_WINDOW_MS);
      // Telegram alert once per IP per process when brute-force pattern
      // crosses threshold (avoid spam if attacker keeps hammering).
      if (fails >= ALERT_THRESHOLD && !recentAlertedIPs.has(ip)) {
        recentAlertedIPs.add(ip);
        notifyAdmin(
          `*Brute-force suspected*\nIP: \`${ip}\`\nFails (15m): *${fails}*\nLast username: \`${body.username}\``,
          "warn",
        );
        // Auto-clear alert dedupe after the lockout window so a re-attempt
        // from the same IP days later still notifies.
        setTimeout(() => recentAlertedIPs.delete(ip), LOCKOUT_MS).unref?.();
      }
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    // Successful login → reset rate limit, log success, audit.
    loginLimiter.reset(`login:${ip}`);
    recordAttempt(ip, u.username, true, null, ua);
    writeAudit({
      actorId: u.id,
      actorUsername: u.username,
      ip,
      action: "login",
      meta: { ua: ua?.slice(0, 200) },
    });

    const token = app.jwt.sign({ sub: u.id, username: u.username, role: u.role });
    reply.setCookie("token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.SECURE_COOKIES,
      domain: config.COOKIE_DOMAIN || undefined,
      path: "/",
      // Persistent (30 days) when "remember me" is checked; otherwise omit
      // maxAge so the cookie disappears when the browser session ends.
      ...(body.remember ? { maxAge: 60 * 60 * 24 * 30 } : {}),
    });
    return { user: userToPublic(u) };
  });

  app.post("/logout", async (req, reply) => {
    const session = await (async () => {
      try { return await req.jwtVerify<{ sub: string; username: string }>(); }
      catch { return null; }
    })();
    if (session) {
      writeAudit({
        actorId: session.sub,
        actorUsername: session.username,
        ip: clientIp(req),
        action: "logout",
      });
    }
    reply.clearCookie("token", { path: "/", domain: config.COOKIE_DOMAIN || undefined });
    return { ok: true };
  });

  app.get("/me", async (req, reply) => {
    const session = await requireUser(req, reply);
    if (!session) return;
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(session.id) as DbUser;
    return { user: userToPublic(u) };
  });

  app.post("/change-password", async (req, reply) => {
    const session = await requireUser(req, reply);
    if (!session) return;
    const Body = z.object({ password: z.string().min(8) });
    const body = Body.parse(req.body);
    const hash = bcrypt.hashSync(body.password, 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, session.id);
    writeAudit({
      actorId: session.id,
      actorUsername: session.username,
      ip: clientIp(req),
      action: "password-change",
    });
    return { ok: true };
  });
};
