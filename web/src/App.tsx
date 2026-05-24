import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { AuthForm } from './components/AuthForm'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'
import { SettingsPage } from './components/SettingsPage'
import { SchedulesPage } from './components/SchedulesPage'
import { useWebSocket } from './hooks/useWebSocket'
import type { AuthUser } from './lib/auth.ts'

type Route = 'chat' | 'settings' | 'schedules'

function getRoute(): Route {
  const hash = window.location.hash
  // Legacy /#/supervisor → settings with supervisor tab
  if (hash.startsWith('#/supervisor')) {
    window.location.hash = '#/settings?tab=supervisor'
    return 'settings'
  }
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/schedules')) return 'schedules'
  return 'chat'
}

export default function App() {
  const { user, token, loading, signIn, signOut } = useAuth()
  const { profile, loading: profileLoading, updateProfile } = useProfile(token)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [route, setRoute] = useState<Route>(getRoute)

  useEffect(() => {
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/setup/status`)
      .then(r => r.json())
      .then(data => setNeedsSetup(data.needs_setup))
      .catch(() => setNeedsSetup(false))
  }, [])

  // Hash-based routing
  useEffect(() => {
    const onHashChange = () => setRoute(getRoute())
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
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    )
  }

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  if (!token || !user) {
    return <AuthForm onAuth={signIn} />
  }

  // Wait for profile to load before rendering gated routes
  if (profileLoading || !profile) {
    return (
      <div className="flex items-center justify-center h-screen bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)]">Loading...</div>
      </div>
    )
  }

  return (
    <>
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
