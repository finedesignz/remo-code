import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { AuthForm } from './components/AuthForm'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'
import { SettingsPage } from './components/SettingsPage'

type Route = 'chat' | 'settings'

function getRoute(): Route {
  const hash = window.location.hash
  if (hash === '#/settings') return 'settings'
  return 'chat'
}

export default function App() {
  const { session, user, loading, signOut } = useAuth()
  const { profile, loading: profileLoading, updateProfile } = useProfile(session)
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

  if (!session || !user) {
    return <AuthForm />
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
          session={session}
          profile={profile}
          onUpdateProfile={updateProfile}
          onBack={goToChat}
        />
      )}

      {route === 'chat' && (
        <Layout
          session={session}
          user={user}
          signOut={signOut}
          onNavigate={navigate}
        />
      )}
    </>
  )
}
