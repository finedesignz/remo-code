import { useState, useCallback, useEffect } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useChat } from '../hooks/useChat'
import { Sidebar, type ConnectData } from './Sidebar'
import { ChatPanel } from './ChatPanel'
import { ConnectModal } from './ConnectModal'
import { ApiKeyModal } from './ApiKeyModal'

interface Props {
  session: Session
  user: User
  signOut: () => void
}

export function Layout({ session, user, signOut }: Props) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [connectData, setConnectData] = useState<ConnectData | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)

  const { connected, send, subscribe } = useWebSocket(session)
  const sessionsHook = useSessions(session)
  const { messages, loading: chatLoading, sendMessage } = useChat(
    session, activeSessionId, subscribe, send
  )

  // Listen for session status updates
  subscribe((msg) => {
    if (msg.type === 'session_status') {
      sessionsHook.updateSessionStatus(msg.session_id, msg.status)
    }
    if (msg.type === 'session_list') {
      sessionsHook.refetch()
    }
  })

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

  const activeSession = activeSessionId
    ? sessionsHook.sessions.find(s => s.id === activeSessionId)
    : null

  return (
    <div className="flex h-full bg-slate-900 relative overflow-hidden">
      {/* Modals — rendered at top level, above everything */}
      {showApiKey && (
        <ApiKeyModal session={session} onClose={() => setShowApiKey(false)} />
      )}
      {connectData && (
        <ConnectModal
          token={connectData.token}
          sessionName={connectData.name}
          onClose={() => setConnectData(null)}
        />
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
          sidebar-panel fixed inset-y-0 left-0 z-40 w-72
          md:relative md:z-0 md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <Sidebar
          sessions={sessionsHook.sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onCreateSession={sessionsHook.createSession}
          onDeleteSession={sessionsHook.deleteSession}
          onRotateToken={sessionsHook.rotateToken}
          onShowConnect={setConnectData}
          onShowApiKey={() => setShowApiKey(true)}
          connected={connected}
          user={user}
          signOut={signOut}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center gap-3 px-3 py-2.5 border-b border-slate-700/80 bg-slate-800/60 backdrop-blur-sm shrink-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-700/50 transition-colors"
            aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="3" y1="5" x2="17" y2="5" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="15" x2="17" y2="15" />
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-slate-200 truncate">
              {activeSession?.name || 'Remo Code'}
            </h2>
            {activeSession?.project_dir && (
              <p className="text-[11px] text-slate-500 truncate">{activeSession.project_dir}</p>
            )}
          </div>
          {connected && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-400 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="hidden sm:inline">Connected</span>
            </span>
          )}
        </header>

        <ChatPanel
          messages={messages}
          loading={chatLoading}
          onSend={sendMessage}
          activeSessionId={activeSessionId}
        />
      </div>
    </div>
  )
}
