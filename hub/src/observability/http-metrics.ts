// B4 (obs): per-request HTTP latency histogram. Kept separate from
// `middleware.ts` (which B1 owns) so the metrics dep doesn't cross-pollinate
// the request-id/ALS path.
//
// Labels are intentionally low-cardinality: `method` + `status_class` (2xx,
// 3xx, etc). Per-path labels would explode cardinality on apps with dynamic
// route params; the path is logged separately by B1.

import type { MiddlewareHandler } from 'hono'
import { httpRequestDuration } from './metrics'

function statusClass(status: number): string {
  if (status >= 500) return '5xx'
  if (status >= 400) return '4xx'
  if (status >= 300) return '3xx'
  if (status >= 200) return '2xx'
  return '1xx'
}

export function withHttpMetrics(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now()
    try {
      await next()
    } finally {
      const status = c.res?.status ?? 0
      const seconds = (Date.now() - startedAt) / 1000
      try {
        httpRequestDuration.observe(seconds, {
          method: c.req.method,
          status_class: statusClass(status),
        })
      } catch {
        // Never let an instrumentation glitch take the request down.
      }
    }
  }
}
