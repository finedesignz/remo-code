import { useState, useEffect, useCallback } from 'react'
import { hubFetch, HubFetchError } from '../lib/api'

export interface ApiKey {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export type ApiKeyOpResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: 're_auth_required' | 'unknown'; message: string }

function classifyError(e: unknown): { code: 're_auth_required' | 'unknown'; message: string } {
  if (e instanceof HubFetchError) {
    const body: any = (e as any).body
    if (e.status === 401 && body?.error === 're_auth_required') {
      return { code: 're_auth_required', message: 'Session too old for sensitive action — request a fresh magic link, then retry.' }
    }
    return { code: 'unknown', message: typeof body?.error === 'string' ? body.error : e.message }
  }
  return { code: 'unknown', message: e instanceof Error ? e.message : 'request failed' }
}

export function useApiKey(token: string | null) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  const fetchKeys = useCallback(async () => {
    if (!token) return
    try {
      const data = await hubFetch<ApiKey[]>(token, '/api/api-keys')
      setKeys(data)
    } catch { /* swallow — caller can retry */ }
    setLoading(false)
  }, [token])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  const generateKey = async (): Promise<ApiKeyOpResult<any>> => {
    if (!token) return { ok: false, code: 'unknown', message: 'not signed in' }
    try {
      const data = await hubFetch<any>(token, '/api/api-keys', { method: 'POST' })
      await fetchKeys()
      return { ok: true, data } // data = { id, name, created_at, key: "remokey_..." }
    } catch (e) {
      return { ok: false, ...classifyError(e) }
    }
  }

  const revokeKey = async (id: string): Promise<ApiKeyOpResult<void>> => {
    if (!token) return { ok: false, code: 'unknown', message: 'not signed in' }
    try {
      await hubFetch(token, `/api/api-keys/${id}`, { method: 'DELETE' })
      await fetchKeys()
      return { ok: true, data: undefined }
    } catch (e) {
      await fetchKeys()
      return { ok: false, ...classifyError(e) }
    }
  }

  const activeKey = keys.find(k => !k.revoked_at) || null

  return { keys, activeKey, loading, generateKey, revokeKey }
}
