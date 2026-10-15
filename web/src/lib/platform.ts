/**
 * Platform detection shim for the Remo Code web SPA.
 *
 * The same bundle ships to the desktop browser (https://app.remo-code.com) and
 * to the Tauri 2 mobile WebView. This module is the single source of truth for
 * runtime platform detection. All Tauri-specific code paths in the web SPA must
 * be gated behind `isMobileApp()`.
 *
 * Contract:
 *   - Pure module. No side effects on import. No React.
 *   - Tauri APIs are accessed via `window.__TAURI__` / `window.__TAURI_INTERNALS__`
 *     feature detection. Do NOT import `@tauri-apps/api` into `web/`.
 *   - The Tauri shell injects `window.__REMO_APP_VERSION__` at boot.
 */

// Loose typings — we deliberately avoid pulling Tauri types into the web build.
declare global {
  interface Window {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
    __REMO_APP_VERSION__?: string
  }
}

/** True iff running inside the Tauri 2 WebView. False in any normal browser. */
export function isMobileApp(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.__TAURI_INTERNALS__ !== 'undefined'
}

export type Platform = 'ios' | 'android' | 'web'

/**
 * Best-effort platform detection.
 *
 * When `isMobileApp()` is true we sniff the UserAgent because the Tauri shell
 * exposes the underlying platform via the standard mobile UA string. In a
 * normal browser we always return `'web'` regardless of UA (a phone browser
 * is still the web build).
 */
export function platform(): Platform {
  if (!isMobileApp()) return 'web'
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  if (/android/i.test(ua)) return 'android'
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios'
  // Fall back to web — Tauri desktop builds would land here but we don't ship those today.
  return 'web'
}

/**
 * App version injected by the Tauri shell as `window.__REMO_APP_VERSION__`.
 * Returns `null` in the browser build (no shell, no global).
 */
export function appVersion(): string | null {
  if (typeof window === 'undefined') return null
  const v = window.__REMO_APP_VERSION__
  return typeof v === 'string' && v.length > 0 ? v : null
}

const APP_SHELL_KEY = 'remo:app_shell'

/**
 * The Tauri shell boots on its own origin, then `location.replace`s the WebView to
 * the hub origin with `?remo_shell=<version>` (mobile/tauri/ui/src/main.ts).
 * sessionStorage is per-origin, so the marker has to cross in the URL: capture it
 * here (once, at SPA boot) into THIS origin's sessionStorage and strip it from the
 * address bar.
 */
export function captureAppShellMarker(): void {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    const v = url.searchParams.get('remo_shell')
    if (v === null) return
    sessionStorage.setItem(APP_SHELL_KEY, v || '1')
    url.searchParams.delete('remo_shell')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {
    // sessionStorage blocked: the login falls back to the web leg.
  }
}

/**
 * True inside the Remo Code Tauri shell, also after it navigated its WebView to the
 * hub origin (which drops `window.__TAURI_INTERNALS__`). Drives the deep-link login
 * leg (`client: 'app'`, return to remo-code://auth/callback).
 */
export function isAppShell(): boolean {
  if (isMobileApp()) return true
  try {
    return typeof sessionStorage !== 'undefined' && !!sessionStorage.getItem(APP_SHELL_KEY)
  } catch {
    return false
  }
}
