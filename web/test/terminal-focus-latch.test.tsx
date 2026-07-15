/**
 * fix/terminal-focus-latch — the touch-focus suppression must be TIME-BOUNDED.
 *
 * REGRESSION (owner, desktop Windows, hybrid touchscreen): the terminal could
 * blur but a mouse click could no longer refocus it — "can blur but cannot make
 * it active for typing". Root cause: `touchOriginRef` was set TRUE permanently in
 * onTouchStart, so `focusTerm` (bound to mousedown) early-returned FOREVER after
 * any single stray touch (touchscreen laptop / precision touchpad / pen), while
 * blur still worked. One touch latched click-to-focus off for the whole session.
 *
 * FIX: replace the permanent boolean with a timestamp + a TOUCH_SUPPRESS_MS
 * window. The synthetic mousedown Safari replays after a touch (~a few hundred ms)
 * is still swallowed; a genuine mouse click LONG after any touch focuses again.
 *
 * We drive the injectable `__setTouchClockForTest` clock to prove BOTH cases
 * deterministically (production still reads Date.now).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!(globalThis as any).document) GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Stubbed xterm — happy-dom has no canvas/renderer. We assert on focus()/blur(),
// which is exactly the click-to-focus contract under test.
type Stub = { focusCount: number; blurCount: number }
const stub: Stub = { focusCount: 0, blurCount: 0 }

mock.module('@xterm/xterm', () => ({
  Terminal: class {
    textarea: any = { setAttribute() {}, blur() { stub.blurCount++ } }
    cols = 80
    rows = 24
    get buffer() { return { active: { baseY: 0, type: 'normal' } } }
    loadAddon() {}
    open() {}
    clear() {}
    write() {}
    dispose() {}
    focus() { stub.focusCount++ }
    scrollLines() {}
    onData() { return { dispose() {} } }
  },
}))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
mock.module('@xterm/xterm/css/xterm.css', () => ({}))

function touch(type: string, clientY = 0, clientX = 0): TouchEvent {
  const e: any = new Event(type, { bubbles: true, cancelable: true })
  e.touches = [{ clientY, clientX }]
  return e as TouchEvent
}
const mousedown = () => new Event('mousedown', { bubbles: true, cancelable: true })

let root: any
let host: HTMLDivElement
const sent: any[] = []
let clock = 0
const advance = (ms: number) => { clock += ms }

async function mountSurface() {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const mod = await import('../src/components/TerminalSurface')
  mod.__setTouchClockForTest(() => clock)

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(mod.TerminalSurface, {
        sessionId: 's1',
        send: (m: object) => sent.push(m),
        subscribe: () => () => {},
      }),
    )
  })
  const wrapper = host.firstElementChild as HTMLElement
  return { termHost: wrapper.lastElementChild as HTMLElement, act, TOUCH_SUPPRESS_MS: mod.TOUCH_SUPPRESS_MS }
}

beforeEach(() => {
  stub.focusCount = 0
  stub.blurCount = 0
  sent.length = 0
  clock = 10_000 // arbitrary non-zero base so a fresh (0) ref isn't "recent"
})

afterEach(async () => {
  const { act } = await import('react')
  const mod = await import('../src/components/TerminalSurface')
  mod.__setTouchClockForTest(null) // restore Date.now for other files
  await act(async () => { root?.unmount() })
})

describe('touch-focus suppression is TIME-BOUNDED (not a permanent latch)', () => {
  test('mousedown WITHIN the window after a touch does NOT focus (synthetic-suppression preserved)', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchend', 100))
      advance(300) // Safari replays its synthetic mousedown ~a few hundred ms later
      termHost.dispatchEvent(mousedown())
    })
    expect(stub.focusCount).toBe(0)
  })

  test('mousedown MORE than the window after the last touch DOES focus (the fix)', async () => {
    const { termHost, act, TOUCH_SUPPRESS_MS } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchend', 100))
      advance(TOUCH_SUPPRESS_MS + 1) // a genuine, deliberate click later
      termHost.dispatchEvent(mousedown())
    })
    expect(stub.focusCount).toBe(1)
  })

  test('a stray touch does not latch focus off forever — a much later click still focuses', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      termHost.dispatchEvent(touch('touchend', 100))
    })
    advance(60_000) // a full minute of hybrid-desktop use later
    await act(async () => { termHost.dispatchEvent(mousedown()) })
    expect(stub.focusCount).toBe(1)
  })

  test('window is measured from gesture END: a long drag then an immediate replay is still suppressed', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => {
      termHost.dispatchEvent(touch('touchstart', 100))
      advance(2000)                      // drag lasts 2s (> window) ...
      termHost.dispatchEvent(touch('touchmove', 300))
      termHost.dispatchEvent(touch('touchend', 300))
      advance(100)                       // ... synthetic mousedown right after END
      termHost.dispatchEvent(mousedown())
    })
    // Measured from touchstart this would be >700ms and wrongly focus; measured
    // from END (touchmove/touchend refresh the timestamp) it is suppressed.
    expect(stub.focusCount).toBe(0)
  })

  test('desktop mouse-only (no touch ever) focuses on click, always', async () => {
    const { termHost, act } = await mountSurface()
    await act(async () => { termHost.dispatchEvent(mousedown()) })
    expect(stub.focusCount).toBe(1)
  })
})
