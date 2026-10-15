/**
 * Auth client (Phase 07 — Titanium cutover).
 *
 * Session is owned by an HttpOnly cookie (`__Host-remo_sid`) set by the hub when
 * a Titanium hosted login completes (`/auth/callback`). JS can NOT read it. We only see the companion
 * non-HttpOnly `csrf_token` cookie, which is also our "user is signed in"
 * signal (see `hasSessionCookie`).
 *
 * Legacy password login and the own magic link are kept behind hub flags
 * (ALLOW_LEGACY_LOGIN / LEGACY_MAGIC_LINK_LOGIN, both default off); the login
 * page shows them only when `/api/client-config` says they are enabled.
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
 * Titanium hosted login, email path. The hub (`POST /auth/email`) sets the
 * short-lived `remo_login` state cookie and asks the Titanium portal to mail a
 * sign-in link that returns to `/auth/callback`. Same answer for every address,
 * so the caller always renders "check your inbox". `client: 'app'` is the Tauri
 * shell (deep-link return, PKCE). Throws only on a config/transport failure that
 * says nothing about the address (invalid email format, misconfigured server).
 */
export async function requestTitaniumLink(email: string, client: 'web' | 'app' = 'web'): Promise<void> {
  const res = await fetch(`${HUB_URL}/auth/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, client }),
    credentials: 'include',
  })
  if (res.ok) return
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error || 'send_failed')
}

/** Form action of the "Continue with Titanium" button (hosted login, PKCE). */
export function titaniumStartAction(): string {
  return `${HUB_URL}/auth/start`
}

/**
 * Full sign-out: a top-level form POST to the hub's `/auth/logout`, which clears
 * the hub session and lands on `/auth/signed-out`, which in turn POSTs the
 * browser to the Titanium portal logout (its session would otherwise sign the
 * user straight back in on the next "Continue with Titanium").
 */
export function submitFullLogout(): void {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = `${HUB_URL}/auth/logout`
  form.style.display = 'none'
  document.body.appendChild(form)
  form.submit()
}

/**
 * LEGACY own magic link (hub `LEGACY_MAGIC_LINK_LOGIN=on` only; the route 404s
 * otherwise). Kept for one release as a rollback.
 */
export async function requestMagicLink(email: string): Promise<void> {
  await fetch(`${HUB_URL}/api/auth/login/request-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    credentials: 'include',
  }).catch(() => null)
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
    if (res.status === 404 || res.status === 410) {
      throw new Error('Password sign-in is disabled. Use the email link or Continue with Titanium.')
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
