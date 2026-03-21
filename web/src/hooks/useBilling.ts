import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface Subscription {
  status: string
  current_period_end: string
  cancel_at_period_end: boolean
}

export function useBilling(session: Session | null) {
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSubscription = useCallback(async () => {
    if (!session?.access_token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    try {
      const res = await fetch(`${hubUrl}/api/billing/subscription`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setSubscription(data.subscription)
      }
    } catch {
      // ignore
    }
    setLoading(false)
  }, [session?.access_token])

  useEffect(() => { fetchSubscription() }, [fetchSubscription])

  const checkout = useCallback(async (tier: string) => {
    if (!session?.access_token) return null
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ tier }),
    })
    if (res.ok) {
      const data = await res.json()
      return data.url as string
    }
    return null
  }, [session?.access_token])

  const openPortal = useCallback(async () => {
    if (!session?.access_token) return
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    const res = await fetch(`${hubUrl}/api/billing/portal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      const data = await res.json()
      window.open(data.url, '_blank')
    }
  }, [session?.access_token])

  return { subscription, loading, fetchSubscription, checkout, openPortal }
}
