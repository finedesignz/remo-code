/**
 * PTYCAP-04-07 Task 3: POST /api/sessions/heal is a MACHINE surface (panel F-2).
 *
 * The external self-heal service emits session.start outside the guarded launch primitives, so
 * the route (1) checks the kill switch BEFORE pickSessionTarget consumes a slot and a run row,
 * (2) makes ONE lifetime reservation per request under heal:<userId>:<repo> with a fresh per-call token
 * and no rate enforcement, and (3) releases it on every exit that does not start a session.
 * Controls, routing, budget and the supervisor registry are mocked (spreading the real modules
 * so unrelated exports stay resolvable); per-file bun process because mock.module is global.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const st = {
  halted: null as null | string,
  haltCalls: 0,
  lateHalted: null as null | string,
  preSendCalls: 0,
  endedRuns: [] as any[],
  reserve: [] as any[],
  reserveResult: { ok: true } as any,
  releases: [] as any[],
  picks: [] as any[],
  pickQueue: [] as any[],
  sends: [] as any[],
  throwOnSendOnce: false,
  throwOnSendAlways: false,
  slotReleases: 0,
}

const realControls = await import(`../src/dispatch/automation-controls.ts?real=${Date.now()}`)
const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
const realRegistry = await import(`../src/ws/supervisor-registry.ts?real=${Date.now()}`)
const realBudget = await import(`../src/sessions/budget.ts?real=${Date.now()}`)
const realSupDal = await import(`../src/db/supervisor-dal.ts?real=${Date.now()}`)

mock.module('../src/dispatch/automation-controls.ts', () => ({
  ...realControls,
  isAutomationHalted: async () => {
    st.haltCalls++
    return st.halted ? { halted: true, scope: st.halted } : { halted: false }
  },
  // QC B1: the fresh read immediately before session.start. `lateHalted` simulates an engage
  // that lands AFTER the early check and AFTER pickSessionTarget consumed a slot + run row.
  haltBeforeMachineSend: async () => {
    st.preSendCalls++
    return st.lateHalted
      ? { ok: false, reason: `automation_halted:${st.lateHalted}`, scope: st.lateHalted }
      : { ok: true }
  },
  reserveInject: async (a: any) => {
    st.reserve.push(a)
    return st.reserveResult
  },
  releaseInject: async (a: any) => {
    st.releases.push(a)
  },
}))
mock.module('../src/sessions/routing.ts', () => ({
  pickSessionTarget: async (_u: string, opts: any) => {
    st.picks.push(opts)
    return st.pickQueue.shift() ?? { kind: 'none' }
  },
}))
mock.module('../src/db/dal.ts', () => ({ ...realDal, getSessionSkipPermissionsByRepo: async () => false }))
mock.module('../src/sessions/budget.ts', () => ({
  ...realBudget,
  releaseSessionSlot: async () => { st.slotReleases++ },
}))
mock.module('../src/db/supervisor-dal.ts', () => ({ ...realSupDal, endRun: async (...a: any[]) => { st.endedRuns.push(a); return {} } }))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  ...realRegistry,
  sendToSupervisor: (supId: string, msg: any) => {
    if (st.throwOnSendAlways) throw new Error('ws send boom')
    if (st.throwOnSendOnce) {
      st.throwOnSendOnce = false
      throw new Error('ws send boom')
    }
    st.sends.push({ supId, msg })
  },
  updateSupervisorState: async () => {},
}))

let app: Hono

beforeAll(async () => {
  const { sessions } = await import('../src/api/sessions.ts')
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, (c.req.header('x-test-user') ?? 'u1') as never)
    await next()
  })
  app.route('/api/sessions', sessions)
})

beforeEach(() => {
  st.halted = null
  st.haltCalls = 0
  st.lateHalted = null
  st.preSendCalls = 0
  st.endedRuns = []
  st.reserve = []
  st.reserveResult = { ok: true }
  st.releases = []
  st.picks = []
  st.pickQueue = []
  st.sends = []
  st.throwOnSendOnce = false
  st.throwOnSendAlways = false
  st.slotReleases = 0
})

const BODY = { repo: 'github://o/r', branch: 'main', prompt: 'fix it' }
function heal(body: unknown = BODY, user?: string) {
  return app.request('/api/sessions/heal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body),
  })
}
const supPick = () => ({ kind: 'supervisor', supervisor_id: 'sup-1', run: { id: 'run-1' } })

describe('POST /api/sessions/heal kill switch + lifetime reservation', () => {
  test.each(['global', 'user', 'env'])('halted (%s) -> 503 BEFORE pickSessionTarget: no slot, no run row, no send, no reservation', async (scope) => {
    st.halted = scope
    const res = await heal()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'automation_halted', reason: `automation_halted:${scope}` })
    expect(st.picks).toHaveLength(0)
    expect(st.reserve).toHaveLength(0)
    expect(st.sends).toHaveLength(0)
  })

  test('not halted: ONE reserveInject per request (not per hop), key heal:<userId>:<repo>, fresh token, no rate enforcement', async () => {
    st.throwOnSendOnce = true // hop 1 send fails -> hop 2 succeeds
    st.pickQueue = [supPick(), supPick()]
    const res = await heal()
    expect(res.status).toBe(202)
    expect(st.picks).toHaveLength(2)
    expect(st.reserve).toHaveLength(1)
    const r = st.reserve[0]
    expect(r.counterKey).toBe('heal:u1:github://o/r')
    expect(r.actor).toBe('self-heal')
    expect(r.enforceRate).toBeFalsy()
    expect(r.token).toMatch(/^heal:/)
    st.pickQueue = [supPick()]
    await heal()
    expect(st.reserve[1].token).not.toBe(r.token)
  })

  test('exhausted -> 503 lifetime_inject_exhausted with pickSessionTarget never called', async () => {
    st.reserveResult = { ok: false, reason: 'lifetime_inject_exhausted:1000>=1000' }
    const res = await heal()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'lifetime_inject_exhausted', reason: 'lifetime_inject_exhausted:1000>=1000' })
    expect(st.picks).toHaveLength(0)
    expect(st.releases).toHaveLength(0)
  })

  test('a started session leaves the reservation counted (no release)', async () => {
    st.pickQueue = [supPick()]
    const res = await heal()
    expect(res.status).toBe(202)
    expect(st.sends).toHaveLength(1)
    expect(st.releases).toHaveLength(0)
  })

  test('no_target_available, quota_blocked and every-hop-failed each release the reservation exactly once', async () => {
    st.pickQueue = [{ kind: 'none' }]
    expect((await heal()).status).toBe(503)
    expect(st.releases).toHaveLength(1)
    expect(st.releases[0]).toEqual({ counterKey: st.reserve[0].counterKey, token: st.reserve[0].token })

    st.pickQueue = [{ kind: 'quota_blocked', reason: 'threshold', utilization_pct: 99, threshold_pct: 95, resets_at: null }]
    expect((await heal()).status).toBe(503)
    expect(st.releases).toHaveLength(2)

    // every hop's send throws -> HEAL_MAX_HOPS exhausted -> all_dispatches_failed
    st.throwOnSendAlways = true
    st.pickQueue = [supPick(), supPick(), supPick()]
    const res = await heal()
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).reason).toBe('all_dispatches_failed')
    expect(st.releases).toHaveLength(3)
    expect(st.sends).toHaveLength(0)
  })

  test('invalid body -> 400 before the halt check (other validation paths unchanged)', async () => {
    const res = await heal({ repo: '' })
    expect(res.status).toBe(400)
    expect(st.haltCalls).toBe(0)
  })
})

describe('QC M2: heal counter key is scoped by user', () => {
  test('two users healing the SAME repo reserve under DIFFERENT counter keys', async () => {
    st.pickQueue = [supPick()]
    await heal(BODY, 'alice')
    st.pickQueue = [supPick()]
    await heal(BODY, 'bob')
    expect(st.reserve.map((r: any) => r.counterKey)).toEqual(['heal:alice:github://o/r', 'heal:bob:github://o/r'])
    expect(st.reserve[0].userId).toBe('alice')
    expect(st.reserve[1].userId).toBe('bob')
  })
})

describe('QC B1: fresh kill-switch read immediately before session.start', () => {
  test('an engage landing after pickSessionTarget stops the send: run ended, slot freed, reservation released, 503', async () => {
    st.pickQueue = [supPick()]
    st.lateHalted = 'global'
    const res = await heal()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'automation_halted', reason: 'automation_halted:global' })
    expect(st.picks).toHaveLength(1) // the early check passed: it IS the late window
    expect(st.preSendCalls).toBe(1)
    expect(st.sends).toHaveLength(0)
    expect(st.endedRuns).toHaveLength(1)
    expect(st.endedRuns[0][0]).toBe('run-1')
    expect(st.slotReleases).toBe(1)
    expect(st.releases).toHaveLength(1)
    expect(st.releases[0]).toEqual({ counterKey: st.reserve[0].counterKey, token: st.reserve[0].token })
  })

  test('not halted late: the pre-send read happens and the session starts', async () => {
    st.pickQueue = [supPick()]
    const res = await heal()
    expect(res.status).toBe(202)
    expect(st.preSendCalls).toBe(1)
    expect(st.sends).toHaveLength(1)
  })
})

