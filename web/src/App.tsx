import { useState, useEffect, useCallback } from 'react'
import { useAuth } from './hooks/useAuth'
import { useProfile } from './hooks/useProfile'
import { AuthForm } from './components/AuthForm'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'
import { SettingsPage } from './components/SettingsPage'
import { AdminDashboard } from './components/AdminDashboard'
import { PricingModal } from './components/PricingModal'
import { HUB_URL } from './lib/api'

type Route = 'chat' | 'settings' | 'admin'

function getRoute(): Route {
  const hash = window.location.hash
  if (hash === '#/settings') return 'settings'
  if (hash === '#/admin') return 'admin'
  return 'chat'
}

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center h-screen bg-slate-900">
      <div className="text-slate-400">Loading...</div>
    </div>
  )
}

export default function App() {
  const { session, user, loading, signOut } = useAuth()
  const { profile, loading: profileLoading, updateProfile, isAdmin } = useProfile(session)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [route, setRoute] = useState<Route>(getRoute)
  const [showPricing, setShowPricing] = useState(false)

  useEffect(() => {
    fetch(`${HUB_URL}/api/setup/status`)
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

  if (loading || needsSetup === null) return <LoadingScreen />

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  if (!session || !user) return <AuthForm />

  if (profileLoading || !profile) return <LoadingScreen />

  // Non-admin on admin route falls through to chat
  const effectiveRoute = (route === 'admin' && !isAdmin) ? 'chat' : route

  return (
    <>
      {showPricing && (
        <PricingModal
          session={session}
          currentTier={profile.tier}
          onClose={() => setShowPricing(false)}
        />
      )}

      {effectiveRoute === 'settings' && (
        <SettingsPage
          session={session}
          profile={profile}
          onUpdateProfile={updateProfile}
          onBack={() => navigate('#/')}
          onShowPricing={() => setShowPricing(true)}
        />
      )}

      {effectiveRoute === 'admin' && (
        <AdminDashboard
          session={session}
          onBack={() => navigate('#/')}
        />
      )}

      {effectiveRoute === 'chat' && (
        <Layout
          session={session}
          user={user}
          signOut={signOut}
          profile={profile}
          onNavigate={navigate}
          onShowPricing={() => setShowPricing(true)}
        />
      )}
    </>
  )
}
