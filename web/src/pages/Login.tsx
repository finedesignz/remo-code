import { useState } from 'react'
import { requestMagicLink, legacyPasswordLogin, storeAuth, type AuthUser } from '../lib/auth'

interface Props {
  /**
   * Called after a successful LEGACY password sign-in (soak window only).
   * Magic-link sign-in does NOT call this — the flow continues via the
   * `/auth/callback` redirect.
   */
  onLegacyAuth?: (token: string | null, user: AuthUser) => void
}

type Mode = 'magic' | 'password'

const HIDE_LEGACY = (import.meta as any).env?.VITE_HIDE_LEGACY_LOGIN === 'true'

export function Login({ onLegacyAuth }: Props) {
  const [mode, setMode] = useState<Mode>('magic')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleMagicSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await requestMagicLink(email)
      // Always show the success state regardless of API response — enumeration prevention.
      setSent(true)
    } catch {
      // Network-level failure — still show success (don't leak signal).
      setSent(true)
    } finally {
      setLoading(false)
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const { token, user } = await legacyPasswordLogin(email, password)
      // Mirror to localStorage so existing useAuth/useWebSocket code paths
      // that still consult `remo_token` keep functioning during soak.
      storeAuth(token ?? null, user)
      onLegacyAuth?.(token ?? null, user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
      // 410 from hub → flag is off, hide the toggle for the rest of this session.
      if (err instanceof Error && /disabled/i.test(err.message)) setMode('magic')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        <img src="/logo.png" alt="Remo Code" className="h-12 mx-auto mb-4" />
        <h1 className="text-3xl font-bold text-center mb-2 text-[var(--text-primary)]">Remo Code</h1>
        <p className="text-center text-[var(--text-muted)] mb-8">
          Remote access to your Claude Code sessions
        </p>

        <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-6">
          {mode === 'magic' && !sent && (
            <form onSubmit={handleMagicSubmit} className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sign in with email</h2>
              <p className="text-xs text-[var(--text-muted)] -mt-2">
                We'll email you a one-time link. No password needed.
              </p>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="px-3 py-2 rounded-lg bg-[var(--bg-primary)]/60 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={loading || !email}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
              >
                {loading ? 'Sending…' : 'Send magic link'}
              </button>
            </form>
          )}

          {mode === 'magic' && sent && (
            <div className="flex flex-col gap-3 text-center py-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Check your inbox</h2>
              <p className="text-xs text-[var(--text-muted)]">
                If an account exists for <span className="text-[var(--text-secondary)]">{email}</span>,
                a sign-in link is on its way. The link expires in 15 minutes.
              </p>
              <button
                type="button"
                onClick={() => { setSent(false); setEmail('') }}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors mt-2"
              >
                Use a different email
              </button>
            </div>
          )}

          {mode === 'password' && (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sign in with password</h2>
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="px-3 py-2 rounded-lg bg-[var(--bg-primary)]/60 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="px-3 py-2 rounded-lg bg-[var(--bg-primary)]/60 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <button
                type="submit"
                disabled={loading}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
              >
                {loading ? '…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>

        {!HIDE_LEGACY && (
          <button
            type="button"
            className="mt-4 w-full text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            onClick={() => { setMode(m => (m === 'magic' ? 'password' : 'magic')); setError(null); setSent(false) }}
          >
            {mode === 'magic' ? 'Use password instead' : 'Use magic link instead'}
          </button>
        )}
      </div>
    </div>
  )
}
