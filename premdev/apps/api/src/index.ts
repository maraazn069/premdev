import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./lib/config.js";
import { db, initDb, ensureFirstAdmin } from "./lib/db.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { fileRoutes } from "./routes/files.js";
import { attachRoutes } from "./routes/attach.js";
import { terminalRoutes } from "./routes/terminal.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes } from "./routes/admin.js";
import { dbRoutes } from "./routes/db.js";
import { vfsRoutes } from "./routes/vfs.js";
import { setupProxy } from "./routes/proxy.js";
import { apiLimiter, aiLimiter, clientIp } from "./lib/rate-limit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport: config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
  },
  // Trust ONLY the immediate proxy (Caddy) — not arbitrary upstream
  // X-Forwarded-For headers. Without this restriction an attacker could
  // spoof X-Forwarded-For to bypass per-IP rate limiting and lockout.
  // In production the request chain is: client → Caddy → app, so 1 hop.
  // In dev (no proxy) this still works — req.ip falls back to the socket.
  trustProxy: 1,
  bodyLimit: 50 * 1024 * 1024,
});

await app.register(fastifyCors, {
  origin: true,
  credentials: true,
});
await app.register(fastifyCookie);
await app.register(fastifyJwt, {
  secret: config.JWT_SECRET,
  cookie: { cookieName: "token", signed: false },
});
await app.register(fastifyMultipart, {
  limits: { fileSize: 200 * 1024 * 1024 },
});

initDb();
ensureFirstAdmin();

// Subdomain proxy must come first. It attaches an onRequest hook at root
// scope (NOT via `register`, which would encapsulate the hook to a child
// scope and silently never fire) plus a raw `upgrade` listener that has
// to be wired before @fastify/websocket so its handler runs first and can
// short-circuit upgrades destined for workspace containers.
setupProxy(app);
await app.register(fastifyWebsocket);

// WebSocket terminal — registered at root so the URL stays /ws/terminal/:id
// (the setNotFoundHandler below specifically excludes /ws/* from the SPA fallback)
await app.register(terminalRoutes);

// Per-IP rate limiting on the API surface. Two pools:
//   - apiLimiter: generous (120 burst / +2/s) — covers normal browsing
//   - aiLimiter:  tight   (30  burst / +1/5s) — applied to /api/ai/* only,
//     since each AI call costs real money on upstream providers
// Health endpoint is excluded so monitoring scripts don't burn tokens.
app.addHook("onRequest", async (req, reply) => {
  const url = req.raw.url || "";
  if (!url.startsWith("/api/")) return;
  if (url === "/api/health") return;
  const ip = clientIp(req);
  const isAi = url.startsWith("/api/ai/");
  const ok = isAi ? aiLimiter.take(`ai:${ip}`) : apiLimiter.take(`api:${ip}`);
  if (!ok) {
    reply.code(429).send({ error: "Too many requests. Please slow down." });
  }
});

// API routes
await app.register(async (api) => {
  await api.register(authRoutes, { prefix: "/auth" });
  await api.register(workspaceRoutes, { prefix: "/workspaces" });
  await api.register(fileRoutes, { prefix: "/workspaces" });
  await api.register(attachRoutes, { prefix: "/workspaces" });
  await api.register(aiRoutes, { prefix: "/ai" });
  await api.register(adminRoutes, { prefix: "/admin" });
  await api.register(dbRoutes, { prefix: "/db" });
  await api.register(vfsRoutes, { prefix: "/vfs" });
}, { prefix: "/api" });

// Health
app.get("/api/health", async () => ({ ok: true, version: "0.1.0", time: Date.now() }));

// Serve built frontend in production
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/", wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

const port = Number(config.PORT);
const host = config.HOST;
try {
  await app.listen({ port, host });
  app.log.info(`PremDev API listening on http://${host}:${port}`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
