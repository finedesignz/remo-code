import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AuthUser } from '../lib/auth.ts'
import type { CodeSession } from '../hooks/useSessions'
import { githubOwnerRepo } from '../hooks/useSessions'
import { sessionLabel, shortId, connectedSessions } from './SessionDropdown'
import { UnreadBadge } from './UnreadBadge'
import { SessionTooltip } from './SessionTooltip'
import { PendingLocalRepoPrompt } from './PendingLocalRepoPrompt'
import { CloneHereModal } from './CloneHereModal'

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
  /** JWT for the pending-prompts hook (Phase 08). When null, the prompt section is silently skipped. */
  token?: string | null
  /** Hub WS subscribe — forwarded to PendingLocalRepoPrompt/CreateGithubRepoModal for progress. */
  subscribe?: (handler: (msg: any) => void) => () => void
  /** Phase 08.5 launch-flow helpers (from useSessions). Optional so existing callers keep compiling. */
  launchSession?: (id: string, body?: { cli_kind?: 'claude' | 'codex'; local_path?: string }) => Promise<{ ok: boolean; error?: string; detail?: string }>
  cloneHere?: (id: string, targetRoot: string) => Promise<{ ok: boolean; error?: string; target_path?: string }>
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onDeleteSession, onShowConnect, onShowApiKey,
  onNavigate, onRefresh,
  connected, user, signOut, onClose, unreadCounts = {},
  collapsed = false, onToggleCollapsed,
  token = null,
  subscribe,
  // launchSession is kept in Props (callers still pass it) but the sidebar no
  // longer renders offline rows or re-launch buttons — offline sessions are
  // launched from Settings → Supervisor, not here. The sidebar is active-only.
  launchSession: _launchSession,
  cloneHere,
}: Props) {
  const [cloneModal, setCloneModal] = useState<{ sessionId: string; repoLabel: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3500)
  }
  // Phase 08 — resolve a sessionId from a (hostname, project_dir) pair so the
  // PendingLocalRepoPrompt can call POST /api/sessions/:id/create-github-repo.
  // We try to match against the user's current session list first; if no row
  // matches, the prompt renders the Create button with an inline hint.
  const resolveSessionId = (hostname: string, project_dir: string): string | null => {
    const match = sessions.find(s =>
      s.hostname === hostname && s.project_dir === project_dir,
    )
    return match ? match.id : null
  }
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ id: string; top: number; left: number } | null>(null)

  const handleRowEnter = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setHoverInfo({ id, top: rect.top, left: rect.right + 8 })
  }
  const handleRowLeave = (id: string) => {
    setHoverInfo(prev => (prev?.id === id ? null : prev))
  }
  // Keyboard activation for the div-based clickable rows (Enter/Space select).
  const handleRowKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelectSession(id)
    }
  }
  // Resolve the running branch for a session's cwd, when the supervisor inventory knows it.
  const branchFor = (s: CodeSession): string | null => {
    const lp = (s.local_paths ?? []).find((p) => p.local_path === s.project_dir)
    return lp?.branch ?? null
  }

  if (collapsed) {
    return (
      <div className="w-14 h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0 items-center py-3 gap-2">
        <button
          onClick={onToggleCollapsed}
          className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="3" y1="5" x2="17" y2="5" />
            <line x1="3" y1="10" x2="17" y2="10" />
            <line x1="3" y1="15" x2="17" y2="15" />
          </svg>
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
          onClick={() => onNavigate('#/?tab=grid')}
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
          onClick={() => onNavigate('#/tasks?tab=schedule')}
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
          onClick={() => onNavigate('#/tasks?tab=activity')}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          title="Error Capture"
          aria-label="Error Capture"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.5l6.5 11.5h-13z" />
            <line x1="8" y1="6" x2="8" y2="9.5" />
            <circle cx="8" cy="11.5" r="0.4" fill="currentColor" />
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

  // Phase 08.6 — defensive UI-side collapse: if the session list ever surfaces
  // two rows sharing the same `repo_key` (shouldn't happen post-Phase 08 dedupe
  // but legacy data can drift), keep only the most-recently-active one. Local
  // sessions with NULL repo_key remain as-is, keyed by id.
  const collapseByRepoKey = (list: CodeSession[]): CodeSession[] => {
    const byKey = new Map<string, CodeSession>()
    const out: CodeSession[] = []
    for (const s of list) {
      if (!s.repo_key) { out.push(s); continue }
      const prev = byKey.get(s.repo_key)
      if (!prev) { byKey.set(s.repo_key, s); continue }
      const a = prev.last_activity ? Date.parse(prev.last_activity) : 0
      const b = s.last_activity ? Date.parse(s.last_activity) : 0
      if (b > a) byKey.set(s.repo_key, s)
    }
    for (const s of byKey.values()) out.push(s)
    return out
  }
  const rawConnected = collapseByRepoKey(connectedSessions(sessions))
  // Pin the orchestrator session (if any) to the very top.
  const orchestratorIdx = rawConnected.findIndex((s) => s.is_orchestrator)
  const connectedList = orchestratorIdx >= 0
    ? [rawConnected[orchestratorIdx], ...rawConnected.filter((_, i) => i !== orchestratorIdx)]
    : rawConnected

  // Offline sessions are intentionally NOT rendered in the sidebar — it is
  // active-only. They are launched/managed from Settings → Supervisor instead.

  const hoveredSession =
    hoverInfo ? connectedList.find(s => s.id === hoverInfo.id) : null

  return (
    <>
      <div className="w-72 h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0">
        {/* Session list header — collapse hamburger (desktop) left of the
            "Sessions" label; refresh + add + mobile-close on the right. The
            logo header was removed (it's redundant with the AppShell <Brand/>). */}
        <div className="flex items-center gap-1 px-3 pt-2 pb-1">
          <button
            onClick={onToggleCollapsed}
            className="hidden md:inline-flex p-1 -ml-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="5" x2="17" y2="5" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="15" x2="17" y2="15" />
            </svg>
          </button>
          <span className="text-[11px] font-medium text-[var(--text-muted)] uppercase tracking-wider">Sessions</span>
          <div className="ml-auto flex items-center gap-0.5">
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
            <button
              onClick={() => onNavigate('#/settings?tab=connections')}
              className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
              title="Add connection"
              aria-label="Add connection"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="8" y1="3" x2="8" y2="13" />
                <line x1="3" y1="8" x2="13" y2="8" />
              </svg>
            </button>
            <button
              onClick={onClose}
              className="md:hidden p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded transition-colors"
              aria-label="Close sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="4" y1="4" x2="14" y2="14" />
                <line x1="14" y1="4" x2="4" y2="14" />
              </svg>
            </button>
          </div>
        </div>

        {/* Phase 08 — "Needs attention" pending local folders banner */}
        <PendingLocalRepoPrompt
          token={token}
          resolveSessionId={resolveSessionId}
          subscribe={subscribe}
          onCreated={onRefresh}
        />

        {/* Session list — only connected sessions */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {connectedList.map(s => {
            const ownerRepo = githubOwnerRepo(s)
            const primaryLabel = ownerRepo ?? sessionLabel(s)
            const branch = branchFor(s)
            // Full folder path lives in the row tooltip only (never as body text).
            const rowTitle = s.project_dir
              ? `${primaryLabel}${branch ? ` · ${branch}` : ''}\n${s.project_dir}`
              : primaryLabel
            return (
            <div key={s.id} className="group relative">
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(s.id)}
                onKeyDown={(e) => handleRowKeyDown(e, s.id)}
                onMouseEnter={(e) => handleRowEnter(s.id, e.currentTarget)}
                onMouseLeave={() => handleRowLeave(s.id)}
                title={rowTitle}
                aria-label={primaryLabel}
                className={`w-full cursor-pointer text-left px-3 py-2.5 rounded-lg text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/40 ${
                  s.id === activeSessionId
                    ? 'bg-indigo-600/20 text-[var(--text-primary)] ring-1 ring-indigo-500/30'
                    : s.is_orchestrator
                      ? 'bg-indigo-600/10 text-[var(--text-primary)] ring-1 ring-indigo-500/40 hover:bg-indigo-600/15'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 active:bg-[var(--bg-tertiary)]/70'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                  }`} />
                  {/* Phase 08 — GitHub mark for keyed sessions, folder icon for legacy/local-only */}
                  {ownerRepo ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--text-muted)] shrink-0" aria-label="GitHub-keyed session">
                      <path d="M8 .25a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8.25 8 8 0 0 0 8 .25z" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-[var(--text-muted)] shrink-0" aria-label="Local-only session">
                      <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
                    </svg>
                  )}
                  <span className="truncate flex-1 min-w-0">
                    <span className="font-medium">{primaryLabel}</span>
                    {branch && (
                      <>
                        <span className="opacity-60"> · </span>
                        <span className="text-[var(--text-secondary)]">{branch}</span>
                      </>
                    )}
                  </span>
                  {s.is_orchestrator && (
                    <span
                      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 shrink-0 font-semibold"
                      title="Orchestrator — coordinates your other sessions"
                    >
                      Orchestrator
                    </span>
                  )}
                  {s.cli_kind === 'codex' && (
                    <span
                      className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 shrink-0 font-semibold"
                      title="Codex CLI session"
                    >
                      codex
                    </span>
                  )}
                  {s.is_rootless && (
                    <span
                      className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)]/60 text-[var(--text-muted)] shrink-0 font-semibold"
                      title={s.hostname ? `Ambient — ${s.hostname}` : 'Ambient session'}
                    >
                      ambient
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">{shortId(s)}</span>
                  <UnreadBadge count={unreadCounts[s.id] || 0} />
                  {/* Action control — always visible (no hover-only affordance, per
                      design prefs). Inline two-step confirm. For an online session
                      this stops the supervisor subprocess and removes the row. */}
                  <span className="flex items-center gap-1 shrink-0">
                    {confirmingId === s.id ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmingId(null); onDeleteSession(s.id) }}
                          className="px-2 py-1 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                          title="Confirm: stops the supervisor session and removes it"
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
                        className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-[var(--text-muted)] hover:text-red-300 hover:bg-red-900/30 rounded transition-colors"
                        title="Stop & remove session — closes the Claude Code subprocess and removes the session"
                        aria-label={`Stop and remove ${sessionLabel(s)}`}
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="4" y1="4" x2="12" y2="12" />
                          <line x1="12" y1="4" x2="4" y2="12" />
                        </svg>
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </div>
            )
          })}

          {connectedList.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-8">
              No active sessions. Connect a Claude Code instance to get started.
            </p>
          )}
        </div>

        {toast && (
          <div className="mx-2 mb-2 rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 px-3 py-1.5 text-[11px] text-emerald-300">
            {toast}
          </div>
        )}

        {/* Sessions-only sidebar — Connect moved to the "+" button in the header,
            email/sign-out moved to the avatar dropdown in the main app header. */}
      </div>
      {cloneModal && token && cloneHere && (
        <CloneHereModal
          token={token}
          sessionId={cloneModal.sessionId}
          repoLabel={cloneModal.repoLabel}
          cloneHere={cloneHere}
          onClose={() => setCloneModal(null)}
          onToast={showToast}
        />
      )}
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
