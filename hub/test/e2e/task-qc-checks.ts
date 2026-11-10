// hub/test/e2e/task-qc-checks.ts
// PTYCAP-08 - REAL-POSTGRES proof of the task-quality auditor (SPEC section 6).
//
// This is NOT a test file (no test() call, never collected by `bun test`). Like
// automation-controls-checks.ts it is a plain helper called from the BODY of existing
// REMO_E2E_DB_URL-gated e2e tests, so it runs in Woodpecker's qc pipeline (postgres:16)
// and adds ZERO tests and ZERO skips. There is no local Postgres on the dev host:
// locally the enclosing describe is skipped and none of this executes.
//
// What the DB-free fakes (PGlite included) cannot prove and this does:
//   runTaskQcSchemaChecks - the task_type CHECK drop-and-re-add with task_qc rows present,
//     the per-user partial unique index, NULL-session binding (F2-B2), the findings
//     constraints + dedupe + ON CONFLICT, the ENGINE once-per-UTC-day claim, cascade.
//   runTaskQcEngineChecks - report-only as a row-for-row snapshot comparison, the three
//     allowlisted fixes with executed rollback SQL, writer row-lock serialization, the
//     in-flight refusal, and the atomic single-open-run claim.
//
// Cleans up ONLY rows carrying its unique scratch prefix (users cascade to sessions,
// tasks, runs and findings) in finally, and restores every env var it touches.
import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'

const PG_CHECK_VIOLATION = '23514'
const PG_UNIQUE_VIOLATION = '23505'

type Sql = any

/** Resolve to the Postgres error fields when the statement is rejected; throw when it is accepted. */
async function pgError(p: PromiseLike<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await p
  } catch (e: any) {
    return { code: e?.code, constraint_name: e?.constraint_name }
  }
  throw new Error('task-qc-checks: expected the statement to be rejected by the database')
}

const mkUser = async (sql: Sql, prefix: string, tag: string): Promise<string> => {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, password_hash, role)
    VALUES (${`${prefix}-${tag}@invalid.local`}, 'x', 'user') RETURNING id`
  return rows[0].id
}

const mkSession = async (
  sql: Sql,
  userId: string,
  prefix: string,
  o: { repoKey?: string | null; status?: 'online' | 'offline'; deleted?: boolean } = {},
): Promise<string> => {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, name, project_dir, token_hash, status, repo_key, deleted_at)
    VALUES (${userId}, ${prefix}, ${`/tmp/${prefix}-${randomUUID()}`}, ${'th-' + randomUUID()},
            ${o.status ?? 'online'}, ${o.repoKey ?? null}, ${o.deleted ? sql`now()` : null})
    RETURNING id`
  return rows[0].id
}

interface TaskSeed {
  userId: string
  sessionId: string | null
  targetId?: string | null
  name: string
  type: string
  timezone?: string
  payload?: Record<string, unknown>
  enabled?: boolean
  ageDays?: number
  armed?: boolean
}

/** Distinct prompt per task (prompt = name) so the OPTIMIZE duplicate arm never fires on the seed. */
const mkTask = async (sql: Sql, t: TaskSeed): Promise<string> => {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_tasks (
      user_id, session_id, name, cron_expression, cron_expr, prompt, enabled, task_type,
      target_kind, target_id, payload, timezone, schedule_kind, created_at, next_fire_at
    ) VALUES (
      ${t.userId}, ${t.sessionId}, ${t.name}, '0 9 * * *', '0 9 * * *', ${t.name}, ${t.enabled ?? true}, ${t.type},
      'session', ${t.targetId ?? null}, ${JSON.stringify(t.payload ?? {})}::jsonb, ${t.timezone ?? 'UTC'}, 'cron',
      now() - make_interval(days => ${t.ageDays ?? 0}::int),
      ${t.armed === false ? sql`NULL::timestamptz` : sql`now() + interval '1 hour'`}
    ) RETURNING id`
  return rows[0].id
}

/** Remove only rows that carry the scratch prefix; users cascade to every dependent row. */
const cleanup = async (sql: Sql, prefix: string): Promise<void> => {
  await sql`DELETE FROM users WHERE email LIKE ${prefix + '-%'}`
}

const saveEnv = (keys: string[]): (() => void) => {
  const saved: Record<string, string | undefined> = {}
  for (const k of keys) saved[k] = process.env[k]
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ---------------------------------------------------------------------------
// DDL + constraint checks
// ---------------------------------------------------------------------------

export interface TaskQcSchemaChecksArgs {
  /** Client bound to the database whose schema was applied (the harness or the private-namespace client). */
  sql: Sql
  /** Re-applies the whole schema.sql strictly (the host test's applySchemaStrict). */
  applySchema: () => Promise<void>
}

export async function runTaskQcSchemaChecks(a: TaskQcSchemaChecksArgs): Promise<void> {
  const { sql, applySchema } = a
  const P = `e2e-tqcs-${randomUUID().slice(0, 8)}`
  const findings = await import('../../src/task-qc/findings.ts')

  try {
    const u1 = await mkUser(sql, P, 'u1')
    const u2 = await mkUser(sql, P, 'u2')
    const s1 = await mkSession(sql, u1, P)
    const s2 = await mkSession(sql, u2, P)

    // (1) the CHECK accepts task_qc (NULL session, NULL target) and rejects an unknown type
    const qc1 = await mkTask(sql, { userId: u1, sessionId: null, name: `${P}-qc1`, type: 'task_qc' })
    const bad = await pgError(mkTask(sql, { userId: u1, sessionId: s1, targetId: s1, name: `${P}-bad`, type: 'not_a_type' }))
    expect(bad.code).toBe(PG_CHECK_VIOLATION)

    // (2) the drop-and-re-add of the CHECK validates the existing task_qc row (boot 2 with data present)
    await applySchema()
    await applySchema()
    const [still] = await sql<{ task_type: string }[]>`SELECT task_type FROM scheduled_tasks WHERE id = ${qc1}`
    expect(still.task_type).toBe('task_qc')
    expect((await pgError(mkTask(sql, { userId: u1, sessionId: s1, targetId: s1, name: `${P}-bad2`, type: 'not_a_type' }))).code).toBe(
      PG_CHECK_VIOLATION,
    )

    // (3) the per-user partial unique index: a second task_qc for u1 is rejected, the same insert for u2 succeeds
    const dup = await pgError(mkTask(sql, { userId: u1, sessionId: null, name: `${P}-qc1b`, type: 'task_qc' }))
    expect(dup.code).toBe(PG_UNIQUE_VIOLATION)
    expect(dup.constraint_name).toBe('idx_scheduled_tasks_task_qc_unique')
    const qc2 = await mkTask(sql, { userId: u2, sessionId: null, name: `${P}-qc2`, type: 'task_qc' })

    // (4) NULL anchor (F2-B2): the row has session_id NULL, survives deleting every scratch session,
    //     and a run with session_id NULL inserts
    const [anchor] = await sql<{ session_id: string | null }[]>`SELECT session_id FROM scheduled_tasks WHERE id = ${qc1}`
    expect(anchor.session_id).toBeNull()
    await sql`DELETE FROM sessions WHERE id = ANY(${[s1, s2]}::text[])`
    const surviving = await sql<{ id: string }[]>`SELECT id FROM scheduled_tasks WHERE id = ANY(${[qc1, qc2]}::text[])`
    expect(surviving.length).toBe(2)
    const [run] = await sql<{ id: string; session_id: string | null }[]>`
      INSERT INTO scheduled_task_runs (task_id, user_id, session_id, status)
      VALUES (${qc1}, ${u1}, NULL, 'pending') RETURNING id, session_id`
    expect(run.session_id).toBeNull()

    // (5) task_qc_findings CHECKs reject a bad detector, disposition and severity (raw SQL: the DAL pre-validates)
    const rawFinding = (detector: string, severity: string, disposition: string) => sql`
      INSERT INTO task_qc_findings (user_id, task_id, detector, severity, disposition, evidence_sig, day)
      VALUES (${u1}, ${qc1}, ${detector}, ${severity}, ${disposition}, ${'raw-' + randomUUID()}, '2030-01-01')`
    expect((await pgError(rawFinding('NOPE', 'info', 'proposed'))).code).toBe(PG_CHECK_VIOLATION)
    expect((await pgError(rawFinding('FAILING', 'info', 'nope'))).code).toBe(PG_CHECK_VIOLATION)
    expect((await pgError(rawFinding('FAILING', 'nope', 'proposed'))).code).toBe(PG_CHECK_VIOLATION)

    // (6) a valid insert succeeds; the same (user, task, detector, evidence signature, day) returns inserted:false
    const input = {
      userId: u1,
      taskId: qc1,
      detector: 'FAILING' as const,
      severity: 'warn' as const,
      disposition: 'proposed' as const,
      evidence: { streak: 3, probe: P },
      day: '2030-01-01',
    }
    const first = await findings.insertFinding(sql, input)
    expect(first.inserted).toBe(true)
    const repeat = await findings.insertFinding(sql, input)
    expect(repeat.inserted).toBe(false)
    const next = await findings.insertFinding(sql, { ...input, day: '2030-01-02' })
    expect(next.inserted).toBe(true)

    // (7) the ENGINE claim: true once, false for the same UTC day, true again for another day
    const claim = (utcDay: string) => findings.claimEngineFailure(sql, { userId: u1, taskId: qc1, utcDay })
    expect(await claim('2030-02-01')).toBe(true)
    expect(await claim('2030-02-01')).toBe(false)
    expect(await claim('2030-02-02')).toBe(true)

    // (8) deleting the user cascades its findings
    await findings.insertFinding(sql, { ...input, userId: u2, taskId: qc2 })
    const before = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM task_qc_findings WHERE user_id = ${u2}`
    expect(Number(before[0].n)).toBe(1)
    await sql`DELETE FROM users WHERE id = ${u2}`
    const after = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM task_qc_findings WHERE user_id = ${u2}`
    expect(Number(after[0].n)).toBe(0)
  } finally {
    await cleanup(sql, P)
  }
}

// ---------------------------------------------------------------------------
// Engine, writer, rollback and concurrency checks
// ---------------------------------------------------------------------------

export interface TaskQcEngineChecksArgs {
  /** Harness client bound to REMO_E2E_DB_URL (the same database the hub's shared sql uses). */
  sql: Sql
}

const ENV_KEYS = ['REMO_TASK_QC_ENABLED', 'REMO_TASK_QC_AUTOFIX', 'REMO_TASK_QC_FAIL_STREAK']

export async function runTaskQcEngineChecks(a: TaskQcEngineChecksArgs): Promise<void> {
  const { sql } = a
  const P = `e2e-tqce-${randomUUID().slice(0, 8)}`
  const restoreEnv = saveEnv(ENV_KEYS)
  const engine = await import('../../src/task-qc/engine.ts')
  const writer = await import('../../src/task-qc/safe-fixes.ts')
  const runClaim = await import('../../src/task-qc/run-claim.ts')

  try {
    // A scratch user isolates the pass from unrelated audited tasks other tests leave on the harness user.
    const U = await mkUser(sql, P, 'u')
    const SIB = `${P}-sibling-app-uuid`
    const repoKey = `${P}/repo`

    const sBase = await mkSession(sql, U, `${P}-base`)
    const sLive = await mkSession(sql, U, `${P}-live`, { repoKey })
    const sDead = await mkSession(sql, U, `${P}-dead`, { repoKey, status: 'offline', deleted: true })

    const T_TZ = await mkTask(sql, { userId: U, sessionId: sBase, targetId: sBase, name: `${P}-tz`, type: 'dev', timezone: 'Not/AZone' })
    const T_LOG = await mkTask(sql, { userId: U, sessionId: sBase, targetId: sBase, name: `${P}-log`, type: 'log_check' })
    await mkTask(sql, {
      userId: U,
      sessionId: sBase,
      targetId: sBase,
      name: `${P}-log-sibling`,
      type: 'log_check',
      payload: { application_uuid: SIB },
    })
    const T_DEAD = await mkTask(sql, { userId: U, sessionId: sDead, targetId: sDead, name: `${P}-dead`, type: 'dev' })
    const T_FAIL = await mkTask(sql, { userId: U, sessionId: sBase, targetId: sBase, name: `${P}-fail`, type: 'dev' })
    const T_OLD = await mkTask(sql, {
      userId: U,
      sessionId: sBase,
      targetId: sBase,
      name: `${P}-old`,
      type: 'dev',
      ageDays: 30,
      armed: false,
    })
    // Excluded rows, each seeded with a defect that WOULD be flagged if the row were audited.
    const T_INT = await mkTask(sql, {
      userId: U,
      sessionId: sBase,
      targetId: sBase,
      name: `__internal_${P}`,
      type: 'dev',
      enabled: false,
      timezone: 'Bad/Zone',
      ageDays: 30,
      armed: false,
    })
    const T_QC = await mkTask(sql, { userId: U, sessionId: null, name: `${P}-qc`, type: 'task_qc', timezone: 'Bad/Zone', ageDays: 30, armed: false })
    const T_ORCH = await mkTask(sql, {
      userId: U,
      sessionId: sBase,
      targetId: sBase,
      name: `${P}-orch`,
      type: 'orchestrator',
      timezone: 'Bad/Zone',
      ageDays: 30,
      armed: false,
    })
    const excluded = [T_INT, T_QC, T_ORCH]
    const fixable = [T_TZ, T_LOG, T_DEAD]

    // T_FAIL: a full window (50) of failed runs; the task must stay enabled whatever the pass does.
    await sql`
      INSERT INTO scheduled_task_runs (task_id, user_id, session_id, status, started_at, finished_at, error)
      SELECT ${T_FAIL}, ${U}, NULL, 'failed', now() - make_interval(mins => g), now() - make_interval(mins => g), 'e2e-boom'
      FROM generate_series(1, 50) AS g`

    const snapshot = async (): Promise<Record<string, string>> => {
      const rows = await sql<{ id: string; h: string }[]>`
        SELECT t.id, md5(t::text) AS h FROM scheduled_tasks t WHERE t.user_id = ${U} ORDER BY t.id`
      return Object.fromEntries(rows.map((r: { id: string; h: string }) => [r.id, r.h]))
    }
    const row = async (id: string) =>
      (await sql<any[]>`SELECT enabled, timezone, payload, session_id, target_id FROM scheduled_tasks WHERE id = ${id}`)[0]
    const resolveAppUuid = async (t: { payload?: Record<string, unknown> | null }) => {
      const v = t.payload?.application_uuid
      return typeof v === 'string' && v.trim() !== '' ? v : null
    }
    const pass = (autofix: boolean) =>
      engine.runTaskQcPass({
        userId: U,
        origin: 'run_now',
        deps: { q: sql, resolveAppUuid: resolveAppUuid as never, haltCheck: async () => ({ halted: false }), autofix },
      })
    const detectorsOf = (r: { findings: Array<{ taskId: string; detector: string }> }, id: string) =>
      r.findings.filter((f) => f.taskId === id).map((f) => f.detector)

    process.env.REMO_TASK_QC_ENABLED = '1'
    process.env.REMO_TASK_QC_FAIL_STREAK = '3'

    // ---- AUTOFIX off: findings, no write to ANY scheduled_tasks row --------------------------
    delete process.env.REMO_TASK_QC_AUTOFIX
    const snapBefore = await snapshot()
    const off = await pass(false)
    const snapAfter = await snapshot()
    expect(snapAfter).toEqual(snapBefore)
    expect(off.applied.length).toBe(0)
    const failing = off.findings.find((f) => f.taskId === T_FAIL && f.detector === 'FAILING')
    expect(failing?.severity).toBe('high')
    expect(detectorsOf(off, T_OLD)).toContain('NEVER_FIRED')
    const would = (id: string, detector: string) => off.findings.find((f) => f.taskId === id && f.detector === detector)?.evidence.would_fix
    expect(would(T_TZ, 'NEVER_FIRED')).toBe('normalize_timezone')
    expect(would(T_LOG, 'MISCONFIGURED')).toBe('backfill_payload_from_sibling')
    expect(would(T_DEAD, 'DEAD_SESSION')).toBe('rebind_dead_session')
    for (const id of excluded) expect(detectorsOf(off, id)).toEqual([])
    const autoFixedOff = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM task_qc_findings WHERE user_id = ${U} AND disposition = 'auto_fixed'`
    expect(Number(autoFixedOff[0].n)).toBe(0)

    // ---- AUTOFIX on: the three allowlisted fixes land, each audited --------------------------
    process.env.REMO_TASK_QC_AUTOFIX = '1'
    const keep = await snapshot()
    const on = await pass(true)
    expect(on.applied.map((x) => x.taskId).sort()).toEqual([...fixable].sort())
    expect(on.applied.map((x) => x.fix).sort()).toEqual(['backfill_payload_from_sibling', 'normalize_timezone', 'rebind_dead_session'])
    expect((await row(T_TZ)).timezone).toBe('UTC')
    expect((await row(T_LOG)).payload.application_uuid).toBe(SIB)
    const rebound = await row(T_DEAD)
    expect(rebound.session_id).toBe(sLive)
    expect(rebound.target_id).toBe(sLive)
    // the failing task is only ever proposed against, never disabled; excluded + unfixed rows are byte-identical
    expect((await row(T_FAIL)).enabled).toBe(true)
    const kept = await snapshot()
    for (const id of [T_FAIL, T_OLD, ...excluded]) expect(kept[id]).toBe(keep[id])
    for (const id of excluded) expect(detectorsOf(on, id)).toEqual([])

    const audits = await sql<
      { task_id: string; fix_kind: string; before_json: unknown; after_json: unknown; rollback_sql: string | null }[]
    >`SELECT task_id, fix_kind, before_json, after_json, rollback_sql FROM task_qc_findings
      WHERE user_id = ${U} AND disposition = 'auto_fixed' ORDER BY task_id`
    expect(audits.length).toBe(3)
    for (const au of audits) {
      expect(au.before_json).not.toBeNull()
      expect(au.after_json).not.toBeNull()
      expect(typeof au.rollback_sql).toBe('string')
    }

    // ---- stored rollback SQL, executed here only: restores originals, no-op on the second run ----
    for (const au of audits) {
      const first = await sql.unsafe(au.rollback_sql as string)
      expect(first.count).toBe(1)
      const second = await sql.unsafe(au.rollback_sql as string)
      expect(second.count).toBe(0)
    }
    expect((await row(T_TZ)).timezone).toBe('Not/AZone')
    expect((await row(T_LOG)).payload).toEqual({})
    const restored = await row(T_DEAD)
    expect(restored.session_id).toBe(sDead)
    expect(restored.target_id).toBe(sDead)

    // ---- writer row lock: two overlapping applyFix on one row -> one applied, one noop_changed ----
    const tzApplied = on.applied.find((x) => x.taskId === T_TZ)!
    const day = new Date().toISOString().slice(0, 10)
    const ctx = (taskId: string, finding: unknown) => ({ userId: U, taskId, day, finding: finding as never })
    const tzFix = { kind: 'normalize_timezone' as const, timezone: 'UTC' }
    const raced = await Promise.all([
      writer.applyFix(sql, tzFix, ctx(T_TZ, tzApplied.finding)),
      writer.applyFix(sql, tzFix, ctx(T_TZ, tzApplied.finding)),
    ])
    expect(raced.map((r) => r.status).sort()).toEqual(['applied', 'noop_changed'])
    expect((await row(T_TZ)).timezone).toBe('UTC')

    // ---- an open run blocks the write: skipped_in_flight, row unchanged, one audit row ----
    const logApplied = on.applied.find((x) => x.taskId === T_LOG)!
    const open = await sql<{ id: string }[]>`
      INSERT INTO scheduled_task_runs (task_id, user_id, session_id, status)
      VALUES (${T_LOG}, ${U}, NULL, 'pending') RETURNING id`
    const heldBefore = (await snapshot())[T_LOG]
    const held = await writer.applyFix(
      sql,
      { kind: 'backfill_payload_from_sibling', applicationUuid: SIB },
      ctx(T_LOG, logApplied.finding),
    )
    expect(held.status).toBe('skipped_in_flight')
    expect((await snapshot())[T_LOG]).toBe(heldBefore)
    const skippedRows = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM task_qc_findings
      WHERE user_id = ${U} AND task_id = ${T_LOG} AND disposition = 'skipped_in_flight'`
    expect(Number(skippedRows[0].n)).toBe(1)
    await sql`DELETE FROM scheduled_task_runs WHERE id = ${open[0].id}`

    // ---- atomic run claim: two overlapping claims yield exactly one open run ----
    const claims = await Promise.all(
      [0, 1].map(() => runClaim.claimTaskQcRun({ taskId: T_QC, userId: U, scheduledFor: new Date() })),
    )
    expect(claims.filter((c) => c != null).length).toBe(1)
    const openRuns = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM scheduled_task_runs
      WHERE task_id = ${T_QC} AND status = 'pending' AND finished_at IS NULL AND completed_at IS NULL`
    expect(Number(openRuns[0].n)).toBe(1)
    expect(await runClaim.claimTaskQcRun({ taskId: T_QC, userId: U, scheduledFor: new Date() })).toBeNull()
  } finally {
    restoreEnv()
    await cleanup(sql, P)
  }
}
