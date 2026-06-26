import { useEffect } from 'react'

/**
 * useVisualViewportHeight — drives a `--app-vh` CSS custom property on
 * <html> from `window.visualViewport.height` (falling back to
 * `window.innerHeight` when visualViewport is unavailable).
 *
 * WHY: `height: 100dvh` does NOT shrink when the iOS soft keyboard opens —
 * only `window.visualViewport.height` reflects the keyboard-occluded viewport.
 * Without this, the app stays full-height while the keyboard covers the bottom:
 * the terminal grid keeps its tall row count, the TUI renders its input box at
 * grid-bottom (behind the keyboard) leaving blank rows above, and the PAGE
 * scrolls (header drifts) instead of the terminal. By writing the REAL visible
 * height into `--app-vh`, the flex column shrinks → the xterm host (flex-1)
 * shrinks → TerminalSurface's existing visualViewport handler re-fits to fewer
 * rows → the TUI redraws its input box flush above the keyboard.
 *
 * No-op safe when visualViewport is undefined (older WebViews) — falls back to
 * innerHeight and only the window resize/orientationchange listeners apply.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const vv = (window as any).visualViewport as VisualViewport | undefined

    // rAF-debounced write so a burst of viewport events (keyboard animating
    // open) collapses to a single style mutation.
    let rafId = 0
    const apply = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const h = vv?.height ?? window.innerHeight
        document.documentElement.style.setProperty('--app-vh', `${h}px`)
      })
    }

    // Set once synchronously so the first paint already has the right height.
    document.documentElement.style.setProperty(
      '--app-vh',
      `${vv?.height ?? window.innerHeight}px`
    )

    // visualViewport scroll fires when the keyboard shifts the viewport without
    // a resize; both it and resize must update the height.
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('orientationchange', apply)
    window.addEventListener('resize', apply)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('orientationchange', apply)
      window.removeEventListener('resize', apply)
    }
  }, [])
}

export default useVisualViewportHeight
