// Supervisor-side structured logger. Mirrors hub/src/observability/logger.ts
// envelope shape so a unified Loki/Datadog query later "just works" against
// both streams. No AsyncLocalStorage — the supervisor doesn't have a request
// lifecycle; correlation comes from per-event fields (supervisor_id,
// session_id, run_id).
//
// Output is plain stdout/stderr, one JSON line per call, via console.log/
// console.error — NOT process.stdout.write directly. setupFileLogging (in
// index.ts) monkeypatches console.log/warn/error to tee every call into the
// per-day log file; it does NOT wrap process.stdout.write. A prior version of
// this module wrote straight to process.stdout.write and silently bypassed
// that tee — every obs.* call (including every hub_client.log line emitted
// from SupervisorClient.log(), which routes exclusively through this module)
// was invisible in supervisor.log even while the process ran normally. Fixed
// 2026-08-18: route through console.* so the existing tee "just works" per
// the (previously false) claim in this comment.
//
// error/warn intentionally go to console.error/warn (stderr) so log-level
// filtering by downstream stderr/stdout splitting still works; both are
// captured by the same file tee regardless of stream.

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogFields { [k: string]: unknown }

function write(level: Level, line: string): void {
  try {
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  } catch { /* noop */ }
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    component: 'supervisor',
  }
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
    serialized = JSON.stringify({ ts: line.ts, level, msg, component: 'supervisor', _serialization_failed: true })
  }
  write(level, serialized)
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
}
