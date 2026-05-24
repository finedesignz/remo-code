import { useCallback, useEffect, useRef, useState } from 'react'
import { hubFetch } from '../lib/api'

export type RunStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled'

export interface ScheduleRun {
  id: string
  task_id: string
  status: RunStatus
  scheduled_for: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  cost_usd: number | null
  output_snippet: string | null
  error: string | null
  target_kind?: string
  target_id?: string | null
  session_id?: string | null
  supervisor_id?: string | null
}

interface Options {
  limit?: number
  subscribe?: (handler: (msg: any) => void) => () => void
}

export interface UseScheduleRuns {
  runs: ScheduleRun[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => Promise<void>
  refetch: () => Promise<void>
  cancel: (runId: string) => Promise<void>
}

export function useScheduleRuns(
  token: string | null,
  taskId: string | null,
  opts: Options = {},
): UseScheduleRuns {
  const { limit = 20, subscribe } = opts
  const [runs, setRuns] = useState<ScheduleRun[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const oldestRef = useRef<string | null>(null)

  const fetchPage = useCallback(async (before?: string) => {
    if (!token || !taskId) return
    setLoading(true)
    try {
      const qs = new URLSearchParams({ task_id: taskId, limit: String(limit) })
      if (before) qs.set('before', before)
      const data = await hubFetch<ScheduleRun[] | { runs: ScheduleRun[] }>(token, `/api/scheduled-task-runs?${qs}`)
      const list = Array.isArray(data) ? data : Array.isArray((data as any)?.runs) ? (data as any).runs : []
      setHasMore(list.length === limit)
      if (list.length > 0) {
        oldestRef.current = list[list.length - 1].scheduled_for
      }
      setRuns(prev => before ? [...prev, ...list] : list)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'failed to load runs')
    } finally {
      setLoading(false)
    }
  }, [token, taskId, limit])

  // Initial + taskId change
  useEffect(() => {
    if (!taskId) {
      setRuns([])
      oldestRef.current = null
      setHasMore(false)
      return
    }
    void fetchPage()
  }, [taskId, fetchPage])

  // WS subscription — merge live updates
  useEffect(() => {
    if (!subscribe || !taskId) return
    return subscribe((msg: any) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.task_id && msg.task_id !== taskId) return

      if (msg.type === 'scheduled_run_started') {
        const incoming: ScheduleRun = {
          id: msg.run_id,
          task_id: msg.task_id,
          status: 'running',
          scheduled_for: msg.scheduled_for || new Date().toISOString(),
          started_at: msg.started_at || new Date().toISOString(),
          finished_at: null,
          duration_ms: null,
          cost_usd: null,
          output_snippet: null,
          error: null,
          target_kind: msg.target_kind,
          target_id: msg.target_id,
          session_id: msg.session_id,
          supervisor_id: msg.supervisor_id,
        }
        setRuns(prev => {
          if (prev.some(r => r.id === incoming.id)) {
            return prev.map(r => r.id === incoming.id ? { ...r, ...incoming } : r)
          }
          return [incoming, ...prev]
        })
        return
      }

      if (msg.type === 'scheduled_run_progress') {
        setRuns(prev => prev.map(r => r.id === msg.run_id ? {
          ...r,
          status: 'running',
          output_snippet: msg.output_snippet ?? r.output_snippet,
        } : r))
        return
      }

      if (msg.type === 'scheduled_run_finished') {
        setRuns(prev => prev.map(r => r.id === msg.run_id ? {
          ...r,
          status: msg.status || 'success',
          finished_at: msg.finished_at || new Date().toISOString(),
          duration_ms: msg.duration_ms ?? r.duration_ms,
          cost_usd: msg.cost_usd ?? r.cost_usd,
          output_snippet: msg.output_snippet ?? r.output_snippet,
          error: msg.error ?? r.error,
        } : r))
        return
      }
    })
  }, [subscribe, taskId])

  const loadMore = useCallback(async () => {
    if (!hasMore || !oldestRef.current) return
    await fetchPage(oldestRef.current)
  }, [hasMore, fetchPage])

  const refetch = useCallback(async () => {
    oldestRef.current = null
    await fetchPage()
  }, [fetchPage])

  const cancel = useCallback(async (runId: string) => {
    if (!token) return
    try {
      await hubFetch(token, `/api/scheduled-task-runs/${runId}/cancel`, { method: 'POST', raw: true })
      setRuns(prev => prev.map(r => r.id === runId ? { ...r, status: 'cancelled' } : r))
    } catch (e: any) {
      setError(e?.message || 'cancel failed')
    }
  }, [token])

  return { runs, loading, error, hasMore, loadMore, refetch, cancel }
}
