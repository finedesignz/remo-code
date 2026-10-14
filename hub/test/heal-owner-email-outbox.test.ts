/**
 * PTYCAP-07 repair round (QC round3-codex MAJOR #1): the default owner email for a scheduled-task
 * heal event is a durable obligation persisted WITH the heal claim. Crash between the claim and the
 * scheduler send -> the heal sweep sends exactly one; the normal path sends exactly one.
 * DB-free: an in-memory outbox mirrors the lease-CAS semantics of the DAL (SQL pinned separately).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { routeHeal, type HealDeps } from '../src/heal/route.ts'
import { healFailedScheduledRun, type ScheduledSourceDeps } from '../src/heal/sources/scheduled-task.ts'
import { deliverOwnerEmailForRun, sweepOwnerEmails, type OwnerEmailDeps } from '../src/heal/owner-email.ts'
import { sweepStaleHealLaunches, type SweepDeps } from '../src/heal/sweep.ts'
import { claimHealEvent, claimOwnerEmailDelivery, listPendingOwnerEmails } from '../src/db/heal-events-dal.ts'

const savedFlag = process.env.REMO_HEAL_UNIFIED
beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
})
afterAll(() => {
  if (savedFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
  else process.env.REMO_HEAL_UNIFIED = savedFlag
})

const REPO = 'github://acme/web'
const TASK = { id: 't1', name: 'Nightly', user_id: 'u1', session_id: 's1', is_internal: false }

interface Row {
  id: string
  user_id: string
  trigger_run_id: string
  owner_email: { subject: string; text: string; html: string }
  claimed_at: number | null
  delivered: boolean
}

/** In-memory outbox with the same CAS rules as the SQL. */
function world() {
  const rows: Row[] = []
  const sends: Array<{ to: string; subject: string }> = []
  const heal = { sends: 0 }
  let clock = 1_000_000
  let sendOk = true
  const LEASE = 300_000
  const outbox: OwnerEmailDeps = {
    hasObligation: async (runId) => rows.some((r) => r.trigger_run_id === runId),
    claimByRun: async (runId) => {
      const r = rows.find((x) => x.trigger_run_id === runId)
      return r ? take(r) : null
    },
    list: async () => rows.filter((r) => !r.delivered && (r.claimed_at == null || r.claimed_at < clock - LEASE)).map((r) => ({ id: r.id, user_id: r.user_id, owner_email: r.owner_email })),
    claim: async (id) => {
      const r = rows.find((x) => x.id === id)
      return r ? take(r) : null
    },
    markDelivered: async (id) => {
      rows.find((x) => x.id === id)!.delivered = true
    },
    release: async (id) => {
      rows.find((x) => x.id === id)!.claimed_at = null
    },
    resolveOwnerEmail: async () => 'owner@example.com',
    send: async (m) => {
      if (!sendOk) return false
      sends.push({ to: m.to, subject: m.subject })
      return true
    },
  }
  function take(r: Row) {
    if (r.delivered || (r.claimed_at != null && r.claimed_at >= clock - LEASE)) return null
    r.claimed_at = clock
    return { id: r.id, user_id: r.user_id, owner_email: r.owner_email }
  }
  const healDeps: HealDeps = {
    now: () => clock,
    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
    claim: async (args) => {
      // the obligation is stored in the SAME step as the claim
      const id = `ev${rows.length + 1}`
      rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
      return { ok: true, id }
    },
    setOutcome: async () => {},
    isHealGenerated: async () => false,
    makeSink: () => ({ finalizeTerminal: async () => {}, onParkExpire: async () => {} }) as any,
    dispatch: async () => ({ kind: 'dispatched', runId: 'r1' }) as any,
    runnerTypeOf: async () => 'stream-json',
    isChannelOnline: () => true,
    notify: { claim: async () => true, resolveOwnerEmail: async () => 'owner@example.com', send: async () => { heal.sends++; return true } },
  }
  const sourceDeps: ScheduledSourceDeps = {
    isHealGenerated: async () => false,
    getSession: async () => ({ repo_key: REPO, agent_session_id: null, runner_type: 'stream-json' }) as any,
    countTaskClaimsToday: async () => 0,
    routeHeal: (event) => routeHeal(event, healDeps),
  }
  return {
    rows, sends, heal, outbox, sourceDeps,
    setSendOk: (v: boolean) => { sendOk = v },
    advance: (ms: number) => { clock += ms },
  }
}

const fail = (w: ReturnType<typeof world>, runId: string) =>
  healFailedScheduledRun({ runId, status: 'failed', error: 'boom', task: TASK, persistOwnerEmail: true }, w.sourceDeps)

describe('owner-email outbox: persisted with the heal claim', () => {
  test('the claim carries the obligation; no email has been sent yet', async () => {
    const w = world()
    await fail(w, 'run1')
    expect(w.rows).toHaveLength(1)
    expect(w.rows[0]!.owner_email.subject).toMatch(/\[heal\]/)
    expect(w.rows[0]!.owner_email.text).toContain('run1')
    expect(w.sends).toHaveLength(0)
    expect(w.heal.sends).toBe(0)
  })

  test('without persistOwnerEmail nothing is persisted (legacy default email path)', async () => {
    const w = world()
    await healFailedScheduledRun({ runId: 'run1', status: 'failed', error: 'boom', task: TASK }, w.sourceDeps)
    expect(w.rows[0]!.owner_email).toBeUndefined()
  })
})

describe('owner-email outbox: crash between claim and send', () => {
  test('sweep sends exactly one email; a second sweep sends none', async () => {
    const w = world()
    await fail(w, 'run1') // claim + obligation persisted, then the hub "crashes": no deliverOwnerEmailForRun
    w.advance(10 * 60_000)
    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
    expect(w.sends).toHaveLength(1)
    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(0)
    expect(w.sends).toHaveLength(1)
    expect(w.heal.sends).toBe(0)
  })

  test('the real sweep entry point runs the outbox pass', async () => {
    const w = world()
    await fail(w, 'run1')
    const deps: SweepDeps = {
      list: async () => [],
      reread: async () => null,
      setOutcome: async () => {},
      makeSink: (() => ({})) as any,
      release: async () => {},
      ownerEmails: w.outbox,
    }
    w.advance(10 * 60_000)
    await sweepStaleHealLaunches(deps)
    expect(w.sends).toHaveLength(1)
  })

  test('a send that failed is retried by the sweep (still exactly one delivered)', async () => {
    const w = world()
    await fail(w, 'run1')
    w.setSendOk(false)
    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true)
    expect(w.sends).toHaveLength(0)
    w.setSendOk(true)
    w.advance(10 * 60_000)
    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
    expect(w.sends).toHaveLength(1)
  })

  test('a crash mid-send (lease held) is not re-sent inside the lease, only after it expires', async () => {
    const w = world()
    await fail(w, 'run1')
    await w.outbox.claimByRun('run1') // claimed, then crashed before send/mark
    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
    w.advance(10 * 60_000)
    expect(await sweepOwnerEmails(0, w.outbox)).toBe(1)
    expect(w.sends).toHaveLength(1)
  })
})

describe('owner-email outbox: normal path', () => {
  test('scheduler delivery sends exactly one; the sweep afterwards sends none; default email suppressed', async () => {
    const w = world()
    await fail(w, 'run1')
    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true) // true => suppressDefaultFailureEmail
    expect(w.sends).toHaveLength(1)
    w.advance(10 * 60_000)
    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
    expect(w.sends).toHaveLength(1)
    expect(w.heal.sends).toBe(0)
  })

  test('scheduler and sweep racing: one delivers', async () => {
    const w = world()
    await fail(w, 'run1')
    w.advance(10 * 60_000)
    await Promise.all([deliverOwnerEmailForRun('run1', w.outbox), sweepOwnerEmails(0, w.outbox)])
    expect(w.sends).toHaveLength(1)
  })

  test('no obligation (opted out / no event) => false, caller keeps legacy default email', async () => {
    const w = world()
    expect(await deliverOwnerEmailForRun('nope', w.outbox)).toBe(false)
    expect(w.sends).toHaveLength(0)
  })
})

describe('owner-email outbox: non-live heal outcome does not add a second, ownerless email', () => {
  test('no_routable_session with an obligation: heal sends nothing itself', async () => {
    const w = world()
    const noTarget = { ...w.sourceDeps, routeHeal: (e: unknown) => routeHeal(e, { ...hd(w), resolve: async () => ({ kind: 'none', reason: 'no_session' }) as any }) }
    await healFailedScheduledRun({ runId: 'run2', status: 'failed', error: 'x', task: TASK, persistOwnerEmail: true }, noTarget)
    expect(w.heal.sends).toBe(0)
    expect(await deliverOwnerEmailForRun('run2', w.outbox)).toBe(true)
    expect(w.sends).toHaveLength(1)
  })
})

function hd(w: ReturnType<typeof world>): HealDeps {
  // rebuild the same deps the world uses (route only needs the claim to register the obligation)
  return {
    now: () => 1_000_000,
    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
    claim: async (args) => {
      const id = `ev${w.rows.length + 1}`
      w.rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
      return { ok: true, id }
    },
    setOutcome: async () => {},
    isHealGenerated: async () => false,
    makeSink: () => ({ finalizeTerminal: async () => {}, onParkExpire: async () => {} }) as any,
    dispatch: async () => ({ kind: 'dispatched', runId: 'r1' }) as any,
    runnerTypeOf: async () => 'stream-json',
    isChannelOnline: () => true,
    notify: { claim: async () => true, resolveOwnerEmail: async () => 'owner@example.com', send: async () => { w.heal.sends++; return true } },
    appendOwnerEmailReason: async () => {},
  }
}

describe('owner-email outbox: SQL pins (fake executor)', () => {
  function fake(responder: (text: string) => unknown[] = () => []) {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const tag = (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join('?')
      calls.push({ text, values: v })
      return Promise.resolve(responder(text))
    }
    const exec: any = Object.assign(tag, { begin: async (fn: (tx: any) => Promise<unknown>) => fn(tag) })
    return { exec, calls }
  }

  test('claimHealEvent INSERT writes owner_email in the same transaction', async () => {
    const { exec, calls } = fake((t) => (/INSERT INTO heal_events/.test(t) ? [{ id: 'ev1' }] : /count\(\*\)/i.test(t) ? [{ n: '0' }] : []))
    const r = await claimHealEvent(
      {
        userId: 'u1', source: 'scheduled_task', dedupeKey: 'task:t1:abc', repoIdent: REPO, triggerRunId: 'run1',
        windowMs: 3_600_000, maxClaimsPerUserHour: 10, retentionHours: 48,
        ownerEmail: { subject: 's', text: 't', html: 'h' }, nowMs: 1_000_000,
      },
      exec,
    )
    expect(r.ok).toBe(true)
    const ins = calls.find((c) => /INSERT INTO heal_events/.test(c.text))!
    expect(ins.text).toContain('owner_email')
    expect(ins.values).toContain(JSON.stringify({ subject: 's', text: 't', html: 'h' }))
  })

  test('delivery is a lease CAS on the delivered flag', async () => {
    const { exec, calls } = fake(() => [])
    expect(await claimOwnerEmailDelivery('ev1', 300_000, exec, 1_000_000)).toBeNull()
    const t = calls[0]!.text
    expect(t).toMatch(/UPDATE heal_events SET owner_email_claimed_at/)
    expect(t).toMatch(/owner_email_delivered_at IS NULL/)
    expect(t).toMatch(/owner_email_claimed_at IS NULL OR owner_email_claimed_at </)
    expect(t).toMatch(/RETURNING/)
  })

  test('the sweep list selects only undelivered obligations', async () => {
    const { exec, calls } = fake(() => [])
    await listPendingOwnerEmails(60_000, exec, 1_000_000)
    expect(calls[0]!.text).toMatch(/owner_email IS NOT NULL AND owner_email_delivered_at IS NULL/)
  })
})
