/**
 * Browser-side mirror of `hub/src/scheduler/cron.ts`. Kept API-compatible so
 * the "next 3 runs" preview in the schedule editor matches what the hub will
 * actually fire. Web cannot import from `hub/` — this file is the contract.
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

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Browser default timezone. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
