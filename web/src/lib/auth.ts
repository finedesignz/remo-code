/**
 * Auth client (Phase 07 — Titanium cutover).
 *
 * Session is owned by an HttpOnly cookie (`__Host-remo_sid`) set by the hub on
 * the magic-link callback. JS can NOT read it. We only see the companion
 * non-HttpOnly `csrf_token` cookie, which is also our "user is signed in"
 * signal (see `hasSessionCookie`).
 *
 * Legacy password login is kept available behind a soak flag and a fallback
 * function until plan D7 flips `VITE_HIDE_LEGACY_LOGIN=true`.
 */

import { hubFetch, hubUrl, hasSessionCookie } from './api'

const HUB_URL = import.meta.env.VITE_HUB_URL || ''

export interface AuthUser {
  id: string
  email: string
  role: string
  display_name?: string
}

/**
 * Request a magic-link email. Server ALWAYS returns 200 (enumeration
 * prevention) — caller should render a generic "check your inbox" state
 * regardless of outcome.
 */
export async function requestMagicLink(email: string): Promise<void> {
  const res = await fetch(`${HUB_URL}/api/auth/login/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    credentials: 'include',
  }).catch(() => null)
  // Magic-link is globally disabled when the hub runs Titanium-bypassed
  // (503 `{ error: "titanium_disabled" }`). That is a deployment-wide config
  // state, NOT a per-email signal — surfacing it leaks no enumeration info, and
  // silently rendering "check your inbox" would strand the user waiting for an
  // email that will never send. Signal the caller to fall back to password
  // sign-in. Every other outcome stays silent (enumeration safety).
  if (res && res.status === 503) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    if (body?.error === 'titanium_disabled') throw new Error('magic_link_disabled')
  }
}

/**
 * Legacy password login — preserved during dual-auth soak. Returns the user
 * object on success (the cookie is set by the hub via Set-Cookie). The token
 * field is returned for backward-compatibility with the soak-mode bearer flow;
 * post-cutover the cookie is the only credential needed.
 */
export async function legacyPasswordLogin(
  email: string,
  password: string,
): Promise<{ token?: string; user: AuthUser }> {
  const res = await fetch(`${HUB_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'include',
  })
  if (!res.ok) {
    if (res.status === 410) {
      throw new Error('Password sign-in is disabled. Use the magic-link form.')
    }
    const err = await res.json().catch(() => ({ error: 'Login failed' }))
    throw new Error(err.error || 'Login failed')
  }
  return res.json()
}

/** Logout — clears the session cookie server-side. CSRF-exempt by design. */
export async function apiLogout(): Promise<void> {
  await fetch(`${HUB_URL}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {})
}

/** Returns the current authenticated user, or null if unauthenticated. */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  try {
    const me = await hubFetch<AuthUser>(null, '/api/profile')
    return me as AuthUser
  } catch {
    return null
  }
}

/**
 * Legacy localStorage shims — preserved during the soak window so the legacy
 * password path still hydrates the in-memory app state. Post-cutover these
 * become no-ops and the cookie + `/api/profile` round-trip is authoritative.
 */
const LS_TOKEN = 'remo_token'
const LS_USER = 'remo_user'

export function getStoredToken(): string | null {
  try { return localStorage.getItem(LS_TOKEN) } catch { return null }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(LS_USER)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function storeAuth(token: string | null, user: AuthUser): void {
  try {
    if (token) localStorage.setItem(LS_TOKEN, token)
    localStorage.setItem(LS_USER, JSON.stringify(user))
  } catch {}
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(LS_TOKEN)
    localStorage.removeItem(LS_USER)
  } catch {}
}

/** Titanium portal URL — env override → fallback. */
export function titaniumPortalUrl(): string {
  // NOTE: confirm the canonical Titanium license-portal hostname before D7.
  // Default below mirrors the user's stated convention in the plan brief.
  const env = (import.meta as any).env?.VITE_TITANIUM_PORTAL_URL as string | undefined
  return env || 'https://license.titaniumlabs.us'
}

export { hasSessionCookie, hubUrl }
