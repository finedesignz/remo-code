// Hono middleware: mint or echo a `request_id`, open an ALS frame for the
// lifetime of the request, and emit `req.start` / `req.end` lines.
//
// Inbound `x-request-id` is honored when present + safe (<=128 chars, ASCII
// printable, no whitespace). Otherwise we mint a UUIDv4. The chosen id is
// echoed back on the response so callers can correlate from their side.
import type { MiddlewareHandler } from 'hono'
import { als } from './als'
import { log } from './logger'

const REQUEST_ID_HEADER = 'x-request-id'

function sanitizeInbound(v: string | undefined | null): string | null {
  if (!v) return null
  if (v.length > 128) return null
  // ASCII printable, no whitespace — typical UUID/ULID/slug.
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return null
  }
  return v
}

function newId(): string {
  // crypto.randomUUID is available on Bun, Node 19+, modern browsers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  // Last-resort fallback — millisecond-precision + random suffix.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function withRequestId(): MiddlewareHandler {
  return async (c, next) => {
    const inbound = sanitizeInbound(c.req.header(REQUEST_ID_HEADER))
    const requestId = inbound ?? newId()
    c.header(REQUEST_ID_HEADER, requestId)
    // Stash on the Hono context too so handlers without ALS access can read it.
    c.set('requestId' as never, requestId as never)

    const startedAt = Date.now()
    const method = c.req.method
    const path = c.req.path

    await als.run({ request_id: requestId }, async () => {
      log.info('req.start', { method, path })
      try {
        await next()
      } finally {
        const status = c.res?.status ?? 0
        const duration_ms = Date.now() - startedAt
        log.info('req.end', { method, path, status, duration_ms })
      }
    })
  }
}
