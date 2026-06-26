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
import { useEffect, useRef, useState, useCallback } from 'react'
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
// Raw file bytes → base64 (for term.attach_file uploads).
export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000 // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * On-screen key sequences for the toolbar. The user's Apple keyboard has no
 * arrow keys, so ↑/↓ (menu navigation) are the critical entries; Esc/Tab/Ctrl-C
 * round out TUI control. Each value is the exact raw byte string sent verbatim
 * as a term.input keystroke. Exported for the byte-sequence test.
 */
export const KEY_SEQUENCES = {
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  tab: '\x09',
  enter: '\r',
  ctrlC: '\x03',
} as const

export function TerminalSurface({ sessionId, subscribe, send, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Send a raw key sequence as a term.input keystroke, then refocus the terminal
  // so the on-screen button press doesn't steal the cursor.
  const sendKey = useCallback((seq: string) => {
    send({ type: 'term.input', session_id: sessionId, bytes: inputToB64(seq) })
    try { termRef.current?.focus() } catch {}
  }, [send, sessionId])

  // Ctrl+V / paste: read clipboard text and inject it as a term.input keystroke
  // (same raw-byte path as on-screen keys). Image paste stays on the dedicated
  // upload effect below; this covers the text case the on-screen keyboard can't
  // reach on a phone. Falls back to a notice if the clipboard read is blocked.
  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) sendKey(text)
    } catch {
      setNotice('Clipboard read blocked — use the device paste gesture')
      setTimeout(() => setNotice(null), 4000)
    }
    try { termRef.current?.focus() } catch {}
  }, [sendKey])

  // Upload a file to the host (term.attach_file): the supervisor writes it to a
  // temp file and types its absolute path into the TUI.
  const uploadFile = useCallback((file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result as ArrayBuffer)
        send({ type: 'term.attach_file', session_id: sessionId, filename: file.name, data_b64: bytesToB64(bytes) })
        setNotice(`Uploaded ${file.name} → path inserted`)
        setTimeout(() => setNotice(null), 4000)
        try { termRef.current?.focus() } catch {}
      } catch {
        setNotice('Attachment upload failed')
        setTimeout(() => setNotice(null), 4000)
      }
    }
    reader.readAsArrayBuffer(file)
  }, [send, sessionId])

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      cursorBlink: true,
      // Deep scrollback so the user can scroll back through prior output (normal
      // buffer / shell). Full-screen TUIs use the alt-screen buffer and own their
      // own scrolling — scrollback only applies to the normal buffer.
      scrollback: 5000,
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
    // NOTE: an earlier `compositionstart`/`compositionend` gate (drop onData
    // while composing) was REVERTED — on desktop Chrome/Edge fast typing fires a
    // brief composition whose `compositionend` lands late, so the gate DROPPED
    // keystrokes and then dumped the buffered composed text, corrupting input
    // (e.g. "test"→"ess", "fast"→"fass"). The mobile-IME scramble it was meant to
    // fix needs a beforeinput-based input path instead (tracked separately); the
    // plain 1:1 onData→term.input below is correct on desktop.

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

  // Image paste (Ctrl-V / mobile paste): xterm's text paste can't carry image
  // bytes, so intercept paste events that contain image files and route them
  // through the same upload path. Separate effect so the heavy terminal effect
  // above doesn't re-run when the upload callback identity changes.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) { e.preventDefault(); uploadFile(f); return }
        }
      }
    }
    host.addEventListener('paste', onPaste)
    return () => host.removeEventListener('paste', onPaste)
  }, [uploadFile])

  const btn = 'px-2 py-1 rounded text-xs font-medium leading-none select-none ' +
    'bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] ' +
    'hover:bg-[var(--bg-tertiary)] active:opacity-80 min-h-[32px] min-w-[32px]'

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* On-screen key bar — supplies keys a phone/Apple keyboard can't (arrows,
          Esc, Tab, Ctrl-C) plus file attach. onMouseDown/preventDefault keeps
          terminal focus so typing stays live. */}
      <div
        className="sticky top-0 z-10 flex flex-wrap items-center gap-1 px-1 py-1 shrink-0 bg-[var(--bg-primary)] border-b border-[var(--border-color)]/40"
        onMouseDown={(e) => e.preventDefault()}
      >
        <button type="button" className={btn} title="Escape" onClick={() => sendKey(KEY_SEQUENCES.esc)}>Esc</button>
        <button type="button" className={btn} title="Up" onClick={() => sendKey(KEY_SEQUENCES.up)}>↑</button>
        <button type="button" className={btn} title="Down" onClick={() => sendKey(KEY_SEQUENCES.down)}>↓</button>
        <button type="button" className={btn} title="Left" onClick={() => sendKey(KEY_SEQUENCES.left)}>←</button>
        <button type="button" className={btn} title="Right" onClick={() => sendKey(KEY_SEQUENCES.right)}>→</button>
        <button type="button" className={btn} title="Tab" onClick={() => sendKey(KEY_SEQUENCES.tab)}>Tab</button>
        <button type="button" className={btn} title="Enter" onClick={() => sendKey(KEY_SEQUENCES.enter)}>⏎</button>
        <button type="button" className={btn} title="Ctrl-C (interrupt)" onClick={() => sendKey(KEY_SEQUENCES.ctrlC)}>^C</button>
        <button
          type="button"
          className={btn}
          title="Paste (Ctrl+V)"
          aria-label="Ctrl+V"
          onClick={() => { void pasteClipboard() }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
        </button>
        <button type="button" className={btn} title="Attach file" onClick={() => fileInputRef.current?.click()}>📎</button>
        {notice && <span className="text-xs text-[var(--text-muted)] ml-1">{notice}</span>}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) uploadFile(f)
            e.target.value = '' // allow re-selecting the same file
          }}
        />
      </div>
      <div
        ref={hostRef}
        // overflow:hidden bounds the host so xterm's own .xterm-viewport owns the
        // scroll (touch + wheel) inside a definite height — without this the host
        // can grow to its content and the page/toolbar scroll instead of the term.
        style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}
      />
    </div>
  )
}
