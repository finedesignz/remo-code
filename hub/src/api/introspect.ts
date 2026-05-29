/**
 * B4: /healthz/deep + /metrics introspection endpoints.
 *
 * Bearer-token gated via `HUB_INTROSPECT_TOKEN`. Mounted at root (NOT under
 * /api/*) so they bypass auth catch-all, CSRF guard, and license gate.
 * The bearer check IS the credential.
 *
 * Responses:
 *   - 200 healthy / 503 unhealthy on /healthz/deep
 *   - 200 text/plain Prometheus exposition on /metrics
 *   - 401 missing/invalid bearer
 *   - 503 when HUB_INTROSPECT_TOKEN is unset (fail-closed)
 *
 * `createIntrospectApp(getToken)` is exported as a factory so tests can
 * inject a token-resolver without depending on the global `config` module —
 * Bun's mock.module is sticky across test files and would otherwise pollute.
 */
import { Hono } from 'hono'
import { timingSafeEqual } from 'crypto'
import { config } from '../config'
import { sql } from '../db/postgres'
import { renderPrometheus, costCapUtilization, sessionRunsInFlight } from '../observability/metrics'
import { getInFlightRunCount } from '../sessions/budget'

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

function requireBearer(getToken: () => string, authHeader: string | undefined): { ok: true } | { ok: false; status: 401 | 503; body: { error: string } } {
  const expected = getToken()
  if (!expected) {
    return { ok: false, status: 503, body: { error: 'introspect_token_not_configured' } }
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, body: { error: 'missing_bearer' } }
  }
  const token = authHeader.slice('Bearer '.length).trim()
  if (!constantTimeEqual(token, expected)) {
    return { ok: false, status: 401, body: { error: 'invalid_bearer' } }
  }
  return { ok: true }
}

async function probeDb(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const start = Date.now()
  try {
    await sql`SELECT 1`
    return { ok: true, latency_ms: Date.now() - start }
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - start, error: err?.message || 'db_unreachable' }
  }
}

async function probeRedis(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const start = Date.now()
  const url = config.titanium.redisUrl
  if (!url) {
    return { ok: true, latency_ms: 0, error: 'not_configured' }
  }
  try {
    const mod: any = await import('../titanium-client')
    if (typeof mod.pingRedis === 'function') {
      const ok = await mod.pingRedis()
      return { ok: ok === true, latency_ms: Date.now() - start }
    }
    return { ok: true, latency_ms: Date.now() - start, error: 'probe_unsupported' }
  } catch (err: any) {
    return { ok: false, latency_ms: Date.now() - start, error: err?.message || 'redis_unreachable' }
  }
}

async function probeTitanium(): Promise<{ ok: boolean; age_s: number | null; error?: string }> {
  if (config.titaniumBypass || !config.titanium.keygenApiUrl) {
    return { ok: true, age_s: null, error: 'bypass_or_unconfigured' }
  }
  try {
    const mod: any = await import('../titanium-client')
    if (typeof mod.getJwksCacheAgeSeconds === 'function') {
      const ageS: number | null = await mod.getJwksCacheAgeSeconds()
      return { ok: ageS != null, age_s: ageS }
    }
    return { ok: true, age_s: null, error: 'probe_unsupported' }
  } catch (err: any) {
    return { ok: false, age_s: null, error: err?.message || 'titanium_unreachable' }
  }
}

interface SupervisorSummary {
  id: string
  online: boolean
  last_seen_ms_ago: number | null
}

async function listSupervisors(): Promise<SupervisorSummary[]> {
  try {
    const reg: any = await import('../ws/supervisor-registry')
    if (typeof reg.listSupervisors === 'function') {
      const rows = reg.listSupervisors() as Array<{ id: string; lastSeenAt?: number; online?: boolean }>
      const now = Date.now()
      return rows.map((r) => ({
        id: r.id,
        online: r.online === true,
        last_seen_ms_ago: typeof r.lastSeenAt === 'number' ? now - r.lastSeenAt : null,
      }))
    }
  } catch {}
  try {
    const rows = await sql<{ id: string; last_seen_at: Date | null }[]>`
      SELECT id, last_seen_at FROM supervisors ORDER BY last_seen_at DESC NULLS LAST LIMIT 50
    `
    const now = Date.now()
    return rows.map((r) => ({
      id: r.id,
      online: r.last_seen_at ? (now - new Date(r.last_seen_at).getTime() < 30_000) : false,
      last_seen_ms_ago: r.last_seen_at ? now - new Date(r.last_seen_at).getTime() : null,
    }))
  } catch {
    return []
  }
}

/**
 * Build a Hono sub-app for the introspect endpoints, with bearer-token
 * sourced via `getToken`. Production: see the exported `introspect`.
 */
export function createIntrospectApp(getToken: () => string): Hono {
  const app = new Hono()

  app.get('/healthz/deep', async (c) => {
    const auth = requireBearer(getToken, c.req.header('authorization'))
    if (!auth.ok) return c.json(auth.body, auth.status)

    const [db, redis, titanium, supervisors] = await Promise.all([
      probeDb(),
      probeRedis(),
      probeTitanium(),
      listSupervisors(),
    ])

    const allOk = db.ok && redis.ok && titanium.ok
    return c.json({ ok: allOk, db, redis, titanium, supervisors }, allOk ? 200 : 503)
  })

  app.get('/metrics', async (c) => {
    const auth = requireBearer(getToken, c.req.header('authorization'))
    if (!auth.ok) return c.json(auth.body, auth.status)

    try {
      const inFlight = await getInFlightRunCount()
      sessionRunsInFlight.set(inFlight)
    } catch {}

    try {
      const rows = await sql<{ over: string; total: string }[]>`
        SELECT
          COUNT(*) FILTER (WHERE c.spent_today >= u.daily_cost_cap_usd)::text AS over,
          COUNT(*)::text AS total
        FROM users u
        LEFT JOIN (
          SELECT user_id, COALESCE(SUM(cost_usd), 0)::numeric AS spent_today
          FROM scheduled_task_runs
          WHERE finished_at >= date_trunc('day', now())
          GROUP BY user_id
        ) c ON c.user_id = u.id
        WHERE u.daily_cost_cap_usd > 0
      `
      const over = Number(rows[0]?.over ?? 0)
      const total = Number(rows[0]?.total ?? 0)
      costCapUtilization.set(total > 0 ? over / total : 0)
    } catch {
      // Leave previous value; /metrics must not 500 on a stat query glitch.
    }

    const body = renderPrometheus()
    return c.body(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
  })

  return app
}

// Production singleton: token resolved from config at request time.
export const introspect = createIntrospectApp(() => config.hubIntrospectToken)
