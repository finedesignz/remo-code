import { useState } from 'react'
import { startAppLogin, titaniumStartAction } from '../lib/auth'
import { isAppShell } from '../lib/platform'

const ERROR_MESSAGES: Record<string, string> = {
  no_account: 'There is no Remo Code account for that email. Ask the owner to add you.',
  account_conflict: 'That email belongs to a Remo Code account linked to a different Titanium account. Contact the owner.',
  account_ambiguous: 'More than one Remo Code account matches that email. Contact the owner.',
  wrong_app: 'That sign-in was issued for another app. Start again here.',
  exchange_failed: 'The sign-in link is invalid or expired. Start sign-in again.',
  missing_act: 'The sign-in link is incomplete. Start sign-in again.',
  confirm_expired: 'The confirmation expired. Start sign-in again.',
  confirm_failed: 'The confirmation could not be verified. Start sign-in again.',
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

/**
 * Logged-out landing page. There is no in-app credential form: signing in happens on
 * the Titanium Labs login page (passkey, email link, Google per policy) and returns to
 * the hub's /auth/callback.
 */
export function Login() {
  const appShell = isAppShell()
  const [error, setError] = useState<string | null>(() => {
    const code = readLoginHashParams().get('error')
    return code ? (ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.') : null
  })
  const [loading, setLoading] = useState(false)

  // The Tauri shell cannot follow a cross-origin 303: the hub answers the hosted
  // login URL as JSON and the WebView navigates to it.
  async function handleAppSignIn() {
    setError(null)
    setLoading(true)
    try {
      window.location.assign(await startAppLogin())
    } catch (err) {
      const code = err instanceof Error ? err.message : ''
      setError(ERROR_MESSAGES[code] ?? 'Could not start sign-in. Try again.')
      setLoading(false)
    }
  }

  const primaryBtn = 'px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50'

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
          {appShell ? (
            <button type="button" onClick={handleAppSignIn} disabled={loading} className={`w-full ${primaryBtn}`}>
              {loading ? 'Opening…' : 'Sign in with Titanium Labs'}
            </button>
          ) : (
            // A real form POST: the hub sets the state + PKCE cookie and 303s to the hosted login.
            <form method="POST" action={titaniumStartAction()}>
              <button type="submit" className={`w-full ${primaryBtn}`}>Sign in with Titanium Labs</button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
