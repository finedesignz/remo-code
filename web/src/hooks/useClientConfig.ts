import { useState, useEffect } from 'react'
import { hubFetch } from '../lib/api'

/**
 * Public client bootstrap config fetched once at mount from the hub's
 * unauthenticated `GET /api/client-config`. Currently exposes the
 * `REMO_PTY_INTERACTIVE` flag so the web's default human chat surface
 * (TerminalSurface vs the stream-json ChatSurface) stays in lockstep with the
 * hub env flip — no separate SPA build/deploy needed when the flag flips.
 *
 * Defaults conservatively: until the fetch settles (and on any failure) the
 * flag reads false, preserving current ChatSurface behavior.
 */
export interface ClientConfig {
  pty_interactive: boolean
}

export function useClientConfig(): ClientConfig {
  const [cfg, setCfg] = useState<ClientConfig>({ pty_interactive: false })

  useEffect(() => {
    let cancelled = false
    hubFetch<ClientConfig>(null, '/api/client-config')
      .then((c) => { if (!cancelled) setCfg({ pty_interactive: !!c?.pty_interactive }) })
      .catch(() => { /* leave default (false) — preserves ChatSurface */ })
    return () => { cancelled = true }
  }, [])

  return cfg
}
