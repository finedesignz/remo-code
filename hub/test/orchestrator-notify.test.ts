/**
 * Milestone TMAC — Phase TMAC-03: stage-gated best-effort notify fan-out.
 * Reqs: R-TMAC-03.
 */
import { describe, test, expect } from 'bun:test'
import {
  shouldNotify,
  fanOutNotify,
  type NotifyDeps,
} from '../src/orchestrator/notify.ts'

describe('shouldNotify — SPEC §3 stage matrix', () => {
  test('ship: development logs only (no fire)', () => {
    expect(shouldNotify('ship', 'development').fire).toBe(false)
  })
  test('ship: beta + prod-maint push FYI', () => {
    expect(shouldNotify('ship', 'beta').fire).toBe(true)
    expect(shouldNotify('ship', 'production-maintenance').fire).toBe(true)
  })
  test('gate: development never pages', () => {
    const d = shouldNotify('gate', 'development')
    expect(d.fire).toBe(false)
    expect(d.halt).toBe(false)
  })
  test('gate: beta notifies, no forced halt', () => {
    const d = shouldNotify('gate', 'beta')
    expect(d.fire).toBe(true)
    expect(d.halt).toBe(false)
  })
  test('gate: production-maintenance HALTs + all channels', () => {
    const d = shouldNotify('gate', 'production-maintenance')
    expect(d.fire).toBe(true)
    expect(d.halt).toBe(true)
    expect(d.channels.sort()).toEqual(['email', 'inapp', 'push', 'telegram'])
  })
  test('info: development restricts to in-app only', () => {
    expect(shouldNotify('info', 'development').channels).toEqual(['inapp'])
  })

  // F-10: a failed/refused unattended run must surface even in dev — failures
  // bypass stage silence (which is only for routine progress).
  test('failure: fires in development (failures bypass stage silence)', () => {
    const d = shouldNotify('failure', 'development')
    expect(d.fire).toBe(true)
    expect(d.halt).toBe(false)
    expect(d.channels.length).toBeGreaterThan(0)
  })
  test('failure: fires in beta + production-maintenance', () => {
    expect(shouldNotify('failure', 'beta').fire).toBe(true)
    expect(shouldNotify('failure', 'production-maintenance').fire).toBe(true)
  })
})

function spyDeps(over: Partial<NotifyDeps> = {}): { deps: NotifyDeps; calls: any } {
  const calls = { tg: 0, inapp: 0, email: 0 }
  const deps: NotifyDeps = {
    getUserById: async () => ({ email: 'u@x.com', telegram_chat_id: 123 }),
    sendTelegram: async () => {
      calls.tg++
    },
    broadcastToUser: () => {
      calls.inapp++
    },
    sendEmail: async () => {
      calls.email++
      return true
    },
    ...over,
  }
  return { deps, calls }
}

describe('fanOutNotify — channel fan-out', () => {
  test('all channels deliver when user linked', async () => {
    const { deps, calls } = spyDeps()
    const r = await fanOutNotify(
      {
        userId: 'u1',
        sessionId: 's1',
        event: 'ship',
        level: 'info',
        detail: 'shipped v1.0.0',
        channels: ['telegram', 'inapp', 'email', 'push'],
      },
      deps,
    )
    expect(calls.tg).toBe(1)
    expect(calls.inapp).toBe(1)
    expect(calls.email).toBe(1)
    expect(r.delivered.sort()).toEqual(['email', 'inapp', 'telegram'])
  })

  test('skips telegram when no linked chat', async () => {
    const { deps, calls } = spyDeps({
      getUserById: async () => ({ email: 'u@x.com', telegram_chat_id: null }),
    })
    const r = await fanOutNotify(
      { userId: 'u1', sessionId: 's1', event: 'info', level: 'info', detail: 'hi', channels: ['telegram', 'inapp'] },
      deps,
    )
    expect(calls.tg).toBe(0)
    expect(r.delivered).toContain('inapp')
    expect(r.delivered).not.toContain('telegram')
  })

  test('NEVER throws — a channel error is swallowed, others still fire', async () => {
    const { deps, calls } = spyDeps({
      sendTelegram: async () => {
        throw new Error('telegram down')
      },
    })
    const r = await fanOutNotify(
      { userId: 'u1', sessionId: 's1', event: 'gate', level: 'blocking', detail: 'halt', channels: ['telegram', 'inapp', 'email'] },
      deps,
    )
    expect(calls.inapp).toBe(1)
    expect(calls.email).toBe(1)
    expect(r.delivered).not.toContain('telegram')
  })

  test('getUserById failure does not throw; in-app still fires', async () => {
    const { deps, calls } = spyDeps({
      getUserById: async () => {
        throw new Error('db down')
      },
    })
    const r = await fanOutNotify(
      { userId: 'u1', sessionId: 's1', event: 'info', level: 'info', detail: 'x', channels: ['inapp', 'email', 'telegram'] },
      deps,
    )
    expect(calls.inapp).toBe(1)
    expect(r.delivered).toEqual(['inapp'])
  })
})
