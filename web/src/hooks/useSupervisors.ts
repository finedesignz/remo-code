import { useCallback, useEffect, useRef, useState } from 'react'
import { hubFetch } from '../lib/api'

export interface SupervisorRow {
  id: string
  hostname: string | null
  version: string | null
  os: string | null
  roots: string[] | null
  state: string
  current_run_id: string | null
  last_seen_at: string | null
  created_at?: string
  online: boolean
}

type Subscribe = (handler: (msg: any) => void) => () => void

/**
 * Reactive supervisors list. Loads from GET /api/supervisors on mount and on
 * `connectionId` change (re-fetch after WS reconnect), then subscribes to
 * `supervisor_update` and `supervisor_capacity_changed` WS broadcasts. Each
 * event triggers a debounced refetch so the row's `online`, `state`,
 * `last_seen_at`, hostname, version, os, and roots all stay current without
 * the previous 10s polling loop.
 *
 * Why a refetch instead of patching in-place from the event payload? The hub
 * broadcasts a minimal `{supervisor_id, state, ...}` patch. Roots and online
 * status are derived server-side from the in-memory registry, and the user
 * also expects roots-editor saves and stale-row reaps to show up. One round
 * trip on each event is simpler and correct — supervisor reconnects are not
 * high-frequency.
 */
export function useSupervisors(token: string | null, subscribe: Subscribe, connectionId: number) {
  const [supervisors, setSupervisors] = useState<SupervisorRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const res = await hubFetch<{ supervisors: SupervisorRow[] } | SupervisorRow[]>(
        token,
        '/api/supervisors',
      )
      const rows = Array.isArray(res) ? res : (res?.supervisors ?? [])
      setSupervisors(rows)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'Failed to load supervisors')
    }
  }, [token])

  // Initial fetch + refetch on WS (re)auth so post-reconnect state is correct
  // even if we missed events while disconnected.
  useEffect(() => {
    void load()
  }, [load, connectionId])

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current) return
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null
      void load()
    }, 150)
  }, [load])

  useEffect(() => {
    return subscribe((msg) => {
      if (!msg || typeof msg.type !== 'string') return
      if (msg.type === 'supervisor_update' || msg.type === 'supervisor_capacity_changed') {
        // Fast path: patch `state` / `current_run_id` directly so the row
        // visibly transitions even before the refetch lands.
        if (msg.type === 'supervisor_update' && typeof msg.supervisor_id === 'string') {
          setSupervisors((prev) => {
            if (!prev) return prev
            return prev.map((s) =>
              s.id === msg.supervisor_id
                ? {
                    ...s,
                    state: typeof msg.state === 'string' ? msg.state : s.state,
                    current_run_id:
                      msg.current_run_id !== undefined ? msg.current_run_id : s.current_run_id,
                    online: msg.state !== 'offline',
                    hostname:
                      typeof msg.hostname === 'string' ? msg.hostname : s.hostname,
                    version: msg.version !== undefined ? msg.version : s.version,
                    os: msg.os !== undefined ? msg.os : s.os,
                    roots: Array.isArray(msg.roots) ? msg.roots : s.roots,
                  }
                : s,
            )
          })
        }
        scheduleRefetch()
      }
    })
  }, [subscribe, scheduleRefetch])

  useEffect(() => () => {
    if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current)
  }, [])

  return { supervisors, error, refetch: load }
}
