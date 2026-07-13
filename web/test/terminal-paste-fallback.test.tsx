/**
 * fix/ios-paste — the toolbar Paste button must still work when the async
 * clipboard API is unusable.
 *
 * Prod defect: on iOS Safari `navigator.clipboard.readText()` rejects (or is
 * absent), so the toolbar Paste button did nothing but flash a notice. And the
 * device's own long-press Paste gesture can never reach the terminal, because
 * xterm's capture target is a hidden 1px/opacity-0 helper <textarea> that iOS
 * refuses to show an edit menu for. Net effect: on a phone there was NO way to
 * paste into a session.
 *
 * INVARIANTS:
 *   1. readText() available → its text goes straight out as a term.input frame.
 *   2. readText() rejects → a REAL, focusable paste-capture textarea is opened
 *      (a native paste target the OS will offer its Paste menu on).
 *   3. Text landing in that box → exactly one term.input frame carrying it.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Stub xterm: happy-dom has no canvas renderer, and only the send contract matters.
function stubXterm() {
  mock.module('@xterm/xterm', () => ({
    Terminal: class {
      textarea: any = null
      cols = 80
      rows = 24
      loadAddon() {}
      open() {}
      clear() {}
      write() {}
      focus() {}
      dispose() {}
      onData() {
        return { dispose() {} }
      }
    },
  }))
  mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
  mock.module('@xterm/xterm/css/xterm.css', () => ({}))
}

function setClipboard(readText: () => Promise<string>) {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { readText },
    configurable: true,
  })
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

async function mountSurface(sent: any[]) {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { TerminalSurface } = await import('../src/components/TerminalSurface')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(TerminalSurface, {
        sessionId: 's1',
        send: (m: object) => sent.push(m),
        subscribe: () => () => {},
      }),
    )
  })
  return { root, act }
}

const pasteButton = () =>
  document.querySelector('button[aria-label="Ctrl+V"]') as HTMLButtonElement | null
const pasteBox = () => document.querySelector('textarea') as HTMLTextAreaElement | null
const inputs = (sent: any[]) => sent.filter((f) => f.type === 'term.input')

beforeEach(() => {
  stubXterm()
  document.body.innerHTML = ''
})
afterEach(() => {
  mock.restore()
})

describe('fix/ios-paste — toolbar paste', () => {
  test('clipboard.readText() available → text is sent as one term.input frame', async () => {
    setClipboard(async () => 'hello from clipboard')
    const sent: any[] = []
    const { root, act } = await mountSurface(sent)

    await act(async () => {
      pasteButton()!.click()
    })

    expect(inputs(sent).length).toBe(1)
    expect(inputs(sent)[0].bytes).toBe(b64('hello from clipboard'))
    // Fast path took it — no fallback box.
    expect(pasteBox()).toBeNull()

    await act(async () => root.unmount())
  })

  test('readText() rejects (iOS) → the paste-capture box opens instead of silently failing', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError')
    })
    const sent: any[] = []
    const { root, act } = await mountSurface(sent)

    expect(pasteBox()).toBeNull()
    await act(async () => {
      pasteButton()!.click()
    })

    const box = pasteBox()
    expect(box).not.toBeNull()
    // It must be a REAL editable textarea — that is the whole point (iOS will
    // only offer its Paste menu on one).
    expect(box!.tagName).toBe('TEXTAREA')
    expect(box!.disabled).toBe(false)
    // Nothing sent yet: the user hasn't pasted.
    expect(inputs(sent).length).toBe(0)

    await act(async () => root.unmount())
  })

  test('text pasted into the capture box → exactly one term.input frame carrying it', async () => {
    setClipboard(async () => {
      throw new Error('NotAllowedError')
    })
    const sent: any[] = []
    const { root, act } = await mountSurface(sent)

    await act(async () => {
      pasteButton()!.click()
    })
    const box = pasteBox()!
    await act(async () => {
      box.value = 'pasted on a phone'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // "Send" commits the box.
    const send = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Send',
    ) as HTMLButtonElement
    await act(async () => {
      send.click()
    })

    expect(inputs(sent).length).toBe(1)
    expect(inputs(sent)[0].bytes).toBe(b64('pasted on a phone'))
    expect(inputs(sent)[0].session_id).toBe('s1')
    // Box closed after commit.
    expect(pasteBox()).toBeNull()

    await act(async () => root.unmount())
  })
})
