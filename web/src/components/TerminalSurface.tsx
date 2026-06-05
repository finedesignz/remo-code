/**
 * TerminalSurface — themed xterm.js panel for a raw-terminal (PTY) session.
 * Seed of the single human surface that replaces ChatSurface in Phase 17
 * (RIP-AND-REPLACE).
 *
 * Phase 16 (R-PTY-09) hardening — mobile-ready:
 *   - RECONNECT replays scrollback: on (re)attach the host sends term.reattach
 *     {scrollback}; we clear the buffer then write it before live term.data.
 *   - RESIZE: FitAddon-computed cols/rows propagate to the PTY on container
 *     resize (ResizeObserver), orientation change, AND mobile keyboard-viewport
 *     change (visualViewport).
 *   - SCROLLBACK works on touch (mobile) and desktop (xterm scrollback default).
 *   - SESSION SWITCH clears the prior buffer BEFORE replay so no cross-session
 *     bleed (T-16-10).
 *
 * Channel isolation: this component speaks ONLY term.data/term.input/
 * term.resize/term.attach/term.reattach over the shared /ws/client connection —
 * it never touches the structured chat message path.
 *
 * Theme: background/foreground derived from the app's CSS custom properties
 * (--bg-primary / --text-primary). Accent = BLUE (the forbidden purple-blue
 * accent must never appear — the web accent-guard test enforces this). App
 * chrome is untouched.
 */
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  sessionId: string
  /** From useWebSocketContext(): register an inbound-frame handler; returns an unsubscribe fn. */
  subscribe: (handler: (msg: any) => void) => () => void
  /** From useWebSocketContext(): send a frame to the hub. */
  send: (msg: object) => void
  className?: string
}

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

// base64 helpers for the raw byte payloads carried over the JSON WS.
// CRITICAL: bytes stay bytes. Keystrokes are UTF-8-encoded to bytes before
// base64; inbound PTY bytes are handed to xterm as a Uint8Array so xterm runs
// the single authoritative UTF-8 decode. Decoding to a JS string anywhere in the
// relay corrupts multibyte sequences (box-drawing, etc.) and desyncs the parser.
const _enc = new TextEncoder()
export function inputToB64(s: string): string {
  const bytes = _enc.encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
export function b64ToBytes(b64: string): Uint8Array {
  let bin = ''
  try { bin = atob(b64) } catch { return new Uint8Array(0) }
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function TerminalSurface({ sessionId, subscribe, send, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: cssVar('--bg-primary', '#0b0f17'),
        foreground: cssVar('--text-primary', '#e6edf3'),
        // BLUE accent (design-preferences) — the forbidden purple-blue is never used.
        cursor: cssVar('--accent-blue', '#3b82f6'),
        selectionBackground: cssVar('--accent-blue', '#3b82f6') + '55',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    try { fit.fit() } catch {}
    termRef.current = term
    fitRef.current = fit

    // MOBILE INPUT HARDENING (iOS Safari / Android Chrome).
    // xterm renders a hidden helper <textarea> that receives keystrokes. On
    // mobile the OS keyboard applies autocapitalize/autocorrect/predictive-text
    // to it, which starts an IME composition on the first character and then
    // mangles subsequent input (observed: only the first keystroke lands, then a
    // stray newline). Disable every "smart" text feature and hint a raw input
    // mode so each key maps 1:1 to a byte sent to the PTY. (term.element is the
    // wrapper; .xterm-helper-textarea is the live capture target.)
    const ta = term.textarea
    if (ta) {
      ta.setAttribute('autocapitalize', 'none')
      ta.setAttribute('autocorrect', 'off')
      ta.setAttribute('autocomplete', 'off')
      ta.setAttribute('spellcheck', 'false')
      // enterkeyhint omitted: the TUI handles Enter; "go"/"send" labels imply submit
      ta.setAttribute('inputmode', 'text')
    }
    // Mobile taps on the host div don't reliably focus xterm's hidden textarea,
    // so the keyboard opens but keystrokes go nowhere. Focus the terminal on tap.
    const focusTerm = () => { try { term.focus() } catch {} }
    hostRef.current.addEventListener('touchstart', focusTerm, { passive: true })
    hostRef.current.addEventListener('mousedown', focusTerm)

    // SESSION SWITCH / mount: start from a clean buffer so a prior session's
    // bytes never bleed into this one (T-16-10). Scrollback replay (below)
    // re-clears before writing the replayed buffer.
    term.clear()

    // Keystrokes → term.input (base64 raw bytes).
    const dataDisp = term.onData((d) => {
      send({ type: 'term.input', session_id: sessionId, bytes: inputToB64(d) })
    })

    // Request (re)attach + ask for scrollback replay so a reconnect restores the
    // prior screen state before live output resumes.
    send({ type: 'term.attach', session_id: sessionId })
    send({ type: 'term.reattach', session_id: sessionId })

    // Inbound term.data (live) + term.reattach{scrollback} (replay).
    const unsub = subscribe((msg) => {
      if (!msg || msg.session_id !== sessionId) return
      if (msg.type === 'term.reattach' && typeof msg.scrollback === 'string') {
        // RECONNECT replay: clear then write the buffered scrollback, then live
        // term.data resumes appending.
        term.clear()
        term.write(b64ToBytes(msg.scrollback))
      } else if (msg.type === 'term.data' && typeof msg.bytes === 'string') {
        term.write(b64ToBytes(msg.bytes))
      }
    })

    // Resize → fit + term.resize. Debounced via rAF so a burst of viewport
    // events (mobile keyboard open) collapses to one resize.
    let rafId = 0
    const sendResize = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        try { fit.fit() } catch {}
        send({ type: 'term.resize', session_id: sessionId, cols: term.cols, rows: term.rows })
      })
    }
    const ro = new ResizeObserver(() => sendResize())
    if (hostRef.current) ro.observe(hostRef.current)
    window.addEventListener('resize', sendResize)
    window.addEventListener('orientationchange', sendResize)
    // Mobile keyboard-viewport changes (on-screen keyboard open/close) only
    // surface via visualViewport, not window.resize.
    const vv = (window as any).visualViewport as VisualViewport | undefined
    vv?.addEventListener('resize', sendResize)
    // Initial resize so the PTY matches the rendered grid.
    sendResize()

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      try { dataDisp.dispose() } catch {}
      try { unsub() } catch {}
      try { ro.disconnect() } catch {}
      window.removeEventListener('resize', sendResize)
      window.removeEventListener('orientationchange', sendResize)
      vv?.removeEventListener('resize', sendResize)
      try { term.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, subscribe, send])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ width: '100%', height: '100%', background: 'var(--bg-primary)' }}
    />
  )
}
