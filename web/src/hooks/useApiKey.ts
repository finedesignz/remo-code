import { useState, useEffect, useCallback } from 'react'
import { hubFetch } from '../lib/api'

export interface ApiKey {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
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

  const generateKey = async () => {
    if (!token) return null
    try {
      const data = await hubFetch<any>(token, '/api/api-keys', { method: 'POST' })
      await fetchKeys()
      return data // { id, name, created_at, key: "remokey_..." }
    } catch {
      return null
    }
  }

  const revokeKey = async (id: string) => {
    if (!token) return
    try { await hubFetch(token, `/api/api-keys/${id}`, { method: 'DELETE' }) } catch {}
    await fetchKeys()
  }

  const activeKey = keys.find(k => !k.revoked_at) || null

  return { keys, activeKey, loading, generateKey, revokeKey }
}
