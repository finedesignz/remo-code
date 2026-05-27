import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { AuthUser } from '../lib/auth.ts'
import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { useTheme } from '../hooks/useTheme'
import { Sidebar } from './Sidebar'
import { ApiKeyModal } from './ApiKeyModal'
import { SessionDropdown, connectedSessions } from './SessionDropdown'
import { UsageStrip } from './UsageStrip'
import { hubFetch } from '../lib/api'
import { useLicense, type LicenseStatus } from '../hooks/useLicense'
import { titaniumPortalUrl } from '../lib/auth'

function licenseDotClass(s: LicenseStatus): string {
  switch (s) {
    case 'active': return 'bg-emerald-400'
    case 'expired': return 'bg-amber-400'
    case 'suspended':
    case 'banned': return 'bg-red-400'
    case 'none': return 'bg-[var(--text-muted)]'
    default: return 'bg-transparent'
  }
}

function licenseTextClass(s: LicenseStatus): string {
  switch (s) {
    case 'active': return 'text-emerald-400'
    case 'expired': return 'text-amber-400'
    case 'suspended':
    case 'banned': return 'text-red-400'
    default: return 'text-[var(--text-muted)]'
  }
}

/**
 * Shared application chrome: sidebar + top header (theme toggle + usage strip + profile menu).
 * Wraps every authenticated route so the app feels uniform.
 *
 * The chat view (`Layout`) renders its own header inline because it needs session-aware
 * controls. Non-chat routes (Settings, Schedules, ErrorCapture, Grid) pass through this
 * component with `headerContent` set to a simple page title.
 */
interface Props {
  token: string
  user: AuthUser
  signOut: () => void
  onNavigate: (hash: string) => void
  /** Inline header content (page title or custom header element). */
  headerContent?: ReactNode
  /** Page body. */
  children: ReactNode
  /** When the route already owns its full header (chat view), set to true to suppress the shared one. */
  ownHeader?: boolean
}

export function AppChrome({ token, user, signOut, onNavigate, headerContent, children, ownHeader = false }: Props) {
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
  const { connected, subscribe } = useWebSocket(token)
  const sessionsHook = useSessions(token)

  // Sidebar's selectSession nav: routes to chat view with session selected via hash.
  // The chat view's Layout will pick this up.
  const handleSelectSession = useCallback((id: string) => {
    if (window.innerWidth < 768) setSidebarOpen(false)
    // Store the desired active session for the chat view to consume.
    try { sessionStorage.setItem('remo:next-active-session', id) } catch {}
    onNavigate('#/')
  }, [onNavigate])

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

  return (
    <div className="flex h-full bg-[var(--bg-primary)] relative overflow-hidden">
      {showApiKey && (
        <ApiKeyModal token={token} onClose={() => setShowApiKey(false)} />
      )}

      {sidebarOpen && (
        <div
          className="sidebar-overlay fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`
          sidebar-panel fixed inset-y-0 left-0 z-40 ${sidebarCollapsed ? 'w-14' : 'w-72'}
          md:relative md:z-0 md:translate-x-0 md:pointer-events-auto
          ${sidebarOpen ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'}
        `}
      >
        <Sidebar
          sessions={sessionsHook.sessions}
          activeSessionId={null}
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
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleCollapsed}
          token={token}
          subscribe={subscribe}
          launchSession={sessionsHook.launchSession}
          cloneHere={sessionsHook.cloneHere}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {!ownHeader && (
          <header className="relative z-40 flex items-center gap-3 px-3 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
            {/* Mobile: session dropdown (so users can hop back to a chat) */}
            <div className="md:hidden flex-1 min-w-0">
              <SessionDropdown
                sessions={sessionsHook.sessions}
                activeSessionId={null}
                onSelectSession={handleSelectSession}
              />
            </div>

            <div className="hidden md:flex flex-1 min-w-0 items-center">
              {headerContent ?? <h2 className="text-sm font-semibold text-[var(--text-secondary)] truncate">Remo Code</h2>}
            </div>

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

            <UsageStrip subscribe={subscribe} />
            <ProfileMenu user={user} onNavigate={onNavigate} signOut={signOut} token={token} />
          </header>
        )}

        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </div>
      </div>
    </div>
  )
}

// Re-export so Layout can keep using the same trigger.
export { connectedSessions }

function ProfileMenu({ user, onNavigate, signOut, token }: { user: AuthUser; onNavigate: (h: string) => void; signOut: () => void; token: string }) {
  const [open, setOpen] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const { license } = useLicense(token)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    hubFetch<{ avatar_url?: string | null }>(token, '/api/profile')
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
        <span className="relative w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-[var(--text-on-accent)] text-xs font-medium shrink-0 overflow-hidden">
          {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : initial}
          {license && license.status !== 'unknown' && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--bg-primary)] ${licenseDotClass(license.status)}`}
              title={`License: ${license.status}`}
            />
          )}
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
            {license && license.status !== 'unknown' && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${licenseDotClass(license.status)}`} />
                <span className={`text-[11px] ${licenseTextClass(license.status)}`}>License: {license.status}</span>
              </div>
            )}
          </div>
          <button role="menuitem" onClick={() => go('#/')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Chat</button>
          <button role="menuitem" onClick={() => go('#/grid')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Grid</button>
          <button role="menuitem" onClick={() => go('#/settings?tab=schedules')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Schedules</button>
          <button role="menuitem" onClick={() => go('#/error-capture')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Errors</button>
          <div className="my-1 border-t border-[var(--border-color)]" />
          <button role="menuitem" onClick={() => go('#/settings?tab=profile')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Profile</button>
          <button role="menuitem" onClick={() => go('#/settings')} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors">Settings</button>
          <div className="my-1 border-t border-[var(--border-color)]" />
          <a
            role="menuitem"
            href={`${titaniumPortalUrl()}/account`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)] transition-colors"
            onClick={() => setOpen(false)}
          >Manage account in Titanium ↗</a>
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
