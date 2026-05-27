/**
 * Phase 08 §8 + Plan 005 T5 — GitHub App scope probe.
 *
 * Loads the GitHub credentials from the gateway pair (Ottolax primary,
 * claude-gateway fallback — same path as `hub/src/scheduler/post-run/
 * github-issue.ts`) and reads the installation's `permissions` to determine
 * whether the install can create a new repo (`administration: write`) and
 * push contents (`contents: write`).
 *
 * Cached for 5 minutes in-memory. Cache is cleared by `resetGithubScopeCache()`
 * (exposed for tests + admin endpoints).
 *
 * NOT a GitHub App? The endpoint returns a static PAT token. In that case we
 * fall back to assuming the PAT scope is sufficient if and only if the
 * gateway annotates the cred record with `kind: 'app_installation'`. PAT
 * scopes are surfaced through OAuth `X-OAuth-Scopes` on any subsequent
 * request — we treat unknown as `{ hasAdminWrite: false, hasContentsWrite:
 * true }` (the safe default: contents likely OK, admin not assumed).
 */
import { Octokit } from '@octokit/rest'

export interface GithubScopeResult {
  hasAdminWrite: boolean
  hasContentsWrite: boolean
  kind: 'app_installation' | 'pat' | 'unknown'
  raw: unknown
  probedAt: number
}

const CACHE_TTL_MS = 5 * 60_000
let cache: { value: GithubScopeResult; expires: number } | null = null

/** Test/admin escape hatch — clears the in-memory cache. */
export function resetGithubScopeCache(): void {
  cache = null
}

async function loadGithubCred(): Promise<{ token: string; kind?: string; raw: any } | null> {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [process.env.GATEWAY_URL, process.env.GATEWAY_API_KEY],
    [process.env.FALLBACK_GATEWAY_URL, process.env.FALLBACK_GATEWAY_API_KEY],
  ]
  for (const [url, key] of pairs) {
    if (!url || !key) continue
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/credentials/service/github`, {
        headers: { 'X-Api-Key': key },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) {
        console.warn(`[github-scope] gateway ${url} returned ${res.status}`)
        continue
      }
      const body = (await res.json()) as { token?: string; kind?: string }
      if (body?.token) return { token: body.token, kind: body.kind, raw: body }
    } catch (err: any) {
      console.warn(`[github-scope] gateway ${url} threw: ${err?.message}`)
    }
  }
  return null
}

export async function probeGithubAppScope(): Promise<GithubScopeResult> {
  if (cache && cache.expires > Date.now()) return cache.value

  const cred = await loadGithubCred()
  if (!cred) {
    const value: GithubScopeResult = {
      hasAdminWrite: false,
      hasContentsWrite: false,
      kind: 'unknown',
      raw: { error: 'no_credentials' },
      probedAt: Date.now(),
    }
    cache = { value, expires: Date.now() + 30_000 } // short TTL on failure
    return value
  }

  // Probe install permissions.
  try {
    const octokit = new Octokit({ auth: cred.token, request: { timeout: 5_000 } })
    // For a GitHub App installation token, GET /installation/repositories
    // returns the install metadata in the response headers, but the canonical
    // `permissions` payload lives on `GET /app/installations/{id}` — we
    // already used the install token to mint, so the simplest probe is
    // `GET /installation/repositories` (proves admin scope at least if the
    // call succeeds for org repos) + parse `octokit.rest.apps.getAuthenticated`
    // permissions when available.
    let permissions: Record<string, string> = {}
    try {
      const auth: any = await octokit.request('GET /installation/repositories', { per_page: 1 })
      // octokit attaches permissions when present
      if (auth?.data?.permissions) permissions = auth.data.permissions
    } catch (err: any) {
      // Token might be a classic PAT — that endpoint 404s.
      console.warn(`[github-scope] GET /installation/repositories failed (likely PAT): ${err?.message}`)
    }

    const value: GithubScopeResult = {
      hasAdminWrite: permissions['administration'] === 'write',
      hasContentsWrite: permissions['contents'] === 'write' || permissions['contents'] === 'admin',
      kind: cred.kind === 'app_installation' || Object.keys(permissions).length > 0
        ? 'app_installation'
        : (cred.kind === 'pat' ? 'pat' : 'unknown'),
      raw: { permissions, gatewayKind: cred.kind },
      probedAt: Date.now(),
    }
    cache = { value, expires: Date.now() + CACHE_TTL_MS }
    return value
  } catch (err: any) {
    console.error(`[github-scope] probe failed: ${err?.message}`)
    const value: GithubScopeResult = {
      hasAdminWrite: false,
      hasContentsWrite: false,
      kind: 'unknown',
      raw: { error: err?.message ?? String(err) },
      probedAt: Date.now(),
    }
    cache = { value, expires: Date.now() + 30_000 }
    return value
  }
}
