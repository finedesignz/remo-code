/**
 * SessionPicker — modal to add sessions to a chat tab.
 *
 * Lists all of the user's sessions; sessions already in the tab are visibly
 * disabled and pre-checked. Submit issues one POST per newly checked id
 * (server API is one-at-a-time per PLAN-001) then calls `onAdded`.
 */
import { useEffect, useState } from 'react'
import { useSessions } from '../hooks/useSessions'
import { addSessionToTab, MAX_CELLS_PER_TAB, type TabWithSessions } from '../lib/chat-tabs-api'

interface Props {
  token: string
  tab: TabWithSessions
  onClose: () => void
  onAdded: () => void | Promise<void>
}

export function SessionPicker({ token, tab, onClose, onAdded }: Props) {
  const { sessions, loading } = useSessions(token)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inTab = new Set(tab.sessions.map(s => s.session_id))
  const availableCount = tab.sessions.length
  const remainingSlots = Math.max(0, MAX_CELLS_PER_TAB - availableCount)

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < remainingSlots) next.add(id)
      return next
    })
  }

  const submit = async () => {
    if (selected.size === 0) { onClose(); return }
    setSubmitting(true)
    setError(null)
    try {
      for (const sid of selected) {
        await addSessionToTab(token, tab.id, sid)
      }
      await onAdded()
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to add sessions')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-picker-title"
        className="bg-[var(--bg-secondary)] rounded-xl shadow-xl w-full max-w-md max-h-[80dvh] flex flex-col ring-1 ring-[var(--border-color)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-[var(--border-color)] flex items-center justify-between">
          <div>
            <h3 id="session-picker-title" className="text-sm font-semibold text-[var(--text-primary)]">Add sessions to “{tab.name}”</h3>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {remainingSlots > 0
                ? `${remainingSlots} slot${remainingSlots === 1 ? '' : 's'} remaining (max ${MAX_CELLS_PER_TAB} per tab)`
                : `Tab is full (${MAX_CELLS_PER_TAB} sessions max)`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1 rounded-lg hover:bg-[var(--bg-tertiary)]/50"
            aria-label="Close"
          >×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {loading && <div className="text-xs text-[var(--text-muted)] p-3">Loading sessions…</div>}
          {!loading && sessions.length === 0 && (
            <div className="text-xs text-[var(--text-muted)] p-3">No sessions yet. Create one from the sidebar first.</div>
          )}
          {!loading && sessions.map(s => {
            const already = inTab.has(s.id)
            const isSelected = selected.has(s.id)
            const isOnline = s.status === 'online' || s.status === 'thinking'
            return (
              <label
                key={s.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs cursor-pointer transition-colors ${
                  already
                    ? 'opacity-50 cursor-not-allowed'
                    : isSelected
                      ? 'bg-blue-600/20 ring-1 ring-blue-500/30'
                      : 'hover:bg-[var(--bg-tertiary)]/40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={already || isSelected}
                  disabled={already || (!isSelected && remainingSlots === 0)}
                  onChange={() => !already && toggle(s.id)}
                  className="accent-blue-600"
                />
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                  isOnline ? 'bg-emerald-400' : 'bg-[var(--text-muted)]'
                }`} />
                <span className="flex-1 truncate text-[var(--text-primary)]" title={s.project_dir ?? s.name}>
                  {s.name}
                </span>
                {already && <span className="text-[10px] text-[var(--text-muted)] uppercase">in tab</span>}
              </label>
            )
          })}
        </div>

        {error && (
          <div className="px-5 py-2 text-xs text-red-400 bg-red-500/10 border-t border-[var(--border-color)]">
            {error}
          </div>
        )}

        <div className="px-5 py-3 border-t border-[var(--border-color)] flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || selected.size === 0}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 text-[var(--text-on-accent)] text-xs font-medium transition-colors"
          >
            {submitting ? 'Adding…' : `Add ${selected.size || ''}`.trim()}
          </button>
        </div>
      </div>
    </div>
  )
}
