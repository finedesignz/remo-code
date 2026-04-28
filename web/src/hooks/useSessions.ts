import { useState, useEffect, useCallback } from 'react'

export interface CodeSession {
  id: string
  name: string
  project_dir: string | null
  status: string
  last_activity: string | null
  created_at: string
}

export function useSessions(token: string | null) {
  const [sessions, setSessions] = useState<CodeSession[]>([])
  const [loading, setLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      setSessions(await res.json())
    }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  const createSession = async (name: string, projectDir?: string): Promise<any> => {
    if (!token) return null
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name, project_dir: projectDir }),
    })
    if (res.ok) {
      const data = await res.json()
      await fetchSessions()
      return data // includes { ...session, token: "remo_..." }
    }
    return null
  }

  const deleteSession = async (id: string) => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    await fetch(`${hubUrl}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await fetchSessions()
  }

  const rotateToken = async (id: string) => {
    if (!token) return null
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/sessions/${id}/rotate-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) return res.json() // { token: "remo_..." }
    return null
  }

  const updateSessionStatus = (sessionId: string, status: string) => {
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, status } : s))
  }

  return { sessions, setSessions, loading, createSession, deleteSession, rotateToken, updateSessionStatus, refetch: fetchSessions }
}
