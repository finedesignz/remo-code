import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'
import { hubFetch } from '../lib/api'

export interface ApiKey {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export function useApiKey(session: Session | null) {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)

  const fetchKeys = useCallback(async () => {
    if (!session?.access_token) return
    const res = await hubFetch('/api/api-keys', session.access_token)
    if (res.ok) setKeys(await res.json())
    setLoading(false)
  }, [session?.access_token])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  const generateKey = useCallback(async () => {
    if (!session?.access_token) return null
    const res = await hubFetch('/api/api-keys', session.access_token, { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      await fetchKeys()
      return data
    }
    return null
  }, [session?.access_token, fetchKeys])

  const revokeKey = useCallback(async (id: string) => {
    if (!session?.access_token) return
    await hubFetch(`/api/api-keys/${id}`, session.access_token, { method: 'DELETE' })
    await fetchKeys()
  }, [session?.access_token, fetchKeys])

  const activeKey = keys.find(k => !k.revoked_at) || null

  return { keys, activeKey, loading, generateKey, revokeKey }
}
