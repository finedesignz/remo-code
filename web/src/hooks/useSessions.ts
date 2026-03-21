import { useState, useEffect, useCallback } from 'react'
import type { Session as SupaSession } from '@supabase/supabase-js'
import { hubFetch } from '../lib/api'

export interface CodeSession {
  id: string
  name: string
  project_dir: string | null
  status: string
  last_activity: string | null
  created_at: string
}

export function useSessions(session: SupaSession | null) {
  const [sessions, setSessions] = useState<CodeSession[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    if (!session?.access_token) return
    const res = await hubFetch('/api/sessions', session.access_token)
    if (res.ok) {
      setSessions(await res.json())
    }
    setLoading(false)
  }, [session?.access_token])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  const createSession = useCallback(async (name: string, projectDir?: string): Promise<any> => {
    if (!session?.access_token) return null
    const res = await hubFetch('/api/sessions', session.access_token, {
      method: 'POST',
      body: JSON.stringify({ name, project_dir: projectDir }),
    })
    if (res.ok) {
      const data = await res.json()
      await fetchSessions()
      return data
    }
    if (res.status === 403) {
      return { error: 'session_limit_reached', status: 403 }
    }
    return null
  }, [session?.access_token, fetchSessions])

  const deleteSession = useCallback(async (id: string) => {
    if (!session?.access_token) return
    await hubFetch(`/api/sessions/${id}`, session.access_token, { method: 'DELETE' })
    await fetchSessions()
  }, [session?.access_token, fetchSessions])

  const rotateToken = useCallback(async (id: string) => {
    if (!session?.access_token) return null
    const res = await hubFetch(`/api/sessions/${id}/rotate-token`, session.access_token, { method: 'POST' })
    if (res.ok) return res.json()
    return null
  }, [session?.access_token])

  const updateSessionStatus = useCallback((sessionId: string, status: string) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s))
  }, [])

  return { sessions, setSessions, loading, createSession, deleteSession, rotateToken, updateSessionStatus, refetch: fetchSessions }
}
