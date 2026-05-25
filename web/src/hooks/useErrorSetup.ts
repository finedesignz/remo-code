import { useCallback, useState } from 'react'
import { hubFetch, HubFetchError } from '../lib/api'

export interface ErrorSetupOpts {
  supervisor_id: string
  repo_path: string
  coolify_app_uuid?: string
  redeploy?: boolean
}

export interface ErrorSetupResult {
  ok: boolean
  alreadyConfigured?: boolean
  stack: 'node-express' | 'node-nextjs' | 'python-fastapi' | 'python-django'
  dsn: string
  entry_file: string
  manifest_file: string
  commit_pushed?: boolean
  supervisor_error?: string | null
  coolify_env_set?: boolean | null
  coolify_env_error?: string | null
  redeployed?: boolean | null
  redeploy_error?: string | null
}

export interface ErrorSetupErrorBody {
  error: string
  tried?: string[]
  missing?: string[]
  hint?: string
  detail?: string
}

export interface UseErrorSetup {
  loading: boolean
  result: ErrorSetupResult | null
  error: ErrorSetupErrorBody | null
  run: (projectId: string, opts: ErrorSetupOpts) => Promise<ErrorSetupResult | null>
  reset: () => void
}

export function useErrorSetup(token: string | null): UseErrorSetup {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ErrorSetupResult | null>(null)
  const [error, setError] = useState<ErrorSetupErrorBody | null>(null)

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  const run = useCallback(async (projectId: string, opts: ErrorSetupOpts) => {
    if (!token) {
      setError({ error: 'not_authenticated' })
      return null
    }
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await hubFetch<ErrorSetupResult>(token, `/api/error-setup/${projectId}`, {
        method: 'POST',
        json: opts,
      })
      setResult(res)
      return res
    } catch (err) {
      if (err instanceof HubFetchError) {
        const body = (err.body as ErrorSetupErrorBody) ?? { error: err.message }
        setError(body)
      } else {
        setError({ error: (err as Error)?.message ?? 'unknown_error' })
      }
      return null
    } finally {
      setLoading(false)
    }
  }, [token])

  return { loading, result, error, run, reset }
}
