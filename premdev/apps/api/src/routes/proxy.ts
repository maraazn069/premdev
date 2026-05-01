import type { FastifyInstance } from "fastify";
import http from "node:http";
import net from "node:net";
import { db, DbWorkspace, dnsSafe } from "../lib/db.js";
import { config } from "../lib/config.js";
import { docker } from "../lib/runtime.js";

/**
 * Decide whether a proxy connection failure means the workspace is *truly*
 * dead (container missing / exited) or just transiently unreachable
 * (container alive but the user's app crashed / hasn't bound the port yet /
 * is a non-HTTP daemon like a Telegram userbot).
 *
 * Only the first case warrants flipping the DB status to 'stopped'. The
 * second case must NOT — otherwise headless workloads (bots, workers,
 * cron-style scripts) get marked stopped the moment anyone hits the
 * preview URL, which then makes the IDE show "Stopped" while the
 * container's logs keep streaming. That mismatch was the source of
 * "kayak udh jalan tp dipaksa stop cmn log ttp jalan".
 */
async function containerIsTrulyDead(containerName: string): Promise<boolean> {
  if (!docker) return false; // dev mode: don't touch DB on local processes
  try {
    const info = await docker.getContainer(containerName).inspect();
    // Running OR Restarting = treat as alive. Only Exited / Dead / Removing
    // count as dead.
    return !info.State.Running && !info.State.Restarting;
  } catch {
    // inspect throws 404 → container removed → really gone
    return true;
  }
}

/**
 * Subdomain-based workspace proxy.
 *
 * URL format: `<project>-<user>.<PRIMARY_DOMAIN>` (e.g.
 * `keuangan-naufal.flixprem.org`). The subdomain doubles as the live
 * preview AND the deploy URL — workspaces stay running 24/7 unless the
 * user explicitly stops them.
 *
 * Caddy is the public TLS terminator and forwards every non-reserved
 * subdomain (`*.flixprem.org` minus app/admin/db/api/ws) to this app on
 * port 3001. The hook below inspects the Host header, looks up the
 * matching workspace by sanitised project + username, then streams the
 * request to the workspace container's preview port.
 *
 * IMPORTANT: this is wired in via `setupProxy(app)` (NOT `app.register`)
 * because Fastify plugin encapsulation would otherwise scope the
 * `onRequest` hook to the plugin only, and since the plugin owns no
 * routes, the hook would never fire for requests handled by other
 * plugins / static.
 */

// First-party subdomains that must NEVER be treated as workspace previews.
const RESERVED_SUBS = new Set([
  "app", "admin", "db", "api", "ws", "preview", "deploy", "www",
  "mail", "smtp", "imap", "ftp", "cpanel",
]);

// Connection-level / hop-by-hop headers we MUST NOT forward as-is per
// RFC 7230 §6.1. Letting them through corrupts framing or leaks state
// across hops.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

type Target = { containerName: string; port: number };

/**
 * Resolve `<project>-<user>` subdomain to a workspace target.
 * Returns:
 *   - { ok: true, target } on a single unambiguous match
 *   - { ok: false, status, msg } on no-match (503) or collision (409)
 *   - null when the host doesn't look like a workspace subdomain at all
 */
function resolveSubdomain(sub: string):
  | { ok: true; target: Target }
  | { ok: false; status: number; msg: string }
  | null {
  // 1) Custom-subdomain lookup wins over the auto-form. We accept BOTH
  //    single-component labels (`myapp`) and the legacy <proj>-<user>
  //    shape — the column is just an opaque string.
  const customRow = db
    .prepare(`
      SELECT w.*, u.username AS _username
      FROM workspaces w
      JOIN users u ON u.id = w.user_id
      WHERE w.custom_subdomain = ?
    `)
    .get(sub) as (DbWorkspace & { _username: string }) | undefined;
  if (customRow) {
    if (customRow.status !== "running" || customRow.preview_port == null) {
      return { ok: false, status: 503, msg: "Workspace not running" };
    }
    return { ok: true, target: { containerName: `pw_${customRow.id}`, port: customRow.preview_port } };
  }

  // 2) Fall back to the auto-generated <project>-<user> form. Bail out
  //    early if the label has no hyphen — only the auto-form requires one.
  if (!sub.includes("-")) {
    // No custom mapping AND no hyphen → can't be a workspace at all.
    return { ok: false, status: 503, msg: "Workspace not running" };
  }
  const rows = db
    .prepare(`
      SELECT w.*, u.username AS _username
      FROM workspaces w
      JOIN users u ON u.id = w.user_id
      WHERE w.status = 'running' AND w.preview_port IS NOT NULL
    `)
    .all() as Array<DbWorkspace & { _username: string }>;
  const matches = rows.filter((r) =>
    // Skip workspaces with a custom subdomain — their auto-form is
    // shadowed by the custom one and must not also resolve here.
    !r.custom_subdomain &&
    `${dnsSafe(r.name)}-${dnsSafe(r._username)}` === sub,
  );
  if (matches.length === 0) {
    // Shape looked workspace-y but nothing matches → 503
    return { ok: false, status: 503, msg: "Workspace not running" };
  }
  if (matches.length > 1) {
    // Two workspaces collapse to the same DNS slug. Refuse rather than
    // silently routing to one of them — that would leak the wrong app.
    console.warn(
      `[proxy] subdomain collision for "${sub}":`,
      matches.map((m) => ({ id: m.id, name: m.name, user: m._username })),
    );
    return { ok: false, status: 409, msg: "Workspace name collision — rename one of the projects" };
  }
  const w = matches[0];
  return { ok: true, target: { containerName: `pw_${w.id}`, port: w.preview_port! } };
}

/**
 * Pick the target for an inbound Host. Returns null when this host should
 * fall through to the rest of the app (main UI, /api, /ws, etc.).
 */
function targetForHost(rawHost: string):
  | { ok: true; target: Target }
  | { ok: false; status: number; msg: string }
  | null {
  if (!rawHost) return null;
  const host = rawHost.toLowerCase().split(":")[0];
  const primary = config.PRIMARY_DOMAIN.toLowerCase();
  const primarySuffix = `.${primary}`;

  // <proj>-<user>.<PRIMARY_DOMAIN>
  if (host.endsWith(primarySuffix) && host !== primary) {
    const sub = host.slice(0, host.length - primarySuffix.length);
    if (sub.includes(".") || RESERVED_SUBS.has(sub)) return null;
    return resolveSubdomain(sub);
  }

  return null;
}

export function setupProxy(app: FastifyInstance): void {
  // ---- Plain HTTP requests ----
  app.addHook("onRequest", async (req, reply) => {
    const decision = targetForHost(req.headers.host ?? "");
    if (!decision) return; // fall through to other handlers
    if (!decision.ok) {
      reply.code(decision.status).send(decision.msg);
      return reply;
    }
    const { target } = decision;

    // Buffer the body up-front so we can send a precise Content-Length
    // and never resort to chunked transfer encoding. PHP's built-in dev
    // server (and other minimal HTTP servers commonly used in workspace
    // templates) hang up the socket on chunked POST, which is the root
    // cause of "socket hang up" / "GET succeeded but POST never arrived".
    // 8 MB cap is plenty for forms and small JSON; uploads larger than
    // that should go through the dedicated /api/files endpoints anyway.
    const method = (req.method ?? "GET").toUpperCase();
    const bodyless = method === "GET" || method === "HEAD" || method === "DELETE" || method === "OPTIONS";
    let body: Buffer = Buffer.alloc(0);
    if (!bodyless) {
      try {
        body = await new Promise<Buffer>((resolveBody, rejectBody) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const MAX = 8 * 1024 * 1024;
          req.raw.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX) {
              rejectBody(new Error("body too large (>8MB)"));
              return;
            }
            chunks.push(c);
          });
          req.raw.on("end", () => resolveBody(Buffer.concat(chunks)));
          req.raw.on("error", rejectBody);
        });
      } catch (e: any) {
        reply.code(413).send(e?.message ?? "body read error");
        return reply;
      }
    }

    return new Promise<void>((resolve) => {
      // Strip hop-by-hop headers when forwarding to upstream. Keep the
      // original Host header — PHP / Flask / etc. compare it against
      // their configured ServerName and reject mismatches.
      const fwdHeaders: Record<string, any> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === "content-length" || lk === "expect") continue; // recomputed / dropped
        fwdHeaders[k] = v;
      }
      fwdHeaders["x-forwarded-host"] = (req.headers.host ?? "").toString();
      fwdHeaders["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || "https";
      fwdHeaders["x-forwarded-for"] = req.ip;
      // Force connection close + explicit Content-Length on EVERY request
      // so Node never picks Transfer-Encoding: chunked or keep-alive.
      fwdHeaders["connection"] = "close";
      fwdHeaders["content-length"] = String(body.length);

      const upstream = http.request({
        host: target.containerName,
        port: target.port,
        method,
        path: req.url,
        headers: fwdHeaders,
        timeout: 120_000,
      }, (upRes) => {
        reply.code(upRes.statusCode ?? 502);
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          if (v !== undefined) reply.header(k, v as any);
        }
        reply.send(upRes);
        upRes.on("end", resolve);
        upRes.on("error", () => resolve());
        upRes.on("close", resolve);
      });

      upstream.on("error", async (err: NodeJS.ErrnoException) => {
        if (!reply.sent) {
          if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "EAI_AGAIN") {
            // Only flip DB to stopped if the container itself is gone.
            // ECONNREFUSED with a live container = app crashed or never
            // bound a port (totally normal for headless bots / workers
            // that don't expose HTTP at all). Don't lie to the UI.
            const dead = await containerIsTrulyDead(target.containerName).catch(() => false);
            if (dead) {
              try {
                const id = target.containerName.replace(/^pw_/, "");
                db.prepare("UPDATE workspaces SET status = 'stopped', preview_port = NULL WHERE id = ?").run(id);
              } catch {}
            }
            reply.code(503).send(
              dead
                ? "Workspace tidak berjalan. Klik Run di editor untuk menjalankan ulang."
                : err.code === "ECONNREFUSED"
                  ? "Aplikasi berjalan tapi belum bind ke port preview. Pastikan listen 0.0.0.0:$PORT (cek .premdev), atau workload ini memang headless (Telegram bot / worker) dan tidak punya halaman preview."
                  : "Aplikasi berjalan tapi tidak bisa dijangkau (DNS gagal). Coba restart workspace.",
            );
          } else {
            reply.code(502).send(`Upstream error: ${err.message}`);
          }
        }
        resolve();
      });
      upstream.on("timeout", () => {
        if (!reply.sent) reply.code(504).send("Upstream timeout");
        try { upstream.destroy(new Error("timeout")); } catch {}
        resolve();
      });
      // Send the buffered body atomically and close the request stream.
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });

  // ---- WebSocket / HTTP/1.1 Upgrade tunneling ----
  // Native http server emits 'upgrade' BEFORE Fastify's request lifecycle
  // gets to peek at it. We attach an additional listener that catches
  // workspace-host upgrades and tunnels them as raw bidirectional sockets.
  // For non-workspace hosts (e.g. /ws/terminal/* served by the app itself),
  // we return early so @fastify/websocket's listener handles it.
  app.server.on("upgrade", (req, clientSocket, head) => {
    const decision = targetForHost(req.headers.host ?? "");
    if (!decision) return; // not a workspace upgrade — let fastify-websocket handle it
    if (!decision.ok) {
      try {
        clientSocket.write(`HTTP/1.1 ${decision.status} ${decision.msg}\r\n\r\n`);
      } catch {}
      try { clientSocket.destroy(); } catch {}
      return;
    }
    const { target } = decision;

    const upstream = net.connect(target.port, target.containerName);
    upstream.setNoDelay(true);
    if (clientSocket instanceof net.Socket) clientSocket.setNoDelay(true);

    const teardown = () => {
      try { upstream.destroy(); } catch {}
      try { clientSocket.destroy(); } catch {}
    };
    upstream.on("error", teardown);
    clientSocket.on("error", teardown);
    upstream.on("close", teardown);
    clientSocket.on("close", teardown);

    upstream.on("connect", () => {
      // Replay the original upgrade request line + headers, then any
      // bytes that arrived after the head (rare but possible).
      const headerLines: string[] = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const vv of v) headerLines.push(`${k}: ${vv}`);
        else if (v !== undefined) headerLines.push(`${k}: ${v}`);
      }
      headerLines.push("", "");
      upstream.write(headerLines.join("\r\n"));
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });
}
