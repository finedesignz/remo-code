import { useState } from 'react'
import type { User } from '@supabase/supabase-js'
import type { CodeSession } from '../hooks/useSessions'
import { sessionLabel, connectedSessions } from './SessionDropdown'

export interface ConnectData {
  token: string
  name: string
}

interface Props {
  sessions: CodeSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onCreateSession: (name: string, projectDir?: string) => Promise<any>
  onDeleteSession: (id: string) => Promise<void>
  onRotateToken: (id: string) => Promise<{ token: string } | null>
  onShowConnect: (data: ConnectData) => void
  onShowApiKey: () => void
  onNavigate: (hash: string) => void
  connected: boolean
  user: User
  signOut: () => void
  onClose?: () => void
}

export function Sidebar({
  sessions, activeSessionId, onSelectSession,
  onCreateSession, onDeleteSession, onRotateToken, onShowConnect, onShowApiKey,
  onNavigate,
  connected, user, signOut, onClose,
}: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')

  const handleCreate = async () => {
    if (!newName.trim()) return
    const name = newName.trim()
    const result = await onCreateSession(name)
    if (result?.token) {
      onShowConnect({ token: result.token, name })
    }
    setNewName('')
    setShowCreate(false)
  }

  const handleReconnect = async (session: CodeSession) => {
    const result = await onRotateToken(session.id)
    if (result?.token) {
      onShowConnect({ token: result.token, name: session.name })
    }
  }

  return (
      <div className="w-72 h-full border-r border-slate-700/80 flex flex-col bg-slate-900 md:bg-slate-800/30 shrink-0">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-700/80">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-6 w-6 object-contain" />
              <h1 className="text-lg font-bold text-white">Remo Code</h1>
            </div>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{user.email}</p>
          </div>
          <button
            onClick={onClose}
            className="md:hidden p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700/50 transition-colors"
            aria-label="Close sidebar"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
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
                    ? 'bg-indigo-600/20 text-white ring-1 ring-indigo-500/30'
                    : 'text-slate-300 hover:bg-slate-700/50 active:bg-slate-700/70'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                  }`} />
                  <span className="truncate font-medium flex-1">{sessionLabel(s)}</span>
                  {/* Action buttons — always visible on mobile, hover on desktop */}
                  <span className="flex md:hidden md:group-hover:flex items-center gap-1 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReconnect(s) }}
                      className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-slate-400 hover:text-indigo-300 bg-slate-700/80 hover:bg-slate-600/80 rounded transition-colors"
                      title="Get new connection token"
                      aria-label={`Reconnect ${sessionLabel(s)}`}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M1 4v-3h3" /><path d="M3.51 11a7 7 0 0 0 12.13-3.5" />
                        <path d="M15 12v3h-3" /><path d="M12.49 5a7 7 0 0 0-12.13 3.5" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); if (confirm(`Delete session "${sessionLabel(s)}"?`)) onDeleteSession(s.id) }}
                      className="p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-slate-400 hover:text-red-400 bg-slate-700/80 hover:bg-red-900/50 rounded transition-colors"
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
                  <div className="text-[11px] text-slate-500 mt-0.5 truncate pl-4">
                    {s.project_dir}
                  </div>
                )}
              </button>
            </div>
          ))}

          {connectedSessions(sessions).length === 0 && (
            <p className="text-sm text-slate-500 text-center py-8">
              No active sessions. Connect a Claude Code instance to get started.
            </p>
          )}
        </div>

        {/* Create session */}
        <div className="p-3 border-t border-slate-700/80">
          {showCreate ? (
            <div className="space-y-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="Session name..."
                className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-white font-medium transition-colors"
                >
                  Create
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewName('') }}
                  className="px-3 py-2 text-slate-400 hover:text-white text-sm transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full py-2.5 text-sm text-indigo-400 hover:text-indigo-300 hover:bg-slate-700/50 rounded-lg transition-colors font-medium"
            >
              + New Session
            </button>
          )}
        </div>

        <div className="p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-slate-700/80 flex items-center gap-1">
          <button
            onClick={() => onNavigate('#/settings')}
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-indigo-300 transition-colors rounded-lg hover:bg-slate-700/50"
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
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-indigo-300 transition-colors rounded-lg hover:bg-slate-700/50"
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
            className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors rounded-lg hover:bg-slate-700/50"
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
