/**
 * Cron expression utilities for the scheduled-tasks phase.
 *
 * Thin wrapper over `croner` exposing:
 *   - validate(expr): syntax + reachability check
 *   - nextRuns(expr, tz, n, from): the next N fire times in a given IANA TZ
 *   - compilePreset(preset): UI presets → 5-field cron strings
 *
 * The web mirror at `web/src/lib/cron.ts` is API-compatible so the
 * "next 3 runs" preview in the schedule editor matches the server.
 */
import { Cron } from 'croner'

export type Preset =
  | { kind: 'hourly' }
  | { kind: 'daily'; hh: number; mm: number }
  | { kind: 'every_n_minutes'; n: number }
  | { kind: 'weekdays'; hh: number; mm: number }
  | { kind: 'custom'; expr: string }

export type ValidationResult = { ok: true } | { ok: false; error: string }

export function validate(expr: string): ValidationResult {
  if (typeof expr !== 'string' || expr.trim().length === 0) {
    return { ok: false, error: 'cron expression is empty' }
  }
  try {
    const c = new Cron(expr, { paused: true })
    const next = c.nextRun()
    c.stop()
    if (!next) return { ok: false, error: 'expression yields no future runs' }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || 'invalid cron expression' }
  }
}

export function nextRuns(
  expr: string,
  timezone: string,
  n: number = 3,
  from: Date = new Date(),
): Date[] {
  try {
    const c = new Cron(expr, { timezone, paused: true })
    const out: Date[] = []
    let cursor: Date | undefined = from
    for (let i = 0; i < n; i++) {
      const next = c.nextRun(cursor)
      if (!next) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
    c.stop()
    return out
  } catch {
    return []
  }
}

/**
 * Compile a UI preset into a 5-field cron expression.
 *
 * Constraints:
 *   - daily/weekdays: hh in 0-23, mm in 0-59
 *   - every_n_minutes: n in 1-59. For values that don't evenly divide 60
 *     the result is still `*\/n * * * *` which fires every n minutes from
 *     minute 0 — documented quirk; UI should prefer divisors of 60.
 */
export function compilePreset(preset: Preset): string {
  switch (preset.kind) {
    case 'hourly':
      return '0 * * * *'
    case 'daily': {
      const { hh, mm } = preset
      assertRange('hh', hh, 0, 23)
      assertRange('mm', mm, 0, 59)
      return `${mm} ${hh} * * *`
    }
    case 'every_n_minutes': {
      const { n } = preset
      assertRange('n', n, 1, 59)
      return `*/${n} * * * *`
    }
    case 'weekdays': {
      const { hh, mm } = preset
      assertRange('hh', hh, 0, 23)
      assertRange('mm', mm, 0, 59)
      return `${mm} ${hh} * * 1-5`
    }
    case 'custom':
      return preset.expr
  }
}

function assertRange(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} out of range: expected ${min}..${max}, got ${v}`)
  }
}

/**
 * IANA timezone sanity check. We use Intl.DateTimeFormat — it throws on
 * unknown TZ names. Cheap to call at write time.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
