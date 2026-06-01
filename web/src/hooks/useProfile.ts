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
  // Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt bound. null/absent = OFF.
  programmatic_halt_usd?: number | null
  web_push_enabled?: boolean
  timezone?: string
}

export function useProfile(token: string | null) {
  const [profile, setProfile] = useState<Profile | null>(null)
  // `settled` = a fetch for the CURRENT token has completed (success or fail).
  // `resolvedToken` tracks which token that `settled`/`profile` pair belongs to.
  const [settled, setSettled] = useState(false)
  const [resolvedToken, setResolvedToken] = useState<string | null>(token)

  // Render-phase state adjustment (React's official derived-state pattern):
  // when `token` changes — most importantly null → set on sign-in — reset
  // `settled`/`profile` SYNCHRONOUSLY, in the same commit, before any effect or
  // child renders. `loading` below is then derived, so it is never stale.
  //
  // This is what closes the auto-logout race: previously `loading` was a plain
  // effect-set flag, so for one render right after sign-in App saw
  // `!profileLoading && !profile && token` and fired the dead-credential
  // signOut() — logging the user out the instant they logged in ("dashboard for
  // a second, then back to login"). With derived loading, that window can't exist.
  if (resolvedToken !== token) {
    setResolvedToken(token)
    setSettled(false)
    setProfile(null)
  }
  // Loading whenever we have a token but haven't settled a fetch for it yet.
  const loading = !!token && !settled

  const fetchProfile = useCallback(async () => {
    if (!token) { setSettled(true); return }
    try {
      const p = await hubFetch<Profile>(token, '/api/profile')
      setProfile(p)
    } catch { /* leave profile null — a real dead credential is handled by App */ }
    setSettled(true)
  }, [token])

  useEffect(() => { fetchProfile() }, [fetchProfile])

  const updateProfile = useCallback(async (data: {
    display_name?: string
    avatar_url?: string | null
    system_prompt?: string | null
    daily_cost_cap_usd?: number
    programmatic_halt_usd?: number | null
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
