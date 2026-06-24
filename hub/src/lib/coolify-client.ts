/**
 * auto-dev P5 — minimal Coolify client.
 *
 * Token + base URL from env ONLY (never hard-coded), same convention as
 * `hub/src/scheduler/senders/coolify.ts`:
 *   COOLIFY_TOKEN     → Bearer auth
 *   COOLIFY_BASE_URL  → default https://coolify.titaniumlabs.us
 *
 * The only prod-mutating call is `triggerRedeploy` (POST /api/v1/deploy). The
 * fix itself is commit+push (Coolify auto-deploys); this explicit force-redeploy
 * guarantees the verify probe runs against the freshly-built image rather than
 * racing the push-triggered build.
 */
const DEFAULT_BASE = 'https://coolify.titaniumlabs.us'

export interface CoolifyConfig {
  token: string
  baseUrl: string
}

/** Read Coolify config from env. Returns null when COOLIFY_TOKEN is unset. */
export function coolifyConfigFromEnv(): CoolifyConfig | null {
  const token = process.env.COOLIFY_TOKEN
  if (!token) return null
  const baseUrl = (process.env.COOLIFY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  return { token, baseUrl }
}

export interface RedeployResult {
  ok: boolean
  status: number
  detail?: string
}

/**
 * Trigger a forced redeploy of an application.
 * POST {base}/api/v1/deploy?uuid=<application_uuid>&force=true
 */
export async function triggerRedeploy(
  cfg: CoolifyConfig,
  applicationUuid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RedeployResult> {
  const url = `${cfg.baseUrl}/api/v1/deploy?uuid=${encodeURIComponent(applicationUuid)}&force=true`
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    const detail = (await res.text().catch(() => '')).slice(0, 500)
    return { ok: res.ok, status: res.status, detail }
  } catch (err: any) {
    return { ok: false, status: 0, detail: `redeploy_fetch_failed: ${err?.message}` }
  }
}

export interface AppLogsResult {
  ok: boolean
  status: number
  /** Concatenated runtime log text (empty string when unavailable). */
  logs: string
  detail?: string
}

/**
 * Fetch the runtime logs of an application (Phase 27 — log error-scan input).
 * GET {base}/api/v1/applications/<uuid>/logs?lines=<n>
 *
 * Best-effort + READ-ONLY: never throws, never mutates prod. A failure (auth,
 * network, route shape) returns ok=false + empty logs so the verify tail simply
 * skips the log-scan rather than wedging the cycle. The Coolify logs endpoint
 * returns `{ logs: "<text>" }`; we tolerate a bare string or array too.
 */
export async function fetchAppLogs(
  cfg: CoolifyConfig,
  applicationUuid: string,
  opts: { lines?: number; fetchImpl?: typeof fetch } = {},
): Promise<AppLogsResult> {
  const lines = opts.lines ?? 200
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${cfg.baseUrl}/api/v1/applications/${encodeURIComponent(applicationUuid)}/logs?lines=${lines}`
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500)
      return { ok: false, status: res.status, logs: '', detail }
    }
    const body = await res.text().catch(() => '')
    let logs = body
    try {
      const json = JSON.parse(body)
      if (typeof json === 'string') logs = json
      else if (Array.isArray(json)) logs = json.join('\n')
      else if (json && typeof json.logs === 'string') logs = json.logs
      else if (json && Array.isArray(json.logs)) logs = json.logs.join('\n')
    } catch {
      /* not JSON — treat the raw body as the log text */
    }
    return { ok: true, status: res.status, logs }
  } catch (err: any) {
    return { ok: false, status: 0, logs: '', detail: `logs_fetch_failed: ${err?.message}` }
  }
}
