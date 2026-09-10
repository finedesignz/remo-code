/**
 * Regression: the PTY terminal byte path must preserve RAW BYTES end-to-end.
 *
 * The 2026-06-04 bug: the supervisor utf8-decoded PTY bytes to a string and the
 * browser fed that binary string straight to xterm. Multibyte sequences (the
 * box-drawing borders of the claude/codex TUI) were corrupted — each 3-byte char
 * collapsed to one garbage byte — so the TUI rendered as bare fragments and the
 * cursor desynced. Fix: bytes stay bytes; xterm runs the only UTF-8 decode.
 *
 * These guard the browser end of the contract (the pure helpers). They simulate
 * the supervisor seam (bridge emits raw-byte latin1 string → session-bridge
 * re-base64s it unchanged) and assert the original bytes survive.
 */
import { describe, test, expect, spyOn } from 'bun:test'
import {
  inputToB64, b64ToBytes, inputEventToBytes, CompositionInputTracker,
  KeyRepeater, REPEATABLE_KEYS, type RepeatScheduler,
  applyTextareaKeepAlive, TA_KEEPALIVE_SENTINEL, type KeepAliveTarget,
} from '../src/components/TerminalSurface'

// Mirror of the (now-correct) supervisor output seam: raw PTY bytes → base64.
function supervisorWire(rawBytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < rawBytes.length; i++) bin += String.fromCharCode(rawBytes[i])
  return Buffer.from(bin, 'binary').toString('base64')
}

describe('PTY terminal byte encoding (regression)', () => {
  test('multibyte box-drawing + ANSI survive the output path byte-for-byte', () => {
    // "┌─┐" (each U+250x is 3 UTF-8 bytes) + ESC[1m + ASCII
    const original = new Uint8Array([
      0xe2, 0x94, 0x8c, 0xe2, 0x94, 0x80, 0xe2, 0x94, 0x90, // ┌─┐
      0x1b, 0x5b, 0x31, 0x6d, // ESC[1m
      0x41, 0x42, 0x43, // ABC
    ])
    const out = b64ToBytes(supervisorWire(original))
    expect(Array.from(out)).toEqual(Array.from(original))
  })

  test('inputToB64 encodes keystrokes as UTF-8 bytes (incl. multibyte)', () => {
    // 'é' is 0xC3 0xA9; '\r' is 0x0D.
    const b64 = inputToB64('é\r')
    const bytes = Array.from(b64ToBytes(b64))
    expect(bytes).toEqual([0xc3, 0xa9, 0x0d])
  })

  test('plain ASCII input is unchanged', () => {
    expect(Array.from(b64ToBytes(inputToB64('ls\r')))).toEqual([0x6c, 0x73, 0x0d])
  })

  test('b64ToBytes is tolerant of garbage input (returns empty, never throws)', () => {
    expect(b64ToBytes('!!!not-base64!!!').length).toBe(0)
  })
})

/**
 * Exactly-once mobile/iOS input contract (the IME double-echo fix).
 *
 * iOS WebKit routes every keystroke through composition; we read committed text
 * off the helper textarea's `beforeinput` events and send it ONCE. These guard
 * the pure inputType→bytes mapping that the surface's beforeinput handler uses,
 * proving a single insertText 'a' maps to exactly one 'a' byte (no double) and
 * edit keys map to the right control bytes.
 */
describe('mobile input — exactly-once inputType→bytes mapping', () => {
  test("insertText 'a' → single 'a' byte (no doubling)", () => {
    const bytes = inputEventToBytes('insertText', 'a')
    expect(bytes).toBe('a')
    expect(Array.from(b64ToBytes(inputToB64(bytes!)))).toEqual([0x61])
  })

  test('composed/predictive commit (insertCompositionText) sends the committed text', () => {
    expect(inputEventToBytes('insertCompositionText', 'hi')).toBe('hi')
    expect(inputEventToBytes('insertReplacementText', 'the')).toBe('the')
  })

  test('Enter → CR, backspace → DEL, forward-delete → CSI 3~', () => {
    expect(inputEventToBytes('insertLineBreak', null)).toBe('\r')
    expect(inputEventToBytes('insertParagraph', null)).toBe('\r')
    expect(inputEventToBytes('deleteContentBackward', null)).toBe('\x7f')
    expect(inputEventToBytes('deleteContentForward', null)).toBe('\x1b[3~')
  })

  test('empty / unknown inputType yields null (caller defers to xterm onData)', () => {
    expect(inputEventToBytes('insertText', '')).toBeNull()
    expect(inputEventToBytes('insertText', null)).toBeNull()
    expect(inputEventToBytes('historyUndo', null)).toBeNull()
    expect(inputEventToBytes('formatBold', null)).toBeNull()
  })
})

/**
 * Dictation dedup (owner-reported live bug, distinct from the double-echo fix
 * above). Voice-to-text runs ONE composition per utterance and re-fires
 * beforeinput(insertCompositionText) on every interim recognizer update, each
 * time with `data` = the FULL current hypothesis, not a delta. Sending `data`
 * verbatim on every update (inputEventToBytes's job for the single-keystroke
 * iOS pseudo-composition) accumulates "aalsoalso fialso fix…". These guard
 * CompositionInputTracker, which uses compositionstart/compositionend to tell
 * a real multi-revision composition apart from the single-char case and diffs
 * interim revisions so the committed sentence is sent exactly once.
 */
describe('mobile input — dictation composition dedup (CompositionInputTracker)', () => {
  test('a full dictated sentence, resent whole on every interim update, sends the final text exactly once', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const sent: string[] = []
    const interims = ['also', 'also fi', 'also fix', 'also fix this', 'also fix this duplicate', 'also fix this duplicate lettering']
    for (const hyp of interims) {
      const bytes = t.handleBeforeInput('insertCompositionText', hyp)
      if (bytes) sent.push(bytes)
    }
    // Final recognizer commit reorders/settles on the actual sentence.
    const finalBytes = t.handleBeforeInput('insertFromComposition', 'also fix this duplicate lettering issue when using voice.')
    if (finalBytes) sent.push(finalBytes)
    t.onCompositionEnd()

    // Replaying every sent chunk against a terminal-line model (backspaces
    // pop, everything else appends) must reconstruct the sentence EXACTLY
    // ONCE — no cumulative duplication, no leftover fragments.
    let line = ''
    for (const chunk of sent) {
      for (const ch of chunk) {
        if (ch === '\x7f') line = line.slice(0, -1)
        else line += ch
      }
    }
    expect(line).toBe('also fix this duplicate lettering issue when using voice.')
  })

  test('the single-keystroke iOS pseudo-composition (compositionstart never fires) is unaffected — each char sent as-is', () => {
    const t = new CompositionInputTracker()
    // No onCompositionStart(): matches iOS's per-character composition quirk,
    // where compositionstart doesn't precede the exactly-once beforeinput path.
    expect(t.handleBeforeInput('insertCompositionText', 'h')).toBe('h')
    expect(t.handleBeforeInput('insertCompositionText', 'i')).toBe('i')
  })

  test('desktop typing (no composition) still maps 1:1 through the tracker', () => {
    const t = new CompositionInputTracker()
    expect(t.handleBeforeInput('insertText', 'a')).toBe('a')
    expect(t.handleBeforeInput('deleteContentBackward', null)).toBe('\x7f')
    expect(t.handleBeforeInput('insertLineBreak', null)).toBe('\r')
  })

  test('a mid-dictation correction (deleteContentBackward) is reflected in the next diff', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    t.handleBeforeInput('insertCompositionText', 'hell')
    const del = t.handleBeforeInput('deleteContentBackward', null)
    expect(del).toBe('\x7f') // pending shrinks from 'hell' to 'hel'
    // Recognizer resumes and extends past the corrected point.
    const fix = t.handleBeforeInput('insertCompositionText', 'hello')
    expect(fix).toBe('lo') // common prefix 'hel' + new suffix 'lo', no extra backspace
  })

  test('compositionend resets tracker state for the next utterance (no cross-utterance bleed)', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    t.handleBeforeInput('insertCompositionText', 'first')
    t.onCompositionEnd()
    t.onCompositionStart()
    const bytes = t.handleBeforeInput('insertCompositionText', 'second')
    expect(bytes).toBe('second') // not diffed against 'first' — starts clean
  })

  // Decode a stream of raw bytes (DEL = backspace over the previous char) into
  // the final visible string, the way a real terminal would.
  function replay(chunks: (string | null)[]): string {
    let out: string[] = []
    for (const chunk of chunks) {
      if (!chunk) continue
      for (const ch of chunk) {
        if (ch === '\x7f') out.pop() // DEL removes one CODE POINT, not one UTF-16 unit
        else out.push(ch)
      }
    }
    return out.join('')
  }

  test('emoji retraction: "ok 👍" -> "ok" sends exactly 2 DEL, not 3 (code-point-aware diff)', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const grow = t.handleBeforeInput('insertCompositionText', 'ok 👍')
    const shrink = t.handleBeforeInput('insertCompositionText', 'ok')
    expect(shrink).toBe('\x7f\x7f') // one DEL for the emoji, one for the space
    expect(replay([grow, shrink])).toBe('ok')
  })

  test('CJK retraction diffs by code point, not UTF-16 unit', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const grow = t.handleBeforeInput('insertCompositionText', '你好世界')
    const shrink = t.handleBeforeInput('insertCompositionText', '你好')
    expect(shrink).toBe('\x7f\x7f')
    expect(replay([grow, shrink])).toBe('你好')
  })

  test('compositionend fires BEFORE the final beforeinput(insertText, "hello") — still sends "hello" exactly once', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'hel')
    t.onCompositionEnd('hello') // engine delivers the commit here, ahead of its beforeinput
    const c2 = t.handleBeforeInput('insertText', 'hello') // the trailing beforeinput the engine still fires
    expect(replay([c1, c2])).toBe('hello')
  })

  test('compositionend.data is used as the authoritative final revision when present', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'hel')
    t.onCompositionEnd('hello')
    // Some engines' trailing beforeinput repeats stale interim data instead of
    // the true commit — the tracker must still resolve to the compositionend
    // value, not double-apply whatever this event's own `data` says.
    const c2 = t.handleBeforeInput('insertCompositionText', 'hel')
    expect(replay([c1, c2])).toBe('hello')
  })

  test('normal ordering (beforeinput commit before compositionend) is unaffected', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'hel')
    const c2 = t.handleBeforeInput('insertText', 'hello')
    t.onCompositionEnd('hello')
    expect(replay([c1, c2])).toBe('hello')
  })
})

/**
 * Regression (PR #463 fallout): on the STANDARD Chrome/Android IME ordering
 * — beforeinput(insertCompositionText, "ab") fully sends the commit via
 * `pending`, THEN compositionend(data="ab") fires with no trailing
 * beforeinput — the old code armed `awaitingFinal` unconditionally. The
 * latch then stayed open for the NEXT, unrelated beforeinput (a plain
 * keystroke), which got diffed against the stale composition data instead
 * of forwarded, and was silently swallowed.
 */
describe('mobile input — chrome-order IME commit does not swallow the next keystroke (#463 regression)', () => {
  function replay(chunks: (string | null)[]): string {
    let out: string[] = []
    for (const chunk of chunks) {
      if (!chunk) continue
      for (const ch of chunk) {
        if (ch === '\x7f') out.pop()
        else out.push(ch)
      }
    }
    return out.join('')
  }

  test('chrome-order IME "ab" then plain "X" sends "abX"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'ab')
    t.onCompositionEnd('ab')
    const c2 = t.handleBeforeInput('insertText', 'X')
    expect(replay([c1, c2])).toBe('abX')
  })

  test('chrome-order IME "ab" then two plain chars sends "abXY"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'ab')
    t.onCompositionEnd('ab')
    const c2 = t.handleBeforeInput('insertText', 'X')
    const c3 = t.handleBeforeInput('insertText', 'Y')
    expect(replay([c1, c2, c3])).toBe('abXY')
  })

  test('emoji interim + chrome-order end + plain "y" sends the emoji then "y"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', '\u{1F600}')
    t.onCompositionEnd('\u{1F600}')
    const c2 = t.handleBeforeInput('insertText', 'y')
    expect(replay([c1, c2])).toBe('\u{1F600}y')
  })

  test('end-first order still yields exactly one "hello"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'hel')
    t.onCompositionEnd('hello')
    const c2 = t.handleBeforeInput('insertText', 'hello')
    expect(replay([c1, c2])).toBe('hello')
  })

  test('chrome-order IME commit then Enter forwards "\\r"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'hi')
    t.onCompositionEnd('hi')
    const c2 = t.handleBeforeInput('insertLineBreak', null)
    expect(replay([c1, c2])).toBe('hi\r')
  })

  test('chrome-order IME commit then Backspace forwards DEL', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'ab')
    t.onCompositionEnd('ab')
    const c2 = t.handleBeforeInput('deleteContentBackward', null)
    expect(replay([c1, c2])).toBe('a')
  })

  test('cancelled composition (empty compositionend data) then plain "X" sends only "X"', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    const c1 = t.handleBeforeInput('insertCompositionText', 'ni')
    t.onCompositionEnd('')
    const c2 = t.handleBeforeInput('insertText', 'X')
    expect(replay([c1, c2])).toBe('niX')
  })
})

/**
 * Mobile key repeat (owner-reported live bug): holding a key on the mobile
 * on-screen keyboard/toolbar deletes/moves once instead of repeating like a
 * real physical keyboard.
 *
 * Part 1 — the NATIVE keyboard path (deleteContentBackward / insertText
 * during a held key). Neither #450's exactly-once forwarding nor #457's
 * CompositionInputTracker may collapse a run of identical consecutive
 * beforeinput events: a held key repeating the SAME inputType+data is a
 * legitimate repeat (send N times), while dictation resending the SAME
 * (growing, not identical) hypothesis is the #457 bug (diff, don't resend).
 * The discriminator is composition state, not payload equality — these tests
 * pin that N consecutive events of the same type always produce N sends.
 */
describe('mobile input — held-key repeat is never collapsed (native keyboard path)', () => {
  test('N consecutive deleteContentBackward beforeinput events send N backspace bytes', () => {
    const t = new CompositionInputTracker() // no composition in flight — the plain desktop/iOS path
    const sent: (string | null)[] = []
    for (let i = 0; i < 5; i++) sent.push(t.handleBeforeInput('deleteContentBackward', null))
    expect(sent).toEqual(['\x7f', '\x7f', '\x7f', '\x7f', '\x7f'])
  })

  test('N consecutive insertText events for a held letter each send their own byte (no dedup)', () => {
    const t = new CompositionInputTracker()
    const sent: (string | null)[] = []
    for (let i = 0; i < 4; i++) sent.push(t.handleBeforeInput('insertText', 'a'))
    expect(sent).toEqual(['a', 'a', 'a', 'a'])
  })

  test('deleteContentBackward repeats are still forwarded N times even mid-composition (dictation correction spam is not held-key repeat, but must not be swallowed)', () => {
    const t = new CompositionInputTracker()
    t.onCompositionStart()
    t.handleBeforeInput('insertCompositionText', 'hello')
    const sent: (string | null)[] = []
    for (let i = 0; i < 3; i++) sent.push(t.handleBeforeInput('deleteContentBackward', null))
    expect(sent).toEqual(['\x7f', '\x7f', '\x7f'])
  })
})

/**
 * Part 2 — the TOOLBAR press-and-hold path. Real hold timing is untestable
 * deterministically, so KeyRepeater takes an injectable RepeatScheduler: the
 * fake scheduler below records callbacks instead of racing real timers, and
 * the test fires them itself to drive the repeater through start -> initial
 * delay -> repeat -> stop deterministically.
 */
function makeFakeScheduler() {
  let nextId = 1
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const scheduler: RepeatScheduler = {
    setTimeout: (fn) => { const id = nextId++; timeouts.set(id, fn); return id },
    clearTimeout: (id) => { timeouts.delete(id) },
    setInterval: (fn) => { const id = nextId++; intervals.set(id, fn); return id },
    clearInterval: (id) => { intervals.delete(id) },
  }
  return {
    scheduler,
    // A real setTimeout is one-shot: it removes itself once fired. Mirror that
    // so a fired timeout doesn't linger in activeTimeoutCount().
    elapseInitialDelay: () => {
      for (const [id, fn] of Array.from(timeouts.entries())) { timeouts.delete(id); fn() }
    },
    tickInterval: () => { for (const fn of intervals.values()) fn() },
    activeIntervalCount: () => intervals.size,
    activeTimeoutCount: () => timeouts.size,
  }
}

/**
 * Root cause found on deeper investigation (owner reported holding Backspace
 * on the native iOS keyboard deletes once, contradicting a forwarding-only
 * check): the beforeinput handler calls preventDefault() on every processed
 * event AND used to force the hidden helper textarea's value to '' after
 * each one. iOS WebKit's on-screen keyboard ends Backspace long-press
 * auto-repeat once the target field stops visibly shrinking — an emptied
 * field is indistinguishable, to the OS, from "nothing left to delete", which
 * is exactly the observed "deletes once, then stops" symptom. These tests
 * pin the fix (applyTextareaKeepAlive) at the unit level: the field is NEVER
 * actually empty after processing an event, across any number of repeats.
 * NOTE: this proves the mechanism this repo's code controls. It does NOT
 * replace an on-device check — WebKit's own repeat-continuation heuristic is
 * unverifiable from this session. See the PR body for the exact on-device
 * probe.
 */
describe('mobile input — native held-key repeat is not cut short by an emptied textarea', () => {
  function fakeTextarea(): KeepAliveTarget {
    return { value: '', selectionStart: 0, selectionEnd: 0 }
  }

  test('the keepalive sentinel is non-empty', () => {
    expect(TA_KEEPALIVE_SENTINEL.length).toBeGreaterThan(0)
  })

  test('applyTextareaKeepAlive leaves the field non-empty with the caret after the sentinel', () => {
    const ta = fakeTextarea()
    applyTextareaKeepAlive(ta)
    expect(ta.value).toBe(TA_KEEPALIVE_SENTINEL)
    expect(ta.value.length).toBeGreaterThan(0)
    expect(ta.selectionStart).toBe(ta.value.length)
    expect(ta.selectionEnd).toBe(ta.value.length)
  })

  test('N consecutive held-Backspace ticks (beforeinput -> reset) never leave the field empty on any tick', () => {
    const ta = fakeTextarea()
    applyTextareaKeepAlive(ta) // initial mount seeding
    for (let i = 0; i < 30; i++) {
      // Simulates one deleteContentBackward beforeinput: we preventDefault
      // (the real DOM edit never applies) then reset to the keepalive value —
      // mirroring exactly what onBeforeInput does after every processed event.
      applyTextareaKeepAlive(ta)
      expect(ta.value).not.toBe('') // the regression this fix closes
      expect(ta.value.length).toBeGreaterThan(0)
    }
  })
})

describe('mobile toolbar — press-and-hold auto-repeat (KeyRepeater)', () => {
  test('start() fires immediately, then repeats only after the initial delay elapses', () => {
    let fireCount = 0
    const fake = makeFakeScheduler()
    const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
    r.start()
    expect(fireCount).toBe(1) // immediate first send, like a real keyboard's first keypress
    fake.tickInterval() // no interval scheduled yet — must be a no-op
    expect(fireCount).toBe(1)
    fake.elapseInitialDelay()
    expect(fake.activeIntervalCount()).toBe(1)
    fake.tickInterval()
    fake.tickInterval()
    fake.tickInterval()
    expect(fireCount).toBe(4) // 1 immediate + 3 repeat ticks
  })

  test('stop() halts repeats — release cancels both the pending delay and any running interval', () => {
    let fireCount = 0
    const fake = makeFakeScheduler()
    const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
    r.start()
    fake.elapseInitialDelay()
    fake.tickInterval()
    expect(fireCount).toBe(2)
    r.stop()
    expect(fake.activeIntervalCount()).toBe(0)
    expect(fake.activeTimeoutCount()).toBe(0)
    fake.tickInterval() // stopped — must not fire again
    expect(fireCount).toBe(2)
  })

  test('a stray fast tap (release before the initial delay elapses) never starts repeating', () => {
    let fireCount = 0
    const fake = makeFakeScheduler()
    const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
    r.start()
    r.stop() // released before elapseInitialDelay() would ever fire
    expect(fake.activeTimeoutCount()).toBe(0)
    expect(fireCount).toBe(1) // only the immediate send from the tap itself
  })

  test('starting a new press replaces (stops) any still-running repeat from a prior press', () => {
    let fireCount = 0
    const fake = makeFakeScheduler()
    const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
    r.start()
    fake.elapseInitialDelay()
    r.start() // simulates repeaterRef.current?.stop() + new instance in the component
    expect(fake.activeIntervalCount()).toBe(0) // the stale interval from press 1 is gone
    expect(fake.activeTimeoutCount()).toBe(1) // press 2's fresh initial-delay timer
  })

  test('REPEATABLE_KEYS is exactly the arrow/Tab set — Esc/Enter/Ctrl-C must never repeat', () => {
    expect(Array.from(REPEATABLE_KEYS).sort()).toEqual(['down', 'left', 'right', 'tab', 'up'])
    expect(REPEATABLE_KEYS.has('esc' as any)).toBe(false)
    expect(REPEATABLE_KEYS.has('enter' as any)).toBe(false)
    expect(REPEATABLE_KEYS.has('ctrlC' as any)).toBe(false)
  })
})

/**
 * Alt-tab / app-switch mid-hold must stop the repeater — without a window
 * blur / visibilitychange listener the 50ms interval survives focus loss and
 * keeps firing into a session the user is no longer looking at. bun's test
 * runtime has no DOM globals, so these tests install a minimal fake
 * window/document (EventTarget-backed) for the duration of the test only.
 */
function withFakeBrowserGlobals<T>(fn: () => T): T {
  const realWindow = (globalThis as any).window
  const realDocument = (globalThis as any).document
  const fakeWindow = new EventTarget()
  const fakeDocument = Object.assign(new EventTarget(), { hidden: false })
  ;(globalThis as any).window = fakeWindow
  ;(globalThis as any).document = fakeDocument
  try {
    return fn()
  } finally {
    ;(globalThis as any).window = realWindow
    ;(globalThis as any).document = realDocument
  }
}

describe('mobile toolbar — KeyRepeater stops on window blur / tab hide', () => {
  test('window blur mid-hold stops the repeater — no further ticks fire', () => {
    withFakeBrowserGlobals(() => {
      let fireCount = 0
      const fake = makeFakeScheduler()
      const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
      r.start()
      fake.elapseInitialDelay()
      fake.tickInterval()
      expect(fireCount).toBe(2)
      ;(globalThis as any).window.dispatchEvent(new Event('blur'))
      expect(fake.activeIntervalCount()).toBe(0)
      expect(fake.activeTimeoutCount()).toBe(0)
      fake.tickInterval()
      expect(fireCount).toBe(2) // never fires again after focus loss
    })
  })

  test('document visibilitychange to hidden mid-hold stops the repeater', () => {
    withFakeBrowserGlobals(() => {
      let fireCount = 0
      const fake = makeFakeScheduler()
      const r = new KeyRepeater(() => { fireCount++ }, fake.scheduler)
      r.start()
      fake.elapseInitialDelay()
      expect(fake.activeIntervalCount()).toBe(1)
      ;(globalThis as any).document.hidden = true
      ;(globalThis as any).document.dispatchEvent(new Event('visibilitychange'))
      expect(fake.activeIntervalCount()).toBe(0)
      fake.tickInterval()
      expect(fireCount).toBe(1) // only the immediate send before hide
    })
  })

  test('stop() removes the blur/visibilitychange listeners (no leak across presses)', () => {
    withFakeBrowserGlobals(() => {
      const win = (globalThis as any).window as EventTarget
      const doc = (globalThis as any).document as EventTarget
      const winRemove = spyOn(win, 'removeEventListener')
      const docRemove = spyOn(doc, 'removeEventListener')
      const fake = makeFakeScheduler()
      const r = new KeyRepeater(() => {}, fake.scheduler)
      r.start()
      r.stop()
      expect(winRemove).toHaveBeenCalledWith('blur', expect.any(Function))
      expect(docRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    })
  })
})
