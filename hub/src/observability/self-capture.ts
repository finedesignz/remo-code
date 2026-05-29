/**
 * B2 (obs): Hub self-error capture.
 *
 * Wires Node's `uncaughtException` + `unhandledRejection` and Hono's
 * `app.onError` into the existing error-capture intake pipeline as a
 * synthetic envelope. Reuses `fingerprint.ts` + `record.ts` verbatim so
 * the same dedupe/rate-limit/daily-cap gates apply.
 *
 * Dispatch is HARD-OFF for self-errors (`recordError(..., { dispatch:false })`).
 * Hub-internal exceptions never loop back into a Claude session.
 *
 * Activation:
 *   - Gated by `config.hubSelfOwnerUserId` (env `HUB_SELF_OWNER_USER_ID`).
 *   - When unset, `install()` no-ops and returns false.
 *
 * The self project is created on demand (idempotent `ensureSelfProject`)
 * and cached for the process lifetime.
 */
import type { Hono } from 'hono'
import { ensureSelfProject, type ErrorProject } from '../db/error-capture-dal.ts'
import { fingerprint } from '../error-capture/fingerprint.ts'
import { recordError } from '../error-capture/record.ts'

const SELF_PROJECT_NAME = '__hub_self__'

let selfProject: ErrorProject | null = null
let installed = false

/** Visible for tests: reset module state. */
export function _resetForTest(): void {
  selfProject = null
  installed = false
}

/** Visible for tests: inject a pre-built self project (skip DB ensure). */
export function _setSelfProjectForTest(p: ErrorProject | null): void {
  selfProject = p
}

function classify(err: unknown): { type: string; value: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name || 'Error', value: err.message || String(err), stack: err.stack }
  }
  if (typeof err === 'string') return { type: 'Error', value: err }
  try {
    return { type: 'Error', value: JSON.stringify(err) }
  } catch {
    return { type: 'Error', value: String(err) }
  }
}

/**
 * Capture a hub-internal exception. Safe to call from any context — never
 * throws, never blocks. Returns silently when self-capture isn't installed.
 */
export async function captureSelfError(err: unknown, source: string): Promise<void> {
  if (!selfProject) return
  try {
    const { type, value, stack } = classify(err)
    const fp = fingerprint(SELF_PROJECT_NAME, type, value, stack)
    const stacktrace_json = stack
      ? stack.split('\n').slice(0, 50).map((line) => ({ line }))
      : []
    await recordError(
      selfProject,
      {
        fingerprint: fp,
        error_type: `${type} [${source}]`,
        error_value: value,
        stacktrace_json,
        release: process.env.GIT_SHA || null,
      },
      { dispatch: false },
    )
  } catch (recordErr) {
    // Last-resort logging — never re-throw from a global error hook.
    console.error('[self-capture] recordError failed:', (recordErr as Error)?.message ?? recordErr)
  }
}

/**
 * Install process-level + Hono error hooks. Idempotent. Returns true if
 * self-capture is active for this process.
 */
export async function installSelfCapture(app: Hono, ownerUserId: string): Promise<boolean> {
  if (installed) return selfProject !== null
  installed = true

  if (!ownerUserId) {
    console.log('[self-capture] HUB_SELF_OWNER_USER_ID unset — self-capture disabled')
    return false
  }

  try {
    selfProject = await ensureSelfProject(ownerUserId)
  } catch (err) {
    console.error('[self-capture] ensureSelfProject failed; self-capture inert:', (err as Error)?.message ?? err)
    selfProject = null
    return false
  }

  process.on('uncaughtException', (err) => {
    void captureSelfError(err, 'uncaughtException')
  })
  process.on('unhandledRejection', (reason) => {
    void captureSelfError(reason, 'unhandledRejection')
  })

  // Wrap Hono's app.onError so we capture BEFORE responding. Don't override
  // an existing handler — additive only. The hub's index.ts already calls
  // app.onError() with its own redactor; this re-registers a wrapper that
  // captures first, then delegates the response.
  app.onError(async (err, c) => {
    void captureSelfError(err, 'hono')
    console.error('[error]', (err as Error)?.message ?? err)
    return c.json({ error: 'internal error' }, 500)
  })

  console.log(`[self-capture] installed (project=${selfProject.id})`)
  return true
}
