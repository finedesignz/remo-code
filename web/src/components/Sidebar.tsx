import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { AuthUser } from '../lib/auth.ts'
import type { CodeSession } from '../hooks/useSessions'
import { githubOwnerRepo } from '../hooks/useSessions'
import { sessionLabel, shortId } from './SessionDropdown'
import { repoSessionList } from '../lib/session-list'
import { SessionActionButton } from './SessionActionButton'
import { SessionAvatar } from './SessionAvatar'
import { UnreadBadge } from './UnreadBadge'
import { SessionTooltip } from './SessionTooltip'
import { CloneHereModal } from './CloneHereModal'
import { Toggle } from './ui/Toggle'

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => Promise<void>
  /** User Disconnect — takes a running session offline but KEEPS the row so a
      later Play resumes the SAME session_id with history. Single-click,
      reversible (no destructive confirm). Optional so existing callers compile. */
  onDisconnectSession?: (id: string) => Promise<{ ok: boolean; error?: string }>
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
  /** Phase 08.5 launch-flow helper (from useSessions). Optional so existing callers keep compiling. */
  cloneHere?: (id: string, targetRoot: string) => Promise<{ ok: boolean; error?: string; target_path?: string }>
  /** Phase 10 — user's global auto-nudge default; reflects effective state when a row has no override. */
  globalNudgeDefault?: boolean
  /** Phase 10 — set a session's per-session auto-nudge override (true/false force, null inherit). */
  onSetAutoNudge?: (id: string, value: boolean | null) => Promise<{ ok: boolean; error?: string }>
  /** Per-session "bypass permissions" override (default OFF). */
  onSetSkipPermissions?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onDeleteSession, onDisconnectSession, onShowConnect, onShowApiKey,
  onNavigate, onRefresh,
  connected, user, signOut, onClose, unreadCounts = {},
  collapsed = false, onToggleCollapsed,
  token = null,
  // `subscribe` remains in Props (callers pass it) but is no longer consumed
  // here after the pending-folders banner was removed.
  // The sidebar no longer renders offline rows or re-launch buttons — offline
  // sessions are launched from Settings → Supervisor, not here. The sidebar is
  // active-only, so the old `launchSession` prop has been dropped.
  cloneHere,
  globalNudgeDefault = true,
  onSetAutoNudge,
  onSetSkipPermissions,
}: Props) {
  const [cloneModal, setCloneModal] = useState<{ sessionId: string; repoLabel: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3500)
  }
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [hoverInfo, setHoverInfo] = useState<{ id: string; top: number; left: number } | null>(null)
  // Per-row "more" popover: session id + auto-nudge toggle live here (off the
  // row itself, to keep the row clean). Anchored to the kebab button.
  const [moreInfo, setMoreInfo] = useState<{ id: string; top: number; left: number } | null>(null)
  const openMore = (id: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    setMoreInfo((prev) => (prev?.id === id ? null : { id, top: rect.bottom + 4, left: rect.right }))
  }

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
  // Close the "more" popover on Escape or any outside pointer-down.
  useEffect(() => {
    if (!moreInfo) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreInfo(null) }
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('[data-session-more]')) return
      setMoreInfo(null)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [moreInfo])

  // Resolve the running branch for a session's cwd, when the supervisor inventory knows it.
  const branchFor = (s: CodeSession): string | null => {
    const lp = (s.local_paths ?? []).find((p) => p.local_path === s.project_dir)
    return lp?.branch ?? null
  }

  // Shared selector (web/src/lib/session-list): worktrees collapsed by
  // repo_key, connected-first sort, orchestrator pinned. Active-only (online /
  // thinking) — offline sessions are launched from Settings → Connections.
  // Computed before the collapsed branch so the collapsed rail can render one
  // project avatar per session.
  const onlineOnly = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s.status === 'online' || s.status === 'thinking',
  )
  const connectedList = repoSessionList(onlineOnly)

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
        {/* Collapsed project rail — one square avatar per active session so the
            rail is never blank. Click selects + expands the sidebar. A status
            dot overlay mirrors the expanded rows (amber=thinking, green=idle). */}
        <div className="flex flex-col items-center gap-1.5 mt-1 overflow-y-auto w-full">
          {connectedList.map((s) => {
            const label = githubOwnerRepo(s) ?? sessionLabel(s)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => { onSelectSession(s.id); onToggleCollapsed?.() }}
                title={label}
                aria-label={`Open ${label}`}
                className={`relative rounded-lg p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  s.id === activeSessionId ? 'ring-2 ring-blue-500' : 'hover:bg-[var(--bg-tertiary)]/50'
                }`}
              >
                <SessionAvatar session={s} size={28} />
                <span
                  className={`absolute -bottom-0 -right-0 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--bg-primary)] ${
                    s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                  }`}
                  aria-hidden="true"
                />
              </button>
            )
          })}
        </div>
        <div className="flex-1" />
        <button
          onClick={onShowConnect}
          className="p-2 text-blue-400 hover:text-blue-300 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
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

  const hoveredSession =
    hoverInfo ? connectedList.find(s => s.id === hoverInfo.id) : null

  return (
    <>
      <div className="w-full h-full border-r border-[var(--border-color)] flex flex-col bg-[var(--bg-primary)] md:bg-[var(--bg-secondary)]/30 shrink-0">
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
                className={`w-full cursor-pointer text-left px-3 py-2.5 rounded-lg text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/40 ${
                  s.id === activeSessionId
                    ? 'bg-blue-600/20 text-[var(--text-primary)] ring-1 ring-blue-500/30'
                    : s.is_orchestrator
                      ? 'bg-blue-600/10 text-[var(--text-primary)] ring-1 ring-blue-500/40 hover:bg-blue-600/15'
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
                      className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 shrink-0 font-semibold"
                      title="Orchestrator — coordinates your other sessions"
                    >
                      Orchestrator
                    </span>
                  )}
                  {s.cli_kind === 'codex' && (
                    <span
                      className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 shrink-0 font-semibold"
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
                  <UnreadBadge count={unreadCounts[s.id] || 0} />
                  {/* Action controls — state-aware. The session id + auto-nudge
                      toggle moved OFF the row into the "more" popover (kebab).
                      Stop shows ONLY while the agent is busy (status==='thinking');
                      Disconnect shows ONLY when the session is idle/stopped
                      (online-but-not-thinking) since disconnect acts on a
                      stopped session and resumes it later with history. */}
                  <span className="flex items-center gap-0.5 shrink-0">
                    {/* "More" — kebab opens a popover with the session id + the
                        per-session auto-nudge toggle. */}
                    <button
                      type="button"
                      data-session-more
                      onClick={(e) => { e.stopPropagation(); openMore(s.id, e.currentTarget) }}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      title={`Session details for ${sessionLabel(s)}`}
                      aria-label={`Session details for ${sessionLabel(s)}`}
                      aria-haspopup="dialog"
                      aria-expanded={moreInfo?.id === s.id}
                    >
                      <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                        <circle cx="10" cy="4" r="1.5" />
                        <circle cx="10" cy="10" r="1.5" />
                        <circle cx="10" cy="16" r="1.5" />
                      </svg>
                    </button>
                    {s.status === 'thinking' ? (
                      confirmingId === s.id ? (
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
                        <SessionActionButton
                          kind="stop"
                          onClick={() => setConfirmingId(s.id)}
                          label={`Stop ${sessionLabel(s)} — the agent is working; this closes the subprocess and removes the session`}
                        />
                      )
                    ) : (
                      onDisconnectSession && (
                        <SessionActionButton
                          kind="disconnect"
                          onClick={() => { void onDisconnectSession(s.id) }}
                          label={`Disconnect ${sessionLabel(s)} — frees the slot; reconnect resumes this session with its history`}
                        />
                      )
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
      {moreInfo && (() => {
        const s = connectedList.find(x => x.id === moreInfo.id)
        if (!s) return null
        const label = githubOwnerRepo(s) ?? sessionLabel(s)
        return createPortal(
          <div
            data-session-more
            role="dialog"
            aria-label={`Session details for ${label}`}
            style={{ position: 'fixed', top: moreInfo.top, left: moreInfo.left, transform: 'translateX(-100%)', zIndex: 70, minWidth: 200 }}
            className="bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl p-3 space-y-2.5"
          >
            <div className="text-[11px] text-[var(--text-muted)]">
              <div className="font-medium text-[var(--text-secondary)] truncate" title={label}>{label}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span>Session</span>
                <span className="font-mono text-[var(--text-primary)]">{shortId(s)}</span>
              </div>
            </div>
            {onSetAutoNudge && (
              <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
                <span title="Send a brief status-update prompt when you open this idle session">Auto-nudge when idle</span>
                <Toggle
                  checked={s.auto_nudge ?? globalNudgeDefault}
                  onChange={(next) => { void onSetAutoNudge(s.id, next) }}
                  aria-label={`Auto-nudge when idle for ${label}`}
                />
              </label>
            )}
            {onSetSkipPermissions && (
              <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
                <span title="Bypass tool-approval prompts for this session (auto-allows every tool). Still capped by the supervisor host config.">
                  Skip approval prompts
                </span>
                <Toggle
                  checked={s.dangerously_skip_permissions === true}
                  onChange={(next) => { void onSetSkipPermissions(s.id, next) }}
                  aria-label={`Skip approval prompts for ${label}`}
                />
              </label>
            )}
          </div>,
          document.body
        )
      })()}
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
