import { useState, useEffect, useCallback } from 'react'
import {
  getStoredToken,
  getStoredUser,
  storeAuth,
  clearAuth,
  hasSessionCookie,
  apiLogout,
  fetchCurrentUser,
  type AuthUser,
} from '../lib/auth'

interface AuthState {
  user: AuthUser | null
  /**
   * Bearer token — preserved for the soak window so existing useWebSocket /
   * useChat call sites that still take a `token` keep functioning. Once cookie
   * auth is sole source of truth, callers can ignore it. We continue to return
   * a non-null sentinel ('cookie') when cookie-only so token-truthy checks
   * still pass.
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
      // Cookie path first — magic-link auth sets the cookie; we hydrate user
      // from /api/profile.
      if (hasSessionCookie()) {
        const user = await fetchCurrentUser()
        if (!cancelled && user) {
          setState({ user, token: COOKIE_SENTINEL, loading: false })
          return
        }
      }
      // Soak fallback — legacy localStorage bearer flow.
      const token = getStoredToken()
      const user = getStoredUser()
      if (!cancelled) setState({ user, token, loading: false })
    }
    init()
    return () => { cancelled = true }
  }, [])

  const signIn = useCallback((token: string | null, user: AuthUser) => {
    storeAuth(token, user)
    setState({ user, token: token ?? COOKIE_SENTINEL, loading: false })
  }, [])

  const signOut = useCallback(() => {
    // Clear server-side cookie + local fallback in parallel.
    void apiLogout()
    clearAuth()
    setState({ user: null, token: null, loading: false })
    // Force a hard reload so any cached connections (WS, EventSource) tear down.
    try { window.location.hash = '#/login' } catch {}
  }, [])

  return { ...state, signIn, signOut }
}
