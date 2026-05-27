import { useState, useEffect, useCallback, useRef } from 'react'
import { hubFetch, HubFetchError } from '../lib/api'

/**
 * A folder reported by some supervisor/agent that is NOT yet on GitHub (or not
 * even a git repo) and that the user has not yet dismissed. Drives the
 * "Needs attention" prompt in the sidebar.
 *
 * Shape matches `PendingPromptSchema` in `hub/src/api/_openapi.ts`.
 */
export interface PendingLocalRepo {
  hostname: string
  project_dir: string
  is_git_repo: boolean
  first_seen_at: string
  last_seen_at: string
}

export interface CreateGithubRepoError {
  /** True when the error was 412 — GitHub App missing `administration:write`. */
  scopeMissing: boolean
  detail: string
}

const POLL_INTERVAL_MS = 30_000

/**
 * Polls `GET /api/sessions/pending-prompts` every 30s and exposes
 * dismiss/create-on-github actions. Optimistic local removal on dismiss so the
 * row vanishes immediately without waiting for the next poll.
 */
export function usePendingLocalRepos(token: string | null) {
  const [pending, setPending] = useState<PendingLocalRepo[]>([])
  const [loading, setLoading] = useState(false)
  const mounted = useRef(true)

  const fetchPending = useCallback(async () => {
    if (!token) {
      setPending([])
      return
    }
    setLoading(true)
    try {
      const data = await hubFetch<{ pending: PendingLocalRepo[] }>(token, '/api/sessions/pending-prompts')
      if (mounted.current) setPending(data.pending ?? [])
    } catch {
      /* swallow — keep prior state */
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [token])

  useEffect(() => {
    mounted.current = true
    fetchPending()
    if (!token) return () => { mounted.current = false }
    const id = window.setInterval(fetchPending, POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      window.clearInterval(id)
    }
  }, [fetchPending, token])

  /**
   * Optimistically remove from local state then POST. On failure, refetch to
   * restore truth.
   */
  const dismiss = useCallback(async (hostname: string, project_dir: string): Promise<boolean> => {
    if (!token) return false
    setPending(prev => prev.filter(p => !(p.hostname === hostname && p.project_dir === project_dir)))
    try {
      await hubFetch(token, '/api/sessions/dismiss-local', {
        method: 'POST',
        json: { hostname, project_dir },
      })
      return true
    } catch {
      fetchPending()
      return false
    }
  }, [token, fetchPending])

  /**
   * Create a GitHub repo for the given session. v1 surface: caller passes
   * defaults; the modal/Create-on-GitHub flow will eventually own this.
   *
   * Returns the parsed response on success. Throws a `CreateGithubRepoError`
   * shaped object on the 412 missing-scope path so the UI can render a
   * targeted hint, and a generic Error otherwise.
   */
  const createGithubRepo = useCallback(async (
    sessionId: string,
    body: { name?: string; visibility?: 'private' | 'public'; org?: string | null } = {},
  ): Promise<{ job_id: string } | null> => {
    if (!token) return null
    try {
      return await hubFetch<{ job_id: string }>(
        token,
        `/api/sessions/${sessionId}/create-github-repo`,
        { method: 'POST', json: body },
      )
    } catch (err) {
      if (err instanceof HubFetchError && err.status === 412) {
        const e: CreateGithubRepoError = {
          scopeMissing: true,
          detail: (err.body && err.body.detail) || 'GitHub App needs administration:write — contact admin.',
        }
        throw e
      }
      throw err
    }
  }, [token])

  return { pending, loading, dismiss, createGithubRepo, refetch: fetchPending }
}
