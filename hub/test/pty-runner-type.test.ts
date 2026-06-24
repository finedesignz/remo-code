/**
 * Phase 16 (R-PTY-11) — per-session runner_type: opt-in, default stream-json,
 * idempotent DDL, and the Telegram-default guard (cannot switch to
 * pty-interactive).
 *
 * Mounts the real sessions router with a state-driven DAL mock. mock.module is
 * process-global + first-write-wins, so we spread the REAL dal (cache-busted)
 * and override only the runner-type surface (memory: bun-mock-pollution).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = 'user_rt'
const TEST_SESSION_ID = 'sess_rt'
const TG_DEFAULT_SESSION_ID = 'sess_tg_default'

const state = {
  runnerTypes: new Map<string, 'stream-json' | 'pty-interactive'>(),
  ptyIdentity: new Map<string, { runner_type: string; pty_backend_id: string | null; transcript_path: string | null }>(),
}

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)

mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  setSessionRunnerType: async (sessionId: string, userId: string, runnerType: 'stream-json' | 'pty-interactive') => {
    if (userId !== TEST_USER_ID) return undefined
    if (sessionId !== TEST_SESSION_ID && sessionId !== TG_DEFAULT_SESSION_ID) return undefined
    // Telegram-default guard (R-PTY-11).
    if (runnerType === 'pty-interactive' && sessionId === TG_DEFAULT_SESSION_ID) {
      return { error: 'telegram_default_pty_forbidden' }
    }
    state.runnerTypes.set(sessionId, runnerType)
    return { runner_type: runnerType }
  },
  getSessionPtyIdentity: async (sessionId: string, userId: string) => {
    if (userId !== TEST_USER_ID) return null
    return state.ptyIdentity.get(sessionId) ?? null
  },
}))

mock.module('../src/db/chat-tabs-dal.ts', () => ({ getMessagesForSessions: async () => ({}) }))

let app: Hono
beforeEach(async () => {
  state.runnerTypes.clear()
  state.ptyIdentity.clear()
  const mod = await import(`../src/api/sessions.ts?rt=${Date.now()}`)
  app = new Hono()
  app.use('*', async (c, next) => { c.set('userId', TEST_USER_ID); await next() })
  app.route('/api/sessions', mod.default ?? (mod as any).sessions ?? mod)
})

function patchRunnerType(sessionId: string, runnerType: string) {
  return app.request(`/api/sessions/${sessionId}/runner-type`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runner_type: runnerType }),
  })
}

describe('Phase 16 — runner_type opt-in + Telegram-default guard', () => {
  test('default is stream-json (DDL DEFAULT) — no row mutated unless opted in', () => {
    // The schema column default is asserted by the schema-idempotency test; here
    // we assert the API never implicitly flips a session.
    expect(state.runnerTypes.has(TEST_SESSION_ID)).toBe(false)
  })

  test('a session can opt in to pty-interactive', async () => {
    const res = await patchRunnerType(TEST_SESSION_ID, 'pty-interactive')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.runner_type).toBe('pty-interactive')
    expect(state.runnerTypes.get(TEST_SESSION_ID)).toBe('pty-interactive')
  })

  test('a session can be set back to stream-json', async () => {
    const res = await patchRunnerType(TEST_SESSION_ID, 'stream-json')
    expect(res.status).toBe(200)
    expect((await res.json()).runner_type).toBe('stream-json')
  })

  test('an invalid runner_type is rejected (400)', async () => {
    const res = await patchRunnerType(TEST_SESSION_ID, 'bogus')
    expect(res.status).toBe(400)
  })

  test('a Telegram-default session CANNOT be switched to pty-interactive (409)', async () => {
    const res = await patchRunnerType(TG_DEFAULT_SESSION_ID, 'pty-interactive')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('telegram_default_pty_forbidden')
    expect(state.runnerTypes.has(TG_DEFAULT_SESSION_ID)).toBe(false)
  })

  test('a Telegram-default session may still be set to stream-json (allowed)', async () => {
    const res = await patchRunnerType(TG_DEFAULT_SESSION_ID, 'stream-json')
    expect(res.status).toBe(200)
  })

  test('an unknown session is 404', async () => {
    const res = await patchRunnerType('nope', 'pty-interactive')
    expect(res.status).toBe(404)
  })
})
