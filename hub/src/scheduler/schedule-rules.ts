/**
 * ScheduleRule — structured replacement for raw cron strings.
 *
 * Base shape: { interval: int 1..999, unit, start_at: ISO }.
 *
 * P1 additive extensions (backward-compatible — rules without these fields
 * behave exactly as before):
 *   - unit now also accepts 'minutes' and 'months'.
 *   - active_window?: { from:"HH:MM", to:"HH:MM" } — fires only when the
 *     task-local wall-clock time is inside the window (overnight wrap
 *     supported when from > to). Enforced per-rule in `shouldSkipFire`.
 *   - end bounds (task-scoped; carried on a rule for JSONB storage):
 *       until?: ISO8601      — stop firing at/after this instant
 *       max_runs?: 1..N      — stop after N TOTAL fires (any status)
 *       for?: {count,unit}   — convenience, normalized to `until` on write
 *     Bounds are enforced in the dispatcher (`fire`), which also auto-disables
 *     the task when a bound is hit. See `boundReason()`.
 *
 * Conversion to cron is anchored at minute/hour-of-day of `start_at` in the
 * task's timezone. Interval anchoring beyond hour-of-day is approximate — cron
 * cannot express arbitrary day anchoring — but the registry gates each fire
 * with `start_at` so runs before the start date are skipped. `months` is an
 * approximation: cron fires on the day-of-month of start_at every month; the
 * `interval` (every N months) is registry-gated like the weeks>1 case.
 *
 * Web mirror lives at `web/src/lib/schedule-rules.ts`; both files are
 * intentionally tiny and duplicated to avoid a cross-package import.
 */

export type ScheduleUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'

export interface ActiveWindow {
  from: string // "HH:MM" 24h, task-local
  to: string // "HH:MM" 24h, task-local
}

export interface ScheduleForBound {
  count: number
  unit: ScheduleUnit
}

export interface ScheduleRule {
  interval: number
  unit: ScheduleUnit
  start_at: string // ISO 8601
  // P1 additive (all optional)
  active_window?: ActiveWindow
  until?: string // ISO 8601 (resolved from `for` on write when `for` present)
  max_runs?: number // 1..N total fires
  for?: ScheduleForBound // convenience; normalized to `until` at save time
}

export type RuleValidation = { ok: true } | { ok: false; error: string }

const UNITS: ScheduleUnit[] = ['minutes', 'hours', 'days', 'weeks', 'months']
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function isValidHHMM(s: unknown): s is string {
  return typeof s === 'string' && HHMM_RE.test(s)
}

export function validateRule(rule: unknown): RuleValidation {
  if (!rule || typeof rule !== 'object') return { ok: false, error: 'rule must be an object' }
  const r = rule as Partial<ScheduleRule>
  if (typeof r.interval !== 'number' || !Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999) {
    return { ok: false, error: 'interval must be integer 1..999' }
  }
  if (!UNITS.includes(r.unit as ScheduleUnit)) {
    return { ok: false, error: 'unit must be minutes, hours, days, weeks, or months' }
  }
  if (typeof r.start_at !== 'string' || Number.isNaN(Date.parse(r.start_at))) {
    return { ok: false, error: 'start_at must be a valid ISO date string' }
  }
  // active_window
  if (r.active_window !== undefined) {
    const w = r.active_window
    if (!w || typeof w !== 'object' || !isValidHHMM(w.from) || !isValidHHMM(w.to)) {
      return { ok: false, error: 'active_window.from/to must be "HH:MM" (24h)' }
    }
    if (w.from === w.to) {
      return { ok: false, error: 'active_window.from and to must differ' }
    }
  }
  // bounds — at most the provided ones. `for` and `until` are mutually
  // exclusive at the storage layer (callers normalize `for` → `until`), but we
  // accept both shapes defensively.
  if (r.until !== undefined) {
    if (typeof r.until !== 'string' || Number.isNaN(Date.parse(r.until))) {
      return { ok: false, error: 'until must be a valid ISO date string' }
    }
  }
  if (r.max_runs !== undefined) {
    if (typeof r.max_runs !== 'number' || !Number.isInteger(r.max_runs) || r.max_runs < 1 || r.max_runs > 100000) {
      return { ok: false, error: 'max_runs must be integer 1..100000' }
    }
  }
  if (r.for !== undefined) {
    const f = r.for
    if (
      !f || typeof f !== 'object' ||
      typeof f.count !== 'number' || !Number.isInteger(f.count) || f.count < 1 || f.count > 999 ||
      !UNITS.includes(f.unit as ScheduleUnit)
    ) {
      return { ok: false, error: 'for.count must be 1..999 and for.unit a valid unit' }
    }
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
 * Normalize a rule for storage: resolve `for:{count,unit}` into a concrete
 * `until = start_at + count*unit`, then drop `for` so storage carries a single
 * absolute bound. Idempotent: a rule without `for` is returned unchanged.
 */
export function normalizeRuleForStorage(rule: ScheduleRule): ScheduleRule {
  if (!rule.for) return rule
  const start = new Date(rule.start_at)
  const until = addUnit(start, rule.for.count, rule.for.unit)
  const { for: _drop, ...rest } = rule
  return { ...rest, until: until.toISOString() }
}

export function normalizeRulesForStorage(rules: ScheduleRule[]): ScheduleRule[] {
  return rules.map(normalizeRuleForStorage)
}

/** Add count*unit to a date. months/years use calendar math; others ms math. */
function addUnit(d: Date, count: number, unit: ScheduleUnit): Date {
  const out = new Date(d.getTime())
  switch (unit) {
    case 'minutes': out.setTime(out.getTime() + count * 60_000); break
    case 'hours': out.setTime(out.getTime() + count * 3_600_000); break
    case 'days': out.setTime(out.getTime() + count * 86_400_000); break
    case 'weeks': out.setTime(out.getTime() + count * 7 * 86_400_000); break
    case 'months': out.setMonth(out.getMonth() + count); break
  }
  return out
}

/**
 * Convert a ScheduleRule to a 5-field cron expression.
 *
 * - minutes: "STAR_SLASH_N * * * *" (every N minutes from minute 0). interval=1
 *   emits "* * * * *" (every minute).
 * - hours: anchored on minute-of-hour from start_at; "MM STAR_SLASH_N * * *".
 * - days: anchored on hh:mm; "MM HH STAR_SLASH_N * *".
 * - weeks: anchored on hh:mm + weekday; interval>1 enforced by the registry.
 * - months: anchored on hh:mm + day-of-month from start_at; "MM HH DOM * *".
 *   interval>1 (every N months) is registry-gated (cron can't express it).
 *
 * `tz` is the IANA timezone used to extract the wall-clock components of
 * start_at — this matches how croner interprets the resulting cron.
 */
export function ruleToCron(rule: ScheduleRule, tz: string = 'UTC'): string {
  const d = new Date(rule.start_at)
  const { mm, hh, dow, dom } = extractWallClock(d, tz)

  switch (rule.unit) {
    case 'minutes': {
      if (rule.interval === 1) return `* * * * *`
      return `*/${rule.interval} * * * *`
    }
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
    case 'months': {
      // Fire on the start_at day-of-month every month; interval>1 gated by registry.
      return `${mm} ${hh} ${dom} * *`
    }
  }
}

function extractWallClock(d: Date, tz: string): { mm: number; hh: number; dow: number; dom: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      day: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(d)
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    let hh = parseInt(get('hour'), 10)
    if (hh === 24) hh = 0 // some locales emit "24"
    const mm = parseInt(get('minute'), 10)
    const dom = parseInt(get('day'), 10)
    const wk = get('weekday')
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
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

/** Task-local minutes-since-midnight for `now` in `tz`. */
function localMinutes(now: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    })
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

/**
 * Is `now` (task-local time in `tz`) inside the rule's active window?
 * Inclusive of `from`, exclusive of `to`. Handles the overnight wrap where
 * from > to (e.g. 22:00→06:00 covers 22:00–23:59 and 00:00–05:59). No window
 * means always active.
 */
export function isWithinActiveWindow(rule: ScheduleRule, now: Date, tz: string): boolean {
  const w = rule.active_window
  if (!w) return true
  const cur = localMinutes(now, tz)
  const from = hhmmToMinutes(w.from)
  const to = hhmmToMinutes(w.to)
  if (from === to) return true // degenerate; treat as always-on
  if (from < to) return cur >= from && cur < to
  // overnight wrap
  return cur >= from || cur < to
}

/**
 * Should a fire at `now` be skipped because the rule's start_at is in the
 * future, the unit-interval cadence doesn't line up (weeks>1 / months>1), OR
 * the current task-local time is outside the rule's active window?
 *
 * NOTE: end bounds (until/max_runs) are NOT checked here — they are task-scoped
 * and enforced in the dispatcher (`fire`) so the task can be auto-disabled.
 * `tz` defaults to UTC for the legacy 2-arg call sites; the registry passes the
 * task timezone so windows resolve correctly.
 */
export function shouldSkipFire(rule: ScheduleRule, now: Date = new Date(), tz: string = 'UTC'): boolean {
  const start = new Date(rule.start_at)
  if (now.getTime() < start.getTime()) return true
  if (rule.unit === 'weeks' && rule.interval > 1) {
    const weekMs = 7 * 24 * 60 * 60 * 1000
    const weeksSince = Math.floor((now.getTime() - start.getTime()) / weekMs)
    if (weeksSince % rule.interval !== 0) return true
  }
  if (rule.unit === 'months' && rule.interval > 1) {
    const monthsSince = monthsBetween(start, now)
    if (monthsSince % rule.interval !== 0) return true
  }
  if (!isWithinActiveWindow(rule, now, tz)) return true
  return false
}

function monthsBetween(start: Date, now: Date): number {
  return (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth())
}

/**
 * Evaluate the TASK-scoped end bounds across all rules. Returns a reason string
 * if the task should stop (and be auto-disabled), else null.
 *
 * `totalFires` is the count of run rows already created for the task (used for
 * max_runs). A bound is considered hit when ANY rule's bound is reached:
 *   - until: now >= until
 *   - max_runs: totalFires >= max_runs (i.e. this fire would exceed the cap)
 */
export function boundReason(rules: ScheduleRule[], now: Date, totalFires: number): string | null {
  for (const r of rules) {
    if (r.until) {
      const u = Date.parse(r.until)
      if (Number.isFinite(u) && now.getTime() >= u) return 'bound_until'
    }
    if (typeof r.max_runs === 'number' && totalFires >= r.max_runs) return 'bound_max_runs'
  }
  return null
}

/** Pretty plain-English render. */
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
