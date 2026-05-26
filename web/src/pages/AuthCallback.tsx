import { useEffect, useState } from 'react'
import { hubUrl } from '../lib/auth'

/**
 * Auth callback landing page. The hub's `/api/auth/login/callback` endpoint
 * normally 302-redirects directly to `/` after Set-Cookie, so this page is
 * usually only seen briefly (or never).
 *
 * We render it for two cases:
 *   1. The hub returned an error (409 link_mismatch, 410/401 expired) — show it.
 *   2. A SPA-internal route (`#/auth/callback?token=…`) was opened directly —
 *      we make the call ourselves and follow the redirect.
 */

type State = 'loading' | 'mismatch' | 'expired' | 'unknown_error'

function readToken(): string | null {
  // Token may live in the search-string OR after the hash (`#/auth/callback?token=…`).
  try {
    const search = new URLSearchParams(window.location.search)
    const t = search.get('token')
    if (t) return t
    const hash = window.location.hash
    const qIdx = hash.indexOf('?')
    if (qIdx >= 0) {
      const hp = new URLSearchParams(hash.slice(qIdx + 1))
      return hp.get('token')
    }
  } catch {}
  return null
}

export function AuthCallback() {
  const [state, setState] = useState<State>('loading')

  useEffect(() => {
    const token = readToken()
    if (!token) { setState('expired'); return }
    const url = `${hubUrl()}/api/auth/login/callback?token=${encodeURIComponent(token)}`
    // We let the browser follow Set-Cookie; on the hub's 302 to "/", fetch
    // will land on the SPA index. Use `redirect: 'manual'` so we can inspect
    // status — on success we explicitly navigate.
    fetch(url, { method: 'GET', credentials: 'include', redirect: 'manual' })
      .then(res => {
        // `redirect: 'manual'` yields an opaqueredirect (status 0) on success.
        if (res.type === 'opaqueredirect' || res.status === 0 || (res.status >= 200 && res.status < 300) || (res.status >= 300 && res.status < 400)) {
          window.location.replace('/')
          return
        }
        if (res.status === 409) setState('mismatch')
        else if (res.status === 401 || res.status === 410) setState('expired')
        else setState('unknown_error')
      })
      .catch(() => setState('unknown_error'))
  }, [])

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--bg-primary)]">
      <div className="w-full max-w-md p-8">
        <img src="/logo.png" alt="Remo Code" className="h-12 mx-auto mb-4" />
        <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-6 text-center">
          {state === 'loading' && (
            <>
              <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Signing you in…</h2>
              <p className="text-xs text-[var(--text-muted)]">Verifying your magic link.</p>
            </>
          )}
          {state === 'mismatch' && (
            <>
              <h2 className="text-sm font-semibold text-red-400 mb-2">Link mismatch</h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                This sign-in link was issued for a different browser. Open the link in the same
                browser where you requested it, or request a new one.
              </p>
              <a href="/#/login" className="inline-block px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] text-sm font-medium transition-colors">
                Back to sign in
              </a>
            </>
          )}
          {state === 'expired' && (
            <>
              <h2 className="text-sm font-semibold text-amber-400 mb-2">Link expired</h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                This sign-in link is no longer valid. Request a new one — they expire after 15 minutes
                or one use.
              </p>
              <a href="/#/login" className="inline-block px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] text-sm font-medium transition-colors">
                Request a new link
              </a>
            </>
          )}
          {state === 'unknown_error' && (
            <>
              <h2 className="text-sm font-semibold text-red-400 mb-2">Sign-in failed</h2>
              <p className="text-xs text-[var(--text-muted)] mb-4">
                Something went wrong verifying your link. Please try again.
              </p>
              <a href="/#/login" className="inline-block px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] text-sm font-medium transition-colors">
                Back to sign in
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
