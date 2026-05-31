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
import { ChatPanel } from './ChatPanel'
import { ApiKeyModal } from './ApiKeyModal'
import { connectedSessions, sessionLabel, shortId } from './SessionDropdown'
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
        className={`
          sidebar-panel fixed inset-y-0 left-0 z-40 ${sidebarCollapsed ? 'w-14' : 'w-72'}
          md:relative md:z-0 md:translate-x-0 md:pointer-events-auto
          ${sidebarOpen ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'}
        `}
      >
        <Sidebar
          sessions={sessionsHook.sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={sessionsHook.deleteSession}
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
        <div className="relative z-40 flex items-center gap-3 px-3 py-2 border-b border-[var(--border-color)]/40 bg-[var(--bg-secondary)]/40 backdrop-blur-sm shrink-0">
          {/* Mobile: hamburger opens the active-session sidebar slide-over —
              the single way to browse/switch sessions on mobile (the old
              header SessionDropdown was redundant with it and was removed).
              Offline / prior sessions are launched from Settings -> Supervisor,
              never the sidebar (the sidebar is active-only by design). */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-1.5 -ml-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors shrink-0"
            aria-label="Open session list"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="5" x2="15" y2="5" />
              <line x1="3" y1="9" x2="15" y2="9" />
              <line x1="3" y1="13" x2="15" y2="13" />
            </svg>
          </button>
          {/* Current-session title (mobile + desktop). On mobile, tap to open
              the session list. Switching happens in the sidebar, not here. */}
          <button
            type="button"
            onClick={() => { if (window.innerWidth < 768) setSidebarOpen(true) }}
            className="flex-1 min-w-0 text-left md:cursor-default md:pointer-events-none"
            aria-label={activeSession ? sessionLabel(activeSession) : 'Remo Code'}
          >
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
          </button>

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
      </div>
    </div>
  )
}

export default ChatLayout
