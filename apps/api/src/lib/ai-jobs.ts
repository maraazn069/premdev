import { nanoid } from "nanoid";

// =============================================================================
// AI Chat Job store (in-memory, per-process)
// =============================================================================
//
// Why this exists
// ---------------
// The original `POST /api/ai/chat` streamed the upstream provider's response
// directly into the HTTP reply socket. That meant the moment the user closed
// the browser tab or hit refresh, the request socket closed → the abort
// controller fired → the upstream stream was cancelled → the AI silently
// died mid-reply. The user came back to a half-written message and had to
// re-send.
//
// This module decouples the AI run from the HTTP request lifecycle:
//
//   1. `POST /chat` creates a job, returns `{ jobId }` immediately, and
//      kicks off the upstream streaming in the background. The HTTP
//      response is closed AT ONCE — there is no streaming on this socket.
//   2. The background loop appends each chunk to the job's buffer and
//      notifies any open subscribers (SSE connections).
//   3. `GET /chat/jobs/:id/stream?offset=N` opens an SSE connection that
//      first replays everything from byte `N` (so a reconnecting tab
//      catches up on what it missed) and then tails new chunks as the
//      background loop produces them.
//   4. `POST /chat/jobs/:id/abort` lets the user explicitly stop a run.
//
// Limitations (documented for the README):
//   • In-memory only. A server restart loses every running job. The
//     audit-log row is still written on job completion, so admin visibility
//     survives, but a half-finished reply will be lost.
//   • Per-process. If the API is ever scaled to multiple replicas, jobs
//     created on replica A cannot be tailed by a request landing on
//     replica B. PremDev currently runs as a single container so this is
//     fine.
//   • One round per job. The client-driven auto-continue and tool-result
//     loops still happen client-side: each round is its own short-lived
//     job. A tab that dies between rounds will lose the multi-round
//     chaining — the user comes back, sees the last completed round, and
//     can resume manually.

export type JobStatus = "running" | "done" | "error" | "aborted";

export interface ChatJob {
  id: string;
  workspaceId: string;
  tabId: string;
  userId: string;
  provider: string;
  model: string;
  /** True if the round was kicked off as an auto-continuation. Surfaced
   *  on the active-list endpoint so the client can keep its
   *  continuationCountRef in sync after a refresh. */
  continuation: boolean;
  status: JobStatus;
  /** Append-only buffer of every text chunk the upstream stream has
   *  yielded so far. Storing as a single growing string makes
   *  byte-offset replay cheap (`buffer.slice(offset)`). */
  buffer: string;
  /** Subscribers are SSE connections that want to be notified when a new
   *  chunk arrives or the job transitions to a terminal state. */
  subscribers: Set<(payload: { chunk?: string; status?: JobStatus; error?: string }) => void>;
  /** Aborts the upstream `streamProvider()` fetch when the user clicks
   *  Stop. Independent of any HTTP request lifecycle so closing the tab
   *  does NOT cancel the upstream run. */
  controller: AbortController;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, ChatJob>();
// Secondary index: workspaceId → set of jobIds. Lets the active-jobs
// endpoint return jobs for a workspace in O(jobs-in-this-workspace)
// instead of scanning every job in the process.
const byWorkspace = new Map<string, Set<string>>();

export function createJob(opts: {
  workspaceId: string;
  tabId: string;
  userId: string;
  provider: string;
  model: string;
  continuation: boolean;
}): ChatJob {
  const job: ChatJob = {
    id: nanoid(),
    workspaceId: opts.workspaceId,
    tabId: opts.tabId,
    userId: opts.userId,
    provider: opts.provider,
    model: opts.model,
    continuation: opts.continuation,
    status: "running",
    buffer: "",
    subscribers: new Set(),
    controller: new AbortController(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  let set = byWorkspace.get(opts.workspaceId);
  if (!set) {
    set = new Set();
    byWorkspace.set(opts.workspaceId, set);
  }
  set.add(job.id);
  return job;
}

export function getJob(id: string): ChatJob | undefined {
  return jobs.get(id);
}

export function appendChunk(job: ChatJob, chunk: string) {
  if (!chunk || job.status !== "running") return;
  job.buffer += chunk;
  job.updatedAt = Date.now();
  // Snapshot before iterating: a subscriber that errors and removes
  // itself mid-iteration would otherwise mutate the live Set.
  const subs = Array.from(job.subscribers);
  for (const sub of subs) {
    try { sub({ chunk }); } catch { /* dead socket — ignored, GC'd by close handler */ }
  }
}

export function finishJob(job: ChatJob, status: "done" | "error" | "aborted", error?: string) {
  if (job.status !== "running") return;
  job.status = status;
  if (error) job.error = error;
  job.updatedAt = Date.now();
  const subs = Array.from(job.subscribers);
  for (const sub of subs) {
    try { sub({ status, error }); } catch {}
  }
  job.subscribers.clear();
}

export function abortJob(id: string, userId: string): boolean {
  const j = jobs.get(id);
  if (!j || j.userId !== userId) return false;
  if (j.status !== "running") return true; // already terminal — idempotent ok
  j.controller.abort();
  finishJob(j, "aborted");
  return true;
}

export function listActiveJobs(workspaceId: string, userId: string): ChatJob[] {
  const ids = byWorkspace.get(workspaceId);
  if (!ids) return [];
  const out: ChatJob[] = [];
  for (const id of ids) {
    const j = jobs.get(id);
    if (j && j.userId === userId && j.status === "running") out.push(j);
  }
  return out;
}

// Garbage collect terminal jobs that haven't been touched in an hour. We
// keep them around for a while so a user who reopens a long-idle tab can
// still see the full reply via the SSE replay path. Anything older is
// safely persisted in `ai_tool_calls` audit log + the client's own
// localStorage chat history, so dropping it from the in-memory store
// loses nothing.
const GC_INTERVAL_MS = 5 * 60 * 1000;
const GC_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - GC_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== "running" && j.updatedAt < cutoff) {
      jobs.delete(id);
      const set = byWorkspace.get(j.workspaceId);
      if (set) {
        set.delete(id);
        if (set.size === 0) byWorkspace.delete(j.workspaceId);
      }
    }
  }
}, GC_INTERVAL_MS).unref?.();
