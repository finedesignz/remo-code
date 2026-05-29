// Supervisor-side structured logger. Mirrors hub/src/observability/logger.ts
// envelope shape so a unified Loki/Datadog query later "just works" against
// both streams. No AsyncLocalStorage — the supervisor doesn't have a request
// lifecycle; correlation comes from per-event fields (supervisor_id,
// session_id, run_id).
//
// Output is plain stdout, one JSON line per call. Supervisor's existing
// file-logger tee in setupFileLogging still wraps stdout — so these lines
// also land in the per-day log file without extra plumbing.

type Level = 'debug' | 'info' | 'warn' | 'error'

interface LogFields { [k: string]: unknown }

function write(line: string): void {
  try { process.stdout.write(line) } catch { /* noop */ }
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
  write(serialized + '\n')
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
}
