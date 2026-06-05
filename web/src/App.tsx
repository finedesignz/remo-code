import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { Login } from './pages/Login'
import { AuthCallback } from './pages/AuthCallback'
import { SetupForm } from './components/SetupForm'
import { HomePage } from './pages/HomePage'
import { TasksPage } from './pages/TasksPage'
import { ActivityPage } from './pages/ActivityPage'
import { SettingsPage } from './pages/SettingsPage'
import { ChatSurfaceShowcase } from './components/ChatSurfaceShowcase'
import { MobileAccordionShowcase } from './components/MobileAccordionShowcase'
import { Privacy } from './pages/Privacy'
import { Terms } from './pages/Terms'
import { WebSocketProvider, useWebSocketContext } from './hooks/useWebSocket'
import { useBrowserNotifications } from './hooks/useBrowserNotifications'
import type { Profile } from './hooks/useProfile'
import { onAuthEvent } from './lib/api'

type Route =
  | 'home'
  | 'tasks'
  | 'activity'
  | 'settings'
  | 'privacy'
  | 'terms'
  | 'dev-chat-surface'
  | 'dev-mobile-accordion'
  | 'login'
  | 'auth-callback'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
      <div className="text-[var(--text-muted)]">Loading...</div>
    </div>
  )
}

// Hash-router app: the SPA fallback serves index.html for ANY pathname, so URLs
// like `/login#/settings?tab=supervisor` (stale bookmarks, external links, or
// browser autocomplete) leave a stray pathname that confuses users post-login.
// Normalize pathname to `/` on boot while preserving hash + search.
if (typeof window !== 'undefined' && window.location.pathname !== '/') {
  window.history.replaceState(null, '', '/' + window.location.search + window.location.hash)
}

/**
 * Phase 12 W3 — Deep-link redirects. These map every legacy hash to the new
 * Home/Tasks/Settings shells while preserving back-button history (replaceState
 * not assign). They are kept FOREVER — scheduled-task `{{run_url}}` template
 * emails embed these paths.
 *
 * Returns the canonical hash AFTER redirect resolution.
 */
// Pure hash→canonical-hash mapping (no DOM). Exported for unit tests.
export function canonicalizeHash(hash: string): string {
  let canonical = hash || '#/'

  // Tasks collapsed to a single page; Activity is parked at #/activity.
  // #/tasks?tab=activity → #/activity (back-compat for old deep links/bookmarks)
  if (/^#\/tasks(\?|&).*\btab=activity\b/.test(hash)) canonical = '#/activity'
  // #/schedules → #/tasks (sub-tabs gone)
  else if (hash.startsWith('#/schedules')) canonical = '#/tasks'
  // #/error-capture → #/activity (the run-feed surface)
  else if (hash.startsWith('#/error-capture')) canonical = '#/activity'
  // #/revanote → #/settings?tab=connections
  else if (hash.startsWith('#/revanote')) canonical = '#/settings?tab=connections'
  // Legacy #/supervisor → #/settings?tab=connections (was supervisor tab)
  else if (hash.startsWith('#/supervisor')) canonical = '#/settings?tab=connections'
  // #/grid/:tabId → #/?tab=grid&grid_tab=:tabId
  else {
    const gm = hash.match(/^#\/grid\/([^/?#]+)/)
    if (gm) canonical = `#/?tab=grid&grid_tab=${encodeURIComponent(gm[1])}`
    // bare #/grid → #/?tab=grid
    else if (hash === '#/grid' || hash.startsWith('#/grid?')) {
      const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
      canonical = q ? `#/?tab=grid&${q}` : '#/?tab=grid'
    }
  }
  return canonical
}

function resolveHashWithRedirects(): string {
  const hash = window.location.hash
  const canonical = canonicalizeHash(hash)

  if (canonical !== hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search + canonical)
  }
  return canonical
}

// Pure: reads the (already-redirect-resolved) hash and maps it to a Route.
// Redirect resolution is a side-effect (history.replaceState) and lives in
// `resolveHashWithRedirects`, called once at module load and on every
// hashchange — never inside a render-phase state initializer.
function getRoute(): Route {
  const hash = window.location.hash || '#/'
  if (hash.startsWith('#/auth/callback')) return 'auth-callback'
  if (hash.startsWith('#/login')) return 'login'
  if (hash.startsWith('#/tasks')) return 'tasks'
  if (hash.startsWith('#/activity')) return 'activity'
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/privacy')) return 'privacy'
  if (hash.startsWith('#/terms')) return 'terms'
  if (hash.startsWith('#/dev/chat-surface')) return 'dev-chat-surface'
  if (hash.startsWith('#/dev/mobile-accordion')) return 'dev-mobile-accordion'
  // #/, #/home, #/?tab=list, #/?tab=grid all map to home.
  return 'home'
}

// Resolve legacy-hash redirects ONCE at module load (mirrors the pathname
// normalize above). After this, `getRoute()` can read the canonical hash purely.
if (typeof window !== 'undefined') {
  resolveHashWithRedirects()
}

function getGridTabId(): string | undefined {
  const hash = window.location.hash
  const m = hash.match(/[?&]grid_tab=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

export default function App() {
  const { user, token, loading, signIn, signOut } = useAuth()
  const { profile, loading: profileLoading, updateProfile } = useProfile(token)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [route, setRoute] = useState<Route>(getRoute)
  const [gridTabId, setGridTabId] = useState<string | undefined>(getGridTabId)
  const [licenseRequired, setLicenseRequired] = useState(false)
  // Latch so a burst of concurrent 401s (every in-flight hubFetch fires
  // authEventHandler) triggers signOut() — and its single POST /api/auth/logout
  // — exactly once. Reset once token+user have cleared so a later genuine
  // re-login can sign out again. Does NOT change the self-terminating behavior:
  // signOut still fires, just not N times per dead-credential burst.
  const signingOut = useRef(false)

  useEffect(() => {
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/setup/status`)
      .then(r => r.json())
      .then(data => setNeedsSetup(data.needs_setup))
      .catch(() => setNeedsSetup(false))
  }, [])

  // Hash-based routing
  useEffect(() => {
    const onHashChange = () => { resolveHashWithRedirects(); setRoute(getRoute()); setGridTabId(getGridTabId()) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Centralized auth-event handler — fires on any hubFetch 401/402.
  useEffect(() => {
    onAuthEvent((kind) => {
      if (kind === 'unauthorized') {
        // A 401 means the credential is dead. Clearing token/user (signOut)
        // is what makes the `!token || !user` render gate take the <Login>
        // branch — a bare `hash = '#/login'` left the stale token truthy and
        // fell through to the authenticated render block, which has no
        // 'login' case → blank screen. signOut() also sets hash=#/login, so
        // the redirect is preserved. Guarded by route so we don't loop while
        // already on login/auth-callback. apiLogout() inside signOut uses a
        // bare fetch (NOT hubFetch), so it can't re-fire this handler.
        if (!signingOut.current && route !== 'login' && route !== 'auth-callback') {
          signingOut.current = true
          signOut()
        }
      } else if (kind === 'license_required') {
        setLicenseRequired(true)
      }
    })
    return () => onAuthEvent(null)
  }, [route, signOut])

  // Dead-credential cleanup. If the profile load has SETTLED (not loading) but
  // produced no profile while a token/user is still present, the credential is
  // dead — a 401 the global onAuthEvent handler may have missed due to the
  // effect-registration race. Clear it here (signOut, NOT during render) so the
  // WS and other hooks stop hammering 401 with the stale token. signOut clears
  // token+user → the `(token || user)` condition becomes false on the next
  // render → this effect no-ops → no loop. The `!profile` render branch above
  // shows Login in the meantime.
  useEffect(() => {
    if (!profileLoading && !profile && (token || user)) {
      if (!signingOut.current) {
        signingOut.current = true
        signOut()
      }
    } else if (!token && !user) {
      // Credential fully cleared (or never present) — release the latch so a
      // future re-login can sign out again on its own dead-credential event.
      signingOut.current = false
    }
  }, [profileLoading, profile, token, user, signOut])

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash
  }, [])

  if (route === 'auth-callback') {
    return <AuthCallback />
  }

  if (loading || needsSetup === null) {
    return <LoadingScreen />
  }

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  // Defensive: the login route is self-sufficient regardless of token state.
  // Even if some path leaves a stale token truthy, `#/login` must render the
  // Login page — never fall through to the authenticated block (which has no
  // 'login' case and would render a blank <WebSocketProvider>).
  if (route === 'login') {
    return <Login onLegacyAuth={signIn} />
  }

  if (!token || !user) {
    return <Login onLegacyAuth={signIn} />
  }

  if (profileLoading) {
    return <LoadingScreen />
  }

  if (!profile) {
    // Profile finished loading but is null → the token is dead (a 401 the
    // global onAuthEvent handler may have missed due to the registration race
    // between useProfile's fetch effect and App's onAuthEvent effect). Treat as
    // unauthenticated and render Login deterministically rather than trapping
    // on LoadingScreen forever. The effect below clears the dead credential.
    return <Login onLegacyAuth={signIn} />
  }

  return (
    // REVIEW BL-01: single shared /ws/client connection for all consumers
    // (NotificationsBridge + page route + chat surfaces).
    <WebSocketProvider token={token}>
      <NotificationsBridge profile={profile} />
      {licenseRequired && <LicenseRequiredBanner onDismiss={() => setLicenseRequired(false)} />}

      {route === 'home' && (
        <HomePage token={token} user={user} signOut={signOut} onNavigate={navigate} gridTabId={gridTabId} />
      )}
      {route === 'tasks' && (
        <TasksPage token={token} user={user} signOut={signOut} onNavigate={navigate} />
      )}
      {route === 'activity' && (
        <ActivityPage token={token} user={user} signOut={signOut} onNavigate={navigate} />
      )}
      {route === 'settings' && (
        <SettingsPage
          token={token}
          user={user}
          profile={profile}
          signOut={signOut}
          onNavigate={navigate}
          onUpdateProfile={updateProfile}
        />
      )}
      {route === 'dev-chat-surface' && <ChatSurfaceShowcase token={token} />}
      {route === 'dev-mobile-accordion' && <MobileAccordionShowcase token={token} />}
      {route === 'privacy' && <Privacy />}
      {route === 'terms' && <Terms />}
    </WebSocketProvider>
  )
}

function LicenseRequiredBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="fixed top-0 inset-x-0 z-[100] bg-amber-500/15 text-amber-200 px-4 py-2 text-xs flex items-center gap-3 justify-center">
      <span>
        A Titanium license is required to perform this action.
        <a
          href={`${(import.meta as any).env?.VITE_TITANIUM_PORTAL_URL || 'https://license.titaniumlabs.us'}/account`}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-2 underline hover:text-amber-100"
        >
          Manage license ↗
        </a>
      </span>
      <button onClick={onDismiss} className="ml-2 text-amber-300 hover:text-amber-100" aria-label="Dismiss">×</button>
    </div>
  )
}

function NotificationsBridge({ profile }: { profile: Profile }) {
  // REVIEW BL-01: reads the shared WS from context — no second connection.
  const { subscribe } = useWebSocketContext()
  useBrowserNotifications({ subscribe, profile })
  return null
}
