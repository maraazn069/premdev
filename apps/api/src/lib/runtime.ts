/**
 * Runtime abstraction. Swaps between Docker (production) and local FS (dev).
 * In dev (no Docker socket), workspaces live in ./data/workspaces/<id>/
 * and "running" just spawns a process locally for preview.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import Docker from "dockerode";
import { config } from "./config.js";
import { db } from "./db.js";

let docker: Docker | null = null;
let dockerAvailable = false;

async function probeDocker() {
  try {
    if (!fs.existsSync(config.DOCKER_SOCKET)) {
      console.log("⚠️  Docker socket not found — using local dev runtime");
      return;
    }
    const d = new Docker({ socketPath: config.DOCKER_SOCKET });
    await d.ping();
    docker = d;
    dockerAvailable = true;
    console.log("✅ Docker runtime available");
  } catch {
    console.log("⚠️  Docker not available — using local dev runtime");
    docker = null;
    dockerAvailable = false;
  }
}
probeDocker();

export const isDocker = () => dockerAvailable;

export function workspacePath(workspaceId: string): string {
  return path.join(config.WORKSPACES_DIR, workspaceId);
}

/**
 * Path to the workspace dir as seen by the HOST docker daemon. This is the
 * value that must be used as the source of bind mounts. When this app itself
 * runs inside a container with /opt/premdev/data → /var/lib/premdev, the
 * workspace lives at /var/lib/premdev/workspaces/<id> for our own file IO,
 * but the host docker daemon sees it at /opt/premdev/data/workspaces/<id>.
 */
export function workspaceHostPath(workspaceId: string): string {
  return path.join(config.WORKSPACES_HOST_DIR, workspaceId);
}

export function ensureWorkspaceDir(workspaceId: string) {
  const p = workspacePath(workspaceId);
  fs.mkdirSync(p, { recursive: true });
  // Chown to UID 1000 (premdev user inside workspace container) so the
  // user can create files and directories inside /workspace from the
  // terminal. Without this, the API (running as root) creates the dir
  // owned by root and `mkdir` inside the container fails with EACCES.
  // Failures are silenced for dev environments running unprivileged.
  try { fs.chownSync(p, 1000, 1000); } catch {}
  // Init a local git repo so the workspace has version-control bones from
  // day one. Used by the AI's `git diff`-style hints, by checkpoint diffs,
  // and lets the user run `git log` / `git push` without setup. Idempotent:
  // git init -q on an existing repo is a no-op. Failures are swallowed —
  // git is present in the container image but missing on bare local dev.
  try {
    if (!fs.existsSync(path.join(p, ".git"))) {
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: p });
      spawnSync("git", ["config", "user.email", "premdev@local"], { cwd: p });
      spawnSync("git", ["config", "user.name", "PremDev"], { cwd: p });
    }
  } catch {}
  return p;
}

/**
 * Per-workspace user-home subdirs that are bind-mounted into BOTH the run
 * container (`pw_<id>`) and the long-lived terminal container (`pwsh_<id>`),
 * so that `pip install --user`, `npm config`, `~/.cache/pip` etc. installed
 * from the Terminal are visible to the Run process and persist across
 * container restarts.
 *
 * Layout (siblings to the workspace tree):
 *   <DATA_DIR>/userhome/<wsId>/.local
 *   <DATA_DIR>/userhome/<wsId>/.cache
 *
 * NOT mounting all of /home/premdev because the runtime image's PATH defaults
 * (.bashrc, .profile, .npmrc seed, …) live there and overwriting them would
 * break the shell. Only the two pip/npm-relevant subdirs are mounted.
 */
function userHomeRoot(): string {
  // In-container path used for ensureDir / direct FS access from the API.
  return path.join(path.dirname(config.WORKSPACES_DIR), "userhome");
}
function userHomeHostRoot(): string {
  // Path on the docker host — used as bind mount source.
  return path.join(path.dirname(config.WORKSPACES_HOST_DIR), "userhome");
}
function ensureUserHomeDirs(workspaceId: string): { localHost: string; cacheHost: string } {
  const wsRoot = path.join(userHomeRoot(), workspaceId);
  const localDir = path.join(wsRoot, ".local");
  const cacheDir = path.join(wsRoot, ".cache");
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  // chown to UID 1000 (premdev user inside container) so pip can write.
  // Ignore errors when running unprivileged in dev.
  try { fs.chownSync(wsRoot, 1000, 1000); } catch {}
  try { fs.chownSync(localDir, 1000, 1000); } catch {}
  try { fs.chownSync(cacheDir, 1000, 1000); } catch {}
  const hostRoot = path.join(userHomeHostRoot(), workspaceId);
  return {
    localHost: path.join(hostRoot, ".local"),
    cacheHost: path.join(hostRoot, ".cache"),
  };
}
function userHomeBinds(workspaceId: string): string[] {
  const { localHost, cacheHost } = ensureUserHomeDirs(workspaceId);
  return [
    `${localHost}:/home/premdev/.local`,
    `${cacheHost}:/home/premdev/.cache`,
  ];
}

// === Process tracking for local dev runtime ===
const localProcesses = new Map<string, ChildProcess>();
const localLogs = new Map<string, string[]>();

export function startLocal(workspaceId: string, command: string, cwd: string, port: number): boolean {
  stopLocal(workspaceId);
  const proc = spawn("bash", ["-lc", command], {
    cwd,
    env: { ...process.env, PORT: String(port), HOST: "0.0.0.0" },
    detached: false,
  });
  localProcesses.set(workspaceId, proc);
  const logs: string[] = localLogs.get(workspaceId) ?? [];
  localLogs.set(workspaceId, logs);
  proc.stdout?.on("data", (d) => {
    const s = d.toString();
    logs.push(s);
    if (logs.length > 1000) logs.shift();
  });
  proc.stderr?.on("data", (d) => {
    const s = d.toString();
    logs.push(s);
    if (logs.length > 1000) logs.shift();
  });
  proc.on("exit", () => {
    localProcesses.delete(workspaceId);
  });
  return true;
}

export function stopLocal(workspaceId: string) {
  const p = localProcesses.get(workspaceId);
  if (p) {
    try { p.kill("SIGTERM"); } catch {}
    localProcesses.delete(workspaceId);
  }
}

export function getLocalLogs(workspaceId: string): string {
  return (localLogs.get(workspaceId) ?? []).join("");
}

export function isLocalRunning(workspaceId: string): boolean {
  return localProcesses.has(workspaceId);
}

// === Docker runtime helpers ===

export async function ensureNetwork() {
  if (!docker) return;
  try {
    await docker.getNetwork(config.DOCKER_NETWORK).inspect();
  } catch {
    await docker.createNetwork({ Name: config.DOCKER_NETWORK, Driver: "bridge" });
  }
}

export async function startContainer(opts: {
  workspaceId: string;
  username: string;
  cpu: number;
  memMb: number;
  diskMb: number;
  port: number;
  envVars: Record<string, string>;
  runCommand?: string;
}): Promise<string> {
  if (!docker) throw new Error("Docker not available");
  await ensureNetwork();

  const containerName = `pw_${opts.workspaceId}`;
  // Remove existing
  try {
    const existing = docker.getContainer(containerName);
    await existing.remove({ force: true });
  } catch {}

  ensureWorkspaceDir(opts.workspaceId);
  const wsHostDir = workspaceHostPath(opts.workspaceId);
  const env = Object.entries(opts.envVars).map(([k, v]) => `${k}=${v}`);
  env.push(`PORT=${opts.port}`);
  env.push(`HOST=0.0.0.0`);
  env.push(`USER=${opts.username}`);
  // Make pip / npm honour the per-workspace bind-mounted user-home dirs even
  // when /home/premdev resolves to a different uid mid-install.
  env.push(`PYTHONUSERBASE=/home/premdev/.local`);
  env.push(`PIP_CACHE_DIR=/home/premdev/.cache/pip`);
  env.push(`PATH=/home/premdev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);

  // Wrap the user-supplied run command with an idempotent dependency
  // bootstrap step. If the workspace has a `requirements.txt`, install it
  // (cached after first run via the shared pip wheel cache). Same for
  // package-lock.json — install if `node_modules` is missing.
  const runCmd = opts.runCommand
    ? `set -e; \
if [ -f requirements.txt ]; then \
  echo "[premdev] installing requirements.txt…"; \
  pip install -q --user --no-warn-script-location -r requirements.txt 2>&1 | tail -20 || true; \
fi; \
if [ -f package-lock.json ] && [ ! -d node_modules ]; then \
  echo "[premdev] running npm ci…"; \
  npm ci --silent 2>&1 | tail -20 || true; \
fi; \
cd /workspace && exec bash -lc ${JSON.stringify(opts.runCommand)}`
    : null;

  const container = await docker.createContainer({
    name: containerName,
    Image: config.RUNTIME_IMAGE,
    Tty: true,
    OpenStdin: true,
    Env: env,
    User: "premdev",
    WorkingDir: "/workspace",
    Cmd: runCmd
      ? ["bash", "-lc", runCmd]
      : ["bash", "-lc", "cd /workspace && exec bash -l"],
    HostConfig: {
      NetworkMode: config.DOCKER_NETWORK,
      Binds: [`${wsHostDir}:/workspace`, ...userHomeBinds(opts.workspaceId)],
      AutoRemove: false,
      RestartPolicy: { Name: "no" },
      Memory: opts.memMb * 1024 * 1024,
      // Disable swap to prevent a single workspace from grinding the host
      // I/O when it OOMs (MemorySwap == Memory means "no swap allowed").
      MemorySwap: opts.memMb * 1024 * 1024,
      NanoCpus: Math.floor(opts.cpu * 1e9),
      PidsLimit: 512,
      // Cap open file descriptors and per-user processes. Without these a
      // runaway loop can fork-bomb or exhaust nofile on the host.
      Ulimits: [
        { Name: "nofile", Soft: 4096, Hard: 8192 },
        { Name: "nproc", Soft: 512, Hard: 1024 },
      ],
      // Cap container log volume so a chatty user app can't fill the host
      // disk with stdout/stderr. Matches docker-compose.prod.yml services.
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges:true"],
    },
    Labels: {
      "premdev.workspace": opts.workspaceId,
      "premdev.user": opts.username,
      "premdev.port": String(opts.port),
    },
  });
  await container.start();
  return container.id;
}

export async function stopContainer(workspaceId: string) {
  if (!docker) {
    stopLocal(workspaceId);
    return;
  }
  try {
    const c = docker.getContainer(`pw_${workspaceId}`);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
  } catch {}
}

export async function execInContainer(workspaceId: string, cmd: string[], timeoutMs = 60_000): Promise<{ output: string; exitCode: number }> {
  if (!docker) throw new Error("Docker not available");
  const c = docker.getContainer(`pw_${workspaceId}`);
  // Pin cwd + user explicitly. Without WorkingDir, `docker exec` lands in `/`
  // (NOT the container's WorkingDir) for many engine versions, which makes
  // `cat index.php` fail even though /workspace/index.php exists. Without
  // User, exec runs as root, so files written by these commands (e.g. AI
  // file:write fallbacks) end up root-owned and break later premdev writes.
  const exec = await c.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
    User: "premdev",
  });
  const stream = await exec.start({});
  let buf = "";
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      try { (stream as any).destroy?.(); } catch {}
      resolve();
    }, timeoutMs);
    stream.on("data", (d: Buffer) => (buf += d.toString()));
    stream.on("end", () => { clearTimeout(t); resolve(); });
    stream.on("error", () => { clearTimeout(t); resolve(); });
  });
  if (timedOut) {
    return { output: buf + `\n[command killed after ${timeoutMs}ms timeout]`, exitCode: 124 };
  }
  const inspect = await exec.inspect().catch(() => ({ ExitCode: 1 } as any));
  return { output: buf, exitCode: inspect.ExitCode ?? 0 };
}

/**
 * Run a one-off command in the workspace context. Works whether the workspace container
 * is running or not. If running, exec into it; otherwise spawn an ephemeral container.
 */
export async function runOneOff(workspaceId: string, command: string, timeoutMs = 60_000): Promise<{ output: string; exitCode: number }> {
  if (!docker) {
    // local dev: spawn bash in the workspace dir
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-lc", command], { cwd: workspacePath(workspaceId) });
      let out = "";
      const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, timeoutMs);
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (out += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(t);
        resolve({ output: out, exitCode: code ?? 0 });
      });
    });
  }
  await ensureNetwork();
  // Wrap the user command with GNU `timeout` so the in-container process is
  // actually killed when the deadline elapses (stream destruction alone does
  // not stop the underlying docker exec process). The outer JS timeout in
  // execInContainer remains as a safety net.
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const escaped = command.replace(/'/g, `'\\''`);
  const wrappedForExec = `timeout --kill-after=2s ${seconds}s bash -lc '${escaped}'`;
  // Try exec into running container first
  try {
    const c = docker.getContainer(`pw_${workspaceId}`);
    await c.inspect();
    return await execInContainer(workspaceId, ["bash", "-lc", wrappedForExec], timeoutMs + 5_000);
  } catch {
    // Spawn ephemeral container with workspace mount
    ensureWorkspaceDir(workspaceId);
    const wsHostDir = workspaceHostPath(workspaceId);
    const name = `pwx_${workspaceId}_${Date.now()}`;
    const container = await docker.createContainer({
      name,
      Image: config.RUNTIME_IMAGE,
      Tty: false,
      User: "premdev",
      WorkingDir: "/workspace",
      // Same user-home env as run/shell containers so pip --user installs land
      // in the shared bind mount and `python -m foo` finds them on next exec.
      Env: [
        "PYTHONUSERBASE=/home/premdev/.local",
        "PIP_CACHE_DIR=/home/premdev/.cache/pip",
        "PATH=/home/premdev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ],
      Cmd: ["bash", "-lc", wrappedForExec],
      HostConfig: {
        NetworkMode: config.DOCKER_NETWORK,
        Binds: [`${wsHostDir}:/workspace`, ...userHomeBinds(workspaceId)],
        AutoRemove: true,
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 1e9,
        PidsLimit: 256,
      },
    });
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    let buf = "";
    stream.on("data", (d: Buffer) => (buf += d.toString()));
    await container.start();
    let timedOut = false;
    const killTimer = setTimeout(async () => {
      timedOut = true;
      try { await container.kill({ signal: "SIGKILL" }); } catch {}
    }, timeoutMs);
    const result: any = await container.wait().catch(() => ({ StatusCode: 1 }));
    clearTimeout(killTimer);
    return {
      output: timedOut ? buf + `\n[command killed after ${timeoutMs}ms timeout]` : buf,
      exitCode: timedOut ? 124 : (result.StatusCode ?? 0),
    };
  }
}

/**
 * Start a long-lived "shell" container for a workspace if `pw_<id>` doesn't exist yet.
 * The shell container runs `sleep infinity` and serves as a terminal target.
 * Named `pwsh_<id>` to coexist with the runtime container if started later.
 */
export async function ensureShellContainer(workspaceId: string): Promise<string> {
  if (!docker) throw new Error("Docker not available");
  await ensureNetwork();
  const shellName = `pwsh_${workspaceId}`;
  // Look up the workspace's persisted env vars so terminal sessions see the
  // same DATABASE_*, API keys etc. that the run container does.
  let envVars: Record<string, string> = {};
  try {
    const w = db
      .prepare("SELECT env_vars FROM workspaces WHERE id = ?")
      .get(workspaceId) as { env_vars?: string } | undefined;
    if (w?.env_vars) envVars = JSON.parse(w.env_vars);
  } catch {}
  const env = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);

  // Reuse if already alive AND not paused/dead. Unpause where possible so the
  // user doesn't get HTTP 409 on exec.
  try {
    const c = docker.getContainer(shellName);
    const info = await c.inspect();
    const state = info.State;
    if (state.Paused) {
      try { await c.unpause(); } catch {}
    }
    const fresh = await c.inspect();
    if (fresh.State.Running && !fresh.State.Paused && !fresh.State.Dead) {
      return shellName;
    }
    try { await c.remove({ force: true }); } catch {}
  } catch {}

  ensureWorkspaceDir(workspaceId);
  const wsHostDir = workspaceHostPath(workspaceId);
  // Inject pip/npm user-base envs so `pip install --user X` from the terminal
  // populates the same bind-mounted dir that the run container reads from.
  const shellEnv = [
    ...env,
    "PYTHONUSERBASE=/home/premdev/.local",
    "PIP_CACHE_DIR=/home/premdev/.cache/pip",
    "PATH=/home/premdev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ];
  const container = await docker.createContainer({
    name: shellName,
    Image: config.RUNTIME_IMAGE,
    Tty: true,
    OpenStdin: true,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    Env: shellEnv,
    HostConfig: {
      NetworkMode: config.DOCKER_NETWORK,
      Binds: [`${wsHostDir}:/workspace`, ...userHomeBinds(workspaceId)],
      AutoRemove: false,
      Memory: 1024 * 1024 * 1024,
      MemorySwap: 1024 * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 256,
      Ulimits: [
        { Name: "nofile", Soft: 4096, Hard: 8192 },
        { Name: "nproc", Soft: 512, Hard: 1024 },
      ],
      LogConfig: {
        Type: "json-file",
        Config: { "max-size": "10m", "max-file": "3" },
      },
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "no" },
    },
    Labels: { "premdev.shell": workspaceId },
  });
  await container.start();
  return shellName;
}

export async function stopShellContainer(workspaceId: string) {
  if (!docker) return;
  try {
    const c = docker.getContainer(`pwsh_${workspaceId}`);
    await c.stop({ t: 2 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
  } catch {}
}

export async function getContainerLogs(workspaceId: string, tail = 200): Promise<string> {
  if (!docker) return getLocalLogs(workspaceId);
  try {
    const c = docker.getContainer(`pw_${workspaceId}`);
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: false });
    return buf.toString();
  } catch {
    return "";
  }
}

export { docker };

// === Idle shell auto-stop ===
//
// Long-lived `pwsh_*` containers keep RAM busy even when the user closed the
// browser tab hours ago. The terminal route calls `recordShellActivity(id)`
// on every input frame; a background interval stops shells that have been
// silent for IDLE_SHELL_TIMEOUT_MIN minutes. Run containers (`pw_*`) are
// NEVER touched here — they pause/resume separately via IDLE_PAUSE_MINUTES.
//
// Activity is persisted to `workspaces.last_shell_activity_at` so it
// survives API restarts (otherwise every restart would hand all idle
// containers a fresh 30-min lease).

let activityWriter: any = null;
function writeActivity(workspaceId: string, ts: number): void {
  if (!activityWriter) {
    try {
      activityWriter = db.prepare(
        "UPDATE workspaces SET last_shell_activity_at = ? WHERE id = ?",
      );
    } catch {
      return;
    }
  }
  try { activityWriter.run(ts, workspaceId); } catch {}
}

// Throttle writes — terminal input fires per-keystroke, but a 5s resolution
// is plenty for an idle-after-30-min check.
const lastWriteAt = new Map<string, number>();
export function recordShellActivity(workspaceId: string) {
  const now = Date.now();
  const prev = lastWriteAt.get(workspaceId) ?? 0;
  if (now - prev < 5_000) return;
  lastWriteAt.set(workspaceId, now);
  writeActivity(workspaceId, now);
}

async function reapIdleShells() {
  const timeoutMin = config.IDLE_SHELL_TIMEOUT_MIN;
  if (!timeoutMin || timeoutMin <= 0 || !docker) return;
  const cutoff = Date.now() - timeoutMin * 60_000;
  let known: string[] = [];
  try {
    const list = await docker.listContainers({
      all: true,
      filters: { label: ["premdev.shell"] },
    });
    known = list
      .map((c: any) => c?.Labels?.["premdev.shell"])
      .filter((x: any): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return;
  }
  if (known.length === 0) return;
  // Bulk-fetch last-activity timestamps in one query.
  const placeholders = known.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, last_shell_activity_at FROM workspaces WHERE id IN (${placeholders})`)
    .all(...known) as { id: string; last_shell_activity_at: number | null }[];
  const lastByWs = new Map<string, number | null>();
  for (const r of rows) lastByWs.set(r.id, r.last_shell_activity_at);
  for (const id of known) {
    const last = lastByWs.get(id) ?? null;
    // Unseen shells (no recorded activity yet): seed with `now` so they
    // don't get murdered the moment we discover them. They'll be eligible
    // on the next cycle if still untouched.
    if (last == null) {
      writeActivity(id, Date.now());
      continue;
    }
    if (last <= cutoff) {
      try {
        await stopShellContainer(id);
        console.log(`[idle-reaper] stopped pwsh_${id} (idle ${Math.round((Date.now() - last) / 60000)}m)`);
      } catch (e: any) {
        console.warn(`[idle-reaper] failed to stop pwsh_${id}:`, e?.message ?? e);
      }
    }
  }
}

// Run every 5 minutes. Cheap (one docker list + one batched SQL select +
// a few stops per cycle).
setInterval(() => { reapIdleShells().catch(() => {}); }, 5 * 60_000);
