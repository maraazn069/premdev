/**
 * Tiny in-memory rate limiter (token bucket per key). Suitable for a
 * single-process API; if PremDev ever scales horizontally this needs to be
 * swapped for a Redis-backed store.
 *
 * Each `key` (typically `${ip}:${route}`) gets `capacity` tokens that refill
 * at `refillPerSec` tokens per second. `take()` returns true if a token is
 * available (and consumes it), false otherwise.
 */
type Bucket = { tokens: number; lastRefillMs: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {
    // Periodically prune cold buckets so memory stays bounded under churny
    // IPs (one row per unique attacker would otherwise grow forever).
    setInterval(() => this.prune(), 60_000);
  }
  take(key: string, n = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: now };
    const elapsed = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens >= n) {
      b.tokens -= n;
      this.buckets.set(key, b);
      return true;
    }
    this.buckets.set(key, b);
    return false;
  }
  /** Reset a bucket (e.g. after successful login clears the lockout). */
  reset(key: string): void {
    this.buckets.delete(key);
  }
  private prune() {
    const now = Date.now();
    const cutoff = now - 30 * 60_000;
    for (const [k, b] of this.buckets) {
      if (b.lastRefillMs < cutoff && b.tokens >= this.capacity) {
        this.buckets.delete(k);
      }
    }
  }
}

// Global limiters for common routes. Tuned conservatively for a single-VPS
// deploy — bump these if legitimate users hit them.
export const loginLimiter = new RateLimiter(10, 0.1);    // 10 burst, +1 every 10s
export const apiLimiter   = new RateLimiter(120, 2);      // 120 burst, +2/s
export const aiLimiter    = new RateLimiter(30, 0.2);     // 30 burst, +1 every 5s

/**
 * Pull the client IP via Fastify's `req.ip`, which already honours
 * `trustProxy` (set to `1` in index.ts → only the immediate Caddy hop is
 * trusted). DO NOT manually fall back to `x-forwarded-for` here — that
 * would re-open the very spoof bypass `trustProxy: 1` exists to prevent.
 */
export function clientIp(req: { ip?: string }): string {
  return req.ip || "unknown";
}
