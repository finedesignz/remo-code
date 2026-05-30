import { useState } from 'react'
import { useSubscriptionUsage, type UsageWindow } from '../hooks/useSubscriptionUsage'

type Subscribe = (handler: (msg: any) => void) => () => void

interface Props {
  subscribe: Subscribe
}

function colorFor(util: number) {
  // util is a 0-100 percentage. <70 green, 70-90 amber, >90 red.
  if (util < 70) return { bar: 'bg-emerald-400', text: 'text-emerald-300' }
  if (util < 90) return { bar: 'bg-amber-400', text: 'text-amber-300' }
  return { bar: 'bg-red-400', text: 'text-red-300' }
}

function formatResetIn(resetsAt: string): string {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return 'soon'
  const diff = target - Date.now()
  if (diff <= 0) return 'now'
  const totalMin = Math.floor(diff / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`
}

function Bar({ label, window }: { label: string; window: UsageWindow }) {
  const util = Math.max(0, Math.min(100, window.utilization))
  const { bar, text } = colorFor(util)
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">{label}</span>
      <span className="w-16 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <span className={`block h-full ${bar} transition-all`} style={{ width: `${util}%` }} />
      </span>
      <span className={`text-[10px] font-mono ${text} w-7 text-right`}>{Math.round(util)}%</span>
    </div>
  )
}

function Row({ label, window }: { label: string; window: UsageWindow }) {
  const util = Math.max(0, Math.min(100, window.utilization))
  const { text } = colorFor(util)
  return (
    <div className="flex justify-between gap-3">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="flex items-center gap-2">
        <span className={`font-mono ${text}`}>{util.toFixed(1)}%</span>
        <span className="text-[var(--text-muted)] text-[10px]">resets in {formatResetIn(window.resets_at)}</span>
      </span>
    </div>
  )
}

/**
 * Inline subscription quota strip — two thin bars (5h + 7d) showing live
 * Anthropic Claude usage from the local agent's poll of
 * /api/oauth/usage. Hover reveals exact %, reset times, and Opus/OAuth
 * sub-quotas when present.
 *
 * Renders a `—` placeholder until the first snapshot arrives so stale data
 * never lingers across user switches.
 */
export function UsageStrip({ subscribe }: Props) {
  const snap = useSubscriptionUsage(subscribe)
  const [hover, setHover] = useState(false)

  if (!snap) {
    return (
      <div
        className="hidden sm:flex items-center gap-2 px-2 py-1 rounded-lg text-[var(--text-muted)] cursor-default"
        title="Subscription usage — waiting for agent"
      >
        <span className="text-[10px] uppercase tracking-wider font-medium">Quota</span>
        <span className="text-xs font-mono">—</span>
      </div>
    )
  }

  const { five_hour, seven_day, seven_day_opus, seven_day_oauth_apps } = snap.usage

  // Surface the worst-utilization window's reset countdown inline so the most
  // urgent limit is visible without hovering (ClaudeUsage's resets_at - now).
  const worst = [five_hour, seven_day, seven_day_opus ?? undefined]
    .filter((w): w is UsageWindow => !!w)
    .reduce((a, b) => (b.utilization > a.utilization ? b : a))

  return (
    <div
      className="hidden sm:flex relative items-center gap-3 px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors cursor-default"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Anthropic subscription usage"
    >
      <Bar label="5h" window={five_hour} />
      <Bar label="7d" window={seven_day} />
      {seven_day_opus && <Bar label="Opus" window={seven_day_opus} />}
      <span className="text-[10px] text-[var(--text-muted)] font-mono whitespace-nowrap">
        resets {formatResetIn(worst.resets_at)}
      </span>
      {hover && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl z-50 p-3 text-xs space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">Anthropic quota</div>
          <Row label="5-hour window" window={five_hour} />
          <Row label="7-day window" window={seven_day} />
          {seven_day_opus && (
            <Row label="7-day Opus" window={seven_day_opus} />
          )}
          {seven_day_oauth_apps && (
            <Row label="7-day OAuth apps" window={seven_day_oauth_apps} />
          )}
          <div className="pt-1.5 border-t border-[var(--border-color)]/50 text-[10px] text-[var(--text-muted)]">
            Reported by local agent every 5 minutes via /api/oauth/usage.
          </div>
        </div>
      )}
    </div>
  )
}
