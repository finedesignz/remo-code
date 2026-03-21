import { useAuth } from './hooks/useAuth'
import { AuthForm } from './components/AuthForm'
import { Layout } from './components/Layout'

export default function App() {
  const { session, user, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-slate-400">Loading...</div>
      </div>
    )
  }

  if (!session || !user) {
    return <AuthForm />
  }

  return <Layout session={session} user={user} signOut={signOut} />
}
