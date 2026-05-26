import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { Login } from './pages/Login'
import { AuthCallback } from './pages/AuthCallback'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'
import { SettingsPage } from './components/SettingsPage'
import { SchedulesPage } from './components/SchedulesPage'
import { ErrorCapturePage } from './components/ErrorCapturePage'
import { ChatSurfaceShowcase } from './components/ChatSurfaceShowcase'
import { MobileAccordionShowcase } from './components/MobileAccordionShowcase'
import { GridPage } from './components/GridPage'
import { Footer } from './components/Footer'
import { Privacy } from './pages/Privacy'
import { Terms } from './pages/Terms'
import { useWebSocket } from './hooks/useWebSocket'
import { useBrowserNotifications } from './hooks/useBrowserNotifications'
import type { Profile } from './hooks/useProfile'
import { onAuthEvent } from './lib/api'

type Route =
  | 'chat'
  | 'settings'
  | 'schedules'
  | 'error-capture'
  | 'grid'
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

function getRoute(): Route {
  const hash = window.location.hash
  if (hash.startsWith('#/auth/callback')) return 'auth-callback'
  if (hash.startsWith('#/login')) return 'login'
  // Legacy /#/supervisor → settings with supervisor tab
  if (hash.startsWith('#/supervisor')) {
    window.location.hash = '#/settings?tab=supervisor'
    return 'settings'
  }
  if (hash.startsWith('#/settings')) return 'settings'
  // Legacy /#/schedules → settings with schedules tab
  if (hash.startsWith('#/schedules')) {
    window.location.hash = '#/settings?tab=schedules'
    return 'settings'
  }
  if (hash.startsWith('#/error-capture')) return 'error-capture'
  if (hash.startsWith('#/grid')) return 'grid'
  if (hash.startsWith('#/privacy')) return 'privacy'
  if (hash.startsWith('#/terms')) return 'terms'
  if (hash.startsWith('#/dev/chat-surface')) return 'dev-chat-surface'
  if (hash.startsWith('#/dev/mobile-accordion')) return 'dev-mobile-accordion'
  return 'chat'
}

function getGridTabId(): string | undefined {
  const hash = window.location.hash
  const m = hash.match(/^#\/grid\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]) : undefined
}

export default function App() {
  const { user, token, loading, signIn, signOut } = useAuth()
  const { profile, loading: profileLoading, updateProfile } = useProfile(token)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [route, setRoute] = useState<Route>(getRoute)
  const [gridTabId, setGridTabId] = useState<string | undefined>(getGridTabId)
  const [licenseRequired, setLicenseRequired] = useState(false)

  useEffect(() => {
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/setup/status`)
      .then(r => r.json())
      .then(data => setNeedsSetup(data.needs_setup))
      .catch(() => setNeedsSetup(false))
  }, [])

  // Hash-based routing
  useEffect(() => {
    const onHashChange = () => { setRoute(getRoute()); setGridTabId(getGridTabId()) }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Centralized auth-event handler — fires on any hubFetch 401/402.
  useEffect(() => {
    onAuthEvent((kind) => {
      if (kind === 'unauthorized') {
        // Session is gone — punt back to login. Stay silent on re_auth_required
        // (the calling component is expected to handle it locally).
        if (route !== 'login' && route !== 'auth-callback') {
          window.location.hash = '#/login'
        }
      } else if (kind === 'license_required') {
        setLicenseRequired(true)
      }
    })
    return () => onAuthEvent(null)
  }, [route])

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash
  }, [])

  const goToChat = useCallback(() => {
    window.location.hash = '#/'
  }, [])

  // Auth-callback page must render regardless of session state — that's the whole point.
  if (route === 'auth-callback') {
    return <AuthCallback />
  }

  if (loading || needsSetup === null) {
    return <LoadingScreen />
  }

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  // Unauth → login page. Soak window: useAuth may already have a localStorage
  // token + user, so we still treat that as signed-in for the legacy path.
  if (!token || !user) {
    return <Login onLegacyAuth={signIn} />
  }

  // Wait for profile to load before rendering gated routes
  if (profileLoading || !profile) {
    return <LoadingScreen />
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <NotificationsBridge token={token} profile={profile} />
      {licenseRequired && <LicenseRequiredBanner onDismiss={() => setLicenseRequired(false)} />}
      <div className="flex-1 min-h-0 overflow-hidden">
      {route === 'settings' && (
        <SettingsPage
          token={token}
          profile={profile}
          onUpdateProfile={updateProfile}
          onBack={goToChat}
        />
      )}

      {route === 'schedules' && (
        <SchedulesRoute token={token} onBack={goToChat} />
      )}

      {route === 'error-capture' && (
        <ErrorCaptureRoute token={token} onBack={goToChat} />
      )}

      {route === 'dev-chat-surface' && (
        <ChatSurfaceShowcase token={token} />
      )}

      {route === 'dev-mobile-accordion' && (
        <MobileAccordionShowcase token={token} />
      )}

      {route === 'grid' && (
        <GridPage token={token} tabId={gridTabId} />
      )}

      {(route === 'chat' || route === 'login') && (
        <Layout
          token={token}
          user={user}
          signOut={signOut}
          onNavigate={navigate}
        />
      )}

      {route === 'privacy' && <Privacy />}
      {route === 'terms' && <Terms />}
      </div>
      <Footer />
    </div>
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

function SchedulesRoute({ token, onBack }: { token: string; onBack: () => void }) {
  const { subscribe } = useWebSocket(token)
  return <SchedulesPage token={token} onBack={onBack} subscribe={subscribe} />
}

function ErrorCaptureRoute({ token, onBack }: { token: string; onBack: () => void }) {
  const { subscribe } = useWebSocket(token)
  return <ErrorCapturePage token={token} onBack={onBack} subscribe={subscribe} />
}

function NotificationsBridge({ token, profile }: { token: string; profile: Profile }) {
  const { subscribe } = useWebSocket(token)
  useBrowserNotifications({ subscribe, profile })
  return null
}
