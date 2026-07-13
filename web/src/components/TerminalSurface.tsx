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
  const pasteBoxRef = useRef<HTMLTextAreaElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  // TRUE once this surface has seen a touch — i.e. we're on a touch device. On a
  // touch device the ONLY thing allowed to summon the on-screen keyboard is the
  // ⌨ toggle: nothing else may call term.focus() (a focus IS the keyboard on iOS).
  const touchOriginRef = useRef(false)
  // Mirror of kbOpen readable synchronously (and outside React's render cycle) by
  // the DOM event handlers below.
  const kbOpenRef = useRef(false)

  // Explicit keyboard control (iOS): focusing xterm's hidden textarea summons the
  // on-screen keyboard; blurring dismisses it. Tapping the terminal body now
  // BLURS (the body is for reading — a tap means "get out of my way"), so the ⌨
  // button is the SOLE way to summon the keyboard on a phone, and also the only
  // dismiss affordance Safari gives us.
  //
  // The focus/blur happens HERE, not inside a setState updater: an updater must be
  // PURE (React StrictMode double-invokes it in dev, which would fire focus/blur
  // twice per press).
  const applyKeyboard = useCallback((open: boolean) => {
    const term = termRef.current
    try {
      if (open) term?.focus()
      else term?.textarea?.blur()
    } catch {}
    kbOpenRef.current = open
    setKbOpen(open)
  }, [])
  const toggleKeyboard = useCallback(() => {
    applyKeyboard(!kbOpenRef.current)
  }, [applyKeyboard])

  // Send a raw key sequence as a term.input keystroke, then refocus the terminal
  // so the on-screen button press doesn't steal the cursor. On a TOUCH device a
  // refocus would pop the keyboard, so we skip it there (the PTY receives the
  // bytes regardless — focus is only about where the *browser* routes keystrokes).
  const sendKey = useCallback((seq: string) => {
    send({ type: 'term.input', session_id: sessionId, bytes: inputToB64(seq) })
    if (touchOriginRef.current) return
    try { termRef.current?.focus() } catch {}
  }, [send, sessionId])

  // Ctrl+V / paste. Two paths, in order:
  //
  //  1. navigator.clipboard.readText() — works on desktop Chrome/Edge/Safari.
  //  2. PASTE CAPTURE BOX — the iOS path. readText() is not usable there (Safari
  //     gates it behind its own permission UI and rejects when the gesture isn't
  //     attributed), AND the device long-press "Paste" menu can never reach the
  //     terminal on its own: xterm's capture target is a hidden 1px/opacity-0
  //     helper <textarea>, which iOS refuses to show an edit menu for. So we open
  //     a REAL, visible, focused textarea — a native paste target the OS is happy
  //     to offer its Paste menu on — and forward whatever lands in it to the PTY.
  //
  // Both paths end at the same raw-byte term.input frame as the on-screen keys.
  const pasteClipboard = useCallback(async () => {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      text = ''
    }
    if (text) {
      sendKey(text)
      // Refocus so typing continues after the button press — but NEVER on a touch
      // device: a focus IS the on-screen keyboard on iOS, and a paste must not
      // summon it (same rule sendKey follows).
      if (!touchOriginRef.current) { try { termRef.current?.focus() } catch {} }
      return
    }
    // Clipboard read blocked or empty-by-permission (iOS): fall back to the box.
    setPasteOpen(true)
  }, [sendKey])

  // Commit whatever the user got into the capture box, close it, and (desktop
  // only) refocus the terminal. On touch, closing the box blurs the textarea and
  // the keyboard goes away — re-summoning it here is exactly the bug #360 fixed,
  // so the ⌨ toggle stays the sole keyboard summon on a touch device.
  const commitPasteBox = useCallback((text: string) => {
    setPasteOpen(false)
    if (text) sendKey(text)
    if (touchOriginRef.current) return
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
        if (!touchOriginRef.current) { try { termRef.current?.focus() } catch {} }
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
      // 10k lines: a long agent reply on a phone (~40 cols) wraps hard, and 5k
      // lines was cutting the top off. xterm allocates buffer lines lazily, so
      // the cost is only paid for lines actually emitted.
      scrollback: 10000,
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

    // DESKTOP click-to-focus. A mouse focus opens no keyboard, so a click on the
    // terminal must still focus it (typing after a click keeps working). Guarded
    // against the SYNTHETIC mousedown Safari replays after a touch gesture: if the
    // last interaction was a touch, this is not a real mouse and must not focus
    // (that would re-summon the iOS keyboard we just dismissed).
    const focusTerm = () => {
      if (touchOriginRef.current) return
      applyKeyboard(true)
    }
    // TOUCH tap → BLUR. The terminal body is for READING: on a touch device a tap
    // on the output means "dismiss the keyboard so I can see the output".
    const blurTerm = () => applyKeyboard(false)
    const host = hostRef.current

    // TOUCH SCROLL + TAP-TO-BLUR (mobile). Three prod bugs, one gesture handler:
    //
    //  1. DRAG DIDN'T SCROLL. The old handler poked `.xterm-viewport`.scrollTop.
    //     xterm has no touch support and renders `.xterm-screen` as an overlay
    //     SIBLING above the scrollable viewport, so the DOM scroll path is
    //     unreliable on iOS (and is a no-op the moment the viewport isn't the
    //     element the browser considers scrollable). We now drive xterm's OWN
    //     buffer API — `term.scrollLines(±n)` — computed from drag pixels ÷ row
    //     height. That works regardless of the DOM overlay problem.
    //  2. KEYBOARD POPPED ON EVERY TOUCH. The old handler called focus() on
    //     touchSTART, so merely touching the screen to scroll summoned the iOS
    //     keyboard (shrinking the very output the user was trying to read, and
    //     firing a visualViewport resize storm). NOTHING on the touch path focuses
    //     any more: a drag is pure scroll, and a TAP (≤10px, ≤500ms) BLURS —
    //     tapping the output DISMISSES the keyboard. The ⌨ toggle in the key bar
    //     is the SOLE way to summon it on a touch device. Desktop mousedown still
    //     focuses (a mouse focus opens no keyboard).
    //  3. ALT SCREEN. A full-screen TUI owns the alt buffer and has NO scrollback;
    //     a drag there is a deliberate NO-OP. We never synthesize keystrokes to
    //     fake scrolling (human-only PTY invariant: scrolling is not input).
    //
    // We always preventDefault on touchmove so the gesture is CONTAINED — on iOS
    // body{overflow:hidden} does not stop visualViewport panning under the address
    // bar (which drags the sticky header/toolbar).
    const TAP_SLOP_PX = 10
    const TAP_MAX_MS = 500
    const isAltScreen = () => {
      try { return term.buffer?.active?.type === 'alternate' } catch { return false }
    }
    // Row height in CSS px, derived from the rendered grid (no xterm private API).
    const rowPx = () => {
      const h = host?.clientHeight ?? 0
      const rows = term.rows || 24
      const px = h > 0 ? h / rows : 0
      return px >= 4 ? px : 17 // fallback when the host isn't laid out yet
    }
    // SCROLLBAR-THUMB ZONE. xterm renders a thin native scrollbar at the right edge
    // of `.xterm-viewport`; the owner scrolls with it today. `touch-action` hands us
    // the gesture there too, so if we applied the CONTENT mapping (finger follows
    // content) a thumb drag would INVERT: pulling the thumb DOWN would reveal OLDER
    // output. So a gesture that STARTS in the right-edge strip gets THUMB semantics —
    // down = forward — scaled by the buffer/viewport ratio so the thumb still spans
    // the whole scrollback in one track length.
    const THUMB_ZONE_PX = 24
    const bufferScale = () => {
      try {
        const rows = term.rows || 24
        const total = (term.buffer?.active?.baseY ?? 0) + rows
        return Math.max(1, total / rows)
      } catch { return 1 }
    }
    let lastY = 0
    let startY = 0
    let startX = 0
    let startT = 0
    let maxMove = 0
    let accumPx = 0
    let onThumb = false
    const onTouchStart = (e: TouchEvent) => {
      touchOriginRef.current = true // this is a touch device — never auto-focus again
      const t = e.touches[0]
      startY = lastY = t?.clientY ?? 0
      startX = t?.clientX ?? 0
      startT = Date.now()
      maxMove = 0
      accumPx = 0
      const r = host?.getBoundingClientRect?.()
      // width 0 ⇒ nothing laid out (jsdom/happy-dom): never a thumb drag.
      onThumb = !!r && r.width > 0 && startX >= r.right - THUMB_ZONE_PX
      // NOTE: deliberately NO focusTerm() here — see (2) above.
    }
    const onTouchMove = (e: TouchEvent) => {
      // Multi-finger: hand the gesture back to the browser so pinch-zoom (the
      // accessibility escape hatch) still works over the terminal.
      if (e.touches.length > 1) return
      const t = e.touches[0]
      const y = t?.clientY ?? lastY
      const x = t?.clientX ?? startX
      maxMove = Math.max(maxMove, Math.abs(y - startY), Math.abs(x - startX))
      const dy = y - lastY
      lastY = y
      if (!isAltScreen()) {
        accumPx += dy
        const px = rowPx()
        const units = Math.trunc(accumPx / px)
        if (units !== 0) {
          accumPx -= units * px
          try {
            // Finger DOWN (dy > 0) on the CONTENT reveals OLDER output ⇒ scroll the
            // buffer UP. On the THUMB it means the opposite: down = toward newer.
            if (onThumb) term.scrollLines(Math.trunc(units * bufferScale()))
            else term.scrollLines(-units)
          } catch {}
        }
      }
      e.preventDefault()
    }
    const onTouchEnd = (e: TouchEvent) => {
      const isTap = maxMove <= TAP_SLOP_PX && Date.now() - startT <= TAP_MAX_MS
      // Always suppress the synthetic mouse events Safari replays after a touch
      // gesture — they would re-focus the terminal and re-open the keyboard.
      e.preventDefault()
      if (isTap) blurTerm()
    }
    host.addEventListener('touchstart', onTouchStart, { passive: false })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: false })
    // Desktop click-to-focus is unchanged — a mouse focus opens no keyboard.
    // (focusTerm no-ops once a touch has been seen; see touchOriginRef.)
    host.addEventListener('mousedown', focusTerm)

    // SESSION SWITCH / mount: start from a clean buffer so a prior session's
    // bytes never bleed into this one (T-16-10). Scrollback replay (below)
    // re-clears before writing the replayed buffer.
    term.clear()

    // Keystrokes → term.input (base64 raw bytes). STRICTLY 1:1 — one onData, one
    // frame. `disposed` fences the handler: an unmounted/session-switched
    // terminal (whose onData disposable a straggler event still holds) must
    // NEVER write to the PTY. Two surfaces feeding one session is what doubled
    // keystrokes and starved the hub's turn lock.
    let disposed = false
    const dataDisp = term.onData((d) => {
      if (disposed) return
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
    // events (mobile keyboard open) collapses to one resize. We ALSO dedup on
    // (cols,rows): the mobile keyboard/visualViewport fires a storm of resize
    // events that fit() often resolves to the SAME grid — re-sending an
    // identical term.resize makes the alt-screen TUI (claude/codex) repaint
    // mid-frame, leaving ghost cells (garbled "Kne"+"message" overwrites). Only
    // emit when the grid actually changed.
    let rafId = 0
    let lastCols = 0
    let lastRows = 0
    const sendResize = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        rafId = 0
        try { fit.fit() } catch {}
        if (term.cols === lastCols && term.rows === lastRows) return
        lastCols = term.cols
        lastRows = term.rows
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
      disposed = true
      if (rafId) cancelAnimationFrame(rafId)
      try { dataDisp.dispose() } catch {}
      try { unsub() } catch {}
      try { ro.disconnect() } catch {}
      window.removeEventListener('resize', sendResize)
      window.removeEventListener('orientationchange', sendResize)
      vv?.removeEventListener('resize', sendResize)
      host?.removeEventListener('touchstart', onTouchStart)
      host?.removeEventListener('touchmove', onTouchMove)
      host?.removeEventListener('touchend', onTouchEnd)
      host?.removeEventListener('mousedown', focusTerm)
      try { term.dispose() } catch {}
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, subscribe, send, applyKeyboard])

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

  // ⌨ toggle, ON state: BLUE accent (per design-preferences; the forbidden
  // purple-blue accent is never used), so "the keyboard is up" is unmistakable at a
  // glance on a phone.
  const btnOn = 'px-2 py-1 rounded text-xs font-medium leading-none select-none ' +
    'bg-[var(--accent-blue,#3b82f6)] text-[var(--text-on-accent,#ffffff)] ' +
    'border border-[var(--accent-blue,#3b82f6)] ring-1 ring-[var(--accent-blue,#3b82f6)] ' +
    'active:opacity-80 min-h-[32px] min-w-[32px]'

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
        <button
          type="button"
          className={kbOpen ? btnOn : btn}
          title={kbOpen ? 'Hide keyboard' : 'Show keyboard'}
          aria-label={kbOpen ? 'Hide keyboard' : 'Show keyboard'}
          aria-pressed={kbOpen}
          data-testid="kb-toggle"
          onClick={toggleKeyboard}
        >⌨</button>
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
      {/* PASTE CAPTURE BOX (iOS / blocked-clipboard fallback). A real textarea so
          the OS offers its native long-press Paste menu — the hidden xterm helper
          textarea never gets one. Pasted text (or typed text) is forwarded to the
          PTY as raw bytes; pasted images route through the same upload path as a
          drop. */}
      {pasteOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-16 bg-black/60"
          onMouseDown={(e) => { if (e.target === e.currentTarget) commitPasteBox('') }}
        >
          <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 shadow-xl">
            <div className="mb-2 text-xs text-[var(--text-muted)]">
              Long-press below and choose <span className="text-[var(--text-primary)]">Paste</span>, then Send.
            </div>
            <textarea
              ref={pasteBoxRef}
              autoFocus
              rows={4}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-sm text-[var(--text-primary)] font-mono"
              onPaste={(e) => {
                const items = e.clipboardData?.items
                if (items) {
                  for (const it of items) {
                    if (it.kind === 'file' && it.type.startsWith('image/')) {
                      const f = it.getAsFile()
                      if (f) { e.preventDefault(); setPasteOpen(false); uploadFile(f); return }
                    }
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); commitPasteBox('') }
                // Enter sends (Shift+Enter keeps a newline in the pasted payload).
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitPasteBox(e.currentTarget.value)
                }
              }}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => commitPasteBox('')}>Cancel</button>
              <button
                type="button"
                className={btn}
                onClick={() => commitPasteBox(pasteBoxRef.current?.value ?? '')}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        ref={hostRef}
        // overflow:hidden bounds the host so xterm's own .xterm-viewport owns the
        // scroll (touch + wheel) inside a definite height — without this the host
        // can grow to its content and the page/toolbar scroll instead of the term.
        // touchAction:'pinch-zoom' hands the single-finger vertical gesture to our
        // touchmove handler (instead of letting Safari pan the page/visualViewport
        // with it) while KEEPING pinch-zoom — the browser's accessibility escape
        // hatch — alive over the largest surface on the page. Our touchmove bails
        // out on multi-touch so the pinch reaches Safari untouched.
        style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden', background: 'var(--bg-primary)', touchAction: 'pinch-zoom' }}
      />
    </div>
  )
}
