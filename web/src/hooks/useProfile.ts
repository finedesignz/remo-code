import { useState, useEffect, useCallback } from 'react'
import { hubFetch } from '../lib/api'

export interface Profile {
  id: string
  email: string
  display_name: string | null
  avatar_url?: string | null
  role: string
  session_count: number
  system_prompt?: string | null
  daily_cost_cap_usd?: number
  web_push_enabled?: boolean
  timezone?: string
}

export function useProfile(token: string | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchProfile = useCallback(async () => {
    if (!token) { setLoading(false); return }
    // Reset to loading on every (re)fetch — critically when `token` transitions
    // null → set on sign-in. Without this the flag stays at the stale `false`
    // left by the no-token branch, so App's dead-credential effect sees
    // `!profileLoading && !profile && token` for one render and force-signs-out
    // the user the instant they log in (auto-logout race).
    setLoading(true)
    try {
      const p = await hubFetch<Profile>(token, '/api/profile')
      setProfile(p)
    } catch { /* swallow */ }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  const updateProfile = useCallback(async (data: {
    display_name?: string
    avatar_url?: string | null
    system_prompt?: string | null
    daily_cost_cap_usd?: number
    web_push_enabled?: boolean
    timezone?: string
  }) => {
    if (!token) return
    try {
      const updated = await hubFetch<Profile>(token, '/api/profile', {
        method: 'PATCH',
        json: data,
      })
      setProfile(updated)
      return updated
    } catch {
      return null
    }
  }, [token])

  return { profile, loading, fetchProfile, updateProfile }
}
