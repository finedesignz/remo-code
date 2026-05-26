import { useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'

export type LicenseStatus = 'active' | 'expired' | 'suspended' | 'banned' | 'none' | 'unknown'

export interface LicenseSummary {
  status: LicenseStatus
  license_id?: string | null
  checked_at?: string | null
}

/**
 * Loads license status from `GET /api/profile/license`. If the endpoint is not
 * yet wired on the hub (Plan G/D follow-up), we return `unknown` and the badge
 * is hidden — never block the UI on an absent endpoint.
 */
export function useLicense(token: string | null) {
  const [data, setData] = useState<LicenseSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    const load = async () => {
      try {
        const res = await hubFetch<LicenseSummary>(token, '/api/profile/license')
        if (!cancelled) setData(res)
      } catch (err: any) {
        if (!cancelled) {
          // 404 → endpoint not present yet; keep unknown silently.
          if (err?.status === 404) setData({ status: 'unknown' })
          else if (err?.status === 402) setData({ status: 'expired' })
          else setData({ status: 'unknown' })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    timer = setInterval(load, 5 * 60_000)
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [token])

  return { license: data, loading }
}
