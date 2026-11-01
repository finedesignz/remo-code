/**
 * Bounded hard-reload. A terminal 4001 from /ws/client used to call
 * `location.reload()` unconditionally; when the page itself authenticates fine
 * (HTTP session OK) but the socket is refused, every reload re-fetched
 * `/api/profile` several times and re-triggered the 4001, looping until the
 * per-user API limiter answered 429. Allow at most one reload per window.
 */
export const RELOAD_GUARD_KEY = 'remo:ws-4001-reload-at'
export const RELOAD_GUARD_WINDOW_MS = 60_000

export interface GuardStorage {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
}

export function shouldReloadNow(store: GuardStorage | null, now: number): boolean {
  if (!store) return false
  try {
    const last = Number(store.getItem(RELOAD_GUARD_KEY) ?? 0)
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_WINDOW_MS) return false
    store.setItem(RELOAD_GUARD_KEY, String(now))
    return true
  } catch {
    return false
  }
}
