import crypto from "node:crypto";
import { db } from "./db.js";
import { config } from "./config.js";

type Provider = "openai" | "anthropic" | "google" | "openrouter" | "groq" | "konektika" | "snifox";

const PROVIDERS: Provider[] = ["openai", "anthropic", "google", "openrouter", "groq", "konektika", "snifox"];

const WEAK_JWT_SECRETS = new Set([
  "dev-secret-change-me-in-production",
  "premdev-default-key",
  "",
]);

let warnedWeakKey = false;
function getCipherKey(): Buffer {
  const seed = config.JWT_SECRET || "premdev-default-key";
  if (WEAK_JWT_SECRETS.has(seed) && !warnedWeakKey) {
    warnedWeakKey = true;
    console.warn(
      "⚠️  AI keys are encrypted with a default JWT_SECRET. " +
      "Set a strong JWT_SECRET (>=32 random chars) in your environment so DB-stored AI keys are not decryptable with the shipped default."
    );
  }
  return crypto.createHash("sha256").update(seed).digest();
}

export function isEncryptionKeyWeak(): boolean {
  const seed = config.JWT_SECRET || "";
  return WEAK_JWT_SECRETS.has(seed) || seed.length < 16;
}

function encrypt(plain: string): string {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const key = getCipherKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload: string): string {
  if (!payload || !payload.startsWith("v1:")) return "";
  try {
    const [, ivB64, tagB64, dataB64] = payload.split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const key = getCipherKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return "";
  }
}

function envFallback(provider: Provider): string {
  switch (provider) {
    case "openai": return config.OPENAI_API_KEY;
    case "anthropic": return config.ANTHROPIC_API_KEY;
    case "google": return config.GOOGLE_API_KEY;
    case "openrouter": return config.OPENROUTER_API_KEY;
    case "groq": return config.GROQ_API_KEY;
    case "konektika": return config.KONEKTIKA_API_KEY;
    case "snifox": return config.SNIFOX_API_KEY;
  }
}

const cache = new Map<Provider, string>();
let cacheLoaded = false;

function loadCache() {
  if (cacheLoaded) return;
  for (const p of PROVIDERS) {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`ai.${p}.key`) as { value: string } | undefined;
    if (row?.value) {
      const dec = decrypt(row.value);
      if (dec) cache.set(p, dec);
    }
  }
  cacheLoaded = true;
}

export function getAIKey(provider: Provider): string {
  loadCache();
  return cache.get(provider) || envFallback(provider) || "";
}

/**
 * Multi-key support: a single configured value may contain several keys
 * separated by `,` (or `;` / newline). Returns them split + trimmed +
 * de-duplicated, with empty entries dropped. Order is preserved so the
 * stream callers can iterate "primary first, fall over on rate-limit".
 *
 * Example stored value: `sk-aaa,sk-bbb,sk-ccc` → returns
 *   ["sk-aaa", "sk-bbb", "sk-ccc"].
 *
 * Returns an empty array if no key is configured at all (caller should
 * yield "(provider key not configured)" in that case, same as before).
 */
export function getAIKeys(provider: Provider): string[] {
  const raw = getAIKey(provider);
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const k = part.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

export function setAIKey(provider: Provider, plain: string) {
  loadCache();
  if (!plain) {
    db.prepare("DELETE FROM settings WHERE key = ?").run(`ai.${provider}.key`);
    cache.delete(provider);
    return;
  }
  const enc = encrypt(plain);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`ai.${provider}.key`, enc);
  cache.set(provider, plain);
}

export function listAIKeysMasked(): {
  provider: Provider;
  configured: boolean;
  source: "db" | "env" | "none";
  masked: string;
  keyCount: number;
  maskedAll: string[];
}[] {
  loadCache();
  return PROVIDERS.map((p) => {
    const dbVal = cache.get(p);
    const envVal = envFallback(p);
    const val = dbVal || envVal;
    const source: "db" | "env" | "none" = dbVal ? "db" : envVal ? "env" : "none";
    const all = getAIKeys(p);
    const mask = (s: string) =>
      s.length <= 8
        ? "*".repeat(s.length)
        : s.slice(0, 4) + "•".repeat(Math.min(s.length - 8, 16)) + s.slice(-4);
    return {
      provider: p,
      configured: !!val,
      source,
      // First key masked — preserves the old single-key UI rendering.
      masked: all[0] ? mask(all[0]) : "",
      // Total number of comma/newline-separated keys configured. Lets the
      // admin UI render "3 keys configured" alongside the masked preview
      // and lets ops see at a glance whether failover is set up.
      keyCount: all.length,
      // Masked preview of every key in order, for the admin-side per-key
      // listing ("Key #1: sk-aa…cd, Key #2: sk-ee…hh"). Never leaks more
      // than the first 4 + last 4 chars of any key.
      maskedAll: all.map(mask),
    };
  });
}
