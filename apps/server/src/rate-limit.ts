// In-memory token buckets for the agent API. One server process owns the traffic, so memory is
// enough; a restart forgives everyone, which is fine for abuse control (not billing).

type Bucket = { tokens: number; at: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Take one unit from `key`'s bucket, which holds `limit` units and refills over `perMs`.
   * `ok: false` carries the seconds until a unit is available again.
   */
  take(
    key: string,
    limit: number,
    perMs = 60_000,
  ): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    this.sweep(now, perMs);
    const bucket = this.refilled(key, limit, perMs, now);
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return { ok: false, retryAfter: retryAfter(bucket, limit, perMs) };
    bucket.tokens -= 1;
    return { ok: true };
  }

  /** Whether `take` would succeed, without taking anything. */
  peek(
    key: string,
    limit: number,
    perMs = 60_000,
  ): { ok: true } | { ok: false; retryAfter: number } {
    const bucket = this.refilled(key, limit, perMs, this.now());
    return bucket.tokens < 1
      ? { ok: false, retryAfter: retryAfter(bucket, limit, perMs) }
      : { ok: true };
  }

  private refilled(key: string, limit: number, perMs: number, now: number): Bucket {
    const bucket = this.buckets.get(key) ?? { tokens: limit, at: now };
    return {
      tokens: Math.min(limit, bucket.tokens + ((now - bucket.at) * limit) / perMs),
      at: now,
    };
  }

  /** Drop buckets idle for ten windows, at most once a minute. */
  private sweep(now: number, perMs: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > perMs * 10) this.buckets.delete(key);
    }
  }
}

const retryAfter = (bucket: Bucket, limit: number, perMs: number) =>
  Math.max(1, Math.ceil(((1 - bucket.tokens) * perMs) / limit / 1000));
