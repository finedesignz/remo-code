import { useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'

interface Props { token: string }

interface ThresholdsResponse {
  session_pct: number | null
  week_pct: number | null
}

interface UsageResponse {
  usage: {
    five_hour: { utilization: number; resets_at: string }
    seven_day: { utilization: number; resets_at: string }
    seven_day_opus?: { utilization: number; resets_at: string } | null
  } | null
  thresholds: { session_pct: number | null; week_pct: number | null }
  paused: boolean
  reason: string | null
  utilization_pct: number | null
  threshold_pct: number | null
  resets_at: string | null
}

const MIN_VAL = 50
const MAX_VAL = 95
const STEP = 5

/**
 * Settings → Profile → "Claude usage threshold gate" card.
 * NULL = off. Inputs default-suggested at 90 but are not persisted until Save.
 */
export function ClaudeUsageCard({ token }: Props) {
  const [loading, setLoading] = useState(true)
  const [sessionPct, setSessionPct] = useState<number | null>(null)
  const [weekPct, setWeekPct] = useState<number | null>(null)
  const [sessionEnabled, setSessionEnabled] = useState(false)
  const [weekEnabled, setWeekEnabled] = useState(false)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      hubFetch<ThresholdsResponse>(token, '/api/account/claude-thresholds'),
      hubFetch<UsageResponse>(token, '/api/account/usage').catch(() => null),
    ]).then(([t, u]) => {
      if (cancelled) return
      setSessionPct(t.session_pct)
      setWeekPct(t.week_pct)
      setSessionEnabled(t.session_pct != null)
      setWeekEnabled(t.week_pct != null)
      setUsage(u)
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  async function handleSave() {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const body = {
        session_pct: sessionEnabled ? (sessionPct ?? 90) : null,
        week_pct: weekEnabled ? (weekPct ?? 90) : null,
      }
      const res = await hubFetch<ThresholdsResponse>(token, '/api/account/claude-thresholds', {
        method: 'PUT',
        json: body,
      })
      setSessionPct(res.session_pct)
      setWeekPct(res.week_pct)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
      // Refresh usage decision
      try {
        const u = await hubFetch<UsageResponse>(token, '/api/account/usage')
        setUsage(u)
      } catch {}
    } catch (e: any) {
      setErr(e?.message ?? 'save_failed')
    } finally {
      setSaving(false)
    }
  }

  const fiveHourPct = usage?.usage ? Math.round(usage.usage.five_hour.utilization) : null
  const weekUtilPct = usage?.usage ? Math.round(usage.usage.seven_day.utilization) : null

  const proposedSessionTrips =
    sessionEnabled && fiveHourPct != null && fiveHourPct >= (sessionPct ?? 90)
  const proposedWeekTrips =
    weekEnabled && weekUtilPct != null && weekUtilPct >= (weekPct ?? 90)

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Claude usage threshold gate</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">
        When Claude usage reaches the configured percentage, remo-code pauses NEW dispatches
        (scheduled tasks, error-capture, manual chat sends, healed sessions) until the window
        resets. In-flight sessions are NOT killed. NULL = OFF.
      </p>

      {usage?.paused && (
        <div className="mb-4 rounded-xl bg-red-500/10 ring-1 ring-red-500/30 text-red-300 px-4 py-2 text-sm">
          Paused — {usage.reason === 'session_threshold' ? '5-hour' : '7-day'} usage at {usage.utilization_pct}%
          {usage.resets_at && <> · resets {new Date(usage.resets_at).toLocaleString()}</>}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-[var(--text-muted)]">Loading…</div>
      ) : (
        <div className="space-y-5">
          <ThresholdSlider
            label="Session cap (5-hour window)"
            help="Claude Pro/Max resets every 5 hours. Stop dispatch when 5-hour usage hits this %."
            enabled={sessionEnabled}
            onToggle={setSessionEnabled}
            value={sessionPct ?? 90}
            onChange={setSessionPct}
            currentUtil={fiveHourPct}
            warn={proposedSessionTrips}
          />
          <ThresholdSlider
            label="Weekly cap (7-day window)"
            help="Anthropic enforces a 7-day cap on Pro/Max plans. Pause dispatch when 7-day usage hits this %."
            enabled={weekEnabled}
            onToggle={setWeekEnabled}
            value={weekPct ?? 90}
            onChange={setWeekPct}
            currentUtil={weekUtilPct}
            warn={proposedWeekTrips}
          />

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-sm text-emerald-400">Saved</span>}
            {err && <span className="text-sm text-red-400">{err}</span>}
            {(proposedSessionTrips || proposedWeekTrips) && (
              <span className="text-xs text-amber-300">⚠ Saving now will immediately pause dispatch</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface SliderProps {
  label: string
  help: string
  enabled: boolean
  onToggle: (v: boolean) => void
  value: number
  onChange: (v: number) => void
  currentUtil: number | null
  warn: boolean
}

function ThresholdSlider({ label, help, enabled, onToggle, value, onChange, currentUtil, warn }: SliderProps) {
  const clamped = Math.max(MIN_VAL, Math.min(MAX_VAL, value))
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-[var(--text-primary)]">{label}</div>
          <div className="text-xs text-[var(--text-muted)] mt-0.5">{help}</div>
        </div>
        <button
          type="button"
          onClick={() => onToggle(!enabled)}
          aria-pressed={enabled}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            enabled ? 'bg-indigo-600' : 'bg-[var(--bg-tertiary)]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div className="flex items-center gap-3 pt-1">
          <input
            type="range"
            min={MIN_VAL}
            max={MAX_VAL}
            step={STEP}
            value={clamped}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            className="flex-1 accent-indigo-500"
          />
          <span className={`text-sm font-mono w-12 text-right ${warn ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>
            {clamped}%
          </span>
          {currentUtil != null && (
            <span className="text-xs text-[var(--text-muted)] w-24 text-right">
              now: {currentUtil}%
            </span>
          )}
        </div>
      )}
    </div>
  )
}
