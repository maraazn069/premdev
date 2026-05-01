/**
 * ai.ts — HTTP route handlers for AI chat.
 * Business logic is delegated to lib modules:
 *   - ai-prompt.ts    → prompt templates, message types, token utilities
 *   - ai-context.ts   → workspace snapshot & semantic search helpers
 *   - ai-providers.ts → streaming provider implementations & model config
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import {
  createJob,
  getJob,
  appendChunk,
  finishJob,
  abortJob,
  listActiveJobs,
  type ChatJob,
  type JobStatus,
} from "../lib/ai-jobs.js";
import { requireUser } from "../lib/auth-helpers.js";
import { db, DbWorkspace } from "../lib/db.js";
import { getAIKey } from "../lib/ai-settings.js";
import {
  type Provider,
  type ChatMsg,
  AUTO_PILOT_PROMPT,
  SYSTEM_PROMPT,
  CONT_TRUNC_INSTRUCTION,
  trimHistory,
  MAX_TOKENS_DEFAULT,
  MAX_TOKENS_AUTOPILOT,
} from "../lib/ai-prompt.js";
import {
  buildWorkspaceContext,
  loadProjectMemory,
  buildRelevantSnippets,
} from "../lib/ai-context.js";
import {
  streamProvider,
  PROVIDER_MODELS,
  DEFAULT_MODELS,
  isTextOnlyModel,
  fetchGoogleModels,
  fetchSnifoxModels,
} from "../lib/ai-providers.js";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ImageDataUrl = z
  .string()
  .max(7 * 1024 * 1024)
  .regex(/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/);

const Body = z.object({
  workspaceId: z.string(),
  tabId: z.string().min(1).max(64).optional().default("default"),
  provider: z.enum(["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"]),
  model: z.string().optional(),
  autoPilot: z.boolean().default(true),
  continuation: z.boolean().optional().default(false),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
    images: z.array(ImageDataUrl).max(4).optional(),
  })),
});

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const aiRoutes: FastifyPluginAsync = async (app) => {
  // POST /chat
  // Immediately returns { jobId }; actual streaming runs in the background
  // via ai-jobs.ts so tab closes / refreshes don't kill the AI run.
  app.post("/chat", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = Body.parse(req.body);

    const w = db
      .prepare("SELECT * FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id) as DbWorkspace | undefined;
    if (!w) return reply.code(404).send({ error: "Workspace not found" });

    const sys = body.autoPilot ? AUTO_PILOT_PROMPT : SYSTEM_PROMPT;
    const ownerRow = db
      .prepare("SELECT username FROM users WHERE id = ?")
      .get(w.user_id) as { username?: string } | undefined;
    const ctx = buildWorkspaceContext(body.workspaceId, ownerRow?.username, w.name);
    const memory = loadProjectMemory(body.workspaceId);
    const trimmed = trimHistory(body.messages as ChatMsg[]);
    const snippetsBlock = await buildRelevantSnippets(body.workspaceId, trimmed).catch(() => "");
    const memoryBlock = memory
      ? `\n\n--- Project memory (.premdev/instructions.md) ---\n${memory}`
      : "";
    const continuationBlock = body.continuation ? CONT_TRUNC_INSTRUCTION : "";

    const messages: ChatMsg[] = [
      {
        role: "system",
        content: `${sys}\n\n--- Workspace snapshot ---\n${ctx}${snippetsBlock}${memoryBlock}${continuationBlock}`,
      },
      ...trimmed,
    ];
    const model = body.model || DEFAULT_MODELS[body.provider];
    const maxTokens = body.autoPilot ? MAX_TOKENS_AUTOPILOT : MAX_TOKENS_DEFAULT;

    const job = createJob({
      workspaceId: body.workspaceId,
      tabId: body.tabId,
      userId: u.id,
      provider: body.provider,
      model,
      continuation: body.continuation,
    });

    void reply.send({ jobId: job.id });

    setImmediate(() => {
      runChatJob(job, body, model, maxTokens, messages, u.id).catch((e) => {
        finishJob(job, "error", e?.message || String(e));
      });
    });
  });

  // Background worker: drives the upstream provider stream into the job buffer.
  async function runChatJob(
    job: ChatJob,
    body: z.infer<typeof Body>,
    model: string,
    maxTokens: number,
    messages: ChatMsg[],
    userId: string,
  ) {
    const startedAt = Date.now();
    let totalChars = 0;
    let lastChunk = "";
    let ok = true;
    let errMsg: string | null = null;
    try {
      const stream = streamProvider(body.provider, model, messages, maxTokens, job.controller.signal);
      for await (const chunk of stream) {
        if (job.status !== "running") break;
        totalChars += chunk.length;
        lastChunk = chunk;
        appendChunk(job, chunk);
      }
      if (job.status === "running") finishJob(job, "done");
    } catch (e: any) {
      ok = false;
      errMsg = e?.message || String(e);
      if (errMsg && !errMsg.includes("aborted")) {
        appendChunk(job, `\n[Error: ${errMsg}]`);
      }
      finishJob(
        job,
        errMsg && errMsg.includes("aborted") ? "aborted" : "error",
        errMsg ?? undefined,
      );
    } finally {
      try {
        const dur = Date.now() - startedAt;
        const preview = (errMsg ? `[err] ${errMsg}` : lastChunk).slice(-2000);
        db.prepare(`
          INSERT INTO ai_tool_calls
            (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
          VALUES (?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?)
        `).run(
          nanoid(16),
          userId,
          body.workspaceId,
          body.provider,
          model,
          `chars=${totalChars} dur=${dur}ms${body.autoPilot ? " autopilot" : ""}${body.continuation ? " cont" : ""}`,
          ok ? 1 : 0,
          preview || null,
          startedAt,
        );
      } catch {}
    }
  }

  // GET /chat/jobs/active?workspaceId=…
  app.get("/chat/jobs/active", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = z.object({ workspaceId: z.string().min(1) }).parse(req.query);
    const list = listActiveJobs(q.workspaceId, u.id).map((j) => ({
      id: j.id,
      tabId: j.tabId,
      provider: j.provider,
      model: j.model,
      continuation: j.continuation,
      bufferLen: j.buffer.length,
      createdAt: j.createdAt,
    }));
    return reply.send({ jobs: list });
  });

  // GET /chat/jobs/:id/stream?offset=N  — SSE, replays from byte N then tails.
  app.get("/chat/jobs/:id/stream", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const query = z
      .object({ offset: z.coerce.number().int().min(0).optional().default(0) })
      .parse(req.query);
    const job = getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Job not found or expired" });
    if (job.userId !== u.id) return reply.code(403).send({ error: "Forbidden" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* socket gone */ }
    };

    // Atomic replay + subscribe (no await between snapshot and subscribe).
    const snapshotLen = job.buffer.length;
    const replaySlice =
      snapshotLen > query.offset ? job.buffer.slice(query.offset, snapshotLen) : "";

    if (job.status !== "running") {
      if (replaySlice) writeEvent("chunk", { text: replaySlice });
      writeEvent("done", { status: job.status, error: job.error });
      reply.raw.end();
      return;
    }

    const sub = (payload: { chunk?: string; status?: JobStatus; error?: string }) => {
      if (payload.chunk) writeEvent("chunk", { text: payload.chunk });
      if (payload.status) {
        writeEvent("done", { status: payload.status, error: payload.error });
        try { reply.raw.end(); } catch {}
        job.subscribers.delete(sub);
      }
    };
    job.subscribers.add(sub);

    if (replaySlice) writeEvent("chunk", { text: replaySlice });

    const hb = setInterval(() => {
      try { reply.raw.write(`: heartbeat\n\n`); } catch {}
    }, 20_000);

    req.raw.on("close", () => {
      clearInterval(hb);
      job.subscribers.delete(sub);
    });
  });

  // POST /chat/jobs/:id/abort  — user-initiated stop.
  app.post("/chat/jobs/:id/abort", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const params = z.object({ id: z.string().min(1).max(40) }).parse(req.params);
    const ok = abortJob(params.id, u.id);
    if (!ok) return reply.code(404).send({ error: "Job not found" });
    return reply.send({ ok: true });
  });

  // POST /audit  — client logs one row per executed AI action.
  const AuditBody = z.object({
    workspaceId: z.string().min(1).max(64),
    provider: z.string().max(32).optional(),
    model: z.string().max(128).optional(),
    kind: z.string().min(1).max(32),
    target: z.string().max(500).optional(),
    ok: z.boolean(),
    output: z.string().max(2000).optional(),
  });
  app.post("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = AuditBody.parse(req.body);
    const w = db
      .prepare("SELECT id FROM workspaces WHERE id = ? AND user_id = ?")
      .get(body.workspaceId, u.id);
    if (!w) return reply.code(404).send({ error: "Workspace not found" });
    const id = nanoid(16);
    const preview = (body.output ?? "").slice(0, 2000);
    db.prepare(`
      INSERT INTO ai_tool_calls
        (id, user_id, workspace_id, provider, model, kind, target, ok, output_preview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      u.id,
      body.workspaceId,
      body.provider ?? null,
      body.model ?? null,
      body.kind,
      body.target ?? null,
      body.ok ? 1 : 0,
      preview || null,
      Date.now(),
    );
    return { id };
  });

  // GET /audit  — user's own workspace history.
  app.get("/audit", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const q = req.query as any;
    const wsId = typeof q.workspaceId === "string" ? q.workspaceId : null;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const rows = wsId
      ? db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ? AND workspace_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, wsId, limit)
      : db.prepare(`
          SELECT * FROM ai_tool_calls
          WHERE user_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(u.id, limit);
    return { rows };
  });

  // GET /providers  — returns configured providers + model lists.
  app.get("/providers", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const [googleLive, snifoxLive] = await Promise.all([
      fetchGoogleModels().catch(() => null),
      fetchSnifoxModels().catch(() => null),
    ]);
    return {
      providers: (
        ["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"] as Provider[]
      ).map((id) => {
        let models = PROVIDER_MODELS[id];
        if (id === "google" && googleLive && googleLive.length > 0) {
          models = ["auto", ...googleLive];
        }
        if (id === "snifox" && snifoxLive && snifoxLive.length > 0) {
          models = ["auto", ...snifoxLive];
        }
        return {
          id,
          configured: !!getAIKey(id),
          models,
          textOnlyModels: models.filter(isTextOnlyModel),
          defaultModel: DEFAULT_MODELS[id],
        };
      }),
    };
  });

  // POST /web-search  — used by the AI's `web:search` action.
  const WebSearchBody = z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().positive().max(20).optional().default(8),
  });
  app.post("/web-search", async (req, reply) => {
    const u = await requireUser(req, reply);
    if (!u) return;
    const body = WebSearchBody.parse(req.body);
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(body.query)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `q=${encodeURIComponent(body.query)}`,
        signal: ctrl.signal,
      }).finally(() => clearTimeout(t));
      if (!r.ok) return reply.code(502).send({ error: `Upstream returned ${r.status}` });
      const html = (await r.text()).slice(0, 1024 * 1024);
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const linkRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRe =
        /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const links: Array<{ title: string; url: string }> = [];
      const snippets: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(html)) && links.length < body.maxResults) {
        let href = m[1];
        const ud = href.match(/[?&]uddg=([^&]+)/);
        if (ud) try { href = decodeURIComponent(ud[1]); } catch { /* keep */ }
        if (href.startsWith("//")) href = "https:" + href;
        const title = m[2]
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .trim();
        if (title) links.push({ title, url: href });
      }
      while ((m = snippetRe.exec(html)) && snippets.length < links.length) {
        snippets.push(
          m[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim(),
        );
      }
      for (let i = 0; i < links.length; i++) {
        results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] ?? "" });
      }
      return { ok: true, query: body.query, results };
    } catch (e: any) {
      return reply.code(502).send({ error: e?.message ?? "Web search failed" });
    }
  });
};
