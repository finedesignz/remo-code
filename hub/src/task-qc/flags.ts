/**
 * PTYCAP-08 task-quality auditor: call-time flags, cadence validation and the
 * frozen per-run bounds. Leaf module: imports only scheduler/cron (pure).
 *
 * Every flag is read from process.env on EVERY call (never cached at import) and
 * defaults OFF. There is deliberately no token-cap knob: the engine is
 * deterministic and spends zero model tokens (FORK-1). In its place
 * TASK_QC_BOUNDS bounds the audited tasks, the history rows read per task, the
 * auto-fixes per pass, the rows written per run and the wall-clock of a pass.
 * Those constants are frozen; clampBounds() can only LOWER them (F1-A3).
 */
import { isValidTimezone, nextRuns, validate } from '../scheduler/cron.ts'

export const ENABLED_ENV = 'REMO_TASK_QC_ENABLED'
export const AUTOFIX_ENV = 'REMO_TASK_QC_AUTOFIX'
export const FAIL_STREAK_ENV = 'REMO_TASK_QC_FAIL_STREAK'
export const CADENCE_ENV = 'REMO_TASK_QC_CADENCE'

export const DEFAULT_FAIL_STREAK = 3
export const DEFAULT_CADENCE_CRON = '0 9 * * *'
/** A one-minute cadence is the 2026-07-11 tick-loop shape: never faster than hourly. */
export const MIN_CADENCE_MINUTES = 60

function truthyEnv(raw: string | undefined): boolean {
  if (raw == null) return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

export function isTaskQcEnabled(): boolean {
  return truthyEnv(process.env[ENABLED_ENV])
}

/** AUTOFIX is inert unless ENABLED is also on. */
export function isTaskQcAutofixEnabled(): boolean {
  return isTaskQcEnabled() && truthyEnv(process.env[AUTOFIX_ENV])
}

/** Positive finite integer from env, else 3. Never 0 (0 would flag every task). */
export function taskQcFailStreak(): number {
  const raw = process.env[FAIL_STREAK_ENV]
  if (raw == null || raw.trim() === '') return DEFAULT_FAIL_STREAK
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_FAIL_STREAK
}

export type CadenceCheck = { ok: true } | { ok: false; reason: 'invalid_cron' | 'invalid_timezone' | 'faster_than_hourly' }

/** Sampled runs when checking the gap, so a burst behind a long gap is caught. */
const CADENCE_SAMPLE_RUNS = 10

export function validateTaskQcCadence(expr: string, tz: string): CadenceCheck {
  if (!validate(expr).ok) return { ok: false, reason: 'invalid_cron' }
  if (!isValidTimezone(tz)) return { ok: false, reason: 'invalid_timezone' }
  const runs = nextRuns(expr, tz, CADENCE_SAMPLE_RUNS)
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_CADENCE_MINUTES * 60_000) {
      return { ok: false, reason: 'faster_than_hourly' }
    }
  }
  return { ok: true }
}

/** Env cadence when valid and at least hourly, else the default. */
export function taskQcCadenceCron(): string {
  const raw = process.env[CADENCE_ENV]
  if (raw == null || raw.trim() === '') return DEFAULT_CADENCE_CRON
  const expr = raw.trim()
  return validateTaskQcCadence(expr, 'UTC').ok ? expr : DEFAULT_CADENCE_CRON
}

export interface TaskQcBounds {
  maxAuditedTasks: number
  maxRunsPerTask: number
  maxAutoFixesPerPass: number
  maxRowsWrittenPerRun: number
  passTimeoutMs: number
}

export const TASK_QC_BOUNDS: Readonly<TaskQcBounds> = Object.freeze({
  maxAuditedTasks: 500,
  maxRunsPerTask: 50,
  maxAutoFixesPerPass: 25,
  maxRowsWrittenPerRun: 200,
  passTimeoutMs: 60000,
})

/** Each value is the MIN of the request and the constant; bad requests are ignored. */
export function clampBounds(req: Partial<TaskQcBounds> = {}): TaskQcBounds {
  const out = { ...TASK_QC_BOUNDS }
  for (const k of Object.keys(TASK_QC_BOUNDS) as Array<keyof TaskQcBounds>) {
    const v = req[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.min(Math.floor(v), TASK_QC_BOUNDS[k])
    }
  }
  return out
}
