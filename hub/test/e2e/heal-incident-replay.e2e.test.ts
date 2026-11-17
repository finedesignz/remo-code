/**
 * PTYCAP-07-10 (SC4, SH-05, SH-06): the 2026-07 self-heal incident replayed on REAL Postgres.
 *
 * File name note: the spec / validation map calls this "heal-incident-replay"; it carries the
 * .e2e.test.ts suffix so `bun run orchestrator:e2e` (hub/test/e2e/*.e2e.test.ts) and the Woodpecker
 * postgres:16 step in .woodpecker/qc.yaml pick it up. Gated on REMO_E2E_DB_URL (maybeDescribe): it
 * SKIPS locally without a database (printing the explicit reason below) and must also PASS in CI on
 * postgres:16 - the assertions are written for real Postgres semantics (advisory locks, partial unique
 * indexes, NOT NULL, search_path), never for a lax local engine.
 *
 * Incident fixtures. The incident ids are short prefixes; fixtures pad them deterministically to full
 * ids by appending PAD (pad('8a6e0534') === '8a6e0534-0000-4000-8000-000000000000'):
 *   runs  8a6e0534, fa377e27   (Coolify deployment metadata runs, NULL session_id, pending, 7h old)
 *   task  0e16bf38             (the internal deployment task that owns both runs)
 *   apps  xxhodf65, zl7c3u88   (the two failing Coolify applications)
 * Before the fix those two runs sat `pending` until the 6h run reaper and the failure never reached
 * anyone. The cases:
 *   V1  both failures, flag ON, no repo session -> metadata runs terminal skipped/no_routable_session
 *       well under 5s, zero pending / open-run rows, the reaper sees zero candidates, ONE notification
 *       per dedupe key, and a duplicate webhook is terminal skipped/deduped with no new row or notice.
 *   V2  an unrelated agent session (another repo) is online: the failure is NEVER delivered to it.
 *   CONC eight simultaneous routeHeal calls for one dedupe key: one row, one notice, 1 + 7 outcomes.
 *   AUTO governed autospawn: one launch, the autospawn-launch ledger row, an UNRELEASED lifetime
 *       reservation, outcome autospawn_launched; a failed launch releases the reservation and leaves
 *       the metadata run terminal.
 *
 * Only the notifier send, the launch call, the supervisor-online predicate, the park dispatch (autospawn
 * cases) and the websocket channel are injected; claims, ledger, gates, reservation, run finalization
 * and the reaper loader are the REAL implementations against the disposable DB.
 *
 * Run with: REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/heal-incident-replay.e2e.test.ts
 */
import { test, expect, beforeAll, afterAll, beforeEach, describe } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { hasE2eDb, maybeDescribe, setupHarness, teardownHarness, type Harness } from './orchestrator-harness.ts'

// The hub DAL binds DATABASE_URL at import time: point it at the disposable DB before any DAL import.
if (hasE2eDb()) process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!

if (!hasE2eDb()) {
  describe('heal incident replay (real Postgres)', () => {
    test.skip('SKIPPED: REMO_E2E_DB_URL is not set; runs against postgres:16 in Woodpecker (bun run orchestrator:e2e)', () => {})
  })
}

const PAD = '-0000-4000-8000-000000000000'
const pad = (prefix: string) => `${prefix}${PAD}`

const INCIDENT = {
  runs: ['8a6e0534', 'fa377e27'],
  task: '0e16bf38',
  apps: ['xxhodf65', 'zl7c3u88'],
} as const

const NEVER_CRON = '0 0 31 2 *'
const HEAL_ENV = ['REMO_HEAL_UNIFIED', 'REMO_ORCHESTRATOR_AUTOSPAWN', 'REMO_ORCHESTRATOR_ENABLED'] as const

maybeDescribe('heal incident replay (real Postgres)', () => {
  let h: Harness
  const savedEnv: Record<string, string | undefined> = {}

  // Lazy imports AFTER DATABASE_URL is repointed.
  let dispatchTriage: typeof import('../../src/api/coolify-webhook.ts').dispatchTriage
  let routeHeal: typeof import('../../src/heal/route.ts').routeHeal
  let REAL_DEPS: typeof import('../../src/heal/route.ts').REAL_DEPS
  let REAL_AUTOSPAWN: typeof import('../../src/heal/route.ts').REAL_AUTOSPAWN
  let buildCoolifyHealEvent: typeof import('../../src/heal/sources/coolify.ts').buildCoolifyHealEvent
  let claimHealNotification: typeof import('../../src/db/heal-events-dal.ts').claimHealNotification
  let addRepoToAutospawnAllowlist: typeof import('../../src/db/orchestrator-rows-dal.ts').addRepoToAutospawnAllowlist
  let reapStaleRuns: typeof import('../../src/scheduler/run-reaper.ts').reapStaleRuns
  let buildHealKey: typeof import('../../src/heal/counter-key.ts').buildHealKey
  let registerChannel: typeof import('../../src/ws/registry.ts').registerChannel
  let unregisterChannel: typeof import('../../src/ws/registry.ts').unregisterChannel

  // ── injected seams (the only fakes) ─────────────────────────────────────────
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const launches: Array<{ userId: string; sessionId: string; machine: true }> = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const parked: unknown[] = []
  let dispatchCalls = 0
  let launchResult: any = { ok: true, runId: 'e2e-run', supervisorId: 'e2e-sup', hostname: 'e2e-host', repoPath: '/tmp/e2e' }

  const notifyDeps = () => ({
    claim: (id: string) => claimHealNotification(id),
    resolveOwnerEmail: async () => 'owner-e2e@invalid.local',
    send: async (m: { to: string; subject: string; html: string; text: string }) => {
      sent.push({ to: m.to, subject: m.subject, text: m.text })
      return true
    },
  })

  /** Real routeHeal collaborators; only notify is replaced, dispatch is counted. */
  const healDeps = (extra: Record<string, unknown> = {}): any => ({
    ...REAL_DEPS,
    notify: notifyDeps(),
    dispatch: async (...a: any[]) => {
      dispatchCalls++
      return (REAL_DEPS.dispatch as any)(...a)
    },
    ...extra,
  })

  const autospawnDeps = (): any => ({
    ...REAL_AUTOSPAWN, // real armed(): heal flag AND autospawn flag only
    supervisorOnlineForUser: async () => true,
    launchSessionForUser: async (a: { userId: string; sessionId: string; machine: true }) => {
      launches.push(a)
      return launchResult
    },
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
  })

  // ── fixture helpers ──────────────────────────────────────────────────────────
  let deploymentTaskId = ''

  async function seedMetadataRun(id: string, appUuid: string, gitRepository: string, sevenHoursOld: boolean) {
    const age = sevenHoursOld ? `now() - interval '7 hours'` : 'now()'
    await h.sql.unsafe(
      `INSERT INTO scheduled_task_runs
         (id, task_id, user_id, status, scheduled_for, started_at, target_kind,
          deployment_uuid, application_uuid, git_repository, commit_sha)
       VALUES ($1, $2, $3, 'pending', ${age}, ${age}, 'session', $4, $5, $6, $7)`,
      [id, deploymentTaskId, h.userId, `dep-${id.slice(0, 8)}`, appUuid, gitRepository, 'c0ffee1'],
    )
  }

  async function seedSession(repoKey: string, name: string): Promise<string> {
    const [owner, repo] = repoKey.replace('github://', '').split('/')
    const rows = await h.sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash, repo_key, github_owner, github_repo, hostname)
      VALUES (${h.userId}, ${name}, ${'/tmp/' + name}, ${'th-' + randomUUID()}, ${repoKey}, ${owner}, ${repo}, 'e2e-host')
      RETURNING id
    `
    return rows[0]!.id
  }

  const payloadFor = (app: string, repo: string, sha = 'c0ffee1') => ({
    event: 'deployment.failed' as const,
    deployment_uuid: `dep-${app}`,
    application_uuid: app,
    git_repository: repo,
    commit_sha: sha,
  })

  async function runRow(id: string) {
    const rows = await h.sql<{ id: string; status: string; error: string | null }[]>`
      SELECT id, status, error FROM scheduled_task_runs WHERE id = ${id}
    `
    return rows[0]!
  }

  async function healRows(source: string, dedupeLike: string) {
    return h.sql<{ outcome: string | null; notification_claimed_at: Date | null; dedupe_key: string }[]>`
      SELECT outcome, notification_claimed_at, dedupe_key FROM heal_events
      WHERE user_id = ${h.userId} AND source = ${source} AND dedupe_key LIKE ${dedupeLike}
    `
  }

  const countOne = async (q: PromiseLike<Array<{ n: string }>>) => Number((await q)[0]!.n)

  beforeAll(async () => {
    for (const k of HEAL_ENV) savedEnv[k] = process.env[k]
    h = await setupHarness()
    ;({ dispatchTriage } = await import('../../src/api/coolify-webhook.ts'))
    ;({ routeHeal, REAL_DEPS, REAL_AUTOSPAWN } = await import('../../src/heal/route.ts'))
    ;({ buildCoolifyHealEvent } = await import('../../src/heal/sources/coolify.ts'))
    ;({ claimHealNotification } = await import('../../src/db/heal-events-dal.ts'))
    ;({ addRepoToAutospawnAllowlist } = await import('../../src/db/orchestrator-rows-dal.ts'))
    ;({ reapStaleRuns } = await import('../../src/scheduler/run-reaper.ts'))
    ;({ buildHealKey } = await import('../../src/heal/counter-key.ts'))
    ;({ registerChannel, unregisterChannel } = await import('../../src/ws/registry.ts'))

    // The internal deployment task that owns the incident metadata runs (id 0e16bf38, padded).
    deploymentTaskId = pad(INCIDENT.task)
    await h.sql`
      INSERT INTO scheduled_tasks (
        id, user_id, session_id, name, cron_expression, prompt,
        enabled, task_type, target_kind, payload, cron_expr, timezone, is_internal
      ) VALUES (
        ${deploymentTaskId}, ${h.userId}, NULL, '__internal_coolify_deployment', ${NEVER_CRON}, '',
        false, 'log_check', 'session', '{}'::jsonb, ${NEVER_CRON}, 'UTC', true
      )
    `
  })

  afterAll(async () => {
    for (const k of HEAL_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    if (h) {
      // automation_inject_ledger.user_id has no FK: clear this user's reservations explicitly.
      await h.sql`DELETE FROM automation_inject_ledger WHERE user_id = ${h.userId}`
      await teardownHarness(h)
    }
  })

  beforeEach(() => {
    process.env.REMO_HEAL_UNIFIED = '1'
    delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    launchResult = { ok: true, runId: 'e2e-run', supervisorId: 'e2e-sup', hostname: 'e2e-host', repoPath: '/tmp/e2e' }
  })

  // ---------------------------------------------------------------------------
  // V1 - the incident: two failures, no routable session
  // ---------------------------------------------------------------------------
  describe('V1: runs 8a6e0534 and fa377e27 (task 0e16bf38, apps xxhodf65 and zl7c3u88)', () => {
    const repoFor = (app: string) => `finedesignz/e2e-heal-nosession-${app}`
    const runIds = INCIDENT.runs.map(pad)

    test('fixtures use the incident short ids padded deterministically', () => {
      expect(runIds.map((r) => r.slice(0, 8))).toEqual(['8a6e0534', 'fa377e27'])
      expect(deploymentTaskId.slice(0, 8)).toBe('0e16bf38')
      expect(INCIDENT.apps).toEqual(['xxhodf65', 'zl7c3u88'])
    })

    test('both failures reach a terminal skipped/no_routable_session in under 5 seconds, nothing left pending', async () => {
      for (const [i, app] of INCIDENT.apps.entries()) {
        await seedMetadataRun(runIds[i]!, app, repoFor(app), true)
      }
      const sentBefore = sent.length
      dispatchCalls = 0

      const started = Date.now()
      for (const [i, app] of INCIDENT.apps.entries()) {
        await dispatchTriage(h.userId, runIds[i]!, payloadFor(app, repoFor(app)), {
          routeDeps: healDeps(),
          fetchLogSnippet: async () => 'e2e deploy log',
          resolveRepoKeyFromAppUuid: async () => null,
        })
      }
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(5000)

      for (const id of runIds) {
        const r = await runRow(id)
        expect([id.slice(0, 8), r.status, r.error]).toEqual([id.slice(0, 8), 'skipped', 'no_routable_session'])
      }

      // zero pending / in-flight runs, zero open supervisor runs for the user
      expect(await countOne(h.sql`SELECT count(*)::text AS n FROM scheduled_task_runs WHERE user_id = ${h.userId} AND status IN ('pending','in_flight')`)).toBe(0)
      expect(await countOne(h.sql`SELECT count(*)::text AS n FROM session_runs WHERE user_id = ${h.userId} AND ended_at IS NULL`)).toBe(0)

      // the real 6h reaper loader sees none of the incident runs (finalize is recorded, never executed)
      const reaped: string[] = []
      const candidates = await reapStaleRuns(Date.now(), {
        finalizeRun: (async (id: string) => { reaped.push(id) }) as any,
        releaseSlot: async () => undefined,
      })
      expect(candidates.filter((id) => runIds.includes(id))).toEqual([])
      expect(reaped.filter((id) => runIds.includes(id))).toEqual([])

      // two ledger rows, claimed notification, ONE notice per dedupe key, and no dispatch anywhere
      const rows = await healRows('coolify_deploy', `coolify:${INCIDENT.apps[0]}:%`)
      const rows2 = await healRows('coolify_deploy', `coolify:${INCIDENT.apps[1]}:%`)
      expect([...rows, ...rows2].map((r) => r.outcome)).toEqual(['no_routable_session', 'no_routable_session'])
      expect([...rows, ...rows2].every((r) => r.notification_claimed_at != null)).toBe(true)
      expect(sent.length - sentBefore).toBe(2)
      expect(dispatchCalls).toBe(0)
    })

    test('a duplicate webhook for the first app is terminal skipped/deduped: no third row, no further notification', async () => {
      const dupRun = randomUUID()
      await seedMetadataRun(dupRun, INCIDENT.apps[0], repoFor(INCIDENT.apps[0]), false)
      const sentBefore = sent.length
      const rowsBefore = await countOne(h.sql`SELECT count(*)::text AS n FROM heal_events WHERE user_id = ${h.userId} AND source = 'coolify_deploy'`)

      const started = Date.now()
      await dispatchTriage(h.userId, dupRun, payloadFor(INCIDENT.apps[0], repoFor(INCIDENT.apps[0])), {
        routeDeps: healDeps(),
        fetchLogSnippet: async () => 'e2e deploy log',
        resolveRepoKeyFromAppUuid: async () => null,
      })
      expect(Date.now() - started).toBeLessThan(5000)

      const r = await runRow(dupRun)
      expect([r.status, r.error]).toEqual(['skipped', 'deduped'])
      expect(await countOne(h.sql`SELECT count(*)::text AS n FROM heal_events WHERE user_id = ${h.userId} AND source = 'coolify_deploy'`)).toBe(rowsBefore)
      expect(sent.length).toBe(sentBefore)
      expect(await countOne(h.sql`SELECT count(*)::text AS n FROM scheduled_task_runs WHERE user_id = ${h.userId} AND status IN ('pending','in_flight')`)).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // V2 - the residual hole: an unrelated online session must never receive the failure
  // ---------------------------------------------------------------------------
  describe('V2: no dispatch into an unrelated session', () => {
    test('an online session bound to another repo gets zero frames and zero messages; outcome no_routable_session', async () => {
      const unrelated = await seedSession('github://finedesignz/e2e-heal-unrelated', 'e2e-heal-unrelated')
      const frames: string[] = []
      registerChannel(unrelated, h.userId, { send: (d: string) => void frames.push(d), close: () => {} } as any)
      try {
        const run = randomUUID()
        const app = 'v2app001'
        await seedMetadataRun(run, app, 'finedesignz/e2e-heal-nosession-v2', false)
        const event = await buildCoolifyHealEvent(h.userId, run, payloadFor(app, 'finedesignz/e2e-heal-nosession-v2'), {
          logSnippet: 'e2e deploy log',
          resolveRepoKeyFromAppUuid: async () => null,
        })
        dispatchCalls = 0
        const outcome = await routeHeal(event, healDeps())

        expect(outcome.kind).toBe('no_routable_session')
        expect(frames).toEqual([])
        expect(await countOne(h.sql`SELECT count(*)::text AS n FROM messages WHERE session_id = ${unrelated}`)).toBe(0)
        expect(dispatchCalls).toBe(0)
        const r = await runRow(run)
        expect([r.status, r.error]).toEqual(['skipped', 'no_routable_session'])
      } finally {
        unregisterChannel(unrelated)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // CONC - eight simultaneous events for one dedupe key
  // ---------------------------------------------------------------------------
  describe('concurrency: one dedupe key, eight simultaneous events', () => {
    test('exactly one ledger row, one notification, one non-deduped outcome, seven deduped, all metadata runs terminal', async () => {
      const app = 'concapp1'
      const repo = 'finedesignz/e2e-heal-nosession-conc'
      const runs = Array.from({ length: 8 }, () => randomUUID())
      for (const r of runs) await seedMetadataRun(r, app, repo, false)
      const events = await Promise.all(
        runs.map((r) =>
          buildCoolifyHealEvent(h.userId, r, payloadFor(app, repo), {
            logSnippet: 'e2e deploy log',
            resolveRepoKeyFromAppUuid: async () => null,
          }),
        ),
      )
      expect(new Set(events.map((e) => e.dedupe_key)).size).toBe(1)
      const sentBefore = sent.length

      const outcomes = await Promise.all(events.map((e) => routeHeal(e, healDeps())))

      expect(outcomes.filter((o) => o.kind === 'no_routable_session')).toHaveLength(1)
      expect(outcomes.filter((o) => o.kind === 'deduped')).toHaveLength(7)
      expect(await healRows('coolify_deploy', events[0]!.dedupe_key)).toHaveLength(1)
      expect(sent.length - sentBefore).toBe(1)
      const states = await Promise.all(runs.map((r) => runRow(r)))
      expect(states.every((s) => s.status === 'skipped')).toBe(true)
      expect(states.filter((s) => s.error === 'no_routable_session')).toHaveLength(1)
      expect(states.filter((s) => s.error === 'deduped')).toHaveLength(7)
    })
  })

  // ---------------------------------------------------------------------------
  // AUTO - governed autospawn ledger proofs
  // ---------------------------------------------------------------------------
  describe('autospawn ledger (heal flag + autospawn flag, orchestrator-enabled UNSET)', () => {
    async function offlineCandidate(slug: string) {
      const repoKey = `github://finedesignz/${slug}`
      const sessionId = await seedSession(repoKey, slug)
      await addRepoToAutospawnAllowlist(h.userId, repoKey)
      return { repoKey, sessionId, gitRepository: `finedesignz/${slug}` }
    }

    test('one governed launch: ledger row written, lifetime reservation left UNRELEASED, outcome autospawn_launched', async () => {
      process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
      delete process.env.REMO_ORCHESTRATOR_ENABLED
      const c = await offlineCandidate('e2e-heal-auto-ok')
      const run = randomUUID()
      await seedMetadataRun(run, 'autoapp1', c.gitRepository, false)
      const event = await buildCoolifyHealEvent(h.userId, run, payloadFor('autoapp1', c.gitRepository), {
        logSnippet: 'e2e deploy log',
        resolveRepoKeyFromAppUuid: async () => null,
      })
      launches.length = 0
      timers.length = 0

      const outcome = await routeHeal(
        event,
        healDeps({
          autospawn: autospawnDeps(),
          isChannelOnline: () => false,
          dispatch: async (req: unknown) => {
            parked.push(req)
            return { kind: 'parked_offline' }
          },
        }),
      )

      expect(outcome.kind).toBe('autospawn_launched')
      expect(launches).toHaveLength(1)
      expect(launches[0]).toMatchObject({ userId: h.userId, sessionId: c.sessionId, machine: true })
      expect(timers).toHaveLength(1) // exactly one deadline timer, no polling
      expect(parked).toHaveLength(1)

      expect(
        await countOne(
          h.sql`SELECT count(*)::text AS n FROM routine_run_log WHERE session_id = ${c.sessionId} AND command = 'autospawn-launch'`,
        ),
      ).toBe(1)

      const [ev] = await healRows('coolify_deploy', event.dedupe_key)
      expect(ev!.outcome).toBe('autospawn_launched')
      const [{ id: eventId }] = await h.sql<{ id: string }[]>`
        SELECT id FROM heal_events WHERE user_id = ${h.userId} AND dedupe_key = ${event.dedupe_key}
      `
      const key = buildHealKey(h.userId, c.repoKey)
      expect(
        await countOne(
          h.sql`SELECT count(*)::text AS n FROM automation_inject_ledger
                WHERE counter_key = ${key} AND token = ${'heal:' + eventId} AND kind = 'inject' AND released_at IS NULL`,
        ),
      ).toBe(1)
    })

    test('a failed launch releases the reservation and leaves the metadata run terminal', async () => {
      process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
      delete process.env.REMO_ORCHESTRATOR_ENABLED
      const c = await offlineCandidate('e2e-heal-auto-fail')
      const run = randomUUID()
      await seedMetadataRun(run, 'autoapp2', c.gitRepository, false)
      const event = await buildCoolifyHealEvent(h.userId, run, payloadFor('autoapp2', c.gitRepository), {
        logSnippet: 'e2e deploy log',
        resolveRepoKeyFromAppUuid: async () => null,
      })
      launchResult = { ok: false, reason: 'send_failed', error: 'e2e supervisor frame rejected' }
      launches.length = 0
      timers.length = 0
      const sentBefore = sent.length

      const outcome = await routeHeal(
        event,
        healDeps({
          autospawn: autospawnDeps(),
          isChannelOnline: () => false,
          dispatch: async () => {
            throw new Error('dispatch must not run after a failed launch')
          },
        }),
      )

      expect(outcome.kind).not.toBe('autospawn_launched')
      expect(launches).toHaveLength(1)
      expect(timers).toHaveLength(0) // no deadline timer for a launch that never happened

      const r = await runRow(run)
      expect(['skipped', 'failed']).toContain(r.status) // terminal, never pending
      expect(r.error).not.toBeNull()

      const [{ id: eventId }] = await h.sql<{ id: string }[]>`
        SELECT id FROM heal_events WHERE user_id = ${h.userId} AND dedupe_key = ${event.dedupe_key}
      `
      const key = buildHealKey(h.userId, c.repoKey)
      expect(
        await countOne(
          h.sql`SELECT count(*)::text AS n FROM automation_inject_ledger
                WHERE counter_key = ${key} AND token = ${'heal:' + eventId} AND released_at IS NULL`,
        ),
      ).toBe(0)
      expect(sent.length - sentBefore).toBe(1) // one owner notice for the failed event
      expect(await countOne(h.sql`SELECT count(*)::text AS n FROM scheduled_task_runs WHERE user_id = ${h.userId} AND status IN ('pending','in_flight') AND id = ${run}`)).toBe(0)
    })
  })
})
