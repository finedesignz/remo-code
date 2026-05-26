import { useEffect, useState } from 'react'

export interface UsageWindow {
  utilization: number
  resets_at: string
}

export interface SubscriptionUsage {
  five_hour: UsageWindow
  seven_day: UsageWindow
  seven_day_opus?: UsageWindow | null
  seven_day_oauth_apps?: UsageWindow | null
}

export interface SubscriptionUsageSnapshot {
  usage: SubscriptionUsage
  updated_at: string
}

type Subscribe = (handler: (msg: any) => void) => () => void

/**
 * Subscribe to the hub's `subscription_usage` WS broadcasts. The hub sends
 * one immediately on client auth if any agent has already reported, and
 * pushes a fresh snapshot every 5 minutes thereafter from any connected
 * agent. Returns `null` until the first snapshot arrives.
 */
export function useSubscriptionUsage(subscribe: Subscribe): SubscriptionUsageSnapshot | null {
  const [snap, setSnap] = useState<SubscriptionUsageSnapshot | null>(null)

  useEffect(() => {
    return subscribe((msg) => {
      if (msg?.type !== 'subscription_usage') return
      if (!msg.usage || typeof msg.usage !== 'object') return
      setSnap({ usage: msg.usage, updated_at: msg.updated_at })
    })
  }, [subscribe])

  return snap
}
