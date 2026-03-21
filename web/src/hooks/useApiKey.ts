import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

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
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/api-keys`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) setKeys(await res.json())
    setLoading(false)
  }, [session?.access_token])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  const generateKey = async () => {
    if (!session?.access_token) return null
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/api-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      const data = await res.json()
      await fetchKeys()
      return data // { id, name, created_at, key: "remokey_..." }
    }
    return null
  }

  const revokeKey = async (id: string) => {
    if (!session?.access_token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    await fetch(`${hubUrl}/api/api-keys/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    await fetchKeys()
  }

  const activeKey = keys.find(k => !k.revoked_at) || null

  return { keys, activeKey, loading, generateKey, revokeKey }
}
