import { useState, useCallback, useEffect, useRef } from 'react'
import type { AuthUser } from '../lib/auth.ts'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useChat } from '../hooks/useChat'
import { useActivity } from '../hooks/useActivity'
import { useTheme } from '../hooks/useTheme'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './ChatPanel'
import { ApiKeyModal } from './ApiKeyModal'
import { SessionDropdown, connectedSessions, sessionLabel, shortId } from './SessionDropdown'
import { readLastUserMessage, recordUserMessage } from '../lib/lastUserMsg'

const NUDGE_TEXT = "Status update? Briefly: what's the current state, what would you recommend doing next, or what input do you need from me?"

interface Props {
  token: string
  user: AuthUser
  signOut: () => void
  onNavigate: (hash: string) => void
}

export function Layout({ token, user, signOut, onNavigate }: Props) {
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

  const { theme, toggleTheme } = useTheme()
  const { connected, connectionId, send, subscribe, online } = useWebSocket(token)
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

  // Auto-select first connected session ONLY on initial load (when nothing is selected).
  // Never override a user-chosen session — even if it goes offline or another session comes
  // online, the user's selection is sticky. Switching only happens on explicit user action.
  useEffect(() => {
    if (activeSessionId) return
    const online = connectedSessions(sessionsHook.sessions)
    if (online.length > 0) setActiveSessionId(online[0].id)
  }, [sessionsHook.sessions, activeSessionId])

  // Close sidebar on mobile when selecting a session.
  // Auto-nudge: when user clicks an online + idle (not thinking) session,
  // send a brief status-update prompt. Fires on any click (incl. re-selecting
  // the already-active session), throttled per-session (5 min), opt-out via Settings.
  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    if (window.innerWidth < 768) {
      setSidebarOpen(false)
    }

    try {
      const optOut = localStorage.getItem('remo:auto-nudge') === 'off'
      if (optOut) return
      const target = sessionsHook.sessions.find(s => s.id === id)
      // Only nudge when agent is connected AND not currently generating a response.
      if (!target || target.status !== 'online') return
      // Gate: skip if last user message to this session WAS the nudge text (dedupe),
      // and require >6h since the last user message (allow first-time / long-idle).
      const lastUserMsg = readLastUserMessage(id)
      if (lastUserMsg) {
        if (lastUserMsg.content === NUDGE_TEXT) return
        if (Date.now() - lastUserMsg.ts <= 6 * 60 * 60 * 1000) return
      }
      // Defer so activeSessionId state + subscribe effect settle before send.
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
  }, [sessionsHook.sessions, send])

  // Close sidebar on Escape
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
    onNavigate('#/settings?tab=supervisor')
  }, [onNavigate])

  const activeSession = activeSessionId
    ? sessionsHook.sessions.find(s => s.id === activeSessionId)
    : null

  return (
    <div className="flex h-full bg-[var(--bg-primary)] relative overflow-hidden">
      {/* Modals — rendered at top level, above everything */}
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

      {/* Sidebar — desktop only (hidden on mobile, replaced by dropdown) */}
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
        />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="relative z-40 flex items-center gap-3 px-3 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
          {/* Hamburger — desktop only (mobile uses dropdown switcher) */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:inline-flex text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="5" x2="17" y2="5" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="15" x2="17" y2="15" />
            </svg>
          </button>

          {/* Mobile: session dropdown */}
          <div className="md:hidden flex-1 min-w-0">
            <SessionDropdown
              sessions={sessionsHook.sessions}
              activeSessionId={activeSessionId}
              onSelectSession={handleSelectSession}
              unreadCounts={unreadCounts}
            />
          </div>

          {/* Desktop: session name display */}
          <div className="hidden md:block flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-secondary)] truncate flex items-center gap-1.5">
              {activeSession ? sessionLabel(activeSession) : 'Remo Code'}
              {activeSession && <span className="text-[10px] text-[var(--text-muted)] font-mono font-normal">{shortId(activeSession)}</span>}
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

          <button
            onClick={toggleTheme}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 8.5a5.5 5.5 0 1 1-7-7 4.5 4.5 0 0 0 7 7z" />
              </svg>
            )}
          </button>

          <UsageStrip token={token} />
          <ProfileMenu user={user} onNavigate={onNavigate} signOut={signOut} token={token} />
        </header>

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

function ProfileMenu({ user, onNavigate, signOut, token }: { user: AuthUser; onNavigate: (h: string) => void; signOut: () => void; token: string }) {
  const [open, setOpen] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/profile`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (!cancelled && p) setAvatarUrl(p.avatar_url ?? null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const go = (hash: string) => { setOpen(false); onNavigate(hash) }
  const initial = (user.email || '?')[0].toUpperCase()
  const firstName = (() => {
    const dn = (user as any).display_name as string | undefined
    if (dn && dn.trim()) return dn.trim().split(/\s+/)[0]
    const local = (user.email || '').split('@')[0]
    if (!local) return ''
    const seg = local.split(/[._-]/)[0]
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : ''
  })()

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-[var(--bg-tertiary)]/50 transition-colors"
        title={user.email || 'Profile'}
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-[var(--text-on-accent)] text-xs font-medium shrink-0 overflow-hidden">
          {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : initial}
        </span>
        {firstName && (
          <span className="text-sm text-[var(--text-secondary)] font-medium hidden sm:inline">{firstName}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-[var(--text-muted)]">
          <path d="M2.5 4l2.5 2.5L7.5 4" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-56 bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl z-50 py-1"
        >
          <div className="px-3 py-2 border-b border-[var(--border-color)]">
            <div className="text-xs text-[var(--text-muted)]">Signed in as</div>
            <div className="text-sm text-[var(--text-primary)] truncate">{user.email}</div>
          </div>
          <button role="menuitem" onClick={() => go('#/')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Chat</button>
          <button role="menuitem" onClick={() => go('#/grid')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Grid</button>
          <button role="menuitem" onClick={() => go('#/settings?tab=schedules')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Schedules</button>
          <button role="menuitem" onClick={() => go('#/error-capture')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Errors</button>
          <div className="my-1 border-t border-[var(--border-color)]" />
          <button role="menuitem" onClick={() => go('#/settings?tab=profile')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Profile</button>
          <button role="menuitem" onClick={() => go('#/settings')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Settings</button>
          <div className="my-1 border-t border-[var(--border-color)]" />
          <button
            role="menuitem"
            onClick={() => { setOpen(false); signOut() }}
            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
          >Logout</button>
        </div>
      )}
    </div>
  )
}

/* Usage strip — inline cost-today indicator with hover popover for breakdown. */
function UsageStrip({ token }: { token: string }) {
  const [data, setData] = useState<{ cost_usd: number; cap_usd: number; percent: number; timezone: string } | null>(null)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      const hubUrl = import.meta.env.VITE_HUB_URL || ''
      fetch(`${hubUrl}/api/profile/cost-today`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (!cancelled && d) setData(d) })
        .catch(() => {})
    }
    load()
    const iv = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [token])

  if (!data) return null
  const pct = Math.round(data.percent)
  const color = pct < 50 ? 'text-emerald-300' : pct < 80 ? 'text-amber-300' : 'text-red-300'
  const barColor = pct < 50 ? 'bg-emerald-400' : pct < 80 ? 'bg-amber-400' : 'bg-red-400'

  return (
    <div
      className="hidden sm:flex relative items-center gap-2 px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors cursor-default"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Today's usage"
    >
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">Today</span>
      <span className={`text-xs font-mono ${color}`}>${data.cost_usd.toFixed(2)}</span>
      <span className="w-16 h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <span className={`block h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {hover && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl z-50 p-3 text-xs space-y-1.5">
          <div className="flex justify-between"><span className="text-[var(--text-muted)]">Today's cost</span><span className={`font-mono ${color}`}>${data.cost_usd.toFixed(4)}</span></div>
          <div className="flex justify-between"><span className="text-[var(--text-muted)]">Daily cap</span><span className="font-mono text-[var(--text-secondary)]">${data.cap_usd.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-[var(--text-muted)]">Used</span><span className={`font-mono ${color}`}>{pct}%</span></div>
          <div className="flex justify-between"><span className="text-[var(--text-muted)]">Timezone</span><span className="font-mono text-[var(--text-secondary)]">{data.timezone}</span></div>
          <div className="pt-1.5 border-t border-[var(--border-color)]/50 text-[10px] text-[var(--text-muted)]">
            Scheduled tasks pause when cap is reached. Manual chat is not affected.
          </div>
        </div>
      )}
    </div>
  )
}
