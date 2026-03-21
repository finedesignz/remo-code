import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface Profile {
  id: string
  email: string
  display_name: string | null
  role: string
  session_count: number
}

export function useProfile(session: Session | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = useCallback(async () => {
    if (!session?.access_token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    try {
      const res = await fetch(`${hubUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) setProfile(await res.json())
    } catch {
      // ignore
    }
    setLoading(false)
  }, [session?.access_token])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  const updateProfile = useCallback(async (data: { display_name: string }) => {
    if (!session?.access_token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      const updated = await res.json()
      setProfile(updated)
      return updated
    }
    return null
  }, [session?.access_token])

  return { profile, loading, fetchProfile, updateProfile }
}
