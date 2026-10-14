/**
 * PTYCAP-04: automation-controls core behaviour over a fake sql (DB-free).
 * The real SQL is proven in test/e2e/automation-controls-checks.ts (Woodpecker).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createFakeSql } from './fixtures/automation-fake-sql.ts'

const fake = createFakeSql()
const { state } = fake
const notifications: any[] = []
let notifyThrows = false

mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
mock.module('../src/orchestrator/notify.ts', () => ({
  fanOutNotify: async (input: any) => {
    if (notifyThrows) throw new Error('notify_boom')
    notifications.push(input)
    return { delivered: [] }
  },
}))

const C = await import(`../src/dispatch/automation-controls.ts?t=${Date.now()}`)

const ENV_KEYS = ['REMO_AUTOMATION_KILL_SWITCH', 'REMO_AUTOMATION_LIFETIME_INJECT_CAP', 'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR']
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  state.ledger.length = 0
  state.kill.length = 0
  state.runlog.length = 0
  state.tasks.length = 0
  state.statements.length = 0
  state.unknown.length = 0
  state.failOn = null
  state.beginCalls = 0
  state.lockCalls = 0
  state.seq = 0
  notifications.length = 0
  notifyThrows = false
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  expect(state.unknown).toEqual([]) // the fake recognised every statement
})
afterAll(() => {
  mock.restore()
})

const req = (over: Record<string, unknown> = {}): any => ({
  userId: 'u1',
  sessionId: 's1',
  token: 't1',
  prompt: 'p',
  counterKey: 'task:T1',
  ...over,
})
const reserve = (over: Record<string, unknown> = {}) =>
  C.reserveInject({ userId: 'u1', sessionId: 's1', token: 't1', counterKey: 'task:T1', ...over })
const injectRows = () => state.ledger.filter((r) => r.kind === 'inject')

describe('kill switch', () => {
  test('env break-glass halts without touching the DB', async () => {
    process.env.REMO_AUTOMATION_KILL_SWITCH = 'on'
    expect(await C.isAutomationHalted({ userId: 'u1', sessionId: 's1' })).toEqual({ halted: true, scope: 'env' })
    expect(state.statements.length).toBe(0)
  })

  test('no env, no row: not halted, exactly ONE select; absent sessionId is passed as empty string', async () => {
    expect(await C.isAutomationHalted({ userId: 'u1' })).toEqual({ halted: false })
    expect(state.statements.length).toBe(1)
  })

  test('global row halts everyone; user row halts only that user; session row only that session', async () => {
    await C.engageKillSwitch({ scope: 'user', userId: 'u1', engagedBy: 'admin' })
    expect(await C.isAutomationHalted({ userId: 'u1', sessionId: 'sX' })).toEqual({ halted: true, scope: 'user' })
    expect(await C.isAutomationHalted({ userId: 'u2', sessionId: 'sX' })).toEqual({ halted: false })
    await C.engageKillSwitch({ scope: 'session', userId: 'u2', sessionId: 's9', engagedBy: 'u2' })
    expect(await C.isAutomationHalted({ userId: 'u2', sessionId: 's9' })).toEqual({ halted: true, scope: 'session' })
    expect(await C.isAutomationHalted({ userId: 'u2', sessionId: 's8' })).toEqual({ halted: false })
    await C.engageKillSwitch({ scope: 'global', engagedBy: 'admin' })
    expect(await C.isAutomationHalted({ userId: 'u3', sessionId: 'sZ' })).toEqual({ halted: true, scope: 'global' })
  })

  test('a returned row must carry engaged === true to count', async () => {
    state.kill.push({
      id: 'k', scope: 'global', user_id: null, session_id: null, engaged: false,
      reason: null, engaged_by: 'a', engaged_at: 0, released_by: null, released_at: null,
    })
    expect(await C.isAutomationHalted({ userId: 'u1' })).toEqual({ halted: false })
  })

  test('select throws -> halted with scope error (fail closed)', async () => {
    state.failOn = (t) => t.includes('automation_kill_switch')
    expect(await C.isAutomationHalted({ userId: 'u1', sessionId: 's1' })).toEqual({ halted: true, scope: 'error' })
  })

  test('killSwitchCheck reason, gate name, and gate delegates to the predicate', async () => {
    expect(C.automationKillSwitchGate.name).toBe('automation_kill_switch')
    expect(C.automationKillSwitchGate.check).toBe(C.killSwitchCheck)
    expect(await C.killSwitchCheck(req())).toEqual({ ok: true })
    await C.engageKillSwitch({ scope: 'global', engagedBy: 'admin' })
    expect(await C.killSwitchCheck(req())).toEqual({ ok: false, reason: 'automation_halted:global' })
  })

  test('engage is idempotent, release reports whether a row was released, state reflects rows + env', async () => {
    expect(await C.engageKillSwitch({ scope: 'global', engagedBy: 'a' })).toEqual({ engaged: true, alreadyEngaged: false })
    expect(await C.engageKillSwitch({ scope: 'global', engagedBy: 'a' })).toEqual({ engaged: true, alreadyEngaged: true })
    expect(state.kill.filter((k) => k.engaged).length).toBe(1)
    await C.engageKillSwitch({ scope: 'user', userId: 'u1', engagedBy: 'u1' })
    await C.engageKillSwitch({ scope: 'session', userId: 'u1', sessionId: 's1', engagedBy: 'u1' })
    process.env.REMO_AUTOMATION_KILL_SWITCH = '1'
    const st = await C.getKillSwitchState({ userId: 'u1' })
    expect(st.env).toBe(true)
    expect(st.global?.scope).toBe('global')
    expect(st.user?.scope).toBe('user')
    expect(st.sessions.map((s: any) => s.session_id)).toEqual(['s1'])
    expect(await C.releaseKillSwitch({ scope: 'global', releasedBy: 'a' })).toEqual({ released: true })
    expect(await C.releaseKillSwitch({ scope: 'global', releasedBy: 'a' })).toEqual({ released: false })
    expect(state.kill.length).toBe(3) // history rows stay
  })

  test('user and session scoped release match only their own target (a session row also records its user)', async () => {
    await C.engageKillSwitch({ scope: 'user', userId: 'u1', engagedBy: 'a' })
    await C.engageKillSwitch({ scope: 'session', userId: 'u1', sessionId: 's1', engagedBy: 'a' })
    expect(await C.releaseKillSwitch({ scope: 'user', userId: 'u2', releasedBy: 'a' })).toEqual({ released: false })
    expect(await C.releaseKillSwitch({ scope: 'session', sessionId: 'sX', releasedBy: 'a' })).toEqual({ released: false })
    expect(await C.releaseKillSwitch({ scope: 'session', sessionId: 's1', releasedBy: 'a' })).toEqual({ released: true })
    expect(await C.releaseKillSwitch({ scope: 'user', userId: 'u1', releasedBy: 'a' })).toEqual({ released: true })
    expect(await C.isAutomationHalted({ userId: 'u1', sessionId: 's1' })).toEqual({ halted: false })
  })
})

describe('lifetime counter gate', () => {
  test('blocks lifetime_counter_key_missing without a counterKey', async () => {
    expect(await C.lifetimeCounterCheck(req({ counterKey: undefined }))).toEqual({
      ok: false,
      reason: 'lifetime_counter_key_missing',
    })
    expect(C.automationLifetimeCounterGate.name).toBe('lifetime_counter')
  })

  test('passes under the cap, blocks at the cap with the stable reason', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '2'
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: true })
    await reserve({ token: 'a' })
    await reserve({ token: 'b' })
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: false, reason: 'lifetime_inject_exhausted:2>=2' })
  })

  // PTYCAP-07 QC r1 (codex #2): a pre-launch reservation that took the cap-th slot must not
  // block its OWN post-spawn dispatch. Same token + unreleased row = idempotent pass; a different
  // token, or a released reservation, is still blocked at the cap.
  test('at the cap, a request whose OWN token already holds an active reservation passes', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '2'
    await reserve({ token: 'a' })
    await reserve({ token: 'mine' }) // the cap-th reservation
    expect(await C.lifetimeCounterCheck(req({ token: 'mine' }))).toEqual({ ok: true })
    expect(await C.lifetimeCounterCheck(req({ token: 'other' }))).toEqual({
      ok: false,
      reason: 'lifetime_inject_exhausted:2>=2',
    })
    await C.releaseInject({ counterKey: 'task:T1', token: 'mine' })
    await reserve({ token: 'b' })
    expect((await C.lifetimeCounterCheck(req({ token: 'mine' }))).ok).toBe(false) // released: not honoured
  })

  test('counts ONLY unreleased inject rows after the latest reset; page and reset rows never count', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '3'
    await reserve({ token: 'a' })
    await reserve({ token: 'b' })
    await C.releaseInject({ counterKey: 'task:T1', token: 'b' })
    await C.claimLifetimePage({ userId: 'u1', counterKey: 'task:T1', kind: 'warn' })
    expect(state.ledger.length).toBe(3) // 2 inject + 1 page
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: true }) // only 'a' counts
    await C.resetLifetimeCounter({ userId: 'u1', counterKey: 'task:T1' })
    await reserve({ token: 'c' })
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: true }) // only 'c' (post-reset)
  })

  test('DB failure -> lifetime_counter_error (fail closed)', async () => {
    state.failOn = (t) => t.includes('automation_inject_ledger')
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: false, reason: 'lifetime_counter_error' })
  })
})

describe('reserveInject (atomic reservation)', () => {
  test('takes the advisory lock inside sql.begin and inserts one inject row', async () => {
    const r = await reserve({ actor: 'orchestrator' })
    expect(r).toEqual({ ok: true, count: 1 })
    expect(state.beginCalls).toBe(1)
    expect(state.lockCalls).toBe(1)
    expect(injectRows().length).toBe(1)
    expect(injectRows()[0]!.actor).toBe('orchestrator')
  })

  test('token-idempotent: the same token twice is one row', async () => {
    expect((await reserve()).ok).toBe(true)
    expect(await reserve()).toEqual({ ok: true })
    expect(injectRows().length).toBe(1)
  })

  test('lifetime count at or over the cap blocks lifetime_inject_exhausted', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    expect((await reserve({ token: 'a' })).ok).toBe(true)
    expect(await reserve({ token: 'b' })).toEqual({ ok: false, reason: 'lifetime_inject_exhausted:1>=1' })
    expect(injectRows().length).toBe(1)
  })

  test('enforceRate blocks over_session_inject_rate; lifetime is checked first', async () => {
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '2'
    expect((await reserve({ token: 'a', enforceRate: true })).ok).toBe(true)
    expect((await reserve({ token: 'b', counterKey: 'task:T2', enforceRate: true })).ok).toBe(true)
    expect(await reserve({ token: 'c', counterKey: 'task:T3', enforceRate: true })).toEqual({
      ok: false,
      reason: 'over_session_inject_rate:2>=2',
    })
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    // both exceeded for T1: the lifetime reason wins
    expect(await reserve({ token: 'd', enforceRate: true })).toEqual({ ok: false, reason: 'lifetime_inject_exhausted:1>=1' })
    expect(state.lockCalls).toBeGreaterThanOrEqual(5) // counter-key lock + session lock per rate-checked reserve
  })

  test('enforceRate false ignores the rate; a disabled/garbage rate cap is not an error', async () => {
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '1'
    expect((await reserve({ token: 'a' })).ok).toBe(true)
    expect((await reserve({ token: 'b' })).ok).toBe(true)
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '0'
    expect((await reserve({ token: 'c', enforceRate: true })).ok).toBe(true)
  })

  test('a released token re-reserves under the same checks without a second row', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    await reserve({ token: 'a' })
    await C.releaseInject({ counterKey: 'task:T1', token: 'a' })
    expect((await reserve({ token: 'a' })).ok).toBe(true)
    expect(injectRows().length).toBe(1)
    expect(injectRows()[0]!.released_at).toBeNull()
    // and a DIFFERENT token is now refused again
    expect((await reserve({ token: 'b' })).ok).toBe(false)
  })

  test('any throw returns blocked, never ok', async () => {
    state.failOn = (t) => t.includes('pg_advisory_xact_lock')
    expect(await reserve()).toEqual({ ok: false, reason: 'lifetime_counter_error' })
    expect(injectRows().length).toBe(0)
  })
})

describe('countRateUnion', () => {
  test('a dispatched inject present in both sources counts ONCE; queued/null-token and door-only turns count once each', async () => {
    const now = Date.now()
    state.ledger.push(
      { seq: 1, id: 'l1', user_id: 'u1', session_id: 's1', counter_key: 'k', actor: '', token: 'tok-both', kind: 'inject', created_at: now, released_at: null },
      { seq: 2, id: 'l2', user_id: 'u1', session_id: 's1', counter_key: 'k', actor: '', token: 'door-only', kind: 'inject', created_at: now, released_at: null },
      { seq: 3, id: 'l3', user_id: 'u1', session_id: 's1', counter_key: 'k', actor: '', token: 'released', kind: 'inject', created_at: now, released_at: now },
      { seq: 4, id: 'l4', user_id: 'u1', session_id: 's1', counter_key: 'k', actor: '', token: 'page:warn:0', kind: 'page', created_at: now, released_at: null },
    )
    state.runlog.push(
      { id: 'r1', session_id: 's1', outcome: 'dispatched', inject_token: 'tok-both', created_at: now },
      { id: 'r2', session_id: 's1', outcome: 'queued', inject_token: null, created_at: now },
      { id: 'r3', session_id: 's1', outcome: 'refused', inject_token: null, created_at: now },
      { id: 'r4', session_id: 's1', outcome: 'dispatched', inject_token: null, created_at: now - 61 * 60_000 },
      { id: 'r5', session_id: 'other', outcome: 'dispatched', inject_token: null, created_at: now },
    )
    expect(await C.countRateUnion('s1', 60)).toBe(3) // tok-both, door-only, runlog:r2
  })
})

describe('releaseInject', () => {
  test('stamps released_at only while null, never deletes, never throws', async () => {
    await reserve({ token: 'a' })
    await C.releaseInject({ counterKey: 'task:T1', token: 'a' })
    const stamp = injectRows()[0]!.released_at
    expect(stamp).not.toBeNull()
    await C.releaseInject({ counterKey: 'task:T1', token: 'a' })
    expect(injectRows()[0]!.released_at).toBe(stamp)
    expect(state.ledger.length).toBe(1)
    state.failOn = () => true
    await C.releaseInject({ counterKey: 'task:T1', token: 'a' }) // must not throw
  })
})

describe('releaseInjectStrict (QC r2: a failed release must be visible to the retrying caller)', () => {
  test('stamps the reservation, is idempotent, and resolves for a token that never reserved', async () => {
    await reserve({ token: 'a' })
    await C.releaseInjectStrict({ counterKey: 'task:T1', token: 'a' })
    const stamp = injectRows()[0]!.released_at
    expect(stamp).not.toBeNull()
    await C.releaseInjectStrict({ counterKey: 'task:T1', token: 'a' })
    expect(injectRows()[0]!.released_at).toBe(stamp)
    await C.releaseInjectStrict({ counterKey: 'task:T1', token: 'never-reserved' }) // MINOR 3: no row, no throw
    expect(state.ledger.length).toBe(1)
  })

  test('REJECTS on a database failure, while the legacy releaseInject still swallows it', async () => {
    await reserve({ token: 'a' })
    state.failOn = () => true
    await expect(C.releaseInjectStrict({ counterKey: 'task:T1', token: 'a' })).rejects.toBeDefined()
    await C.releaseInject({ counterKey: 'task:T1', token: 'a' }) // must not throw
    state.failOn = null
    expect(injectRows()[0]!.released_at).toBeNull() // the failed releases left the reservation active
  })
})

describe('pages and reset', () => {
  test('claimLifetimePage claims once per (key, kind, epoch); a reset opens a new epoch; kinds are independent', async () => {
    const a = { userId: 'u1', sessionId: 's1', counterKey: 'task:T1' }
    expect(await C.claimLifetimePage({ ...a, kind: 'warn' })).toEqual({ claimed: true })
    expect(await C.claimLifetimePage({ ...a, kind: 'warn' })).toEqual({ claimed: false })
    expect(await C.claimLifetimePage({ ...a, kind: 'exhausted' })).toEqual({ claimed: true })
    await reserve({ token: 'a' })
    expect((await C.resetLifetimeCounter({ userId: 'u1', counterKey: 'task:T1' })).ok).toBe(true)
    expect(await C.claimLifetimePage({ ...a, kind: 'warn' })).toEqual({ claimed: true })
    expect(state.ledger.filter((r) => r.kind === 'page').map((r) => r.token)).toEqual([
      'page:warn:0',
      'page:exhausted:0',
      `page:warn:${state.ledger.find((r) => r.kind === 'reset')!.seq}`,
    ])
  })

  test('80 percent warning sends ONE notification (all four channels, ASCII), exhaustion ONE more, repeats send nothing', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '5'
    for (const t of ['a', 'b', 'c']) await reserve({ token: t })
    expect(notifications.length).toBe(0) // 3 < ceil(0.8*5)=4
    await reserve({ token: 'd' }) // reaches 4
    expect(notifications.length).toBe(1)
    const n = notifications[0]
    expect(n.event).toBe('failure')
    expect(n.level).toBe('blocking')
    expect(n.channels).toEqual(['telegram', 'inapp', 'email', 'push'])
    expect(n.detail).toContain('task:T1')
    expect(n.detail).toContain('4 of 5')
    expect(n.detail).toContain('REMO_AUTOMATION_LIFETIME_INJECT_CAP')
    expect(/^[\x20-\x7e]*$/.test(n.detail)).toBe(true)
    await reserve({ token: 'e' }) // count 5 >= warn threshold, same epoch -> no second warn
    expect(notifications.length).toBe(1)
    await reserve({ token: 'f' }) // exhausted
    expect(notifications.length).toBe(2)
    expect(notifications[1].detail).toContain('EXHAUSTED')
    await reserve({ token: 'g' }) // exhausted again, same epoch
    expect(notifications.length).toBe(2)
  })

  test('the lifetime GATE claims the exhaustion page once per epoch (the normal place a spent budget is first seen)', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    await reserve({ token: 'a' })
    notifications.length = 0
    expect((await C.lifetimeCounterCheck(req())).ok).toBe(false)
    expect(notifications.length).toBe(1)
    expect(notifications[0].detail).toContain('EXHAUSTED')
    expect((await C.lifetimeCounterCheck(req())).ok).toBe(false)
    expect(notifications.length).toBe(1)
    await C.resetLifetimeCounter({ userId: 'u1', counterKey: 'task:T1' })
    await reserve({ token: 'b' })
    notifications.length = 0
    expect((await C.lifetimeCounterCheck(req())).ok).toBe(false)
    expect(notifications.length).toBe(1) // new epoch pages again
  })

  test('notify errors never change the reserve result', async () => {
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    notifyThrows = true
    expect((await reserve({ token: 'a' })).ok).toBe(true)
    expect(await reserve({ token: 'b' })).toEqual({ ok: false, reason: 'lifetime_inject_exhausted:1>=1' })
  })

  test('resetLifetimeCounter appends a marker only when the caller owns rows; history is never touched', async () => {
    expect(await C.resetLifetimeCounter({ userId: 'u1', counterKey: 'task:T1' })).toEqual({ ok: false, reason: 'unknown_counter_key' })
    await reserve({ token: 'a' })
    expect(await C.resetLifetimeCounter({ userId: 'other', counterKey: 'task:T1' })).toEqual({ ok: false, reason: 'unknown_counter_key' })
    const before = injectRows().length
    expect(await C.resetLifetimeCounter({ userId: 'u1', counterKey: 'task:T1', actor: 'u1' })).toEqual({ ok: true })
    expect(injectRows().length).toBe(before) // the earlier inject row still exists
    expect(state.ledger.filter((r) => r.kind === 'reset').length).toBe(1)
    expect(await C.lifetimeCounterCheck(req())).toEqual({ ok: true })
  })
})

describe('pipeline hooks', () => {
  test('preSendGuard: machine halted -> reason; counterKey reserves and passes enforceRate; no key no reserve', async () => {
    expect(await C.preSendGuard(req({ counterKey: undefined }), { machine: true, enforceRate: false })).toEqual({
      ok: true,
      reserved: false,
    })
    expect(injectRows().length).toBe(0)
    expect(await C.preSendGuard(req(), { machine: false, enforceRate: false })).toEqual({ ok: true, reserved: true })
    expect(injectRows().length).toBe(1)
    await C.engageKillSwitch({ scope: 'global', engagedBy: 'a' })
    expect(await C.preSendGuard(req({ token: 'z' }), { machine: true, enforceRate: false })).toEqual({
      ok: false,
      reason: 'automation_halted:global',
    })
    expect(injectRows().length).toBe(1) // halted before any reserve
    // machine false: a halted switch is not this guard's business (the gate list handles it)
    expect((await C.preSendGuard(req({ token: 'y' }), { machine: false, enforceRate: false })).ok).toBe(true)
  })

  test('preSendGuard enforceRate is passed through to the reservation', async () => {
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '1'
    await C.preSendGuard(req({ token: 'a' }), { machine: false, enforceRate: true })
    const r = await C.preSendGuard(req({ token: 'b', counterKey: 'task:T2' }), { machine: false, enforceRate: true })
    expect(r).toEqual({ ok: false, reason: 'over_session_inject_rate:1>=1' })
  })

  test('preSendGuard maps a throw to automation_guard_error', async () => {
    state.failOn = (t) => t.includes('automation_kill_switch')
    // isAutomationHalted swallows into scope error; force a throw further up instead
    const bad: any = { get userId() { throw new Error('boom') }, sessionId: 's1', token: 't', prompt: '' }
    expect(await C.preSendGuard(bad, { machine: true, enforceRate: false })).toEqual({ ok: false, reason: 'automation_guard_error' })
  })

  test('finalHaltCheck re-reads the switch', async () => {
    expect(await C.finalHaltCheck(req())).toEqual({ ok: true })
    await C.engageKillSwitch({ scope: 'user', userId: 'u1', engagedBy: 'a' })
    expect(await C.finalHaltCheck(req())).toEqual({ ok: false, reason: 'automation_halted:user' })
  })
})

describe('resolveOrchestratorCounterKey', () => {
  test('taskId wins; else the 1:1 orchestrator task; else session:<id>; a DB error propagates', async () => {
    expect(await C.resolveOrchestratorCounterKey({ userId: 'u1', sessionId: 's1', taskId: 'T9' })).toBe('task:T9')
    expect(state.statements.length).toBe(0)
    state.tasks.push({ id: 'T5', session_id: 's1', task_type: 'orchestrator' }, { id: 'X', session_id: 's2', task_type: 'agent' })
    expect(await C.resolveOrchestratorCounterKey({ userId: 'u1', sessionId: 's1' })).toBe('task:T5')
    expect(await C.resolveOrchestratorCounterKey({ userId: 'u1', sessionId: 's2' })).toBe('session:s2')
    state.failOn = (t) => t.includes('scheduled_tasks')
    await expect(C.resolveOrchestratorCounterKey({ userId: 'u1', sessionId: 's1' })).rejects.toThrow('fake_sql_failure')
  })
})
