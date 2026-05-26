/**
 * Shared fetch helper used by data hooks. Centralizes hub URL resolution + auth
 * via cookie (`__Host-remo_sid`) + CSRF (`csrf_token`) header injection so
 * individual hooks/components don't repeat the boilerplate.
 *
 * Usage:
 *   const data = await hubFetch<MyType>(null, '/api/foo')
 *   await hubFetch(null, '/api/foo', { method: 'POST', json: { ... } })
 *
 * Auth model (Phase 07): session cookie is HttpOnly, set by the magic-link
 * callback on the hub. JS cannot read it. We set `credentials: 'include'` on
 * every request so the browser attaches it. The `csrf_token` cookie is
 * intentionally NOT HttpOnly (double-submit pattern) — we read it and echo it
 * via `X-CSRF-Token` on every mutating request.
 *
 * During the dual-auth soak window, if a `Bearer` token is passed AND no
 * `csrf_token` cookie is present, we fall back to attaching `Authorization`.
 *
 * Throws `HubFetchError` (typed) on non-2xx so consumers can branch on
 * `.status` and surface server-side error payloads. Special statuses 401
 * (re-auth or unauth), 402 (license_required) are surfaced via `onAuthEvent`
 * for upstream UI handling.
 */

const HUB_URL: string = (import.meta as any).env?.VITE_HUB_URL || ''

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export class HubFetchError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body: any) {
    super(message)
    this.name = 'HubFetchError'
    this.status = status
    this.body = body
  }
}

export interface HubFetchOptions extends Omit<RequestInit, 'body'> {
  /** When set, JSON.stringified and Content-Type defaulted. Pass null/undefined to skip body. */
  json?: unknown
  body?: BodyInit | null
  /** Don't parse a response — return the raw Response. */
  raw?: boolean
}

/**
 * Read a cookie value by name. Returns null if absent.
 * Safe to call in environments without `document` (returns null).
 */
export function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null
  const prefix = name + '='
  for (const part of document.cookie.split(';')) {
    const c = part.trim()
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length))
  }
  return null
}

/** Convenience — readable session indicator (NOT the HttpOnly session id). */
export function hasSessionCookie(): boolean {
  // We can't read `__Host-remo_sid` (HttpOnly) — presence of csrf_token is the
  // only JS-visible signal that a session exists.
  return readCookie('csrf_token') !== null
}

export type AuthEventKind = 're_auth_required' | 'unauthorized' | 'license_required'
type AuthEventHandler = (
  kind: AuthEventKind,
  details: { status: number; body: any; path: string; method: string },
) => void

let authEventHandler: AuthEventHandler | null = null
export function onAuthEvent(handler: AuthEventHandler | null) {
  authEventHandler = handler
}

export async function hubFetch<T = any>(
  token: string | null,
  path: string,
  opts: HubFetchOptions = {},
): Promise<T> {
  const { json, raw, headers, body, method, ...rest } = opts
  const finalHeaders: Record<string, string> = {
    ...((headers || {}) as Record<string, string>),
  }
  const m = (method || 'GET').toUpperCase()
  const isMutating = MUTATING.has(m)

  // CSRF for mutating requests: double-submit cookie pattern. The hub sets
  // `csrf_token` as a non-HttpOnly cookie when issuing a session; we echo it
  // in a header so the hub can compare. Server-side enforcement of
  // header==cookie is what makes the pattern secure.
  const csrf = readCookie('csrf_token')
  if (isMutating && csrf) {
    finalHeaders['X-CSRF-Token'] = csrf
  }

  // Soak-window: attach Authorization: Bearer whenever a legacy token is
  // available AND it isn't the cookie-session sentinel. This must run
  // INDEPENDENTLY of csrf-cookie presence — a legacy-JWT user can also have
  // a stale `csrf_token` cookie hanging around (e.g. from a prior magic-link
  // session that was later replaced by a bcrypt login). Without the Bearer
  // header in that case, hub-side `csrfGuard` has no way to know this is a
  // non-CSRF-eligible Bearer-authed request and falls back to double-submit
  // enforcement, which fails because the stale `X-CSRF-Token` no longer
  // matches the server cookie. PR #65 added the server-side Bearer bypass —
  // this is the client-side half: always send the Bearer when we have a
  // real legacy token so the bypass actually fires.
  if (token && token !== 'cookie') {
    finalHeaders['Authorization'] = `Bearer ${token}`
  }

  let finalBody: BodyInit | null | undefined = body
  if (json !== undefined && json !== null) {
    finalBody = JSON.stringify(json)
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json'
  }

  const res = await fetch(`${HUB_URL}${path}`, {
    ...rest,
    method: m,
    headers: finalHeaders,
    body: finalBody,
    credentials: 'include',
  })

  if (raw) return res as unknown as T

  const text = await res.text()
  let parsed: any = null
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }

  if (!res.ok) {
    // Surface special statuses to upstream UI before throwing.
    if (authEventHandler) {
      if (res.status === 401) {
        const kind: AuthEventKind = parsed?.error === 're_auth_required' ? 're_auth_required' : 'unauthorized'
        try { authEventHandler(kind, { status: res.status, body: parsed, path, method: m }) } catch {}
      } else if (res.status === 402) {
        try { authEventHandler('license_required', { status: res.status, body: parsed, path, method: m }) } catch {}
      }
    }
    const msg = (parsed && parsed.error) || res.statusText || `HTTP ${res.status}`
    throw new HubFetchError(typeof msg === 'string' ? msg : 'request failed', res.status, parsed)
  }
  return parsed as T
}

export function hubUrl(): string {
  return HUB_URL
}
