import { useState } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useChat } from '../hooks/useChat'
import { Sidebar } from './Sidebar'
import { ChatPanel } from './ChatPanel'

interface Props {
  session: Session
  user: User
  signOut: () => void
}

export function Layout({ session, user, signOut }: Props) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

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

  return (
    <div className="flex h-screen bg-slate-900">
      {sidebarOpen && (
        <Sidebar
          sessions={sessionsHook.sessions}
          activeSessionId={activeSessionId}
          onSelectSession={setActiveSessionId}
          onCreateSession={sessionsHook.createSession}
          onDeleteSession={sessionsHook.deleteSession}
          connected={connected}
          user={user}
          signOut={signOut}
        />
      )}
      <div className="flex-1 flex flex-col">
        <header className="flex items-center gap-3 px-4 py-2 border-b border-slate-700 bg-slate-800/50">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-slate-400 hover:text-white p-1"
          >
            {sidebarOpen ? '\u2190' : '\u2192'}
          </button>
          <h2 className="text-sm font-medium text-slate-300">
            {activeSessionId
              ? sessionsHook.sessions.find(s => s.id === activeSessionId)?.name || 'Session'
              : 'Select a session'}
          </h2>
          {connected && (
            <span className="ml-auto text-xs text-emerald-400">Connected</span>
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
