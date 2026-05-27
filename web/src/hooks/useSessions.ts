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
  hostname?: string | null
  // ── Phase 08 — GitHub-keyed session fields ────────────────────────────────
  // All nullable: legacy/local-only sessions have repo_key === null.
  repo_key?: string | null
  github_owner?: string | null
  github_repo?: string | null
}

/**
 * Derive a `owner/repo` label from a session's GitHub identity, or null when
 * the session is not GitHub-keyed.
 */
export function githubOwnerRepo(s: CodeSession): string | null {
  if (s.github_owner && s.github_repo) return `${s.github_owner}/${s.github_repo}`
  return null
}

export function useSessions(token: string | null) {
  const [sessions, setSessions] = useState<CodeSession[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    if (!token) return
    try {
      const data = await hubFetch<CodeSession[]>(token, '/api/sessions')
      setSessions(data)
    } catch { /* swallow */ }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchSessions() }, [fetchSessions])

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

  return { sessions, setSessions, loading, createSession, deleteSession, rotateToken, updateSessionStatus, refetch: fetchSessions }
}
