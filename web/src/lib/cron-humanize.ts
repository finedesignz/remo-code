import { parseCronToState } from '../components/CronBuilder'
import type { CronMode } from '../components/CronBuilder'

/**
 * Shared cron humanizer used by both CronBuilder (live preview) and the
 * schedules list (row summary). Parses a 5-field cron expression via
 * parseCronToState() and turns the recovered BuilderState back into a
 * friendly English description that covers every mode the builder can
 * produce. Falls back to the raw expression for truly custom crons.
 */

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface DescribableState {
  mode: CronMode
  minN: number
  hourN: number
  hourMin: number
  hh: number
  mm: number
  dayN: number
  weekdays: number[]
  dom: number | 'L'
  monthN: number
  monthDom: number
  cMin: string
  cHour: string
  cDom: string
  cMonth: string
  cDow: string
}

export function fmtTime(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function describeMode(s: DescribableState): string {
  switch (s.mode) {
    case 'every_n_minutes':
      return s.minN === 1 ? 'Every minute' : `Every ${s.minN} minutes`
    case 'every_n_hours': {
      const at = `:${String(s.hourMin).padStart(2, '0')}`
      return s.hourN === 1 ? `Every hour at ${at}` : `Every ${s.hourN} hours at ${at}`
    }
    case 'daily':
      return `Every day at ${fmtTime(s.hh, s.mm)}`
    case 'every_n_days':
      return s.dayN === 1
        ? `Every day at ${fmtTime(s.hh, s.mm)}`
        : `Every ${s.dayN} days at ${fmtTime(s.hh, s.mm)}`
    case 'weekly': {
      if (s.weekdays.length === 0) return 'Pick at least one weekday'
      const names = s.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ')
      return `Every week on ${names} at ${fmtTime(s.hh, s.mm)}`
    }
    case 'monthly':
      return `Monthly on ${s.dom === 'L' ? 'the last day' : `day ${s.dom}`} at ${fmtTime(s.hh, s.mm)}`
    case 'every_n_months':
      return s.monthN === 1
        ? `Monthly on day ${s.monthDom} at ${fmtTime(s.hh, s.mm)}`
        : `Every ${s.monthN} months on day ${s.monthDom} at ${fmtTime(s.hh, s.mm)}`
    case 'custom':
      return 'Custom expression'
  }
}

/**
 * Humanize a 5-field cron string for end-user display. Returns the raw
 * expression unchanged for empty/invalid input or genuinely custom crons
 * (so the list view still shows something meaningful instead of a generic
 * "Custom expression" label).
 */
export function humanizeCron(expr: string): string {
  if (!expr) return ''
  const trimmed = expr.trim()
  if (!trimmed) return expr
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return expr
  const state = parseCronToState(trimmed)
  if (state.mode === 'custom') return trimmed
  return describeMode(state)
}
