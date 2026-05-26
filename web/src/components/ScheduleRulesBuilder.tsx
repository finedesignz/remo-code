import { useMemo } from 'react'
import {
  type ScheduleRule,
  type ScheduleUnit,
  defaultRule,
  ruleToCron,
  humanizeRule,
  validateRule,
} from '../lib/schedule-rules'
import { nextRuns } from '../lib/cron'

/**
 * ScheduleRulesBuilder — composes a list of structured schedule rules.
 *
 * UX: one row per rule — `Every [N] [hours|days|weeks] starting on [date] at [time]`.
 * Plus-button appends another rule. Multiple rules per task = fires on any.
 *
 * Never exposes raw cron strings to the user. The cron string is derived
 * from rule[0] for back-compat with the legacy croner engine; multi-rule
 * dispatching is handled hub-side by registering one Cron per rule.
 */

interface Props {
  rules: ScheduleRule[]
  timezone: string
  onChange: (rules: ScheduleRule[]) => void
}

const UNIT_OPTIONS: Array<{ value: ScheduleUnit; label: string }> = [
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
  { value: 'weeks', label: 'weeks' },
]

export function ScheduleRulesBuilder({ rules, timezone, onChange }: Props) {
  const effectiveRules = rules.length > 0 ? rules : [defaultRule()]

  const next3 = useMemo(() => {
    const all: number[] = []
    for (const r of effectiveRules) {
      if (validateRule(r) !== null) continue
      try {
        const expr = ruleToCron(r, timezone)
        const startMs = Date.parse(r.start_at)
        const from = Number.isFinite(startMs) && startMs > Date.now() ? new Date(startMs) : new Date()
        for (const d of nextRuns(expr, timezone, 3, from)) all.push(d.getTime())
      } catch {}
    }
    all.sort((a, b) => a - b)
    return Array.from(new Set(all)).slice(0, 3).map(ms => new Date(ms))
  }, [effectiveRules, timezone])

  const updateRule = (idx: number, patch: Partial<ScheduleRule>) => {
    onChange(effectiveRules.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }
  const removeRule = (idx: number) => {
    if (effectiveRules.length === 1) return
    onChange(effectiveRules.filter((_, i) => i !== idx))
  }
  const addRule = () => {
    onChange([...effectiveRules, defaultRule()])
  }

  return (
    <div className="space-y-2.5">
      <div className="space-y-2">
        {effectiveRules.map((rule, idx) => (
          <ScheduleRuleRow
            key={idx}
            rule={rule}
            canRemove={effectiveRules.length > 1}
            onChange={(patch) => updateRule(idx, patch)}
            onRemove={() => removeRule(idx)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addRule}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-indigo-300 hover:bg-indigo-600/15 transition-colors"
      >
        <span aria-hidden="true" className="text-base leading-none">+</span>
        <span>Add another rule</span>
      </button>

      {effectiveRules.length > 1 && (
        <p className="text-[11px] text-[var(--text-muted)] px-1">
          Task fires on <em>any</em> rule.
        </p>
      )}

      {next3.length > 0 && (
        <div className="bg-[var(--bg-tertiary)]/40 rounded-lg px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">
            Next 3 fires
          </div>
          <ul className="space-y-0.5">
            {next3.map((d, i) => (
              <li key={i} className="text-xs text-[var(--text-secondary)] font-mono">
                {d.toLocaleString(undefined, { timeZone: timezone, hour12: false })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

interface RowProps {
  rule: ScheduleRule
  canRemove: boolean
  onChange: (patch: Partial<ScheduleRule>) => void
  onRemove: () => void
}

export function ScheduleRuleRow({ rule, canRemove, onChange, onRemove }: RowProps) {
  // Split start_at into the two native inputs (date + time, in browser tz).
  const { dateStr, timeStr } = splitLocal(rule.start_at)
  const err = validateRule(rule)

  const setDate = (next: string) => {
    onChange({ start_at: combineLocal(next, timeStr) })
  }
  const setTime = (next: string) => {
    onChange({ start_at: combineLocal(dateStr, next) })
  }

  return (
    <div className="bg-[var(--bg-primary)]/40 rounded-lg p-2.5 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-2 sm:flex-wrap">
      <span className="text-xs text-[var(--text-muted)] sm:mr-1">Every</span>
      <input
        type="number"
        min={1}
        max={999}
        value={rule.interval}
        onChange={(e) => {
          const n = parseInt(e.target.value || '1', 10)
          onChange({ interval: Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : 1 })
        }}
        className="w-16 px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
      />
      <select
        value={rule.unit}
        onChange={(e) => onChange({ unit: e.target.value as ScheduleUnit })}
        className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {UNIT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="text-xs text-[var(--text-muted)] sm:mx-1">starting on</span>
      <input
        type="date"
        value={dateStr}
        onChange={(e) => setDate(e.target.value)}
        className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <span className="text-xs text-[var(--text-muted)] sm:mx-1">at</span>
      <input
        type="time"
        value={timeStr}
        onChange={(e) => setTime(e.target.value)}
        className="px-2 py-1.5 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-auto px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
          aria-label="Remove rule"
        >
          Remove
        </button>
      )}
      {err && (
        <p className="basis-full text-[11px] text-red-300 px-1">{err}</p>
      )}
      <p className="basis-full text-[11px] text-[var(--text-muted)] px-1">
        {humanizeRule(rule)}
      </p>
    </div>
  )
}

function splitLocal(iso: string): { dateStr: string; timeStr: string } {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return { dateStr: '', timeStr: '' }
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

function combineLocal(dateStr: string, timeStr: string): string {
  if (!dateStr) return new Date().toISOString()
  const [hh, mm] = (timeStr || '00:00').split(':').map(n => parseInt(n, 10))
  const [y, mo, d] = dateStr.split('-').map(n => parseInt(n, 10))
  const dt = new Date(y, (mo || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0)
  return dt.toISOString()
}
