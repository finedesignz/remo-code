// Async-local request context. Any code path inside an HTTP request or WS
// callback inherits {request_id, user_id, supervisor_id, session_id} without
// having to thread them through call signatures.
import { AsyncLocalStorage } from 'node:async_hooks'

export interface LogCtx {
  request_id?: string
  user_id?: string
  supervisor_id?: string
  session_id?: string
  // Free-form extension. Sub-callsites can append e.g. {role, task_id, run_id}.
  [k: string]: unknown
}

export const als = new AsyncLocalStorage<LogCtx>()

/** Read the current ALS frame (or an empty object if outside one). */
export function currentCtx(): LogCtx {
  return als.getStore() ?? {}
}

/**
 * Run `fn` inside a NEW ALS frame seeded with `ctx`. If we're already inside
 * a frame, the new one inherits the outer frame's fields (new fields win).
 */
export function withCtx<T>(ctx: LogCtx, fn: () => T): T {
  const merged = { ...(als.getStore() ?? {}), ...ctx }
  return als.run(merged, fn)
}

/**
 * Mutate the current ALS frame in place. Use sparingly — prefer `withCtx` for
 * a fresh scope. This is for late-binding facts like the user_id we only know
 * AFTER auth middleware finishes. No-op if outside an ALS frame.
 */
export function setCtx(patch: LogCtx): void {
  const store = als.getStore()
  if (!store) return
  Object.assign(store, patch)
}
