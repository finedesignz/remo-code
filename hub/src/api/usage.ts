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
import {
  sumUserTokenWindows,
  usageBySession,
  usageByRepo,
} from '../db/token-usage-dal'

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

/**
 * P2 — GET /api/usage/cost
 *
 * Per-turn token + cost ledger aggregates: today / 7d / total token buckets and
 * dollar cost, plus per-session and per-repo breakdowns. cost_usd is the SDK's
 * authoritative total_cost_usd where available, else a list-price ESTIMATE — a
 * subscription list-price equivalent, NOT billed dollars (`cost_is_estimate`).
 *
 * Auth: global middleware (cookie-or-bearer), user-scoped.
 */
usage.get('/cost', async (c) => {
  const userId = c.get('userId') as string
  const user: any = await getUserById(userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  const tz = user.timezone || 'UTC'

  const [windows, bySession, byRepo] = await Promise.all([
    sumUserTokenWindows(userId, tz),
    usageBySession(userId, 50),
    usageByRepo(userId, 50),
  ])

  return c.json({
    timezone: tz,
    cost_is_estimate: true,
    cost_note:
      'cost_usd uses the SDK total_cost_usd when available, else a list-price estimate. Subscription list-price equivalent, not billed dollars.',
    today: windows.today,
    seven_day: windows.seven_day,
    total: windows.total,
    by_session: bySession,
    by_repo: byRepo,
  })
})

/** Test-only — wipe cache. */
export function _resetUsageSummaryCacheForTests(): void {
  cache.clear()
}
