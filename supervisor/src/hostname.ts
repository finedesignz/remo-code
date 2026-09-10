// supervisor/src/hostname.ts
// fix/supervisor-hostname-required — single source of truth for the hostname the
// supervisor puts on EVERY `/ws/agent` auth frame (supervisor socket + each
// per-session bridge, including RE-auth after a reconnect).
//
// Why this exists: a hostname-less auth frame makes the hub mint a
// `status='online', hostname=NULL` session row with a live phantom channel — a
// "ghost". Ghosts satisfy the orchestrator's `getChannel() != null` liveness
// check, so it dispatches into the void and build-session autospawn never
// fires. `os.hostname()` is the primary source, but it is not guaranteed
// non-empty on every host/container (it can surface '' when the OS call fails);
// an empty string is exactly as bad as omitting the field. So resolve once, at
// module load, through the OS-provided identity chain and freeze it.
//
// This is NOT a made-up default: every fallback is a real host identity the OS
// itself reports. If all of them are empty we return '' and the caller must NOT
// pretend — the hub will log/reject rather than record a ghost.

import { hostname as osHostname } from 'os'

function firstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const s = (v ?? '').toString().trim()
    if (s) return s
  }
  return ''
}

let cached: string | null = null

/**
 * The supervisor's host identity. Non-empty on any host that reports one.
 * Cached — hostname does not change within a process lifetime, and re-reading
 * it per reconnect is how a transient OS failure turns into a ghost session.
 */
export function resolveHostname(): string {
  if (cached !== null) return cached
  let os = ''
  try { os = osHostname() } catch { os = '' }
  cached = firstNonEmpty(
    os,
    process.env.COMPUTERNAME,   // Windows
    process.env.HOSTNAME,       // POSIX shells / containers
  )
  if (!cached) {
    console.error('[supervisor] FATAL-ish: could not resolve a hostname (os.hostname/COMPUTERNAME/HOSTNAME all empty). /ws/agent auth will be rejected by hubs that require one.')
  }
  return cached
}

/** Test seam only — reset the memoized value. */
export function __resetHostnameCacheForTests(): void {
  cached = null
}
