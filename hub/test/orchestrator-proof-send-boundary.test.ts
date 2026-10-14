/**
 * PTYCAP-05 QC round 2 (codex #2/#3): the wire-send boundary. The REAL orchestrator `buildSend`
 * persists the prompt (an awaited DB insert) BEFORE writing to the agent socket. An arm / disarm
 * that commits during that await used to be followed by the stale send. The boundary rechecks the
 * kill switch + active-run identity AFTER persistence, under the same hub-global lock arm/disarm
 * take. These tests race arm / disarm against the real buildSend (not finalHaltCheck alone).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createProofFakeSql } from './fixtures/proof-fake-sql.ts'

const fake = createProofFakeSql()
const { state } = fake

// The persistence insert is parked on a gate the test controls; the kill-switch read answers from
// the fake's kill rows; every other statement is the in-memory proof fake.
let persistGate: Promise<void> = Promise.resolve()
const sql: any = (strings: TemplateStringsArray, ...values: any[]) => {
  const text = strings.join('?')
  if (text.includes('INSERT INTO messages')) {
    return persistGate.then(() => [{ id: 'm1', created_at: '2026-10-13T00:00:00Z' }])
  }
  if (text.includes('FROM automation_kill_switch') && text.includes('SELECT scope, engaged')) {
    const sessionId = values[1]
    const k = state.kill.find((x) => x.engaged && x.scope === 'session' && x.session_id === sessionId)
    return Promise.resolve(k ? [{ scope: 'session', engaged: true }] : [])
  }
  return fake.sql(strings, ...values)
}
sql.json = fake.sql.json
sql.begin = fake.sql.begin
mock.module('../src/db/postgres.ts', () => ({ sql }))

const stamp = Date.now()
const I = await import(`../src/orchestrator/inject.ts?t=${stamp}`)
const D = await import(`../src/db/orchestrator-proof-dal.ts?t=${stamp}`)

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    process.env[k] = '1'
  }
  for (const k of ['runs', 'tasks', 'rows', 'allow', 'kill', 'queue'] as const) (state as any)[k] = []
  state.statements.length = 0
  state.unknown.length = 0
  state.lockCalls = 0
  state.lockKeys.length = 0
  persistGate = Promise.resolve()
})
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  expect(state.unknown).toEqual([])
})
afterAll(() => {
  mock.restore()
})

const sent: string[] = []
const deps = (): any => ({
  getChannel: () => ({ ws: { send: (m: string) => sent.push(m) } }),
})
const REQ = (over: Record<string, unknown> = {}): any => ({
  userId: 'u1', sessionId: 's1', token: 'tok', prompt: 'merge everything', counterKey: 'task:T1', ...over,
})
const armArgs = (): any => ({
  userId: 'u1', sessionId: 's1', repoIdent: 'github://acme/proof', installationId: 99, repoOwner: 'acme', repoName: 'proof',
  defaultBranch: 'main', baseSha: 'a'.repeat(40), rulesetIds: [7], rulesetDigest: 'dig', rulesetUpdatedAt: null,
  protectionShape: 'update_restriction', requiredContexts: ['ci'], armPreconditions: {}, maxInjects: 5, maxTokens: 1_000_000,
  maxWallMs: 3_600_000, scheduleRule: { interval: 5, unit: 'minutes', start_at: '2026-10-13T00:00:00Z' },
})
function parkPersist(): () => void {
  let open!: () => void
  persistGate = new Promise<void>((r) => (open = r))
  return open
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('wire-send boundary races arm / disarm against the REAL buildSend', () => {
  test('disarm commits while the prompt is being persisted: the send is refused, nothing reaches the socket', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    await D.enableProofTaskTx({ userId: 'u1' }) // released halt: the run is live
    sent.length = 0
    const open = parkPersist()
    const send = I.buildSend('merge everything', 'tok', deps())
    const p = send(REQ({ proofRunId: run.id, counterKey: run.counter_key }))
    const settled = p.then(() => 'sent', (e: Error) => e.message)
    await tick() // buildSend is now parked inside insertMessage
    await D.disarmProofRunTx({ userId: 'u1' }) // the owner disarms in that window
    open()
    expect(await settled).toMatch(/^proof_send_refused:/)
    expect(sent).toEqual([])
  })

  test('arm commits while a stale ordinary dev prompt is being persisted: refused, never sent', async () => {
    const open = parkPersist()
    const send = I.buildSend('dev macro with merge', 'tok', deps())
    const p = send(REQ()) // no proofRunId: an ordinary dev prompt that passed every earlier gate
    const settled = p.then(() => 'sent', (e: Error) => e.message)
    await tick()
    await D.armProofRunTx(armArgs()) // the arm lands in the window
    open()
    expect(await settled).toMatch(/^proof_send_refused:/)
    expect(sent).toEqual([])
  })

  test('control: an authentic proof prompt on a live run is delivered, behind the global lock', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    await D.enableProofTaskTx({ userId: 'u1' })
    sent.length = 0
    state.lockKeys.length = 0
    await I.buildSend('proof prompt', 'tok', deps())(REQ({ proofRunId: run.id, counterKey: run.counter_key }))
    expect(sent).toHaveLength(1)
    expect(state.lockKeys).toEqual([D.PROOF_LOCK_KEY])
  })

  test('flag OFF: delivery is unchanged and takes no lock (true no-op)', async () => {
    for (const k of FLAGS) delete process.env[k]
    sent.length = 0
    await I.buildSend('dev prompt', 'tok', deps())(REQ())
    expect(sent).toHaveLength(1)
    expect(state.lockCalls).toBe(0)
  })
})
