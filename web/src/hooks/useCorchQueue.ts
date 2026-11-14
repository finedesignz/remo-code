import { useCallback, useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'

// CORCH-11 (R6.1): the central-orchestrator queue. One GET on mount for the first paint, then ONLY the hub's
// `corch_queue` WebSocket event (broadcastToUser on every transition). No timers anywhere in this hook.

export interface CorchQueueItem {
  id: string
  project_id: string
  repo_ident: string
  title: string
  source: string
  priority: number
  status: 'queued' | 'running' | 'pr_open' | 'done' | 'blocked' | 'cancelled'
  wait_reason: string | null
  not_before: string | null
  attempts: number
  pr_url: string | null
  created_at: string
}

export interface CorchQueueRun {
  id: string
  work_item_id: string
  repo_ident: string
  status: 'launching' | 'running' | 'stalled' | 'ended'
  account_slot: string | null
  supervisor_id: string | null
  started_at: string
  heartbeat_at: string
  age_seconds: number
}

export interface CorchQuotaAccount {
  account_id: string
  slot: string | null
  eligible: boolean
  reason: string | null
  not_before: string | null
  five_h_pct: number | null
  seven_d_pct: number | null
}

export interface CorchQueue {
  paused: boolean
  max_concurrent_runs: number
  projects: Array<{ id: string; repo_ident: string; priority: number; enabled: boolean; aaf_provision_status: string }>
  items: CorchQueueItem[]
  live_runs: CorchQueueRun[]
  quota_accounts: CorchQuotaAccount[]
  generated_at: string
}

type Subscribe = (handler: (msg: any) => void) => () => void

/** Pure reducer: the load-bearing logic, unit-testable without a DOM. */
export function reduceCorchQueue(msg: any): CorchQueue | null {
  if (msg?.type !== 'corch_queue') return null
  const q = msg.queue
  if (!q || typeof q !== 'object' || !Array.isArray(q.items) || !Array.isArray(q.live_runs)) return null
  return q as CorchQueue
}

export interface CorchQueueActions {
  setPaused(paused: boolean): Promise<void>
  setPriority(itemId: string, priority: number): Promise<void>
  cancel(itemId: string): Promise<void>
}

export function useCorchQueue(token: string, subscribe: Subscribe): {
  queue: CorchQueue | null
  error: string | null
  actions: CorchQueueActions
} {
  const [queue, setQueue] = useState<CorchQueue | null>(null)
  const [error, setError] = useState<string | null>(null)

  // One read for the first paint and one after each authenticated (re)connect: events missed while the socket was
  // down are not replayed. Both are driven by events, never a timer. A fetched snapshot never replaces a newer one.
  const load = useCallback(() => {
    hubFetch<CorchQueue>(token, '/api/corch/queue')
      .then((q) => setQueue((cur) => (cur && cur.generated_at > q.generated_at ? cur : q)))
      .catch((e: any) => setError(e?.message || 'Failed to load queue'))
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  useEffect(
    () =>
      subscribe((msg) => {
        if (msg?.type === 'auth_ok') {
          load()
          return
        }
        const q = reduceCorchQueue(msg)
        if (q) {
          setQueue(q)
          setError(null)
        }
      }),
    [subscribe, load],
  )

  const run = useCallback(
    async (path: string, method: string, json?: unknown) => {
      try {
        await hubFetch(token, path, { method, json })
        setError(null)
      } catch (e: any) {
        setError(e?.message || 'Request failed')
      }
      // The new state arrives over the WebSocket; nothing is re-fetched or polled here.
    },
    [token],
  )

  const actions: CorchQueueActions = {
    setPaused: (paused) => run('/api/corch/settings', 'PATCH', { paused }),
    setPriority: (id, priority) => run(`/api/corch/work-items/${id}`, 'PATCH', { priority }),
    cancel: (id) => run(`/api/corch/work-items/${id}/cancel`, 'POST'),
  }
  return { queue, error, actions }
}
