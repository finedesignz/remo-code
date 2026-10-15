import { useState } from 'react'
import {
  requestTitaniumLink,
  requestMagicLink,
  legacyPasswordLogin,
  storeAuth,
  titaniumStartAction,
  type AuthUser,
} from '../lib/auth'
import { useClientConfig } from '../hooks/useClientConfig'
import { isAppShell } from '../lib/platform'

interface Props {
  /**
   * Called after a successful LEGACY password sign-in (hub ALLOW_LEGACY_LOGIN=true
   * only). The Titanium login does NOT call this: it completes through the hub's
   * /auth/callback redirect, which sets the session cookie and lands on `/`.
   */
  onLegacyAuth?: (token: string | null, user: AuthUser) => void
}

type Mode = 'titanium' | 'legacy-link' | 'password'

const ERROR_MESSAGES: Record<string, string> = {
  no_account: 'There is no Remo Code account for that email. Ask the owner to add you.',
  account_conflict: 'That email belongs to a Remo Code account linked to a different Titanium account. Contact the owner.',
  account_ambiguous: 'More than one Remo Code account matches that email. Contact the owner.',
  wrong_app: 'That sign-in was issued for another app. Start again here.',
  exchange_failed: 'The sign-in link is invalid or expired. Request a new one.',
  missing_act: 'The sign-in link is incomplete. Request a new one.',
  confirm_expired: 'The confirmation expired. Request a new sign-in link.',
  confirm_failed: 'The confirmation could not be verified. Request a new sign-in link.',
  origin_not_allowed: 'Sign-in must be started from this site.',
  server_misconfigured: 'Sign-in is not configured on this server.',
}

function readLoginHashParams(): URLSearchParams {
  try {
    const hash = window.location.hash
    const q = hash.indexOf('?')
    return new URLSearchParams(q >= 0 ? hash.slice(q + 1) : '')
  } catch {
    return new URLSearchParams()
  }
}

export function Login({ onLegacyAuth }: Props) {
  const cfg = useClientConfig()
  const appShell = isAppShell()
  const [mode, setMode] = useState<Mode>('titanium')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(() => {
    const code = readLoginHashParams().get('error')
    return code ? (ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.') : null
  })
  const [loading, setLoading] = useState(false)

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      if (mode === 'legacy-link') await requestMagicLink(email)
      else await requestTitaniumLink(email, appShell ? 'app' : 'web')
      // Same state for every address (no existence signal).
      setSent(true)
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(code === 'invalid_email' ? 'Enter a valid email address.' : (ERROR_MESSAGES[code] ?? 'Could not send the link. Try again.'))
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
      storeAuth(token ?? null, user)
      onLegacyAuth?.(token ?? null, user)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'px-3 py-2 rounded-lg bg-[var(--bg-primary)]/60 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-blue-500'
  const primaryBtn = 'px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50'
  const linkBtn = 'w-full text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors'

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        <img src="/logo.png" alt="Remo Code" className="h-12 mx-auto mb-4" />
        <h1 className="text-3xl font-bold text-center mb-2 text-[var(--text-primary)]">Remo Code</h1>
        <p className="text-center text-[var(--text-muted)] mb-8">
          Remote access to your Claude Code sessions
        </p>

        <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-6">
          {error && <p className="text-red-400 text-sm mb-4" role="alert">{error}</p>}

          {mode !== 'password' && !sent && (
            <div className="flex flex-col gap-4">
              {mode === 'titanium' && !appShell && (
                // Hosted login (passkey first, email link, Google per policy). A real
                // form POST: the hub sets the state + PKCE cookie and 303s away.
                <form method="POST" action={titaniumStartAction()}>
                  <button type="submit" className={`w-full ${primaryBtn}`}>Continue with Titanium</button>
                </form>
              )}
              <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {mode === 'legacy-link' ? 'Legacy email link' : 'Or get a sign-in link by email'}
                </h2>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className={inputCls}
                />
                <button type="submit" disabled={loading || !email} className={primaryBtn}>
                  {loading ? 'Sending…' : 'Email me a link'}
                </button>
              </form>
            </div>
          )}

          {mode !== 'password' && sent && (
            <div className="flex flex-col gap-3 text-center py-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Check your inbox</h2>
              <p className="text-xs text-[var(--text-muted)]">
                If <span className="text-[var(--text-secondary)]">{email}</span> can sign in here,
                a sign-in link is on its way. Open it in this browser{appShell ? ' or on this device' : ''}.
              </p>
              <button type="button" onClick={() => { setSent(false); setEmail('') }} className={`${linkBtn} mt-2`}>
                Use a different email
              </button>
            </div>
          )}

          {mode === 'password' && (
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sign in with password (legacy)</h2>
              <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" className={inputCls} />
              <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" className={inputCls} />
              <button type="submit" disabled={loading} className={primaryBtn}>{loading ? '…' : 'Sign in'}</button>
            </form>
          )}
        </div>

        {/* Legacy surfaces: shown only while the hub flags enable them (the routes 404 otherwise). */}
        <div className="mt-4 flex flex-col gap-2">
          {mode !== 'titanium' && (
            <button type="button" className={linkBtn} onClick={() => { setMode('titanium'); setError(null); setSent(false) }}>
              Back to Titanium sign-in
            </button>
          )}
          {cfg.legacy_magic_link_login && mode !== 'legacy-link' && (
            <button type="button" className={linkBtn} onClick={() => { setMode('legacy-link'); setError(null); setSent(false) }}>
              Use the legacy email link
            </button>
          )}
          {cfg.legacy_password_login && mode !== 'password' && (
            <button type="button" className={linkBtn} onClick={() => { setMode('password'); setError(null); setSent(false) }}>
              Use password (legacy)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
