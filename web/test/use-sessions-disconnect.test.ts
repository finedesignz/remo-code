// useSessions().disconnectSession contract.
//
// Guards the user-Disconnect wiring: the helper POSTs to the session-scoped
// /api/sessions/:id/disconnect endpoint (KEEP-the-row), NOT the DELETE
// (soft-delete) path — so a later launch resumes the SAME session_id. On a
// network failure it resolves { ok:false } (optimistic flip is rolled back in
// the hook). No DOM/renderHook infra in this repo, so we drive the hook body
// through react-dom/server with a render-prop harness and invoke the captured
// callback after render.
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ── Mock the hub fetch so we capture path + method without a network ────────
const calls: Array<{ token: string; path: string; init?: any }> = []
let nextThrows = false
mock.module('../src/lib/api', () => ({
  hubFetch: async (token: string, path: string, init?: any) => {
    calls.push({ token, path, init })
    if (nextThrows) {
      const err: any = new Error('network')
      err.status = 503
      err.body = { error: 'dispatch_failed' }
      throw err
    }
    // /api/sessions GET (initial fetch) returns an array; others return ok.
    if (path === '/api/sessions') return []
    return { ok: true }
  },
}))

const { useSessions } = await import('../src/hooks/useSessions')

// Capture the hook's return value during a server render.
function capture(token: string | null): ReturnType<typeof useSessions> {
  let captured: any
  function Harness() {
    captured = useSessions(token)
    return null
  }
  renderToStaticMarkup(h(Harness))
  return captured
}

beforeEach(() => {
  calls.length = 0
  nextThrows = false
})

describe('useSessions().disconnectSession', () => {
  test('exposes disconnectSession + launchSession (reconnect uses launch, not create)', () => {
    const hook = capture('tok')
    expect(typeof hook.disconnectSession).toBe('function')
    expect(typeof hook.launchSession).toBe('function')
  })

  test('POSTs to /api/sessions/:id/disconnect (keep-the-row endpoint, not DELETE)', async () => {
    const hook = capture('tok')
    const res = await hook.disconnectSession('sess_abc')
    expect(res.ok).toBe(true)
    const call = calls.find((c) => c.path === '/api/sessions/sess_abc/disconnect')
    expect(call).toBeTruthy()
    expect(call!.init?.method).toBe('POST')
    // Must NOT hit the soft-delete DELETE route.
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false)
  })

  test('returns { ok:false } on failure (optimistic flip rolled back in hook)', async () => {
    const hook = capture('tok')
    nextThrows = true
    const res = await hook.disconnectSession('sess_abc')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('dispatch_failed')
  })

  test('no token → unauthorized, no fetch', async () => {
    const hook = capture(null)
    const res = await hook.disconnectSession('sess_abc')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('unauthorized')
    expect(calls.some((c) => c.path.includes('/disconnect'))).toBe(false)
  })
})
