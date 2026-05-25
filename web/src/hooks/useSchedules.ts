import { useCallback, useEffect, useState } from 'react'
import { hubFetch, HubFetchError } from '../lib/api'

export type TaskType = 'prompt' | 'skill' | 'security_scan' | 'log_check' | 'continue_dev'
export type TargetKind = 'session' | 'supervisor' | 'all_agents' | 'all_supervisors'
export type CatchupPolicy = 'skip' | 'run_once'

export type PostRunActionType =
  | 'chain_task'
  | 'notify_email'
  | 'notify_telegram'
  | 'notify_web_push'
  | 'webhook'

export type PostRunActionOn = 'success' | 'failure' | 'always' | 'cost_exceeded'

export interface PostRunAction {
  type: PostRunActionType
  on: PostRunActionOn
  delay_seconds?: number
  // type-specific config — kept loose for forward compat
  config: Record<string, any>
}

export interface ScheduledTask {
  id: string
  name: string
  task_type: TaskType
  target_kind: TargetKind
  target_id: string | null
  payload: Record<string, any>
  cron_expr: string
  timezone: string
  catchup_policy: CatchupPolicy
  max_concurrent: number
  enabled: boolean
  post_run_actions: PostRunAction[]
  last_fire_at: string | null
  next_fire_at: string | null
  next_3_runs: string[]
  last_run_status?: 'success' | 'failure' | 'skipped' | 'pending' | 'running' | null
  last_run_cost_usd?: number | null
  last_run_duration_ms?: number | null
  created_at?: string
}

export interface ScheduleCreateInput {
  name: string
  task_type: TaskType
  target_kind: TargetKind
  target_id?: string | null
  payload?: Record<string, any>
  cron_expr: string
  timezone: string
  catchup_policy?: CatchupPolicy
  max_concurrent?: number
  enabled?: boolean
  post_run_actions?: PostRunAction[]
}

export type SchedulePatch = Partial<ScheduleCreateInput>

export interface UseSchedules {
  schedules: ScheduledTask[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  create: (input: ScheduleCreateInput) => Promise<ScheduledTask>
  update: (id: string, patch: SchedulePatch) => Promise<ScheduledTask>
  remove: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  runNow: (id: string) => Promise<{ run_ids: string[] } | null>
}

export function useSchedules(token: string | null): UseSchedules {
  const [schedules, setSchedules] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const data = await hubFetch<ScheduledTask[] | { tasks: ScheduledTask[] }>(token, '/api/scheduled-tasks')
      const list = Array.isArray(data) ? data : Array.isArray((data as any)?.tasks) ? (data as any).tasks : []
      setSchedules(list)
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'failed to load schedules')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void refetch() }, [refetch])

  const create = useCallback(async (input: ScheduleCreateInput) => {
    if (!token) throw new Error('no token')
    const task = await hubFetch<ScheduledTask>(token, '/api/scheduled-tasks', {
      method: 'POST',
      json: input,
    })
    setSchedules(prev => [task, ...prev])
    return task
  }, [token])

  const update = useCallback(async (id: string, patch: SchedulePatch) => {
    if (!token) throw new Error('no token')
    const task = await hubFetch<ScheduledTask>(token, `/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      json: patch,
    })
    setSchedules(prev => prev.map(s => s.id === id ? task : s))
    return task
  }, [token])

  const remove = useCallback(async (id: string) => {
    if (!token) return
    await hubFetch(token, `/api/scheduled-tasks/${id}`, { method: 'DELETE', raw: true })
    setSchedules(prev => prev.filter(s => s.id !== id))
  }, [token])

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    if (!token) return
    // Optimistic flip — revert on error.
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled } : s))
    try {
      const task = await hubFetch<ScheduledTask>(token, `/api/scheduled-tasks/${id}`, {
        method: 'PATCH',
        json: { enabled },
      })
      setSchedules(prev => prev.map(s => s.id === id ? task : s))
    } catch (e) {
      // Revert
      setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled: !enabled } : s))
      throw e
    }
  }, [token])

  const runNow = useCallback(async (id: string) => {
    if (!token) return null
    try {
      const res = await hubFetch<{ run_ids: string[] }>(token, `/api/scheduled-tasks/${id}/run-now`, {
        method: 'POST',
      })
      return res
    } catch (e) {
      if (e instanceof HubFetchError) {
        setError(e.message)
      }
      throw e
    }
  }, [token])

  return { schedules, loading, error, refetch, create, update, remove, toggle, runNow }
}
