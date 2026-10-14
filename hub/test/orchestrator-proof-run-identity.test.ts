/**
 * PTYCAP-05 QC round 1 (codex #2/#3): a proof dispatch is authentic only when its server-only
 * proofRunId equals the ACTIVE run, checked at the gate AND again immediately before send.
 *
 *  (a) gate: an ordinary (dev) prompt carrying the reusable task:<id> key can never be authorized
 *  (b) pipeline: an ordinary dev prompt parked BEFORE the arm never reaches send on replay
 *  (c) final check: a run that goes terminal (disarm) after the gates stops the send
 *  (d) the proof gate list is recognised by the pipeline (name pin)
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createProofFakeSql } from './fixtures/proof-fake-sql.ts'

const fake = createProofFakeSql()
// only the kill-switch read is stubbed; every proof statement goes to the in-memory proof fake
const sql: any = (strings: TemplateStringsArray, ...values: any[]) =>
  strings.join('?').includes('automation_kill_switch') ? Promise.resolve([]) : fake.sql(strings, ...values)
sql.json = fake.sql.json
sql.begin = fake.sql.begin
mock.module('../src/db/postgres.ts', () => ({ sql }))

const stamp = Date.now()
const G = await import(`../src/orchestrator/proof-gates.ts?t=${stamp}`)
const P = await import(`../src/dispatch/pipeline.ts?t=${stamp}`)
const C = await import(`../src/dispatch/automation-controls.ts?t=${stamp}`)
const { getGraceBuffer } = await import("../src/dispatch/grace.ts")

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    process.env[k] = '1'
  }
  fake.state.runs = []
  fake.state.statements.length = 0
  fake.state.unknown.length = 0
  P._reset()
})
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  expect(fake.state.unknown).toEqual([])
})
afterAll(() => {
  mock.restore()
})

function runRow(over: Record<string, unknown> = {}): any {
  return {
    id: 'run-NEW', user_id: 'u1', task_id: 'T1', session_id: 's1', repo_ident: 'github://acme/proof',
    counter_key: 'task:T1', branch: 'proof/run-NEW', installation_id: 9, repo_owner: 'acme', repo_name: 'proof',
    default_branch: 'main', base_sha: 'a'.repeat(40), ruleset_ids: [1], ruleset_digest: 'd', ruleset_updated_at: null,
    protection_shape: 'branch_lock', required_contexts: ['ci'], arm_preconditions: {}, max_injects: 5, max_tokens: 1000,
    max_wall_ms: 60000, status: 'armed', outcome: null, outcome_detail: null, pr_url: null, pr_number: null,
    last_ci_state: null, last_inject_outcome: null, tokens_hwm: 0, armed_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z', started_at: null, terminal_at: null, ...over,
  }
}
const req = (over: Record<string, unknown> = {}): any => ({
  userId: 'u1', sessionId: 's1', token: 'tok', prompt: 'ordinary dev prompt', counterKey: 'task:T1', ...over,
})
const gateDeps = (findRun: () => Promise<any>): any => ({
  findRun,
  countInjects: async () => 0,
  sumTokens: async () => ({ tokens: 0, sessionExists: true }),
  recordTokens: async () => undefined,
  githubFor: () => ({}),
  reassert: async () => ({ ok: true }),
  now: () => Date.now(),
})

describe('(a) proofIdentityRefusal', () => {
  test('exact active-run match is authentic; ordinary / other-run / terminal are refused', () => {
    const run = runRow()
    expect(G.proofIdentityRefusal(run, req({ proofRunId: 'run-NEW' }))).toBeNull()
    expect(G.proofIdentityRefusal(run, req())).toBe('proof_run_mismatch')
    expect(G.proofIdentityRefusal(run, req({ proofRunId: 'run-OLD' }))).toBe('proof_run_mismatch')
    expect(G.proofIdentityRefusal(runRow({ status: 'disarmed' }), req({ proofRunId: 'run-NEW' }))).toMatch(/^proof_run_terminal/)
    expect(G.proofIdentityRefusal(null, req({ proofRunId: 'run-NEW' }))).toBe('proof_mode_non_proof_task')
  })

  test('the budget gate refuses an ordinary prompt carrying the proof task counter key', async () => {
    const gate = G.makeProofBudgetGate(gateDeps(async () => runRow({ status: 'running', started_at: new Date().toISOString() })))
    expect(await gate.check(req())).toEqual({ ok: false, reason: 'proof_run_mismatch' })
    expect(await gate.check(req({ proofRunId: 'run-NEW' }))).toEqual({ ok: true })
  })
})

describe('(b) an ordinary dev prompt parked before the arm never reaches send', () => {
  test('park (no run yet) -> arm creates the run -> grace drain replays through dispatch -> refused, send never called', async () => {
    let active: any = null // no proof run exists yet when the stale prompt is dispatched
    const proofGate = G.makeProofBudgetGate(gateDeps(async () => active))
    let online = false
    const sends: any[] = []
    const replays: any[] = []
    const deps: any = {
      // before the arm there is no proof run (the stack was not armed); after it the real gate decides
      gates: [{ name: 'proof_budget', check: (r: any) => (active ? proofGate.check(r) : Promise.resolve({ ok: true as const })) }],
      store: null,
      isOnline: () => online,
      replay: async (r: any) => {
        replays.push(await P.dispatch(r, deps))
      },
      send: async (r: any) => {
        sends.push(r)
      },
    }
    expect(await P.dispatch(req(), deps)).toEqual({ kind: 'parked_offline' })

    // the owner arms: a run now exists for the reused task; the session comes online; grace drains
    active = runRow({ status: 'running', started_at: new Date().toISOString() })
    online = true
    await getGraceBuffer().drain('s1')
    expect(replays).toEqual([{ kind: 'skipped', reason: 'proof_run_mismatch' }]) // the replay really ran, and was refused
    expect(sends).toHaveLength(0)

    // control: the genuine proof request carrying the active run id DOES reach send
    const ok = await P.dispatch(req({ token: 'tok2', proofRunId: 'run-NEW' }), deps)
    expect(ok.kind).toBe('dispatched')
    expect(sends).toHaveLength(1)
  })
})

describe('(c) finalHaltCheck re-checks the active proof run immediately before send', () => {
  test('active matching run -> ok; ordinary prompt -> refused; run terminal (disarm) after the gates -> refused', async () => {
    fake.state.runs = [runRow({ status: 'running' })]
    expect(await C.finalHaltCheck(req({ proofRunId: 'run-NEW' }), { proof: true })).toEqual({ ok: true })
    expect(await C.finalHaltCheck(req(), { proof: true })).toEqual({ ok: false, reason: 'proof_run_mismatch' })
    fake.state.runs[0].status = 'disarmed' // disarm committed after the gate list passed
    const r = await C.finalHaltCheck(req({ proofRunId: 'run-NEW' }), { proof: true })
    expect(r.ok).toBe(false)
    expect((r as any).reason).toMatch(/^proof_run_terminal/)
  })

  test('a non-proof list (no opts.proof) and the flag stack OFF are untouched', async () => {
    fake.state.runs = [runRow({ status: 'disarmed' })]
    expect(await C.finalHaltCheck(req())).toEqual({ ok: true })
    process.env.REMO_ORCHESTRATOR_PROOF = '0'
    fake.state.statements.length = 0
    expect(await C.finalHaltCheck(req(), { proof: true })).toEqual({ ok: true })
    expect(fake.state.statements.filter((t) => t.includes('orchestrator_proof_runs'))).toHaveLength(0)
  })
})

describe('(d) wiring pins', () => {
  test('the pipeline recognises the proof gate list by the proof budget gate name', () => {
    expect(P.PROOF_BUDGET_GATE_LIST_NAME).toBe(G.PROOF_BUDGET_GATE_NAME)
  })
})
