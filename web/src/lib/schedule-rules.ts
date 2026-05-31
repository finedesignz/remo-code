/**
 * Browser mirror of `hub/src/scheduler/schedule-rules.ts`. Kept in sync so
 * the editor can compute the "next 3 fires" preview locally and validate.
 *
 * P1 additive: 'minutes'/'months' units, active_window, and end bounds
 * (until / max_runs / for). `for` is normalized to `until` server-side on
 * write; the editor sends whichever the user picked.
 */

export type ScheduleUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'

export interface ActiveWindow {
  from: string // "HH:MM"
  to: string // "HH:MM"
}

export interface ScheduleForBound {
  count: number
  unit: ScheduleUnit
}

export interface ScheduleRule {
  interval: number
  unit: ScheduleUnit
  start_at: string
  active_window?: ActiveWindow
  until?: string
  max_runs?: number
  for?: ScheduleForBound
}

const UNITS: ScheduleUnit[] = ['minutes', 'hours', 'days', 'weeks', 'months']
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function validateRule(rule: Partial<ScheduleRule>): string | null {
  if (typeof rule.interval !== 'number' || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999) {
    return 'Interval must be 1..999'
  }
  if (!UNITS.includes(rule.unit as ScheduleUnit)) {
    return 'Unit must be minutes, hours, days, weeks, or months'
  }
  if (typeof rule.start_at !== 'string' || Number.isNaN(Date.parse(rule.start_at))) {
    return 'Pick a valid start date/time'
  }
  if (rule.active_window !== undefined) {
    const w = rule.active_window
    if (!w || !HHMM_RE.test(w.from) || !HHMM_RE.test(w.to)) return 'Active window times must be HH:MM'
    if (w.from === w.to) return 'Active window from/to must differ'
  }
  if (rule.until !== undefined && Number.isNaN(Date.parse(rule.until))) {
    return 'Pick a valid "until" date'
  }
  if (rule.max_runs !== undefined && (!Number.isInteger(rule.max_runs) || rule.max_runs < 1 || rule.max_runs > 100000)) {
    return 'Max runs must be 1..100000'
  }
  if (rule.for !== undefined) {
    const f = rule.for
    if (!f || !Number.isInteger(f.count) || f.count < 1 || f.count > 999 || !UNITS.includes(f.unit)) {
      return 'Stop-after count must be 1..999'
    }
  }
  return null
}

export function ruleToCron(rule: ScheduleRule, tz: string = 'UTC'): string {
  const d = new Date(rule.start_at)
  const { mm, hh, dow, dom } = extractWallClock(d, tz)
  switch (rule.unit) {
    case 'minutes':
      return rule.interval === 1 ? `* * * * *` : `*/${rule.interval} * * * *`
    case 'hours':
      return rule.interval === 1 ? `${mm} * * * *` : `${mm} */${rule.interval} * * *`
    case 'days':
      return rule.interval === 1 ? `${mm} ${hh} * * *` : `${mm} ${hh} */${rule.interval} * *`
    case 'weeks':
      return `${mm} ${hh} * * ${dow}`
    case 'months':
      return `${mm} ${hh} ${dom} * *`
  }
}

function extractWallClock(d: Date, tz: string): { mm: number; hh: number; dow: number; dom: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', day: '2-digit', hour12: false,
    })
    const parts = fmt.formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    let hh = parseInt(get('hour'), 10)
    if (hh === 24) hh = 0
    const mm = parseInt(get('minute'), 10)
    const dom = parseInt(get('day'), 10)
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'))
    return {
      mm: Number.isFinite(mm) ? mm : 0,
      hh: Number.isFinite(hh) ? hh : 0,
      dow: dow >= 0 ? dow : 0,
      dom: Number.isFinite(dom) && dom >= 1 ? dom : 1,
    }
  } catch {
    return { mm: 0, hh: 0, dow: 0, dom: 1 }
  }
}

function localMinutes(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    const parts = fmt.formatToParts(now)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    let hh = parseInt(get('hour'), 10)
    if (hh === 24) hh = 0
    const mm = parseInt(get('minute'), 10)
    return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0)
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes()
  }
}

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(n => parseInt(n, 10))
  return (h || 0) * 60 + (m || 0)
}

export function isWithinActiveWindow(rule: ScheduleRule, now: Date, tz: string): boolean {
  const w = rule.active_window
  if (!w) return true
  const cur = localMinutes(now, tz)
  const from = hhmmToMinutes(w.from)
  const to = hhmmToMinutes(w.to)
  if (from === to) return true
  if (from < to) return cur >= from && cur < to
  return cur >= from || cur < to
}

export function shouldSkipFire(rule: ScheduleRule, now: Date = new Date(), tz: string = 'UTC'): boolean {
  const start = new Date(rule.start_at)
  if (now.getTime() < start.getTime()) return true
  if (rule.unit === 'weeks' && rule.interval > 1) {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const weeksSince = Math.floor((now.getTime() - start.getTime()) / weekMs)
    if (weeksSince % rule.interval !== 0) return true
  }
  if (rule.unit === 'months' && rule.interval > 1) {
    const monthsSince = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth())
    if (monthsSince % rule.interval !== 0) return true
  }
  if (!isWithinActiveWindow(rule, now, tz)) return true
  return false
}

export function humanizeRule(rule: ScheduleRule): string {
  const singular: Record<ScheduleUnit, string> = {
    minutes: 'minute', hours: 'hour', days: 'day', weeks: 'week', months: 'month',
  }
  const unitWord = rule.interval === 1 ? singular[rule.unit] : rule.unit
  const start = new Date(rule.start_at)
  const dateStr = isNaN(start.getTime())
    ? '—'
    : start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  let s = `Every ${rule.interval} ${unitWord} starting ${dateStr}`
  if (rule.active_window) s += `, active ${rule.active_window.from}–${rule.active_window.to}`
  if (rule.until) {
    const u = new Date(rule.until)
    if (!isNaN(u.getTime())) s += `, until ${u.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
  } else if (typeof rule.max_runs === 'number') {
    s += `, ${rule.max_runs} run${rule.max_runs === 1 ? '' : 's'}`
  }
  return s
}

/** Default rule when adding a new row in the builder. */
export function defaultRule(): ScheduleRule {
  // Round forward to next quarter hour
  const d = new Date()
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0)
  return { interval: 1, unit: 'days', start_at: d.toISOString() }
}
