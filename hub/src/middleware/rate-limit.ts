// Phase 07-G: extended rate limiter.
//
// Backwards-compatible default export `rateLimit({ windowMs, max, keyFn })` —
// existing call sites keep working unchanged.
//
// New:
//   - `RateLimitBackend` interface: in-memory default; Redis when
//     `TITANIUM_REDIS_URL` is set (pluggable; tests can inject).
//   - `rateLimitMulti({ buckets: [...], silent?: boolean })`: enforces N
//     bucket-windows simultaneously. Used for `request-link` (3/min/IP
//     + 5/hr/email). `silent: true` swallows the 429 and lets the route
//     respond normally (login-enumeration prevention) — the caller checks
//     `c.get('rateLimited')` to decide whether to skip the side-effect.
//   - `Retry-After` always set when 429 is returned.

import type { Context, Next } from 'hono';
import Redis from 'ioredis';
import { config } from '../config';

// Backend ────────────────────────────────────────────────────────────────────

export interface RateLimitBackend {
  /** Returns the new count after incrementing. TTL applied on first hit. */
  incr(key: string, windowMs: number): Promise<number>;
}

class MemoryBackend implements RateLimitBackend {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor() {
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.windows) if (now > v.resetAt) this.windows.delete(k);
    }, 60_000);
    (t as any).unref?.();
  }

  async incr(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || now > entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }
}

class RedisBackend implements RateLimitBackend {
  constructor(private redis: Redis) {}

  async incr(key: string, windowMs: number): Promise<number> {
    const k = `ratelimit:${key}`;
    const ttlSec = Math.max(1, Math.ceil(windowMs / 1000));
    // Atomic-ish: INCR returns the new count; EXPIRE NX applies TTL only on
    // the first hit so the window doesn't reset on each increment.
    const count = await this.redis.incr(k);
    if (count === 1) {
      await this.redis.expire(k, ttlSec, 'NX');
    }
    return count;
  }
}

let _backend: RateLimitBackend | null = null;
let _redis: Redis | null = null;

export function getRateLimitBackend(): RateLimitBackend {
  if (_backend) return _backend;
  if (config.titanium.redisUrl) {
    try {
      _redis = new Redis(config.titanium.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
      _backend = new RedisBackend(_redis);
      return _backend;
    } catch (err) {
      console.warn('[ratelimit] redis init failed, falling back to memory:', (err as Error).message);
    }
  }
  _backend = new MemoryBackend();
  return _backend;
}

/** Test seam — inject a custom backend (e.g. a controllable in-memory one). */
export function __setRateLimitBackendForTesting(b: RateLimitBackend | null) {
  _backend = b;
}

// Public API ─────────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFn: (c: Context) => string;
  /** Header prefix for the bucket name (audit/debug). Defaults to 'default'. */
  bucket?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const key = `${opts.bucket ?? 'default'}:${opts.windowMs}:${opts.keyFn(c)}`;
    let count: number;
    try {
      count = await getRateLimitBackend().incr(key, opts.windowMs);
    } catch (err) {
      // Fail-open on backend failure — better to serve than to lock everyone out.
      console.error('[ratelimit] backend error:', (err as Error).message);
      return next();
    }
    if (count > opts.max) {
      c.header('Retry-After', String(Math.ceil(opts.windowMs / 1000)));
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
    return next();
  };
}

export interface RateLimitBucket {
  windowMs: number;
  max: number;
  /** Returns the bucket key. Return `null` to skip this bucket for the request. */
  keyFn: (c: Context) => string | null;
  bucket?: string;
}

export interface RateLimitMultiOptions {
  buckets: RateLimitBucket[];
  /** If true, sets c.set('rateLimited', true) and continues — does NOT 429. */
  silent?: boolean;
  /** Audit hook fired when any bucket trips (always called even when silent). */
  onLimit?: (c: Context, bucket: RateLimitBucket) => Promise<void> | void;
}

export function rateLimitMulti(opts: RateLimitMultiOptions) {
  return async (c: Context, next: Next) => {
    let limited: RateLimitBucket | null = null;
    let retryAfter = 0;
    for (const b of opts.buckets) {
      const rawKey = b.keyFn(c);
      if (rawKey == null) continue;
      const key = `${b.bucket ?? 'multi'}:${b.windowMs}:${rawKey}`;
      try {
        const count = await getRateLimitBackend().incr(key, b.windowMs);
        if (count > b.max) {
          limited = b;
          retryAfter = Math.max(retryAfter, Math.ceil(b.windowMs / 1000));
          break;
        }
      } catch (err) {
        console.error('[ratelimit-multi] backend error:', (err as Error).message);
        // Fail-open per-bucket.
      }
    }
    if (limited) {
      if (opts.onLimit) {
        try { await opts.onLimit(c, limited); } catch {}
      }
      if (opts.silent) {
        c.set('rateLimited', true);
        return next();
      }
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate limit exceeded' }, 429);
    }
    c.set('rateLimited', false);
    return next();
  };
}
