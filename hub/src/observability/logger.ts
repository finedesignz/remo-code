// Zero-dep structured JSON logger. Emits one line per call to stdout, ready
// for Coolify's log ingest. Every line carries the current ALS context
// (request_id, user_id, supervisor_id, session_id) so a single grep
// reconstructs a full request trace.
//
// Envelope: { ts, level, msg, request_id?, user_id?, supervisor_id?,
//             session_id?, ...ctx }
//
// We intentionally bypass `console.*` so structured output isn't polluted by
// stray multi-line messages. Output goes through Bun's stdout writer when
// available, falling back to process.stdout.write so the helper also works
// under bare Node (e.g. when imported by test runners).
import { currentCtx } from './als'

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogFields {
  // Optional fields are merged on top of the ALS frame. Caller-provided keys
  // override ALS keys with the same name.
  [k: string]: unknown
}

let writer: (line: string) => void
try {
  // Bun has a faster stdout writer; fall back to process.stdout in Node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: any = globalThis as any
  if (g?.Bun?.write && g?.Bun?.stdout) {
    writer = (line) => { void g.Bun.write(g.Bun.stdout, line) }
  } else {
    writer = (line) => { try { process.stdout.write(line) } catch { /* noop */ } }
  }
} catch {
  writer = (line) => { try { process.stdout.write(line) } catch { /* noop */ } }
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  const ctx = currentCtx()
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  }
  // ALS-derived fields first (they're the correlation primitives).
  for (const k of Object.keys(ctx)) {
    if (ctx[k] !== undefined) line[k] = ctx[k]
  }
  // Then per-call fields — they win on conflict so callers can override.
  if (fields) {
    for (const k of Object.keys(fields)) {
      const v = fields[k]
      if (v !== undefined) line[k] = v
    }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(line)
  } catch {
    // Circular ref or BigInt — fall back to a minimal envelope so we never
    // crash the caller.
    serialized = JSON.stringify({
      ts: line.ts, level, msg, _serialization_failed: true,
    })
  }
  writer(serialized + '\n')
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
}

/**
 * Test-only hook — swap the underlying writer so unit tests can capture
 * emitted lines without spawning a subprocess. Returns the previous writer
 * so the test can restore it.
 */
export function _setWriterForTest(fn: (line: string) => void): (line: string) => void {
  const prev = writer
  writer = fn
  return prev
}
