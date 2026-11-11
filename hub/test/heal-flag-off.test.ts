/**
 * PTYCAP-07-03 -- flag-OFF legacy effect-trace baseline (SC5, D-01, T-07-09).
 *
 * Characterizes the CURRENT behaviour of the four self-heal failure sources on
 * UNMODIFIED code, so that "REMO_HEAL_UNIFIED off == today, byte for byte" is
 * provable against a recorded baseline rather than asserted after the edits:
 *
 *   1. Coolify deploy failure   -> coolify-webhook.ts dispatchTriage
 *   2. error-capture            -> error-capture/dispatcher.ts dispatchPendingError
 *   3. feedback widget          -> feedback/dispatcher.ts dispatchFeedback
 *   4. scheduled-task failure   -> scheduler/post-run/dispatcher.ts buildDefaultEmailActions
 *
 * Every scenario is looped over the NON-ON flag values (unset, "", "0", "false",
 * "maybe", "garbage"); the later rewiring plans re-run this file unchanged as the
 * flag-OFF proof. Expected traces are literal arrays written from the source as
 * it is NOW -- never recomputed from the code under test. The legacy orphan
 * behaviour (a storm-dedupe drop leaves the metadata run un-finalized) is
 * recorded AS-IS, not endorsed.
 *
 * This file must not import anything from hub/src/heal (it does not exist yet at
 * baseline time). DB-free: dal / postgres / registry / dispatcher / pipeline are
 * mocked. Bun mock.module is process-global; real modules are cache-busted and
 * spread so unmocked exports stay defined, and afterAll(mock.restore) undoes it.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Pure helper: loaded BEFORE any module mock below so it binds the real graph.
const { buildDefaultEmailActions } = await import('../src/scheduler/post-run/dispatcher.ts')

// Non-ON flag values. `undefined` = the variable is deleted (unset).
const FLAG_VALUES: Array<string | undefined> = [undefined, '', '0', 'false', 'maybe', 'garbage']
const flagLabel = (v: string | undefined) => (v === undefined ? 'unset' : JSON.stringify(v))

function applyFlag(v: string | undefined): void {
  if (v === undefined) delete process.env.REMO_HEAL_UNIFIED
  else process.env.REMO_HEAL_UNIFIED = v
}

// ---------------------------------------------------------------------------
// Shared recorded state
// ---------------------------------------------------------------------------
type Call = { c: string; a: unknown[] }
const trace: Call[] = []
const rec = (c: string, ...a: unknown[]) => { trace.push({ c, a }) }

const sc: {
  claim: 'fresh' | 'duplicate' | 'throws'
  repoKeyed: { agent_session_id: string; repo_key: string } | null
  probeThrows: boolean
  online: string[]
  dispatchOutcome: any
  dispatchCalls: Array<{ req: any; deps: any }>
  errorStatuses: Array<[string, string, string | undefined]>
  errorBroadcasts: any[]
} = {
  claim: 'fresh',
  repoKeyed: null,
  probeThrows: false,
  online: [],
  dispatchOutcome: { kind: 'dispatched', runId: 'run-1' },
  dispatchCalls: [],
  errorStatuses: [],
  errorBroadcasts: [],
}

const ERROR_ROW = {
  id: 'err-1', project_id: 'proj-1', fingerprint: 'fp-1', error_type: 'TypeError',
  error_value: 'x is not a function', stacktrace_json: [], release: null,
  received_at: new Date().toISOString(), dispatch_status: 'pending', dispatched_at: null, skip_reason: null,
}
const PROJECT = {
  id: 'proj-1', user_id: 'user-1', name: 'demo-app', sentry_key: 'sk_demo', session_id: 'sess-1',
  dedupe_window_seconds: 60, rate_limit_per_hour: 20, daily_dispatch_cap: 50, enabled: true,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}

// ---------------------------------------------------------------------------
// Module mocks (real modules cache-busted + spread)
// ---------------------------------------------------------------------------
const realDal = await import(`../src/db/dal.ts?bust=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  claimDeployFailure: async (...a: unknown[]) => {
    rec('claimDeployFailure', ...a)
    if (sc.claim === 'throws') throw new Error('claim_boom')
    return sc.claim === 'fresh'
  },
  ensureInternalTriageTask: async (...a: unknown[]) => {
    rec('ensureInternalTriageTask', ...a)
    return 'task-internal-triage'
  },
  insertMessage: async () => ({ id: 'msg-1', created_at: new Date().toISOString() }),
}))

const realPg = await import(`../src/db/postgres.ts?bust=${Date.now()}`)
mock.module('../src/db/postgres.ts', () => ({
  ...realPg,
  sql: async (strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings)
    if (text.includes('FROM errors')) return [ERROR_ROW]
    if (text.includes('FROM error_projects')) return [PROJECT]
    return []
  },
}))

const realEcDal = await import(`../src/db/error-capture-dal.ts?bust=${Date.now()}`)
mock.module('../src/db/error-capture-dal.ts', () => ({
  ...realEcDal,
  updateErrorDispatchStatus: async (id: string, status: string, reason?: string) => {
    sc.errorStatuses.push([id, status, reason])
  },
}))

mock.module('../src/scheduler/dispatcher.ts', () => ({
  runNow: async (...a: unknown[]) => { rec('runNow', ...a); return { skipped: false } },
  finalizeRun: async (...a: unknown[]) => { rec('finalizeRun', ...a) },
}))

mock.module('../src/sessions/repo-routing.ts', () => ({
  hasActiveSessionForRepo: async () => false,
  resolveRepoKeyedAgentSession: async (...a: unknown[]) => {
    rec('resolveRepoKeyedAgentSession', ...a)
    if (sc.probeThrows) throw new Error('probe_boom')
    return sc.repoKeyed
  },
}))

const realReg = await import(`../src/ws/registry.ts?bust=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realReg,
  listOnlineAgentSessionsForUser: (...a: unknown[]) => { rec('listOnlineAgentSessionsForUser', ...a); return sc.online },
  getChannel: () => ({ ws: { send() {} } }),
  broadcastErrorEvent: (_userId: string, event: any) => { sc.errorBroadcasts.push(event) },
}))

const realCc = await import(`../src/lib/coolify-client.ts?bust=${Date.now()}`)
mock.module('../src/lib/coolify-client.ts', () => ({
  ...realCc,
  coolifyConfigFromEnv: () => ({ fake: true }),
  fetchAppLogs: async (...a: unknown[]) => { rec('fetchAppLogs', ...a); return { ok: true, status: 200, logs: 'LOGS' } },
}))

const realPipeline = await import(`../src/dispatch/pipeline.ts?bust=${Date.now()}`)
mock.module('../src/dispatch/pipeline.ts', () => ({
  ...realPipeline,
  dispatch: async (req: any, deps: any) => {
    sc.dispatchCalls.push({ req, deps })
    return sc.dispatchOutcome
  },
}))

// Import AFTER mocks.
const { dispatchTriage } = await import('../src/api/coolify-webhook.ts')
const { dispatchPendingError } = await import('../src/error-capture/dispatcher.ts')
const { dispatchFeedback } = await import('../src/feedback/dispatcher.ts')

afterAll(() => { delete process.env.REMO_HEAL_UNIFIED; mock.restore() })

function resetScenario(): void {
  trace.length = 0
  sc.claim = 'fresh'
  sc.repoKeyed = null
  sc.probeThrows = false
  sc.online = []
  sc.dispatchOutcome = { kind: 'dispatched', runId: 'run-1' }
  sc.dispatchCalls = []
  sc.errorStatuses = []
  sc.errorBroadcasts = []
}

// ---------------------------------------------------------------------------
// 1. Coolify -- dispatchTriage
// ---------------------------------------------------------------------------
const COOLIFY_PAYLOAD = {
  event: 'deployment.failed' as const,
  deployment_uuid: 'dep-1',
  application_uuid: 'app-1',
  git_repository: 'owner/repo',
  commit_sha: 'abc123',
}
const anyStr = expect.any(String)
const CLAIM = { c: 'claimDeployFailure', a: ['user-1', 'app-1', anyStr, anyStr] }
const RESOLVE = { c: 'resolveRepoKeyedAgentSession', a: ['user-1', 'owner/repo', 'app-1'] }
const LOGS = { c: 'fetchAppLogs', a: [{ fake: true }, 'app-1', { lines: 400 }] }
const ENSURE = { c: 'ensureInternalTriageTask', a: ['user-1'] }
const RUN_NOW = {
  c: 'runNow',
  a: [
    'task-internal-triage',
    'user-1',
    {
      triggeredByRunId: 'run-meta-1',
      chainDepth: 0,
      isManual: true,
      payloadOverride: {
        application_uuid: 'app-1',
        deployment_uuid: 'dep-1',
        git_repository: 'owner/repo',
        commit_sha: 'abc123',
        log_snippet: 'LOGS',
      },
    },
  ],
}

for (const flag of FLAG_VALUES) {
  describe(`legacy Coolify dispatchTriage [REMO_HEAL_UNIFIED=${flagLabel(flag)}]`, () => {
    beforeEach(() => { resetScenario(); applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    test('(a) fresh failure + repo-keyed live session -> claim, probe, logs, ensure task, runNow; never finalizeRun', async () => {
      sc.repoKeyed = { agent_session_id: 'sess-repo', repo_key: 'owner/repo' }
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([CLAIM, RESOLVE, LOGS, ENSURE, RUN_NOW])
      const [claim] = trace
      expect(claim.a[2]).not.toBe(claim.a[3]) // current vs previous bucket fingerprint differ
      expect(trace.some((t) => t.c === 'finalizeRun')).toBe(false)
    })

    test('(a2) no repo-keyed session but an online agent session -> still dispatches (no finalize)', async () => {
      sc.online = ['sess-live']
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([
        CLAIM, RESOLVE, { c: 'listOnlineAgentSessionsForUser', a: ['user-1'] }, LOGS, ENSURE, RUN_NOW,
      ])
    })

    test('(b) duplicate (claim false) -> nothing else called; metadata run NOT finalized (legacy orphan, recorded as-is)', async () => {
      sc.claim = 'duplicate'
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([CLAIM])
      expect(trace.some((t) => t.c === 'finalizeRun')).toBe(false)
    })

    test('(c) no repo-keyed session and zero online agent sessions -> finalizeRun skipped/no_routable_session once, no runNow', async () => {
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([
        CLAIM,
        RESOLVE,
        { c: 'listOnlineAgentSessionsForUser', a: ['user-1'] },
        { c: 'finalizeRun', a: ['run-meta-1', 'skipped', 'no_routable_session'] },
      ])
      expect(trace.filter((t) => t.c === 'finalizeRun')).toHaveLength(1)
      expect(trace.some((t) => t.c === 'runNow')).toBe(false)
    })

    test('(d) claimDeployFailure throws -> fails open, dispatch still happens', async () => {
      sc.claim = 'throws'
      sc.repoKeyed = { agent_session_id: 'sess-repo', repo_key: 'owner/repo' }
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([CLAIM, RESOLVE, LOGS, ENSURE, RUN_NOW])
    })

    test('(e) routability probe throws -> dispatches anyway (never finalizes)', async () => {
      sc.probeThrows = true
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([CLAIM, RESOLVE, LOGS, ENSURE, RUN_NOW])
      expect(trace.some((t) => t.c === 'finalizeRun')).toBe(false)
    })
  })
}

// ---------------------------------------------------------------------------
// 2. error-capture -- dispatchPendingError
// ---------------------------------------------------------------------------
const LEGACY_GATE_NAMES = [
  'automation_kill_switch',
  'threshold',
  'daily_cost_cap',
  'daily_token_cap',
  'session_inject_rate',
]

for (const flag of FLAG_VALUES) {
  describe(`legacy error-capture dispatchPendingError [REMO_HEAL_UNIFIED=${flagLabel(flag)}]`, () => {
    beforeEach(() => { resetScenario(); applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    test('gate-name order, ensureOnline supplied, request shape without counterKey, dispatched side effects', async () => {
      const out = await dispatchPendingError('err-1')

      expect(sc.dispatchCalls).toHaveLength(1)
      const { req, deps } = sc.dispatchCalls[0]
      expect(deps.gates.map((g: any) => g.name)).toEqual(LEGACY_GATE_NAMES)
      expect(typeof deps.ensureOnline).toBe('function')

      expect(req.userId).toBe('user-1')
      expect(req.sessionId).toBe('sess-1')
      expect(req.token).toBe('err-1')
      expect(typeof req.prompt).toBe('string')
      expect('counterKey' in req).toBe(false)
      expect(Object.keys(req).sort()).toEqual(['prompt', 'sessionId', 'token', 'userId'])

      // 'dispatched' outcome: status updated exactly as the existing switch does.
      expect(out).toEqual({ status: 'dispatched', run_id: 'run-1' })
      expect(sc.errorStatuses).toEqual([['err-1', 'dispatched', undefined]])
      expect(sc.errorBroadcasts).toHaveLength(1)
      expect(sc.errorBroadcasts[0]).toMatchObject({
        type: 'error_dispatched', error_id: 'err-1', project_id: 'proj-1', run_id: 'run-1',
      })
    })
  })
}

// ---------------------------------------------------------------------------
// 3. feedback -- dispatchFeedback
// ---------------------------------------------------------------------------
const SCREENSHOT = { media_type: 'image/png', data: 'AAAA' }

for (const flag of FLAG_VALUES) {
  describe(`legacy feedback dispatchFeedback [REMO_HEAL_UNIFIED=${flagLabel(flag)}]`, () => {
    beforeEach(() => { resetScenario(); applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    test('gate-name order, ensureOnline supplied, token = submission id, images passthrough, no counterKey', async () => {
      const out = await dispatchFeedback({
        submissionId: 'sub-1', userId: 'user-1', sessionId: 'sess-1', comment: 'it broke', screenshot: SCREENSHOT,
      })

      expect(sc.dispatchCalls).toHaveLength(1)
      const { req, deps } = sc.dispatchCalls[0]
      expect(deps.gates.map((g: any) => g.name)).toEqual(LEGACY_GATE_NAMES)
      expect(typeof deps.ensureOnline).toBe('function')

      expect(req.userId).toBe('user-1')
      expect(req.sessionId).toBe('sess-1')
      expect(req.token).toBe('sub-1')
      expect(req.images).toEqual([SCREENSHOT])
      expect('counterKey' in req).toBe(false)
      expect(Object.keys(req).sort()).toEqual(['images', 'prompt', 'sessionId', 'token', 'userId'])

      expect(out).toEqual({ status: 'dispatched', run_id: 'run-1' })
    })

    test('no screenshot -> images undefined, still no counterKey', async () => {
      await dispatchFeedback({ submissionId: 'sub-2', userId: 'user-1', sessionId: 'sess-1', comment: 'no shot' })
      const { req } = sc.dispatchCalls[0]
      expect(req.images).toBeUndefined()
      expect(req.token).toBe('sub-2')
      expect('counterKey' in req).toBe(false)
    })
  })
}

// ---------------------------------------------------------------------------
// 4. scheduled-task failure email -- buildDefaultEmailActions (no heal involved)
// ---------------------------------------------------------------------------
const FAILED = { status: 'failed' as const, output_snippet: null }
const SUCCESS = { status: 'success' as const, output_snippet: 'Summary: all good' }

for (const flag of FLAG_VALUES) {
  describe(`legacy scheduled-task failure email [REMO_HEAL_UNIFIED=${flagLabel(flag)}]`, () => {
    beforeEach(() => { applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    const rootTask = { id: 't1', user_id: 'u1', name: 'Nightly', email_summary: true } as any

    test('failed root run (chainDepth 0) -> exactly one notify_email', () => {
      const out = buildDefaultEmailActions(rootTask, 0, [], FAILED)
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe('notify_email')
      expect(out[0].on).toBe('always')
    })

    test('failed __internal_triage run -> exactly one notify_email', () => {
      const t = { id: 't2', user_id: 'u1', name: '__internal_triage', email_summary: true } as any
      const out = buildDefaultEmailActions(t, 0, [], FAILED)
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe('notify_email')
    })

    test('successful __internal_ run -> none', () => {
      const dep = { id: 't3', user_id: 'u1', name: '__internal_coolify_deployment', email_summary: true } as any
      const tri = { id: 't2', user_id: 'u1', name: '__internal_triage', email_summary: true } as any
      expect(buildDefaultEmailActions(dep, 0, [], SUCCESS)).toEqual([])
      expect(buildDefaultEmailActions(tri, 0, [], SUCCESS)).toEqual([])
    })

    test('email_summary=false -> none, even for a failed run', () => {
      const t = { ...rootTask, email_summary: false }
      expect(buildDefaultEmailActions(t, 0, [], FAILED)).toEqual([])
    })

    test('task already configuring notify_email -> no duplicate synthesized', () => {
      const existing = [{ type: 'notify_email', on: 'failure', config: { subject: 's', body: 'b' } }] as any
      expect(buildDefaultEmailActions(rootTask, 0, existing, FAILED)).toEqual([])
    })
  })
}

// ---------------------------------------------------------------------------
// 5. Static import hygiene: flag-OFF loading must stay unchanged after rewiring.
//    Only the flag reader, the event builder and LAZY dynamic imports may
//    reference the heal tree; no top-level import of heal/route or heal/sinks.
// ---------------------------------------------------------------------------
const STATIC_HEAL_IMPORT = [
  /(^|\s)from\s+['"][^'"]*heal\/(route|sinks)[^'"]*['"]/m,
  /^import\s+['"][^'"]*heal\/(route|sinks)[^'"]*['"]/m,
]
const hasStaticHealImport = (src: string) => STATIC_HEAL_IMPORT.some((re) => re.test(src))

describe('flag-OFF static import hygiene', () => {
  const SRC_FILES = [
    'src/api/coolify-webhook.ts',
    'src/error-capture/dispatcher.ts',
    'src/feedback/dispatcher.ts',
    'src/scheduler/dispatcher.ts',
  ]

  test('the detector flags a static heal/route or heal/sinks import (positive control)', () => {
    expect(hasStaticHealImport(`import { routeHeal } from '../heal/route.ts'`)).toBe(true)
    expect(hasStaticHealImport(`import {\n  a,\n} from '../heal/sinks.ts'`)).toBe(true)
    expect(hasStaticHealImport(`import '../heal/sinks.ts'`)).toBe(true)
    expect(hasStaticHealImport(`const m = await import('../heal/route.ts')`)).toBe(false)
    expect(hasStaticHealImport(`import { healEnabled } from '../heal/flag.ts'`)).toBe(false)
  })

  for (const rel of SRC_FILES) {
    test(`${rel} has no static import of the heal route or sinks`, () => {
      const src = readFileSync(resolve(import.meta.dir, '..', rel), 'utf8')
      expect(hasStaticHealImport(src)).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// 6. PTYCAP-07-10 (SC5, SH-07, D-01): the final flag matrix. routeHeal is spied (the real module is
//    spread, only the entry function is replaced). OFF = every value that is not 1|true|yes|on
//    (trimmed, case-insensitive): routeHeal is NEVER invoked by any of the four entry points and the
//    legacy traces are unchanged. ON = the same four entry points call routeHeal exactly once per
//    eligible input: the flag is the only switch. The finalizeRun failed-run path is driven through
//    the REAL scheduler dispatcher (loaded under a query so the file-level dispatcher mock does not
//    apply) with its leaves mocked.
// ---------------------------------------------------------------------------
const routeCalls: unknown[] = []
const healTaskCalls: unknown[] = []
const afterRunArgs: any[] = []

const realRouteMod = await import(`../src/heal/route.ts?bust=${Date.now()}`)
mock.module('../src/heal/route.ts', () => ({
  ...realRouteMod,
  routeHeal: async (event: unknown) => {
    routeCalls.push(event)
    return { kind: 'dispatched_live' }
  },
}))
const realSchedSource = await import(`../src/heal/sources/scheduled-task.ts?bust=${Date.now()}`)
mock.module('../src/heal/sources/scheduled-task.ts', () => ({
  ...realSchedSource,
  healFailedScheduledRun: async (input: unknown) => {
    healTaskCalls.push(input)
    return false
  },
}))
const realStDalMod = await import(`../src/db/scheduled-tasks-dal.ts?bust=${Date.now()}`)
const FINAL_TASK = { id: 't1', name: 'nightly-sync', user_id: 'u1', session_id: 's1', is_internal: false }
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realStDalMod,
  updateRunStatus: async () => ({ user_id: 'u1', task_id: 't1' }),
  getTaskById: async () => FINAL_TASK,
}))
const realPostRunMod = await import(`../src/scheduler/post-run/dispatcher.ts?bust=${Date.now()}`)
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  ...realPostRunMod,
  afterRun: async (args: any) => { afterRunArgs.push(args) },
}))
const { finalizeRun: realFinalizeRun } = await import(`../src/scheduler/dispatcher.ts?real=${Date.now()}`)

const OFF_VALUES: Array<string | undefined> = [undefined, '', '0', 'false', 'no', 'off', 'maybe', 'garbage', '2', 'onn', '10']
const ON_VALUES: string[] = ['1', 'true', 'yes', 'on', 'ON', 'True', 'YES', 'On', ' on ', ' 1 ']

function resetFinalMatrix(): void {
  resetScenario()
  routeCalls.length = 0
  healTaskCalls.length = 0
  afterRunArgs.length = 0
}

async function driveAllFour(): Promise<void> {
  await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD, {
    fetchLogSnippet: async () => 'LOGS',
    resolveRepoKeyFromAppUuid: async () => null,
  })
  await dispatchPendingError('err-1')
  await dispatchFeedback({ submissionId: 'sub-m', userId: 'user-1', sessionId: 'sess-1', comment: 'matrix' })
  await realFinalizeRun('run-m', 'failed', 'boom')
}

for (const flag of OFF_VALUES) {
  describe(`final flag-OFF proof [REMO_HEAL_UNIFIED=${flagLabel(flag)}]`, () => {
    beforeEach(() => { resetFinalMatrix(); applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    test('routeHeal and the scheduled-task source are never invoked by any entry point', async () => {
      await driveAllFour()
      expect(routeCalls).toHaveLength(0)
      expect(healTaskCalls).toHaveLength(0)
    })

    test('the legacy traces are unchanged (Coolify trace, one legacy dispatch each, plain failed post-run)', async () => {
      sc.repoKeyed = { agent_session_id: 'sess-repo', repo_key: 'owner/repo' }
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD)
      expect(trace).toEqual([CLAIM, RESOLVE, LOGS, ENSURE, RUN_NOW])
      sc.dispatchCalls = []
      await dispatchPendingError('err-1')
      await dispatchFeedback({ submissionId: 'sub-m', userId: 'user-1', sessionId: 'sess-1', comment: 'x' })
      expect(sc.dispatchCalls).toHaveLength(2)
      for (const { deps } of sc.dispatchCalls) expect(deps.gates.map((g: any) => g.name)).toEqual(LEGACY_GATE_NAMES)
      await realFinalizeRun('run-m', 'failed', 'boom')
      expect(afterRunArgs).toHaveLength(1)
      expect('suppressDefaultFailureEmail' in afterRunArgs[0]).toBe(false)
      expect(routeCalls).toHaveLength(0)
    })
  })
}

for (const flag of ON_VALUES) {
  describe(`final flag-ON proof [REMO_HEAL_UNIFIED=${JSON.stringify(flag)}]`, () => {
    beforeEach(() => { resetFinalMatrix(); applyFlag(flag) })
    afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

    test('Coolify, error-capture and feedback each call routeHeal exactly once; no legacy dispatch', async () => {
      await dispatchTriage('user-1', 'run-meta-1', COOLIFY_PAYLOAD, {
        fetchLogSnippet: async () => 'LOGS',
        resolveRepoKeyFromAppUuid: async () => null,
      })
      expect(routeCalls).toHaveLength(1)
      await dispatchPendingError('err-1')
      expect(routeCalls).toHaveLength(2)
      await dispatchFeedback({ submissionId: 'sub-m', userId: 'user-1', sessionId: 'sess-1', comment: 'matrix' })
      expect(routeCalls).toHaveLength(3)
      expect(sc.dispatchCalls).toHaveLength(0)
      expect(trace.some((t) => t.c === 'claimDeployFailure' || t.c === 'runNow')).toBe(false)
    })

    test('a failed scheduled run reaches the scheduled-task heal source exactly once', async () => {
      await realFinalizeRun('run-m', 'failed', 'boom')
      expect(healTaskCalls).toHaveLength(1)
      expect(afterRunArgs).toHaveLength(1)
    })
  })
}

describe('the flag is read at call time', () => {
  beforeEach(() => { resetFinalMatrix(); delete process.env.REMO_HEAL_UNIFIED })
  afterEach(() => { delete process.env.REMO_HEAL_UNIFIED })

  test('flipping the env between two calls in one process switches behaviour', async () => {
    const sub = { submissionId: 'sub-f', userId: 'user-1', sessionId: 'sess-1', comment: 'flip' }
    await dispatchFeedback(sub)
    expect(routeCalls).toHaveLength(0)
    expect(sc.dispatchCalls).toHaveLength(1)
    process.env.REMO_HEAL_UNIFIED = 'on'
    await dispatchFeedback(sub)
    expect(routeCalls).toHaveLength(1)
    expect(sc.dispatchCalls).toHaveLength(1)
    process.env.REMO_HEAL_UNIFIED = 'off'
    await dispatchFeedback(sub)
    expect(routeCalls).toHaveLength(1)
    expect(sc.dispatchCalls).toHaveLength(2)
  })

  test('a non-failed scheduled finalize never reaches the heal source even when ON', async () => {
    process.env.REMO_HEAL_UNIFIED = '1'
    await realFinalizeRun('run-m', 'success', null)
    expect(healTaskCalls).toHaveLength(0)
    expect(afterRunArgs).toHaveLength(1)
  })
})
