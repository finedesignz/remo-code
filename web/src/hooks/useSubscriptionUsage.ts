import { useEffect, useState } from 'react'

export interface UsageWindow {
  utilization: number
  resets_at: string
}

// Phase 18 (R-PTY-17): the programmatic Agent-SDK credit pool — a dollar bucket
// carried additively. Null/absent = pre-claim / unknown empty state.
export interface ProgrammaticCredit {
  used_usd: number
  limit_usd: number
  resets_at: string
  claimed: boolean
}

export interface SubscriptionUsage {
  five_hour: UsageWindow
  seven_day: UsageWindow
  seven_day_opus?: UsageWindow | null
  seven_day_oauth_apps?: UsageWindow | null
  programmatic_credit?: ProgrammaticCredit | null
}

export interface SubscriptionUsageSnapshot {
  usage: SubscriptionUsage
  updated_at: string
}

// Phase 18 (R-PTY-18): the leak-alert WS event the hub broadcasts.
export interface ProgrammaticLeakAlert {
  type: 'programmatic_leak_alert'
  reason: 'drain_without_automation' | 'drain_rate_exceeded'
  delta_usd: number
  used_usd: number
  limit_usd: number
  detected_at: string
}

type Subscribe = (handler: (msg: any) => void) => () => void

/**
 * Pure message reducers — the load-bearing logic of the hooks below, factored
 * out so it is unit-testable WITHOUT a DOM / React render (and without mocking
 * React, which would pollute sibling tests via Bun's process-global mock.module).
 */
export function reduceSubscriptionUsage(msg: any): SubscriptionUsageSnapshot | null {
  if (msg?.type !== 'subscription_usage') return null
  if (!msg.usage || typeof msg.usage !== 'object') return null
  return { usage: msg.usage, updated_at: msg.updated_at }
}

export function reduceProgrammaticLeakAlert(msg: any): ProgrammaticLeakAlert | null {
  if (msg?.type !== 'programmatic_leak_alert') return null
  return {
    type: 'programmatic_leak_alert',
    reason: msg.reason,
    delta_usd: msg.delta_usd,
    used_usd: msg.used_usd,
    limit_usd: msg.limit_usd,
    detected_at: msg.detected_at,
  }
}

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
      const next = reduceSubscriptionUsage(msg)
      if (next) setSnap(next)
    })
  }, [subscribe])

  return snap
}

/**
 * Phase 18 — subscribe to `programmatic_leak_alert` WS events. Returns the most
 * recent alert (or null). Consumers render a dismissible, non-blocking banner.
 */
export function useProgrammaticLeakAlert(subscribe: Subscribe): {
  alert: ProgrammaticLeakAlert | null
  dismiss: () => void
} {
  const [alert, setAlert] = useState<ProgrammaticLeakAlert | null>(null)

  useEffect(() => {
    return subscribe((msg) => {
      const next = reduceProgrammaticLeakAlert(msg)
      if (next) setAlert(next)
    })
  }, [subscribe])

  return { alert, dismiss: () => setAlert(null) }
}
