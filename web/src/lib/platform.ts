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
