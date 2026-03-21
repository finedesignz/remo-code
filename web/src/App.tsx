import { useState, useEffect } from 'react'
import { useAuth } from './hooks/useAuth'
import { AuthForm } from './components/AuthForm'
import { SetupForm } from './components/SetupForm'
import { Layout } from './components/Layout'

export default function App() {
  const { session, user, loading, signOut } = useAuth()
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  useEffect(() => {
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/setup/status`)
      .then(r => r.json())
      .then(data => setNeedsSetup(data.needs_setup))
      .catch(() => setNeedsSetup(false))
  }, [])

  if (loading || needsSetup === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-900">
        <div className="text-slate-400">Loading...</div>
      </div>
    )
  }

  if (needsSetup) {
    return <SetupForm onComplete={() => setNeedsSetup(false)} />
  }

  if (!session || !user) {
    return <AuthForm />
  }

  return <Layout session={session} user={user} signOut={signOut} />
}
