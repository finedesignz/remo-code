/**
 * Auth client (Phase 07 — Titanium cutover).
 *
 * Session is owned by an HttpOnly cookie (`__Host-remo_sid`) set by the hub when
 * a Titanium hosted login completes (`/auth/callback`). JS can NOT read it. We only see the companion
 * non-HttpOnly `csrf_token` cookie, which is also our "user is signed in"
 * signal (see `hasSessionCookie`).
 *
 * There is no in-app login form: the login page only sends the user to the
 * Titanium Labs hosted login (`titaniumStartAction` / `startAppLogin`).
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
 * App shell (Tauri WebView, deep-link return): ask the hub to start the hosted login
 * (`POST /auth/start {client:"app"}`: sets the PKCE pending cookie in this WebView's jar)
 * and return the Titanium Labs login URL to navigate to. Throws a hub error code.
 */
export async function startAppLogin(): Promise<string> {
  const res = await fetch(`${HUB_URL}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'app' }),
    credentials: 'include',
  })
  const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null
  if (!res.ok || !body?.url) throw new Error(body?.error || 'server_misconfigured')
  return body.url
}

/** Form action of the "Continue with Titanium" button (hosted login, PKCE). */
export function titaniumStartAction(): string {
  return `${HUB_URL}/auth/start`
}

/**
 * Full sign-out: a top-level form POST to the hub's `/auth/logout`, which clears
 * the hub session and 303s the browser (a top-level GET) to the Titanium portal
 * logout (its session would otherwise sign the user straight back in on the next
 * "Continue with Titanium").
 */
export function submitFullLogout(): void {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = `${HUB_URL}/auth/logout`
  form.style.display = 'none'
  document.body.appendChild(form)
  form.submit()
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

/** Stale localStorage keys from the retired password login; only ever cleared. */
const LS_TOKEN = 'remo_token'
const LS_USER = 'remo_user'

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
