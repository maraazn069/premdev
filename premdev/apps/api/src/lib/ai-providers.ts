/**
 * ai-providers.ts — streaming provider implementations and model config.
 * Extracted from apps/api/src/routes/ai.ts for maintainability.
 */

import { getAIKey, getAIKeys } from "./ai-settings.js";
import type { Provider, ChatMsg } from "./ai-prompt.js";

// ---------------------------------------------------------------------------
// Model lists
// ---------------------------------------------------------------------------

/**
 * Default model per provider. "auto" = smartest-first tier rotation.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "auto",
  anthropic: "auto",
  google: "auto",
  openrouter: "auto",
  groq: "auto",
  konektika: "auto",
  snifox: "auto",
};

/**
 * Free-tier Gemini models, ordered by cost-effectiveness (cheapest first).
 * "auto" iterates this list and falls through on 429 quota errors. The live
 * list from Google's ListModels endpoint is preferred at runtime; this
 * constant is only the fallback when the API call fails.
 */
export const GEMINI_FREE_TIER = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash",
] as const;

export const PROVIDER_MODELS: Record<Provider, string[]> = {
  openai: ["auto", "gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["auto", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  google: [
    "auto",
    "gemini-2.5-flash",
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
  ],
  openrouter: [
    "auto",
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "google/gemma-2-9b-it:free",
    "openrouter/auto",
  ],
  groq: ["auto", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
  konektika: ["auto", "kimi-pro"],
  snifox: [
    "auto",
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-5-codex",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-flash-preview",
    "google/gemini-2.5-flash",
  ],
};

/**
 * Per-provider "auto" tier — smartest first, cheapest last.
 * Google has its own dynamic auto handler in streamGoogle (it queries the
 * live model list per-key), so its tier here is unused by the dispatcher.
 */
export const AUTO_TIERS: Record<Provider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  google: [...GEMINI_FREE_TIER],
  openrouter: [
    "deepseek/deepseek-r1:free",
    "deepseek/deepseek-chat-v3.1:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen-2.5-72b-instruct:free",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  konektika: ["kimi-pro"],
  snifox: [
    "openai/gpt-5",
    "openai/gpt-5-mini",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-2.5-flash",
  ],
};

/**
 * Models known to ignore the structured action format and respond with
 * plain prose only. Surfaced in the /providers response so the UI can
 * mark them with a "text only" badge.
 */
export const TEXT_ONLY_MODEL_PATTERNS: RegExp[] = [
  /gemma/i,
  /llama-3\.1-8b/i,
  /llama-3\.2-(?:1b|3b)/i,
  /qwen-2\.5-(?:0\.5|1\.5|3|7)b/i,
  /mixtral-8x7b/i,
];

export function isTextOnlyModel(name: string): boolean {
  if (name === "auto") return false;
  return TEXT_ONLY_MODEL_PATTERNS.some((re) => re.test(name));
}

// ---------------------------------------------------------------------------
// Multi-key failover
// ---------------------------------------------------------------------------

/**
 * HTTP statuses that indicate "this specific key is exhausted / invalid".
 * The multi-key failover should try the next key instead of surfacing the
 * error. 5xx and body-shape errors are NOT here on purpose — those are
 * upstream issues, not key issues.
 */
export const KEY_FAILOVER_STATUSES = new Set([401, 402, 403, 429]);

// ---------------------------------------------------------------------------
// Live model list caches
// ---------------------------------------------------------------------------

let cachedGoogleModels: { at: number; list: string[] } | null = null;
export async function fetchGoogleModels(): Promise<string[]> {
  const key = getAIKey("google");
  if (!key) return [];
  if (cachedGoogleModels && Date.now() - cachedGoogleModels.at < 10 * 60 * 1000) {
    return cachedGoogleModels.list;
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`,
  );
  if (!res.ok) return cachedGoogleModels?.list ?? [];
  const j = (await res.json().catch(() => null)) as any;
  const arr = Array.isArray(j?.models) ? j.models : [];
  const list: string[] = arr
    .filter(
      (m: any) =>
        Array.isArray(m?.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent"),
    )
    .map((m: any) => String(m.name || "").replace(/^models\//, ""))
    .filter((n: string) => n.startsWith("gemini-"))
    .filter((n: string) => !/-001$|-002$/.test(n));
  list.sort((a, b) => b.localeCompare(a));
  cachedGoogleModels = { at: Date.now(), list };
  return list;
}

let cachedSnifoxModels: { at: number; list: string[] } | null = null;
export async function fetchSnifoxModels(): Promise<string[]> {
  if (cachedSnifoxModels && Date.now() - cachedSnifoxModels.at < 10 * 60 * 1000) {
    return cachedSnifoxModels.list;
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const key = getAIKey("snifox");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (key) headers["Authorization"] = `Bearer ${key}`;
    const res = await fetch("https://core.snifoxai.com/v1/models", {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return cachedSnifoxModels?.list ?? [];
    const j = (await res.json().catch(() => null)) as any;
    const arr = Array.isArray(j?.data) ? j.data : [];
    const list: string[] = arr
      .map((m: any) => String(m?.id ?? "").trim())
      .filter((s: string) => s.length > 0)
      .sort((a: string, b: string) => {
        const av = a.split("/")[0];
        const bv = b.split("/")[0];
        if (av !== bv) return av.localeCompare(bv);
        return b.localeCompare(a);
      });
    cachedSnifoxModels = { at: Date.now(), list };
    return list;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Stream dispatchers
// ---------------------------------------------------------------------------

export async function* streamProvider(
  provider: Provider,
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (model === "auto" && provider !== "google") {
    yield* streamProviderAuto(provider, messages, maxTokens, signal);
    return;
  }
  switch (provider) {
    case "openai":
      yield* streamOpenAICompat({
        url: "https://api.openai.com/v1/chat/completions",
        keys: getAIKeys("openai"),
        providerLabel: "OpenAI",
        model, messages, signal, maxTokens,
      });
      return;
    case "anthropic":
      yield* streamAnthropic(model, messages, maxTokens, signal);
      return;
    case "google":
      yield* streamGoogle(model, messages, maxTokens, signal);
      return;
    case "openrouter":
      yield* streamOpenAICompat({
        url: "https://openrouter.ai/api/v1/chat/completions",
        keys: getAIKeys("openrouter"),
        providerLabel: "OpenRouter",
        model, messages, signal, maxTokens,
        extraHeaders: {
          "HTTP-Referer": "https://flixprem.org",
          "X-Title": "PremDev",
        },
      });
      return;
    case "groq":
      yield* streamOpenAICompat({
        url: "https://api.groq.com/openai/v1/chat/completions",
        keys: getAIKeys("groq"),
        providerLabel: "Groq",
        model, messages, signal, maxTokens,
      });
      return;
    case "konektika":
      yield* streamOpenAICompat({
        url: "https://konektika.web.id/v1/chat/completions",
        keys: getAIKeys("konektika"),
        providerLabel: "Konektika",
        model, messages, signal, maxTokens,
        omitMaxTokens: true,
      });
      return;
    case "snifox":
      yield* streamOpenAICompat({
        url: "https://core.snifoxai.com/v1/chat/completions",
        keys: getAIKeys("snifox"),
        providerLabel: "Snifox",
        model, messages, signal, maxTokens,
      });
      return;
  }
}

/**
 * AUTO-mode router for any non-google provider.
 * Iterates the provider's tier (smartest → cheapest), running each model
 * through the normal streamProvider dispatch. The first model that emits
 * real content wins; if a model fails (rate-limit, quota, key-not-set,
 * 5xx, etc.) we silently roll over to the next.
 */
export async function* streamProviderAuto(
  provider: Provider,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const tier = AUTO_TIERS[provider] ?? [];
  if (tier.length === 0) {
    yield `(Auto: tier list untuk ${provider} kosong — pilih model spesifik di dropdown.)`;
    return;
  }
  let lastErr = "";
  for (let i = 0; i < tier.length; i++) {
    const candidate = tier[i];
    let firstSeen = false;
    let success = false;
    let abortedThis = false;
    try {
      for await (const chunk of streamProvider(provider, candidate, messages, maxTokens, signal)) {
        if (!firstSeen) {
          firstSeen = true;
          if (
            chunk.startsWith("Error:") ||
            /^\([^)]*key not configured[^)]*\)$/i.test(chunk.trim())
          ) {
            lastErr = chunk.slice(0, 200);
            abortedThis = true;
            break;
          }
          success = true;
          yield `\n[Auto pilih ${provider}/${candidate}${i > 0 ? ` — ${i} model sebelumnya gagal` : ""}]\n`;
        }
        yield chunk;
      }
    } catch (e: any) {
      lastErr = e?.message || String(e);
      abortedThis = true;
    }
    if (success && !abortedThis) return;
    if (!firstSeen) lastErr ||= `${candidate} returned no chunks`;
  }
  yield `\n[Auto: semua ${tier.length} kandidat ${provider} gagal. Last: ${lastErr || "(no detail)"}]`;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible streaming (also used by OpenRouter / Groq / Konektika / Snifox)
// ---------------------------------------------------------------------------

export async function* streamOpenAICompat(opts: {
  url: string;
  keys: string[];
  model: string;
  messages: ChatMsg[];
  signal: AbortSignal;
  maxTokens: number;
  extraHeaders?: Record<string, string>;
  omitMaxTokens?: boolean;
  providerLabel?: string;
}): AsyncGenerator<string> {
  if (!opts.keys || opts.keys.length === 0) {
    yield `(${opts.providerLabel ?? opts.url} key not configured)`;
    return;
  }
  const apiMessages = opts.messages.map((m) => {
    if (m.images && m.images.length > 0 && m.role === "user") {
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img } });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
  const reqBody = JSON.stringify({
    model: opts.model,
    messages: apiMessages,
    stream: true,
    ...(opts.omitMaxTokens ? {} : { max_tokens: opts.maxTokens }),
  });

  let lastError: { status: number; body: string } | null = null;
  for (let i = 0; i < opts.keys.length; i++) {
    const key = opts.keys[i];
    const res = await fetch(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(opts.extraHeaders || {}),
      },
      body: reqBody,
      signal: opts.signal,
    });
    if (res.ok && res.body) {
      if (i > 0) yield `\n[Key #${i + 1} dipakai (key sebelumnya gagal)]\n`;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const j = JSON.parse(data);
            const txt = j.choices?.[0]?.delta?.content ?? "";
            if (txt) yield txt;
          } catch {}
        }
      }
      return;
    }
    const body = await res.text().catch(() => "");
    lastError = { status: res.status, body: body.slice(0, 300) };
    if (KEY_FAILOVER_STATUSES.has(res.status) && i < opts.keys.length - 1) continue;
    yield `Error: ${res.status} ${body}`;
    return;
  }
  if (lastError) {
    yield `Error: semua ${opts.keys.length} key gagal. Last: ${lastError.status} ${lastError.body}`;
  }
}

// ---------------------------------------------------------------------------
// Anthropic streaming
// ---------------------------------------------------------------------------

export async function* streamAnthropic(
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const keys = getAIKeys("anthropic");
  if (keys.length === 0) { yield "(Anthropic key not configured)"; return; }
  const sys = messages.find((m) => m.role === "system")?.content;
  const msgs = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      if (m.images && m.images.length > 0 && m.role === "user") {
        const blocks: any[] = [];
        for (const img of m.images) {
          const parsed = parseDataUrlLocal(img);
          if (!parsed) continue;
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: parsed.mimeType, data: parsed.data },
          });
        }
        if (m.content) blocks.push({ type: "text", text: m.content });
        return { role: m.role, content: blocks };
      }
      return { role: m.role, content: m.content };
    });
  const reqBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    system: sys,
    messages: msgs,
  });
  let res: Response | null = null;
  let usedKeyIdx = 0;
  let lastError: { status: number; body: string } | null = null;
  for (let i = 0; i < keys.length; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": keys[i],
        "anthropic-version": "2023-06-01",
      },
      body: reqBody,
      signal,
    });
    if (r.ok && r.body) { res = r; usedKeyIdx = i; break; }
    const body = await r.text().catch(() => "");
    lastError = { status: r.status, body: body.slice(0, 300) };
    if (KEY_FAILOVER_STATUSES.has(r.status) && i < keys.length - 1) continue;
    yield `Error: ${r.status} ${body}`;
    return;
  }
  if (!res || !res.body) {
    yield lastError
      ? `Error: semua ${keys.length} Anthropic key gagal. Last: ${lastError.status} ${lastError.body}`
      : `Error: Anthropic request failed`;
    return;
  }
  if (usedKeyIdx > 0) yield `\n[Anthropic key #${usedKeyIdx + 1} dipakai (key sebelumnya gagal)]\n`;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        if (j.type === "content_block_delta" && j.delta?.text) yield j.delta.text;
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Google / Gemini streaming
// ---------------------------------------------------------------------------

export async function* streamGoogle(
  model: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const googleKeys = getAIKeys("google");
  if (googleKeys.length === 0) { yield "(Google key not configured)"; return; }
  const keys = googleKeys;

  let lastQuotaMsg: string | null = null;
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    if (ki > 0) yield `\n[Google key #${ki + 1} dipakai (quota key sebelumnya habis)]\n`;

    if (model === "auto") {
      const liveList = await fetchGoogleModels().catch(() => [] as string[]);
      const freeFromLive = liveList.filter(
        (n) => /flash-lite|flash$|flash-/.test(n) && !/exp|pro/.test(n),
      );
      const candidates = freeFromLive.length > 0 ? freeFromLive : [...GEMINI_FREE_TIER];
      let lastError: string | null = null;
      let allQuotaThisKey = true;
      let keyDead = false;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        let emitted = false;
        let skipReason: "quota" | "notfound" | "keydead" | null = null;
        const wrapped = streamGoogleSingle(candidate, key, messages, maxTokens, signal);
        for await (const chunk of wrapped) {
          if (chunk.startsWith("__KEYDEAD__")) {
            skipReason = "keydead";
            keyDead = true;
            lastError = chunk.slice(11);
            break;
          }
          if (chunk.startsWith("__QUOTA__")) { skipReason = "quota"; lastError = chunk.slice(9); break; }
          if (chunk.startsWith("__ERROR__")) {
            lastError = chunk.slice(9);
            if (/^404\b|NOT_FOUND/i.test(lastError ?? "")) skipReason = "notfound";
            break;
          }
          emitted = true;
          yield chunk;
        }
        if (emitted) return;
        if (!skipReason) {
          if (lastError) yield `\n\n[Gemini error: ${lastError}]`;
          return;
        }
        if (skipReason === "keydead") break;
        if (skipReason === "notfound") allQuotaThisKey = false;
        const reason = skipReason === "quota" ? "Quota habis" : "Model tidak tersedia";
        const next = candidates[i + 1] ?? "(habis semua)";
        yield `\n[${reason} di ${candidate}, coba ${next}…]\n`;
      }
      if ((keyDead || allQuotaThisKey) && ki < keys.length - 1) {
        lastQuotaMsg = lastError;
        continue;
      }
      if (keyDead) {
        yield `\n\n[Google key #${ki + 1} ditolak (auth/quota habis): ${lastError ?? ""}]`;
      } else {
        yield `\n\n[Semua kandidat Gemini free-tier gagal pada key #${ki + 1}. Coba lagi nanti atau pilih model spesifik.]`;
      }
      return;
    }

    let emittedSingle = false;
    let advanceKey = false;
    let lastErr: string | null = null;
    for await (const chunk of streamGoogleSingle(model, key, messages, maxTokens, signal)) {
      if (chunk.startsWith("__KEYDEAD__")) {
        advanceKey = true; lastErr = chunk.slice(11); lastQuotaMsg = lastErr; break;
      }
      if (chunk.startsWith("__QUOTA__")) {
        advanceKey = true; lastErr = chunk.slice(9); lastQuotaMsg = lastErr; break;
      }
      if (chunk.startsWith("__ERROR__")) {
        yield `\n[Gemini error: ${chunk.slice(9)}]`; return;
      }
      emittedSingle = true;
      yield chunk;
    }
    if (emittedSingle) return;
    if (advanceKey && ki < keys.length - 1) continue;
    yield `\n[Model "${model}" kena quota / rate-limit / key invalid (key #${ki + 1}). Tambah API key di admin atau pilih model lain.${lastErr ? " Detail: " + lastErr : ""}]`;
    return;
  }
  if (lastQuotaMsg) {
    yield `\n[Semua ${getAIKeys("google").length} Google key habis quota / invalid. Last: ${lastQuotaMsg}]`;
  }
}

export async function* streamGoogleSingle(
  model: string,
  key: string,
  messages: ChatMsg[],
  maxTokens: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const sys = messages.find((m) => m.role === "system")?.content;
  const contents = messages.filter((m) => m.role !== "system").map((m) => {
    const parts: any[] = [];
    if (m.content) parts.push({ text: m.content });
    if (m.images && m.role === "user") {
      for (const img of m.images) {
        const parsed = parseDataUrlLocal(img);
        if (!parsed) continue;
        parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
      }
    }
    if (parts.length === 0) parts.push({ text: "" });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    const txt = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      yield `__KEYDEAD__${res.status} ${txt}`;
    } else if (res.status === 429 || /quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded/i.test(txt)) {
      yield `__QUOTA__${res.status} ${txt}`;
    } else {
      yield `__ERROR__${res.status} ${txt}`;
    }
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let emittedAnyText = false;
  let lastFinishReason: string | null = null;
  let lastBlockReason: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const j = JSON.parse(line.slice(5).trim());
        const cand = j.candidates?.[0];
        const parts = cand?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === "string" && p.text.length > 0) {
              emittedAnyText = true;
              yield p.text;
            }
          }
        }
        if (typeof cand?.finishReason === "string") lastFinishReason = cand.finishReason;
        if (typeof j?.promptFeedback?.blockReason === "string") {
          lastBlockReason = j.promptFeedback.blockReason;
        }
      } catch {}
    }
  }
  if (!emittedAnyText) {
    if (lastBlockReason) {
      yield `\n\n[Gemini blocked the prompt: ${lastBlockReason}. Try rephrasing or removing the image.]`;
    } else if (lastFinishReason && lastFinishReason !== "STOP") {
      yield `\n\n[Gemini returned no text (finishReason=${lastFinishReason}). Try a different model or shorter prompt.]`;
    } else {
      yield `\n\n[Gemini returned an empty response. Check the API key, the model name, and that your account has access to it.]`;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helper (avoids cross-module dependency on ai-prompt for data URLs)
// ---------------------------------------------------------------------------

function parseDataUrlLocal(
  dataUrl: string,
): { mimeType: string; data: string } | null {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}
