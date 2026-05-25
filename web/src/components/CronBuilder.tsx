import { useEffect, useMemo, useState } from 'react'
import { nextRuns, validate as validateCron } from '../lib/cron'

/**
 * CronBuilder — dropdown/input UI for composing 5-field cron strings.
 *
 * The composed cron string is the source of truth; this component never asks
 * the user to type cron syntax (Custom mode uses five labeled per-field inputs
 * with accepted-grammar hints). The hub uses croner which accepts standard
 * 5-field cron + `L` (last-day-of-month) so we stay within that grammar.
 */

export type CronMode =
  | 'every_n_minutes'
  | 'every_n_hours'
  | 'daily'
  | 'every_n_days'
  | 'weekly'
  | 'monthly'
  | 'every_n_months'
  | 'custom'

interface Props {
  value: string
  timezone: string
  onChange: (cron: string) => void
}

interface BuilderState {
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

const DEFAULTS: BuilderState = {
  mode: 'daily',
  minN: 15,
  hourN: 1,
  hourMin: 0,
  hh: 9,
  mm: 0,
  dayN: 1,
  weekdays: [1],
  dom: 1,
  monthN: 1,
  monthDom: 1,
  cMin: '*',
  cHour: '*',
  cDom: '*',
  cMonth: '*',
  cDow: '*',
}

const MIN_N_OPTIONS = [1, 2, 5, 10, 15, 20, 30, 45]
const HOUR_N_OPTIONS = [1, 2, 3, 4, 6, 8, 12]
const DAY_N_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1)
const MONTH_N_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1)
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MODE_OPTIONS: Array<{ value: CronMode; label: string }> = [
  { value: 'every_n_minutes', label: 'Every N minutes' },
  { value: 'every_n_hours', label: 'Every N hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'every_n_days', label: 'Every N days' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'every_n_months', label: 'Every N months' },
  { value: 'custom', label: 'Custom' },
]

const QUICK_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Mon 9am', cron: '0 9 * * 1' },
]

export function CronBuilder({ value, timezone, onChange }: Props) {
  const [state, setState] = useState<BuilderState>(() => parseCronToState(value))

  useEffect(() => {
    const composed = composeCron(state)
    if (composed !== value) setState(parseCronToState(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const composed = useMemo(() => composeCron(state), [state])
  useEffect(() => {
    if (composed && composed !== value) onChange(composed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composed])

  const validation = useMemo(() => validateCron(composed), [composed])
  const next3 = useMemo(
    () => (validation.ok ? nextRuns(composed, timezone, 3) : []),
    [composed, timezone, validation.ok],
  )
  const english = useMemo(() => describeMode(state), [state])

  const update = <K extends keyof BuilderState>(k: K, v: BuilderState[K]) =>
    setState((s) => ({ ...s, [k]: v }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {QUICK_PRESETS.map((p) => (
          <button
            key={p.cron}
            type="button"
            onClick={() => setState(parseCronToState(p.cron))}
            className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
              composed === p.cron
                ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <select
        value={state.mode}
        onChange={(e) => update('mode', e.target.value as CronMode)}
        className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {MODE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {state.mode === 'every_n_minutes' && (
        <Row>
          <Label>Every</Label>
          <NumSelect value={state.minN} options={MIN_N_OPTIONS} onChange={(v) => update('minN', v)} />
          <Hint>minutes</Hint>
        </Row>
      )}

      {state.mode === 'every_n_hours' && (
        <div className="space-y-2">
          <Row>
            <Label>Every</Label>
            <NumSelect value={state.hourN} options={HOUR_N_OPTIONS} onChange={(v) => update('hourN', v)} />
            <Hint>hours</Hint>
          </Row>
          <Row>
            <Label>At minute</Label>
            <NumSelect value={state.hourMin} options={range(0, 59)} onChange={(v) => update('hourMin', v)} pad />
            <Hint>of the hour</Hint>
          </Row>
        </div>
      )}

      {state.mode === 'daily' && (
        <Row>
          <Label>At</Label>
          <HHMM hh={state.hh} mm={state.mm} onChange={(hh, mm) => setState((s) => ({ ...s, hh, mm }))} />
        </Row>
      )}

      {state.mode === 'every_n_days' && (
        <div className="space-y-2">
          <Row>
            <Label>Every</Label>
            <NumSelect value={state.dayN} options={DAY_N_OPTIONS} onChange={(v) => update('dayN', v)} />
            <Hint>days</Hint>
          </Row>
          <Row>
            <Label>At</Label>
            <HHMM hh={state.hh} mm={state.mm} onChange={(hh, mm) => setState((s) => ({ ...s, hh, mm }))} />
          </Row>
        </div>
      )}

      {state.mode === 'weekly' && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAY_LABELS.map((lbl, idx) => {
              const selected = state.weekdays.includes(idx)
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setState((s) => {
                      const set = new Set(s.weekdays)
                      if (set.has(idx)) set.delete(idx)
                      else set.add(idx)
                      return { ...s, weekdays: Array.from(set).sort() }
                    })
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/70'
                  }`}
                >
                  {lbl}
                </button>
              )
            })}
          </div>
          <Row>
            <Label>At</Label>
            <HHMM hh={state.hh} mm={state.mm} onChange={(hh, mm) => setState((s) => ({ ...s, hh, mm }))} />
          </Row>
        </div>
      )}

      {state.mode === 'monthly' && (
        <div className="space-y-2">
          <Row>
            <Label>On day</Label>
            <select
              value={state.dom === 'L' ? 'L' : String(state.dom)}
              onChange={(e) => update('dom', e.target.value === 'L' ? 'L' : parseInt(e.target.value, 10))}
              className="px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {range(1, 31).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
              <option value="L">Last day</option>
            </select>
          </Row>
          <Row>
            <Label>At</Label>
            <HHMM hh={state.hh} mm={state.mm} onChange={(hh, mm) => setState((s) => ({ ...s, hh, mm }))} />
          </Row>
        </div>
      )}

      {state.mode === 'every_n_months' && (
        <div className="space-y-2">
          <Row>
            <Label>Every</Label>
            <NumSelect value={state.monthN} options={MONTH_N_OPTIONS} onChange={(v) => update('monthN', v)} />
            <Hint>months</Hint>
          </Row>
          <Row>
            <Label>On day</Label>
            <NumSelect value={state.monthDom} options={range(1, 31)} onChange={(v) => update('monthDom', v)} />
          </Row>
          <Row>
            <Label>At</Label>
            <HHMM hh={state.hh} mm={state.mm} onChange={(hh, mm) => setState((s) => ({ ...s, hh, mm }))} />
          </Row>
        </div>
      )}

      {state.mode === 'custom' && (
        <div className="space-y-2">
          <div className="grid grid-cols-5 gap-1.5">
            <CustomField label="min" value={state.cMin} onChange={(v) => update('cMin', v)} />
            <CustomField label="hour" value={state.cHour} onChange={(v) => update('cHour', v)} />
            <CustomField label="day" value={state.cDom} onChange={(v) => update('cDom', v)} />
            <CustomField label="month" value={state.cMonth} onChange={(v) => update('cMonth', v)} />
            <CustomField label="weekday" value={state.cDow} onChange={(v) => update('cDow', v)} />
          </div>
          <p className="text-[10px] text-[var(--text-muted)]">
            Each field accepts <span className="font-mono">*</span>, a number, a list{' '}
            <span className="font-mono">a,b,c</span>, a range <span className="font-mono">a-b</span>, or a step{' '}
            <span className="font-mono">*/n</span>.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="font-mono text-sm text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/40 rounded-lg px-3 py-2">
          {composed || ' '}
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <p className="text-xs text-[var(--text-muted)]">{english}</p>
          {!validation.ok && composed && (
            <p className="text-xs text-red-400">Invalid: {validation.error}</p>
          )}
        </div>
        {validation.ok && next3.length > 0 && (
          <div className="bg-[var(--bg-tertiary)]/40 rounded-lg px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Next 3 runs</div>
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
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center flex-wrap gap-2">{children}</div>
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-[var(--text-muted)] min-w-[60px]">{children}</span>
}
function Hint({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-[var(--text-muted)]">{children}</span>
}

function NumSelect({
  value, options, onChange, pad,
}: { value: number; options: number[]; onChange: (n: number) => void; pad?: boolean }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
      className="px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
    >
      {options.map((n) => (
        <option key={n} value={n}>{pad ? String(n).padStart(2, '0') : n}</option>
      ))}
    </select>
  )
}

function HHMM({ hh, mm, onChange }: { hh: number; mm: number; onChange: (hh: number, mm: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <NumSelect value={hh} options={range(0, 23)} onChange={(v) => onChange(v, mm)} pad />
      <span className="text-[var(--text-muted)]">:</span>
      <NumSelect value={mm} options={range(0, 59)} onChange={(v) => onChange(hh, v)} pad />
      <span className="text-xs text-[var(--text-muted)] ml-1">24-hour</span>
    </div>
  )
}

function CustomField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.trim() || '*')}
        className="w-full px-2 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm font-mono text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-indigo-500 text-center"
      />
    </label>
  )
}

function range(lo: number, hi: number): number[] {
  const out: number[] = []
  for (let i = lo; i <= hi; i++) out.push(i)
  return out
}

export function composeCron(s: BuilderState): string {
  switch (s.mode) {
    case 'every_n_minutes':
      return s.minN === 1 ? '* * * * *' : `*/${s.minN} * * * *`
    case 'every_n_hours':
      return s.hourN === 1 ? `${s.hourMin} * * * *` : `${s.hourMin} */${s.hourN} * * *`
    case 'daily':
      return `${s.mm} ${s.hh} * * *`
    case 'every_n_days':
      return s.dayN === 1 ? `${s.mm} ${s.hh} * * *` : `${s.mm} ${s.hh} */${s.dayN} * *`
    case 'weekly': {
      const dows = s.weekdays.length > 0 ? s.weekdays.slice().sort().join(',') : '*'
      return `${s.mm} ${s.hh} * * ${dows}`
    }
    case 'monthly':
      return `${s.mm} ${s.hh} ${s.dom} * *`
    case 'every_n_months':
      return s.monthN === 1
        ? `${s.mm} ${s.hh} ${s.monthDom} * *`
        : `${s.mm} ${s.hh} ${s.monthDom} */${s.monthN} *`
    case 'custom':
      return `${s.cMin} ${s.cHour} ${s.cDom} ${s.cMonth} ${s.cDow}`
  }
}

export function parseCronToState(expr: string): BuilderState {
  const base = { ...DEFAULTS }
  const parts = (expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return base
  const [m, h, dom, mon, dow] = parts
  const customFallback = (): BuilderState => ({
    ...base, mode: 'custom', cMin: m, cHour: h, cDom: dom, cMonth: mon, cDow: dow,
  })

  if (h === '*' && dom === '*' && mon === '*' && dow === '*') {
    if (m === '*') return { ...base, mode: 'every_n_minutes', minN: 1 }
    const stepMin = /^\*\/(\d+)$/.exec(m)
    if (stepMin) {
      const n = parseInt(stepMin[1], 10)
      if (n >= 1 && n <= 59) return { ...base, mode: 'every_n_minutes', minN: n }
    }
    if (/^\d+$/.test(m)) {
      const min = parseInt(m, 10)
      if (min >= 0 && min <= 59) return { ...base, mode: 'every_n_hours', hourN: 1, hourMin: min }
    }
  }

  if (/^\d+$/.test(m) && dom === '*' && mon === '*' && dow === '*') {
    const stepH = /^\*\/(\d+)$/.exec(h)
    if (stepH) {
      const n = parseInt(stepH[1], 10)
      if (n >= 1 && n <= 23) {
        return { ...base, mode: 'every_n_hours', hourN: n, hourMin: parseInt(m, 10) }
      }
    }
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return { ...base, mode: 'daily', hh: parseInt(h, 10), mm: parseInt(m, 10) }
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && mon === '*' && dow === '*') {
    const stepD = /^\*\/(\d+)$/.exec(dom)
    if (stepD) {
      const n = parseInt(stepD[1], 10)
      if (n >= 1 && n <= 31) {
        return { ...base, mode: 'every_n_days', dayN: n, hh: parseInt(h, 10), mm: parseInt(m, 10) }
      }
    }
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow !== '*') {
    const wd = parseDowList(dow)
    if (wd) {
      return { ...base, mode: 'weekly', weekdays: wd, hh: parseInt(h, 10), mm: parseInt(m, 10) }
    }
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && mon === '*' && dow === '*') {
    if (dom === 'L') {
      return { ...base, mode: 'monthly', dom: 'L', hh: parseInt(h, 10), mm: parseInt(m, 10) }
    }
    if (/^\d+$/.test(dom)) {
      const d = parseInt(dom, 10)
      if (d >= 1 && d <= 31) {
        return { ...base, mode: 'monthly', dom: d, hh: parseInt(h, 10), mm: parseInt(m, 10) }
      }
    }
  }

  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && dow === '*') {
    const stepMon = /^\*\/(\d+)$/.exec(mon)
    if (stepMon) {
      const n = parseInt(stepMon[1], 10)
      if (n >= 1 && n <= 12) {
        return {
          ...base, mode: 'every_n_months', monthN: n, monthDom: parseInt(dom, 10),
          hh: parseInt(h, 10), mm: parseInt(m, 10),
        }
      }
    }
  }

  return customFallback()
}

function parseDowList(s: string): number[] | null {
  if (/^\d+(,\d+)*$/.test(s)) {
    const arr = s.split(',').map((n) => parseInt(n, 10))
    if (arr.every((n) => n >= 0 && n <= 6)) return Array.from(new Set(arr)).sort()
  }
  const rng = /^(\d+)-(\d+)$/.exec(s)
  if (rng) {
    const a = parseInt(rng[1], 10)
    const b = parseInt(rng[2], 10)
    if (a >= 0 && b <= 6 && a <= b) {
      const out: number[] = []
      for (let i = a; i <= b; i++) out.push(i)
      return out
    }
  }
  return null
}

function describeMode(s: BuilderState): string {
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

function fmtTime(hh: number, mm: number): string {
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
