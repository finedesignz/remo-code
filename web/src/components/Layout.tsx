import { useState, useCallback, useEffect } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useChat } from '../hooks/useChat'
import { useActivity } from '../hooks/useActivity'
import { useTheme } from '../hooks/useTheme'
import { useApiKey } from '../hooks/useApiKey'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './ChatPanel'
import { ConnectModal } from './ConnectModal'
import { ApiKeyModal } from './ApiKeyModal'
import { SessionDropdown, connectedSessions, sessionLabel, shortId } from './SessionDropdown'

interface Props {
  session: Session
  user: User
  signOut: () => void
  onNavigate: (hash: string) => void
}

export function Layout({ session, user, signOut, onNavigate }: Props) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [showConnect, setShowConnect] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  const { theme, toggleTheme } = useTheme()
  const { connected, connectionId, send, subscribe } = useWebSocket(session)
  const sessionsHook = useSessions(session)
  const { messages, loading: chatLoading, sendMessage, unreadCounts } = useChat(
    session, activeSessionId, subscribe, send, connectionId
  )
  const activity = useActivity(activeSessionId, subscribe)
  const { activeKey, generateKey } = useApiKey(session)

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

  // Auto-select first connected session when none is selected (or current goes offline)
  useEffect(() => {
    const online = connectedSessions(sessionsHook.sessions)
    if (activeSessionId) {
      // If the active session is still connected, keep it
      if (online.some(s => s.id === activeSessionId)) return
    }
    // Select the first connected session, or null if none
    setActiveSessionId(online.length > 0 ? online[0].id : null)
  }, [sessionsHook.sessions, activeSessionId])

  // Close sidebar on mobile when selecting a session
  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    if (window.innerWidth < 768) {
      setSidebarOpen(false)
    }
  }, [])

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

  // Handle showing connect modal — generate API key if none exists
  const [connectApiKey, setConnectApiKey] = useState<string | null>(null)

  const handleShowConnect = useCallback(() => {
    setShowConnect(true)
  }, [])

  const activeSession = activeSessionId
    ? sessionsHook.sessions.find(s => s.id === activeSessionId)
    : null

  return (
    <div className="flex h-full bg-[var(--bg-primary)] relative overflow-hidden">
      {/* Modals — rendered at top level, above everything */}
      {showApiKey && (
        <ApiKeyModal session={session} onClose={() => setShowApiKey(false)} />
      )}
      {showConnect && (
        <ConnectModal
          apiKey={connectApiKey || undefined}
          onGenerateKey={generateKey}
          onClose={() => { setShowConnect(false); setConnectApiKey(null) }}
        />
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
          sidebar-panel fixed inset-y-0 left-0 z-40 w-72
          md:relative md:z-0 md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
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
        />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-3 px-3 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
          {/* Hamburger — opens sidebar (settings/create/manage sessions) */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
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

          <button
            onClick={() => onNavigate('#/settings')}
            className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-[var(--text-on-accent)] text-sm font-medium shrink-0 hover:bg-indigo-500 transition-colors"
            title={user.email || 'Profile'}
            aria-label="Profile settings"
          >
            {(user.email || '?')[0].toUpperCase()}
          </button>
        </header>

        <ChatPanel
          messages={messages}
          loading={chatLoading}
          onSend={sendMessage}
          activeSessionId={activeSessionId}
          sessionStatus={activeSession?.status}
          activity={activity}
        />
      </div>
    </div>
  )
}
