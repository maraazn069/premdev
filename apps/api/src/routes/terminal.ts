import type { FastifyPluginAsync } from "fastify";
import { spawn } from "node:child_process";
import { db, DbWorkspace } from "../lib/db.js";
import { workspacePath, isDocker, docker, ensureShellContainer, recordShellActivity } from "../lib/runtime.js";

/**
 * Terminal WebSocket route. Production uses node-pty (loaded dynamically) for full PTY semantics.
 * If node-pty isn't available (dev environment), falls back to plain child_process spawn.
 * In Docker mode, attaches to the running container via `docker exec`.
 */

let pty: any = null;
async function loadPty() {
  if (pty !== null) return pty;
  try {
    // Use eval so TypeScript doesn't type-check / bundle this dynamic import.
    // node-pty is only present in production (compiled in the Docker builder stage).
    pty = await (0, eval)('import("node-pty")');
  } catch {
    pty = false;
  }
  return pty;
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws/terminal/:id", { websocket: true }, async (socket, req) => {
    // --- AuthN. Surface the actual reason in dev so misconfigured cookies
    // (SameSite, missing token, expired) are obvious in the browser console
    // instead of an opaque 1008. The frontend already shows close codes.
    let userId: string | null = null;
    try {
      await (req as any).jwtVerify();
      userId = (req.user as any).sub;
    } catch (err: any) {
      try { socket.send(`\r\n\x1b[31m[auth failed: ${err?.message || "no token"}]\x1b[0m\r\n`); } catch {}
      socket.close(1008, "Unauthorized");
      return;
    }
    const id = (req.params as any).id;
    const w = db.prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?").get(id, userId) as DbWorkspace | undefined;
    if (!w) {
      socket.close(1008, "Not found");
      return;
    }

    const q = req.query as any;
    const cols = Number(q.cols) || 80;
    const rows = Number(q.rows) || 24;

    // --- Keep-alive ping. Many production proxies (Cloudflare, NGINX, even
    // Caddy with default idle settings) drop a WebSocket after ~60s of no
    // traffic. xterm only sends data on user input, so a long-idle terminal
    // (just sitting at a prompt) gets killed mid-session. A 25s ping frame
    // is invisible to the app and is the standard cure.
    const pingInterval = setInterval(() => {
      try {
        if (socket.readyState === 1) (socket as any).ping?.();
      } catch {}
    }, 25_000);
    const stopPing = () => clearInterval(pingInterval);

    if (isDocker() && docker) {
      try {
        // Always use a dedicated long-lived shell container (`pwsh_<id>`),
        // independent of whether the user's app (`pw_<id>`) is running,
        // stopped or paused. This matches Replit's "shell is always alive"
        // semantics: the terminal session never dies just because the app
        // crashes, finishes, or is restarted.
        const target = await ensureShellContainer(id);
        const c = docker.getContainer(target);
        const exec = await c.exec({
          // Prefer zsh (oh-my-zsh installed in runtime image) but fall back
          // automatically — `bash -l` is guaranteed to exist.
          Cmd: ["bash", "-lc", "exec $(command -v zsh || command -v bash)"],
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: [`TERM=xterm-256color`, `COLUMNS=${cols}`, `LINES=${rows}`],
        });
        const stream = await exec.start({ hijack: true, stdin: true });
        // Send raw bytes (not toString()) so multi-byte UTF-8 sequences split
        // across docker chunks don't get mangled into U+FFFD replacement
        // chars — common for unicode TUIs (htop, vim status line, emoji).
        stream.on("data", (d: Buffer) => {
          if (socket.readyState === 1) socket.send(d);
        });
        socket.on("message", (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === "input") {
              recordShellActivity(id);
              stream.write(m.data);
            } else if (m.type === "resize") {
              recordShellActivity(id);
              exec.resize({ h: m.rows, w: m.cols }).catch(() => {});
            }
          } catch {}
        });
        const cleanup = () => { stopPing(); try { stream.end(); } catch {} };
        socket.on("close", cleanup);
        socket.on("error", cleanup);
        return;
      } catch (e: any) {
        try { socket.send(`\r\n\x1b[31mTerminal error: ${e.message}\x1b[0m\r\n`); } catch {}
        stopPing();
        socket.close();
        return;
      }
    }

    // Local fallback
    const cwd = workspacePath(w.id);
    const ptyMod = await loadPty();
    if (ptyMod) {
      const term = ptyMod.spawn(process.env.SHELL || "bash", ["-l"], {
        name: "xterm-256color",
        cols, rows,
        cwd,
        env: { ...process.env, TERM: "xterm-256color" },
      });
      term.onData((data: string) => { if (socket.readyState === 1) socket.send(data); });
      term.onExit(() => { try { socket.close(); } catch {} });
      socket.on("message", (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === "input") term.write(m.data);
          else if (m.type === "resize") term.resize(m.cols, m.rows);
        } catch {}
      });
      socket.on("close", () => { try { term.kill(); } catch {} });
      return;
    }

    // Last-resort fallback: child_process (no PTY semantics, but works for basic commands)
    socket.send("\x1b[33m[dev mode: limited terminal — PTY not loaded]\x1b[0m\r\n$ ");
    let cmdBuf = "";
    socket.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type !== "input") return;
        const data: string = m.data;
        for (const ch of data) {
          if (ch === "\r" || ch === "\n") {
            socket.send("\r\n");
            const line = cmdBuf;
            cmdBuf = "";
            if (line.trim()) {
              const proc = spawn("bash", ["-c", line], { cwd });
              proc.stdout.on("data", (d) => socket.send(d.toString()));
              proc.stderr.on("data", (d) => socket.send(d.toString()));
              proc.on("close", () => socket.send("$ "));
            } else {
              socket.send("$ ");
            }
          } else if (ch === "\x7f") {
            if (cmdBuf.length) {
              cmdBuf = cmdBuf.slice(0, -1);
              socket.send("\b \b");
            }
          } else {
            cmdBuf += ch;
            socket.send(ch);
          }
        }
      } catch {}
    });
  });
};
