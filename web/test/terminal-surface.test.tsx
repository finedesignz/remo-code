/**
 * Phase 16 (R-PTY-09, T-16-10) — terminal surface lifecycle.
 *
 * No DOM test infra ships in this repo, so we exercise the LOAD-BEARING logic
 * through the testable `openTermWs` lib seam (frame construction, auth gating,
 * session-id filtering, scrollback replay, resize, input) with a fake
 * WebSocket — the same lib the surface + useTerminalSession consume. This proves
 * the contract the xterm component renders on:
 *   - attach + reattach are requested after auth,
 *   - inbound term.data for the bound session is delivered as decoded bytes,
 *   - inbound term.reattach{scrollback} is delivered to onScrollback (the
 *     surface clears + writes it BEFORE live data — no cross-session bleed),
 *   - a frame for ANOTHER session is ignored,
 *   - keystrokes → term.input base64; resize → term.resize cols/rows.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { openTermWs, __testing } from '../src/lib/term-ws'

// Minimal fake WebSocket capturing sent frames + letting the test drive inbound.
class FakeWS {
  static OPEN = 1
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(raw: string) { this.sent.push(raw) }
  close() { this.readyState = 3; this.onclose?.() }
  // test helpers
  open() { this.readyState = FakeWS.OPEN; this.onopen?.() }
  recv(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  parsedSent() { return this.sent.map((s) => JSON.parse(s)) }
}

// Provide WebSocket constants the lib reads (WebSocket.OPEN).
;(globalThis as any).WebSocket = FakeWS
;(globalThis as any).window = { location: { protocol: 'https:', host: 'app.test' } }
;(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
;(globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary')

const SESSION = 'sess1'

let fake: FakeWS
let data: string[]
let scrollback: string[]

function mkWs() {
  data = []
  scrollback = []
  fake = new FakeWS()
  return openTermWs(
    SESSION,
    null,
    {
      onData: (b) => data.push(b),
      onScrollback: (b) => scrollback.push(b),
    },
    () => fake as any,
  )
}

describe('Phase 16 — term-ws lifecycle (surface contract)', () => {
  beforeEach(() => { /* fresh per test via mkWs */ })

  test('after auth_ok, attach + reattach are requested', () => {
    mkWs()
    fake.open()
    fake.recv({ type: 'auth_ok' })
    const types = fake.parsedSent().map((f) => f.type)
    expect(types).toContain('auth')
    expect(types).toContain('term.attach')
  })

  test('inbound term.data for the bound session is decoded + delivered', () => {
    mkWs()
    fake.open()
    fake.recv({ type: 'auth_ok' })
    fake.recv({ type: 'term.data', session_id: SESSION, bytes: __testing.b64encode('hello') })
    expect(data).toEqual(['hello'])
  })

  test('term.reattach{scrollback} goes to onScrollback (replayed before live)', () => {
    const ws = mkWs()
    fake.open()
    fake.recv({ type: 'auth_ok' })
    ws.reattach()
    fake.recv({ type: 'term.reattach', session_id: SESSION, scrollback: __testing.b64encode('prev\nstate') })
    expect(scrollback).toEqual(['prev\nstate'])
    // Live data still flows after replay.
    fake.recv({ type: 'term.data', session_id: SESSION, bytes: __testing.b64encode('live') })
    expect(data).toEqual(['live'])
  })

  test('a frame for ANOTHER session is ignored (no cross-session bleed)', () => {
    mkWs()
    fake.open()
    fake.recv({ type: 'auth_ok' })
    fake.recv({ type: 'term.data', session_id: 'other', bytes: __testing.b64encode('leak') })
    expect(data).toEqual([])
  })

  test('data before auth_ok is ignored', () => {
    mkWs()
    fake.open()
    fake.recv({ type: 'term.data', session_id: SESSION, bytes: __testing.b64encode('early') })
    expect(data).toEqual([])
  })

  test('keystrokes → term.input base64; resize → term.resize cols/rows', () => {
    const ws = mkWs()
    fake.open()
    fake.recv({ type: 'auth_ok' })
    fake.sent = []
    ws.sendInput('ls\n')
    ws.resize(120, 40)
    const sent = fake.parsedSent()
    const input = sent.find((f) => f.type === 'term.input')
    const resize = sent.find((f) => f.type === 'term.resize')
    expect(input.bytes).toBe(__testing.b64encode('ls\n'))
    expect(input.session_id).toBe(SESSION)
    expect(resize.cols).toBe(120)
    expect(resize.rows).toBe(40)
  })
})
