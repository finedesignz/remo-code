/**
 * ScheduleRule — structured replacement for raw cron strings.
 *
 * Shape: { interval: int>=1, unit: 'hours'|'days'|'weeks', start_at: ISO }
 *
 * Conversion to cron is anchored at minute/hour-of-day of `start_at` in the
 * task's timezone (resolved client-side as the wall-clock components of
 * start_at). Interval anchoring beyond hour-of-day (e.g. "every 3 days from
 * Tuesday the 14th") is approximate — cron cannot express arbitrary day
 * anchoring — but the registry gates each fire with `start_at` so runs
 * before the start date are skipped.
 *
 * Web mirror lives at `web/src/lib/schedule-rules.ts`; both files are
 * intentionally tiny and duplicated to avoid a cross-package import.
 */

export type ScheduleUnit = 'hours' | 'days' | 'weeks'

export interface ScheduleRule {
  interval: number
  unit: ScheduleUnit
  start_at: string // ISO 8601
}

export type RuleValidation = { ok: true } | { ok: false; error: string }

export function validateRule(rule: unknown): RuleValidation {
  if (!rule || typeof rule !== 'object') return { ok: false, error: 'rule must be an object' }
  const r = rule as Partial<ScheduleRule>
  if (typeof r.interval !== 'number' || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999) {
    return { ok: false, error: 'interval must be integer 1..999' }
  }
  if (r.unit !== 'hours' && r.unit !== 'days' && r.unit !== 'weeks') {
    return { ok: false, error: 'unit must be hours, days, or weeks' }
  }
  if (typeof r.start_at !== 'string' || Number.isNaN(Date.parse(r.start_at))) {
    return { ok: false, error: 'start_at must be a valid ISO date string' }
  }
  return { ok: true }
}

export function validateRules(rules: unknown): { ok: true; rules: ScheduleRule[] } | { ok: false; error: string } {
  if (!Array.isArray(rules)) return { ok: false, error: 'schedule_rules must be an array' }
  if (rules.length === 0) return { ok: false, error: 'schedule_rules must have at least one rule' }
  if (rules.length > 20) return { ok: false, error: 'schedule_rules max 20 rules' }
  for (let i = 0; i < rules.length; i++) {
    const v = validateRule(rules[i])
    if (!v.ok) return { ok: false, error: `rule[${i}]: ${v.error}` }
  }
  return { ok: true, rules: rules as ScheduleRule[] }
}

/**
 * Convert a ScheduleRule to a 5-field cron expression.
 *
 * - hours: anchored on minute-of-hour from start_at; fires every N hours
 *   "MM STAR_SLASH_N STAR STAR STAR". For interval=1 the cron uses STAR.
 * - days: anchored on hh:mm from start_at; fires every N days
 *   "MM HH STAR_SLASH_N STAR STAR". For interval=1 the DOM field is STAR.
 * - weeks: anchored on hh:mm + weekday from start_at. interval is enforced
 *   by the dispatcher (cron can't express "every N weeks"). For interval=1
 *   the cron is "MM HH STAR STAR DOW"; for >1 we still emit weekly cron
 *   and the registry skips fires where (now - start_at) / 7d % interval != 0.
 *
 * `tz` is the IANA timezone used to extract the wall-clock components of
 * start_at — this matches how croner interprets the resulting cron.
 */
export function ruleToCron(rule: ScheduleRule, tz: string = 'UTC'): string {
  const d = new Date(rule.start_at)
  const parts = extractWallClock(d, tz)
  const { mm, hh, dow } = parts

  switch (rule.unit) {
    case 'hours': {
      if (rule.interval === 1) return `${mm} * * * *`
      return `${mm} */${rule.interval} * * *`
    }
    case 'days': {
      if (rule.interval === 1) return `${mm} ${hh} * * *`
      return `${mm} ${hh} */${rule.interval} * *`
    }
    case 'weeks': {
      return `${mm} ${hh} * * ${dow}`
    }
  }
}

function extractWallClock(d: Date, tz: string): { mm: number; hh: number; dow: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    })
    const parts = fmt.formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    let hh = parseInt(get('hour'), 10)
    if (hh === 24) hh = 0 // some locales emit "24"
    const mm = parseInt(get('minute'), 10)
    const wk = get('weekday')
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
    return {
      mm: Number.isFinite(mm) ? mm : 0,
      hh: Number.isFinite(hh) ? hh : 0,
      dow: dow >= 0 ? dow : 0,
    }
  } catch {
    return { mm: 0, hh: 0, dow: 0 }
  }
}

/**
 * Should a fire at `now` be skipped because the rule's start_at is in the
 * future, OR because the rule is `weeks` with interval > 1 and `now` doesn't
 * line up with the start_at weekly cadence?
 */
export function shouldSkipFire(rule: ScheduleRule, now: Date = new Date()): boolean {
  const start = new Date(rule.start_at)
  if (now.getTime() < start.getTime()) return true
  if (rule.unit === 'weeks' && rule.interval > 1) {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const elapsed = now.getTime() - start.getTime()
    const weeksSince = Math.floor(elapsed / weekMs)
    if (weeksSince % rule.interval !== 0) return true
  }
  return false
}

/** Pretty plain-English render. */
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
