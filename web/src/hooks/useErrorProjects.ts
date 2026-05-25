import { useCallback, useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'

export interface ErrorProject {
  id: string
  user_id: string
  name: string
  sentry_key: string
  session_id: string
  dedupe_window_seconds: number
  rate_limit_per_hour: number
  daily_dispatch_cap: number
  enabled: boolean
  created_at: string
  updated_at: string
  /** Server-computed: https://<sentry_key>@<host>/<project_id>. */
  dsn: string
}

export interface ErrorProjectCreateInput {
  name: string
  session_id: string
  dedupe_window_seconds?: number
  rate_limit_per_hour?: number
  daily_dispatch_cap?: number
  enabled?: boolean
}

export type ErrorProjectPatch = Partial<ErrorProjectCreateInput>

export interface UseErrorProjects {
  projects: ErrorProject[]
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
  create: (input: ErrorProjectCreateInput) => Promise<ErrorProject>
  update: (id: string, patch: ErrorProjectPatch) => Promise<ErrorProject>
  remove: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
}

export function useErrorProjects(token: string | null): UseErrorProjects {
  const [projects, setProjects] = useState<ErrorProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const data = await hubFetch<{ projects: ErrorProject[] }>(token, '/api/error-projects')
      setProjects(Array.isArray(data?.projects) ? data.projects : [])
      setError(null)
    } catch (e: any) {
      setError(e?.message || 'failed to load error projects')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void refetch() }, [refetch])

  const create = useCallback(async (input: ErrorProjectCreateInput) => {
    if (!token) throw new Error('no token')
    const p = await hubFetch<ErrorProject>(token, '/api/error-projects', {
      method: 'POST',
      json: input,
    })
    setProjects(prev => [p, ...prev])
    return p
  }, [token])

  const update = useCallback(async (id: string, patch: ErrorProjectPatch) => {
    if (!token) throw new Error('no token')
    const p = await hubFetch<ErrorProject>(token, `/api/error-projects/${id}`, {
      method: 'PATCH',
      json: patch,
    })
    setProjects(prev => prev.map(x => x.id === id ? p : x))
    return p
  }, [token])

  const remove = useCallback(async (id: string) => {
    if (!token) return
    await hubFetch(token, `/api/error-projects/${id}`, { method: 'DELETE', raw: true })
    setProjects(prev => prev.filter(x => x.id !== id))
  }, [token])

  const toggle = useCallback(async (id: string, enabled: boolean) => {
    if (!token) return
    setProjects(prev => prev.map(x => x.id === id ? { ...x, enabled } : x))
    try {
      const p = await hubFetch<ErrorProject>(token, `/api/error-projects/${id}`, {
        method: 'PATCH',
        json: { enabled },
      })
      setProjects(prev => prev.map(x => x.id === id ? p : x))
    } catch (e) {
      setProjects(prev => prev.map(x => x.id === id ? { ...x, enabled: !enabled } : x))
      throw e
    }
  }, [token])

  return { projects, loading, error, refetch, create, update, remove, toggle }
}
