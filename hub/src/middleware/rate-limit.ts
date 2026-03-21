import type { Context, Next } from 'hono'

interface RateLimitOptions {
  windowMs: number
  max: number
  keyFn: (c: Context) => string
}

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

// Purge expired entries every 60 seconds
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of windows) {
    if (now > entry.resetAt) windows.delete(key)
  }
}, 60_000)

export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    const key = opts.keyFn(c)
    const now = Date.now()
    const entry = windows.get(key)

    if (!entry || now > entry.resetAt) {
      windows.set(key, { count: 1, resetAt: now + opts.windowMs })
      await next()
      return
    }

    entry.count++
    if (entry.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return c.json({ error: 'rate limit exceeded' }, 429)
    }

    await next()
  }
}
