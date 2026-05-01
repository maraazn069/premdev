import { config } from "./config.js";

type Level = "info" | "warn" | "error";
const ICON: Record<Level, string> = { info: "ℹ️", warn: "⚠️", error: "🚨" };

let lastSendAt = 0;
const MIN_INTERVAL_MS = 1000;

/**
 * Send a notification to the configured admin Telegram chat. Becomes a
 * silent no-op when either TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is
 * missing — safe to call from anywhere even on dev / unconfigured installs.
 *
 * Includes a 1s minimum send interval (Telegram bot API hard limit is 30/s
 * but we're far more conservative — these are admin alerts, not chat).
 *
 * Returns true on HTTP 2xx, false otherwise. Never throws.
 */
export async function notifyAdmin(
  text: string,
  level: Level = "info",
): Promise<boolean> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chat = config.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chat) return false;

  const now = Date.now();
  if (now - lastSendAt < MIN_INTERVAL_MS) return false;
  lastSendAt = now;

  const body = {
    chat_id: chat,
    text: `${ICON[level]} ${text}`,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export function telegramConfigured(): boolean {
  return !!(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_ADMIN_CHAT_ID);
}
