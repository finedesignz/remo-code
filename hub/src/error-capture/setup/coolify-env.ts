/**
 * Coolify env-var helper (W5).
 *
 * Pushes a single env var (`SENTRY_DSN`) to a Coolify application via the
 * Coolify v1 API. Failure is log-only: returns `{ ok: false, error }` rather
 * than throwing, so the setup endpoint can still report the upstream
 * git-push step as successful.
 *
 * Reuses the same auth + base-URL convention as the existing log_check
 * sender (`hub/src/scheduler/senders/coolify.ts`):
 *   COOLIFY_TOKEN env → Bearer auth
 *   COOLIFY_BASE_URL  → default https://coolify.titaniumlabs.us
 *
 * Strategy: Coolify v1 supports per-app env CRUD via
 *   POST  /api/v1/applications/{uuid}/envs   (create)
 *   PATCH /api/v1/applications/{uuid}/envs   (update existing key)
 * The OpenAPI exact behavior between "create only" vs "upsert" varies by
 * Coolify version, so we try PATCH first (cheap, idempotent for existing
 * keys) and fall back to POST on 404 (key does not exist yet).
 */

const DEFAULT_BASE = 'https://coolify.titaniumlabs.us'
const TIMEOUT_MS = 10_000

export interface SetEnvResult {
  ok: boolean
  error?: string
  status?: number
  method?: 'PATCH' | 'POST'
}

export interface SetEnvOpts {
  token?: string
  baseUrl?: string
  isBuildTime?: boolean
}

export async function setCoolifyEnv(
  appUuid: string,
  key: string,
  value: string,
  opts: SetEnvOpts = {},
): Promise<SetEnvResult> {
  const token = opts.token || process.env.COOLIFY_TOKEN
  const baseUrl = (opts.baseUrl || process.env.COOLIFY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  if (!token) {
    return { ok: false, error: 'coolify_token_missing' }
  }
  if (!appUuid || !key) {
    return { ok: false, error: 'invalid_args' }
  }

  const url = `${baseUrl}/api/v1/applications/${appUuid}/envs`
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const body = JSON.stringify({ key, value, is_build_time: !!opts.isBuildTime, is_preview: false })

  // 1. PATCH (update existing)
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      return { ok: true, status: res.status, method: 'PATCH' }
    }
    // Not 2xx — fall through to POST on 404, else error out
    if (res.status !== 404) {
      const text = await safeText(res)
      return { ok: false, error: `coolify_patch_${res.status}: ${text}`, status: res.status, method: 'PATCH' }
    }
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      return { ok: false, error: `coolify_patch_failed: ${err?.message ?? err}`, method: 'PATCH' }
    }
    return { ok: false, error: 'coolify_patch_timeout', method: 'PATCH' }
  }

  // 2. POST (create new)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) {
      return { ok: true, status: res.status, method: 'POST' }
    }
    const text = await safeText(res)
    return { ok: false, error: `coolify_post_${res.status}: ${text}`, status: res.status, method: 'POST' }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'coolify_post_timeout', method: 'POST' }
    }
    return { ok: false, error: `coolify_post_failed: ${err?.message ?? err}`, method: 'POST' }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * Trigger an app redeploy. Used only when the user opts in via the setup
 * modal's "redeploy" checkbox. Log-only failure.
 */
export async function redeployCoolifyApp(
  appUuid: string,
  opts: SetEnvOpts = {},
): Promise<SetEnvResult> {
  const token = opts.token || process.env.COOLIFY_TOKEN
  const baseUrl = (opts.baseUrl || process.env.COOLIFY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  if (!token) return { ok: false, error: 'coolify_token_missing' }
  const url = `${baseUrl}/api/v1/deploy?uuid=${encodeURIComponent(appUuid)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.ok) return { ok: true, status: res.status }
    const text = await safeText(res)
    return { ok: false, error: `coolify_deploy_${res.status}: ${text}`, status: res.status }
  } catch (err: any) {
    return { ok: false, error: `coolify_deploy_failed: ${err?.message ?? err}` }
  }
}
