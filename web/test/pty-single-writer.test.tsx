/**
 * fix/dup-pty-writer — CLIENT-SIDE invariants for the PTY writer.
 *
 * Prod defect (2026-07-12): one user session had TWO live `/ws/client` writer
 * connections. The hub logged `term.input.diag.rx` twice per keystroke, the
 * turn lock ping-ponged between `client:2454…` (holder) and `client:f146…`
 * (queuer, one queued waiter PER CHARACTER → `queue overflow`), and Telegram's
 * `acquire` never won ("Session busy — try again in a moment").
 *
 * ROOT CAUSE (reproduced by the first test below): `useWebSocket`'s
 * `ws.onclose` handler did not check that the socket firing it was still the
 * CURRENT socket. When `connect()` was re-run (token hydration / provider
 * re-render), the cleanup closed the old socket, a new socket was opened and
 * stored in `wsRef` — and THEN the old socket's (asynchronous) `onclose` fired,
 * nulled `wsRef` (which now pointed at the NEW socket) and scheduled yet another
 * reconnect. The reconnect opened a third socket and overwrote `wsRef`, leaving
 * the second socket OPEN, AUTHENTICATED and SUBSCRIBED with nothing referencing
 * it: a leaked `/ws/client` connection per token change, forever.
 *
 * INVARIANTS (both must hold):
 *   1. At most ONE live `/ws/client` socket per tab, no matter how many times
 *      connect() is re-run or how the old sockets close.
 *   2. One `term.onData` → exactly ONE `term.input` frame, and an UNMOUNTED
 *      TerminalSurface sends nothing.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// ---------------------------------------------------------------------------
// Fake WebSocket — records every instance, defers close() the way a real socket
// does (onclose lands on a later task, AFTER React has already re-run connect()).
// ---------------------------------------------------------------------------
class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWS[] = []

  readyState = FakeWS.CONNECTING
  sent: any[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null

  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close(code = 1000) {
    if (this.readyState === FakeWS.CLOSED) return
    this.readyState = FakeWS.CLOSED
    // Real sockets fire onclose on a LATER task, not synchronously.
    setTimeout(() => this.onclose?.({ code }), 0)
  }
  // helpers
  openAndAuth() {
    this.readyState = FakeWS.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'auth_ok' }) })
  }
  get live() {
    return this.readyState !== FakeWS.CLOSED
  }
  frames(type: string) {
    return this.sent.filter((f) => f.type === type)
  }
}

;(globalThis as any).WebSocket = FakeWS
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  FakeWS.instances = []
  try {
    localStorage.clear()
  } catch {}
  document.cookie = '__Host-remo_sid=x'
})

afterEach(() => {
  mock.restore()
})

describe('INVARIANT 1 — at most one live /ws/client socket per tab', () => {
  test('a superseded socket closing does NOT orphan the current socket (the prod leak)', async () => {
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { WebSocketProvider } = await import('../src/hooks/useWebSocket')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    // 1. Mount with the pre-hydration token, then hydrate a real token — this is
    //    the exact prod path (useAuth: null → token) that re-runs connect().
    await act(async () => {
      root.render(React.createElement(WebSocketProvider, { token: 'tok-a' }, null))
    })
    const ws1 = FakeWS.instances[0]!
    await act(async () => {
      ws1.openAndAuth()
    })

    await act(async () => {
      root.render(React.createElement(WebSocketProvider, { token: 'tok-b' }, null))
    })
    // The effect cleanup closed ws1 and connect() opened ws2. ws1's onclose has
    // NOT fired yet (deferred, like a real socket).
    const ws2 = FakeWS.instances[1]!
    await act(async () => {
      ws2.openAndAuth()
    })

    // 2. Now let ws1's deferred onclose land, plus any reconnect it schedules
    //    (backoff floor = 1s).
    await act(async () => {
      await sleep(1400)
    })

    const live = FakeWS.instances.filter((w) => w.live)
    expect(live.length).toBe(1)

    await act(async () => {
      root.unmount()
    })
  }, 10_000)
})

describe('INVARIANT 2 — one keystroke → exactly one term.input; unmounted surface is silent', () => {
  test('term.onData fires once → one term.input frame; after unmount, nothing is sent', async () => {
    // Stub xterm: happy-dom has no canvas/renderer, and we only care about the
    // onData → send contract, not the glyph rendering.
    let onDataCb: ((d: string) => void) | null = null
    let disposed = false
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
        dispose() {
          disposed = true
        }
        onData(cb: (d: string) => void) {
          onDataCb = cb
          return { dispose() {} }
        }
      },
    }))
    mock.module('@xterm/addon-fit', () => ({
      FitAddon: class {
        fit() {}
      },
    }))
    mock.module('@xterm/xterm/css/xterm.css', () => ({}))

    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { TerminalSurface } = await import('../src/components/TerminalSurface')

    const sent: any[] = []
    const send = (m: object) => sent.push(m)
    const subscribe = () => () => {}

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(TerminalSurface, { sessionId: 's1', send, subscribe }))
    })

    expect(onDataCb).not.toBeNull()

    await act(async () => {
      onDataCb!('a')
    })
    expect(sent.filter((f) => f.type === 'term.input').length).toBe(1)

    // Unmount, then have a straggler keystroke arrive (a disposed-but-still-
    // referenced terminal, or a pending IME/composition flush).
    const stale = onDataCb!
    await act(async () => {
      root.unmount()
    })
    expect(disposed).toBe(true)

    stale('b')
    expect(sent.filter((f) => f.type === 'term.input').length).toBe(1)
  }, 10_000)
})
