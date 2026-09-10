/**
 * Mounts the AgentAutofix click-to-comment widget (directive A) for signed-in
 * users only. Fetches `{host, public_key}` from the hub's session-gated
 * `/api/agentautofix/token` route, stashes it on `window.__AGENTAUTOFIX_CONFIG__`,
 * then loads the static `agentautofix-widget.js` bundle (web/public) which reads
 * that global instead of hardcoding a public key per build.
 *
 * No-ops entirely when the hub isn't configured for AgentAutofix (404 from the
 * token route) — safe to render unconditionally in every environment.
 */
import { useEffect } from 'react'
import { hubFetch } from '../lib/api'

declare global {
  interface Window {
    __AGENTAUTOFIX_CONFIG__?: { host: string; publicKey: string; tokenUrl: string }
  }
}

let scriptLoaded = false

export function AgentautofixWidget({ token }: { token: string }) {
  useEffect(() => {
    if (scriptLoaded) return
    let cancelled = false

    hubFetch<{ host: string; public_key: string }>(token, '/api/agentautofix/token')
      .then((cfg) => {
        if (cancelled || scriptLoaded) return
        window.__AGENTAUTOFIX_CONFIG__ = {
          host: cfg.host,
          publicKey: cfg.public_key,
          tokenUrl: '/api/agentautofix/token',
        }
        const script = document.createElement('script')
        script.src = '/agentautofix-widget.js'
        script.defer = true
        document.body.appendChild(script)
        scriptLoaded = true
      })
      .catch(() => {
        // 404 (not configured) or network error — widget stays absent, no retry.
      })

    return () => {
      cancelled = true
    }
  }, [token])

  return null
}
