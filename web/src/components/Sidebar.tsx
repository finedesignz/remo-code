import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AuthUser } from '../lib/auth.ts'
import type { CodeSession } from '../hooks/useSessions'
import { sessionLabel, shortId, connectedSessions } from './SessionDropdown'
import { UnreadBadge } from './UnreadBadge'
import { SessionTooltip } from './SessionTooltip'

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => Promise<void>
  onShowConnect: () => void
  onShowApiKey: () => void
  onNavigate: (hash: string) => void
  onRefresh: () => void
  connected: boolean
  user: AuthUser
  signOut: () => void
  onClose?: () => void
  unreadCounts?: Record<string, number>
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onDeleteSession, onShowConnect, onShowApiKey,
  onNavigate, onRefresh,
  connected, user, signOut, onClose, unreadCounts = {},
  collapsed = false, onToggleCollapsed,
}: Props) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ id: string; top: number; left: number } | null>(null)

  const handleRowEnter = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setHoverInfo({ id, top: rect.top, left: rect.right + 8 })
  }
  const handleRowLeave = (id: string) => {
    setHoverInfo(prev => (prev?.id === id ? null : prev))
  }

  if (collapsed) {
    return (
      <div className="w-14 h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0 items-center py-3 gap-2">
        <button
          onClick={onToggleCollapsed}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <img src="/logo.png" alt="Remo Code" className="h-6 w-6 object-contain" />
        </button>
        <div className="flex-1" />
        <button
          onClick={onShowConnect}
          className="p-2 text-indigo-400 hover:text-indigo-300 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Connect a repository"
          aria-label="Connect a repository"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 9.5l-2 2a2.5 2.5 0 1 1-3.5-3.5l2-2" />
            <path d="M9.5 6.5l2-2a2.5 2.5 0 1 1 3.5 3.5l-2 2" />
            <path d="M6 10l4-4" />
          </svg>
        </button>
        <button
          onClick={() => onNavigate('#/grid')}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Grid View"
          aria-label="Grid View"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="2" y="2" width="4.5" height="4.5" rx="0.8" />
            <rect x="9.5" y="2" width="4.5" height="4.5" rx="0.8" />
            <rect x="2" y="9.5" width="4.5" height="4.5" rx="0.8" />
            <rect x="9.5" y="9.5" width="4.5" height="4.5" rx="0.8" />
          </svg>
        </button>
        <button
          onClick={() => onNavigate('#/schedules')}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Schedules"
          aria-label="Schedules"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
            <path d="M2.5 6.5h11" />
            <path d="M5.5 1.5v3M10.5 1.5v3" />
          </svg>
        </button>
        <button
          onClick={() => onNavigate('#/settings')}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Settings"
          aria-label="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2" />
            <path d="M13 8a5 5 0 0 0-.09-.94l1.4-1.08-1.5-2.6-1.65.66a5 5 0 0 0-1.62-.94L9.25 1.5h-3l-.29 1.6a5 5 0 0 0-1.62.94L2.69 3.38l-1.5 2.6 1.4 1.08A5 5 0 0 0 2.5 8a5 5 0 0 0 .09.94l-1.4 1.08 1.5 2.6 1.65-.66a5 5 0 0 0 1.62.94l.29 1.6h3l.29-1.6a5 5 0 0 0 1.62-.94l1.65.66 1.5-2.6-1.4-1.08A5 5 0 0 0 13 8z" />
          </svg>
        </button>
      </div>
    )
  }

  const hoveredSession =
    hoverInfo ? connectedSessions(sessions).find(s => s.id === hoverInfo.id) : null

  return (
    <>
      <div className="w-72 h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0">
        {/* Header — large centered logo, minimal padding */}
        <div className="relative flex items-center justify-center px-2 py-2 border-b border-[var(--border-color)]">
          <button
            onClick={onToggleCollapsed}
            className="hidden md:inline-flex p-0.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <img src="/logo.png" alt="Remo Code" className="h-14 w-14 object-contain" />
          </button>
          <img src="/logo.png" alt="Remo Code" className="md:hidden h-14 w-14 object-contain" />
          <button
            onClick={onClose}
            className="md:hidden absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            aria-label="Close sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
            </svg>
          </button>
        </div>

        {/* Session list header with refresh */}
        <div className="flex items-center justify-between px-3 pt-2 pb-1">
          <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Sessions</span>
          <button
            onClick={onRefresh}
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Refresh sessions"
            aria-label="Refresh sessions"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M1 4v-3h3" /><path d="M3.51 11a7 7 0 0 0 12.13-3.5" />
              <path d="M15 12v3h-3" /><path d="M12.49 5a7 7 0 0 0-12.13 3.5" />
            </svg>
          </button>
        </div>

        {/* Session list — only connected sessions */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {connectedSessions(sessions).map(s => (
            <div key={s.id} className="group relative">
              <button
                onClick={() => onSelectSession(s.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  s.id === activeSessionId
                    ? 'bg-indigo-600/20 text-[var(--text-primary)] ring-1 ring-indigo-500/30'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 active:bg-[var(--bg-tertiary)]/70'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                  }`} />
                  <span className="truncate font-medium flex-1">{sessionLabel(s)}</span>
                  <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">{shortId(s)}</span>
                  <UnreadBadge count={unreadCounts[s.id] || 0} />
                  {/* Action buttons — always visible on mobile, hover on desktop */}
                  <span className="flex md:hidden md:group-hover:flex items-center gap-1 shrink-0">
                    {confirmingId === s.id ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmingId(null); onDeleteSession(s.id) }}
                          className="px-2 py-1 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                          title="Confirm: shuts down the local claude-remote process and removes the session"
                        >
                          Confirm stop
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmingId(null) }}
                          className="px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 rounded transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmingId(s.id) }}
                        className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-red-400 hover:text-red-300 bg-[var(--bg-tertiary)]/80 hover:bg-red-900/40 rounded transition-colors"
                        title="Disconnect & stop agent — shuts down the local claude-remote process and removes the session"
                        aria-label={`Disconnect ${sessionLabel(s)}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="4" y1="4" x2="12" y2="12" />
                          <line x1="12" y1="4" x2="4" y2="12" />
                        </svg>
                      </button>
                    )}
                  </span>
                </div>
                {s.project_dir && (
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate pl-4">
                    {s.project_dir}
                  </div>
                )}
              </button>
            </div>
          ))}

          {connectedSessions(sessions).length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-8">
              No active sessions. Connect a Claude Code instance to get started.
            </p>
          )}
        </div>

        {/* Connect session — routes to Supervisor tab */}
        <div className="p-3 border-t border-[var(--border-color)]">
          <button
            onClick={onShowConnect}
            className="w-full py-2.5 text-sm text-indigo-400 hover:text-indigo-300 hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors font-medium flex items-center justify-center gap-2"
            title="Connect a repository via the Supervisor"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6.5 9.5l-2 2a2.5 2.5 0 1 1-3.5-3.5l2-2" />
              <path d="M9.5 6.5l2-2a2.5 2.5 0 1 1 3.5 3.5l-2 2" />
              <path d="M6 10l4-4" />
            </svg>
            Connect
          </button>
        </div>

        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-[var(--border-color)] flex items-center gap-2">
          <button
            onClick={() => onNavigate('#/grid')}
            className="flex-1 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors font-medium"
            title="Multichat grid view"
          >
            Grid
          </button>
          <button
            onClick={() => onNavigate('#/schedules')}
            className="flex-1 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors font-medium"
            title="Scheduled tasks"
          >
            Schedules
          </button>
          <button
            onClick={() => onNavigate('#/settings')}
            className="flex-1 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors font-medium"
          >
            Settings
          </button>
          <button
            onClick={signOut}
            className="px-3 py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors"
            title="Sign out"
            aria-label="Sign out"
          >
            Sign out
          </button>
        </div>
      </div>
      {hoveredSession && hoverInfo && createPortal(
        <div
          style={{ position: 'fixed', top: hoverInfo.top, left: hoverInfo.left, zIndex: 60, pointerEvents: 'none' }}
          className="hidden md:block bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl"
        >
          <SessionTooltip session={hoveredSession} />
        </div>,
        document.body
      )}
    </>
  )
}
