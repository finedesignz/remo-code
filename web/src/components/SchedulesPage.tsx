import { useMemo, useState } from 'react'
import { useSchedules, type ScheduledTask } from '../hooks/useSchedules'
import { ScheduleEditor } from './ScheduleEditor'
import { ScheduleRunsDrawer } from './ScheduleRunsDrawer'
import { humanizeCron } from '../lib/cron-humanize'
import { formatCostUsd, formatDuration, formatRelativeAgo } from '../lib/format'

interface Props {
  token: string
  onBack?: () => void
  /** Subscribe to WS for live run updates inside drawer. Optional. */
  subscribe?: (handler: (msg: any) => void) => () => void
}

type StatusFilter = 'all' | 'enabled' | 'disabled'
type TypeFilter = 'all' | ScheduledTask['task_type']

export function SchedulesPage({ token, onBack, subscribe }: Props) {
  const { schedules, loading, error, create, update, remove, toggle, runNow, refetch } = useSchedules(token)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ScheduledTask | null>(null)
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')

  const filteredSchedules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return schedules.filter(s => {
      if (q && !s.name.toLowerCase().includes(q)) return false
      if (statusFilter === 'enabled' && s.enabled !== true) return false
      if (statusFilter === 'disabled' && s.enabled !== false) return false
      if (typeFilter !== 'all' && s.task_type !== typeFilter) return false
      return true
    })
  }, [schedules, searchQuery, statusFilter, typeFilter])

  const clearFilters = () => {
    setSearchQuery('')
    setStatusFilter('all')
    setTypeFilter('all')
  }

  const handleNew = () => { setEditing(null); setEditorOpen(true) }
  const handleEdit = (s: ScheduledTask) => { setEditing(s); setEditorOpen(true) }
  const handleClose = () => { setEditorOpen(false); setEditing(null) }

  const handleRunNow = async (id: string) => {
    setBusy(b => ({ ...b, [id]: true }))
    try { await runNow(id) } catch {}
    finally { setBusy(b => ({ ...b, [id]: false })) }
  }

  const handleDelete = async (id: string) => {
    try { await remove(id) } catch {}
    setConfirmingDelete(null)
  }

  const drawerTask = drawerTaskId ? schedules.find(s => s.id === drawerTaskId) || null : null

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            aria-label="Back to chat"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l-6 6 6 6" />
            </svg>
          </button>
        )}
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] flex-1">Schedules</h2>
        <button
          onClick={handleNew}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors inline-flex items-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
          New schedule
        </button>
      </header>

      {schedules.length > 0 && (
        <div className="flex items-center gap-2 px-4 md:px-6 lg:px-10 py-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/40 shrink-0">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name…"
            className="flex-1 max-w-sm px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
            aria-label="Search schedules by name"
          />
          <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-tertiary)]/60 p-0.5">
            {(['all', 'enabled', 'disabled'] as StatusFilter[]).map(opt => (
              <button
                key={opt}
                type="button"
                onClick={() => setStatusFilter(opt)}
                className={`px-2.5 py-1 text-xs rounded-md capitalize transition-colors ${
                  statusFilter === opt
                    ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
                aria-pressed={statusFilter === opt}
              >
                {opt}
              </button>
            ))}
          </div>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
            className="px-3 py-2 text-sm rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40"
            aria-label="Filter by task type"
          >
            <option value="all">All types</option>
            <option value="prompt">Prompt</option>
            <option value="skill">Skill</option>
            <option value="security_scan">Security scan</option>
            <option value="log_check">Log check</option>
            <option value="continue_dev">Continue dev</option>
          </select>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 md:px-6 lg:px-10 py-5 md:py-6">
        {loading && schedules.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Loading...</p>
        ) : error ? (
          <div className="bg-red-500/10 ring-1 ring-red-500/30 rounded-xl p-4 text-sm text-red-300 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => void refetch()} className="text-xs text-red-300 hover:text-red-200 underline">Retry</button>
          </div>
        ) : schedules.length === 0 ? (
          <EmptyState onNew={handleNew} />
        ) : filteredSchedules.length === 0 ? (
          <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 text-center max-w-xl mx-auto">
            <p className="text-sm text-[var(--text-muted)] mb-3">No schedules match your filters.</p>
            <button
              onClick={clearFilters}
              className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs text-[var(--text-on-accent)] font-medium transition-colors"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="space-y-3 max-w-4xl">
            {filteredSchedules.map(s => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                busy={!!busy[s.id]}
                confirming={confirmingDelete === s.id}
                onClick={() => setDrawerTaskId(s.id)}
                onToggle={() => void toggle(s.id, !s.enabled)}
                onRunNow={(e) => { e.stopPropagation(); void handleRunNow(s.id) }}
                onEdit={(e) => { e.stopPropagation(); handleEdit(s) }}
                onDelete={(e) => { e.stopPropagation(); setConfirmingDelete(s.id) }}
                onConfirmDelete={(e) => { e.stopPropagation(); void handleDelete(s.id) }}
                onCancelDelete={(e) => { e.stopPropagation(); setConfirmingDelete(null) }}
              />
            ))}
          </div>
        )}
      </div>

      {editorOpen && (
        <ScheduleEditor
          token={token}
          existing={editing}
          allSchedules={schedules}
          onClose={handleClose}
          onSave={async (data) => {
            if (editing) {
              await update(editing.id, data)
            } else {
              await create(data)
            }
            handleClose()
          }}
        />
      )}

      {drawerTask && (
        <ScheduleRunsDrawer
          token={token}
          task={drawerTask}
          subscribe={subscribe}
          onClose={() => setDrawerTaskId(null)}
        />
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- */

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-8 text-center max-w-xl mx-auto">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-indigo-600/20 ring-1 ring-indigo-500/30 mb-4">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300">
          <rect x="3" y="4" width="14" height="13" rx="2" />
          <path d="M3 8h14" />
          <path d="M7 2v4M13 2v4" />
        </svg>
      </div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1.5">No schedules yet</h3>
      <p className="text-xs text-[var(--text-muted)] mb-5 leading-relaxed">
        Schedule recurring tasks for your Claude Code sessions and supervisors.
        Run security scans nightly, kick off log-checks every morning, or chain a prompt
        through any of your connected agents on cron.
      </p>
      <button
        onClick={onNew}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
      >
        Create your first schedule
      </button>
    </div>
  )
}

interface RowProps {
  schedule: ScheduledTask
  busy: boolean
  confirming: boolean
  onClick: () => void
  onToggle: () => void
  onRunNow: (e: React.MouseEvent) => void
  onEdit: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
  onConfirmDelete: (e: React.MouseEvent) => void
  onCancelDelete: (e: React.MouseEvent) => void
}

function ScheduleRow({
  schedule, busy, confirming, onClick, onToggle,
  onRunNow, onEdit, onDelete, onConfirmDelete, onCancelDelete,
}: RowProps) {
  const next = schedule.next_fire_at ? new Date(schedule.next_fire_at) : null
  const targetSummary = useMemo(() => describeTarget(schedule), [schedule.target_kind, schedule.target_id])
  const cronSummary = useMemo(() => humanizeCron(schedule.cron_expr), [schedule.cron_expr])

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-[var(--bg-secondary)]/60 rounded-xl p-4 hover:bg-[var(--bg-secondary)]/80 transition-colors group"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">{schedule.name}</h3>
            <TaskTypeChip type={schedule.task_type} />
            {schedule.last_run_status && <StatusChip status={schedule.last_run_status} />}
            <LastRunMetrics
              costUsd={schedule.last_run_cost_usd}
              durationMs={schedule.last_run_duration_ms}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
            <span className="inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="6" r="4.5" />
                <path d="M6 3.5v2.5l1.5 1.5" />
              </svg>
              {cronSummary}
            </span>
            <span className="inline-flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 5h9M1.5 8h9" />
                <rect x="1" y="2.5" width="10" height="7.5" rx="1" />
              </svg>
              {targetSummary}
            </span>
            {next && (
              <span className="inline-flex items-center gap-1">
                Next: <span className="text-[var(--text-secondary)]">{formatTsInTz(next, schedule.timezone)}</span>
              </span>
            )}
            {schedule.last_fire_at && (
              <span className="inline-flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="4.5" />
                  <path d="M6 3.5v2.5l1.5 1.5" />
                </svg>
                Fired {formatRelativeAgo(new Date(schedule.last_fire_at))}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Enable toggle */}
          <button
            type="button"
            onClick={onToggle}
            aria-pressed={schedule.enabled}
            title={schedule.enabled ? 'Disable' : 'Enable'}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              schedule.enabled ? 'bg-indigo-600' : 'bg-[var(--bg-tertiary)]'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              schedule.enabled ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
            }`} />
          </button>

          {/* Run now */}
          <button
            onClick={onRunNow}
            disabled={busy}
            title="Run now"
            aria-label="Run now"
            className="p-1.5 text-[var(--text-muted)] hover:text-emerald-400 rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
              <path d="M4 3l8 4-8 4V3z" />
            </svg>
          </button>

          {/* Edit */}
          <button
            onClick={onEdit}
            title="Edit"
            aria-label="Edit"
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 2l3 3-7 7H2v-3l7-7z" />
            </svg>
          </button>

          {/* Delete */}
          {confirming ? (
            <>
              <button
                onClick={onConfirmDelete}
                className="px-2 py-1 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
              >Confirm</button>
              <button
                onClick={onCancelDelete}
                className="px-2 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
              >Cancel</button>
            </>
          ) : (
            <button
              onClick={onDelete}
              title="Delete"
              aria-label="Delete"
              className="p-1.5 text-[var(--text-muted)] hover:text-red-400 rounded hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.5 8h5L10 4" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </button>
  )
}

/* ----------------------------------------------------------------- */
/* Chips                                                              */
/* ----------------------------------------------------------------- */

function TaskTypeChip({ type }: { type: ScheduledTask['task_type'] }) {
  const label: Record<ScheduledTask['task_type'], string> = {
    prompt: 'prompt',
    skill: 'skill',
    security_scan: 'security scan',
    log_check: 'log check',
    continue_dev: 'continue dev',
  }
  return (
    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)]">
      {label[type] || type}
    </span>
  )
}

function StatusChip({ status }: { status: NonNullable<ScheduledTask['last_run_status']> }) {
  const cfg: Record<string, { label: string; cls: string }> = {
    success: { label: 'success', cls: 'bg-emerald-600/20 text-emerald-300 ring-emerald-500/30' },
    failure: { label: 'failed', cls: 'bg-red-600/20 text-red-300 ring-red-500/30' },
    skipped: { label: 'skipped', cls: 'bg-amber-600/20 text-amber-300 ring-amber-500/30' },
    pending: { label: 'pending', cls: 'bg-gray-600/20 text-gray-300 ring-gray-500/30' },
    running: { label: 'running', cls: 'bg-indigo-600/20 text-indigo-300 ring-indigo-500/30' },
  }
  const c = cfg[status] || cfg.pending
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ring-1 ${c.cls}`}>{c.label}</span>
  )
}

function LastRunMetrics({
  costUsd,
  durationMs,
}: {
  costUsd: number | null | undefined
  durationMs: number | null | undefined
}) {
  const costLabel = formatCostUsd(costUsd)
  const hasDuration = durationMs !== null && durationMs !== undefined
  if (!costLabel && !hasDuration) return null
  const parts: string[] = []
  if (costLabel) parts.push(costLabel)
  if (hasDuration) parts.push(formatDuration(durationMs))
  return (
    <span className="text-[10px] text-[var(--text-muted)] font-mono">
      {parts.join(' · ')}
    </span>
  )
}

/* ----------------------------------------------------------------- */
/* Formatters (exported for reuse by editor + drawer)                 */
/* ----------------------------------------------------------------- */

export function describeTarget(s: Pick<ScheduledTask, 'target_kind' | 'target_id'>): string {
  switch (s.target_kind) {
    case 'session': return `session: ${shortId(s.target_id)}`
    case 'supervisor': return `supervisor: ${shortId(s.target_id)}`
    case 'all_agents': return 'all agents'
    case 'all_supervisors': return 'all supervisors'
    default: return s.target_kind
  }
}

function shortId(id: string | null | undefined): string {
  if (!id) return '—'
  return id.length > 8 ? id.slice(0, 8) : id
}

export function formatLocalTs(d: Date): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(d)
  } catch {
    return d.toISOString()
  }
}

export function formatTsInTz(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: tz,
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return formatLocalTs(d)
  }
}
