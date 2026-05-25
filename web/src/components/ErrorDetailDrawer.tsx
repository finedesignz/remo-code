import { useEffect, useState } from 'react'
import { useErrors, type ErrorRow, type DispatchStatus } from '../hooks/useErrors'
import type { ErrorProject } from '../hooks/useErrorProjects'

interface Props {
  token: string
  project: ErrorProject
  subscribe?: (handler: (msg: any) => void) => () => void
  onClose: () => void
}

function statusChip(status: DispatchStatus): { label: string; cls: string } {
  switch (status) {
    case 'dispatched':
      return { label: 'Dispatched', cls: 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30' }
    case 'pending':
      return { label: 'Pending', cls: 'bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30' }
    case 'failed':
      return { label: 'Failed', cls: 'bg-red-500/15 text-red-300 ring-1 ring-red-500/30' }
    case 'deduped':
      return { label: 'Deduped', cls: 'bg-gray-500/15 text-gray-300 ring-1 ring-gray-500/30' }
    case 'rate_limited':
      return { label: 'Rate-limited', cls: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30' }
    case 'cap_exceeded':
      return { label: 'Cap hit', cls: 'bg-orange-500/15 text-orange-300 ring-1 ring-orange-500/30' }
    case 'skipped':
    default:
      return { label: 'Skipped', cls: 'bg-gray-500/15 text-gray-300 ring-1 ring-gray-500/30' }
  }
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function StacktracePreview({ row }: { row: ErrorRow }) {
  const frames = Array.isArray(row.stacktrace_json) ? row.stacktrace_json : []
  if (frames.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">No stacktrace.</p>
  }
  return (
    <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--code-bg)] rounded p-2 overflow-x-auto max-h-72">
      {frames.map((f: any, i: number) => {
        const file = f.filename || f.module || '<anon>'
        const line = f.lineno ?? f.line ?? '?'
        const fn = f.function || '?'
        return `${file}:${line}  in ${fn}\n`
      }).join('')}
    </pre>
  )
}

export function ErrorDetailDrawer({ token, project, subscribe, onClose }: Props) {
  const { errors, loading, hasMore, loadMore, refetch } = useErrors(token, project.id, { subscribe })
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="w-full max-w-xl bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">{project.name}</h2>
            <div className="text-[11px] text-[var(--text-muted)]">
              {errors.length} loaded {hasMore ? '(more available)' : ''}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refetch()}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 transition-colors"
              title="Refresh"
              aria-label="Refresh"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M1 4v-3h3" /><path d="M3.51 11a7 7 0 0 0 12.13-3.5" />
                <path d="M15 12v3h-3" /><path d="M12.49 5a7 7 0 0 0-12.13 3.5" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 transition-colors"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-5 py-3 space-y-2">
          {loading && errors.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-8">Loading…</p>
          )}

          {!loading && errors.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm text-[var(--text-muted)]">No errors captured yet.</p>
              <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                Point a Sentry SDK at this project's DSN — they'll show up here in real time.
              </p>
            </div>
          )}

          {errors.map(row => {
            const isOpen = expanded === row.id
            const chip = statusChip(row.dispatch_status)
            return (
              <div
                key={row.id}
                className="rounded-lg bg-[var(--bg-primary)] hover:bg-[var(--bg-tertiary)]/30 transition-colors"
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : row.id)}
                  className="w-full text-left px-3 py-2.5"
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${chip.cls}`}>
                      {chip.label}
                    </span>
                    <span className="text-xs font-medium text-[var(--text-primary)] truncate flex-1">
                      {row.error_type}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                      {formatTs(row.received_at)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-secondary)] truncate">
                    {truncate(row.error_value || '(no message)', 140)}
                  </div>
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 space-y-2 border-t border-[var(--border-color)] pt-2 mt-0">
                    <div className="text-[11px] text-[var(--text-muted)]">
                      Fingerprint: <code className="text-[var(--text-secondary)] font-mono">{truncate(row.fingerprint, 32)}</code>
                    </div>
                    {row.dispatched_at && (
                      <div className="text-[11px] text-[var(--text-muted)]">
                        Dispatched: {formatTs(row.dispatched_at)}
                      </div>
                    )}
                    {row.skip_reason && (
                      <div className="text-[11px] text-amber-300">
                        Skip reason: {row.skip_reason}
                      </div>
                    )}
                    {row.release && (
                      <div className="text-[11px] text-[var(--text-muted)]">
                        Release: <code className="text-[var(--text-secondary)] font-mono">{row.release}</code>
                      </div>
                    )}
                    <StacktracePreview row={row} />
                  </div>
                )}
              </div>
            )
          })}

          {hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loading}
              className="w-full py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg transition-colors disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
