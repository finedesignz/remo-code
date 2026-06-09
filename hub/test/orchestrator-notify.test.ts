/**
 * Milestone TMAC — Phase TMAC-03: stage-gated best-effort notify fan-out.
 * Reqs: R-TMAC-03.
 */
import { describe, test, expect } from 'bun:test'
import {
  shouldNotify,
  fanOutNotify,
  applyChannelPrefs,
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

describe('applyChannelPrefs — §7.1 per-channel opt-in (PURE)', () => {
  const all: any[] = ['telegram', 'inapp', 'email', 'push']
  test('null/undefined prefs ⇒ all channels (default all-on, prior behavior)', () => {
    expect(applyChannelPrefs(all, null)).toEqual(all)
    expect(applyChannelPrefs(all, undefined)).toEqual(all)
  })
  test('missing key reads as opted-IN', () => {
    expect(applyChannelPrefs(all, { telegram: true })).toEqual(all)
    expect(applyChannelPrefs(all, {})).toEqual(all)
  })
  test('explicit false mutes only that channel', () => {
    expect(applyChannelPrefs(all, { email: false })).toEqual(['telegram', 'inapp', 'push'])
    expect(applyChannelPrefs(all, { telegram: false, push: false })).toEqual(['inapp', 'email'])
  })
})

describe('fanOutNotify — honors per-channel prefs', () => {
  test('a muted channel is skipped even when requested', async () => {
    const { deps, calls } = spyDeps({
      getUserById: async () => ({ email: 'u@x.com', telegram_chat_id: 123, notify_channels: { telegram: false } }),
    })
    const r = await fanOutNotify(
      { userId: 'u1', sessionId: 's1', event: 'gate', level: 'blocking', detail: 'halt', channels: ['telegram', 'inapp', 'email'] },
      deps,
    )
    expect(calls.tg).toBe(0)
    expect(r.delivered).not.toContain('telegram')
    expect(r.delivered.sort()).toEqual(['email', 'inapp'])
  })
  test('no prefs ⇒ unchanged fan-out (back-compat)', async () => {
    const { deps, calls } = spyDeps({
      getUserById: async () => ({ email: 'u@x.com', telegram_chat_id: 123 }),
    })
    const r = await fanOutNotify(
      { userId: 'u1', sessionId: 's1', event: 'ship', level: 'info', detail: 'v1', channels: ['telegram', 'inapp', 'email'] },
      deps,
    )
    expect(calls.tg).toBe(1)
    expect(r.delivered.sort()).toEqual(['email', 'inapp', 'telegram'])
  })
})

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
