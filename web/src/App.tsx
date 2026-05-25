import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { AuthForm } from './components/AuthForm'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'
import { SettingsPage } from './components/SettingsPage'
import { SchedulesPage } from './components/SchedulesPage'
import { ErrorCapturePage } from './components/ErrorCapturePage'
import { ChatSurfaceShowcase } from './components/ChatSurfaceShowcase'
import { MobileAccordionShowcase } from './components/MobileAccordionShowcase'
import { GridPage } from './components/GridPage'
import { useWebSocket } from './hooks/useWebSocket'
import { useBrowserNotifications } from './hooks/useBrowserNotifications'
import type { Profile } from './hooks/useProfile'
import type { AuthUser } from './lib/auth.ts'

type Route = 'chat' | 'settings' | 'schedules' | 'error-capture' | 'grid' | 'dev-chat-surface' | 'dev-mobile-accordion'

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
      <div className="text-[var(--text-muted)]">Loading...</div>
    </div>
  )
}

function getRoute(): Route {
  const hash = window.location.hash
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

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash
  }, [])

  const goToChat = useCallback(() => {
    window.location.hash = '#/'
  }, [])

  if (loading || needsSetup === null) {
    return <LoadingScreen />
  }

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  if (!token || !user) {
    return <AuthForm onAuth={signIn} />
  }

  // Wait for profile to load before rendering gated routes
  if (profileLoading || !profile) {
    return <LoadingScreen />
  }

  return (
    <>
      <NotificationsBridge token={token} profile={profile} />
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

      {route === 'chat' && (
        <Layout
          token={token}
          user={user}
          signOut={signOut}
          onNavigate={navigate}
        />
      )}
    </>
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
