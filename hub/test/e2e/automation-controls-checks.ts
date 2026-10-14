// hub/test/e2e/automation-controls-checks.ts
// PTYCAP-04 - REAL-POSTGRES proof of the automation controls SQL.
//
// This is NOT a test file (no test() call, never collected by `bun test`). It is a
// plain helper called from the BODY of one existing DB-gated e2e test
// (orchestrator-tokencap.e2e.test.ts, the "UNDER cap" control), so it runs in
// Woodpecker's qc pipeline (postgres:16, REMO_E2E_DB_URL) and adds ZERO tests and
// ZERO skips. There is no local Postgres on the dev host: locally the enclosing
// describe is skipped and this never executes.
//
// What the DB-free tests cannot prove and this does (panel F-8 / plan-check MAJOR):
//   - the advisory-lock reservation under REAL concurrency (20 and 5 parallel reserves),
//   - the partial unique indexes (one engaged kill-switch row per target),
//   - ON CONFLICT page / alarm claims, count-after-reset, token idempotency,
//   - text/uuid casts across users / sessions / scheduled_tasks,
//   - the rate-union de-duplication (ledger row + routine_run_log row = ONE inject).
//
// Cleans up ONLY rows it created (unique counter-key / token / engaged_by prefix)
// and restores every env var it touches.
import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'

type Controls = typeof import('../../src/dispatch/automation-controls.ts')
type Inject = typeof import('../../src/orchestrator/inject.ts')
type Pipeline = typeof import('../../src/dispatch/pipeline.ts')

export interface AutomationChecksArgs {
  /** Private harness client bound to REMO_E2E_DB_URL (same database the hub's shared sql uses). */
  sql: any
  userId: string
  sessionId: string
  controls: Controls
  inject: Inject
  pipeline: Pipeline
}

const ENV_KEYS = [
  'REMO_AUTOMATION_LIFETIME_INJECT_CAP',
  'REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR',
  'REMO_AUTOMATION_KILL_SWITCH',
]

export async function runAutomationControlsChecks(a: AutomationChecksArgs): Promise<void> {
  const { sql, userId, sessionId, controls: C } = a
  const P = `e2e-ac-${randomUUID().slice(0, 8)}`
  const saved: Record<string, string | undefined> = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  delete process.env.REMO_AUTOMATION_KILL_SWITCH

  const K1 = `${P}:k1`
  const K2 = `${P}:k2`
  const createdSessions: string[] = []
  const extraCounterKeys: string[] = []
  const alarmClaimIds: string[] = []

  const newSession = async (): Promise<string> => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, ${P}, ${`/tmp/e2e-automation-${randomUUID()}`}, ${'th-' + randomUUID()})
      RETURNING id
    `
    createdSessions.push(rows[0].id)
    return rows[0].id
  }
  const count = async (where: any): Promise<number> => {
    const rows = await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM automation_inject_ledger ${where}`
    return Number(rows[0].n)
  }
  const injectCount = (key: string) =>
    count(sql`WHERE counter_key = ${key} AND kind = 'inject'`)
  const reserve = (key: string, token: string, over: Record<string, unknown> = {}) =>
    C.reserveInject({ userId, sessionId, token, counterKey: key, ...over })

  try {
    // (1) the migrated database has all three tables
    await expect(C.assertAutomationControlsTables()).resolves.toBeUndefined()

    // (2) lifetime cap 5, 20 concurrent reserves with distinct tokens -> exactly 5 ok
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '5'
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => reserve(K1, `${P}-t${i}`)))
    expect(burst.filter((r) => r.ok).length).toBe(5)
    const refused = burst.filter((r) => !r.ok) as Array<{ ok: false; reason: string }>
    expect(refused.length).toBe(15)
    expect(refused.every((r) => r.reason.startsWith('lifetime_inject_exhausted:'))).toBe(true)
    expect(await injectCount(K1)).toBe(5)

    // (3) same token again -> ok, still 5 rows (token idempotency)
    const okTokens = await sql<{ token: string }[]>`
      SELECT token FROM automation_inject_ledger WHERE counter_key = ${K1} AND kind = 'inject' ORDER BY seq`
    const t0 = okTokens[0].token
    expect((await reserve(K1, t0)).ok).toBe(true)
    expect(await injectCount(K1)).toBe(5)

    // (4) release one token -> count 4; re-reserve that token -> 5, still 5 rows
    await C.releaseInject({ counterKey: K1, token: t0 })
    const probe: any = { userId, sessionId, token: 'probe', prompt: '', counterKey: K1 }
    expect(await C.lifetimeCounterCheck(probe)).toEqual({ ok: true }) // 4 < 5
    expect((await reserve(K1, t0)).ok).toBe(true)
    expect(await injectCount(K1)).toBe(5)
    expect((await reserve(K1, `${P}-new`)).ok).toBe(false)
    const gateBlock = await C.lifetimeCounterCheck(probe)
    expect(gateBlock).toEqual({ ok: false, reason: 'lifetime_inject_exhausted:5>=5' })

    // (5) rate: cap 2, 5 concurrent reserves, one session, distinct counter keys
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1000'
    process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = '2'
    const rateSession = await newSession()
    const rateKeys = Array.from({ length: 5 }, (_, i) => `${P}:r${i}`)
    extraCounterKeys.push(...rateKeys)
    const rateBurst = await Promise.all(
      rateKeys.map((k, i) =>
        C.reserveInject({ userId, sessionId: rateSession, token: `${P}-rt${i}`, counterKey: k, enforceRate: true }),
      ),
    )
    expect(rateBurst.filter((r) => r.ok).length).toBe(2)
    const rateRefused = rateBurst.filter((r) => !r.ok) as Array<{ ok: false; reason: string }>
    expect(rateRefused.length).toBe(3)
    expect(rateRefused.every((r) => r.reason.startsWith('over_session_inject_rate:'))).toBe(true)
    expect(await C.countRateUnion(rateSession, 60)).toBe(2)
    // a dispatched inject present in BOTH sources (run log carries the ledger token) counts ONCE
    const ledgerTok = await sql<{ token: string }[]>`
      SELECT token FROM automation_inject_ledger WHERE session_id = ${rateSession} AND kind = 'inject' LIMIT 1`
    await sql`
      INSERT INTO routine_run_log (session_id, command, outcome, inject_token)
      VALUES (${rateSession}, 'e2e-both', 'dispatched', ${ledgerTok[0].token})`
    expect(await C.countRateUnion(rateSession, 60)).toBe(2)
    // a queued run-log row with a NULL token counts once
    await sql`
      INSERT INTO routine_run_log (session_id, command, outcome, inject_token)
      VALUES (${rateSession}, 'e2e-queued', 'queued', NULL)`
    expect(await C.countRateUnion(rateSession, 60)).toBe(3)
    // a non-inject outcome never counts
    await sql`
      INSERT INTO routine_run_log (session_id, command, outcome, inject_token)
      VALUES (${rateSession}, 'e2e-refused', 'refused', NULL)`
    expect(await C.countRateUnion(rateSession, 60)).toBe(3)
    if (saved.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR === undefined) delete process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR
    else process.env.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR = saved.REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR

    // (6) reset: count 0, earlier inject rows still exist, a new reserve succeeds
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '5'
    expect(await C.resetLifetimeCounter({ userId: randomUUID(), counterKey: K1 })).toEqual({
      ok: false,
      reason: 'unknown_counter_key',
    })
    expect(await C.resetLifetimeCounter({ userId, counterKey: K1, actor: P })).toEqual({ ok: true })
    expect(await C.lifetimeCounterCheck(probe)).toEqual({ ok: true })
    expect(await injectCount(K1)).toBe(5) // history untouched
    expect((await reserve(K1, `${P}-after-reset`)).ok).toBe(true)
    expect(await injectCount(K1)).toBe(6)

    // (7) page claims: 3 concurrent claims for one (key, kind, epoch) -> exactly one
    expect((await reserve(K2, `${P}-k2a`)).ok).toBe(true)
    const claim = { userId, sessionId, counterKey: K2 }
    const claims = await Promise.all([
      C.claimLifetimePage({ ...claim, kind: 'warn' }),
      C.claimLifetimePage({ ...claim, kind: 'warn' }),
      C.claimLifetimePage({ ...claim, kind: 'warn' }),
    ])
    expect(claims.filter((c) => c.claimed).length).toBe(1)
    expect((await C.claimLifetimePage({ ...claim, kind: 'exhausted' })).claimed).toBe(true) // independent kind
    expect((await C.claimLifetimePage({ ...claim, kind: 'exhausted' })).claimed).toBe(false)
    expect(await C.resetLifetimeCounter({ userId, counterKey: K2 })).toEqual({ ok: true })
    expect((await C.claimLifetimePage({ ...claim, kind: 'warn' })).claimed).toBe(true) // new epoch
    expect(await count(sql`WHERE counter_key = ${K2} AND kind = 'inject'`)).toBe(1) // pages never count

    // (8) kill switch: partial unique indexes, fresh-read predicate, scopes
    const other = { userId: randomUUID(), sessionId: randomUUID() }
    const both = await Promise.all([
      C.engageKillSwitch({ scope: 'global', engagedBy: P, reason: 'e2e' }),
      C.engageKillSwitch({ scope: 'global', engagedBy: P, reason: 'e2e' }),
    ])
    expect(both.filter((r) => !r.alreadyEngaged).length).toBe(1)
    const engagedRows = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM automation_kill_switch WHERE scope = 'global' AND engaged AND engaged_by = ${P}`
    expect(Number(engagedRows[0].n)).toBe(1)
    expect(await C.isAutomationHalted({ userId, sessionId })).toEqual({ halted: true, scope: 'global' })
    expect(await C.killSwitchCheck({ userId, sessionId, token: 'x', prompt: '' })).toEqual({
      ok: false,
      reason: 'automation_halted:global',
    })
    expect(await C.releaseKillSwitch({ scope: 'global', releasedBy: P })).toEqual({ released: true })
    expect(await C.isAutomationHalted({ userId, sessionId })).toEqual({ halted: false })
    expect(await C.releaseKillSwitch({ scope: 'global', releasedBy: P })).toEqual({ released: false })

    await C.engageKillSwitch({ scope: 'user', userId, engagedBy: P })
    expect(await C.isAutomationHalted({ userId, sessionId })).toEqual({ halted: true, scope: 'user' })
    expect(await C.isAutomationHalted({ userId: other.userId, sessionId: other.sessionId })).toEqual({ halted: false })
    // text/uuid cast: kill-switch.user_id (TEXT) joined to users.id (UUID)
    const joined = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM automation_kill_switch k JOIN users u ON u.id::text = k.user_id
      WHERE k.engaged_by = ${P}`
    expect(Number(joined[0].n)).toBe(1)
    expect(await C.releaseKillSwitch({ scope: 'user', userId, releasedBy: P })).toEqual({ released: true })

    await C.engageKillSwitch({ scope: 'session', userId, sessionId: rateSession, engagedBy: P })
    expect(await C.isAutomationHalted({ userId, sessionId: rateSession })).toEqual({ halted: true, scope: 'session' })
    expect(await C.isAutomationHalted({ userId, sessionId })).toEqual({ halted: false })
    const st = await C.getKillSwitchState({ userId })
    expect(st.sessions.map((s) => s.session_id)).toContain(rateSession)
    expect(await C.releaseKillSwitch({ scope: 'session', sessionId: rateSession, releasedBy: P })).toEqual({ released: true })
    const history = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM automation_kill_switch WHERE engaged_by = ${P} AND NOT engaged`
    expect(Number(history[0].n)).toBe(3) // released rows stay as history

    // (9) token_cap_alarms: two concurrent raw claims -> one row
    await Promise.all([
      sql`INSERT INTO token_cap_alarms (user_id, local_date, pct) VALUES (${userId}, '2099-01-01', 60)
          ON CONFLICT (user_id, local_date) DO NOTHING`,
      sql`INSERT INTO token_cap_alarms (user_id, local_date, pct) VALUES (${userId}, '2099-01-01', 60)
          ON CONFLICT (user_id, local_date) DO NOTHING`,
    ])
    const alarms = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM token_cap_alarms WHERE user_id = ${userId} AND local_date = '2099-01-01'`
    expect(Number(alarms[0].n)).toBe(1)

    // (10) casts + resolver against real rows
    const ledgerJoin = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM automation_inject_ledger l
      JOIN users u ON u.id::text = l.user_id
      JOIN sessions s ON s.id = l.session_id
      WHERE l.counter_key = ${K1} AND l.kind = 'inject'`
    expect(Number(ledgerJoin[0].n)).toBe(6)
    const taskSession = await newSession()
    const task = await sql<{ id: string }[]>`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type, target_kind, target_id, timezone)
      VALUES (${userId}, ${taskSession}, ${P}, '0 * * * *', 'go', 'orchestrator', 'session', ${taskSession}, 'UTC')
      RETURNING id`
    const taskKey = `task:${task[0].id}`
    extraCounterKeys.push(taskKey)
    expect(await C.resolveOrchestratorCounterKey({ userId, sessionId: taskSession })).toBe(taskKey)
    expect(await C.resolveOrchestratorCounterKey({ userId, sessionId: rateSession })).toBe(`session:${rateSession}`)

    // (11) the REAL inject path with cap 1: first dispatched, second refused
    process.env.REMO_AUTOMATION_LIFETIME_INJECT_CAP = '1'
    const sent: string[] = []
    const channel = { ws: { send: (f: string) => { sent.push(f) } }, userId, sessionId: taskSession }
    const deps = {
      dispatch: a.pipeline.dispatch,
      getChannel: ((sid: string) => (sid === taskSession ? channel : undefined)) as any,
      isSessionLive: (async (sid: string) => sid === taskSession) as any,
    }
    a.pipeline._reset()
    const first = await a.inject.injectOrchestratorPrompt(
      { userId, sessionId: taskSession, token: `${P}:orch:1`, prompt: 'automation e2e 1' },
      deps as any,
    )
    expect(first.kind).toBe('dispatched')
    await a.pipeline.onSessionReply(taskSession, 'done') // free the session slot
    const second = await a.inject.injectOrchestratorPrompt(
      { userId, sessionId: taskSession, token: `${P}:orch:2`, prompt: 'automation e2e 2' },
      deps as any,
    )
    expect(second).toEqual({ kind: 'refused', reason: 'lifetime_inject_exhausted:1>=1' })
    expect(sent.length).toBe(1)
    expect(await injectCount(taskKey)).toBe(1)
    a.pipeline._reset()

    // (12) PTYCAP-04-05: the REAL claimTokenCapAlarm SQL. Two concurrent claims for the
    // same user and local day -> exactly one winner and exactly one row; an immediate
    // third claim (undelivered, inside the cooldown) wins nothing; after delivered=true
    // nothing is ever claimable. Same helper, same existing test body: zero new tests/skips.
    const alarmMod = await import('../../src/observability/token-cap-alarm.ts')
    const alarmArgs = { userId, timezone: 'UTC', pct: 60, tokens: 600, cap: 1000 }
    await sql`DELETE FROM token_cap_alarms WHERE user_id = ${userId} AND local_date = (now() AT TIME ZONE 'UTC')::date`
    const alarmClaims = await Promise.all([
      alarmMod.claimTokenCapAlarm(alarmArgs, sql),
      alarmMod.claimTokenCapAlarm(alarmArgs, sql),
    ])
    const winners = alarmClaims.filter((c) => c !== null)
    expect(winners.length).toBe(1)
    alarmClaimIds.push(winners[0] as string)
    const alarmRows = await sql<{ n: string; delivered: boolean; attempts: number }[]>`
      SELECT COUNT(*)::text AS n, bool_or(delivered) AS delivered, max(attempts) AS attempts
      FROM token_cap_alarms
      WHERE user_id = ${userId} AND local_date = (now() AT TIME ZONE 'UTC')::date`
    expect(Number(alarmRows[0].n)).toBe(1)
    expect(alarmRows[0].delivered).toBe(false)
    expect(await alarmMod.claimTokenCapAlarm(alarmArgs, sql)).toBeNull() // cooling down
    await sql`UPDATE token_cap_alarms SET delivered = true WHERE id = ${winners[0] as string}`
    expect(await alarmMod.claimTokenCapAlarm({ ...alarmArgs, cooldownSeconds: 0 }, sql)).toBeNull() // delivered

    // (13) QC m2: the REAL countFiresForTask SQL. Kill-switch skips (skipped +
    // automation_halted:<scope>) do not count toward max_runs; a success and every other
    // skip (cost cap) still do. Rows hang off the scheduled task of (10) and cascade away
    // with it in the cleanup below.
    const dalMod = await import('../../src/db/scheduled-tasks-dal.ts')
    const runStatuses: Array<[string, string | null]> = [
      ['success', null],
      ['skipped', 'daily_cost_cap'],
      ['skipped', 'automation_halted:global'],
      ['skipped', 'automation_halted:user'],
      ['failed', 'automation_halted:user'], // only SKIPPED halts are excluded
    ]
    for (const [status, error] of runStatuses) {
      await sql`INSERT INTO scheduled_task_runs (task_id, user_id, status, error) VALUES (${task[0].id}, ${userId}, ${status}, ${error})`
    }
    expect(await dalMod.countFiresForTask(task[0].id)).toBe(3)
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    // Delete ONLY what this helper created (unique prefix / ids).
    await sql`DELETE FROM automation_inject_ledger WHERE counter_key LIKE ${P + '%'} OR counter_key = ANY(${extraCounterKeys}::text[])`
    await sql`DELETE FROM automation_kill_switch WHERE engaged_by = ${P}`
    await sql`DELETE FROM token_cap_alarms WHERE user_id = ${userId} AND local_date = '2099-01-01'`
    if (alarmClaimIds.length > 0) {
      await sql`DELETE FROM token_cap_alarms WHERE id = ANY(${alarmClaimIds}::text[])`
    }
    if (createdSessions.length > 0) {
      await sql`DELETE FROM scheduled_tasks WHERE session_id = ANY(${createdSessions}::text[])`
      await sql`DELETE FROM sessions WHERE id = ANY(${createdSessions}::text[])`
    }
  }
}
