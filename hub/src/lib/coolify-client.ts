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
