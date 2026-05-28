import { useEffect, useState } from 'react'
import { useScheduleRuns, type ScheduleRun } from '../hooks/useScheduleRuns'
import type { ScheduledTask } from '../hooks/useSchedules'
import { formatLocalTs } from './SchedulesPage'
import { formatDuration } from '../lib/format'

interface Props {
  token: string
  task: ScheduledTask
  subscribe?: (handler: (msg: any) => void) => () => void
  onClose: () => void
}

type StatusFilter = 'all' | 'success' | 'failure' | 'skipped' | 'running' | 'cancelled'

export function ScheduleRunsDrawer({ token, task, subscribe, onClose }: Props) {
  const { runs, loading, error, hasMore, loadMore, refetch, cancel } = useScheduleRuns(token, task.id, { subscribe })
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')

  // Counts per status (pending grouped under running per existing live logic)
  const counts = {
    all: runs.length,
    success: runs.filter(r => r.status === 'success').length,
    failure: runs.filter(r => r.status === 'failure').length,
    skipped: runs.filter(r => r.status === 'skipped').length,
    running: runs.filter(r => r.status === 'running' || r.status === 'pending').length,
    cancelled: runs.filter(r => r.status === 'cancelled').length,
  }

  const filteredRuns = filter === 'all'
    ? runs
    : filter === 'running'
      ? runs.filter(r => r.status === 'running' || r.status === 'pending')
      : runs.filter(r => r.status === filter)

  // Aggregate stats over loaded runs (not filtered)
  const successCount = counts.success
  const failureCount = counts.failure
  const successDenom = successCount + failureCount
  const successRate = successDenom === 0 ? null : Math.round((successCount / successDenom) * 100)
  const totalCost = runs.reduce((sum, r) => sum + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0)
  const durations = runs.map(r => r.duration_ms).filter((d): d is number => typeof d === 'number')
  const avgDurationMs = durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      {/* Drawer */}
      <div className="w-full max-w-xl bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/95 backdrop-blur-sm">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">{task.name}</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'} shown
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refetch()}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
              title="Refresh"
              aria-label="Refresh"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 6a5 5 0 0 1 8.5-3.5L12 4" />
                <path d="M12 1v3h-3" />
                <path d="M12 8a5 5 0 0 1-8.5 3.5L2 10" />
                <path d="M2 13v-3h3" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
              aria-label="Close"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>

        {runs.length > 0 && (
          <div className="px-5 pt-4 space-y-3">
            {/* Status filter chips */}
            <div className="flex flex-wrap gap-1.5">
              {([
                ['all', 'All', counts.all, true],
                ['success', 'Success', counts.success, true],
                ['failure', 'Failure', counts.failure, true],
                ['skipped', 'Skipped', counts.skipped, counts.skipped > 0],
                ['running', 'Running', counts.running, true],
                ['cancelled', 'Cancelled', counts.cancelled, counts.cancelled > 0],
              ] as Array<[StatusFilter, string, number, boolean]>)
                .filter(([, , , show]) => show)
                .map(([key, label, count]) => {
                  const active = filter === key
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(active && key !== 'all' ? 'all' : key)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                        active
                          ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300'
                          : 'bg-[var(--bg-tertiary)]/40 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/60'
                      }`}
                    >
                      {label} ({count})
                    </button>
                  )
                })}
            </div>

            {/* Summary stats banner */}
            <div className="bg-[var(--bg-primary)]/40 rounded-lg p-3 flex flex-wrap gap-4">
              <div>
                <div className="text-xs text-[var(--text-muted)]">Total</div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">{runs.length} {runs.length === 1 ? 'run' : 'runs'}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted)]">Success rate</div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">{successRate === null ? '—' : `${successRate}%`}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted)]">Total cost</div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">${totalCost >= 0.01 ? totalCost.toFixed(2) : totalCost.toFixed(4)}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--text-muted)]">Avg duration</div>
                <div className="text-sm font-semibold text-[var(--text-primary)]">{formatDuration(avgDurationMs)}</div>
              </div>
            </div>
          </div>
        )}

        <div className="p-5 space-y-2">
          {error && (
            <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-lg p-3 text-sm text-red-300">{error}</div>
          )}
          {loading && runs.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Loading runs...</p>
          ) : runs.length === 0 ? (
            <div className="bg-[var(--bg-primary)]/40 rounded-lg p-5 text-center">
              <p className="text-sm text-[var(--text-muted)]">No runs yet.</p>
              <p className="text-xs text-[var(--text-muted)]/70 mt-1">The first run will appear here once it fires.</p>
            </div>
          ) : (
            <>
              {filteredRuns.length === 0 && (
                <div className="bg-[var(--bg-primary)]/40 rounded-lg p-4 text-center text-xs text-[var(--text-muted)]">
                  No runs match this filter.
                </div>
              )}
              {filteredRuns.map(run => (
                <RunCard
                  key={run.id}
                  run={run}
                  expanded={expandedRun === run.id}
                  onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  onCancel={() => void cancel(run.id)}
                />
              ))}
              {hasMore && (
                <button
                  onClick={() => void loadMore()}
                  disabled={loading}
                  className="w-full px-3 py-2 text-xs text-indigo-300 hover:text-indigo-200 bg-indigo-600/10 hover:bg-indigo-600/20 rounded-lg transition-colors font-medium"
                >
                  {loading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- */

function RunCard({
  run, expanded, onToggle, onCancel,
}: {
  run: ScheduleRun
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
}) {
  const scheduled = run.scheduled_for ? new Date(run.scheduled_for) : null
  const live = run.status === 'running' || run.status === 'pending'

  return (
    <div className="bg-[var(--bg-primary)]/40 rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-2.5 flex items-center gap-3 hover:bg-[var(--bg-tertiary)]/40 transition-colors rounded-lg"
      >
        <RunStatusIcon status={run.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-primary)] truncate">
              {scheduled ? formatLocalTs(scheduled) : '—'}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] font-mono">
              {run.id.slice(0, 8)}
            </span>
          </div>
          <div className="text-xs text-[var(--text-muted)] flex items-center gap-3 mt-0.5">
            <span>{formatDuration(run.duration_ms)}</span>
            {typeof run.cost_usd === 'number' && <span>${run.cost_usd.toFixed(4)}</span>}
            {run.error && <span className="text-red-400 truncate">{run.error}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {live && (
            <button
              onClick={(e) => { e.stopPropagation(); onCancel() }}
              title="Cancel run"
              aria-label="Cancel run"
              className="p-1.5 text-[var(--text-muted)] hover:text-red-400 rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <rect x="3" y="3" width="6" height="6" rx="1" />
              </svg>
            </button>
          )}
          <svg
            width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            className={`text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Status</div>
              <div className="text-[var(--text-secondary)] capitalize">{run.status}</div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Started</div>
              <div className="text-[var(--text-secondary)]">{run.started_at ? formatLocalTs(new Date(run.started_at)) : '—'}</div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Finished</div>
              <div className="text-[var(--text-secondary)]">{run.finished_at ? formatLocalTs(new Date(run.finished_at)) : '—'}</div>
            </div>
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Cost</div>
              <div className="text-[var(--text-secondary)]">{typeof run.cost_usd === 'number' ? `$${run.cost_usd.toFixed(4)}` : '—'}</div>
            </div>
          </div>
          {run.output_snippet && (
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px] mb-1">Output</div>
              <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-[11px] text-[var(--text-secondary)] overflow-x-auto whitespace-pre-wrap">
                {run.output_snippet}
              </pre>
            </div>
          )}
          {run.error && (
            <div>
              <div className="text-[var(--text-muted)] uppercase tracking-wider text-[10px] mb-1">Error</div>
              <pre className="bg-red-500/10 ring-1 ring-red-500/20 rounded-lg p-3 text-[11px] text-red-300 overflow-x-auto whitespace-pre-wrap">
                {run.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RunStatusIcon({ status }: { status: ScheduleRun['status'] }) {
  const base = 'w-2.5 h-2.5 rounded-full shrink-0'
  switch (status) {
    case 'success': return <span className={`${base} bg-emerald-400`} title="success" />
    case 'failure': return <span className={`${base} bg-red-400`} title="failed" />
    case 'skipped': return <span className={`${base} bg-amber-400`} title="skipped" />
    case 'cancelled': return <span className={`${base} bg-gray-500`} title="cancelled" />
    case 'running': return <span className={`${base} bg-indigo-400 animate-pulse`} title="running" />
    case 'pending': return <span className={`${base} bg-gray-500`} title="pending" />
    default: return <span className={`${base} bg-gray-500`} />
  }
}

