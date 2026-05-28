/**
 * Phase 12 W2 — GET /api/usage/summary
 *
 * Aggregates today / week-to-date / month-to-date cost from
 * `scheduled_task_runs.cost_usd` for the authenticated user, in the user's
 * IANA timezone. Returns current threshold settings + caps from the `users`
 * row plus the in-memory Anthropic OAuth window snapshot from the agent.
 *
 * 60s in-memory cache per user so hot dashboard refresh doesn't hammer the
 * DB. Cache is invalidated on hub restart (acceptable — values reconverge
 * within one minute).
 *
 * Auth: handled by the global middleware (cookie-or-bearer). License-gated.
 */
import { Hono } from 'hono'
import { getUserById, sumUserCostWindows } from '../db/dal'
import { getUsage } from '../usage/store'

export const usage = new Hono()

interface CachedSummary {
  expires_at: number
  value: any
}
const cache = new Map<string, CachedSummary>()
const CACHE_TTL_MS = 60_000

usage.get('/summary', async (c) => {
  const userId = c.get('userId') as string
  const now = Date.now()
  const cached = cache.get(userId)
  if (cached && cached.expires_at > now) {
    return c.json(cached.value)
  }
  const user: any = await getUserById(userId)
  if (!user) return c.json({ error: 'not_found' }, 404)

  const tz = user.timezone || 'UTC'
  const windows = await sumUserCostWindows(userId, tz)
  const snapshot = getUsage(userId)

  const value = {
    timezone: tz,
    today_usd: windows.today_usd,
    week_usd: windows.week_usd,
    month_usd: windows.month_usd,
    daily_cap_usd: Number(user.daily_cost_cap_usd ?? 0),
    thresholds: {
      session_pct: user.claude_session_threshold_pct ?? null,
      week_pct: user.claude_week_threshold_pct ?? null,
    },
    claude_window: snapshot?.usage ?? null,
    claude_window_updated_at: snapshot?.updated_at ?? null,
  }

  cache.set(userId, { expires_at: now + CACHE_TTL_MS, value })
  return c.json(value)
})

/** Test-only — wipe cache. */
export function _resetUsageSummaryCacheForTests(): void {
  cache.clear()
}
