import { useState, useEffect, useCallback } from 'react'
import {
  clearAuth,
  hasSessionCookie,
  apiLogout,
  submitFullLogout,
  fetchCurrentUser,
  type AuthUser,
} from '../lib/auth'

interface AuthState {
  user: AuthUser | null
  /**
   * Always the 'cookie' sentinel when signed in (the session is an HttpOnly
   * cookie; JS holds no credential), so existing token-truthy checks still pass.
   */
  token: string | null
  loading: boolean
}

const COOKIE_SENTINEL = 'cookie'

export function useAuth() {
  const [state, setState] = useState<AuthState>({ user: null, token: null, loading: true })

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      // The hub's /auth/callback sets the session cookie; hydrate the user from /api/profile.
      if (hasSessionCookie()) {
        const user = await fetchCurrentUser()
        if (!cancelled && user) {
          setState({ user, token: COOKIE_SENTINEL, loading: false })
          return
        }
      }
      // No session cookie (or a dead one): signed out. The Titanium hosted login is
      // the only way in.
      if (!cancelled) setState({ user: null, token: null, loading: false })
    }
    init()
    return () => { cancelled = true }
  }, [])

  const signOut = useCallback(() => {
    // Clear server-side cookie + local fallback in parallel.
    void apiLogout()
    clearAuth()
    setState({ user: null, token: null, loading: false })
    // Force a hard reload so any cached connections (WS, EventSource) tear down.
    try { window.location.hash = '#/login' } catch {}
  }, [])

  /**
   * Explicit user sign-out (the Logout menu item): clears the local fallback and
   * top-level POSTs to the hub's /auth/logout, which ends the hub session and then
   * the Titanium portal session (303 to the portal's GET logout). `signOut` above stays the
   * LOCAL-only cleanup used for a dead credential (a 401), so a transient error
   * never signs the user out of Titanium itself.
   */
  const logout = useCallback(() => {
    clearAuth()
    setState({ user: null, token: null, loading: false })
    submitFullLogout()
  }, [])

  return { ...state, signOut, logout }
}
