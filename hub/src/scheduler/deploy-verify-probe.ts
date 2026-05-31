/**
 * auto-dev P5 — deploy verify probe (CLAUDE.md global rule 14.4).
 *
 * After a redeploy we do NOT trust `/health` alone. `/health` 200 only proves
 * the process booted; route-level breakage (502 from a proxy timeout, 500 from a
 * missing DAL helper, middleware drift) only shows on the REAL routes. So this
 * probe:
 *
 *   1. Polls `/health` (then `/healthz`) until 200 or timeout.
 *   2. THEN probes the REAL routes — the app's top-level `/api/*` namespaces plus
 *      `/openapi.json` and `/docs` when present.
 *
 * Per-route classification (unauthenticated probe):
 *   200/2xx → mounted + healthy
 *   401/403 → mounted (auth gate present — route exists, just needs a token) = PASS
 *   404     → route GONE (regression — the route we expected is missing)        = FAIL
 *   502/503/504 → runtime/proxy BROKEN (build up but route crashes)             = FAIL
 *   0 / network error → unreachable                                             = FAIL
 *
 * The probe is deterministic + injectable (`fetchImpl`, `sleepImpl`, `nowMs`) so
 * tests assert it hits real routes (not just /health) and classifies correctly
 * without real network or timers.
 */

export type RouteVerdict = 'pass' | 'fail'

export interface RouteProbeResult {
  path: string
  status: number
  verdict: RouteVerdict
  classification: 'ok' | 'mounted_auth' | 'route_gone' | 'runtime_broken' | 'unreachable'
}

export interface DeployVerifyResult {
  healthOk: boolean
  healthPath: string | null
  healthStatus: number
  routes: RouteProbeResult[]
  /** Overall pass = health ok AND every probed route passed. */
  pass: boolean
}

export interface DeployVerifyOptions {
  /** Base origin of the deployed app, e.g. https://app.example.com (no trailing slash). */
  baseUrl: string
  /** Real `/api/*` namespaces (and other paths) to probe after health is green. */
  routes: string[]
  /** Health endpoints to try in order. Defaults to ['/health', '/healthz']. */
  healthPaths?: string[]
  /** Max wall-clock to wait for health, ms. Default 120s. */
  healthTimeoutMs?: number
  /** Poll interval for health, ms. Default 5s. */
  healthIntervalMs?: number
  fetchImpl?: typeof fetch
  sleepImpl?: (ms: number) => Promise<void>
  nowMs?: () => number
}

const DEFAULT_HEALTH_PATHS = ['/health', '/healthz']
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000
const DEFAULT_HEALTH_INTERVAL_MS = 5_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function classify(status: number): RouteProbeResult['classification'] {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'mounted_auth'
  if (status === 404) return 'route_gone'
  if (status === 502 || status === 503 || status === 504) return 'runtime_broken'
  if (status === 0) return 'unreachable'
  // Other 4xx (e.g. 400/405) mean the route is mounted + responding → treat as
  // mounted (PASS): the route exists, we just sent it a bare GET.
  if (status >= 400 && status < 500) return 'mounted_auth'
  // 5xx other than the proxy codes → runtime broken.
  return 'runtime_broken'
}

function verdictFor(c: RouteProbeResult['classification']): RouteVerdict {
  return c === 'ok' || c === 'mounted_auth' ? 'pass' : 'fail'
}

async function probeOne(
  baseUrl: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<RouteProbeResult> {
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  let status = 0
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    status = res.status
  } catch {
    status = 0
  }
  const classification = classify(status)
  return { path, status, verdict: verdictFor(classification), classification }
}

/**
 * Run the full verify: poll health, then probe real routes. Always returns a
 * result (never throws); a totally-down app yields healthOk=false + pass=false.
 */
export async function runDeployVerify(opts: DeployVerifyOptions): Promise<DeployVerifyResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const fetchImpl = opts.fetchImpl ?? fetch
  const sleep = opts.sleepImpl ?? defaultSleep
  const now = opts.nowMs ?? Date.now
  const healthPaths = opts.healthPaths ?? DEFAULT_HEALTH_PATHS
  const timeoutMs = opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
  const intervalMs = opts.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS

  // (1) Poll health until 200 or timeout.
  let healthOk = false
  let healthPath: string | null = null
  let healthStatus = 0
  const deadline = now() + timeoutMs
  while (now() <= deadline) {
    for (const p of healthPaths) {
      const r = await probeOne(baseUrl, p, fetchImpl)
      healthStatus = r.status
      if (r.status >= 200 && r.status < 300) {
        healthOk = true
        healthPath = p
        break
      }
    }
    if (healthOk) break
    if (now() + intervalMs > deadline) break
    await sleep(intervalMs)
  }

  // (2) Probe real routes regardless of health outcome — a 502 on a real route
  // is exactly the signal we want even if health flapped. (Reporting both is
  // more useful than short-circuiting.)
  const routes: RouteProbeResult[] = []
  for (const path of opts.routes) {
    routes.push(await probeOne(baseUrl, path, fetchImpl))
  }

  const allRoutesPass = routes.length > 0 && routes.every((r) => r.verdict === 'pass')
  return {
    healthOk,
    healthPath,
    healthStatus,
    routes,
    pass: healthOk && allRoutesPass,
  }
}

/** Human-readable per-route report for the chat message. */
export function formatVerifyReport(appLabel: string, result: DeployVerifyResult): string {
  const lines: string[] = []
  lines.push(`Deploy verify for ${appLabel}: ${result.pass ? 'PASS ✅' : 'FAIL ❌'}`)
  lines.push(
    `  health: ${result.healthOk ? `200 @ ${result.healthPath}` : `not healthy (last ${result.healthStatus || 'unreachable'})`}`,
  )
  if (result.routes.length === 0) {
    lines.push('  routes: (none probed)')
  } else {
    for (const r of result.routes) {
      const mark = r.verdict === 'pass' ? '✓' : '✗'
      lines.push(`  ${mark} ${r.path} → ${r.status || 'ERR'} (${r.classification})`)
    }
  }
  return lines.join('\n')
}
