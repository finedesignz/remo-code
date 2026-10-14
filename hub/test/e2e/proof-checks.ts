// hub/test/e2e/proof-checks.ts
// PTYCAP-05 - REAL-POSTGRES proof of the throwaway-repo proof SQL.
//
// This is NOT a test file (no test()/it()/describe() call, never collected by `bun test`).
// It is a plain helper awaited from the BODY of one existing DB-gated e2e test
// (orchestrator-autospawn.e2e.test.ts, the first test), so it runs in Woodpecker's qc
// pipeline (postgres:16, REMO_E2E_DB_URL) and adds ZERO tests and ZERO skips. There is no
// local Postgres on the dev host: locally the enclosing describe is skipped and this never
// executes (it must still type-check and import cleanly).
//
// What the DB-free tests cannot prove and this does (verdict F2-1..F2-4):
//   1. the PTYCAP-05 DDL applies twice cleanly; 6 named CHECKs + 3 partial unique indexes exist,
//   2. single-flight under REAL concurrency (5 parallel arms -> exactly 1 wins),
//   3. the partial unique indexes reject a 2nd active proof per user / repo / task,
//   4. the CHECK constraints (budgets > 0, status set, terminal_at coupling),
//   5. claim is idempotent; terminalize is exactly-once under 10 parallel callers,
//   6. token attribution survives session deletion (sessionExists=false, hwm monotone),
//   7. the budget gate on the real ledger blocks at max_injects and not before,
//   8. disarm removes ONLY the exact (user_id, repo_ident) allowlist row.
//
// SAFETY: the harness refuses a production DSN (assertNonProdDsn) before this is ever
// reached. Everything created here uses its OWN synthetic users and a unique prefix, and is
// removed in a finally block by exact id / prefix. The harness user is only observed.
import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type ProofDal = typeof import('../../src/db/orchestrator-proof-dal.ts')
type ProofGates = typeof import('../../src/orchestrator/proof-gates.ts')
type TokenDal = typeof import('../../src/db/token-usage-dal.ts')
type Controls = typeof import('../../src/dispatch/automation-controls.ts')

export interface ProofChecksArgs {
  /** Private harness client bound to REMO_E2E_DB_URL (same database the hub's shared sql uses). */
  sql: any
  /** Harness user: only OBSERVED (its allowlist rows must be untouched), never mutated. */
  userId: string
  sessionId: string
}

const ENV_KEYS = [
  'REMO_ORCHESTRATOR_PROOF',
  'REMO_ORCHESTRATOR_ENABLED',
  'REMO_ORCHESTRATOR_AUTOSPAWN',
  'REMO_AUTOMATION_LIFETIME_INJECT_CAP',
  'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR',
  'REMO_AUTOMATION_KILL_SWITCH',
]

const SCHEMA_PATH = resolve(import.meta.dir, '../../src/db/schema.sql')
const CONSTRAINTS = [
  'orchestrator_proof_runs_status_check',
  'orchestrator_proof_runs_max_injects_check',
  'orchestrator_proof_runs_max_tokens_check',
  'orchestrator_proof_runs_max_wall_ms_check',
  'orchestrator_proof_runs_tokens_hwm_check',
  'orchestrator_proof_runs_terminal_at_check',
]
const INDEXES = [
  'idx_orchestrator_proof_runs_active_user',
  'idx_orchestrator_proof_runs_active_repo',
  'idx_orchestrator_proof_runs_active_task',
]

/** SQLSTATE of a rejected promise, or 'NO_ERROR' when it resolved. */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return 'NO_ERROR'
  } catch (err: any) {
    return err?.code
  }
}

export async function runProofChecks(a: ProofChecksArgs): Promise<void> {
  const { sql } = a
  const P = `e2e-pc-${randomUUID().slice(0, 8)}`
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  delete process.env.REMO_AUTOMATION_KILL_SWITCH

  const dal: ProofDal = await import('../../src/db/orchestrator-proof-dal.ts')
  const gates: ProofGates = await import('../../src/orchestrator/proof-gates.ts')
  const tokenDal: TokenDal = await import('../../src/db/token-usage-dal.ts')
  const controls: Controls = await import('../../src/dispatch/automation-controls.ts')

  const createdUsers: string[] = []
  const createdSessions: string[] = []
  const counterKeys: string[] = []

  const harnessAllowBefore = (await sql`
    SELECT repo_ident FROM orchestrator_autospawn_allowlist WHERE user_id = ${a.userId} ORDER BY repo_ident
  `).map((r: any) => r.repo_ident)

  const newUser = async (tag: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`${P}-${tag}@invalid.local`}, 'x', 'user') RETURNING id`
    createdUsers.push(rows[0].id)
    return rows[0].id
  }
  const newSession = async (userId: string): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, ${P}, ${`/tmp/${P}-${randomUUID()}`}, ${'th-' + randomUUID()}) RETURNING id`
    createdSessions.push(rows[0].id)
    return rows[0].id
  }
  const frozen = (over: Record<string, unknown> = {}) => ({
    installationId: 4242,
    repoOwner: 'acme',
    repoName: 'proof',
    defaultBranch: 'main',
    baseSha: 'a'.repeat(40),
    rulesetIds: [1],
    rulesetDigest: `${P}-digest`,
    rulesetUpdatedAt: new Date().toISOString(),
    protectionShape: 'required_checks',
    requiredContexts: ['ci'],
    armPreconditions: {},
    maxInjects: 5,
    maxTokens: 1_000_000,
    maxWallMs: 600_000,
    ...over,
  })
  const scheduleRule = () => ({ interval: 5, unit: 'minutes', start_at: new Date().toISOString() })
  const arm = (userId: string, sessionId: string, repoIdent: string, over: Record<string, unknown> = {}) =>
    dal.armProofRunTx({ userId, sessionId, repoIdent, scheduleRule: scheduleRule(), ...frozen(over) } as any)

  let rawN = 0
  /** Raw INSERT bypassing the DAL (constraint probes). */
  const rawRun = (o: {
    user: string
    task: string
    repo: string
    status?: string
    session?: string
    maxInjects?: number
    maxTokens?: number
    maxWallMs?: number
    terminalAt?: Date | null
    startedAt?: Date | null
  }) => {
    const ck = `${P}:raw:${++rawN}`
    counterKeys.push(ck)
    return sql`
      INSERT INTO orchestrator_proof_runs (
        user_id, task_id, session_id, repo_ident, counter_key, branch, installation_id,
        repo_owner, repo_name, default_branch, base_sha, ruleset_digest, protection_shape,
        max_injects, max_tokens, max_wall_ms, status, terminal_at, started_at
      ) VALUES (
        ${o.user}, ${o.task}, ${o.session ?? `${P}-s-${rawN}`}, ${o.repo}, ${ck}, ${'proof/' + ck}, 1,
        'acme', 'proof', 'main', ${'b'.repeat(40)}, 'd', 'required_checks',
        ${o.maxInjects ?? 5}, ${o.maxTokens ?? 1000}, ${o.maxWallMs ?? 1000}, ${o.status ?? 'armed'},
        ${o.terminalAt ?? null}, ${o.startedAt ?? null}
      )`
  }
  const rowOf = async (id: string) =>
    (await sql`SELECT * FROM orchestrator_proof_runs WHERE id = ${id}`)[0] as any

  try {
    const userA = await newUser('a')
    const userB = await newUser('b')
    const userC = await newUser('c')
    const userE = await newUser('e')
    const sessA = await newSession(userA)
    const sessB = await newSession(userB)
    const repoA = `github://acme/${P}-a`
    const repoA2 = `github://acme/${P}-a2`

    // ── 1. Schema: PTYCAP-05 DDL re-applies cleanly; constraints + indexes exist ─────────
    const ddl = readFileSync(SCHEMA_PATH, 'utf-8')
    const start = ddl.indexOf('-- ── PTYCAP-05')
    const endMarker = 'ON orchestrator_proof_runs(session_id);'
    const end = ddl.indexOf(endMarker, start) + endMarker.length
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start + endMarker.length)
    const block = ddl.slice(start, end)
    await sql.unsafe(block) // second apply (harness already applied it once)
    await sql.unsafe(block) // third apply: idempotent, no error
    const cons = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'orchestrator_proof_runs'::regclass AND conname::text = ANY(${CONSTRAINTS}::text[])`
    expect(cons.map((r: any) => r.conname).sort()).toEqual([...CONSTRAINTS].sort())
    const idx = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'orchestrator_proof_runs' AND indexname::text = ANY(${INDEXES}::text[])`
    expect(idx.map((r: any) => r.indexname).sort()).toEqual([...INDEXES].sort())
    expect(idx.every((r: any) => /UNIQUE/i.test(r.indexdef) && /WHERE/i.test(r.indexdef))).toBe(true)

    // ── 2. Single-flight under concurrency: 5 parallel arms, exactly 1 wins ──────────────
    const arms = await Promise.allSettled(Array.from({ length: 5 }, () => arm(userA, sessA, repoA)))
    const won = arms.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ run: any; taskId: string }>[]
    const lost = arms.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(won.length).toBe(1)
    expect(lost.length).toBe(4)
    expect(lost.every((r) => (r.reason as any)?.code === 'proof_already_active')).toBe(true)
    const runA = won[0].value.run
    const taskA = won[0].value.taskId
    counterKeys.push(runA.counter_key)
    expect(runA.counter_key).toBe(`task:${taskA}`)
    expect(runA.status).toBe('armed')
    const allowA = await sql`SELECT repo_ident FROM orchestrator_autospawn_allowlist WHERE user_id = ${userA}`
    expect(allowA.map((r: any) => r.repo_ident)).toEqual([repoA])
    const activeA = await sql`
      SELECT id FROM orchestrator_proof_runs WHERE user_id = ${userA} AND status IN ('armed','running')`
    expect(activeA.map((r: any) => r.id)).toEqual([runA.id])

    // ── 3. DB-level uniqueness (raw INSERTs bypass the DAL) ──────────────────────────────
    // second active per USER (new task, new repo)
    expect(await pgCode(rawRun({ user: userA, task: `${P}-t1`, repo: `github://acme/${P}-x1` }))).toBe('23505')
    // second active per REPO (other user, new task)
    expect(await pgCode(rawRun({ user: userB, task: `${P}-t2`, repo: repoA }))).toBe('23505')
    // second active per TASK (other user, new repo)
    expect(await pgCode(rawRun({ user: userB, task: taskA, repo: `github://acme/${P}-x3` }))).toBe('23505')
    // the same shapes with a TERMINAL status are accepted
    const now = new Date()
    expect(
      await pgCode(rawRun({ user: userA, task: `${P}-t1`, repo: `github://acme/${P}-x1`, status: 'terminated', terminalAt: now })),
    ).toBe('NO_ERROR')
    expect(await pgCode(rawRun({ user: userB, task: `${P}-t2`, repo: repoA, status: 'nothing', terminalAt: now }))).toBe('NO_ERROR')
    expect(
      await pgCode(rawRun({ user: userB, task: taskA, repo: `github://acme/${P}-x3`, status: 'disarmed', terminalAt: now })),
    ).toBe('NO_ERROR')

    // ── 4. CHECK constraints ─────────────────────────────────────────────────────────────
    const c = (o: Partial<Parameters<typeof rawRun>[0]>, n: string) =>
      pgCode(rawRun({ user: userC, task: `${P}-c${n}`, repo: `github://acme/${P}-c${n}`, ...o }))
    expect(await c({ maxInjects: 0 }, '1')).toBe('23514')
    expect(await c({ maxTokens: -1 }, '2')).toBe('23514')
    expect(await c({ maxWallMs: 0 }, '3')).toBe('23514')
    expect(await c({ status: 'bogus' }, '4')).toBe('23514')
    expect(await c({ status: 'armed', terminalAt: new Date() }, '5')).toBe('23514')
    expect((await sql`SELECT 1 FROM orchestrator_proof_runs WHERE user_id = ${userC}`).length).toBe(0)

    // ── 5. Claim idempotent; terminalize exactly-once under concurrency ──────────────────
    const [c1, c2] = await Promise.all([dal.claimActiveProofRunForTask(taskA), dal.claimActiveProofRunForTask(taskA)])
    expect(c1).not.toBeNull()
    expect(c2).not.toBeNull()
    expect(c1!.id).toBe(runA.id)
    expect(c2!.id).toBe(runA.id)
    expect(c1!.status).toBe('running')
    expect(c2!.status).toBe('running')
    expect(new Date(c1!.started_at as any).getTime()).toBe(new Date(c2!.started_at as any).getTime())
    const terms = await Promise.all(
      Array.from({ length: 10 }, () =>
        dal.terminalizeProofRun({ runId: runA.id, outcome: 'nothing:agent_declined', detail: P }),
      ),
    )
    const winners = terms.filter((t) => t !== null)
    expect(winners.length).toBe(1)
    expect(winners[0]!.status).toBe('nothing')
    expect(winners[0]!.outcome).toBe('nothing:agent_declined')
    const finalA = await rowOf(runA.id)
    expect(finalA.status).toBe('nothing')
    expect(finalA.terminal_at).not.toBeNull()
    expect(await dal.claimActiveProofRunForTask(taskA)).toBeNull()
    expect(await dal.taskHasAnyProofRun(taskA)).toBe(true)

    // ── 6. Attribution: four buckets, survives session deletion, hwm monotone ───────────
    const sessE = await newSession(userE)
    const taskE = `${P}-te`
    const repoE = `github://acme/${P}-e`
    await rawRun({ user: userE, task: taskE, repo: repoE, status: 'running', session: sessE, startedAt: new Date() })
    const runE = (await sql`SELECT * FROM orchestrator_proof_runs WHERE user_id = ${userE}`)[0] as any
    const seedTokens = (sid: string, b: number[], ageSql: 'old' | 'new') =>
      ageSql === 'old'
        ? sql`
            INSERT INTO token_usage (user_id, session_id, model, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens, cost_usd, cost_source, created_at)
            VALUES (${userE}, ${sid}, 'claude-test', ${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}, 0, 'sdk', now() - interval '1 hour')`
        : sql`
            INSERT INTO token_usage (user_id, session_id, model, input_tokens, output_tokens,
              cache_creation_input_tokens, cache_read_input_tokens, cost_usd, cost_source, created_at)
            VALUES (${userE}, ${sid}, 'claude-test', ${b[0]}, ${b[1]}, ${b[2]}, ${b[3]}, 0, 'sdk', now())`
    await seedTokens(sessE, [1000, 1000, 1000, 1000], 'old') // before `since`: excluded
    await seedTokens(sessE, [1, 2, 3, 4], 'new') // 10
    await seedTokens(sessE, [10, 20, 30, 40], 'new') // 100
    const since = new Date(Date.now() - 30 * 60 * 1000)
    expect(await tokenDal.sumSessionTokensSince(sessE, since)).toEqual({ tokens: 110, sessionExists: true })
    expect(Number((await dal.recordProofObservation(runE.id, { tokens: 110 }))!.tokens_hwm)).toBe(110)
    expect(Number((await dal.recordProofObservation(runE.id, { tokens: 50 }))!.tokens_hwm)).toBe(110)
    await sql`DELETE FROM sessions WHERE id = ${sessE}`
    const gone = await tokenDal.sumSessionTokensSince(sessE, since)
    expect(gone.sessionExists).toBe(false)
    expect(Number((await dal.recordProofObservation(runE.id, { tokens: 40 }))!.tokens_hwm)).toBe(110)
    expect(Number((await dal.recordProofObservation(runE.id, { tokens: 200 }))!.tokens_hwm)).toBe(200)
    expect(Number((await dal.recordProofObservation(runE.id, { tokens: 0 }))!.tokens_hwm)).toBe(200)
    // and the budget gate fails closed on the lost attribution (flag stack ON, real tables)
    process.env.REMO_ORCHESTRATOR_PROOF = '1'
    process.env.REMO_ORCHESTRATOR_ENABLED = '1'
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
    expect(
      await gates.makeProofBudgetGate().check({
        userId: userE,
        sessionId: sessE,
        token: `${P}-e`,
        prompt: '',
        counterKey: runE.counter_key,
      }),
    ).toEqual({ ok: false, reason: 'proof_budget_attribution_lost' })

    // ── 7. Budget gate on the real tables: blocks AT max_injects, not before ────────────
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1000'
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '1000'
    // user A's run is terminal, so user B may arm the same repo (allowlist row (B, repoA) is new).
    const armedB = await arm(userB, sessB, repoA, { maxInjects: 3 })
    const runB = armedB.run
    counterKeys.push(runB.counter_key)
    const gateReq = (token: string) => ({
      userId: userB,
      sessionId: sessB,
      token,
      prompt: '',
      counterKey: runB.counter_key,
    })
    const reserve = (token: string) =>
      controls.reserveInject({ userId: userB, sessionId: sessB, token, counterKey: runB.counter_key })
    const budget = gates.makeProofBudgetGate()
    expect(await budget.check(gateReq(`${P}-g0`))).toEqual({ ok: true })
    expect((await reserve(`${P}-i1`)).ok).toBe(true)
    expect((await reserve(`${P}-i2`)).ok).toBe(true)
    expect(await budget.check(gateReq(`${P}-g2`))).toEqual({ ok: true }) // 2 < 3
    expect((await reserve(`${P}-i3`)).ok).toBe(true)
    expect(await budget.check(gateReq(`${P}-g3`))).toEqual({ ok: false, reason: 'proof_budget_injects:3>=3' })

    // ── 8. Disarm removes ONLY the exact (user_id, repo_ident) allowlist row ────────────
    await sql`INSERT INTO orchestrator_autospawn_allowlist (user_id, repo_ident) VALUES (${userA}, ${repoA2})`
    const allowBefore = await sql`
      SELECT user_id, repo_ident FROM orchestrator_autospawn_allowlist WHERE repo_ident LIKE ${`%${P}%`}`
    expect(allowBefore.length).toBe(3) // (A, repoA) (A, repoA2) (B, repoA)
    const dis = await dal.disarmProofRunTx({ userId: userB, detail: P })
    expect(dis.disarmed).toBe(true)
    const allowAfter = await sql`
      SELECT user_id, repo_ident FROM orchestrator_autospawn_allowlist WHERE repo_ident LIKE ${`%${P}%`}`
    expect(
      allowAfter.map((r: any) => `${r.user_id}|${r.repo_ident}`).sort(),
    ).toEqual([`${userA}|${repoA}`, `${userA}|${repoA2}`].sort())
    const disarmedB = await rowOf(runB.id)
    expect(disarmedB.status).toBe('disarmed')
    expect(disarmedB.outcome).toBeNull()
    expect(disarmedB.terminal_at).not.toBeNull()
    expect((await dal.disarmProofRunTx({ userId: userB })).disarmed).toBe(false) // idempotent

    // the harness user's own allowlist rows were never touched
    const harnessAllowAfter = (await sql`
      SELECT repo_ident FROM orchestrator_autospawn_allowlist WHERE user_id = ${a.userId} ORDER BY repo_ident
    `).map((r: any) => r.repo_ident)
    expect(harnessAllowAfter).toEqual(harnessAllowBefore)
  } finally {
    // Remove ONLY what this helper created, by exact id / prefix. Users cascade to proof runs,
    // allowlist, sessions, scheduled_tasks (+ orchestrator_rows) and token_usage.
    try {
      if (counterKeys.length > 0) {
        await sql`DELETE FROM automation_inject_ledger WHERE counter_key = ANY(${counterKeys}::text[])`
      }
      if (createdUsers.length > 0) {
        await sql`DELETE FROM orchestrator_proof_runs WHERE user_id = ANY(${createdUsers}::uuid[])`
        await sql`DELETE FROM orchestrator_autospawn_allowlist WHERE user_id = ANY(${createdUsers}::uuid[])`
        await sql`DELETE FROM users WHERE id = ANY(${createdUsers}::uuid[])`
      }
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  }
}
