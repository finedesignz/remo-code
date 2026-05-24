/**
 * Shared fetch helper used by data hooks. Centralizes hub URL resolution + auth
 * header injection so individual hooks/components don't repeat the boilerplate.
 *
 * Usage:
 *   const data = await hubFetch<MyType>(token, '/api/foo')
 *   await hubFetch(token, '/api/foo', { method: 'POST', body: JSON.stringify({...}) })
 *
 * Throws `HubFetchError` (typed) on non-2xx so consumers can branch on `.status`
 * and surface server-side error payloads (e.g. cycle detection on chain actions).
 */

const HUB_URL: string = (import.meta as any).env?.VITE_HUB_URL || ''

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

export async function hubFetch<T = any>(
  token: string | null,
  path: string,
  opts: HubFetchOptions = {},
): Promise<T> {
  const { json, raw, headers, body, ...rest } = opts
  const finalHeaders: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((headers || {}) as Record<string, string>),
  }
  let finalBody: BodyInit | null | undefined = body
  if (json !== undefined && json !== null) {
    finalBody = JSON.stringify(json)
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${HUB_URL}${path}`, {
    ...rest,
    headers: finalHeaders,
    body: finalBody,
  })
  if (raw) return res as unknown as T
  const text = await res.text()
  let parsed: any = null
  if (text) {
    try { parsed = JSON.parse(text) } catch { parsed = text }
  }
  if (!res.ok) {
    const msg = (parsed && parsed.error) || res.statusText || `HTTP ${res.status}`
    throw new HubFetchError(typeof msg === 'string' ? msg : 'request failed', res.status, parsed)
  }
  return parsed as T
}

export function hubUrl(): string {
  return HUB_URL
}
