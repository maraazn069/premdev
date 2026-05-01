import { useEffect, useMemo, useRef, useState } from "react";
import {
  Send, Square, Sparkles, Bot, User, Play, Save, RotateCw,
  Check, X, FileEdit, Copy, Pencil, ImagePlus,
  Trash2, FolderPlus, Move, Search, Stethoscope, Globe, Diff,
  Plus, MessageSquare, Mic, MicOff, Bookmark, FlaskConical,
  ListChecks, Clock,
} from "lucide-react";
import { API } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

type Msg = {
  role: "user" | "assistant";
  content: string;
  // Optional inline images (base64 data URLs). Only present on user messages
  // where the user attached / pasted screenshots. Persisted in localStorage
  // along with the rest of chat history.
  images?: string[];
  // True for synthetic continuation user messages emitted by the
  // auto-continue loop (NOT typed by the user). Hidden from the chat
  // bubble render, stripped from localStorage persistence, and never
  // round-trips back through `loadTabMsgs`. Server-side authority for
  // the continuation behaviour comes from the `continuation: true` body
  // flag on the same request — this field exists purely as a client-side
  // marker so the UI / persistence layer can distinguish them.
  synthetic?: boolean;
  // Provenance: which provider/model produced this assistant reply,
  // captured at SEND time so historical bubbles keep showing the model
  // that actually generated them even after the user later switches the
  // active provider/model dropdown. Undefined on user messages and on
  // legacy persisted history (the Bubble falls back to the current
  // active provider/model in that case).
  provider?: string;
  model?: string;
};

// Match the backend's per-image cap (~5 MB raw → ~7 MB base64).
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_IMGS_PER_MSG = 4;
const ACCEPTED_IMG_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Heuristic: which (provider, model) combos are known to accept images.
// Used to warn the user before they send images to a text-only model
// (e.g. Llama 3.3 on Groq), which would otherwise fail with a 400.
function modelSupportsVision(provider: string, model: string): boolean {
  const m = (model || "").toLowerCase();
  if (provider === "openai") {
    // gpt-4o, gpt-4o-mini, gpt-4.1, o1, o3, o4-mini all support images.
    return /^(gpt-4o|gpt-4\.1|gpt-4-turbo|o[134])/.test(m);
  }
  if (provider === "anthropic") {
    // All current Claude 3 / 3.5 / 4 models accept images.
    return /claude-(3|sonnet|opus|haiku|4)/.test(m);
  }
  if (provider === "google") {
    // Gemini 1.5+ and 2.x are multimodal; legacy gemini-pro is text-only.
    return /gemini-(1\.5|2|pro-vision)/.test(m);
  }
  if (provider === "openrouter") {
    return /vision|gpt-4o|claude-3|gemini-1\.5|gemini-2|llama-3\.2.*vision|pixtral/.test(m);
  }
  if (provider === "groq") {
    return /vision|llama-3\.2-(11|90)b/.test(m);
  }
  if (provider === "konektika") {
    // kimi-pro is text-only per https://konektika.web.id/docs.
    return false;
  }
  if (provider === "snifox") {
    // Snifox is OpenRouter-style — every modern OpenAI/Claude/Gemini model
    // accepts images. Match those families plus a generic "vision" tag.
    return /vision|gpt-4o|gpt-5|claude-(opus|sonnet)|gemini-(2|3)/.test(m);
  }
  return false;
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

// If the user pastes/types more than this many chars, the message body is
// dumped to `attached_assets/<name>-<ts>.txt` and the AI receives only a
// short reference. Saves a LOT of tokens on log dumps and big code pastes.
const LONG_TEXT_THRESHOLD = 4000;
// Re-encode any image larger than this (decoded) to JPEG q=0.85 with the
// long edge capped at MAX_IMAGE_EDGE px before upload. Cuts a 5MB phone
// screenshot down to ~300KB with no visible quality loss for chat usage.
const COMPRESS_IMAGE_THRESHOLD_BYTES = 600 * 1024; // 600 KB
const MAX_IMAGE_EDGE = 1920;
const JPEG_QUALITY = 0.85;

// Best-effort browser-side image compressor. Returns the compressed data URL
// (PNG → JPEG) or the original on any failure (e.g. canvas blocked, GIF
// animation we don't want to flatten). Animated GIFs are NEVER recompressed.
async function compressImage(file: File): Promise<{ dataUrl: string; sizeBytes: number; type: string }> {
  const original = await fileToDataUrl(file);
  if (file.size <= COMPRESS_IMAGE_THRESHOLD_BYTES || file.type === "image/gif") {
    return { dataUrl: original, sizeBytes: file.size, type: file.type };
  }
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = original;
    });
    const longEdge = Math.max(img.width, img.height);
    const scale = longEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longEdge : 1;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl: original, sizeBytes: file.size, type: file.type };
    ctx.drawImage(img, 0, 0, w, h);
    const out = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    // Decoded size estimate from base64 length (not perfect but close).
    const b64 = out.split(",")[1] ?? "";
    const sizeBytes = Math.floor(b64.length * 0.75);
    return sizeBytes < file.size
      ? { dataUrl: out, sizeBytes, type: "image/jpeg" }
      : { dataUrl: original, sizeBytes: file.size, type: file.type };
  } catch {
    return { dataUrl: original, sizeBytes: file.size, type: file.type };
  }
}

// Persist a chat-side attachment into the workspace's `attached_assets/`
// folder. Returns the workspace-relative path or null on failure.
// Hits `/api/workspaces/:id/attach` (not under `/files/...` to avoid clashing
// with user apps that already serve a `/files` route through the proxy).
async function saveAttachment(
  workspaceId: string,
  payload:
    | { kind: "image"; filename: string; dataUrl: string }
    | { kind: "text"; filename: string; text: string },
): Promise<string | null> {
  try {
    const body =
      payload.kind === "image"
        ? {
            kind: "image",
            filename: payload.filename,
            dataBase64: payload.dataUrl.replace(/^data:[^;]+;base64,/, ""),
          }
        : { kind: "text", filename: payload.filename, text: payload.text };
    const r = await API.post<{ ok: boolean; path: string }>(
      `/workspaces/${workspaceId}/attach`,
      body,
    );
    return r.path;
  } catch {
    return null;
  }
}

type Provider = {
  id: "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox";
  configured: boolean;
  models: string[];
  // Sub-list of `models` heuristically known to ignore the structured
  // action format (file:/bash:/patch: blocks) and answer with prose only.
  // Used to render a "text-only" badge next to those entries in the
  // dropdown so users know not to expect file edits / bash output from
  // them. Optional for backward compat with older /providers responses.
  textOnlyModels?: string[];
  defaultModel: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
  groq: "Groq",
  konektika: "Konektika (kimi-pro)",
  snifox: "SnifoxAI",
};

type Action =
  | { kind: "bash"; command: string }
  | { kind: "file"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "mkdir"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "patch"; path: string; find: string; replace: string; replaceAll: boolean }
  | { kind: "search"; pattern: string; pathGlob?: string; regex: boolean }
  | { kind: "diag" }
  | { kind: "test"; command?: string }
  | { kind: "web"; query: string }
  | { kind: "setRun"; command: string }
  | { kind: "setEnv"; vars: Record<string, string> }
  | { kind: "restart" }
  | { kind: "checkpoint"; message: string }
  | { kind: "db"; sql: string };

type ActionResult = { ok: boolean; output: string };

// Pass `signal` so Stop can abort the in-flight HTTP request — without this,
// the orchestrator's `await runAction(...)` blocks until the server's own
// timeout (~120s for /exec) and Stop appears to do nothing.
async function runAction(
  workspaceId: string,
  action: Action,
  signal?: AbortSignal,
): Promise<ActionResult> {
  async function fetchJson(method: string, path: string, body?: unknown) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = data?.error || text || res.statusText;
      throw new Error(typeof err === "string" ? err : JSON.stringify(err));
    }
    return data;
  }
  try {
    if (action.kind === "bash") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/exec`, {
        command: action.command,
      });
      return { ok: r.exitCode === 0, output: r.output ?? "" };
    }
    if (action.kind === "file") {
      try {
        await fetchJson("POST", `/workspaces/${workspaceId}/checkpoints`, {
          message: `Auto: before AI edit ${action.path}`,
        });
      } catch {}
      await fetchJson("POST", `/workspaces/${workspaceId}/files/create`, {
        path: action.path,
        type: "file",
      });
      await fetchJson("PUT", `/workspaces/${workspaceId}/files`, {
        path: action.path,
        content: action.content,
      });
      return { ok: true, output: `Wrote ${action.path}` };
    }
    if (action.kind === "setRun") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/config/patch`, {
        run: action.command,
      });
      return { ok: true, output: `.premdev run set to:\n${r.config?.run ?? action.command}` };
    }
    if (action.kind === "setEnv") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/config/patch`, {
        env: action.vars,
      });
      const keys = Object.keys(action.vars);
      const merged = r.config?.env ?? {};
      return {
        ok: true,
        output: `.premdev env merged (${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}). Total now: ${Object.keys(merged).length}.`,
      };
    }
    if (action.kind === "restart") {
      await fetchJson("POST", `/workspaces/${workspaceId}/restart`);
      return { ok: true, output: "Workspace restarted" };
    }
    if (action.kind === "checkpoint") {
      await fetchJson("POST", `/workspaces/${workspaceId}/checkpoints`, {
        message: action.message,
      });
      return { ok: true, output: `Checkpoint saved: ${action.message}` };
    }
    if (action.kind === "delete") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/delete`, {
        path: action.path,
      });
      if (r.ok === false) {
        const failed = (r.results ?? []).filter((x: any) => !x.ok).map((x: any) => `${x.path}: ${x.error}`).join("; ");
        return { ok: false, output: failed || "Delete failed" };
      }
      return { ok: true, output: `Deleted ${action.path}` };
    }
    if (action.kind === "mkdir") {
      await fetchJson("POST", `/workspaces/${workspaceId}/files/create`, {
        path: action.path,
        type: "dir",
      });
      return { ok: true, output: `Created directory ${action.path}` };
    }
    if (action.kind === "rename") {
      await fetchJson("POST", `/workspaces/${workspaceId}/files/rename`, {
        from: action.from,
        to: action.to,
      });
      return { ok: true, output: `Renamed ${action.from} → ${action.to}` };
    }
    if (action.kind === "patch") {
      try {
        await fetchJson("POST", `/workspaces/${workspaceId}/checkpoints`, {
          message: `Auto: before AI patch ${action.path}`,
        });
      } catch {}
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/patch`, {
        path: action.path,
        find: action.find,
        replace: action.replace,
        replaceAll: action.replaceAll,
      });
      const occ = r.occurrences ?? 1;
      return { ok: true, output: `Patched ${action.path} (${occ} occurrence${occ === 1 ? "" : "s"} replaced)` };
    }
    if (action.kind === "search") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/search`, {
        pattern: action.pattern,
        regex: action.regex,
        pathGlob: action.pathGlob || undefined,
        maxHits: 100,
      });
      const hits = r.hits ?? [];
      if (hits.length === 0) {
        return { ok: true, output: `No matches for "${action.pattern}" (scanned ${r.filesScanned ?? 0} files)` };
      }
      const lines = hits.slice(0, 80).map((h: any) => `${h.path}:${h.line}: ${h.text}`);
      const hdr = `Found ${hits.length}${r.truncated ? "+" : ""} matches in ${r.filesScanned} files:`;
      return { ok: true, output: [hdr, ...lines].join("\n") };
    }
    if (action.kind === "diag") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/files/diagnostics`, {
        tool: "auto",
      });
      const hdr = `Diagnostics (${r.tool}, exit=${r.exitCode}):`;
      return { ok: r.ok !== false, output: [hdr, r.output || "(no output)"].join("\n") };
    }
    if (action.kind === "test") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/test`, {
        command: action.command,
      });
      const hdr = `Tests (${r.tool}, exit=${r.exitCode}):`;
      return { ok: r.ok !== false, output: [hdr, r.output || "(no output)"].join("\n") };
    }
    if (action.kind === "db") {
      const r = await fetchJson("POST", `/workspaces/${workspaceId}/db/query`, {
        sql: action.sql,
      });
      if (r.kind === "rows") {
        const lines: string[] = [];
        lines.push(`db: ${r.database} — ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? " (showing first " + r.rows.length + ")" : ""}`);
        if (r.columns?.length) lines.push(r.columns.join(" | "));
        for (const row of r.rows.slice(0, 50)) {
          lines.push(r.columns.map((c: string) => {
            const v = row[c];
            if (v === null || v === undefined) return "NULL";
            const s = typeof v === "object" ? JSON.stringify(v) : String(v);
            return s.length > 80 ? s.slice(0, 77) + "..." : s;
          }).join(" | "));
        }
        return { ok: true, output: lines.join("\n").slice(0, 12_000) };
      }
      if (r.kind === "info") {
        return { ok: true, output: `db: ${r.database} — affected=${r.affectedRows}, insertId=${r.insertId}, changed=${r.changedRows}` };
      }
      return { ok: true, output: JSON.stringify(r).slice(0, 4000) };
    }
    if (action.kind === "web") {
      const r = await fetchJson("POST", `/ai/web-search`, {
        query: action.query,
        maxResults: 8,
      });
      const results = r.results ?? [];
      if (results.length === 0) {
        return { ok: true, output: `No web results for "${action.query}"` };
      }
      const fmt = results.map((x: any, i: number) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n");
      return { ok: true, output: `Web search "${action.query}":\n\n${fmt}` };
    }
    return { ok: false, output: "Unknown action" };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return { ok: false, output: "Cancelled by user" };
    }
    return { ok: false, output: e?.message ?? String(e) };
  }
}

/**
 * Build the audit "target" string for a given action — short, human-readable,
 * and stable across the bash/file/setRun/setEnv/restart/checkpoint variants.
 * Mirrors actionLabel() but optimised for log filtering rather than UI display.
 */
function actionTarget(a: Action): string {
  switch (a.kind) {
    case "bash":       return a.command.split("\n")[0].slice(0, 200);
    case "file":       return a.path;
    case "delete":     return a.path;
    case "mkdir":      return a.path;
    case "rename":     return `${a.from} => ${a.to}`;
    case "patch":      return a.path;
    case "search":     return a.pattern.slice(0, 200);
    case "diag":       return "";
    case "test":       return a.command?.slice(0, 200) ?? "";
    case "web":        return a.query.slice(0, 200);
    case "setRun":     return a.command.slice(0, 200);
    case "setEnv":     return Object.keys(a.vars).join(",");
    case "restart":    return "";
    case "checkpoint": return a.message;
    case "db":         return a.sql.split("\n")[0].slice(0, 200);
  }
}

/**
 * Fire-and-forget POST to /api/ai/audit. Failures are swallowed: an audit
 * outage must never block or visibly affect the AI workflow.
 */
async function logAudit(opts: {
  workspaceId: string;
  provider?: string;
  model?: string;
  action: Action;
  result: ActionResult;
}): Promise<void> {
  try {
    await fetch("/api/ai/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        workspaceId: opts.workspaceId,
        provider: opts.provider,
        model: opts.model,
        kind: opts.action.kind,
        target: actionTarget(opts.action),
        ok: opts.result.ok,
        // Cap at the same 2000-char limit the backend will truncate to.
        output: (opts.result.output ?? "").slice(0, 2000),
      }),
    });
  } catch {}
}

function actionLabel(a: Action): string {
  switch (a.kind) {
    case "bash": return `bash:run \`${a.command.split("\n")[0].slice(0, 80)}\``;
    case "file": return `file: ${a.path}`;
    case "delete": return `delete: ${a.path}`;
    case "mkdir": return `mkdir: ${a.path}`;
    case "rename": return `rename: ${a.from} → ${a.to}`;
    case "patch": return `patch: ${a.path}${a.replaceAll ? " (all)" : ""}`;
    case "search": return `search: ${a.pattern.slice(0, 60)}${a.pathGlob ? ` in:${a.pathGlob}` : ""}`;
    case "diag": return `diag:run`;
    case "test": return `test:run${a.command ? ` \`${a.command.slice(0, 60)}\`` : ""}`;
    case "web": return `web:search ${a.query.slice(0, 60)}`;
    case "setRun": return `workspace:setRun \`${a.command.slice(0, 80)}\``;
    case "setEnv": {
      const keys = Object.keys(a.vars);
      return `workspace:setEnv (${keys.length}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""})`;
    }
    case "restart": return "workspace:restart";
    case "checkpoint": return `workspace:checkpoint "${a.message}"`;
    case "db": return `db:query \`${a.sql.split("\n")[0].slice(0, 80)}\``;
  }
}

function formatToolResults(actions: Action[], results: ActionResult[]): string {
  const lines: string[] = ["Tool results:"];
  actions.forEach((a, i) => {
    const r = results[i];
    if (!r) {
      lines.push(`${i + 1}. ${actionLabel(a)} — (skipped)`);
      return;
    }
    lines.push(`${i + 1}. ${actionLabel(a)} — ${r.ok ? "OK" : "ERROR"}`);
    const trimmed = (r.output || "").trim();
    if (trimmed) {
      const snippet = trimmed.length > 1500
        ? trimmed.slice(0, 1500) + "\n…(truncated)"
        : trimmed;
      lines.push("```");
      lines.push(snippet);
      lines.push("```");
    }
  });
  return lines.join("\n");
}

// Effectively unlimited per user request — the orchestrator runs until
// the AI stops emitting actions or the user clicks Stop. The 999 cap is
// only a runaway-loop safety net (a model emitting an action every turn
// for 999 turns would hit ~16 million tokens of activity, which is a
// clear pathology worth aborting). Real interactive sessions never get
// near this number.
const MAX_AUTO_ITERATIONS = 999;

// Cheap detector used by the auto-continue loop in sendRaw(). Returns true
// if `text` contains at least one action-fence header (```file:foo.html /
// ```patch:bar.ts / etc.) that lacks a matching closing fence — which is
// the signature of a model reply that ran out of output tokens mid-action
// and would otherwise show up as a yellow "OUTPUT TERPOTONG" badge.
//
// We deliberately keep this simple: we only need a yes/no signal. The full
// per-fence walk lives in parseActions() below; copying the entire bracket
// stack here would just be redundant.
function hasUnclosedActionFence(text: string): boolean {
  const ACTION_KINDS = new Set(["bash", "file", "workspace", "patch", "search", "diag", "test", "web", "db"]);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^(`{3,})([a-zA-Z]+):/);
    if (!open || !ACTION_KINDS.has(open[2])) { i++; continue; }
    const ticks = open[1].length;
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const bare = lines[j].match(/^(`{3,})\s*$/);
      // For non-`file:` actions any bare fence of matching length closes.
      // For `file:` actions we use the same simplification — false negatives
      // here only mean we MISS a continuation chance, which is safe (user
      // can still click "lanjutkan" manually). We won't false-positive
      // because a closed file: fence always has a matching bare run.
      if (bare && bare[1].length === ticks) { closed = true; break; }
      j++;
    }
    if (!closed) return true;
    i = j + 1;
  }
  return false;
}

function parseActions(text: string): { actions: Action[]; cleaned: string } {
  const ACTION_KINDS = new Set(["bash", "file", "workspace", "patch", "search", "diag", "test", "web", "db"]);
  const actions: Action[] = [];
  const lines = text.split("\n");
  const kept: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = line.match(/^(`{3,})([a-zA-Z]+):(.*)$/);
    if (!open) { kept.push(line); i++; continue; }
    const [, ticks, kind, headerRaw] = open;
    if (!ACTION_KINDS.has(kind)) { kept.push(line); i++; continue; }
    const header = headerRaw.trim();
    const isFile = kind === "file";
    const body: string[] = [];
    const stack: number[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      const inner = lines[j];
      const bare = inner.match(/^(`{3,})\s*$/);
      const labeled = inner.match(/^(`{3,})\S/);
      if (isFile) {
        if (bare) {
          const n = bare[1].length;
          if (stack.length > 0 && stack[stack.length - 1] === n) {
            stack.pop();
            body.push(inner);
          } else if (n === ticks.length) {
            closed = true; j++; break;
          } else {
            stack.push(n);
            body.push(inner);
          }
        } else if (labeled && labeled[1].length <= ticks.length) {
          stack.push(labeled[1].length);
          body.push(inner);
        } else {
          body.push(inner);
        }
      } else {
        if (bare && bare[1].length === ticks.length) { closed = true; j++; break; }
        body.push(inner);
      }
      j++;
    }
    if (!closed) { kept.push(line); i++; continue; }

    if (kind === "bash" && header === "run") {
      actions.push({ kind: "bash", command: body.join("\n").trim() });
    } else if (kind === "file" && header) {
      // Sub-commands embedded in the header: file:delete:path, file:mkdir:path,
      // file:rename:from => to. We dispatch on the first segment before the
      // colon so the AI can express filesystem ops without us inventing new
      // top-level fence kinds.
      const subDelete = header.match(/^delete:(.+)$/);
      const subMkdir = header.match(/^mkdir:(.+)$/);
      const subRename = header.match(/^rename:(.+)$/);
      if (subDelete) {
        actions.push({ kind: "delete", path: subDelete[1].trim() });
      } else if (subMkdir) {
        actions.push({ kind: "mkdir", path: subMkdir[1].trim() });
      } else if (subRename) {
        const [from, to] = subRename[1].split("=>").map((s) => s.trim());
        if (from && to) actions.push({ kind: "rename", from, to });
        else kept.push(`> Invalid file:rename header: "${header}" (expected \`from => to\`).`);
      } else {
        // Guard: never let any spelling of `.premdev` overwrite the
        // user's secrets. Strip leading slashes, /workspace/ prefix, and `./`
        // segments, then compare on the basename — covers `.premdev`,
        // `./.premdev`, `/workspace/.premdev`, `foo/../.premdev`,
        // etc.
        const cleaned = header
          .trim()
          .replace(/^\/+/, "")
          .replace(/^workspace\//, "")
          .split("/")
          .filter((seg) => seg && seg !== "." && seg !== "..");
        const basename = cleaned[cleaned.length - 1] ?? "";
        if (basename === ".premdev" || basename === ".premdev.json") {
          kept.push(`> AI tried to overwrite \`${basename}\` (blocked — use \`workspace:setRun\` / \`workspace:setEnv\` instead).`);
        } else {
          actions.push({ kind: "file", path: header, content: body.join("\n") });
        }
      }
    } else if (kind === "patch" && header) {
      // `patch:path` (or `patch:path replaceAll`). Body must contain three
      // anchor lines that consist of exactly `<<<FIND`, `===`, `>>>` (with
      // any trimmable whitespace). Anchoring on whole lines avoids the
      // earlier non-anchored regex's habit of misparsing when an AI
      // explanation includes a literal `<<<FIND` token, or when the
      // find/replace body contains a `===` rule on its own.
      const parts = header.trim().split(/\s+/);
      const path = parts[0];
      const replaceAll = parts.includes("replaceAll");
      let findIdx = -1, sepIdx = -1, endIdx = -1;
      for (let k = 0; k < body.length; k++) {
        const t = body[k].trim();
        if (findIdx === -1) { if (t === "<<<FIND") findIdx = k; }
        else if (sepIdx === -1) { if (t === "===") sepIdx = k; }
        else if (endIdx === -1) { if (t === ">>>") { endIdx = k; break; } }
      }
      if (!path) {
        kept.push(`> Invalid patch header: missing path.`);
      } else if (findIdx === -1 || sepIdx === -1 || endIdx === -1) {
        kept.push(`> Invalid patch:${path} body — need three anchor lines: \`<<<FIND\`, \`===\`, \`>>>\` (each on its own line).`);
      } else {
        const find = body.slice(findIdx + 1, sepIdx).join("\n");
        const replace = body.slice(sepIdx + 1, endIdx).join("\n");
        if (!find) {
          kept.push(`> Invalid patch:${path} body — empty FIND section.`);
        } else {
          actions.push({ kind: "patch", path, find, replace, replaceAll });
        }
      }
    } else if (kind === "search" && (header === "run" || header === "")) {
      // First non-empty body line: pattern + optional `in:<glob>` + optional `regex` flag.
      const first = (body.find((l) => l.trim() !== "") ?? "").trim();
      if (!first) {
        kept.push(`> Empty search:run body — provide a pattern.`);
      } else {
        // Strip trailing flags so the pattern itself can contain spaces.
        let pattern = first;
        let pathGlob: string | undefined;
        let regex = false;
        const inMatch = pattern.match(/\s+in:(\S+)/);
        if (inMatch) { pathGlob = inMatch[1]; pattern = pattern.replace(/\s+in:\S+/, ""); }
        if (/\s+regex\b/.test(pattern)) { regex = true; pattern = pattern.replace(/\s+regex\b/, ""); }
        actions.push({ kind: "search", pattern: pattern.trim(), pathGlob, regex });
      }
    } else if (kind === "diag" && (header === "run" || header === "")) {
      actions.push({ kind: "diag" });
    } else if (kind === "test" && (header === "run" || header === "")) {
      // Optional first body line: a custom test command override (e.g.
      // "npm test -- --runInBand"). Empty body falls back to auto-detect.
      const first = (body.find((l) => l.trim() !== "") ?? "").trim();
      actions.push({ kind: "test", command: first || undefined });
    } else if (kind === "web" && header === "search") {
      const first = (body.find((l) => l.trim() !== "") ?? "").trim();
      if (!first) {
        kept.push(`> Empty web:search body — provide a query.`);
      } else {
        actions.push({ kind: "web", query: first });
      }
    } else if (kind === "db" && (header === "query" || header === "")) {
      const sql = body.join("\n").trim();
      if (!sql) {
        kept.push(`> Empty db:query body — provide one SQL statement.`);
      } else {
        actions.push({ kind: "db", sql });
      }
    } else if (kind === "workspace") {
      if (header === "restart") {
        actions.push({ kind: "restart" });
      } else if (header.startsWith("checkpoint")) {
        const m = header.match(/message="([^"]*)"/);
        actions.push({ kind: "checkpoint", message: m?.[1] || "Auto checkpoint" });
      } else if (header === "setRun") {
        const cmd = body.join("\n").trim();
        if (cmd) actions.push({ kind: "setRun", command: cmd });
      } else if (header === "setEnv") {
        const vars: Record<string, string> = {};
        for (const raw of body) {
          const ln = raw.trim();
          if (!ln || ln.startsWith("#")) continue;
          const eq = ln.indexOf("=");
          if (eq <= 0) continue;
          const k = ln.slice(0, eq).trim();
          let v = ln.slice(eq + 1).trim();
          // Strip optional surrounding quotes for convenience.
          if ((v.startsWith(`"`) && v.endsWith(`"`)) || (v.startsWith(`'`) && v.endsWith(`'`))) {
            v = v.slice(1, -1);
          }
          if (k) vars[k] = v;
        }
        if (Object.keys(vars).length > 0) actions.push({ kind: "setEnv", vars });
      } else {
        kept.push(line, ...body, lines[j - 1]);
      }
    }
    i = j;
  }
  return { actions, cleaned: kept.join("\n") };
}

/* ===========================  Markdown render  =========================== */

type MdNode =
  | { type: "code"; lang: string; text: string }
  | { type: "para"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string }
  // Placeholder shown in chat WHILE an AI action block is still streaming
  // (the parseActions() pass strips closed action blocks for us; anything
  // left in `cleaned` whose fence header looks like an action kind is, by
  // definition, a fence that hasn't closed yet — we collapse it so the
  // user doesn't see hundreds of lines of HTML/CSS streaming as raw text).
  | { type: "actionPreview"; kind: string; header: string; lines: number; complete: boolean };

// Fence kinds that should NEVER be rendered as raw code in the chat —
// they are meant to be executed via ActionCard, not displayed inline.
const ACTION_FENCE_KINDS = new Set([
  "bash", "file", "patch", "search", "diag", "test", "web", "workspace", "db",
]);

function parseMarkdown(text: string): MdNode[] {
  const out: MdNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Match BOTH 3- and 4-backtick fences, AND any header text (action
    // kinds like `file:index.html` use `:` and `/` chars not allowed by
    // the lang-only regex below).
    const anyFence = line.match(/^(`{3,4})(.*)$/);
    if (anyFence) {
      const ticks = anyFence[1];
      const headerRaw = anyFence[2].trim();
      // Detect action-fence kind: must look like `<kind>:<rest>`. A bare
      // `bash` / `python` is a normal code block, not an action — only
      // headers with a colon (e.g. `bash:run`, `file:index.html`,
      // `db:query`) are treated as collapsible action previews.
      const kindMatch = headerRaw.match(/^([a-zA-Z]+):/);
      const kind = kindMatch?.[1] ?? "";
      if (kind && ACTION_FENCE_KINDS.has(kind)) {
        // Action fence — collapse body, hide content. Closing fence must
        // match the same number of backticks (file: uses 4, others 3).
        const closeRe = new RegExp("^" + ticks + "\\s*$");
        const buf: string[] = [];
        i++;
        let complete = false;
        while (i < lines.length) {
          if (closeRe.test(lines[i])) { complete = true; i++; break; }
          buf.push(lines[i]); i++;
        }
        out.push({
          type: "actionPreview",
          kind,
          header: headerRaw,
          lines: buf.length,
          complete,
        });
        continue;
      }
      // Plain code fence (lang only, e.g. ```js / ```python). Only
      // recognise when header is a bare language token; otherwise treat
      // the line as paragraph text so we don't accidentally swallow body
      // content.
      if (ticks.length === 3 && /^[a-zA-Z0-9_+-]*$/.test(headerRaw)) {
        const lang = headerRaw;
        const buf: string[] = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // consume closing fence
        out.push({ type: "code", lang, text: buf.join("\n") });
        continue;
      }
      // Anything else (4-tick fence with no recognised action) — treat as
      // text so we don't swallow content silently.
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      out.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push({ type: "list", items });
      continue;
    }
    if (/^>\s+/.test(line)) {
      out.push({ type: "quote", text: line.replace(/^>\s+/, "") });
      i++; continue;
    }
    if (line.trim() === "") { i++; continue; }
    // Paragraph: gather consecutive non-empty, non-special lines
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^>\s+/.test(lines[i])
    ) { buf.push(lines[i]); i++; }
    out.push({ type: "para", text: buf.join("\n") });
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  // Allow only http(s), mailto, and relative paths
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  if (/^\//.test(trimmed) && !/^\/\//.test(trimmed)) return trimmed;
  return null;
}

function renderInline(text: string): string {
  // Tokenize so we never re-process content already inside a tag we generated.
  type Tok = { kind: "text" | "html"; v: string };
  let toks: Tok[] = [{ kind: "text", v: text }];

  function applyRegex(re: RegExp, transform: (m: RegExpExecArray) => string) {
    const next: Tok[] = [];
    for (const t of toks) {
      if (t.kind !== "text") { next.push(t); continue; }
      let last = 0;
      let m: RegExpExecArray | null;
      const src = t.v;
      const reG = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = reG.exec(src))) {
        if (m.index > last) next.push({ kind: "text", v: src.slice(last, m.index) });
        const replacement = transform(m);
        if (replacement === "") {
          // Couldn't transform — emit as plain text
          next.push({ kind: "text", v: m[0] });
        } else {
          next.push({ kind: "html", v: replacement });
        }
        last = m.index + m[0].length;
        if (m[0].length === 0) reG.lastIndex++;
      }
      if (last < src.length) next.push({ kind: "text", v: src.slice(last) });
    }
    toks = next;
  }

  // 1) inline code: `...` (highest priority)
  applyRegex(/`([^`\n]+)`/g, (m) =>
    `<code class="rounded bg-bg px-1 py-[1px] font-mono text-[12px]">${escapeHtml(m[1])}</code>`
  );
  // 2) links: [text](url)
  applyRegex(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m) => {
    const href = safeHref(m[2]);
    if (!href) return ""; // fall back to literal
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="text-accent underline">${escapeHtml(m[1])}</a>`;
  });
  // 3) bold: **...**
  applyRegex(/\*\*([^*\n]+)\*\*/g, (m) => `<strong>${escapeHtml(m[1])}</strong>`);
  // 4) italic: *...* / _..._
  applyRegex(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, (m) =>
    `${escapeHtml(m[1])}<em>${escapeHtml(m[2])}</em>`
  );
  applyRegex(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, (m) =>
    `${escapeHtml(m[1])}<em>${escapeHtml(m[2])}</em>`
  );

  return toks.map((t) => (t.kind === "text" ? escapeHtml(t.v) : t.v)).join("");
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); } catch {}
      }}
      className="ml-auto flex items-center gap-1 rounded bg-bg-subtle px-2 py-[2px] text-[10px] text-text-muted hover:text-text"
      title="Copy"
    >
      {done ? <Check size={10} /> : <Copy size={10} />} {done ? "Copied" : "Copy"}
    </button>
  );
}

function Markdown({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="space-y-2">
      {nodes.map((n, i) => {
        if (n.type === "code") {
          return (
            <div key={i} className="overflow-hidden rounded border border-bg-border bg-bg">
              <div className="flex items-center gap-2 border-b border-bg-border px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted">
                <span>{n.lang || "code"}</span>
                <CopyBtn text={n.text} />
              </div>
              <pre className="overflow-auto p-2 font-mono text-[12px] leading-relaxed">{n.text}</pre>
            </div>
          );
        }
        if (n.type === "actionPreview") {
          // Compact placeholder shown ONLY while the AI is still streaming
          // an action block (the body hasn't received its closing fence yet).
          // Once the block closes, parseActions() strips it and an
          // ActionCard takes over below the message.
          const icon = n.kind === "file" || n.kind === "patch" ? "📄"
            : n.kind === "db" ? "🗄"
            : n.kind === "bash" ? "⚡"
            : n.kind === "search" ? "🔍"
            : n.kind === "diag" || n.kind === "test" ? "🩺"
            : n.kind === "web" ? "🌐"
            : "⚙";
          const label = n.header || n.kind;
          // An action fence that NEVER closed AND streaming has stopped =
          // the model was cut off mid-write (usually by max_tokens). Show
          // a clear warning instead of "sedang ditulis" forever — without
          // this, the user just stares at a stuck placeholder with no
          // ActionCard to approve and no way to know what went wrong.
          const truncated = !n.complete && !isStreaming;
          const status = n.complete
            ? `${n.lines} baris`
            : truncated
              ? `⚠ output terpotong · ${n.lines} baris — auto-lanjut aktif (atau minta AI "lanjutkan")`
              : `sedang ditulis · ${n.lines} baris`;
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded border px-2 py-1 text-[12px] ${
                truncated
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-200"
                  : "border-bg-border bg-bg text-text-muted"
              }`}
              title={truncated
                ? `${n.kind}:${n.header} — model berhenti sebelum menutup blok (kemungkinan kena batas token). Suruh AI "lanjutkan ${n.header}" atau naikkan AI_MAX_TOKENS_DEFAULT di .env.`
                : `${n.kind}:${n.header}`}
            >
              <span>{icon}</span>
              <span className="font-mono text-text">{label}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wide">{status}</span>
            </div>
          );
        }
        if (n.type === "heading") {
          const sz = n.level <= 2 ? "text-base font-bold" : n.level === 3 ? "text-sm font-semibold" : "text-xs font-semibold uppercase tracking-wide";
          return <div key={i} className={sz} dangerouslySetInnerHTML={{ __html: renderInline(n.text) }} />;
        }
        if (n.type === "list") {
          return (
            <ul key={i} className="ml-4 list-disc space-y-0.5">
              {n.items.map((it, k) => (
                <li key={k} dangerouslySetInnerHTML={{ __html: renderInline(it) }} />
              ))}
            </ul>
          );
        }
        if (n.type === "quote") {
          return (
            <blockquote key={i} className="border-l-2 border-bg-border pl-2 text-text-muted"
              dangerouslySetInnerHTML={{ __html: renderInline(n.text) }} />
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap leading-relaxed"
            dangerouslySetInnerHTML={{ __html: renderInline(n.text) }} />
        );
      })}
    </div>
  );
}

/* ============================  Main component  ============================ */

// ----------------------------- Chat tabs ------------------------------------
// Each workspace can hold N independent chat conversations ("tabs"), so the
// user can iterate on one feature without polluting the context window with
// an unrelated thread. Storage layout:
//   premdev:chat:tabs:<wsid>          → JSON: Tab[]                (tab list)
//   premdev:chat:active-tab:<wsid>    → tabId                       (selection)
//   premdev:chat:tab:<wsid>:<tabId>   → JSON: Msg[]                 (messages)
// `LEGACY_HISTORY_KEY` is the pre-tabs single-chat key — read once on first
// mount so users don't lose their existing conversations.
type Tab = { id: string; name: string };
const TABS_KEY = (wsid: string) => `premdev:chat:tabs:${wsid}`;
const ACTIVE_TAB_KEY = (wsid: string) => `premdev:chat:active-tab:${wsid}`;
const TAB_MSGS_KEY = (wsid: string, tabId: string) => `premdev:chat:tab:${wsid}:${tabId}`;
const LEGACY_HISTORY_KEY = (wsid: string) => `premdev:chat:${wsid}`;
// Background AI job pointer for crash/refresh recovery. Stores just the
// server-side jobId; the actual streamed text lives on the server until
// we reconnect to the SSE endpoint and replay from offset.
const JOB_KEY = (wsid: string, tabId: string) => `premdev:chat:job:${wsid}:${tabId}`;

// =============================================================================
// SSE stream helper — used by both sendRaw (initial connect) and the mount-
// time recovery effect (reconnect after refresh). Parses the server's SSE
// frames manually because we need explicit reconnect control: the browser's
// EventSource silently auto-reconnects from offset=0 on a network blip,
// which would re-deliver chunks we've already rendered.
// =============================================================================
async function streamSSEJob(
  jobId: string,
  offset: number,
  signal: AbortSignal,
  onChunk: (text: string) => void,
): Promise<{ status: "done" | "error" | "aborted"; error?: string }> {
  const res = await fetch(`/api/ai/chat/jobs/${jobId}/stream?offset=${offset}`, {
    credentials: "include",
    signal,
    // Hint to fetch that we want a long-lived stream; same headers the
    // server returns. Without these some intermediaries (corp proxies)
    // try to gzip the response, breaking SSE framing.
    headers: { Accept: "text/event-stream" },
  });
  if (res.status === 404) return { status: "error", error: "Job not found" };
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    return { status: "error", error: txt || res.statusText };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finalStatus: "done" | "error" | "aborted" = "done";
  let finalError: string | undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // SSE frames are separated by a blank line ("\n\n"). Each frame
      // can have multiple `event:` / `data:` lines. We only emit our own
      // two event names: "chunk" and "done".
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue; // heartbeat / comment
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
        }
        if (ev === "chunk" && data) {
          try {
            const parsed = JSON.parse(data);
            if (typeof parsed.text === "string") onChunk(parsed.text);
          } catch { /* malformed frame — drop */ }
        } else if (ev === "done") {
          try {
            const parsed = JSON.parse(data);
            finalStatus = parsed.status || "done";
            finalError = parsed.error;
          } catch { finalStatus = "done"; }
          // Server closes after `done`; reader will return done=true on
          // next read. Break early so we don't block awaiting it.
          try { reader.cancel(); } catch {}
          return { status: finalStatus, error: finalError };
        }
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return { status: "aborted" };
    return { status: "error", error: e?.message || String(e) };
  }
  return { status: finalStatus, error: finalError };
}

function loadTabState(wsid: string): { tabs: Tab[]; active: string } {
  try {
    const raw = localStorage.getItem(TABS_KEY(wsid));
    let tabs: Tab[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(tabs) || tabs.length === 0) {
      tabs = [{ id: "default", name: "Chat 1" }];
      // One-time migration: if the user already had a single-tab chat
      // history under the legacy key, copy it into the default tab so
      // they don't lose anything when the tab strip first appears.
      try {
        const legacy = localStorage.getItem(LEGACY_HISTORY_KEY(wsid));
        if (legacy && !localStorage.getItem(TAB_MSGS_KEY(wsid, "default"))) {
          localStorage.setItem(TAB_MSGS_KEY(wsid, "default"), legacy);
        }
      } catch {}
      try { localStorage.setItem(TABS_KEY(wsid), JSON.stringify(tabs)); } catch {}
    }
    const activeRaw = localStorage.getItem(ACTIVE_TAB_KEY(wsid));
    const active = activeRaw && tabs.some((t) => t.id === activeRaw) ? activeRaw : tabs[0].id;
    return { tabs, active };
  } catch {
    return { tabs: [{ id: "default", name: "Chat 1" }], active: "default" };
  }
}

function loadTabMsgs(wsid: string, tabId: string): Msg[] {
  try {
    const raw = localStorage.getItem(TAB_MSGS_KEY(wsid, tabId));
    return raw ? (JSON.parse(raw) as Msg[]) : [];
  } catch { return []; }
}

export function AIChat({
  workspaceId,
  onWorkspaceMutated,
  onFilesMutated,
}: {
  workspaceId: string;
  onWorkspaceMutated?: () => void;
  onFilesMutated?: () => void;
}) {
  const initialTabState = (() => loadTabState(workspaceId))();
  const [tabs, setTabs] = useState<Tab[]>(initialTabState.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(initialTabState.active);
  const [msgs, setMsgs] = useState<Msg[]>(() => loadTabMsgs(workspaceId, initialTabState.active));
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [imgError, setImgError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<Provider["id"]>("openai");
  const [model, setModel] = useState<string>("");
  const [streaming, setStreaming] = useState(false);
  // Default ON: with autopilot off the AI just explains commands instead of
  // proposing approve-able action blocks, which surprises users.
  const [autoPilot, setAutoPilot] = useState(true);
  // Autonomous mode: actions auto-execute (no Approve), and after each batch
  // the tool results are fed back so the AI can keep iterating until done.
  const [autonomous, setAutonomous] = useState<boolean>(() => {
    try { return localStorage.getItem("premdev:ai:autonomous") === "1"; }
    catch { return false; }
  });
  // Plan mode (Batch A #13): when ON, the next user message is wrapped with
  // "Tampilkan rencana dulu, JANGAN emit action blocks. Tunggu konfirmasi."
  // so the AI describes its plan first and the user can confirm before
  // anything touches the workspace.
  const [planMode, setPlanMode] = useState<boolean>(() => {
    try { return localStorage.getItem("premdev:ai:planMode") === "1"; }
    catch { return false; }
  });
  // Snippet library (Batch A #23): user-saved prompt templates persisted in
  // localStorage. Snippets are global per browser, not per-workspace, since
  // most are reusable starters like "review for security issues".
  type Snippet = { id: string; label: string; text: string };
  const [snippets, setSnippets] = useState<Snippet[]>(() => {
    try {
      const raw = localStorage.getItem("premdev:ai:snippets");
      if (raw) return JSON.parse(raw) as Snippet[];
    } catch {}
    return [
      { id: "rev",  label: "Review for bugs", text: "Review the currently-open file for bugs, race conditions, and edge cases. Don't change code yet — just list findings with severity." },
      { id: "test", label: "Add tests",        text: "Generate tests for the currently-open file. After writing them, run test:run." },
      { id: "doc",  label: "Add JSDoc",        text: "Add concise JSDoc / docstring comments to every exported function in the currently-open file. Don't change behavior." },
      { id: "perf", label: "Profile slow path",text: "Identify the hottest path in this file and propose 1-2 concrete optimisations with measured trade-offs." },
    ];
  });
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // Voice input (Batch C #21): Web Speech API. Browser-only; gracefully
  // disabled when the API isn't present (Firefox, older Safari).
  const [voiceOn, setVoiceOn] = useState(false);
  const recognitionRef = useRef<any>(null);
  const voiceSupported = typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  const iterationRef = useRef<number>(0);
  const stoppedRef = useRef<boolean>(false);
  // Per-message action results: msgIdx -> [results]. Filled sequentially by
  // the autonomous orchestrator below; ActionCard reads from this map to
  // display the outcome without ever running the action itself.
  const [actionResults, setActionResults] = useState<Map<number, ActionResult[]>>(
    new Map(),
  );
  // True while the autonomous orchestrator is running an action batch (so
  // Stop stays visible even when the model isn't streaming).
  const [autoExecuting, setAutoExecuting] = useState(false);
  // msgIdx values whose action batch we've already orchestrated. Prevents the
  // continuation effect from re-triggering on the same batch.
  const processedBatchesRef = useRef<Set<number>>(new Set());
  // msgIdx values whose action batch is owned by the orchestrator (display-
  // only ActionCards). Frozen at orchestration start so toggling the Otonom
  // checkbox mid-batch can't re-expose manual Approve/Edit/Skip controls.
  const [autoManagedBatches, setAutoManagedBatches] = useState<Set<number>>(
    new Set(),
  );
  const abortRef = useRef<AbortController | null>(null);
  // Server-side job id of the in-flight chat round. Set the moment POST
  // /chat returns and cleared on terminal SSE event. Used by stop() to
  // abort the upstream provider stream on the server (independent of our
  // local SSE fetch) and by the recovery effect to skip re-connecting to
  // a job we're already streaming.
  const activeJobIdRef = useRef<string | null>(null);
  // Auto-continue: counts how many continuation rounds we've fired for the
  // CURRENT user turn. Reset to 0 in send() (i.e. when the user types a
  // genuinely new message). Capped by MAX_CONTINUATIONS so a stuck model
  // can't burn the user's tokens in an infinite loop.
  const continuationCountRef = useRef<number>(0);
  // Queue for messages typed while the AI is still streaming. Contents are
  // flushed (one by one, in order) after the current sendRaw call chain
  // finishes. The displayed count drives the "N pesan di-queue" pill.
  const pendingQueueRef = useRef<string[]>([]);
  const [queuedCount, setQueuedCount] = useState<number>(0);
  // Effectively unlimited (was 10, then user asked for no limit at all).
  // Same runaway-loop safety net rationale as MAX_AUTO_ITERATIONS — 999
  // rounds × 16k output ≈ 16M tokens, well past any legitimate single
  // user turn. The real bounds are the user's wallet and the Stop button.
  const MAX_CONTINUATIONS = 999;
  // Mirror of the latest committed `msgs` state, kept in sync via the
  // useEffect below. Needed because `sendRaw()` recursively re-invokes
  // itself for auto-continuation; the recursive call would otherwise
  // capture the parent invocation's stale `msgs` closure (predating the
  // truncated assistant turn that was just streamed in via setMsgs).
  // Reading from `msgsRef.current` instead of the closured `msgs`
  // guarantees the next request includes the full prior history.
  const msgsRef = useRef<Msg[]>([]);
  // AbortController for the action HTTP request currently in-flight inside
  // the orchestrator. Stop calls .abort() on this so the orchestrator's
  // `await runAction(...)` returns immediately instead of blocking until the
  // server-side timeout (~120s for /exec).
  const actionAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem("premdev:ai:autonomous", autonomous ? "1" : "0"); }
    catch {}
  }, [autonomous]);

  useEffect(() => {
    try { localStorage.setItem("premdev:ai:planMode", planMode ? "1" : "0"); }
    catch {}
  }, [planMode]);

  useEffect(() => {
    try { localStorage.setItem("premdev:ai:snippets", JSON.stringify(snippets)); }
    catch {}
  }, [snippets]);

  // Stop dictation as soon as the panel unmounts so the mic LED doesn't
  // stay on after the user closes the chat tab.
  useEffect(() => {
    return () => {
      try { recognitionRef.current?.stop?.(); } catch {}
    };
  }, []);

  // External prefill: lets Editor.tsx (selection-based ask, quick-actions
  // toolbar, etc.) push text into the chat input without prop drilling.
  // Detail: { text: string, send?: boolean }.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { text?: string; send?: boolean } | undefined;
      const t = (detail?.text || "").trim();
      if (!t) return;
      setInput((prev) => prev ? prev.trimEnd() + "\n\n" + t : t);
      if (detail?.send) {
        // Defer one tick so React commits the new input before we fire send.
        setTimeout(() => { try { sendBtnRef.current?.click(); } catch {} }, 50);
      }
    };
    window.addEventListener("premdev:ai:prefill", handler as EventListener);
    return () => window.removeEventListener("premdev:ai:prefill", handler as EventListener);
  }, []);
  const sendBtnRef = useRef<HTMLButtonElement>(null);

  function toggleVoice() {
    if (!voiceSupported) return;
    if (voiceOn) {
      try { recognitionRef.current?.stop?.(); } catch {}
      setVoiceOn(false);
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let finalText = "";
    rec.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      // Append voice text to whatever the user has already typed; keep the
      // ongoing interim chunk visible so they see it transcribing live.
      setInput((prev) => {
        // Strip any previously appended interim block (delimited by ⟨…⟩) so
        // we don't accumulate every interim revision.
        const base = prev.replace(/\s*⟨[^⟩]*⟩\s*$/, "").trimEnd();
        const next = (base ? base + " " : "") + finalText + (interim ? `⟨${interim}⟩` : "");
        return next;
      });
    };
    rec.onerror = () => { setVoiceOn(false); };
    rec.onend = () => {
      // Clean up any leftover interim marker on stop.
      setInput((prev) => prev.replace(/\s*⟨[^⟩]*⟩\s*$/, "").trim());
      setVoiceOn(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setVoiceOn(true);
    } catch {
      setVoiceOn(false);
    }
  }

  function insertSnippet(s: Snippet) {
    setInput((prev) => prev ? prev.trimEnd() + "\n\n" + s.text : s.text);
    setSnippetsOpen(false);
  }
  function saveCurrentAsSnippet() {
    const txt = input.trim();
    if (!txt) { alert("Tulis dulu prompt-nya, baru simpan sebagai snippet."); return; }
    const label = window.prompt("Snippet name:", txt.slice(0, 40));
    if (!label) return;
    setSnippets((prev) => [{ id: Math.random().toString(36).slice(2, 10), label, text: txt }, ...prev].slice(0, 30));
  }
  function deleteSnippet(id: string) {
    setSnippets((prev) => prev.filter((s) => s.id !== id));
  }

  const { data: providers } = useQuery({
    queryKey: ["ai", "providers"],
    queryFn: () => API.get<{ providers: Provider[] }>("/ai/providers"),
    staleTime: 60_000,
  });

  // The (workspace, tab) key the current `msgs` was loaded from. Stored in
  // state — and updated in the SAME setState batch as setMsgs() — so the
  // persistence effect can verify msgs and key are in sync before writing.
  // Using state (not a ref) means each transient render the component goes
  // through during a workspace switch sees a coherent snapshot: msgs and
  // msgsKey are both either pre-switch or post-switch, never mixed. The
  // persistence effect skips the write whenever msgsKey doesn't match the
  // currently-rendered (workspaceId, activeTabId), which is exactly the
  // window where the previous tab's history would otherwise get written to
  // the new tab's storage slot.
  const [msgsKey, setMsgsKey] = useState<string>(
    `${workspaceId}::${initialTabState.active}`
  );

  // Reload tab list + active tab + msgs when workspace changes.
  useEffect(() => {
    const { tabs: nextTabs, active } = loadTabState(workspaceId);
    setTabs(nextTabs);
    setActiveTabId(active);
    setMsgs(loadTabMsgs(workspaceId, active));
    setMsgsKey(`${workspaceId}::${active}`);
  }, [workspaceId]);

  // Reload msgs when the active tab changes within the same workspace, and
  // remember the selection so a hard refresh restores the right tab.
  useEffect(() => {
    setMsgs(loadTabMsgs(workspaceId, activeTabId));
    setMsgsKey(`${workspaceId}::${activeTabId}`);
    try { localStorage.setItem(ACTIVE_TAB_KEY(workspaceId), activeTabId); } catch {}
    // Intentionally omit `workspaceId` — the workspace effect above already
    // calls setMsgs in lock-step with setActiveTabId, and adding workspaceId
    // here would cause a double-load on every workspace switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // ================== Persistent AI run — recovery on mount ===============
  // Decoupling the AI run from the HTTP request lifecycle (see
  // apps/api/src/lib/ai-jobs.ts) means a tab close / refresh / network
  // blip no longer kills the upstream stream. On mount and on
  // workspace+tab switch, we look for a saved jobId for this tab and, if
  // the server still has a record of it (running OR recently finished),
  // reconnect to its SSE stream and pick up where we left off.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    (async () => {
      let jobId: string | null = null;
      try { jobId = localStorage.getItem(JOB_KEY(workspaceId, activeTabId)); } catch {}
      if (!jobId) {
        // Server-side fallback: localStorage may be empty for old chats that
        // started before the JOB_KEY scheme existed, for chats in other tabs
        // whose jobId was never copied to this tab's localStorage, or when the
        // user cleared storage. Ask the server for any active job in this
        // workspace+tab and reconnect to the most relevant one.
        try {
          const r = await fetch(
            `/api/ai/chat/jobs/active?workspaceId=${encodeURIComponent(workspaceId)}`,
            { credentials: "include", signal: ac.signal },
          );
          if (r.ok) {
            const data = (await r.json()) as {
              jobs: Array<{ id: string; tabId: string; bufferLen: number }>;
            };
            // Prefer an exact tab match so we don't hijack another tab's job.
            // Fall back to the most recently created active job (last in array)
            // only when the tab was reloaded without localStorage.
            const match =
              data.jobs.find((j) => j.tabId === activeTabId) ??
              (data.jobs.length > 0 ? data.jobs[data.jobs.length - 1] : null);
            if (match) {
              jobId = match.id;
              // Save to localStorage so subsequent refreshes use the fast path.
              try { localStorage.setItem(JOB_KEY(workspaceId, activeTabId), jobId); } catch {}
            }
          }
        } catch {
          // Network error or server not reachable — fall through silently.
        }
      }
      if (!jobId) return;
      // Skip if we're already streaming this exact job (e.g. React strict
      // mode double-mount in dev): activeJobIdRef is set during sendRaw
      // and cleared when its SSE stream resolves.
      if (activeJobIdRef.current === jobId) return;
      // Compute reconnect offset from whatever we have rendered locally
      // for the last assistant bubble. Server replays from this offset
      // onwards so we don't double-render the chunks already on screen.
      const lastMsg = msgsRef.current[msgsRef.current.length - 1];
      const offset = lastMsg && lastMsg.role === "assistant" ? lastMsg.content.length : 0;

      activeJobIdRef.current = jobId;
      abortRef.current = ac;
      setStreaming(true);
      // Accumulator seeded with whatever's on screen so onChunk just
      // appends — keeps the bubble visually continuous through the
      // refresh.
      let acc = lastMsg && lastMsg.role === "assistant" ? lastMsg.content : "";
      // If the saved msgs array doesn't end with an assistant placeholder
      // (rare — usually the last entry IS the in-progress assistant),
      // inject one so the streamed bytes have somewhere to land.
      if (!lastMsg || lastMsg.role !== "assistant") {
        const placeholder: Msg = { role: "assistant", content: "", provider, model };
        const next = [...msgsRef.current, placeholder];
        msgsRef.current = next;
        setMsgs(next);
      }

      let result: { status: "done" | "error" | "aborted"; error?: string } | null = null;
      try {
        result = await streamSSEJob(jobId, offset, ac.signal, (text) => {
          if (cancelled) return;
          acc += text;
          setMsgs((cur) => {
            const c = [...cur];
            const prev = c[c.length - 1];
            if (prev?.role === "assistant") {
              c[c.length - 1] = { ...prev, content: acc };
              msgsRef.current = c;
            }
            return c;
          });
        });
      } finally {
        // Lifecycle teardown MUST run even when this effect was cancelled
        // (tab/workspace switch). The previous "if (cancelled) return"
        // exit-before-cleanup path left activeJobIdRef + streaming stuck
        // forever, blocking subsequent sends. Compare-and-clear protects
        // against the case where a newer effect run has already taken
        // ownership of the shared refs (different jobId stored).
        if (activeJobIdRef.current === jobId) {
          activeJobIdRef.current = null;
          abortRef.current = null;
          setStreaming(false);
        }
        // localStorage strategy:
        // - cancelled (user switched tab/refreshed): keep saved jobId so
        //   the next mount can resume.
        // - terminal done/error: clear so we don't re-attach to a job
        //   that's no longer interesting.
        // - 404 "Job not found": clear — the server lost it, no point
        //   retrying.
        if (!cancelled && result) {
          const term =
            result.status === "done" ||
            result.status === "error";
          if (term) {
            try { localStorage.removeItem(JOB_KEY(workspaceId, activeTabId)); } catch {}
          }
        }
      }

      if (cancelled) return;
      if (!result) return;
      if (result.status === "error" && result.error && result.error !== "Job not found") {
        // Surface the error inline only if it's a real provider failure;
        // a missing-job 404 just means the in-memory job was GC'd / lost
        // to a server restart, in which case the user already has the
        // partial reply on screen and we silently stop.
        setMsgs((cur) => {
          const c = [...cur];
          const prev = c[c.length - 1];
          if (prev?.role === "assistant") {
            c[c.length - 1] = { ...prev, content: (prev.content || "") + `\n[Error: ${result!.error}]` };
            msgsRef.current = c;
          }
          return c;
        });
      }
      // Auto-continue parity with sendRaw: if the recovered run ended
      // with an unclosed action fence, fire the same continuation
      // recursion the original sendRaw path would have. Without this,
      // a refresh during a truncated reply would leave the user with a
      // half-written file action and no recovery.
      if (
        result.status === "done" &&
        !stoppedRef.current &&
        continuationCountRef.current < MAX_CONTINUATIONS &&
        hasUnclosedActionFence(acc)
      ) {
        continuationCountRef.current += 1;
        await sendRaw(
          `Lanjutkan output yang terpotong. Re-emit action block dengan chunked patches dan tutup fence-nya.`,
          undefined,
          { synthetic: true, continuation: true },
        );
      }
    })();
    return () => {
      cancelled = true;
      try { ac.abort(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, activeTabId]);

  // Persist tab list whenever it changes.
  useEffect(() => {
    try { localStorage.setItem(TABS_KEY(workspaceId), JSON.stringify(tabs)); } catch {}
  }, [tabs, workspaceId]);

  // Persist messages for the active tab — but only when msgsKey (which was
  // updated atomically alongside setMsgs above) matches the in-render
  // (workspaceId, activeTabId). On a workspace switch, the transient render
  // shows the new workspaceId but stale msgs+msgsKey, so the keys don't
  // match and we skip the write; the next render (after React applies the
  // batched setters) sees msgs+msgsKey both pointing at the new workspace
  // and the write goes through.
  useEffect(() => {
    const renderKey = `${workspaceId}::${activeTabId}`;
    if (msgsKey !== renderKey) return;
    // Strip synthetic auto-continuation user messages before persisting —
    // they're a transport-level artifact, not real chat content. Reloading
    // the tab should show only what the user actually typed plus the
    // assistant replies (the continuation assistant reply IS kept; only
    // the synthetic "lanjutkan" user msg is dropped).
    const persisted = msgs.filter((m) => !m.synthetic);
    try { localStorage.setItem(TAB_MSGS_KEY(workspaceId, activeTabId), JSON.stringify(persisted)); } catch {}
  }, [msgs, msgsKey, workspaceId, activeTabId]);

  useEffect(() => {
    if (!providers) return;
    const cur = providers.providers.find((p) => p.id === provider);
    if (!cur?.configured) {
      const first = providers.providers.find((p) => p.configured);
      if (first) {
        setProvider(first.id);
        setModel(first.defaultModel);
      }
    } else if (!model) {
      setModel(cur.defaultModel);
    }
  }, [providers]);

  function changeProvider(id: Provider["id"]) {
    setProvider(id);
    const p = providers?.providers.find((x) => x.id === id);
    setModel(p?.defaultModel ?? "");
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // Keep the ref in sync so the auto-continue recursion sees a fresh
    // history snapshot rather than the stale closure from its caller.
    msgsRef.current = msgs;
  }, [msgs]);

  async function sendRaw(
    userContent: string,
    images?: string[],
    opts?: { synthetic?: boolean; continuation?: boolean },
  ) {
    if (streaming) return;
    // Honor a Stop click that happened while we were `await`-ing an
    // attachment save in send(). Without this, the message would still be
    // sent to the AI after the user explicitly cancelled.
    if (stoppedRef.current) return;
    const userMsg: Msg = {
      role: "user",
      content: userContent,
      ...(images && images.length > 0 ? { images } : {}),
      ...(opts?.synthetic ? { synthetic: true } : {}),
    };
    // Use msgsRef instead of the captured `msgs` closure so an
    // auto-continuation recursion includes the assistant turn that just
    // finished streaming (which was committed via setMsgs in the parent
    // invocation but is invisible to that invocation's `msgs` snapshot).
    // Capture the active provider/model on the assistant placeholder so
    // the bubble keeps displaying the correct provenance even if the
    // user switches the dropdown before the next reply.
    const next = [
      ...msgsRef.current,
      userMsg,
      { role: "assistant" as const, content: "", provider, model },
    ];
    // Mirror to the ref SYNCHRONOUSLY so any code path that reads
    // msgsRef.current before React's commit-effect runs (e.g. an
    // immediate recursive sendRaw, or a fast Stop+Resume sequence) sees
    // the up-to-date history. The useEffect below is still the canonical
    // sync point, this is just a belt-and-suspenders to eliminate the
    // commit-timing race the architect flagged.
    msgsRef.current = next;
    setMsgs(next);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let buf = "";
    try {
      // Step 1 — kick off the run on the server. The server creates an
      // in-memory job, returns its id, and runs the upstream provider
      // stream in the background (decoupled from this HTTP request's
      // lifecycle). See apps/api/src/lib/ai-jobs.ts for the rationale.
      //
      // We INTENTIONALLY do NOT pass `ac.signal` to this POST. If the
      // user clicks Stop while the POST is in flight, aborting the
      // socket would race with the server's `reply.send` — we'd lose
      // the jobId and orphan a freshly-created server-side job (it
      // would keep burning tokens until natural completion).  Instead
      // we let the POST complete (it returns in milliseconds: just
      // builds the prompt and creates the job), THEN check
      // `stoppedRef.current` and explicitly abort the job we now know
      // the id of.
      const startRes = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workspaceId,
          tabId: activeTabId,
          provider,
          model,
          autoPilot,
          // Server-authoritative signal that this turn is an auto-continuation
          // recovery from a previously truncated reply. Cannot be forged by
          // the user typing a magic string — only our client sets this on a
          // genuine fence-truncation detection.
          continuation: opts?.continuation === true,
          messages: next.slice(0, -1),
        }),
      });
      if (!startRes.ok) {
        const txt = await startRes.text();
        throw new Error(txt || startRes.statusText);
      }
      const { jobId } = (await startRes.json()) as { jobId: string };
      activeJobIdRef.current = jobId;
      // Persist immediately so a refresh in the next millisecond can
      // still find this job and reconnect via the recovery effect.
      try { localStorage.setItem(JOB_KEY(workspaceId, activeTabId), jobId); } catch {}

      // Stop-while-POST-was-in-flight race: user clicked stop before we
      // knew the jobId. Stop now that we do.
      if (stoppedRef.current) {
        fetch(`/api/ai/chat/jobs/${jobId}/abort`, {
          method: "POST",
          credentials: "include",
        }).catch(() => {});
        try { localStorage.removeItem(JOB_KEY(workspaceId, activeTabId)); } catch {}
        return;
      }

      // Step 2 — stream the job output via the SSE endpoint. Closing the
      // tab here would NOT cancel the upstream run; the user would
      // reconnect on next mount.
      const result = await streamSSEJob(jobId, 0, ac.signal, (text) => {
        buf += text;
        setMsgs((cur) => {
          const c = [...cur];
          // Preserve the provider/model captured on the placeholder (set
          // when the assistant turn was first appended) — overwriting
          // here without spreading the old fields would erase the
          // provenance metadata mid-stream.
          const prev = c[c.length - 1];
          c[c.length - 1] = {
            ...prev,
            role: "assistant",
            content: buf,
          };
          // Keep the ref in lockstep with each streamed chunk so an
          // auto-continuation kicked off the instant streaming ends sees
          // the freshly-committed assistant turn without waiting for the
          // useEffect commit cycle.
          msgsRef.current = c;
          return c;
        });
      });

      if (result.status === "error" && result.error) {
        throw new Error(result.error);
      }
      // status === "aborted" → user clicked Stop. Whatever was streamed so
      // far stays in the bubble; we just exit the function quietly.
    } catch (e: any) {
      if (e.name !== "AbortError" && !stoppedRef.current) {
        setMsgs((cur) => {
          const c = [...cur];
          c[c.length - 1] = {
            role: "assistant",
            content: `Error: ${e.message}`,
          };
          msgsRef.current = c;
          return c;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      activeJobIdRef.current = null;
      try { localStorage.removeItem(JOB_KEY(workspaceId, activeTabId)); } catch {}
    }

    // Auto-continue: if the model's reply ended with an unclosed action
    // fence (badge would say "OUTPUT TERPOTONG"), silently re-fire the
    // chat with a `[CONT_TRUNC]` marker so the server prepends a strong
    // "continue without preamble, switch to chunked patches" instruction.
    // We cap at MAX_CONTINUATIONS rounds per user turn so a model that
    // keeps truncating doesn't loop forever.
    if (
      !stoppedRef.current &&
      continuationCountRef.current < MAX_CONTINUATIONS &&
      hasUnclosedActionFence(buf)
    ) {
      continuationCountRef.current += 1;
      // No setTimeout heuristic needed: msgsRef is updated synchronously
      // inside every setMsgs callback in this function (initial seed +
      // streaming chunks + error path), so the recursive sendRaw below
      // is guaranteed to read the just-committed assistant turn even if
      // React hasn't run its commit effects yet.
      if (!stoppedRef.current) {
        await sendRaw(
          `Lanjutkan output yang terpotong. Re-emit action block dengan chunked patches dan tutup fence-nya.`,
          undefined,
          { synthetic: true, continuation: true },
        );
      }
    }
  }

  async function send() {
    // Allow sending if there's at least text OR at least one attached image.
    if ((!input.trim() && pendingImages.length === 0) || streaming || autoExecuting) return;
    // Stop any active dictation so it can't keep mutating `input` after the
    // message has been dispatched (would otherwise produce a phantom partial
    // message in the textbox once recognition's debounced result arrives).
    if (voiceOn) {
      try { recognitionRef.current?.stop?.(); } catch {}
      setVoiceOn(false);
    }
    // Strip any in-flight voice interim marker before sending.
    let txt = input.replace(/\s*⟨[^⟩]*⟩\s*$/, "").trim();
    if (planMode) {
      // Plan mode (Batch A #13): ask for a written plan FIRST, no edits.
      // The user then says "go" / "lanjut" to actually execute.
      txt = `[PLAN MODE — JANGAN emit action blocks. Tampilkan rencana terstruktur dulu (numbered steps + file targets + risiko), tunggu konfirmasi user.]\n\n${txt}`;
    }
    const imgs = pendingImages;
    setInput("");
    setPendingImages([]);
    setImgError(null);
    iterationRef.current = 0;
    stoppedRef.current = false;
    continuationCountRef.current = 0;
    processedBatchesRef.current = new Set();
    setAutoManagedBatches(new Set());
    // Clear any pending mid-run queue from the PREVIOUS AI turn so the
    // newly typed message starts fresh. Queue items are only valid for the
    // run they were submitted during; a new send() from the user supersedes
    // any queued messages that hadn't been flushed yet.
    pendingQueueRef.current = [];
    setQueuedCount(0);

    // If the user dumped a huge paste (e.g. a 50KB error log), persist it to
    // `attached_assets/` and only show the AI a one-line reference. The AI can
    // `cat` the file on demand. Stops a single message from blowing the chat
    // history budget on every subsequent turn.
    if (txt.length > LONG_TEXT_THRESHOLD) {
      const lines = txt.split("\n").length;
      const firstLine = txt.split("\n", 1)[0].slice(0, 60).trim() || "paste";
      const slug = firstLine.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "paste";
      const saved = await saveAttachment(workspaceId, {
        kind: "text",
        filename: `${slug}.txt`,
        text: txt,
      });
      if (saved) {
        const preview = txt.slice(0, 240).replace(/\s+/g, " ").trim();
        txt = `[Pasted text disimpan ke \`${saved}\` — ${lines} baris, ${txt.length} chars. Awalnya: "${preview}…". Pakai \`bash:run cat ${saved}\` kalau butuh isi penuh.]`;
      }
    }

    await sendRaw(txt, imgs);

    // Flush mid-run queued messages one by one (oldest first). Each queued
    // message becomes a full AI turn: reset counters so continuation limits
    // apply fresh per queued message, then await sendRaw. Stop flushing if
    // the user clicked Stop during any of the flushed turns.
    while (pendingQueueRef.current.length > 0 && !stoppedRef.current) {
      const queued = pendingQueueRef.current.shift()!;
      setQueuedCount(pendingQueueRef.current.length);
      stoppedRef.current = false;
      continuationCountRef.current = 0;
      iterationRef.current = 0;
      processedBatchesRef.current = new Set();
      setAutoManagedBatches(new Set());
      await sendRaw(queued, []);
    }
    // Ensure count reflects reality after all flushes (or early stop).
    pendingQueueRef.current = [];
    setQueuedCount(0);
  }

  async function addImagesFromFiles(files: FileList | File[] | null) {
    if (!files) return;
    setImgError(null);
    const arr = Array.from(files).filter((f) => f && ACCEPTED_IMG_TYPES.includes(f.type));
    if (arr.length === 0) {
      setImgError("Only PNG / JPEG / WEBP / GIF images are supported.");
      return;
    }
    const room = MAX_IMGS_PER_MSG - pendingImages.length;
    if (room <= 0) {
      setImgError(`Max ${MAX_IMGS_PER_MSG} images per message.`);
      return;
    }
    const slice = arr.slice(0, room);
    const next: string[] = [];
    for (const f of slice) {
      if (f.size > MAX_IMG_BYTES) {
        setImgError(`"${f.name}" is larger than 5 MB.`);
        continue;
      }
      try {
        // Downscale + JPEG re-encode large images BEFORE the AI sees them.
        // Cuts upload size and prompt-token cost dramatically without
        // touching anything visible at chat thumbnail size.
        const { dataUrl, type } = await compressImage(f);
        next.push(dataUrl);
        const fname = (f.name || "image.png").replace(/\.[^.]+$/, "") +
          (type === "image/jpeg" ? ".jpg" : "." + (f.type.split("/")[1] || "png"));
        // Fire-and-forget save to `attached_assets/` so the image survives a
        // browser refresh and is referenceable from project code.
        saveAttachment(workspaceId, { kind: "image", filename: fname, dataUrl }).catch(() => {});
      } catch {
        setImgError(`Failed to read "${f.name}"`);
      }
    }
    if (next.length > 0) {
      setPendingImages((cur) => [...cur, ...next]);
    }
  }

  function removePendingImage(idx: number) {
    setPendingImages((cur) => cur.filter((_, i) => i !== idx));
  }

  // Stop both: any in-flight model stream, the in-flight action HTTP request
  // (so `await runAction(...)` resolves immediately instead of waiting for
  // the server's 120s timeout), AND the autonomous loop's continuation.
  //
  // For persistent jobs (post-refactor) we ALSO need to tell the server
  // to abort the upstream provider stream — otherwise the local fetch
  // close just orphans the server-side job, which keeps burning tokens
  // until the model finishes naturally.
  function stop() {
    stoppedRef.current = true;
    const jobId = activeJobIdRef.current;
    if (jobId) {
      // Fire-and-forget; if the network is down the local abort below
      // still ends the user's wait, and the job will eventually time out
      // server-side or be killed by the GC.
      fetch(`/api/ai/chat/jobs/${jobId}/abort`, {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
      try { localStorage.removeItem(JOB_KEY(workspaceId, activeTabId)); } catch {}
    }
    abortRef.current?.abort();
    actionAbortRef.current?.abort();
  }

  // Queue a message typed while the AI is still running. Called from the
  // Queue (+) button (visible during streaming) and from Enter key when
  // streaming is active. The text is stored in pendingQueueRef and the
  // count pill below the chat updates immediately. The actual user bubble
  // appears when the flush in send() calls sendRaw() for each queued item
  // — this avoids duplicate bubbles (sendRaw always appends its own user
  // message to msgsRef before creating the assistant placeholder).
  function queueMessage() {
    const txt = input.replace(/\s*⟨[^⟩]*⟩\s*$/, "").trim();
    if (!txt) return;
    pendingQueueRef.current.push(txt);
    setQueuedCount(pendingQueueRef.current.length);
    setInput("");
    // Note: we deliberately DO NOT add a user bubble here. Adding one now
    // would create a duplicate when the flush calls sendRaw (which appends
    // its own user bubble). The count pill + preview (below the chat) tells
    // the user what's queued. The real bubble appears naturally when the
    // flush fires and sendRaw processes the text as a proper turn.
  }

  function clearChat() {
    if (streaming || autoExecuting) stop();
    setMsgs([]);
    setActionResults(new Map());
    setAutoManagedBatches(new Set());
    processedBatchesRef.current = new Set();
    iterationRef.current = 0;
    try { localStorage.removeItem(TAB_MSGS_KEY(workspaceId, activeTabId)); } catch {}
  }

  // Multi-tab actions ------------------------------------------------------
  // Each tab gets a stable timestamp-based id so concurrent localStorage
  // writes from two browser tabs of the same workspace can't collide.
  function newTab() {
    if (streaming || autoExecuting) stop();
    const id = `t${Date.now().toString(36)}`;
    const usedNames = new Set(tabs.map((t) => t.name));
    let n = tabs.length + 1;
    while (usedNames.has(`Chat ${n}`)) n++;
    setTabs((prev) => [...prev, { id, name: `Chat ${n}` }]);
    setActiveTabId(id);
    setMsgs([]);
    setActionResults(new Map());
    setAutoManagedBatches(new Set());
    processedBatchesRef.current = new Set();
    iterationRef.current = 0;
  }
  function switchTab(id: string) {
    if (id === activeTabId) return;
    if (streaming || autoExecuting) stop();
    setActiveTabId(id);
    setActionResults(new Map());
    setAutoManagedBatches(new Set());
    processedBatchesRef.current = new Set();
    iterationRef.current = 0;
  }
  function renameTab(id: string) {
    const cur = tabs.find((t) => t.id === id);
    if (!cur) return;
    const next = window.prompt("Rename chat tab:", cur.name);
    if (next == null) return;
    const trimmed = next.trim().slice(0, 40);
    if (!trimmed) return;
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name: trimmed } : t)));
  }
  function closeTab(id: string) {
    if (tabs.length <= 1) return;
    const ok = window.confirm(`Close this chat tab? The conversation will be deleted.`);
    if (!ok) return;
    if (streaming || autoExecuting) stop();
    const remaining = tabs.filter((t) => t.id !== id);
    try { localStorage.removeItem(TAB_MSGS_KEY(workspaceId, id)); } catch {}
    setTabs(remaining);
    if (activeTabId === id) setActiveTabId(remaining[0].id);
  }

  // Autonomous orchestrator: when the latest assistant message contains
  // action blocks and Otonom is on, run them SEQUENTIALLY (each awaiting the
  // previous), populate the results map for ActionCard display, then send a
  // "Tool results" continuation so the AI can keep iterating. Bounded by
  // MAX_AUTO_ITERATIONS and stoppedRef.
  useEffect(() => {
    if (!autonomous || streaming || autoExecuting || stoppedRef.current) return;
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx];
    if (!last || last.role !== "assistant") return;
    const acts = parseActions(last.content).actions;
    if (acts.length === 0) return; // AI ended naturally — loop stops
    if (processedBatchesRef.current.has(lastIdx)) return;
    processedBatchesRef.current.add(lastIdx);
    setAutoManagedBatches((prev) => {
      const n = new Set(prev);
      n.add(lastIdx);
      return n;
    });

    (async () => {
      setAutoExecuting(true);
      const results: ActionResult[] = [];
      for (let i = 0; i < acts.length; i++) {
        if (stoppedRef.current) break;
        const ac = new AbortController();
        actionAbortRef.current = ac;
        const r = await runAction(workspaceId, acts[i], ac.signal);
        actionAbortRef.current = null;
        results[i] = r;
        // Audit each action with the provider/model that triggered it. Fire
        // and forget — never block on the network here.
        logAudit({
          workspaceId,
          provider,
          model,
          action: acts[i],
          result: r,
        });
        // Snapshot results into state so ActionCard re-renders with outcome.
        setActionResults((prev) => {
          const n = new Map(prev);
          n.set(lastIdx, results.slice());
          return n;
        });
        const k = acts[i].kind;
        if (k === "file" || k === "setRun" || k === "setEnv") onFilesMutated?.();
        if (k === "restart" || k === "setRun") onWorkspaceMutated?.();
        // If user clicked Stop mid-action, the abort propagates as a
        // "Cancelled by user" result — bail before running the rest.
        if (stoppedRef.current) break;
      }
      setAutoExecuting(false);
      if (stoppedRef.current) return;
      if (iterationRef.current >= MAX_AUTO_ITERATIONS) return;
      iterationRef.current += 1;
      await sendRaw(formatToolResults(acts, results));
    })().catch(() => {
      setAutoExecuting(false);
      actionAbortRef.current = null;
    });
  }, [msgs, autonomous, streaming, autoExecuting]);

  const currentProvider = providers?.providers.find((p) => p.id === provider);

  return (
    <div className="flex h-full flex-col bg-bg-panel">
      <div className="flex flex-col gap-2 border-b border-bg-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wide">AI</span>
          {(() => {
            // Cheap token estimate: ~4 chars per token across English/code, no
            // tokenizer dependency. Good enough to warn the user when the
            // history is bloating the context window. Image attachments are
            // not counted here (they're sized server-side per request).
            const totalChars = msgs.reduce((s, m) => s + (m.content?.length || 0), 0);
            const tokens = Math.round(totalChars / 4);
            const fmt = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
            return (
              <span
                className="ml-auto text-[10px] text-text-muted"
                title={`${msgs.length} messages, ~${totalChars.toLocaleString()} chars`}
              >
                ~{fmt} tok
              </span>
            );
          })()}
          <button
            className="text-[10px] text-text-muted hover:text-text"
            onClick={clearChat}
            title="Clear current tab"
          >
            Clear
          </button>
        </div>
        {/* Tab strip — horizontally scrollable. Click switches tab; double-click
            (or the pencil button on hover) renames; the × closes the tab when
            there's more than one. The "+" button creates a fresh tab. */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((t) => {
            const active = t.id === activeTabId;
            return (
              <div
                key={t.id}
                className={`group flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                  active
                    ? "border-accent bg-accent/10 text-text"
                    : "border-bg-border bg-bg-subtle text-text-muted hover:text-text"
                }`}
              >
                <button
                  className="flex items-center gap-1"
                  onClick={() => switchTab(t.id)}
                  onDoubleClick={() => renameTab(t.id)}
                  title="Click to switch · double-click to rename"
                >
                  <MessageSquare size={10} />
                  <span className="max-w-[120px] truncate">{t.name}</span>
                </button>
                {tabs.length > 1 && (
                  <button
                    className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    onClick={() => closeTab(t.id)}
                    title="Close tab"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            className="shrink-0 rounded-md border border-bg-border bg-bg-subtle px-1.5 py-1 text-text-muted hover:text-text"
            onClick={newTab}
            title="New chat tab"
          >
            <Plus size={11} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border border-bg-border bg-bg-subtle px-2 py-1 text-xs"
            value={provider}
            onChange={(e) => changeProvider(e.target.value as Provider["id"])}
          >
            {providers?.providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.configured}>
                {PROVIDER_LABELS[p.id]} {p.configured ? "" : "(no key)"}
              </option>
            ))}
          </select>
          <select
            className="min-w-0 max-w-[180px] truncate rounded-md border border-bg-border bg-bg-subtle px-2 py-1 text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {currentProvider?.models.map((m) => {
              const textOnly = currentProvider?.textOnlyModels?.includes(m);
              const label =
                m === "auto"
                  ? "Auto (pilih model terpintar, fallback quota)"
                  : textOnly
                  ? `${m} — text-only (no actions)`
                  : m;
              return (
                <option key={m} value={m}>
                  {label}
                </option>
              );
            })}
          </select>
          <label className="flex items-center gap-1 text-[10px] text-text-muted">
            <input
              type="checkbox"
              checked={autoPilot}
              onChange={(e) => setAutoPilot(e.target.checked)}
            />
            Auto-pilot
          </label>
          <label
            className="flex items-center gap-1 text-[10px] text-text-muted"
            title="Otonom: aksi auto-execute & AI lanjut sendiri sampai task selesai atau kamu klik Stop. Tidak ada batas langkah."
          >
            <input
              type="checkbox"
              checked={autonomous}
              onChange={(e) => {
                setAutonomous(e.target.checked);
                if (e.target.checked && !autoPilot) setAutoPilot(true);
              }}
            />
            Otonom
          </label>
          <label
            className="flex items-center gap-1 text-[10px] text-text-muted"
            title="Plan mode: AI tunjukkan rencana dulu sebelum eksekusi action. Berguna untuk task besar/risk-tinggi."
          >
            <input
              type="checkbox"
              checked={planMode}
              onChange={(e) => setPlanMode(e.target.checked)}
            />
            <ListChecks size={11} className={planMode ? "text-accent" : ""} />
            Plan
          </label>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto p-3 text-sm">
        {msgs.length === 0 && (
          <div className="rounded-md bg-bg-subtle px-3 py-3 text-center text-xs text-text-muted">
            Ask about your code. Toggle Auto-pilot so AI can run commands, edit files, restart, or save checkpoints (with your approval).
          </div>
        )}
        {msgs.map((m, i) => {
          // Hide auto-continuation user messages from the UI — the user
          // never typed them, they're a synthetic "please continue" signal
          // we send to the model. Still kept in `msgs` so the in-flight
          // recursion can pick up the right history; stripped from
          // localStorage by the persistence effect above.
          if (m.synthetic) return null;
          return (
            <Bubble
              key={i}
              msg={m}
              msgIdx={i}
              workspaceId={workspaceId}
              isLast={i === msgs.length - 1 && !streaming}
              isStreaming={i === msgs.length - 1 && streaming}
              autoPilot={autoPilot}
              autoManaged={autoManagedBatches.has(i)}
              actionResults={actionResults.get(i)}
              provider={provider}
              model={model}
              onWorkspaceMutated={onWorkspaceMutated}
              onFilesMutated={onFilesMutated}
            />
          );
        })}
        {streaming && continuationCountRef.current > 0 && (
          // Auto-continue indicator. With the cap effectively removed, only
          // show the running count — no "/N" denominator that would imply
          // a near limit. Calm neutral pill, not a warning.
          <div className="mx-1 inline-flex items-center gap-1 self-start rounded-full border border-bg-border bg-bg-subtle px-2 py-0.5 text-[10px] text-text-muted">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            melanjutkan output… (round {continuationCountRef.current})
          </div>
        )}
        {queuedCount > 0 && (
          // Mid-run queue indicator: shows when user typed a message while AI
          // was still running. The queued message(s) will fire as full AI
          // turns once the current run finishes. Shows a preview of the
          // NEXT queued message so the user can confirm what's waiting.
          <div className="mx-1 flex items-start gap-1 self-start rounded-lg border border-bg-border bg-bg-subtle px-2 py-1 text-[10px] text-text-muted">
            <Clock size={10} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-medium text-text">
                {queuedCount === 1 ? "1 pesan" : `${queuedCount} pesan`} menunggu
              </span>
              {" — akan dikirim setelah AI selesai"}
              {pendingQueueRef.current[0] && (
                <>
                  {": "}
                  <span className="italic">
                    &ldquo;{pendingQueueRef.current[0].slice(0, 60)}{pendingQueueRef.current[0].length > 60 ? "…" : ""}&rdquo;
                  </span>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-bg-border p-2">
        {pendingImages.length > 0 && (
          <>
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingImages.map((src, i) => (
                <div
                  key={i}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-bg-border bg-bg-subtle"
                >
                  <img src={src} alt={`attachment ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => removePendingImage(i)}
                    title="Remove"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
            {!modelSupportsVision(provider, model) && (
              <div className="mb-2 text-[11px] text-warning">
                "{model || provider}" tidak mendukung gambar. Pilih model vision
                (mis. gpt-4o, claude-3, gemini-1.5/2.x) atau hapus lampiran.
              </div>
            )}
          </>
        )}
        {imgError && (
          <div className="mb-2 text-[11px] text-danger">{imgError}</div>
        )}
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMG_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(e) => {
              addImagesFromFiles(e.target.files);
              // Allow re-picking the same file by clearing the input.
              if (e.target) e.target.value = "";
            }}
          />
          <button
            className="btn-secondary self-end"
            title={`Attach image (max ${MAX_IMGS_PER_MSG}, 5 MB each)`}
            onClick={() => fileInputRef.current?.click()}
            disabled={pendingImages.length >= MAX_IMGS_PER_MSG}
          >
            <ImagePlus size={14} />
          </button>
          <div className="relative self-end">
            <button
              className="btn-secondary"
              title="Prompt snippets (saved templates)"
              onClick={() => setSnippetsOpen((v) => !v)}
            >
              <Bookmark size={14} />
            </button>
            {snippetsOpen && (
              <div className="absolute bottom-full left-0 mb-1 w-72 rounded-md border border-bg-border bg-bg-subtle p-1 text-xs shadow-lg z-10">
                <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted">
                  Snippets
                  <button className="text-accent hover:underline" onClick={saveCurrentAsSnippet}>
                    + Save current
                  </button>
                </div>
                <div className="max-h-64 overflow-auto">
                  {snippets.length === 0 && (
                    <div className="px-2 py-2 text-text-muted">No snippets yet.</div>
                  )}
                  {snippets.map((s) => (
                    <div key={s.id} className="group flex items-center gap-1 rounded px-1 hover:bg-bg-base">
                      <button
                        className="flex-1 truncate text-left px-1 py-1.5"
                        onClick={() => insertSnippet(s)}
                        title={s.text}
                      >
                        {s.label}
                      </button>
                      <button
                        className="opacity-0 group-hover:opacity-100 px-1 text-text-muted hover:text-danger"
                        onClick={() => deleteSnippet(s.id)}
                        title="Delete snippet"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {voiceSupported && (
            <button
              className={"self-end " + (voiceOn ? "btn-danger" : "btn-secondary")}
              title={voiceOn ? "Stop dictation" : "Voice input (Web Speech)"}
              onClick={toggleVoice}
            >
              {voiceOn ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
          )}
          <textarea
            className="input min-h-[44px] flex-1 resize-none"
            placeholder="Ask AI…  (Shift+Enter for newline, paste images with Ctrl+V)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const it of Array.from(items)) {
                if (it.kind === "file") {
                  const f = it.getAsFile();
                  if (f && ACCEPTED_IMG_TYPES.includes(f.type)) files.push(f);
                }
              }
              if (files.length > 0) {
                e.preventDefault();
                addImagesFromFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // While AI is running, Enter queues the message instead of
                // firing a new send (which is blocked during streaming).
                if (streaming || autoExecuting) {
                  queueMessage();
                } else {
                  send();
                }
              }
            }}
          />
          {streaming || autoExecuting ? (
            // During streaming: show Stop + a Queue button side-by-side.
            // Queue button adds the typed message to a backlog that fires
            // one-by-one after the current AI run finishes.
            <div className="flex gap-1">
              <button className="btn-danger" onClick={stop} title="Stop AI">
                <Square size={14} />
              </button>
              <button
                className="btn-secondary"
                title="Kirim setelah AI selesai (Shift+Enter untuk queue tanpa kirim)"
                disabled={!input.trim()}
                onClick={queueMessage}
              >
                <Plus size={14} />
              </button>
            </div>
          ) : (
            <button
              ref={sendBtnRef}
              className="btn-primary"
              onClick={send}
              disabled={!input.trim() && pendingImages.length === 0}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  msgIdx,
  workspaceId,
  isLast,
  isStreaming,
  autoPilot,
  autoManaged,
  actionResults,
  provider,
  model,
  onWorkspaceMutated,
  onFilesMutated,
}: {
  msg: Msg;
  msgIdx: number;
  workspaceId: string;
  isLast: boolean;
  isStreaming: boolean;
  autoPilot: boolean;
  autoManaged: boolean;
  actionResults?: ActionResult[];
  provider: string;
  model: string;
  onWorkspaceMutated?: () => void;
  onFilesMutated?: () => void;
}) {
  const isAssistant = msg.role === "assistant";
  const parsed = isAssistant && autoPilot
    ? parseActions(msg.content)
    : { actions: [], cleaned: msg.content };
  const actions = parsed.actions;
  const cleanText = parsed.cleaned;
  // Truncate long synthetic "Tool results" user messages to keep the UI tidy.
  const isToolResults = !isAssistant && msg.content.startsWith("Tool results:");

  return (
    <div
      className={`rounded-md px-3 py-2 ${
        isAssistant ? "bg-bg-subtle text-text" : "bg-accent/10 text-text"
      }`}
    >
      <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        {isAssistant ? <Bot size={10} /> : <User size={10} />}
        {isToolResults ? "tool results" : msg.role}
        {isAssistant && (
          // Show which provider+model produced this reply so the user can
          // see "oh, that one was on Gemini, the next one was Claude".
          // Prefer the per-message provenance (captured at send time);
          // fall back to the currently active provider/model only for
          // legacy persisted bubbles that pre-date the provenance field.
          <span className="ml-1 normal-case tracking-normal text-text-muted/70">
            · {msg.provider ?? provider}/{msg.model ?? model}
          </span>
        )}
      </div>
      {isAssistant
        ? <Markdown text={cleanText || (isLast ? "" : "…")} isStreaming={isStreaming} />
        : isToolResults
          ? <ToolResultsView text={cleanText} />
          : <div className="whitespace-pre-wrap leading-relaxed">{cleanText}</div>}
      {actions.length > 0 && (
        <div className="mt-3 space-y-2">
          {actions.map((a, i) => (
            <ActionCard
              key={`${msgIdx}-${i}`}
              action={a}
              workspaceId={workspaceId}
              presetResult={autoManaged ? actionResults?.[i] : undefined}
              autoManaged={autoManaged}
              provider={provider}
              model={model}
              onWorkspaceMutated={onWorkspaceMutated}
              onFilesMutated={onFilesMutated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolResultsView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
  return (
    <div className="text-[11px] text-text-muted">
      <pre className="whitespace-pre-wrap font-mono leading-relaxed">
        {open ? text : preview}
      </pre>
      {text.length > 200 && (
        <button
          className="mt-1 text-[10px] underline hover:text-text"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Show less" : "Show full"}
        </button>
      )}
    </div>
  );
}

function ActionCard({
  action,
  workspaceId,
  presetResult,
  autoManaged = false,
  provider,
  model,
  onWorkspaceMutated,
  onFilesMutated,
}: {
  action: Action;
  workspaceId: string;
  // When provided (autonomous mode), display this result instead of the
  // Approve/Edit/Skip controls. Execution is owned by the AIChat orchestrator.
  presetResult?: ActionResult;
  // True when this card is part of an autonomous batch — hides manual buttons
  // and shows a "Queued (otonom)…" placeholder while results stream in.
  autoManaged?: boolean;
  // Provider+model that produced this suggestion — recorded in the audit log
  // when the user approves it manually.
  provider: string;
  model: string;
  onWorkspaceMutated?: () => void;
  onFilesMutated?: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "ok" | "error">("idle");
  const [output, setOutput] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState<string>(
    action.kind === "file" ? action.content : ""
  );
  const [editedCommand, setEditedCommand] = useState<string>(
    action.kind === "bash" ? action.command : ""
  );
  const [showFull, setShowFull] = useState(false);
  // Manual Approve also needs a per-card AbortController so the per-card
  // Stop button can cancel a hung command without waiting for the server's
  // 120s exec timeout. (The chat-level Stop only aborts the orchestrator.)
  const manualAbortRef = useRef<AbortController | null>(null);

  async function execute() {
    setState("running");
    setOutput("");
    // Build the action with edits applied (so manual Approve uses edits).
    const eff: Action =
      action.kind === "bash" ? { ...action, command: editedCommand } :
      action.kind === "file" ? { ...action, content: editedContent } :
      action;
    const ac = new AbortController();
    manualAbortRef.current = ac;
    const r = await runAction(workspaceId, eff, ac.signal);
    manualAbortRef.current = null;
    setOutput(r.output);
    setState(r.ok ? "ok" : "error");
    // Manual approval — record alongside autonomous actions in the audit log.
    logAudit({ workspaceId, provider, model, action: eff, result: r });
    if (eff.kind === "file" || eff.kind === "setRun" || eff.kind === "setEnv") onFilesMutated?.();
    if (eff.kind === "restart" || eff.kind === "setRun") onWorkspaceMutated?.();
  }

  function cancelManual() {
    manualAbortRef.current?.abort();
  }

  function reject() {
    setState("ok");
    setOutput("(skipped)");
  }

  // Autonomous mode: render straight from presetResult (set by orchestrator).
  // Falls through the normal render path so the action header still shows.
  const effectiveState: "idle" | "running" | "ok" | "error" =
    autoManaged
      ? presetResult
        ? presetResult.ok ? "ok" : "error"
        : "running"
      : state;
  const effectiveOutput = autoManaged
    ? presetResult?.output ?? ""
    : output;

  const meta = (() => {
    switch (action.kind) {
      case "bash": return { icon: <Play size={12} />, label: "Run command", color: "text-warning" };
      case "file": return { icon: <FileEdit size={12} />, label: `Write file: ${action.path}`, color: "text-accent" };
      case "delete": return { icon: <Trash2 size={12} />, label: `Delete: ${action.path}`, color: "text-danger" };
      case "mkdir": return { icon: <FolderPlus size={12} />, label: `Create folder: ${action.path}`, color: "text-accent" };
      case "rename": return { icon: <Move size={12} />, label: `Rename: ${action.from} → ${action.to}`, color: "text-accent" };
      case "patch": return { icon: <Diff size={12} />, label: `Patch: ${action.path}${action.replaceAll ? " (all)" : ""}`, color: "text-accent" };
      case "search": return { icon: <Search size={12} />, label: `Search: "${action.pattern.slice(0, 60)}"${action.pathGlob ? ` in ${action.pathGlob}` : ""}`, color: "text-text-muted" };
      case "diag": return { icon: <Stethoscope size={12} />, label: "Run diagnostics (tsc/eslint/ruff)", color: "text-text-muted" };
      case "test": return { icon: <FlaskConical size={12} />, label: action.command ? `Run tests: ${action.command.slice(0, 60)}` : "Run tests (auto-detect)", color: "text-text-muted" };
      case "web": return { icon: <Globe size={12} />, label: `Web search: "${action.query.slice(0, 60)}"`, color: "text-text-muted" };
      case "setRun": return { icon: <Play size={12} />, label: "Set run command (.premdev)", color: "text-accent" };
      case "setEnv": return { icon: <FileEdit size={12} />, label: `Set env vars (${Object.keys(action.vars).length} key${Object.keys(action.vars).length === 1 ? "" : "s"})`, color: "text-accent" };
      case "restart": return { icon: <RotateCw size={12} />, label: "Restart workspace", color: "text-warning" };
      case "checkpoint": return { icon: <Save size={12} />, label: `Save checkpoint: ${action.message}`, color: "text-success" };
    }
  })();

  const canEdit = action.kind === "file" || action.kind === "bash";
  const fullContent =
    action.kind === "file" ? action.content :
    action.kind === "bash" ? action.command :
    action.kind === "setRun" ? action.command :
    action.kind === "setEnv" ? Object.entries(action.vars).map(([k, v]) => `${k}=${v}`).join("\n") :
    action.kind === "patch" ? `<<<FIND\n${action.find}\n===\n${action.replace}\n>>>` :
    action.kind === "search" ? `pattern: ${action.pattern}${action.pathGlob ? `\nin: ${action.pathGlob}` : ""}${action.regex ? `\nregex: yes` : ""}` :
    action.kind === "test" ? (action.command ?? "(auto-detect test command)") :
    action.kind === "web" ? `query: ${action.query}` :
    "";
  const displayContent = showFull
    ? fullContent
    : fullContent.length > 400 ? fullContent.slice(0, 400) + "…" : fullContent;

  return (
    <div className="rounded-md border border-bg-border bg-bg p-2">
      <div className={`mb-1 flex items-center gap-1 text-xs font-semibold ${meta.color}`}>
        {meta.icon} {meta.label}
        {fullContent && (
          <CopyBtn text={fullContent} />
        )}
      </div>
      {fullContent && !editing && (
        <>
          <pre className="mb-1 max-h-60 overflow-auto rounded bg-bg-subtle p-2 font-mono text-[11px] leading-relaxed">
            {displayContent}
          </pre>
          {fullContent.length > 400 && (
            <button
              className="mb-2 text-[10px] text-text-muted hover:text-text"
              onClick={() => setShowFull((v) => !v)}
            >
              {showFull ? "Show less" : "Show full"}
            </button>
          )}
        </>
      )}
      {editing && action.kind === "file" && (
        <textarea
          className="input mb-2 min-h-[160px] w-full resize-y font-mono text-[11px] leading-relaxed"
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
        />
      )}
      {editing && action.kind === "bash" && (
        <textarea
          className="input mb-2 min-h-[60px] w-full resize-y font-mono text-[11px] leading-relaxed"
          value={editedCommand}
          onChange={(e) => setEditedCommand(e.target.value)}
        />
      )}
      {effectiveState === "idle" ? (
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary text-xs" onClick={execute}>
            <Check size={12} /> Approve
          </button>
          {canEdit && (
            <button
              className="btn-secondary text-xs"
              onClick={() => setEditing((v) => !v)}
            >
              <Pencil size={12} /> {editing ? "Done editing" : "Edit"}
            </button>
          )}
          <button className="btn-secondary text-xs" onClick={reject}>
            <X size={12} /> Skip
          </button>
        </div>
      ) : effectiveState === "running" ? (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span>{autoManaged ? "Queued (otonom)…" : "Running…"}</span>
          {!autoManaged && (
            <button
              className="btn-danger text-[11px]"
              onClick={cancelManual}
              title="Cancel this command"
            >
              <Square size={10} /> Stop
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={`text-xs ${effectiveState === "ok" ? "text-success" : "text-danger"}`}>
            {effectiveState === "ok" ? "Done" : "Error"}
          </div>
          {effectiveOutput && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg-subtle p-2 font-mono text-[11px] leading-relaxed">
              {effectiveOutput}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
