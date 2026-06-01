/**
 * TerminalSurface — Phase-15 themed xterm.js panel for a raw-terminal (PTY)
 * session. Seed of the single human surface that replaces ChatSurface in
 * Phase 17 (RIP-AND-REPLACE). Spike scope: render PTY output, send keystrokes
 * + resize over the raw-terminal WS channel (term.* frames).
 *
 * Channel isolation: this component speaks ONLY term.data/term.input/
 * term.resize/term.attach over the shared /ws/client connection — it never
 * touches the structured chat message path.
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
function toB64(s: string): string {
  // s is a binary string (one char per byte).
  let out = ''
  try { out = btoa(s) } catch { out = btoa(unescape(encodeURIComponent(s))) }
  return out
}
function fromB64(b64: string): string {
  try { return atob(b64) } catch { return '' }
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

    // Keystrokes → term.input (base64 raw bytes).
    const dataDisp = term.onData((d) => {
      send({ type: 'term.input', session_id: sessionId, bytes: toB64(d) })
    })

    // Request (re)attach so the supervisor starts/streams the PTY.
    send({ type: 'term.attach', session_id: sessionId })

    // Inbound term.data → write to the terminal.
    const unsub = subscribe((msg) => {
      if (!msg || msg.session_id !== sessionId) return
      if (msg.type === 'term.data' && typeof msg.bytes === 'string') {
        term.write(fromB64(msg.bytes))
      }
    })

    // Resize → fit + term.resize.
    const sendResize = () => {
      try { fit.fit() } catch {}
      send({ type: 'term.resize', session_id: sessionId, cols: term.cols, rows: term.rows })
    }
    const ro = new ResizeObserver(() => sendResize())
    if (hostRef.current) ro.observe(hostRef.current)
    window.addEventListener('resize', sendResize)
    // Initial resize so the PTY matches the rendered grid.
    sendResize()

    return () => {
      try { dataDisp.dispose() } catch {}
      try { unsub() } catch {}
      try { ro.disconnect() } catch {}
      window.removeEventListener('resize', sendResize)
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
