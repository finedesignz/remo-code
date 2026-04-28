import { useState, useEffect, useCallback } from 'react'

export interface Profile {
  id: string
  email: string
  display_name: string | null
  role: string
  session_count: number
}

export function useProfile(token: string | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = useCallback(async () => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    try {
      const res = await fetch(`${hubUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.ok) setProfile(await res.json())
    } catch {
      // ignore
    }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  const updateProfile = useCallback(async (data: { display_name: string }) => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    })
    if (res.ok) {
      const updated = await res.json()
      setProfile(updated)
      return updated
    }
    return null
  }, [token])

  return { profile, loading, fetchProfile, updateProfile }
}
