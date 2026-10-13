/**
 * PTYCAP-04-05 Task 3 (D-13, SC-3): the 60 percent daily-token-ceiling alarm.
 * Every dependency is injected; no real mail is ever sent; timers are injectable.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('../src/db/postgres.ts', () => ({ sql: async () => [] }))

const mod = await import('../src/observability/token-cap-alarm.ts')
const {
  evaluateTokenCapAlarm,
  claimTokenCapAlarm,
  scheduleTokenCapAlarm,
  resetTokenCapAlarmScheduler,
  buildAlarmMessage,
  tokenCapAlarmPct,
  pendingAlarmCount,
} = mod
type AlarmDeps = import('../src/observability/token-cap-alarm.ts').AlarmDeps

afterAll(() => {
  mock.restore()
  delete process.env.REMO_TOKEN_CAP_ALARM_PCT
})

function makeDeps(over: Partial<AlarmDeps> & { tokens?: number; cap?: number; email?: string | null; tz?: string } = {}) {
  const log = { claims: [] as any[], emails: [] as any[], delivered: [] as string[], notifies: [] as any[] }
  const deps: AlarmDeps = {
    getUser: async () => ({ email: over.email === undefined ? 'owner@example.com' : over.email, timezone: over.tz ?? 'America/Los_Angeles' }),
    getStatus: async () => ({ over: false, tokens: over.tokens ?? 0, cap: over.cap ?? 1000 }),
    claim: async (a) => {
      log.claims.push(a)
      return 'alarm-1'
    },
    markDelivered: async (id) => {
      log.delivered.push(id)
    },
    sendEmail: async (i) => {
      log.emails.push(i)
      return true
    },
    notify: async (i) => {
      log.notifies.push(i)
    },
    pct: () => 60,
    ...(over.getUser ? { getUser: over.getUser } : {}),
    ...(over.getStatus ? { getStatus: over.getStatus } : {}),
    ...(over.claim ? { claim: over.claim } : {}),
    ...(over.sendEmail ? { sendEmail: over.sendEmail } : {}),
    ...(over.notify ? { notify: over.notify } : {}),
    ...(over.pct ? { pct: over.pct } : {}),
  }
  return { deps, log }
}

beforeEach(() => {
  delete process.env.REMO_TOKEN_CAP_ALARM_PCT
  resetTokenCapAlarmScheduler()
})

describe('evaluateTokenCapAlarm', () => {
  test('below pct of cap: no claim, no email', async () => {
    const { deps, log } = makeDeps({ tokens: 599 })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(false)
    expect(log.claims.length).toBe(0)
    expect(log.emails.length).toBe(0)
  })

  test('crossing pct: one claim, one email to users.email, delivered after send, fan-out inapp+telegram only', async () => {
    const { deps, log } = makeDeps({ tokens: 600 })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(true)
    expect(log.claims.length).toBe(1)
    expect(log.emails.length).toBe(1)
    expect(log.emails[0].to).toBe('owner@example.com')
    expect(log.delivered).toEqual(['alarm-1'])
    expect(log.notifies.length).toBe(1)
    expect(log.notifies[0].channels).toEqual(['inapp', 'telegram'])
    expect(log.notifies[0].userId).toBe('u1')
  })

  test('delivered is marked only AFTER sendEmail returned true', async () => {
    const order: string[] = []
    const { deps } = makeDeps({
      tokens: 700,
      sendEmail: async () => {
        order.push('send')
        return true
      },
    })
    deps.markDelivered = async () => {
      order.push('mark')
    }
    await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(order).toEqual(['send', 'mark'])
  })

  test('sendEmail false: claim stays delivered=false, no fan-out', async () => {
    const { deps, log } = makeDeps({ tokens: 700, sendEmail: async () => false })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(true)
    expect(log.delivered).toEqual([])
    expect(log.notifies.length).toBe(0)
  })

  test('sendEmail throwing is treated as undelivered, never propagates', async () => {
    const { deps, log } = makeDeps({
      tokens: 700,
      sendEmail: async () => {
        throw new Error('network')
      },
    })
    await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(log.delivered).toEqual([])
  })

  test('a failing fan-out does not matter', async () => {
    const { deps, log } = makeDeps({
      tokens: 700,
      notify: async () => {
        throw new Error('tg down')
      },
    })
    await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(log.delivered).toEqual(['alarm-1'])
  })

  test('claim returns null (already delivered / cooling down): nothing sent', async () => {
    const { deps, log } = makeDeps({ tokens: 900, claim: async () => null })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(false)
    expect(log.emails.length).toBe(0)
  })

  test('explicit cap disable (cap 0): nothing beyond the status read, no claim', async () => {
    let claimed = 0
    const { deps, log } = makeDeps({ cap: 0, tokens: 0, claim: async () => (claimed++, 'x') })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(false)
    expect(claimed).toBe(0)
    expect(log.emails.length).toBe(0)
  })

  test('user without an email: attempt recorded (claim made), nothing sent, no throw', async () => {
    const { deps, log } = makeDeps({ tokens: 800, email: null })
    const r = await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(r.fired).toBe(true)
    expect(log.claims.length).toBe(1)
    expect(log.emails.length).toBe(0)
    expect(log.delivered).toEqual([])
  })

  test('unknown user: nothing happens', async () => {
    const { deps, log } = makeDeps({ tokens: 800, getUser: async () => null })
    expect((await evaluateTokenCapAlarm('ghost', 's1', deps)).fired).toBe(false)
    expect(log.claims.length).toBe(0)
  })

  test('the claim carries the USER timezone, not UTC', async () => {
    const { deps, log } = makeDeps({ tokens: 800, tz: 'Asia/Tokyo' })
    await evaluateTokenCapAlarm('u1', 's1', deps)
    expect(log.claims[0].timezone).toBe('Asia/Tokyo')
    expect(log.claims[0].pct).toBe(60)
    expect(log.claims[0].tokens).toBe(800)
    expect(log.claims[0].cap).toBe(1000)
  })

  test('email subject and body are ASCII only', () => {
    const m = buildAlarmMessage({ tokens: 123456, cap: 200000, pct: 60, tz: 'America/Los_Angeles' })
    for (const s of [m.subject, m.text, m.html]) expect(/^[\x20-\x7e\n]*$/.test(s)).toBe(true)
    expect(m.text).toContain('123,456')
    expect(m.text).toContain('200,000')
    expect(m.subject).toContain('62 percent')
  })
})

describe('tokenCapAlarmPct', () => {
  test('unset or garbage -> 60; clamped to (0,100]; 100 means at the ceiling; never disabled', () => {
    expect(tokenCapAlarmPct()).toBe(60)
    for (const bad of ['abc', '0', '-5', '  ']) {
      process.env.REMO_TOKEN_CAP_ALARM_PCT = bad
      expect(tokenCapAlarmPct()).toBe(60)
    }
    process.env.REMO_TOKEN_CAP_ALARM_PCT = '250'
    expect(tokenCapAlarmPct()).toBe(100)
    process.env.REMO_TOKEN_CAP_ALARM_PCT = '100'
    expect(tokenCapAlarmPct()).toBe(100)
    process.env.REMO_TOKEN_CAP_ALARM_PCT = '45'
    expect(tokenCapAlarmPct()).toBe(45)
  })

  test('pct 100 fires only at the ceiling', async () => {
    const { deps, log } = makeDeps({ tokens: 999, pct: () => 100 })
    expect((await evaluateTokenCapAlarm('u1', 's', deps)).fired).toBe(false)
    const b = makeDeps({ tokens: 1000, pct: () => 100 })
    expect((await evaluateTokenCapAlarm('u1', 's', b.deps)).fired).toBe(true)
    expect(log.claims.length).toBe(0)
  })
})

// A stateful fake of the two claim statements: first INSERT wins, UPDATE honours
// delivered / attempts / cooldown exactly as the SQL does.
function fakeClaimSql() {
  const rows = new Map<string, { id: string; delivered: boolean; attempts: number; lastAt: number | null }>()
  const calls: { text: string; values: any[] }[] = []
  let clock = 1_000_000
  const key = (u: string, tz: string) => `${u}|${tz}`
  const q: any = async (strings: TemplateStringsArray, ...v: any[]) => {
    const text = strings.join('?')
    calls.push({ text, values: v })
    if (text.includes('INSERT INTO token_cap_alarms')) {
      const k = key(v[0], v[1])
      if (rows.has(k)) return []
      const row = { id: `row-${rows.size + 1}`, delivered: false, attempts: 1, lastAt: clock }
      rows.set(k, row)
      return [{ id: row.id }]
    }
    if (text.includes('UPDATE token_cap_alarms')) {
      const [, userId, tz, maxAttempts, cooldown] = v
      const row = rows.get(key(userId, tz))
      if (!row || row.delivered || row.attempts >= maxAttempts) return []
      if (row.lastAt != null && row.lastAt > clock - cooldown * 1000) return []
      row.attempts++
      row.lastAt = clock
      return [{ id: row.id }]
    }
    return []
  }
  return { q, rows, calls, advance: (ms: number) => (clock += ms) }
}

describe('claimTokenCapAlarm', () => {
  const base = { userId: 'u1', timezone: 'America/Los_Angeles', pct: 60, tokens: 700, cap: 1000 }

  test('uses ON CONFLICT (user_id, local_date) with the user timezone expression', async () => {
    const f = fakeClaimSql()
    await claimTokenCapAlarm(base, f.q)
    const insert = f.calls[0]!
    expect(insert.text).toContain('ON CONFLICT (user_id, local_date) DO NOTHING')
    expect(insert.text).toContain('AT TIME ZONE')
    expect(insert.values).toContain('America/Los_Angeles')
  })

  test('first claim wins; a second claim while undelivered inside the cooldown does not', async () => {
    const f = fakeClaimSql()
    expect(await claimTokenCapAlarm(base, f.q)).toBe('row-1')
    expect(await claimTokenCapAlarm(base, f.q)).toBeNull()
  })

  test('a retry after the cooldown wins, bounded by the attempt maximum', async () => {
    const f = fakeClaimSql()
    const a = { ...base, maxAttempts: 3, cooldownSeconds: 60 }
    expect(await claimTokenCapAlarm(a, f.q)).toBe('row-1') // attempt 1
    f.advance(61_000)
    expect(await claimTokenCapAlarm(a, f.q)).toBe('row-1') // attempt 2
    f.advance(61_000)
    expect(await claimTokenCapAlarm(a, f.q)).toBe('row-1') // attempt 3
    f.advance(61_000)
    expect(await claimTokenCapAlarm(a, f.q)).toBeNull() // exhausted
  })

  test('a delivered claim is never retried', async () => {
    const f = fakeClaimSql()
    await claimTokenCapAlarm(base, f.q)
    f.rows.get('u1|America/Los_Angeles')!.delivered = true
    f.advance(10_000_000)
    expect(await claimTokenCapAlarm(base, f.q)).toBeNull()
  })
})

describe('scheduleTokenCapAlarm (trailing edge, injectable timers)', () => {
  function harness() {
    let t = 0
    const timers = new Map<number, { fn: () => void; at: number }>()
    let nextId = 1
    const evaluated: string[] = []
    const opts = {
      quietMs: 100,
      maxWaitMs: 1000,
      now: () => t,
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.set(id, { fn, at: t + ms })
        return id
      },
      clearTimer: (id: unknown) => {
        timers.delete(id as number)
      },
      evaluate: async (u: string) => {
        evaluated.push(u)
      },
    }
    // advance time, firing due timers in order
    const advance = async (ms: number) => {
      const end = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = Math.max(t, due[1].at)
        timers.delete(due[0])
        due[1].fn()
        await Promise.resolve()
        await Promise.resolve()
      }
      t = end
    }
    return { opts, advance, evaluated, timers }
  }

  test('25 calls inside the quiet window -> exactly one evaluation after the window', async () => {
    const h = harness()
    for (let i = 0; i < 25; i++) {
      scheduleTokenCapAlarm('u1', 's1', h.opts)
      await h.advance(2)
    }
    expect(h.evaluated.length).toBe(0)
    expect(h.timers.size).toBe(1)
    await h.advance(200)
    expect(h.evaluated).toEqual(['u1'])
    expect(pendingAlarmCount()).toBe(0)
  })

  test('an unbroken stream still evaluates within the maximum wait', async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) {
      scheduleTokenCapAlarm('u1', 's1', h.opts)
      await h.advance(50) // never quiet for 100ms
    }
    expect(h.evaluated.length).toBeGreaterThanOrEqual(1)
    // first evaluation happened no later than maxWait after the first event
    expect(h.evaluated.length).toBeLessThanOrEqual(3)
  })

  test('separate users coalesce independently', async () => {
    const h = harness()
    scheduleTokenCapAlarm('u1', 's1', h.opts)
    scheduleTokenCapAlarm('u2', 's2', h.opts)
    scheduleTokenCapAlarm('u1', 's1', h.opts)
    expect(pendingAlarmCount()).toBe(2)
    await h.advance(200)
    expect(h.evaluated.sort()).toEqual(['u1', 'u2'])
  })

  test('a failing evaluation never throws out of the timer', async () => {
    const h = harness()
    h.opts.evaluate = async () => {
      throw new Error('db down')
    }
    scheduleTokenCapAlarm('u1', 's1', h.opts)
    await h.advance(200)
    expect(pendingAlarmCount()).toBe(0)
  })
})

describe('static pins', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'observability', 'token-cap-alarm.ts'), 'utf8')
  const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  test('no polling primitive', () => {
    expect(code).not.toContain('setInterval')
  })
  test('claim is an atomic ON CONFLICT with a delivered flag', () => {
    expect(src).toContain('ON CONFLICT (user_id, local_date)')
    expect(src).toContain('delivered')
    expect(src).toContain('export async function claimTokenCapAlarm')
  })
})
