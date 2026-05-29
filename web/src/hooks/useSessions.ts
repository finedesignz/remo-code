import { useState, useEffect, useCallback } from 'react'
import { hubFetch } from '../lib/api'

export interface AgentInfo {
  hostname?: string
  platform?: string
  os_release?: string
  arch?: string
  cpu_model?: string
  cpu_cores?: number
  total_mem_bytes?: number
  node_version?: string
  bun_version?: string
  agent_version?: string
}

export interface CodeSession {
  id: string
  name: string
  project_dir: string | null
  status: string
  last_activity: string | null
  created_at: string
  agent_info?: AgentInfo | null
  cli_kind?: 'claude' | 'codex'
  is_rootless?: boolean
  is_orchestrator?: boolean
  hostname?: string | null
  // ── Phase 08 — GitHub-keyed session fields ────────────────────────────────
  // All nullable: legacy/local-only sessions have repo_key === null.
  repo_key?: string | null
  github_owner?: string | null
  github_repo?: string | null
  // ── Phase 08.6 — known local working trees for this repo ──────────────────
  // Populated from the supervisor inventory cache. Empty for legacy sessions
  // and when the supervisor hasn't uploaded inventory yet. Capped at 20.
  local_paths?: Array<{
    local_path: string
    branch: string | null
    is_worktree: boolean
    canonical: boolean
  }>
}

/**
 * Derive a `owner/repo` label from a session's GitHub identity, or null when
 * the session is not GitHub-keyed.
 */
export function githubOwnerRepo(s: CodeSession): string | null {
  if (s.github_owner && s.github_repo) return `${s.github_owner}/${s.github_repo}`
  return null
}

type Subscribe = (handler: (msg: any) => void) => () => void

export function useSessions(
  token: string | null,
  subscribe?: Subscribe,
  connectionId?: number,
) {
  const [sessions, setSessions] = useState<CodeSession[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    if (!token) return
    try {
      const data = await hubFetch<CodeSession[]>(token, '/api/sessions')
      // Defensive: the hub can return a non-array 200 body under odd
      // auth/license/bypass states (e.g. a `{sessions:[]}` wrapper or an
      // error-shaped 200). A non-array here propagates into `sessions.filter`
      // / `for…of sessions` in consumers (Sidebar, SessionDropdown,
      // SupervisorPage) and crashes the per-tab ErrorBoundary. Coerce to [].
      setSessions(Array.isArray(data) ? data : [])
    } catch { /* swallow */ }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchSessions() }, [fetchSessions, connectionId])

  // When the hub broadcasts a fresh `session_list` (supervisor reconnect,
  // repo_inventory upsert, session offline-close), replace our local copy.
  // This is what makes the sidebar / supervisor page show launched sessions
  // come back without a refresh after a supervisor restart.
  useEffect(() => {
    if (!subscribe) return
    return subscribe((msg) => {
      if (!msg || msg.type !== 'session_list' || !Array.isArray(msg.sessions)) return
      setSessions(msg.sessions as CodeSession[])
      setLoading(false)
    })
  }, [subscribe])

  const createSession = async (name: string, projectDir?: string): Promise<any> => {
    if (!token) return null
    try {
      const data = await hubFetch<any>(token, '/api/sessions', {
        method: 'POST',
        json: { name, project_dir: projectDir },
      })
      await fetchSessions()
      return data // includes { ...session, token: "remo_..." }
    } catch {
      return null
    }
  }

  const deleteSession = async (id: string) => {
    if (!token) return
    try { await hubFetch(token, `/api/sessions/${id}`, { method: 'DELETE' }) } catch {}
    await fetchSessions()
  }

  const rotateToken = async (id: string) => {
    if (!token) return null
    try {
      return await hubFetch<{ token: string }>(token, `/api/sessions/${id}/rotate-token`, { method: 'POST' })
    } catch {
      return null
    }
  }

  const updateSessionStatus = (sessionId: string, status: string) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s))
  }

  // ── Phase 08.5 — launch / clone-here / create-github-repo helpers ──────────
  // All three POST to session-scoped endpoints; the hub does the heavy lifting
  // (supervisor dispatch, GH API call, job enqueue) and progress arrives via
  // websocket. These helpers swallow HubFetchError into a small typed result
  // so callers can branch on `error` strings without try/catch noise.

  const launchSession = useCallback(async (
    id: string,
    body: { cli_kind?: 'claude' | 'codex'; local_path?: string } = {},
  ): Promise<{ ok: boolean; error?: string; detail?: string }> => {
    if (!token) return { ok: false, error: 'unauthorized' }
    try {
      await hubFetch(token, `/api/sessions/${id}/launch`, { method: 'POST', json: body })
      return { ok: true }
    } catch (err: any) {
      const status = err?.status as number | undefined
      const errCode = (err?.body?.error as string | undefined) ?? (status ? `http_${status}` : 'unknown')
      return { ok: false, error: errCode, detail: err?.body?.detail }
    }
  }, [token])

  const cloneHere = useCallback(async (
    id: string,
    targetRoot: string,
  ): Promise<{ ok: boolean; error?: string; target_path?: string; req_id?: string }> => {
    if (!token) return { ok: false, error: 'unauthorized' }
    try {
      const res = await hubFetch<{ cloning: boolean; req_id: string; target_path: string }>(
        token, `/api/sessions/${id}/clone-here`,
        { method: 'POST', json: { target_root: targetRoot } },
      )
      return { ok: true, target_path: res.target_path, req_id: res.req_id }
    } catch (err: any) {
      return { ok: false, error: (err?.body?.error as string) ?? 'unknown' }
    }
  }, [token])

  const createGithubRepo = useCallback(async (
    id: string,
    opts: { name: string; private: boolean; org?: string | null },
  ): Promise<{ ok: boolean; job_id?: string; error?: string; scopeMissing?: boolean }> => {
    if (!token) return { ok: false, error: 'unauthorized' }
    try {
      const res = await hubFetch<{ job_id: string }>(token, `/api/sessions/${id}/create-github-repo`, {
        method: 'POST',
        json: {
          name: opts.name,
          visibility: opts.private ? 'private' : 'public',
          org: opts.org ?? undefined,
        },
      })
      return { ok: true, job_id: res.job_id }
    } catch (err: any) {
      const status = err?.status as number | undefined
      if (status === 412) {
        return { ok: false, scopeMissing: true, error: 'github_app_missing_scope' }
      }
      return { ok: false, error: (err?.body?.error as string) ?? 'unknown' }
    }
  }, [token])

  return {
    sessions, setSessions, loading,
    createSession, deleteSession, rotateToken, updateSessionStatus,
    refetch: fetchSessions,
    launchSession, cloneHere, createGithubRepo,
  }
}
