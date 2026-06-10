/**
 * Coolify `application_uuid` → `repo_key` resolver.
 *
 * WHY: Coolify's `deployment.failed` webhook payload carries NO `git_repository`
 * field (verified live 2026-06-09) — only `application_uuid` / `application_name`
 * / `fqdn`. So `resolveRepoKeyedAgentSession` can't derive a `repo_key` from the
 * webhook alone and always falls back to capacity routing, landing the fix in the
 * wrong (or no) session. This resolver closes that gap: it maps an app UUID to a
 * `repo_key` by querying the Coolify API (the SAME `COOLIFY_TOKEN` /
 * `COOLIFY_BASE_URL` convention the `log_check` / `deploy_verify` senders already
 * use — never hard-code), and caches the answer in `coolify_app_repo`.
 *
 *   appUuid ──(cache hit, fresh)──────────────► repo_key
 *   appUuid ──(miss/stale)──► Coolify GET /api/v1/applications/{uuid}
 *            ──► git_full_url / git_repository ──(repoKeyFromGitRepository)──► repo_key
 *            ──► upsert cache ──► repo_key
 *
 * INVARIANTS:
 *   - NEVER throws. Any network / parse / DB error → return null so the caller
 *     falls back to today's capacity routing (no regression).
 *   - Off the webhook response path. The webhook still returns 202 immediately;
 *     this runs inside the fire-and-forget triage dispatch.
 *   - Cache populates lazily at runtime; schema.sql holds idempotent DDL only.
 */
import { repoKeyFromGitRepository } from '../lib/repo-key.ts'
import { getCoolifyAppRepo, upsertCoolifyAppRepo } from '../db/dal.ts'

const DEFAULT_BASE = 'https://coolify.titaniumlabs.us'
// Re-resolve from the Coolify API when the cached row is older than this. A
// repo's git remote rarely changes, so a day is plenty; staleness only matters
// if an app is re-pointed at a different repo.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Pull the git remote URL out of a Coolify application object. Coolify exposes
 * the remote under a few keys across versions / source types; accept any of
 * them, preferring the fully-qualified URL. Returns null when none present.
 */
export function extractGitUrl(app: any): string | null {
  if (!app || typeof app !== 'object') return null
  const full = app.git_full_url
  if (typeof full === 'string' && full.trim() !== '') return full.trim()
  const repo = app.git_repository
  if (typeof repo === 'string' && repo.trim() !== '') return repo.trim()
  return null
}

/**
 * Resolve a `repo_key` for a Coolify `application_uuid`, user-scoped.
 * Returns null on any miss / error — the caller treats null as "no repo match"
 * and falls back to capacity routing exactly as before.
 */
export async function resolveRepoKeyFromAppUuid(
  appUuid: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!appUuid || typeof appUuid !== 'string' || appUuid.trim() === '') return null
  const uuid = appUuid.trim()

  // A stale-but-present cached key. If the API re-resolve below fails (down /
  // unconfigured / error), serving this old key still routes to the right
  // session — strictly better than dropping to capacity routing. Only when we
  // have NO cached key at all do we return null.
  let staleKey: string | null = null

  // (1) Cache lookup.
  try {
    const cached = await getCoolifyAppRepo(uuid, userId)
    if (cached) {
      const ageMs = Date.now() - new Date(cached.updated_at).getTime()
      if (cached.repo_key && Number.isFinite(ageMs) && ageMs < CACHE_TTL_MS) {
        return cached.repo_key
      }
      if (cached.repo_key) staleKey = cached.repo_key
    }
  } catch (err: any) {
    console.warn(`[coolify-app-repo] cache lookup failed uuid=${uuid}: ${err?.message}`)
    // fall through to API resolve
  }

  // (2) Coolify API resolve.
  const token = process.env.COOLIFY_TOKEN
  if (!token) {
    // Unconfigured — can't resolve. Serve a stale cached key if we have one,
    // else caller falls back. (Don't cache a miss.)
    return staleKey
  }
  const baseUrl = (process.env.COOLIFY_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
  const url = `${baseUrl}/api/v1/applications/${encodeURIComponent(uuid)}`

  let gitUrl: string | null = null
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      console.warn(`[coolify-app-repo] coolify http ${res.status} uuid=${uuid}`)
      return staleKey
    }
    const app = await res.json()
    gitUrl = extractGitUrl(app)
  } catch (err: any) {
    console.warn(`[coolify-app-repo] coolify fetch failed uuid=${uuid}: ${err?.message}`)
    return staleKey
  }

  const repoKey = repoKeyFromGitRepository(gitUrl)
  if (!repoKey) return staleKey

  // (3) Upsert cache. Best-effort — a cache-write failure must not lose the
  // freshly-resolved answer.
  try {
    await upsertCoolifyAppRepo({
      application_uuid: uuid,
      user_id: userId,
      repo_key: repoKey,
      git_full_url: gitUrl,
    })
  } catch (err: any) {
    console.warn(`[coolify-app-repo] cache upsert failed uuid=${uuid}: ${err?.message}`)
  }

  return repoKey
}
