/**
 * Phase 12 W4a — header-free chat surface.
 *
 * Same content as `Layout.tsx` minus the inline `<header>` (theme toggle,
 * quota strip, profile menu, settings gear). Those now live on the shared
 * `<AppShell>` header rendered by `HomePage`. The session-context strip
 * (session name + project_dir + connected dot + session dropdown) stays —
 * it's chat-specific chrome, not app chrome.
 *
 * Wave 5 will delete `Layout.tsx` once all consumers (login screen / auth
 * callback) migrate to `<AppShell>`.
 */
import { useState, useCallback, useEffect } from 'react'
import type { AuthUser } from '../lib/auth.ts'
import { useWebSocketContext } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useChat } from '../hooks/useChat'
import { useActivity } from '../hooks/useActivity'
import { Sidebar } from './Sidebar'
import { useSidebarWidth } from '../hooks/useSidebarWidth'
import { ChatPanel } from './ChatPanel'
import { TerminalSurface } from './TerminalSurface'
import { ApiKeyModal } from './ApiKeyModal'
import { SessionDropdown, connectedSessions, sessionLabel, shortId } from './SessionDropdown'
import { readLastUserMessage, recordUserMessage } from '../lib/lastUserMsg'
import { hubFetch } from '../lib/api'

const NUDGE_TEXT = "Status update? Briefly: what's the current state, what would you recommend doing next, or what input do you need from me?"

interface Props {
  token: string
  user: AuthUser
  signOut: () => void
  onNavigate: (hash: string) => void
}

export function ChatLayout({ token, user, signOut, onNavigate }: Props) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('remo:sidebar-collapsed') === '1' } catch { return false }
  })
  const toggleCollapsed = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem('remo:sidebar-collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }, [])
  const [showApiKey, setShowApiKey] = useState(false)
  // Border-drag resizable sidebar width (persisted to localStorage).
  const { width: sidebarWidth, startResize } = useSidebarWidth()

  // Phase 10 — user's global auto-nudge default. Per-session `auto_nudge`
  // overrides this; null/undefined on a session inherits this value. Source of
  // truth is the server (users.auto_nudge_idle_sessions); the legacy
  // `remo:auto-nudge` localStorage key is kept only as an offline fallback.
  const [globalNudgeDefault, setGlobalNudgeDefault] = useState<boolean>(() => {
    try { return localStorage.getItem('remo:auto-nudge') !== 'off' } catch { return true }
  })
  useEffect(() => {
    let cancelled = false
    hubFetch<{ auto_nudge_idle_sessions?: boolean }>(token, '/api/profile')
      .then((p) => {
        if (!cancelled && typeof p.auto_nudge_idle_sessions === 'boolean') {
          setGlobalNudgeDefault(p.auto_nudge_idle_sessions)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  // REVIEW BL-01: shared WS from context.
  const { connected, connectionId, send, subscribe, online } = useWebSocketContext()
  const sessionsHook = useSessions(token)
  const { messages, loading: chatLoading, sendMessage, unreadCounts } = useChat(
    token, activeSessionId, subscribe, send, connectionId
  )
  const activity = useActivity(activeSessionId, subscribe)

  // Handle permission responses
  const handlePermissionRespond = useCallback((requestId: string, approved: boolean) => {
    if (!activeSessionId) return
    send({
      type: 'permission_response',
      session_id: activeSessionId,
      request_id: requestId,
      approved,
    })
  }, [activeSessionId, send])

  // Handle cancel (Stop button)
  const handleCancel = useCallback(() => {
    if (!activeSessionId) return
    send({ type: 'cancel', session_id: activeSessionId })
  }, [activeSessionId, send])

  // Handle question responses
  const handleQuestionRespond = useCallback((requestId: string, answer: string) => {
    if (!activeSessionId) return
    send({
      type: 'question_response',
      session_id: activeSessionId,
      request_id: requestId,
      answer,
    })
  }, [activeSessionId, send])

  // Listen for session status updates
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'session_status') {
        sessionsHook.updateSessionStatus(msg.session_id, msg.status)
      }
      if (msg.type === 'session_list' && msg.sessions) {
        sessionsHook.setSessions(msg.sessions)
      }
    })
  }, [subscribe, sessionsHook.updateSessionStatus, sessionsHook.setSessions])

  // Auto-select the default session ONLY on initial load (when nothing is selected).
  // Default resolution (R-PROFILE-02): prefer the user's orchestrator session,
  // else the first connected session.
  useEffect(() => {
    if (activeSessionId) return
    const onl = connectedSessions(sessionsHook.sessions)
    if (onl.length === 0) return
    const orchestrator = onl.find(s => s.is_orchestrator)
    setActiveSessionId((orchestrator ?? onl[0]).id)
  }, [sessionsHook.sessions, activeSessionId])

  // Auto-nudge on session click (matches Layout behavior).
  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    if (window.innerWidth < 768) {
      setSidebarOpen(false)
    }

    try {
      const target = sessionsHook.sessions.find(s => s.id === id)
      if (!target || target.status !== 'online') return
      // Phase 10 — effective auto-nudge = per-session override, else the user's
      // global default. `auto_nudge` null/undefined means "inherit".
      // CONTRACT: this `?? globalNudgeDefault` resolution is currently CLIENT-ONLY.
      // Any server-side nudge dispatcher MUST resolve
      // `session.auto_nudge ?? user.auto_nudge_idle_sessions` too — never nudge
      // unconditionally (NULL = inherit the per-user default, not "always on").
      const effective = target.auto_nudge ?? globalNudgeDefault
      if (!effective) return
      const lastUserMsg = readLastUserMessage(id)
      if (lastUserMsg) {
        if (lastUserMsg.content === NUDGE_TEXT) return
        if (Date.now() - lastUserMsg.ts <= 6 * 60 * 60 * 1000) return
      }
      setTimeout(() => {
        send({
          type: 'send_message',
          session_id: id,
          content: NUDGE_TEXT,
          id: crypto.randomUUID(),
        })
        recordUserMessage(id, NUDGE_TEXT)
      }, 150)
    } catch {}
  }, [sessionsHook.sessions, send, globalNudgeDefault])

  // Close sidebar on Escape (mobile)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sidebarOpen && window.innerWidth < 768) {
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [sidebarOpen])

  const handleShowConnect = useCallback(() => {
    onNavigate('#/settings?tab=connections')
  }, [onNavigate])

  const activeSession = activeSessionId
    ? sessionsHook.sessions.find(s => s.id === activeSessionId)
    : null

  // Phase-15 spike toggle: render the raw-terminal panel for the active session.
  // Dev/opt-in only (localStorage `remo:pty-interactive` = '1'); full per-session
  // runner-type selection lands in Phase 16.
  const ptyInteractive = (() => {
    try { return localStorage.getItem('remo:pty-interactive') === '1' } catch { return false }
  })()

  return (
    <div className="flex h-full bg-[var(--bg-primary)] relative overflow-hidden">
      {showApiKey && (
        <ApiKeyModal token={token} onClose={() => setShowApiKey(false)} />
      )}

      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="sidebar-overlay fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        style={sidebarCollapsed ? undefined : { ['--sidebar-w' as string]: `${sidebarWidth}px` }}
        className={`
          sidebar-panel fixed inset-y-0 left-0 z-40 ${sidebarCollapsed ? 'w-14' : 'w-72 md:w-[var(--sidebar-w)]'}
          md:relative md:z-0 md:translate-x-0 md:pointer-events-auto
          ${sidebarOpen ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'}
        `}
      >
        {/* Border-drag resize target (desktop only) — the right border IS the
            grab handle (no visible chrome); col-resize cursor on hover. */}
        {!sidebarCollapsed && (
          <div
            onMouseDown={startResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            title="Drag to resize"
            className="hidden md:block absolute top-0 right-0 z-50 h-full w-1.5 translate-x-1/2 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/40 transition-colors"
          />
        )}
        <Sidebar
          sessions={sessionsHook.sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={sessionsHook.deleteSession}
          onDisconnectSession={sessionsHook.disconnectSession}
          onShowConnect={handleShowConnect}
          onShowApiKey={() => setShowApiKey(true)}
          onNavigate={onNavigate}
          onRefresh={sessionsHook.refetch}
          connected={connected}
          user={user}
          signOut={signOut}
          onClose={() => setSidebarOpen(false)}
          unreadCounts={unreadCounts}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleCollapsed}
          token={token}
          subscribe={subscribe}
          cloneHere={sessionsHook.cloneHere}
          globalNudgeDefault={globalNudgeDefault}
          onSetAutoNudge={sessionsHook.setSessionAutoNudge}
        />
      </div>

      {/* Main chat area — NO app header here; AppShell owns it. */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat-specific session strip (kept — it's session chrome, not app chrome). */}
        <div className="relative z-40 flex items-center gap-2 sm:gap-3 px-3 py-2 safe-x border-b border-[var(--border-color)]/40 bg-[var(--bg-secondary)]/40 backdrop-blur-sm shrink-0">
          {/* Mobile (< md): the desktop left sidebar is hidden, so the session
              switcher lives HERE as a top-bar dropdown — the single way to
              browse/switch active sessions on a phone. Reconciles PR #228:
              #228 removed the OLD header dropdown because it duplicated the
              hamburger slide-over; the owner now wants the dropdown to BE the
              switcher, so it returns as primary and the redundant slide-over
              trigger is gone. Per-session management (delete / disconnect /
              auto-nudge) stays reachable via the "manage" affordance, which
              opens the full sidebar slide-over. */}
          <div className="md:hidden flex-1 min-w-0">
            <SessionDropdown
              sessions={sessionsHook.sessions}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              unreadCounts={unreadCounts}
            />
          </div>
          {/* Mobile: open the full sidebar slide-over for per-session controls
              the dropdown doesn't expose (delete / disconnect / auto-nudge). */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-1.5 -mr-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors shrink-0"
            aria-label="Manage sessions"
            title="Manage sessions"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="9" cy="3.5" r="1.3" />
              <circle cx="9" cy="9" r="1.3" />
              <circle cx="9" cy="14.5" r="1.3" />
            </svg>
          </button>
          {/* Desktop (md+): static current-session title — switching happens in
              the always-visible left sidebar, not here. */}
          <div className="hidden md:block flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-secondary)] truncate flex items-center gap-1.5">
              {activeSession ? sessionLabel(activeSession) : 'Remo Code'}
              {activeSession && (
                <span className="text-[10px] text-[var(--text-muted)] font-mono font-normal">
                  {shortId(activeSession)}
                </span>
              )}
            </h2>
            {activeSession?.project_dir && (
              <p className="text-[11px] text-[var(--text-muted)] truncate">{activeSession.project_dir}</p>
            )}
          </div>

          {activeSession && (activeSession.status === 'online' || activeSession.status === 'thinking') ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="hidden sm:inline">Connected</span>
            </span>
          ) : activeSession ? (
            <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]" />
              <span className="hidden sm:inline">Offline</span>
            </span>
          ) : null}
        </div>

        {ptyInteractive && activeSessionId ? (
          // Phase-15 spike: PTY-interactive sessions render the raw-terminal
          // panel instead of the chat bubbles. Gated by a dev toggle
          // (localStorage `remo:pty-interactive`); full per-session selection
          // is Phase 16. Non-PTY sessions keep ChatPanel (Phase 17 deletes it).
          <TerminalSurface sessionId={activeSessionId} subscribe={subscribe} send={send} className="flex-1 min-h-0 p-2" />
        ) : (
          <ChatPanel
            messages={messages}
            loading={chatLoading}
            onSend={sendMessage}
            activeSessionId={activeSessionId}
            sessionStatus={activeSession?.status}
            activity={activity}
            onPermissionRespond={handlePermissionRespond}
            onQuestionRespond={handleQuestionRespond}
            token={token}
            wsConnected={connected}
            online={online}
            onCancel={handleCancel}
          />
        )}
      </div>
    </div>
  )
}

export default ChatLayout
