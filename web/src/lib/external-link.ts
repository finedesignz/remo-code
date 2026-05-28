/**
 * External-link interception for the Tauri 2 mobile WebView.
 *
 * Inside the WebView, `target="_blank"` anchors would otherwise either be
 * silently dropped or trap inside the WebView with no way back. We delegate
 * those clicks to the Tauri shell plugin so they open in the system browser.
 *
 * Internal links (same origin) are left alone — they navigate normally.
 *
 * Feature-detected: in a plain browser, or if the Tauri shell plugin isn't
 * loaded, the handler is a no-op and the default click behavior wins.
 */

import { isMobileApp } from './platform'

/** Loose shape of the Tauri shell plugin we feature-detect at runtime. */
type TauriShell = { open?: (url: string) => unknown }
type TauriGlobal = { shell?: TauriShell }

/**
 * Decide whether a click should be intercepted and handed to the system browser.
 *
 * Pure function — no DOM mutation, no side effects. Returns the URL to open
 * via the shell plugin, or `null` if the default browser behavior should win.
 *
 * Rules:
 *   1. Only inside the mobile app (`isMobileApp()` true) — otherwise `null`.
 *   2. Only plain left-clicks without modifier keys — otherwise `null` so we
 *      don't break copy-link / open-in-new-tab on desktop browsers
 *      (defense in depth — this only runs when `isMobileApp()` anyway).
 *   3. Anchor must have a resolvable absolute href.
 *   4. href origin must differ from the current page origin OR the anchor
 *      must explicitly carry `target="_blank"`. Same-origin in-app links pass through.
 *   5. `javascript:` / `mailto:` / `tel:` / fragment-only URLs pass through.
 */
export function shouldOpenExternally(
  event: { button?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean },
  anchor: { href?: string | null; target?: string | null; origin?: string | null } | null,
  pageOrigin: string,
  mobile: boolean = isMobileApp(),
): string | null {
  if (!mobile) return null
  if (!anchor) return null
  if (event.defaultPrevented) return null
  if (event.button !== undefined && event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null

  const href = anchor.href || ''
  if (!href) return null
  if (href.startsWith('javascript:')) return null
  if (href.startsWith('#')) return null
  // mailto/tel are technically external but we want the OS to handle them via
  // the default browser dispatcher — the shell plugin handles those too.
  // Fall through and let shell.open take them.

  const target = (anchor.target || '').toLowerCase()
  const anchorOrigin = anchor.origin || ''
  const crossOrigin = !!anchorOrigin && anchorOrigin !== pageOrigin

  // Intercept when explicitly _blank OR when the link points off-origin.
  if (target !== '_blank' && !crossOrigin) return null

  return href
}

/**
 * Install a delegated click handler on `document` that intercepts external
 * links inside the mobile WebView and routes them through the Tauri shell.
 * Returns a teardown function. No-op in a plain browser.
 */
export function installExternalLinkInterceptor(doc: Document = document): () => void {
  if (!isMobileApp()) return () => {}

  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element | null
    if (!target) return
    const anchor = target.closest && (target.closest('a') as HTMLAnchorElement | null)
    if (!anchor) return
    const pageOrigin = doc.defaultView?.location?.origin ?? ''
    const url = shouldOpenExternally(ev, {
      href: anchor.href,
      target: anchor.target,
      origin: anchor.origin,
    }, pageOrigin)
    if (!url) return

    const tauri = (doc.defaultView as unknown as { __TAURI__?: TauriGlobal } | undefined)?.__TAURI__
    const open = tauri?.shell?.open
    if (typeof open !== 'function') return // plugin missing — let the WebView handle it

    ev.preventDefault()
    try {
      open(url)
    } catch {
      // swallow — if the plugin throws, default behavior already prevented;
      // nothing better we can do without leaking the user into the WebView.
    }
  }

  doc.addEventListener('click', onClick, { capture: true })
  return () => doc.removeEventListener('click', onClick, { capture: true } as any)
}
