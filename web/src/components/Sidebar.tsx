import { useState } from 'react'
import type { User } from '@supabase/supabase-js'
import type { CodeSession } from '../hooks/useSessions'
import { ConnectModal } from './ConnectModal'

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateSession: (name: string, projectDir?: string) => Promise<any>
  onDeleteSession: (id: string) => Promise<void>
  connected: boolean
  user: User
  signOut: () => void
}

interface NewSessionData {
  token: string
  name: string
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onCreateSession, onDeleteSession,
  connected, user, signOut,
}: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSession, setNewSession] = useState<NewSessionData | null>(null)

  const handleCreate = async () => {
    if (!newName.trim()) return
    const name = newName.trim()
    const result = await onCreateSession(name)
    if (result?.token) {
      setNewSession({ token: result.token, name })
    }
    setNewName('')
    setShowCreate(false)
  }

  return (
    <>
      {newSession && (
        <ConnectModal
          token={newSession.token}
          sessionName={newSession.name}
          onClose={() => setNewSession(null)}
        />
      )}

      <div className="w-72 border-r border-slate-700 flex flex-col bg-slate-800/30 shrink-0">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-lg font-bold text-white">Remo Code</h1>
          <p className="text-xs text-slate-500 mt-1 truncate">{user.email}</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => onSelectSession(s.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                s.id === activeSessionId
                  ? 'bg-indigo-600/30 text-white'
                  : 'text-slate-300 hover:bg-slate-700/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  s.status === 'online' ? 'bg-emerald-400' :
                  s.status === 'thinking' ? 'bg-amber-400 animate-pulse' :
                  'bg-slate-600'
                }`} />
                <span className="truncate font-medium">{s.name}</span>
              </div>
              {s.project_dir && (
                <div className="text-xs text-slate-500 mt-0.5 truncate pl-4">
                  {s.project_dir}
                </div>
              )}
            </button>
          ))}

          {sessions.length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">
              No sessions yet. Create one to get started.
            </p>
          )}
        </div>

        {/* Create session */}
        <div className="p-3 border-t border-slate-700">
          {showCreate ? (
            <div className="space-y-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="Session name..."
                className="w-full px-3 py-1.5 bg-slate-700 border border-slate-600 rounded text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded text-sm text-white"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName('') }}
                  className="px-3 py-1.5 text-slate-400 hover:text-white text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full py-2 text-sm text-indigo-400 hover:text-indigo-300 hover:bg-slate-700/50 rounded-lg transition-colors"
            >
              + New Session
            </button>
          )}
        </div>

        <div className="p-3 border-t border-slate-700">
          <button
            onClick={signOut}
            className="w-full py-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </>
  )
}
