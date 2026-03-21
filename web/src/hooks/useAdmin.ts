import { useState, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface AdminUser {
  id: string
  email: string
  display_name: string | null
  role: string
  tier: string
  session_count: number
  created_at: string
}

export interface AdminStats {
  total_users: number
  total_sessions: number
  online_sessions: number
  total_messages: number
  tiers: { free: number; pro: number; max: number }
}

export function useAdmin(session: Session | null) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(true)

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token}`,
  })

  const hubUrl = import.meta.env.VITE_HUB_URL || ''

  const fetchUsers = useCallback(async () => {
    if (!session?.access_token) return
    try {
      const res = await fetch(`${hubUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) setUsers(await res.json())
    } catch {
      // ignore
    }
  }, [session?.access_token, hubUrl])

  const fetchStats = useCallback(async () => {
    if (!session?.access_token) return
    try {
      const res = await fetch(`${hubUrl}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) setStats(await res.json())
    } catch {
      // ignore
    }
  }, [session?.access_token, hubUrl])

  const fetchAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchUsers(), fetchStats()])
    setLoading(false)
  }, [fetchUsers, fetchStats])

  const updateUser = useCallback(async (id: string, data: { role?: string; tier?: string }) => {
    if (!session?.access_token) return false
    const res = await fetch(`${hubUrl}/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(data),
    })
    if (res.ok) {
      await fetchUsers()
      return true
    }
    return false
  }, [session?.access_token, hubUrl, fetchUsers])

  const deleteUser = useCallback(async (id: string) => {
    if (!session?.access_token) return false
    const res = await fetch(`${hubUrl}/api/admin/users/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      await fetchAll()
      return true
    }
    return false
  }, [session?.access_token, hubUrl, fetchAll])

  return { users, stats, loading, fetchAll, updateUser, deleteUser }
}
