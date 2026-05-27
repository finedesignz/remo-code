/**
 * Revanote annotations dashboard (Phase 08).
 *
 * Lists inbound annotations + their runs. Status filter + force-retry. Mirrors
 * SchedulesPage / ErrorCapturePage shape — same layout primitives, same
 * back-to-chat affordance. Mappings + webhook secret live under
 * Settings → Revanote (see `RevanoteSettings.tsx`).
 */
import { useEffect, useState, useCallback } from 'react'
import { hubFetch } from '../lib/api'

type AnnotationStatus = 'pending' | 'dispatched' | 'resolved' | 'failed' | 'failed_offline'

interface AnnotationRow {
  id: string
  annotation_id_external: string
  page_url: string
  annotation_url: string | null
  comment: string
  status: AnnotationStatus
  skip_reason: string | null
  received_at: string
  dispatched_at: string | null
  resolved_at: string | null
}

interface Props {
  token: string
  onBack: () => void
  subscribe: (handler: (msg: any) => void) => () => void
}

const STATUSES: Array<{ key: 'all' | AnnotationStatus; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'failed', label: 'Failed' },
  { key: 'failed_offline', label: 'Offline' },
]

const STATUS_STYLES: Record<AnnotationStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30',
  dispatched: 'bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30',
  resolved: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
  failed: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30',
  failed_offline: 'bg-gray-500/15 text-gray-300 ring-1 ring-gray-500/30',
}

export function RevanotePage({ token, onBack, subscribe }: Props) {
  const [filter, setFilter] = useState<'all' | AnnotationStatus>('all')
  const [rows, setRows] = useState<AnnotationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = filter === 'all' ? '' : `?status=${filter}`
      const data = await hubFetch<{ annotations: AnnotationRow[] }>(
        token,
        `/api/revanote/annotations${params}`,
      )
      setRows(data.annotations ?? [])
    } catch (err: any) {
      setError(err?.message ?? 'load_failed')
    } finally {
      setLoading(false)
    }
  }, [token, filter])

  useEffect(() => { void refresh() }, [refresh])

  // Live updates: re-fetch when any revanote event arrives.
  useEffect(() => {
    const off = subscribe((msg: any) => {
      if (!msg?.type || typeof msg.type !== 'string') return
      if (!msg.type.startsWith('revanote_')) return
      void refresh()
    })
    return off
  }, [subscribe, refresh])

  async function forceRetry(id: string) {
    setRetrying((s) => new Set(s).add(id))
    try {
      await hubFetch(token, `/api/revanote/annotations/${id}/retry`, { method: 'POST' })
      await refresh()
    } finally {
      setRetrying((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="max-w-5xl mx-auto px-5 py-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-lg font-semibold">Revanote Annotations</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Inbound visual annotations from Revanote that have been routed to your Claude sessions.
            </p>
          </div>
          <button
            onClick={onBack}
            className="text-xs px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/40"
          >
            ← Back
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {STATUSES.map((s) => (
            <button
              key={s.key}
              onClick={() => setFilter(s.key)}
              className={`text-xs px-3 py-1.5 rounded-lg ${
                filter === s.key
                  ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300'
                  : 'bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/40 text-[var(--text-secondary)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {loading && <div className="text-xs text-[var(--text-muted)]">Loading…</div>}
        {error && <div className="text-xs text-red-300">{error}</div>}

        {!loading && !error && rows.length === 0 && (
          <div className="text-xs text-[var(--text-muted)] bg-[var(--bg-secondary)]/60 rounded-xl p-5">
            No annotations yet. Configure your Revanote webhook under Settings → Revanote.
          </div>
        )}

        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="bg-[var(--bg-secondary)]/60 rounded-xl p-4">
              <div className="flex items-start gap-3 justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${STATUS_STYLES[r.status]}`}>
                      {r.status}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {new Date(r.received_at).toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm font-medium truncate">{r.comment}</div>
                  <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">{r.page_url}</div>
                  {r.skip_reason && (
                    <div className="text-xs text-amber-300 mt-1">Reason: {r.skip_reason}</div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {r.annotation_url && (
                    <a
                      href={r.annotation_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-indigo-300 hover:text-indigo-200"
                    >
                      open ↗
                    </a>
                  )}
                  {(r.status === 'failed' || r.status === 'failed_offline') && (
                    <button
                      disabled={retrying.has(r.id)}
                      onClick={() => forceRetry(r.id)}
                      className="text-[10px] px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
                    >
                      {retrying.has(r.id) ? '…' : 'Retry'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
