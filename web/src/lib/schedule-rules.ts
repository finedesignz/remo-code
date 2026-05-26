/**
 * Browser mirror of `hub/src/scheduler/schedule-rules.ts`. Kept in sync so
 * the editor can compute the "next 3 fires" preview locally.
 */

export type ScheduleUnit = 'hours' | 'days' | 'weeks'

export interface ScheduleRule {
  interval: number
  unit: ScheduleUnit
  start_at: string
}

export function validateRule(rule: Partial<ScheduleRule>): string | null {
  if (typeof rule.interval !== 'number' || !Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 999) {
    return 'Interval must be 1..999'
  }
  if (rule.unit !== 'hours' && rule.unit !== 'days' && rule.unit !== 'weeks') {
    return 'Unit must be hours, days, or weeks'
  }
  if (typeof rule.start_at !== 'string' || Number.isNaN(Date.parse(rule.start_at))) {
    return 'Pick a valid start date/time'
  }
  return null
}

export function ruleToCron(rule: ScheduleRule, tz: string = 'UTC'): string {
  const d = new Date(rule.start_at)
  const parts = extractWallClock(d, tz)
  const { mm, hh, dow } = parts
  switch (rule.unit) {
    case 'hours':
      return rule.interval === 1 ? `${mm} * * * *` : `${mm} */${rule.interval} * * *`
    case 'days':
      return rule.interval === 1 ? `${mm} ${hh} * * *` : `${mm} ${hh} */${rule.interval} * *`
    case 'weeks':
      return `${mm} ${hh} * * ${dow}`
  }
}

function extractWallClock(d: Date, tz: string): { mm: number; hh: number; dow: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
    })
    const parts = fmt.formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    let hh = parseInt(get('hour'), 10)
    if (hh === 24) hh = 0
    const mm = parseInt(get('minute'), 10)
    const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(get('weekday'))
    return { mm: Number.isFinite(mm) ? mm : 0, hh: Number.isFinite(hh) ? hh : 0, dow: dow >= 0 ? dow : 0 }
  } catch {
    return { mm: 0, hh: 0, dow: 0 }
  }
}

export function shouldSkipFire(rule: ScheduleRule, now: Date = new Date()): boolean {
  const start = new Date(rule.start_at)
  if (now.getTime() < start.getTime()) return true
  if (rule.unit === 'weeks' && rule.interval > 1) {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const weeksSince = Math.floor((now.getTime() - start.getTime()) / weekMs)
    if (weeksSince % rule.interval !== 0) return true
  }
  return false
}

export function humanizeRule(rule: ScheduleRule): string {
  const unitWord = rule.interval === 1
    ? (rule.unit === 'hours' ? 'hour' : rule.unit === 'days' ? 'day' : 'week')
    : rule.unit
  const start = new Date(rule.start_at)
  const dateStr = isNaN(start.getTime())
    ? '—'
    : start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `Every ${rule.interval} ${unitWord} starting ${dateStr}`
}

/** Default rule when adding a new row in the builder. */
export function defaultRule(): ScheduleRule {
  // Round forward to next quarter hour
  const d = new Date()
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15, 0, 0)
  return { interval: 1, unit: 'days', start_at: d.toISOString() }
}
