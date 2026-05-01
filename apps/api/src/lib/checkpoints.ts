import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { config } from "./config.js";
import { workspacePath, isDocker, stopContainer, stopLocal } from "./runtime.js";

// Per-workspace mutex to prevent concurrent create/restore corrupting state.
const workspaceLocks = new Map<string, Promise<void>>();
async function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = workspaceLocks.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  workspaceLocks.set(workspaceId, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceLocks.get(workspaceId) === prev.then(() => next)) {
      workspaceLocks.delete(workspaceId);
    }
  }
}

const CHECKPOINTS_DIR = path.join(config.DATA_DIR, "checkpoints");
fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });

const MAX_CHECKPOINTS_PER_WORKSPACE = 20;

export type Checkpoint = {
  id: string;
  workspace_id: string;
  message: string;
  size_bytes: number;
  created_at: number;
};

function tarDir(srcDir: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=.cache",
      "--exclude=.venv",
      "--exclude=venv",
      "--exclude=__pycache__",
      "--exclude=dist",
      "--exclude=build",
      "--exclude=.next",
      "-czf", outFile,
      "-C", srcDir, ".",
    ];
    const p = spawn("tar", args);
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)));
  });
}

function untarTo(tarFile: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const p = spawn("tar", ["-xzf", tarFile, "-C", destDir]);
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`untar exited ${code}`)));
  });
}

export async function createCheckpoint(workspaceId: string, message: string): Promise<Checkpoint> {
  return withWorkspaceLock(workspaceId, async () => {
    const id = nanoid(10);
    const file = path.join(CHECKPOINTS_DIR, `${workspaceId}_${id}.tar.gz`);
    const src = workspacePath(workspaceId);
    await tarDir(src, file);
    const stat = fs.statSync(file);
    const ck: Checkpoint = {
      id,
      workspace_id: workspaceId,
      message: message || "Checkpoint",
      size_bytes: stat.size,
      created_at: Date.now(),
    };
    db.prepare(`
      INSERT INTO checkpoints (id, workspace_id, message, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ck.id, ck.workspace_id, ck.message, ck.size_bytes, ck.created_at);
    pruneCheckpoints(workspaceId);
    return ck;
  });
}

export function listCheckpoints(workspaceId: string): Checkpoint[] {
  return db.prepare(
    "SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC"
  ).all(workspaceId) as Checkpoint[];
}

export async function restoreCheckpoint(workspaceId: string, checkpointId: string) {
  const ck = db.prepare("SELECT * FROM checkpoints WHERE id = ? AND workspace_id = ?")
    .get(checkpointId, workspaceId) as Checkpoint | undefined;
  if (!ck) throw new Error("Checkpoint not found");
  const file = path.join(CHECKPOINTS_DIR, `${workspaceId}_${checkpointId}.tar.gz`);
  if (!fs.existsSync(file)) throw new Error("Checkpoint file missing");

  // Stop any running runtime so the workspace dir is not being written to.
  if (isDocker()) {
    await stopContainer(workspaceId).catch(() => {});
  } else {
    stopLocal(workspaceId);
  }

  return withWorkspaceLock(workspaceId, async () => {
    // Backup current state to a "pre-restore" checkpoint (without nesting locks).
    const backupId = nanoid(10);
    const backupFile = path.join(CHECKPOINTS_DIR, `${workspaceId}_${backupId}.tar.gz`);
    try {
      await tarDir(workspacePath(workspaceId), backupFile);
      const stat = fs.statSync(backupFile);
      db.prepare(`
        INSERT INTO checkpoints (id, workspace_id, message, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(backupId, workspaceId, `Auto-backup before restore ${checkpointId}`, stat.size, Date.now());
      pruneCheckpoints(workspaceId);
    } catch {
      try { fs.unlinkSync(backupFile); } catch {}
    }

    // Wipe workspace and untar
    const dest = workspacePath(workspaceId);
    for (const entry of fs.readdirSync(dest)) {
      fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
    }
    await untarTo(file, dest);
  });
}

/**
 * List file paths captured inside a checkpoint snapshot, sorted. Used by the
 * "Changes" button in the checkpoints panel so the user can see what the
 * checkpoint actually contains before they Rollback.
 */
export async function listCheckpointFiles(workspaceId: string, checkpointId: string): Promise<string[]> {
  const ck = db.prepare("SELECT 1 FROM checkpoints WHERE id = ? AND workspace_id = ?")
    .get(checkpointId, workspaceId);
  if (!ck) throw new Error("Checkpoint not found");
  const file = path.join(CHECKPOINTS_DIR, `${workspaceId}_${checkpointId}.tar.gz`);
  if (!fs.existsSync(file)) throw new Error("Checkpoint file missing");
  return new Promise<string[]>((resolve, reject) => {
    const p = spawn("tar", ["-tzf", file]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`tar -tzf exited ${code}: ${err}`));
      const list = out.split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l !== "./" && !l.endsWith("/"))
        .map((l) => l.replace(/^\.\//, ""))
        .sort();
      resolve(list);
    });
  });
}

export function deleteCheckpoint(workspaceId: string, checkpointId: string) {
  const file = path.join(CHECKPOINTS_DIR, `${workspaceId}_${checkpointId}.tar.gz`);
  try { fs.unlinkSync(file); } catch {}
  db.prepare("DELETE FROM checkpoints WHERE id = ? AND workspace_id = ?").run(checkpointId, workspaceId);
}

function pruneCheckpoints(workspaceId: string) {
  const all = listCheckpoints(workspaceId);
  if (all.length <= MAX_CHECKPOINTS_PER_WORKSPACE) return;
  const toDelete = all.slice(MAX_CHECKPOINTS_PER_WORKSPACE);
  for (const ck of toDelete) {
    deleteCheckpoint(workspaceId, ck.id);
  }
}

export function deleteAllCheckpointsFor(workspaceId: string) {
  const all = listCheckpoints(workspaceId);
  for (const ck of all) deleteCheckpoint(workspaceId, ck.id);
}
