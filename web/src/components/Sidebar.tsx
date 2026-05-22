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
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onDeleteSession, onShowConnect, onShowApiKey,
  onNavigate, onRefresh,
  connected, user, signOut, onClose, unreadCounts = {},
}: Props) {

  return (
      <div className="w-72 h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border-color)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-6 w-6 object-contain" />
              <h1 className="text-lg font-bold text-[var(--text-primary)]">Remo Code</h1>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{user.email}</p>
          </div>
          <button
            onClick={onClose}
            className="md:hidden p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
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
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete session "${sessionLabel(s)}"?`)) onDeleteSession(s.id) }}
                      className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 bg-[var(--bg-tertiary)]/80 hover:bg-red-900/50 rounded transition-colors"
                      title="Delete session"
                      aria-label={`Delete ${sessionLabel(s)}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <line x1="4" y1="4" x2="12" y2="12" />
                        <line x1="12" y1="4" x2="4" y2="12" />
                      </svg>
                    </button>
                  </span>
                </div>
                {s.project_dir && (
                  <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate pl-4">
                    {s.project_dir}
                  </div>
                )}
              </button>
              <div className="hidden group-hover:block absolute left-full top-0 ml-2 z-50 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl pointer-events-none">
                <SessionTooltip session={s} />
              </div>
            </div>
          ))}

          {connectedSessions(sessions).length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-8">
              No active sessions. Connect a Claude Code instance to get started.
            </p>
          )}
        </div>

        {/* Connect session button */}
        <div className="p-3 border-t border-[var(--border-color)]">
          <button
            onClick={onShowConnect}
            className="w-full py-2.5 text-sm text-indigo-400 hover:text-indigo-300 hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors font-medium"
          >
            + Connect Session
          </button>
        </div>

        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-[var(--border-color)] flex items-center gap-1">
          <button
            onClick={() => onNavigate('#/supervisor')}
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-indigo-300 transition-colors rounded-lg hover:bg-[var(--bg-tertiary)]/50"
            title="Supervisor — manage local repos"
            aria-label="Supervisor"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="9" rx="1.5" />
              <path d="M5 14h6" />
              <path d="M8 12v2" />
              <circle cx="5" cy="6" r="0.6" fill="currentColor" />
              <path d="M7.5 6h4" />
            </svg>
          </button>
          <button
            onClick={() => onNavigate('#/settings')}
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-indigo-300 transition-colors rounded-lg hover:bg-[var(--bg-tertiary)]/50"
            title="Settings"
            aria-label="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M13.5 8a5.5 5.5 0 0 0-.1-.9l1.4-1.1-1-1.7-1.7.5a5.5 5.5 0 0 0-1.5-.9L10.2 2H8.2l-.4 1.9a5.5 5.5 0 0 0-1.5.9l-1.7-.5-1 1.7 1.4 1.1A5.5 5.5 0 0 0 5 8c0 .3 0 .6.1.9L3.6 10l1 1.7 1.7-.5c.4.4.9.7 1.5.9l.4 1.9h2l.4-1.9c.6-.2 1.1-.5 1.5-.9l1.7.5 1-1.7-1.4-1.1c0-.3.1-.6.1-.9z" />
            </svg>
          </button>
          <button
            onClick={onShowApiKey}
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-indigo-300 transition-colors rounded-lg hover:bg-[var(--bg-tertiary)]/50"
            title="API Key"
            aria-label="API Key"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M10.5 2.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z" />
              <path d="M8.5 7l-6.5 6.5v2h2v-2h2v-2h2l1-1" />
            </svg>
          </button>
          <div className="flex-1" />
          <button
            onClick={signOut}
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors rounded-lg hover:bg-[var(--bg-tertiary)]/50"
            title="Sign out"
            aria-label="Sign out"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
              <path d="M10 12l4-4-4-4" />
              <path d="M14 8H6" />
            </svg>
          </button>
        </div>
      </div>
  )
}
