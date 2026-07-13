/**
 * fix/term-touch-scroll — iOS Safari touch invariants for TerminalSurface.
 *
 * Three prod bugs reported from an iPhone on app.remo-code.com, all in the touch
 * gesture handler:
 *
 *   1. "dragging the screen to scroll up doesn't work, only dragging the actual
 *      scroll bar". The handler poked `.xterm-viewport`.scrollTop; xterm has no
 *      touch support and renders `.xterm-screen` as an overlay SIBLING above the
 *      viewport, so that DOM path never moved the buffer. FIX: drive xterm's own
 *      buffer API, `term.scrollLines(±n)`, from drag pixels ÷ row height.
 *
 *   2. "the keyboard auto pops up when clicking the screen". The handler called
 *      term.focus() on touchSTART, so any touch — including a scroll drag —
 *      summoned the iOS keyboard over the output being read. FIX (owner-corrected
 *      semantics): NOTHING on the touch path focuses. A drag is pure scroll, and a
 *      TAP (≤10px, ≤500ms) BLURS the helper textarea — "when i click the text in
 *      the terminal, it should blur the input box and hide the keyboard on ios".
 *      The ⌨ toggle in the key bar is the SOLE way to summon the keyboard on touch.
 *      DESKTOP is unchanged: a mouse click still focuses (a mouse focus opens no
 *      keyboard), so typing after a click keeps working.
 *
 *   3. Alt screen. A full-screen TUI owns the alt buffer and has NO scrollback, so
 *      a drag there must be an inert no-op — and must NEVER be turned into
 *      keystrokes (the human-only PTY invariant: scrolling is not input).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Bun's test runner shares ONE process across files (the QC gate runs each file
// isolated; a local `bun test web/test/` does not). happy-dom throws if a sibling
// already registered, so register only when the DOM isn't there yet.
if (!(globalThis as any).document) GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Stubbed xterm — happy-dom has no canvas/renderer. We assert on the buffer API
// (scrollLines) + focus(), which is exactly the contract under test.
// ---------------------------------------------------------------------------
type Stub = {
  scrolled: number[]
  focusCount: number
  blurCount: number
  bufferType: 'normal' | 'alternate'
}
const stub: Stub = { scrolled: [], focusCount: 0, blurCount: 0, bufferType: 'normal' }

mock.module('@xterm/xterm', () => ({
  Terminal: class {
    textarea: any = { setAttribute() {}, blur() { stub.blurCount++ } }
    cols = 80
    rows = 24
    get buffer() {
      return { active: { baseY: 0, get type() { return stub.bufferType } } }
    }
    loadAddon() {}
    open() {}
    clear() {}
    write() {}
    dispose() {}
    focus() { stub.focusCount++ }
    scrollLines(n: number) { stub.scrolled.push(n) }
    onData() { return { dispose() {} } }
  },
}))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
mock.module('@xterm/xterm/css/xterm.css', () => ({}))

// happy-dom lays nothing out, so clientHeight is 0 and the component falls back
// to a 17px row height. Pin it explicitly so the pixel→row math is deterministic:
// 24 rows * 17px = 408px host.
const ROW_PX = 17

function touch(type: string, clientY: number, clientX = 0): TouchEvent {
  const e: any = new Event(type, { bubbles: true, cancelable: true })
  e.touches = [{ clientY, clientX }]
  return e as TouchEvent
}

let root: any
let host: HTMLDivElement
const sent: any[] = []

async function mountSurface() {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { TerminalSurface } = await import('../src/components/TerminalSurface')

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(TerminalSurface, {
        sessionId: 's1',
        send: (m: object) => sent.push(m),
        subscribe: () => () => {},
      }),
    )
  })
  // The xterm host div is the last child of the surface wrapper.
  const wrapper = host.firstElementChild as HTMLElement
  return { termHost: wrapper.lastElementChild as HTMLElement, act }
}

beforeEach(() => {
  stub.scrolled = []
  stub.focusCount = 0
  stub.blurCount = 0
  stub.bufferType = 'normal'
  sent.length = 0
})

afterEach(async () => {
  const { act } = await import('react')
  await act(async () => { root?.unmount() })
})

describe('BUG 1 — a finger drag scrolls the terminal BUFFER', () => {
  test('drag down scrolls the buffer up (older output) via term.scrollLines', async () => {
    const { termHost, act } = await mountSurface()

    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      // Finger moves DOWN 5 rows worth of pixels ⇒ reveal OLDER output.
      termHost.dispatchEvent(touch('touchmove', 100 + 5 * ROW_PX))
    })

    // Negative = scroll up toward the scrollback.
    const total = stub.scrolled.reduce((a, b) => a + b, 0)
    expect(stub.scrolled.length).toBeGreaterThan(0)
    expect(total).toBe(-5)
  })

  test('drag up scrolls the buffer down (newer output)', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 300))
      termHost.dispatchEvent(touch('touchmove', 300 - 3 * ROW_PX))
    })
    expect(stub.scrolled.reduce((a, b) => a + b, 0)).toBe(3)
  })

  test('sub-row jitter accumulates instead of being discarded', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      // Six 5px nudges = 30px = 1 row (17px) + remainder. None of them alone is a
      // full row; a non-accumulating handler would scroll ZERO.
      for (let i = 1; i <= 6; i++) termHost.dispatchEvent(touch('touchmove', 100 + i * 5))
    })
    expect(stub.scrolled.reduce((a, b) => a + b, 0)).toBe(-1)
  })
})

describe('BUG 2 — on TOUCH, a tap BLURS (hides the keyboard); only ⌨ summons it', () => {
  test('a DRAG never focuses and never blurs (pure scroll)', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchmove', 100 + 4 * ROW_PX))
      termHost.dispatchEvent(touch('touchend', 100 + 4 * ROW_PX))
    })
    expect(stub.focusCount).toBe(0)
    expect(stub.blurCount).toBe(0)
  })

  test('a TAP BLURS the helper textarea and NEVER focuses (iOS keyboard dismissed)', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchmove', 102)) // 2px < 10px slop
      termHost.dispatchEvent(touch('touchend', 102))
    })
    expect(stub.focusCount).toBe(0)
    expect(stub.blurCount).toBe(1)
  })

  test('touchstart alone does nothing (the old handler focused here)', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
    })
    expect(stub.focusCount).toBe(0)
    expect(stub.blurCount).toBe(0)
  })

  test('the ⌨ toggle focuses when toggled ON and blurs when toggled OFF', async () => {
    const { act } = await mountSurface()
    const toggle = host.querySelector('[data-testid="kb-toggle"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()

    await act(async () => { toggle.click() })          // ON → summon
    expect(stub.focusCount).toBe(1)
    expect(stub.blurCount).toBe(0)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    await act(async () => { toggle.click() })          // OFF → dismiss
    expect(stub.focusCount).toBe(1)
    expect(stub.blurCount).toBe(1)
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  test('the ⌨ toggle is visually obvious when ON — BLUE accent, never indigo', async () => {
    const { act } = await mountSurface()
    const toggle = host.querySelector('[data-testid="kb-toggle"]') as HTMLButtonElement
    const off = toggle.className
    await act(async () => { toggle.click() })
    expect(toggle.className).not.toBe(off)
    expect(toggle.className).toContain('accent-blue')
    expect(toggle.className).not.toContain('indigo')
  })

  test('DESKTOP mousedown still FOCUSES (click-to-focus, no blur) — typing keeps working', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(stub.focusCount).toBe(1)
    expect(stub.blurCount).toBe(0)
  })

  test('a mousedown REPLAYED by Safari after a touch does NOT re-focus', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchend', 100))
      // Safari's synthetic compat mouse event after the tap.
      termHost.dispatchEvent(new Event('mousedown', { bubbles: true, cancelable: true }))
    })
    expect(stub.focusCount).toBe(0)
    expect(stub.blurCount).toBe(1)
  })
})

describe('SCROLLBAR THUMB — a drag starting on the thumb is NOT inverted', () => {
  test('thumb drag DOWN scrolls toward NEWER output (positive), unlike a content drag', async () => {
    const { termHost, act } = await mountSurface()
    // happy-dom lays nothing out; pin a rect so the right-edge thumb zone exists.
    ;(termHost as any).getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 408, width: 300, height: 408, toJSON() {},
    })
    await act(async () => {
      // startX = 295 ⇒ inside the 24px right-edge strip.
      termHost.dispatchEvent(touch('touchstart', 100, 295))
      termHost.dispatchEvent(touch('touchmove', 100 + 5 * ROW_PX, 295))
    })
    const total = stub.scrolled.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0) // NOT the inverted -5 of a content drag
    expect(sent.filter((f) => f.type === 'term.input').length).toBe(0)
  })
})

describe('BUG 3 — alt-screen drags are inert and NEVER become input', () => {
  test('no scrollLines and, critically, no term.input frames from a drag', async () => {
    stub.bufferType = 'alternate'
    const { termHost, act } = await mountSurface()

    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchmove', 100 + 6 * ROW_PX))
      termHost.dispatchEvent(touch('touchmove', 100 + 12 * ROW_PX))
      termHost.dispatchEvent(touch('touchend', 100 + 12 * ROW_PX))
    })

    expect(stub.scrolled.length).toBe(0)
    // The human-only PTY invariant: scrolling must not synthesize keystrokes.
    expect(sent.filter((f) => f.type === 'term.input').length).toBe(0)
  })

  test('a NORMAL-buffer drag also emits zero term.input frames', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchmove', 100 + 8 * ROW_PX))
      termHost.dispatchEvent(touch('touchend', 100 + 8 * ROW_PX))
    })
    expect(stub.scrolled.reduce((a, b) => a + b, 0)).toBe(-8)
    expect(sent.filter((f) => f.type === 'term.input').length).toBe(0)
  })
})
