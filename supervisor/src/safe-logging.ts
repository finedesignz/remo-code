/**
 * EPIPE-safe logging primitives.
 *
 * Why this module exists (prod outage 2026-05-31):
 *   The Tauri tray (parent process) crashed, orphaning the `remo-code-supervisor
 *   run` sidecar. The sidecar's stdout/stderr pipe to the dead parent broke, so
 *   every subsequent `console.log/error` write to `process.stdout` threw
 *   `EPIPE: broken pipe`. With no `'error'` listener on the std streams, that
 *   surfaced as an `uncaughtException` — fired mid-`session.stop()`, which
 *   aborted the slot-cleanup path (`runs.delete`) before it ran. Leaked slots
 *   accumulated until `activeSlotCount()` hit the budget and every launch was
 *   denied `concurrency_cap`.
 *
 * Invariant: logging must NEVER throw into its caller. A dead parent pipe must
 * degrade logging to file-only and never abort a session lifecycle.
 */

/** Broken-pipe / dead-stream error codes that must never crash the sidecar. */
export const BROKEN_PIPE_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'EBADF',
  'ERR_STREAM_WRITE_AFTER_END',
])

export function isBrokenPipe(err: any): boolean {
  return !!err && (BROKEN_PIPE_CODES.has(err?.code) || /EPIPE|broken pipe/i.test(err?.message || ''))
}

/**
 * Attach `'error'` listeners to the given writable streams (stdout/stderr) so a
 * broken pipe to a dead parent is swallowed instead of rethrown as an
 * uncaughtException. Without a listener, an `'error'` emit on a stream is
 * rethrown by Node/Bun. Idempotent per-stream is the caller's concern; this
 * just attaches.
 */
export function installStreamErrorGuards(streams: Array<{ on: (ev: string, fn: (e: any) => void) => unknown }>): void {
  for (const s of streams) {
    try { s.on('error', () => { /* swallow — stay alive on broken pipe */ }) } catch {}
  }
}

/**
 * Wrap a console writer so a synchronous throw from the underlying write (e.g.
 * EPIPE on a broken stdout pipe) can never propagate to the caller. The
 * file-stream write is independently guarded. Returns a function with the same
 * `(...args) => void` shape as `console.log`.
 */
export function makeSafeTee(
  orig: (...a: any[]) => void,
  level: string,
  fileWrite: (line: string) => void,
): (...args: any[]) => void {
  return (...args: any[]) => {
    // Console write: guarded — broken pipe throws here and MUST NOT escape.
    try { orig(...args) } catch {}
    // File write: independently guarded.
    try {
      const line = args
        .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a)))
        .join(' ')
      fileWrite(`${new Date().toISOString()} ${level} ${line}\n`)
    } catch {}
  }
}
