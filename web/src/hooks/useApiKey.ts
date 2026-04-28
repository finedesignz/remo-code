import { useState, useEffect, useCallback } from 'react'

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
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) setKeys(await res.json())
    setLoading(false)
  }, [token])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  const generateKey = async () => {
    if (!token) return null
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/api-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      const data = await res.json()
      await fetchKeys()
      return data // { id, name, created_at, key: "remokey_..." }
    }
    return null
  }

  const revokeKey = async (id: string) => {
    if (!token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    await fetch(`${hubUrl}/api/api-keys/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await fetchKeys()
  }

  const activeKey = keys.find(k => !k.revoked_at) || null

  return { keys, activeKey, loading, generateKey, revokeKey }
}
