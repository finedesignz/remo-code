import { useState, useRef, useEffect } from 'react'
import type { CodeSession } from '../hooks/useSessions'
import { UnreadBadge } from './UnreadBadge'
import { timeAgo } from './SessionTooltip'

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  unreadCounts?: Record<string, number>
}

/** Derive a short, human-readable label from a session */
export function sessionLabel(s: CodeSession): string {
  if (s.project_dir) {
    const folder = s.project_dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (folder) return folder
  }
  return s.name
}

/** Short session ID for display (first 8 chars) */
export function shortId(s: CodeSession): string {
  return s.id.slice(0, 8)
}

/** Filter to only connected (online/thinking) sessions */
export function connectedSessions(sessions: CodeSession[]): CodeSession[] {
  return sessions.filter(s => s.status === 'online' || s.status === 'thinking')
}

export function SessionDropdown({ sessions, activeSessionId, onSelectSession, unreadCounts = {} }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const connected = connectedSessions(sessions)
  const active = connected.find(s => s.id === activeSessionId)
  const totalUnread = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0)

  // Close on outside click/touch
  useEffect(() => {
    if (!open) return
    const handler = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  if (connected.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <span className="w-2 h-2 rounded-full bg-[var(--bg-tertiary)]" />
        No active sessions
      </div>
    )
  }

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full min-w-0 px-2 py-1.5 rounded-lg text-sm hover:bg-[var(--bg-tertiary)]/50 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {active ? (
          <>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
              active.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
            }`} />
            <span className="truncate font-medium text-[var(--text-secondary)]">
              {sessionLabel(active)}
            </span>
          </>
        ) : (
          <span className="text-[var(--text-muted)]">Select session</span>
        )}
        {totalUnread > 0 && <UnreadBadge count={totalUnread} />}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`ml-auto flex-shrink-0 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full left-0 right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl z-50 overflow-y-auto max-h-64 touch-auto"
          role="listbox"
        >
          {connected.map(s => (
            <button
              key={s.id}
              role="option"
              aria-selected={s.id === activeSessionId}
              title={`${sessionLabel(s)} (${shortId(s)})\n${s.project_dir || ''}\nActive: ${timeAgo(s.last_activity)}\nStatus: ${s.status}`}
              onClick={(e) => { e.preventDefault(); onSelectSession(s.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                s.id === activeSessionId
                  ? 'bg-indigo-600/20 text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50'
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
              }`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{sessionLabel(s)}</span>
                  <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">{shortId(s)}</span>
                </div>
                {s.project_dir && (
                  <div className="text-[11px] text-[var(--text-muted)] truncate">{s.project_dir}</div>
                )}
              </div>
              <UnreadBadge count={unreadCounts[s.id] || 0} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
