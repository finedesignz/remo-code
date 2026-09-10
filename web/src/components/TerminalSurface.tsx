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
import type { CSSProperties } from 'react'
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
 * Map a textarea InputEvent (inputType, data) to the raw bytes the PTY expects.
 * This is the EXACTLY-ONCE mobile/IME input seam: on iOS WebKit every keystroke
 * is routed through composition (keydown keyCode 229) and never reaches xterm's
 * keyboard handler, so xterm would otherwise both compose/echo the glyph locally
 * AND let the PTY (claude) echo it back → doubled characters. We instead read the
 * committed text straight off the helper <textarea>'s input events and send it
 * once, suppressing xterm's own local render.
 *
 * Returns the byte string to send, or null when the event carries nothing to send
 * (so the caller leaves xterm's onData to handle it — e.g. desktop control keys).
 * Exported for the exactly-once regression test.
 */
export function inputEventToBytes(inputType: string, data: string | null): string | null {
  switch (inputType) {
    // Printable text — typed, composed (predictive/IME commit), autocorrect swap,
    // dictation, or paste. `data` holds the committed string.
    case 'insertText':
    case 'insertCompositionText':
    case 'insertReplacementText':
    case 'insertFromPaste':
    case 'insertFromComposition':
      return data && data.length > 0 ? data : null
    case 'insertLineBreak':
    case 'insertParagraph':
      return '\r'
    case 'deleteContentBackward':
      return '\x7f' // DEL — TUIs treat as backspace
    case 'deleteContentForward':
      return '\x1b[3~' // forward-delete
    default:
      return null
  }
}

/**
 * The single sentinel character kept in xterm's helper textarea at all times.
 * See the NATIVE HELD-KEY REPEAT comment in the mount effect for why: iOS
 * WebKit ends Backspace long-press auto-repeat once the target field no
 * longer visibly shrinks (i.e. once it's empty), which is exactly what
 * happened here — preventDefault() + resetting to '' after every processed
 * event left the textarea perpetually empty. A single stable non-empty value
 * keeps the OS perceiving deletable content on every tick.
 */
export const TA_KEEPALIVE_SENTINEL = ' '

/** Minimal textarea-shaped target so this is testable without a real DOM. */
export interface KeepAliveTarget {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
}

/** Resets `target` to the keepalive sentinel with the caret placed after it. */
export function applyTextareaKeepAlive(target: KeepAliveTarget): void {
  target.value = TA_KEEPALIVE_SENTINEL
  target.selectionStart = target.selectionEnd = target.value.length
}

// Common-prefix diff between the previously-sent interim hypothesis and the new
// one: backspace over the divergent suffix of `prev`, then type the new suffix
// of `next`. Used ONLY inside an active composition (see CompositionInputTracker)
// — outside one, `data` is a single already-committed unit and must be sent
// as-is (that's inputEventToBytes's job).
function diffInterimBytes(prev: string, next: string): string {
  // Iterate by CODE POINT, not UTF-16 code unit: an astral char (e.g. an emoji,
  // surrogate pair) counts as ONE backspace on a real terminal, not two. Using
  // `.length`/index access here over-counts the common prefix and the
  // backspace tail for any string containing one, e.g. retracting "ok 👍" to
  // "ok" must send exactly 2 DEL (for the space and the emoji), not 3.
  const prevCp = Array.from(prev)
  const nextCp = Array.from(next)
  let i = 0
  const max = Math.min(prevCp.length, nextCp.length)
  while (i < max && prevCp[i] === nextCp[i]) i++
  return '\x7f'.repeat(prevCp.length - i) + nextCp.slice(i).join('')
}
/** How long after compositionend a beforeinput can still be the engine's own
 * delivery of the commit rather than a fresh human keystroke. Browsers dispatch
 * the trailing commit event in the same input burst as compositionend (~0ms);
 * no human types within this window of their own commit. */
export const IME_COMMIT_WINDOW_MS = 30

const COMPOSITION_INSERT_TYPES: ReadonlySet<string> = new Set([
  'insertCompositionText',
  'insertReplacementText',
  'insertFromComposition',
  'insertText',
])

/**
 * Stateful companion to inputEventToBytes for the mobile-dictation / IME case.
 *
 * Root cause (owner-reported live bug, distinct from the double-echo fix above):
 * dictation (iOS/Android keyboard mic) runs ONE composition per utterance and
 * re-fires `beforeinput`(insertCompositionText) on EVERY interim recognizer
 * update, each time with `data` = the recognizer's FULL current hypothesis, not
 * a delta ("also", then "also fi", then "also fix", …). Forwarding `data`
 * verbatim accumulates "aalsoalso fialso fix…", so an in-flight hypothesis must
 * be DIFFED against what the PTY already has. A real multi-char composition is
 * distinguishable from the single-char iOS pseudo-composition ONLY via
 * compositionstart/compositionend — NOT by gating term.onData with them (that
 * regressed desktop typing in #306/#307; onData is untouched here).
 *
 * DESIGN — disambiguate at CONSUMPTION, never at compositionend.
 * Two engine orderings deliver the same commit:
 *   chrome/android: beforeinput(insertCompositionText,"ab") … compositionend("ab")
 *   ios/end-first : beforeinput(insertCompositionText,"ab") … compositionend("ab")
 *                   … beforeinput(insertText,"ab")
 * Up to and including compositionend these traces are BYTE-IDENTICAL, so no
 * decision taken inside onCompositionEnd can be correct for both — that is what
 * broke #463 (latch armed unconditionally: the chrome ordering swallowed the
 * next plain keystroke) and #465 (latch armed only on a differing final: the
 * ios ordering double-sent, "abab").
 *
 * So compositionend does ONE unconditional thing: it settles the line to the
 * authoritative final text by emitting diff(sent, final) — correct for both
 * orderings, and complete on its own if no trailing event ever arrives. What
 * remains is purely a question of SUPPRESSION, decided when the next event
 * actually shows up: a beforeinput is the engine re-delivering that same commit
 * only if it lands inside the commit burst window AND carries the text we just
 * settled on (or the stale interim some engines repeat there). Anything else —
 * different text, a later timestamp, a Backspace, an Enter — is a genuine
 * keystroke and is forwarded 1:1.
 *
 * A cancelled composition (compositionend with '' data) RETRACTS the interim
 * bytes already sent, one DEL per code point.
 *
 * All diffs are by CODE POINT (Array.from), so an astral char costs one DEL.
 */
export class CompositionInputTracker {
  private composing = false
  /** Text of this composition the PTY has actually received so far. */
  private sent = ''
  /** The browser's latest interim hypothesis for this composition. */
  private hypothesis = ''
  /** True while a settled commit may still be re-delivered by a trailing event. */
  private armed = false
  /** The authoritative committed text, as settled at compositionend. */
  private finalData = ''
  /** The last interim seen before compositionend — some engines repeat it. */
  private preEnd = ''
  private endedAt = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  onCompositionStart(): void {
    this.clear()
    this.composing = true
  }

  /**
   * `data` is compositionend.data: the engine's authoritative committed text,
   * `''` for a cancelled composition, or `null` when the engine omits it (then
   * the last interim hypothesis stands). Returns the bytes that settle the line
   * to that text, or null if nothing is owed.
   */
  onCompositionEnd(data: string | null = null): string | null {
    this.composing = false
    this.preEnd = this.hypothesis
    const cancelled = data === ''
    const final = cancelled ? '' : (data ?? this.hypothesis)
    const bytes = diffInterimBytes(this.sent, final)
    this.endedAt = this.now()
    if (cancelled || final === '') {
      this.clear()
    } else {
      this.sent = final
      this.hypothesis = final
      this.finalData = final
      this.armed = true
    }
    return bytes.length > 0 ? bytes : null
  }

  /** Bytes to send for this beforeinput event, or null to send nothing. */
  handleBeforeInput(inputType: string, data: string | null): string | null {
    if (this.composing) {
      if (COMPOSITION_INSERT_TYPES.has(inputType)) {
        // Interim revision of the SAME utterance — send only the delta.
        const next = data ?? ''
        const bytes = diffInterimBytes(this.sent, next)
        this.sent = next
        this.hypothesis = next
        return bytes.length > 0 ? bytes : null
      }
      if (inputType === 'deleteContentBackward') {
        // A correction mid-composition: shrink the tracked hypothesis by one
        // code point so the next diff doesn't re-delete what's already gone.
        const cps = Array.from(this.sent)
        cps.pop()
        this.sent = cps.join('')
        this.hypothesis = this.sent
        return '\x7f'
      }
      // Paste / newline / forward-delete mid-composition: not part of the
      // hypothesis stream, pass through.
      return inputEventToBytes(inputType, data)
    }

    if (this.armed) {
      const withinBurst = this.now() - this.endedAt <= IME_COMMIT_WINDOW_MS
      const d = data ?? ''
      const redelivered =
        withinBurst &&
        COMPOSITION_INSERT_TYPES.has(inputType) &&
        (d === this.finalData || (this.preEnd !== '' && d === this.preEnd))
      this.clear()
      // compositionend already put this exact text on the line — drop the echo.
      if (redelivered) return null
    }

    // No composition in flight (desktop; the iOS one-shot-per-char pseudo-
    // composition; a plain paste/newline/delete): unchanged 1:1 behavior.
    if (inputType === 'deleteContentBackward') this.sent = ''
    return inputEventToBytes(inputType, data)
  }

  private clear(): void {
    this.composing = false
    this.armed = false
    this.sent = ''
    this.hypothesis = ''
    this.finalData = ''
    this.preEnd = ''
  }
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

/** Toolbar keys where holding down must auto-repeat, matching a real keyboard's
 * typematic behavior. Esc/Enter/Ctrl-C are deliberately excluded — those must
 * never fire more than once per press (repeating Ctrl-C or Enter would be
 * actively dangerous/wrong). Exported so the repeat-DoD test can assert this
 * set stays exactly {up,down,left,right,tab}. */
export const REPEATABLE_KEYS: ReadonlySet<keyof typeof KEY_SEQUENCES> = new Set(['up', 'down', 'left', 'right', 'tab'])

/**
 * Injectable timer seam so KeyRepeater is unit-testable without real clocks —
 * tests supply a fake scheduler and fire callbacks deterministically instead of
 * racing real setTimeout/setInterval.
 */
export interface RepeatScheduler {
  setTimeout: (fn: () => void, ms: number) => number
  clearTimeout: (id: number) => void
  setInterval: (fn: () => void, ms: number) => number
  clearInterval: (id: number) => void
}

const windowScheduler: RepeatScheduler = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (id) => window.clearInterval(id),
}

/**
 * Press-and-hold auto-repeat for a toolbar key: fires once immediately on
 * start() (a real keyboard registers the first press instantly), waits
 * `initialMs` before repeating (so a normal tap never repeats), then fires
 * every `intervalMs` until stop(). One instance is reused per press (a new one
 * created per pointerdown); stop() is idempotent and cancels both timers.
 */
export class KeyRepeater {
  private timeoutId: number | null = null
  private intervalId: number | null = null
  private blurListenersBound = false
  private readonly onBlur = () => this.stop()
  private readonly onVisibilityChange = () => { if (document.hidden) this.stop() }
  constructor(
    private readonly fire: () => void,
    private readonly scheduler: RepeatScheduler = windowScheduler,
    private readonly initialMs = 400,
    private readonly intervalMs = 50,
  ) {}
  start(): void {
    this.stop()
    this.bindBlurListeners()
    this.fire()
    this.timeoutId = this.scheduler.setTimeout(() => {
      this.timeoutId = null
      this.intervalId = this.scheduler.setInterval(() => this.fire(), this.intervalMs)
    }, this.initialMs)
  }
  stop(): void {
    if (this.timeoutId != null) { this.scheduler.clearTimeout(this.timeoutId); this.timeoutId = null }
    if (this.intervalId != null) { this.scheduler.clearInterval(this.intervalId); this.intervalId = null }
    this.unbindBlurListeners()
  }
  // Alt-tab / app-switch mid-hold must never leave the 50ms interval running —
  // there is no matching pointerup off-window, so without this the repeater
  // fires forever into a session the user is no longer looking at.
  private bindBlurListeners(): void {
    if (this.blurListenersBound || typeof window === 'undefined') return
    window.addEventListener('blur', this.onBlur)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    this.blurListenersBound = true
  }
  private unbindBlurListeners(): void {
    if (!this.blurListenersBound) return
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.blurListenersBound = false
  }
}

// Touch-focus suppression window. After a touch gesture we swallow the SYNTHETIC
// mousedown Safari replays (~a few hundred ms later) so it can't re-summon the iOS
// keyboard the user just dismissed by tapping. But ONLY for this short window — a
// genuine mouse click a second+ after any touch (hybrid touchscreen laptop /
// precision touchpad / pen) must still focus. 700ms clears the synthetic replay
// with margin while staying well under any deliberate later click.
export const TOUCH_SUPPRESS_MS = 700
// Injectable clock: prod reads Date.now; the focus-latch test advances it to prove
// a mouse click LONG after a touch refocuses (the permanent-latch regression).
let _touchNowMs: () => number = () => Date.now()
export function __setTouchClockForTest(fn: (() => number) | null): void {
  _touchNowMs = fn ?? (() => Date.now())
}

export function TerminalSurface({ sessionId, subscribe, send, className }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const pasteBoxRef = useRef<HTMLTextAreaElement | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [kbOpen, setKbOpen] = useState(false)
  // Timestamp (ms, from `_touchNowMs`) of the END of the most recent touch gesture.
  // `recentTouch()` is true only inside the TOUCH_SUPPRESS_MS window after it: while
  // true we swallow the synthetic mousedown Safari replays post-tap (a focus IS the
  // keyboard on iOS), while a genuine mouse click later still focuses. NOT a
  // permanent "is a touch device" latch — that broke click-to-focus on hybrids.
  const lastTouchAtRef = useRef(0)
  const recentTouch = () => _touchNowMs() - lastTouchAtRef.current < TOUCH_SUPPRESS_MS
  // Mirror of kbOpen readable synchronously (and outside React's render cycle) by
  // the DOM event handlers below.
  const kbOpenRef = useRef(false)

  // Explicit keyboard control (iOS): focusing xterm's hidden textarea summons the
  // on-screen keyboard; blurring dismisses it. A genuine TAP on the terminal body
  // now FOCUSES/summons the keyboard ("I want to type here" — reverses #360's
  // tap-to-blur per owner), while a DRAG stays a pure scroll and never touches the
  // keyboard. The ⌨ button TOGGLES — it both summons and dismisses — so it remains
  // the way to HIDE the keyboard on a phone.
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
    if (recentTouch()) return
    try { termRef.current?.focus() } catch {}
  }, [send, sessionId])

  // Press-and-hold auto-repeat for arrows/Tab (REPEATABLE_KEYS). One KeyRepeater
  // per active press, held in a ref so pointerup/pointercancel/pointerleave/blur
  // can stop the SAME instance that pointerdown started (a stale closure over a
  // fresh repeater per render would stop the wrong one). startRepeat replaces
  // any still-running repeater first, so a stray missed pointerup from a prior
  // press can never leave two repeaters running at once.
  const repeaterRef = useRef<KeyRepeater | null>(null)
  // A pointerdown already sent the first keystroke via KeyRepeater; the browser
  // then fires a native 'click' right after for a real mouse/touch press
  // (preventDefault() on pointerdown suppresses the SIMULATED compatibility
  // click a touch pointer would otherwise get, but not a genuine mouse click).
  // This flag makes onClick a no-op for that follow-on click while still
  // sending once for a keyboard/screen-reader activation (Enter/Space), which
  // never fires pointerdown at all.
  const pointerHandledRef = useRef(false)
  const startRepeat = useCallback((seq: string) => {
    pointerHandledRef.current = true
    repeaterRef.current?.stop()
    const r = new KeyRepeater(() => sendKey(seq))
    repeaterRef.current = r
    r.start()
  }, [sendKey])
  const stopRepeat = useCallback(() => {
    repeaterRef.current?.stop()
  }, [])
  const clickIfNotPointer = useCallback((seq: string) => {
    if (pointerHandledRef.current) { pointerHandledRef.current = false; return }
    sendKey(seq)
  }, [sendKey])
  useEffect(() => stopRepeat, [stopRepeat]) // unmount safety net

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
      if (!recentTouch()) { try { termRef.current?.focus() } catch {} }
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
    if (recentTouch()) return
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
        if (!recentTouch()) { try { termRef.current?.focus() } catch {} }
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
    // NATIVE HELD-KEY REPEAT (root cause of "holding Backspace deletes once").
    // iOS WebKit's on-screen keyboard gates Backspace long-press auto-repeat on
    // the target field's content actually shrinking on each tick — holding
    // Backspace in an EMPTY field fires (at most) one beforeinput and then the
    // OS ends the repeat gesture, the same behavior as holding Backspace at the
    // very start of any real text field. Every event this handler processes
    // calls preventDefault() (below) AND used to force textarea.value = '' —
    // so the hidden helper textarea was perpetually empty from WebKit's point
    // of view on every single tick, for every key, not only Backspace. Fix:
    // keep one sentinel character (with the caret after it) in the textarea at
    // ALL times so the OS always perceives real, shrinkable content and keeps
    // repeating. The sentinel's actual value is never read anywhere else in
    // this handler — the committed text always comes from InputEvent.data, so
    // its presence changes nothing about what gets sent to the PTY.
    const keepTextareaAlive = () => { if (ta) applyTextareaKeepAlive(ta) }
    keepTextareaAlive()
    // EXACTLY-ONCE MOBILE/IME INPUT (the iOS double-character fix).
    // On iOS WebKit every keystroke is routed through IME composition (keydown
    // keyCode 229), so it never reaches xterm's keyboard handler. xterm's
    // CompositionHelper then renders the composed glyph INLINE in the terminal
    // buffer while the PTY (claude) ALSO echoes the committed bytes back over
    // term.data — two glyph sources for the same character → doubling
    // ("allsso iimm…"). The naive compositionend gate did not fix it.
    //
    // Fix: take deterministic control of the helper <textarea>. We read the
    // committed text off its `beforeinput` events, send those bytes to the PTY
    // EXACTLY ONCE, and preventDefault() so the textarea value never changes —
    // which cancels the follow-on `input`/composition events, so xterm neither
    // composes/echoes locally NOR fires onData for that text. The PTY's own echo
    // is then the single glyph source. We also reset the textarea to a single
    // sentinel character (never truly empty — see keepTextareaAlive below,
    // added for the native held-key-repeat fix) after each event so no
    // composition state accumulates across keystrokes.
    //
    // Desktop is unaffected: xterm preventDefaults printable keydowns and emits
    // onData itself, so no `beforeinput` fires for them — this handler only
    // engages on the IME/mobile path. Control keys (arrows, Esc, Tab, Ctrl-C,
    // fn-keys) on BOTH platforms still flow through keydown→onData below.
    //
    // DICTATION DEDUP: voice-to-text (mobile keyboard mic) runs one real
    // composition per utterance and re-fires beforeinput(insertCompositionText)
    // on every interim recognizer update, each time with the FULL current
    // hypothesis (not a delta) — sending `data` verbatim on every update
    // accumulates "aalsoalso fialso fix…". CompositionInputTracker (above)
    // distinguishes that in-flight case from the single-keystroke iOS
    // pseudo-composition via compositionstart/compositionend and diffs interim
    // revisions so only the actual delta is sent. These listeners feed the
    // tracker ONLY — they never gate term.onData (that gate regressed desktop
    // typing in #306/#307; onData below stays untouched).
    const inputTracker = new CompositionInputTracker()
    const onCompositionStart = () => inputTracker.onCompositionStart()
    // compositionend SETTLES the line to the engine's authoritative committed
    // text (and retracts the interim bytes on a cancel), so it emits bytes of
    // its own — they must be sent here, not deferred to a trailing beforeinput
    // that the chrome/android ordering never fires. See the design comment on
    // CompositionInputTracker.
    const onCompositionEnd = (e: CompositionEvent) => {
      const bytes = inputTracker.onCompositionEnd(e.data ?? null)
      if (bytes == null) return
      send({ type: 'term.input', session_id: sessionId, bytes: inputToB64(bytes) })
      keepTextareaAlive()
    }
    const onBeforeInput = (ev: Event) => {
      const ie = ev as InputEvent
      const bytes = inputTracker.handleBeforeInput(ie.inputType, ie.data)
      if (bytes == null) return // not a text/edit input we own → let xterm handle
      ev.preventDefault() // cancel local apply + the follow-on input/onData
      send({ type: 'term.input', session_id: sessionId, bytes: inputToB64(bytes) })
      // Reset to the sentinel (never truly empty — see keepTextareaAlive above)
      // so composition state can't accumulate AND held-key repeat isn't cut
      // short by an apparently-empty field.
      keepTextareaAlive()
    }
    if (ta) {
      ta.addEventListener('beforeinput', onBeforeInput)
      ta.addEventListener('compositionstart', onCompositionStart)
      ta.addEventListener('compositionend', onCompositionEnd)
    }

    // DESKTOP click-to-focus. A mouse focus opens no keyboard, so a click on the
    // terminal must still focus it (typing after a click keeps working). Guarded
    // against the SYNTHETIC mousedown Safari replays right after a touch gesture:
    // within TOUCH_SUPPRESS_MS of the last touch this is that replay, not a real
    // mouse, and must not focus (it would re-summon the iOS keyboard we just
    // dismissed). Outside that window a genuine mouse click DOES focus — the fix
    // for the hybrid-device regression where one stray touch latched focus off
    // forever.
    const focusTerm = () => {
      if (recentTouch()) return
      applyKeyboard(true)
    }
    const host = hostRef.current

    // TOUCH SCROLL + TAP-TO-FOCUS (mobile). Three prod bugs, one gesture handler:
    //
    //  1. DRAG DIDN'T SCROLL. The old handler poked `.xterm-viewport`.scrollTop.
    //     xterm has no touch support and renders `.xterm-screen` as an overlay
    //     SIBLING above the scrollable viewport, so the DOM scroll path is
    //     unreliable on iOS (and is a no-op the moment the viewport isn't the
    //     element the browser considers scrollable). We now drive xterm's OWN
    //     buffer API — `term.scrollLines(±n)` — computed from drag pixels ÷ row
    //     height. That works regardless of the DOM overlay problem.
    //  2. TAP = FOCUS/TYPE, DRAG = SCROLL. The FIRST-generation handler focused on
    //     touchSTART, so merely touching the screen to scroll summoned the iOS
    //     keyboard (a resize storm over the output being read). #360 over-corrected
    //     to tap-to-BLUR, which left the owner unable to type at all ("tap activates
    //     then blurs, can't activate again"). The owner's rule: a TAP (≤10px,
    //     ≤500ms, not on the scrollbar thumb) FOCUSES and summons the keyboard —
    //     "I want to type here" — and a DRAG stays a PURE SCROLL that never touches
    //     the keyboard (keeps #360's real fix). We focus SYNCHRONOUSLY in touchEND
    //     (the user gesture iOS requires to open the keyboard). The ⌨ toggle in the
    //     key bar TOGGLES — it both summons AND dismisses — so it stays the way to
    //     HIDE the keyboard. Desktop mousedown still focuses (a mouse focus opens no
    //     keyboard).
    //  3. ALT SCREEN. A full-screen TUI (claude/codex) owns the alt buffer and has
    //     NO scrollback; a DRAG there is a deliberate NO-OP. A TAP there still
    //     FOCUSES — the alt-screen TUI is exactly where the owner types — and we
    //     never synthesize keystrokes to fake scrolling (human-only PTY invariant:
    //     scrolling is not input).
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
      lastTouchAtRef.current = _touchNowMs() // open the synthetic-mousedown suppression window
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
      lastTouchAtRef.current = _touchNowMs() // refresh: measure the window from gesture END, not start
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
      // Re-open the suppression window from the gesture END: the synthetic mousedown
      // follows touchEND, so a >700ms drag measured from touchstart would wrongly
      // let that replay focus. Suppressing the replay ALSO means the tap-focus below
      // is the SINGLE focus for this gesture — the replayed mousedown can't re-fire it.
      lastTouchAtRef.current = _touchNowMs()
      e.preventDefault()
      // A genuine TAP = "type here": focus + summon the keyboard. Skip the scrollbar
      // thumb zone (a tap there is scrollbar territory, not a request to type). We call
      // applyKeyboard(true) DIRECTLY (not focusTerm, which recentTouch()-guards against
      // the synthetic replay) so the focus lands inside THIS user-gesture handler — the
      // only place iOS will honor .focus() to raise the keyboard.
      if (isTap && !onThumb) applyKeyboard(true)
    }
    host.addEventListener('touchstart', onTouchStart, { passive: false })
    host.addEventListener('touchmove', onTouchMove, { passive: false })
    host.addEventListener('touchend', onTouchEnd, { passive: false })
    // Desktop click-to-focus is unchanged — a mouse focus opens no keyboard.
    // (focusTerm no-ops only for the brief post-touch window; see recentTouch.)
    host.addEventListener('mousedown', focusTerm)

    // SESSION SWITCH / mount: start from a clean buffer so a prior session's
    // bytes never bleed into this one (T-16-10). Scrollback replay (below)
    // re-clears before writing the replayed buffer.
    term.clear()

    // Keystrokes → term.input (base64 raw bytes). This is the DESKTOP +
    // control-key path: xterm emits onData for printable keydowns (desktop) and
    // for control sequences (arrows/Esc/Tab/Ctrl-C/fn) on every platform. Mobile
    // TEXT input never reaches here — it is consumed (and preventDefaulted) by
    // the `beforeinput` handler above, so it is sent exactly once and not
    // doubled. The two paths are disjoint by construction (beforeinput cancels
    // the input event that would otherwise drive onData), so no guard is needed.
    // `disposed` fences the handler: an unmounted/session-switched terminal
    // (whose onData disposable a straggler event still holds) must NEVER write
    // to the PTY. Two surfaces feeding one session is what doubled keystrokes
    // and starved the hub's turn lock.
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
      if (ta) {
        ta.removeEventListener('beforeinput', onBeforeInput)
        ta.removeEventListener('compositionstart', onCompositionStart)
        ta.removeEventListener('compositionend', onCompositionEnd)
      }
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
  // Repeatable-key buttons (arrows/Tab): keep a hold from being interpreted as
  // iOS text-selection/magnifier instead of a repeat, and drop the platform's
  // default 300ms touch-to-click delay that would otherwise stall the first
  // repeat tick.
  const repeatBtnStyle: CSSProperties = {
    touchAction: 'manipulation',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  }

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
        {/* Repeatable keys (arrows, Tab): pointerdown starts KeyRepeater (fires
            once immediately, then repeats after a 400ms hold), any release/exit
            path stops it. touch-action + -webkit-user-select/-touch-callout
            keep a hold from triggering iOS text-selection/magnifier instead of
            repeating. Also keep onClick so keyboard/screen-reader activation
            (Enter/Space on a focused button, which never fires pointerdown)
            still sends a single keystroke. */}
        <button
          type="button"
          className={btn}
          title="Up"
          style={repeatBtnStyle}
          onPointerDown={(e) => { e.preventDefault(); startRepeat(KEY_SEQUENCES.up) }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          onBlur={stopRepeat}
          onClick={() => clickIfNotPointer(KEY_SEQUENCES.up)}
        >↑</button>
        <button
          type="button"
          className={btn}
          title="Down"
          style={repeatBtnStyle}
          onPointerDown={(e) => { e.preventDefault(); startRepeat(KEY_SEQUENCES.down) }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          onBlur={stopRepeat}
          onClick={() => clickIfNotPointer(KEY_SEQUENCES.down)}
        >↓</button>
        <button
          type="button"
          className={btn}
          title="Left"
          style={repeatBtnStyle}
          onPointerDown={(e) => { e.preventDefault(); startRepeat(KEY_SEQUENCES.left) }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          onBlur={stopRepeat}
          onClick={() => clickIfNotPointer(KEY_SEQUENCES.left)}
        >←</button>
        <button
          type="button"
          className={btn}
          title="Right"
          style={repeatBtnStyle}
          onPointerDown={(e) => { e.preventDefault(); startRepeat(KEY_SEQUENCES.right) }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          onBlur={stopRepeat}
          onClick={() => clickIfNotPointer(KEY_SEQUENCES.right)}
        >→</button>
        <button
          type="button"
          className={btn}
          title="Tab"
          style={repeatBtnStyle}
          onPointerDown={(e) => { e.preventDefault(); startRepeat(KEY_SEQUENCES.tab) }}
          onPointerUp={stopRepeat}
          onPointerCancel={stopRepeat}
          onPointerLeave={stopRepeat}
          onBlur={stopRepeat}
          onClick={() => clickIfNotPointer(KEY_SEQUENCES.tab)}
        >Tab</button>
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
