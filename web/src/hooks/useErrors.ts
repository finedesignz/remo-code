import { useCallback, useEffect, useRef, useState } from 'react'
import { hubFetch } from '../lib/api'

export type DispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'skipped'
  | 'failed'
  | 'deduped'
  | 'rate_limited'
  | 'cap_exceeded'

export interface ErrorRow {
  id: string
  project_id: string
  fingerprint: string
  error_type: string
  error_value: string
  stacktrace_json: any
  release: string | null
  received_at: string
  dispatch_status: DispatchStatus
  dispatched_at: string | null
  skip_reason: string | null
}

/**
 * Local TS stub for the W3 WS events. Wave 3 lands the actual Zod schemas
 * in `hub/src/ws/protocol.ts`; until merged, we type the live-update payloads
 * here so this hook compiles + behaves correctly at runtime.
 */
type ErrorReceivedMsg = {
  type: 'error_received'
  error_id: string
  project_id: string
  fingerprint: string
  received_at: string
  error_type?: string
  error_value?: string
  dispatch_status?: DispatchStatus
}
type ErrorDispatchedMsg = {
  type: 'error_dispatched'
  error_id: string
  project_id: string
  run_id: string
  dispatched_at: string
}
type ErrorRunFinishedMsg = {
  type: 'error_run_finished'
  error_id: string
  project_id: string
  run_id: string
  status: 'success' | 'failed' | 'cancelled' | 'skipped'
  output_snippet?: string
  cost_usd?: number
  duration_ms?: number
  error?: string
  finished_at: string
}
type ErrorSkippedMsg = {
  type: 'error_skipped'
  error_id: string
  project_id: string
  dispatch_status: DispatchStatus
  skip_reason: string
}
type ErrorWsMsg = ErrorReceivedMsg | ErrorDispatchedMsg | ErrorRunFinishedMsg | ErrorSkippedMsg

interface Options {
  limit?: number
  subscribe?: (handler: (msg: any) => void) => () => void
}

export interface UseErrors {
  errors: ErrorRow[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => Promise<void>
  refetch: () => Promise<void>
}

export function useErrors(
  token: string | null,
  projectId: string | null,
  opts: Options = {},
): UseErrors {
  const { limit = 30, subscribe } = opts
  const [errors, setErrors] = useState<ErrorRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const oldestRef = useRef<string | null>(null)

  const fetchPage = useCallback(async (before?: string) => {
    if (!token || !projectId) return
    setLoading(true)
    try {
      const qs = new URLSearchParams({ project_id: projectId, limit: String(limit) })
      if (before) qs.set('before', before)
      const data = await hubFetch<{ errors: ErrorRow[] }>(token, `/api/errors?${qs}`)
      const list = Array.isArray(data?.errors) ? data.errors : []
      setHasMore(list.length === limit)
      if (list.length > 0) {
        oldestRef.current = list[list.length - 1].received_at
      }
      setErrors(prev => before ? [...prev, ...list] : list)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'failed to load errors')
    } finally {
      setLoading(false)
    }
  }, [token, projectId, limit])

  useEffect(() => {
    if (!projectId) {
      setErrors([])
      oldestRef.current = null
      setHasMore(false)
      return
    }
    void fetchPage()
  }, [projectId, fetchPage])

  // WS live merge
  useEffect(() => {
    if (!subscribe || !projectId) return
    return subscribe((raw: any) => {
      const msg = raw as ErrorWsMsg
      if (!msg || typeof msg !== 'object') return
      if ((msg as any).project_id && (msg as any).project_id !== projectId) return

      if (msg.type === 'error_received') {
        setErrors(prev => {
          if (prev.some(e => e.id === msg.error_id)) return prev
          const fresh: ErrorRow = {
            id: msg.error_id,
            project_id: msg.project_id,
            fingerprint: msg.fingerprint,
            error_type: msg.error_type ?? 'Error',
            error_value: msg.error_value ?? '',
            stacktrace_json: null,
            release: null,
            received_at: msg.received_at,
            dispatch_status: msg.dispatch_status ?? 'pending',
            dispatched_at: null,
            skip_reason: null,
          }
          return [fresh, ...prev]
        })
        return
      }

      if (msg.type === 'error_dispatched') {
        setErrors(prev => prev.map(e => e.id === msg.error_id ? {
          ...e,
          dispatch_status: 'dispatched',
          dispatched_at: msg.dispatched_at,
        } : e))
        return
      }

      if (msg.type === 'error_skipped') {
        setErrors(prev => prev.map(e => e.id === msg.error_id ? {
          ...e,
          dispatch_status: msg.dispatch_status,
          skip_reason: msg.skip_reason,
        } : e))
        return
      }

      if (msg.type === 'error_run_finished') {
        // Run-level event — for now we only mark dispatch_status if the run
        // failed and the error wasn't already marked.
        if (msg.status === 'failed') {
          setErrors(prev => prev.map(e => e.id === msg.error_id && e.dispatch_status === 'dispatched'
            ? { ...e, dispatch_status: 'failed' }
            : e))
        }
        return
      }
    })
  }, [subscribe, projectId])

  const loadMore = useCallback(async () => {
    if (!hasMore || !oldestRef.current) return
    await fetchPage(oldestRef.current)
  }, [hasMore, fetchPage])

  const refetch = useCallback(async () => {
    oldestRef.current = null
    await fetchPage()
  }, [fetchPage])

  return { errors, loading, error, hasMore, loadMore, refetch }
}
