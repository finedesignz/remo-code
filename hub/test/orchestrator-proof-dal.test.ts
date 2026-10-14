/**
 * PTYCAP-05: orchestrator-proof-dal + sumSessionTokensSince over a fake sql (DB-free).
 * Real SQL is proven against Postgres by plan 05-08. Every test asserts the fake
 * recognised every statement (state.unknown empty).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createProofFakeSql } from './fixtures/proof-fake-sql.ts'

const fake = createProofFakeSql()
const { state } = fake

mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))

const stamp = Date.now()
const D = await import(`../src/db/orchestrator-proof-dal.ts?t=${stamp}`)
const T = await import(`../src/db/token-usage-dal.ts?t=${stamp}`)

beforeEach(() => {
  state.runs = []
  state.tasks = []
  state.rows = []
  state.allow = []
  state.kill = []
  state.queue = []
  state.ledger = []
  state.tokenUsage = []
  state.messages = []
  state.sessions = new Set()
  state.failOn = null
  state.statements.length = 0
  state.unknown.length = 0
  state.beginCalls = 0
  state.lockCalls = 0
  state.lockKeys.length = 0
})
afterEach(() => {
  expect(state.unknown).toEqual([]) // the fake recognised every statement
})
afterAll(() => {
  mock.restore()
})

const REPO = 'github://acme/proof'
const armArgs = (over: Record<string, unknown> = {}): any => ({
  userId: 'u1',
  sessionId: 's1',
  repoIdent: REPO,
  installationId: 99,
  repoOwner: 'acme',
  repoName: 'proof',
  defaultBranch: 'main',
  baseSha: 'a'.repeat(40),
  rulesetIds: [7],
  rulesetDigest: 'dig',
  rulesetUpdatedAt: null,
  protectionShape: 'update_restriction',
  requiredContexts: ['ci'],
  armPreconditions: { ok: true },
  maxInjects: 5,
  maxTokens: 1_000_000,
  maxWallMs: 3_600_000,
  scheduleRule: { interval: 5, unit: 'minutes', start_at: '2026-10-13T00:00:00Z' },
  ...over,
})

describe('canonical repo identity (codex #6)', () => {
  test('a mixed-case ident is stored canonical in the allowlist and the proof row', async () => {
    const { run } = await D.armProofRunTx(armArgs({ repoIdent: 'github://Acme/PROOF' }))
    expect(run.repo_ident).toBe('github://acme/proof')
    expect(state.allow).toEqual([{ user_id: 'u1', repo_ident: 'github://acme/proof' }])
  })

  test('the mixed-case twin of an existing allowlist row is the same repo (no other_repo_allowlisted)', async () => {
    state.allow = [{ user_id: 'u1', repo_ident: 'github://Acme/Proof' }]
    await D.armProofRunTx(armArgs())
    expect(state.runs).toHaveLength(1)
  })

  test('merge-refusal lookup finds the active run through any casing of the repo key', async () => {
    const { run } = await D.armProofRunTx(armArgs({ repoIdent: 'Github://ACME/Proof'.replace('Github', 'github') }))
    expect((await D.findActiveProofRunForRepo('github://ACME/proof'))?.id).toBe(run.id)
    expect(await D.findActiveProofRunForRepo('github://acme/other')).toBeNull()
    expect(await D.findActiveProofRunForRepo('path:///tmp/x')).toBeNull()
  })

  test('a non github://owner/repo ident cannot be armed', async () => {
    await expect(D.armProofRunTx(armArgs({ repoIdent: 'path:///tmp/x' }))).rejects.toThrow('repo_ident_not_canonical')
    expect(state.runs).toHaveLength(0)
  })
})

describe('armProofRunTx', () => {
  test('one begin; first statement is the advisory lock; creates disabled dev task, row, allowlist, frozen run', async () => {
    const { run, taskId } = await D.armProofRunTx(armArgs())
    expect(state.beginCalls).toBe(1)
    expect(state.lockCalls).toBe(1)
    expect(state.statements[0]).toContain('pg_advisory_xact_lock')
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: taskId, enabled: false, macro_task_type: 'dev', task_type: 'orchestrator' })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ task_id: taskId, command: 'proof', enabled: true })
    expect(state.allow).toEqual([{ user_id: 'u1', repo_ident: REPO }])
    expect(state.runs).toHaveLength(1)
    expect(run.counter_key).toBe(`task:${taskId}`)
    expect(run.branch).toBe(`proof/${run.id}`)
    expect(run.status).toBe('armed')
    expect(run).toMatchObject({ max_injects: 5, max_tokens: 1_000_000, max_wall_ms: 3_600_000, base_sha: 'a'.repeat(40) })
  })

  test('QC r1: arm marks the task proof_owned (created AND reused) so the dev macro is refused for it under any flag combination', async () => {
    const { taskId } = await D.armProofRunTx(armArgs())
    expect(state.tasks.find((t) => t.id === taskId)?.proof_owned).toBe(true)
    state.runs = []
    state.tasks = [{ id: 'old', user_id: 'u1', session_id: 's1', task_type: 'orchestrator', enabled: true, macro_task_type: 'maintenance' }]
    await D.armProofRunTx(armArgs())
    expect(state.tasks[0].proof_owned).toBe(true)
  })

  test('converts an existing orchestrator task for the session, forcing it disabled', async () => {
    state.tasks.push({ id: 'old', user_id: 'u1', session_id: 's1', task_type: 'orchestrator', enabled: true, macro_task_type: 'maintenance' })
    const { taskId } = await D.armProofRunTx(armArgs())
    expect(taskId).toBe('old')
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ enabled: false, macro_task_type: 'dev' })
  })

  test('another repo already allowlisted for the user -> other_repo_allowlisted, nothing written', async () => {
    state.allow.push({ user_id: 'u1', repo_ident: 'github://acme/other' })
    await expect(D.armProofRunTx(armArgs())).rejects.toMatchObject({ code: 'other_repo_allowlisted' })
    expect(state.runs).toHaveLength(0)
    expect(state.tasks).toHaveLength(0)
    expect(state.allow).toHaveLength(1)
  })

  test('QC r1 exclusivity: ANY other enabled orchestrator task (any user) refuses arm and rolls back', async () => {
    state.tasks.push({ id: 'foreign', user_id: 'someone-else', session_id: 'sx', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    await expect(D.armProofRunTx(armArgs())).rejects.toMatchObject({ code: 'other_orchestrator_task_enabled' })
    expect(state.runs).toHaveLength(0)
    expect(state.rows).toHaveLength(0)
    expect(state.allow).toHaveLength(0)
    expect(state.tasks).toHaveLength(1) // only the foreign one; the created proof task rolled back
  })

  test('QC r1 exclusivity: the reused session task itself does not count; a disabled other task does not count', async () => {
    state.tasks.push({ id: 'old', user_id: 'u1', session_id: 's1', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    state.tasks.push({ id: 'off', user_id: 'u2', session_id: 's9', task_type: 'orchestrator', enabled: false, macro_task_type: 'dev' })
    const { taskId } = await D.armProofRunTx(armArgs())
    expect(taskId).toBe('old')
  })

  test('QC r1 exclusivity: countOtherEnabledOrchestratorTasks (dry-run read) matches the in-tx rule', async () => {
    state.tasks.push({ id: 'old', user_id: 'u1', session_id: 's1', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    expect(await D.countOtherEnabledOrchestratorTasks({ userId: 'u1', sessionId: 's1' })).toBe(0)
    state.tasks.push({ id: 'f', user_id: 'u2', session_id: 's2', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    expect(await D.countOtherEnabledOrchestratorTasks({ userId: 'u1', sessionId: 's1' })).toBe(1)
  })

  test('the target repo already allowlisted is fine (exactly the target)', async () => {
    state.allow.push({ user_id: 'u1', repo_ident: REPO })
    await D.armProofRunTx(armArgs())
    expect(state.allow).toHaveLength(1)
  })

  test('an active run exists for the user -> proof_already_active', async () => {
    await D.armProofRunTx(armArgs())
    await expect(D.armProofRunTx(armArgs({ sessionId: 's2' }))).rejects.toMatchObject({ code: 'proof_already_active' })
    expect(state.runs).toHaveLength(1)
  })

  test('a unique violation from the partial indexes maps to proof_already_active', async () => {
    // simulate the race: the recheck inside the lock saw nothing but the index still rejects
    state.runs.push({ id: 'x', user_id: 'someone-else', task_id: 'tx', repo_ident: REPO, status: 'running' })
    await expect(D.armProofRunTx(armArgs())).rejects.toMatchObject({ code: 'proof_already_active' })
    expect(state.tasks).toHaveLength(0) // rolled back
    expect(state.rows).toHaveLength(0)
    expect(state.allow).toHaveLength(0)
  })

  test('a thrown insert rolls back everything (no partial rows)', async () => {
    state.failOn = (t) => t.includes('INSERT INTO orchestrator_proof_runs')
    await expect(D.armProofRunTx(armArgs())).rejects.toThrow('fake_sql_failure')
    expect(state.tasks).toHaveLength(0)
    expect(state.rows).toHaveLength(0)
    expect(state.allow).toHaveLength(0)
    expect(state.runs).toHaveLength(0)
  })
})

describe('disarmProofRunTx', () => {
  test('one begin; ends the run disarmed (no outcome), disables task+row, deletes ONLY the exact allowlist row', async () => {
    const { taskId } = await D.armProofRunTx(armArgs())
    state.allow.push({ user_id: 'u1', repo_ident: 'github://acme/keep' })
    state.beginCalls = 0
    const r = await D.disarmProofRunTx({ userId: 'u1' })
    expect(state.beginCalls).toBe(1)
    expect(state.statements.slice(-4).some((s) => s.includes('pg_advisory_xact_lock')) || state.lockCalls >= 1).toBe(true)
    expect(r.disarmed).toBe(true)
    expect(state.runs[0]).toMatchObject({ status: 'disarmed', outcome: null })
    expect(state.tasks.find((t) => t.id === taskId)?.enabled).toBe(false)
    expect(state.rows.find((x) => x.task_id === taskId)?.enabled).toBe(false)
    expect(state.allow).toEqual([{ user_id: 'u1', repo_ident: 'github://acme/keep' }])
  })

  test('the allowlist DELETE names both user_id and repo_ident in its WHERE', async () => {
    await D.armProofRunTx(armArgs())
    await D.disarmProofRunTx({ userId: 'u1' })
    const del = state.statements.find((s) => s.includes('DELETE FROM orchestrator_autospawn_allowlist'))!
    expect(del).toMatch(/WHERE user_id = \? AND lower\(repo_ident\) = \?/)
  })

  test('idempotent when nothing is active', async () => {
    expect(await D.disarmProofRunTx({ userId: 'u1' })).toEqual({ disarmed: false })
    await D.armProofRunTx(armArgs())
    await D.disarmProofRunTx({ userId: 'u1' })
    expect(await D.disarmProofRunTx({ userId: 'u1' })).toEqual({ disarmed: false })
  })
})

describe('QC r1 arm halts the session and cancels pending cycles; enable releases the halt', () => {
  test('arm engages the session kill switch and cancels ONLY pending routine cycles of that session', async () => {
    state.queue.push({ session_id: 's1', status: 'pending' }, { session_id: 's1', status: 'running' }, { session_id: 'other', status: 'pending' })
    await D.armProofRunTx(armArgs())
    expect(state.kill).toEqual([expect.objectContaining({ scope: 'session', session_id: 's1', engaged: true })])
    expect(state.queue.map((q) => q.status)).toEqual(['cancelled', 'running', 'pending'])
  })

  test('a refused arm engages nothing (rolled back)', async () => {
    state.tasks.push({ id: 'foreign', user_id: 'x', session_id: 'sx', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    await expect(D.armProofRunTx(armArgs())).rejects.toMatchObject({ code: 'other_orchestrator_task_enabled' })
    expect(state.kill).toEqual([])
  })

  test('enable releases the session halt of the armed run', async () => {
    await D.armProofRunTx(armArgs())
    expect(state.kill[0].engaged).toBe(true)
    await D.enableProofTaskTx({ userId: 'u1' })
    expect(state.kill[0].engaged).toBe(false)
  })
})

describe('QC r2 kill-switch ownership (codex new #2, sonnet MINOR 1)', () => {
  const foreign = (over: Record<string, unknown> = {}): any => ({ id: 'k-manual', engaged_by: 'owner-user', scope: 'session', user_id: 'u1', session_id: 's1', reason: 'manual stop', engaged: true, ...over })

  test('arm refuses a foreign engaged session halt and leaves it engaged', async () => {
    state.kill.push(foreign())
    await expect(D.armProofRunTx(armArgs())).rejects.toMatchObject({ code: 'session_halt_engaged' })
    expect(state.kill).toEqual([expect.objectContaining({ id: 'k-manual', engaged: true })])
    expect(state.runs).toEqual([])
  })

  test('arm records the exact kill row id it engaged on the run', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    const engaged = state.kill.filter((k) => k.engaged)
    expect(engaged).toHaveLength(1)
    expect(run.kill_switch_id).toBe(engaged[0].id)
    expect(engaged[0].engaged_by).toBe('arm-orchestrator-proof')
  })

  test('enable releases ONLY the proof-owned row: a halt engaged after arm by someone else survives', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    // the owner releases the proof halt and engages their own emergency stop on the same session
    for (const k of state.kill) k.engaged = false
    state.kill.push(foreign({ id: 'k-late' }))
    await D.enableProofTaskTx({ userId: 'u1' })
    expect(state.kill.find((k) => k.id === 'k-late')?.engaged).toBe(true)
    expect(state.kill.find((k) => k.id === run.kill_switch_id)?.engaged).toBe(false)
  })

  test('a stale halt the proof tooling left on the session is released at arm and replaced by the run own row', async () => {
    state.kill.push(foreign({ id: 'k-stale', engaged_by: 'proof-guard' }))
    const { run } = await D.armProofRunTx(armArgs())
    expect(state.kill.find((k) => k.id === 'k-stale')?.engaged).toBe(false)
    expect(state.kill.find((k) => k.id === run.kill_switch_id)?.engaged).toBe(true)
  })
})

describe('QC r2 disarm removes the canonical allowlist row and any case-variant twin (sonnet MINOR 3)', () => {
  test('mixed-case twin of the armed repo does not survive disarm; another repo row is untouched', async () => {
    state.allow.push({ user_id: 'u1', repo_ident: 'github://Acme/Proof' })
    await D.armProofRunTx(armArgs())
    expect(state.allow.map((a) => a.repo_ident).sort()).toEqual(['github://Acme/Proof', 'github://acme/proof'])
    state.allow.push({ user_id: 'u1', repo_ident: 'github://acme/other' })
    await D.disarmProofRunTx({ userId: 'u1' })
    expect(state.allow.map((a) => a.repo_ident)).toEqual(['github://acme/other'])
  })
})

describe('enableProofTaskTx', () => {
  test('one begin; enables the task of an armed run', async () => {
    const { taskId } = await D.armProofRunTx(armArgs())
    state.beginCalls = 0
    const r = await D.enableProofTaskTx({ userId: 'u1' })
    expect(state.beginCalls).toBe(1)
    expect(r.run.id).toBeTruthy()
    expect(state.tasks.find((t) => t.id === taskId)?.enabled).toBe(true)
  })

  test('QC r1 exclusivity: enable refuses while any other orchestrator task is enabled', async () => {
    const { taskId } = await D.armProofRunTx(armArgs())
    state.tasks.push({ id: 'late', user_id: 'u3', session_id: 's7', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    await expect(D.enableProofTaskTx({ userId: 'u1' })).rejects.toMatchObject({ code: 'other_orchestrator_task_enabled' })
    expect(state.tasks.find((t) => t.id === taskId)?.enabled).toBe(false)
  })

  test('refuses unless the run is armed (proof_not_armed)', async () => {
    await expect(D.enableProofTaskTx({ userId: 'u1' })).rejects.toMatchObject({ code: 'proof_not_armed' })
    const { taskId } = await D.armProofRunTx(armArgs())
    await D.claimActiveProofRunForTask(taskId) // armed -> running
    await expect(D.enableProofTaskTx({ userId: 'u1' })).rejects.toMatchObject({ code: 'proof_not_armed' })
  })
})

describe('QC r2 global exclusivity: one hub-global lock serializes arm/enable across users (codex new #1)', () => {
  test('two different users enabling concurrently: exactly one wins, the other is refused', async () => {
    await D.armProofRunTx(armArgs())
    await D.armProofRunTx(armArgs({ userId: 'u2', sessionId: 's2', repoIdent: 'github://acme/proof2' }))
    const results = await Promise.allSettled([D.enableProofTaskTx({ userId: 'u1' }), D.enableProofTaskTx({ userId: 'u2' })])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(loser.reason).toMatchObject({ code: 'other_orchestrator_task_enabled' })
    expect(state.tasks.filter((t) => t.task_type === 'orchestrator' && t.enabled)).toHaveLength(1)
  })

  test('arm, disarm and enable all take the SAME global lock key', async () => {
    await D.armProofRunTx(armArgs())
    await D.enableProofTaskTx({ userId: 'u1' })
    await D.disarmProofRunTx({ userId: 'u1' })
    expect(state.lockCalls).toBe(3)
    expect(state.lockKeys).toEqual([D.PROOF_LOCK_KEY, D.PROOF_LOCK_KEY, D.PROOF_LOCK_KEY])
  })
})

describe('claim / terminalize (tracer subset)', () => {
  test('claim flips armed->running once and returns the snapshot; none -> null', async () => {
    const { taskId, run } = await D.armProofRunTx(armArgs())
    const c = await D.claimActiveProofRunForTask(taskId)
    expect(c.id).toBe(run.id)
    expect(c.status).toBe('running')
    expect(await D.claimActiveProofRunForTask('nope')).toBeNull()
    expect(await D.taskHasAnyProofRun(taskId)).toBe(true)
    expect(await D.taskHasAnyProofRun('nope')).toBe(false)
  })

  test('terminalize is single-winner', async () => {
    const { run, taskId } = await D.armProofRunTx(armArgs())
    const first = await D.terminalizeProofRun({ runId: run.id, outcome: 'nothing:agent_declined', detail: 'no' })
    expect(first.status).toBe('nothing')
    expect(await D.terminalizeProofRun({ runId: run.id, outcome: 'pr_open_green', detail: 'late' })).toBeNull()
    expect(state.runs[0].outcome).toBe('nothing:agent_declined')
    expect(await D.terminalizeActiveProofRunForTask({ taskId, outcome: 'nothing:guard_error', detail: 'x' })).toBeNull()
  })

  test('disableProofTask disables only an orchestrator task of that user', async () => {
    state.tasks.push({ id: 'a', user_id: 'u1', session_id: 's', task_type: 'orchestrator', enabled: true, macro_task_type: 'dev' })
    state.tasks.push({ id: 'b', user_id: 'u1', session_id: 's', task_type: 'agent', enabled: true, macro_task_type: 'dev' })
    await D.disableProofTask('u1', 'a')
    await D.disableProofTask('u1', 'b')
    expect(state.tasks.map((t) => t.enabled)).toEqual([false, true])
  })
})

describe('reads, counters, observation', () => {
  test('findProofRunForRequest: counter_key (any status) first, else the ACTIVE run for the session', async () => {
    const { run, taskId } = await D.armProofRunTx(armArgs())
    expect((await D.findProofRunForRequest({ requestKey: `task:${taskId}`, sessionId: 'zzz' })).id).toBe(run.id)
    expect((await D.findProofRunForRequest({ requestKey: 'task:other', sessionId: 's1' })).id).toBe(run.id)
    await D.terminalizeProofRun({ runId: run.id, outcome: 'nothing:agent_declined', detail: 'x' })
    expect((await D.findProofRunForRequest({ requestKey: `task:${taskId}` })).status).toBe('nothing') // terminal, by key
    expect(await D.findProofRunForRequest({ requestKey: 'task:other', sessionId: 's1' })).toBeNull() // terminal, by session
    expect(await D.findProofRunForRequest({})).toBeNull()
  })

  test('findActiveProofRunForRepo: active only', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    expect((await D.findActiveProofRunForRepo(REPO)).id).toBe(run.id)
    await D.disarmProofRunTx({ userId: 'u1' })
    expect(await D.findActiveProofRunForRepo(REPO)).toBeNull()
  })

  test('countProofInjects counts live ledger injects for the key since the cutoff', async () => {
    const since = new Date(1000)
    state.ledger.push(
      { counter_key: 'task:t', kind: 'inject', released_at: null, created_at: 2000 },
      { counter_key: 'task:t', kind: 'inject', released_at: null, created_at: 500 }, // before cutoff
      { counter_key: 'task:t', kind: 'inject', released_at: 3000, created_at: 2000 }, // released
      { counter_key: 'task:t', kind: 'page', released_at: null, created_at: 2000 }, // not an inject
      { counter_key: 'task:other', kind: 'inject', released_at: null, created_at: 2000 },
    )
    expect(await D.countProofInjects('task:t', since)).toBe(1)
  })

  test('recordProofObservation: tokens_hwm is monotone and only while active', async () => {
    const { run } = await D.armProofRunTx(armArgs())
    await D.recordProofObservation(run.id, { tokens: 500, pr_url: 'https://x/pr/1', pr_number: 1, last_ci_state: 'green' })
    await D.recordProofObservation(run.id, { tokens: 100, last_inject_outcome: 'dispatched' })
    expect(Number(state.runs[0].tokens_hwm)).toBe(500)
    expect(state.runs[0]).toMatchObject({ pr_url: 'https://x/pr/1', pr_number: 1, last_ci_state: 'green', last_inject_outcome: 'dispatched' })
    await D.terminalizeProofRun({ runId: run.id, outcome: 'terminated:budget_wall', detail: 'x' })
    expect(await D.recordProofObservation(run.id, { tokens: 9999 })).toBeNull()
    expect(Number(state.runs[0].tokens_hwm)).toBe(500)
  })

  test('listProofRunsForUser: newest first, scoped by user', async () => {
    state.runs.push(
      { id: 'a', user_id: 'u1', status: 'nothing' },
      { id: 'b', user_id: 'u2', status: 'nothing' },
      { id: 'c', user_id: 'u1', status: 'armed' },
    )
    expect((await D.listProofRunsForUser('u1', 10)).map((r: any) => r.id)).toEqual(['c', 'a'])
    expect(await D.listProofRunsForUser('u1', 1)).toHaveLength(1)
  })
})

describe('sumSessionTokensSince (F2-3 attribution)', () => {
  test('sums all four buckets (modelled as tokens) since the cutoff and reports the session exists', async () => {
    state.sessions.add('s1')
    state.tokenUsage.push({ session_id: 's1', tokens: 100, created_at: 2000 }, { session_id: 's1', tokens: 5, created_at: 10 }, { session_id: 's2', tokens: 7, created_at: 2000 })
    expect(await T.sumSessionTokensSince('s1', new Date(1000))).toEqual({ tokens: 100, sessionExists: true })
  })

  describe('QC r2 durable attribution: completed turns vs ledger rows (codex #4)', () => {
    const OLD = 2000 // created_at well before now - 120s
    const turn = (over: Record<string, unknown> = {}) => ({ session_id: 's1', role: 'assistant', status: 'complete', created_at: OLD, ...over })

    test('a completed turn with no token_usage row is attribution lost, with NO in-process mark (survives restart/eviction)', async () => {
      const L = await import('../src/usage/attribution-loss.ts')
      L.resetUsageAttributionLoss() // a restarted hub: nothing remembered
      state.sessions.add('s1')
      state.messages.push(turn(), turn({ created_at: OLD + 1 }))
      state.tokenUsage.push({ session_id: 's1', tokens: 10, created_at: OLD }) // 2 turns, 1 ledger row
      expect(await T.sumSessionTokensSince('s1', new Date(1000))).toEqual({ tokens: 10, sessionExists: true, attributionLost: true })
    })

    test('every completed turn has a ledger row: not lost', async () => {
      state.sessions.add('s1')
      state.messages.push(turn(), turn({ created_at: OLD + 1 }))
      state.tokenUsage.push({ session_id: 's1', tokens: 10, created_at: OLD }, { session_id: 's1', tokens: 10, created_at: OLD + 1 })
      expect(await T.sumSessionTokensSince('s1', new Date(1000))).toEqual({ tokens: 20, sessionExists: true })
    })

    test('a turn still inside the grace window, a streaming placeholder, a user message, another session and a pre-arm turn are not losses', async () => {
      state.sessions.add('s1')
      state.messages.push(
        turn({ created_at: Date.now() }), // in flight, inside grace
        turn({ status: 'streaming' }),
        turn({ role: 'user' }),
        turn({ session_id: 's2' }),
        turn({ created_at: 10 }), // before the arm
      )
      expect(await T.sumSessionTokensSince('s1', new Date(1000))).toEqual({ tokens: 0, sessionExists: true })
    })
  })

  test('a deleted session reports sessionExists=false so callers fail closed', async () => {
    state.tokenUsage.push({ session_id: null, tokens: 100, created_at: 2000 })
    expect(await T.sumSessionTokensSince('gone', new Date(1000))).toEqual({ tokens: 0, sessionExists: false })
  })

  test('the SQL sums the four buckets', async () => {
    await T.sumSessionTokensSince('s1', new Date(0))
    const s = state.statements.find((x) => x.includes('EXISTS (SELECT 1 FROM sessions'))!
    for (const col of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      expect(s).toContain(col)
    }
  })
})
