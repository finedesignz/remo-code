/**
 * Per-session "bypass permissions" (dangerously-skip-permissions) override.
 *
 * Default OFF: a session never skips permission prompts unless its
 * `dangerously_skip_permissions` column is explicitly TRUE. The hub passes the
 * *requested* value on `session.start`; the supervisor's own config
 * `allowDangerousSkipPermissions` is the HARD CEILING (applied = requested &&
 * allowed), enforced supervisor-side (asserted by the supervisor test).
 *
 * Mirrors pty-runner-type.test.ts: real DAL spread (cache-busted, bun-mock
 * pollution is process-global + first-write-wins) with only the skip-permission
 * surface overridden.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = 'user_skip'
const TEST_SESSION_ID = 'sess_skip'

const state = {
  skip: new Map<string, boolean | null>(),
}

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  setSessionSkipPermissions: async (sessionId: string, userId: string, enabled: boolean) => {
    if (userId !== TEST_USER_ID) return undefined
    if (sessionId !== TEST_SESSION_ID) return undefined
    state.skip.set(sessionId, enabled)
    return { dangerously_skip_permissions: enabled }
  },
  getSessionPtyIdentity: async () => null,
}))

mock.module('../src/db/chat-tabs-dal.ts', () => ({ getMessagesForSessions: async () => ({}) }))

let app: Hono
beforeEach(async () => {
  state.skip.clear()
  const mod = await import(`../src/api/sessions.ts?skip=${Date.now()}`)
  app = new Hono()
  app.use('*', async (c, next) => { c.set('userId', TEST_USER_ID); await next() })
  app.route('/api/sessions', mod.default ?? (mod as any).sessions ?? mod)
})

function patchSkip(sessionId: string, enabled: unknown) {
  return app.request(`/api/sessions/${sessionId}/skip-permissions`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

describe('per-session skip-permissions — default OFF, explicit opt-in', () => {
  test('default is OFF — no row mutated unless opted in', () => {
    expect(state.skip.has(TEST_SESSION_ID)).toBe(false)
  })

  test('a session can opt in (enabled: true)', async () => {
    const res = await patchSkip(TEST_SESSION_ID, true)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dangerously_skip_permissions).toBe(true)
    expect(state.skip.get(TEST_SESSION_ID)).toBe(true)
  })

  test('a session can be set back OFF (enabled: false)', async () => {
    const res = await patchSkip(TEST_SESSION_ID, false)
    expect(res.status).toBe(200)
    expect((await res.json()).dangerously_skip_permissions).toBe(false)
    expect(state.skip.get(TEST_SESSION_ID)).toBe(false)
  })

  test('a non-boolean body is rejected (400)', async () => {
    const res = await patchSkip(TEST_SESSION_ID, 'yes')
    expect(res.status).toBe(400)
  })

  test('an unknown session is 404', async () => {
    const res = await patchSkip('nope', true)
    expect(res.status).toBe(404)
  })
})
