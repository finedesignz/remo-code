import { useState, useRef, useEffect } from 'react'
import type { CodeSession } from '../hooks/useSessions'

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
}

/** Derive a short, human-readable label from a session */
export function sessionLabel(s: CodeSession): string {
  if (s.project_dir) {
    const folder = s.project_dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
    if (folder) return folder
  }
  return s.name
}

/** Filter to only connected (online/thinking) sessions */
export function connectedSessions(sessions: CodeSession[]): CodeSession[] {
  return sessions.filter(s => s.status === 'online' || s.status === 'thinking')
}

export function SessionDropdown({ sessions, activeSessionId, onSelectSession }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const connected = connectedSessions(sessions)
  const active = connected.find(s => s.id === activeSessionId)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
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
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span className="w-2 h-2 rounded-full bg-slate-600" />
        No active sessions
      </div>
    )
  }

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full min-w-0 px-2 py-1.5 rounded-lg text-sm hover:bg-slate-700/50 transition-colors"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        {active ? (
          <>
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
              active.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
            }`} />
            <span className="truncate font-medium text-slate-200">
              {sessionLabel(active)}
            </span>
          </>
        ) : (
          <span className="text-slate-400">Select session</span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`ml-auto flex-shrink-0 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute top-full left-0 right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl z-50 overflow-y-auto max-h-64"
          role="listbox"
        >
          {connected.map(s => (
            <button
              key={s.id}
              role="option"
              aria-selected={s.id === activeSessionId}
              onClick={() => { onSelectSession(s.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 ${
                s.id === activeSessionId
                  ? 'bg-indigo-600/20 text-white'
                  : 'text-slate-300 hover:bg-[var(--bg-tertiary)]/50'
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
              }`} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{sessionLabel(s)}</div>
                {s.project_dir && (
                  <div className="text-[11px] text-slate-500 truncate">{s.project_dir}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
