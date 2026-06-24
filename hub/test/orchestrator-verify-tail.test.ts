/**
 * Phase 27 (auto-dev-orchestrator) — terminal deploy/log-verify tail.
 *
 * All injectable (no DB, no network — every coolify/dispatch/run-log dep is a spy):
 *   1. log-scan detects error patterns vs clean logs (R-ADO-20).
 *   2. bounded fix loop runs AT MOST N=3 then surfaces — asserts it STOPS, never
 *      loops forever (R-ADO-21).
 *   3. deploy-verify-fail → fix dispatched → re-verify path; pass on a later pass.
 *   4. success-first-try → no fix dispatched, 1 iteration.
 *   5. flag-OFF dormancy (registerCycleRunnerIfEnabled returns false).
 *   6. missing-Coolify-config / missing-target → graceful `skipped` no-op.
 *   7. run-log entry written with the outcome on every path.
 *
 * appendRunLog is mock.module'd to a no-op spy (Bun mock.module is process-global —
 * restored in afterAll per the bun_mock_pollution hygiene note).
 */
import { describe, test, expect, afterEach, afterAll, mock } from 'bun:test'
import type {
  VerifyTailDeps,
  VerifyTarget,
  VerifyTailContext,
} from '../src/orchestrator/verify-tail.ts'
import type { DeployVerifyResult } from '../src/scheduler/deploy-verify-probe.ts'

let runLogCalls: any[] = []
mock.module('../src/orchestrator/run-log.ts', () => ({
  appendRunLog: async (entry: any) => {
    runLogCalls.push(entry)
    return { id: 'fake', created_at: new Date().toISOString(), ...entry }
  },
  recentRunLog: async () => [],
}))

const {
  runVerifyTail,
  scanLogForErrors,
  resolveVerifyTargetFromEnv,
  MAX_FIX_ITERATIONS,
} = await import('../src/orchestrator/verify-tail.ts')
const { registerCycleRunnerIfEnabled } = await import('../src/orchestrator/controller.ts')

afterEach(() => {
  runLogCalls = []
})
afterAll(() => {
  mock.restore()
})

const TARGET: VerifyTarget = {
  appUuid: 'app-uuid-1',
  baseUrl: 'https://app.example.com',
  routes: ['/api/sessions', '/openapi.json'],
}
const CTX: VerifyTailContext = {
  sessionId: 'sess-1',
  repoKey: 'owner/repo',
  userId: 'user-1',
  decisionRationale: 'tick',
}

function verifyResult(pass: boolean): DeployVerifyResult {
  return {
    healthOk: pass,
    healthPath: pass ? '/health' : null,
    healthStatus: pass ? 200 : 502,
    routes: [{ path: '/api/sessions', status: pass ? 401 : 502, verdict: pass ? 'pass' : 'fail', classification: pass ? 'mounted_auth' : 'runtime_broken' }],
    pass,
  }
}

/** Build a full spy deps set; override individual seams per test. */
function spyDeps(over: Partial<VerifyTailDeps> & { injectKind?: string } = {}): {
  deps: Partial<VerifyTailDeps>
  injectCalls: any[]
  notifyCalls: any[]
} {
  const injectCalls: any[] = []
  const notifyCalls: any[] = []
  const deps: Partial<VerifyTailDeps> = {
    configFromEnv: () => ({ token: 't', baseUrl: 'https://coolify' }),
    triggerRedeploy: async () => ({ ok: true, status: 200 }),
    fetchAppLogs: async () => ({ ok: true, status: 200, logs: 'all good\nstartup complete' }),
    runDeployVerify: async () => verifyResult(true),
    inject: async (input) => {
      injectCalls.push(input)
      return { kind: (over.injectKind as any) ?? 'dispatched' } as any
    },
    notify: async (input) => {
      notifyCalls.push(input)
    },
    ...over,
  }
  delete (deps as any).injectKind
  return { deps, injectCalls, notifyCalls }
}

// ── 1. log-scan ───────────────────────────────────────────────────────────────
describe('scanLogForErrors', () => {
  test('clean log → clean:true', () => {
    const r = scanLogForErrors('listening on 3040\nstartup complete\nrequest 200 ok')
    expect(r.clean).toBe(true)
    expect(r.matches.length).toBe(0)
  })
  test('detects error patterns', () => {
    const log = [
      'info: booted',
      'UnhandledPromiseRejection: boom',
      '    at handler (/app/x.ts:10:5)',
      'Error: ECONNREFUSED 127.0.0.1:5432',
      'FATAL could not bind',
    ].join('\n')
    const r = scanLogForErrors(log)
    expect(r.clean).toBe(false)
    expect(r.matches.length).toBeGreaterThanOrEqual(3)
  })
  test('empty/null log → clean', () => {
    expect(scanLogForErrors('').clean).toBe(true)
    expect(scanLogForErrors(null).clean).toBe(true)
    expect(scanLogForErrors('   \n  ').clean).toBe(true)
  })
  test('benign "0 errors" line not flagged', () => {
    expect(scanLogForErrors('summary: 0 errors, 0 warnings').clean).toBe(true)
  })
})

// ── 4. success first try ──────────────────────────────────────────────────────
test('success first try — pass, 1 iteration, no fix dispatched', async () => {
  const { deps, injectCalls } = spyDeps()
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('pass')
  expect(res.iterations).toBe(1)
  expect(injectCalls.length).toBe(0)
  expect(runLogCalls.length).toBe(1)
  expect(runLogCalls[0].outcome).toBe('verify_pass')
  expect(runLogCalls[0].command).toBe('deploy-verify')
})

// ── 3. fail → fix → re-verify → pass ──────────────────────────────────────────
test('fail then pass on 2nd pass — fix dispatched once', async () => {
  let pass = 0
  const { deps, injectCalls } = spyDeps({
    runDeployVerify: async () => verifyResult(pass++ >= 1),
  })
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('pass')
  expect(res.iterations).toBe(2)
  expect(injectCalls.length).toBe(1) // one fix dispatched between pass 1 and 2
  expect(runLogCalls[runLogCalls.length - 1].outcome).toBe('verify_pass')
})

// ── 2. bounded loop — never loops forever ─────────────────────────────────────
test('always-failing → bounded at N=3, surfaces, fails', async () => {
  let verifyCalls = 0
  const { deps, injectCalls, notifyCalls } = spyDeps({
    runDeployVerify: async () => {
      verifyCalls++
      return verifyResult(false)
    },
  })
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('fail')
  expect(res.iterations).toBe(MAX_FIX_ITERATIONS) // exactly 3, HARD cap
  expect(verifyCalls).toBe(MAX_FIX_ITERATIONS) // never re-runs past 3
  expect(injectCalls.length).toBe(MAX_FIX_ITERATIONS - 1) // fix between each non-final pass
  expect(notifyCalls.length).toBe(1) // surfaced exactly once
  expect(runLogCalls[runLogCalls.length - 1].outcome).toBe('verify_failed')
})

test('log errors alone (routes pass) still trigger fail path', async () => {
  const { deps, notifyCalls } = spyDeps({
    runDeployVerify: async () => verifyResult(true),
    fetchAppLogs: async () => ({ ok: true, status: 200, logs: 'FATAL boom\n    at x (/a.ts:1:1)' }),
  })
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('fail')
  expect(res.logClean).toBe(false)
  expect(notifyCalls.length).toBe(1)
})

// ── fix refused (cost cap) stops the loop early ───────────────────────────────
test('fix refused by cost cap → loop stops, no further verify', async () => {
  let verifyCalls = 0
  const { deps, injectCalls } = spyDeps({
    injectKind: 'refused_cost_cap',
    runDeployVerify: async () => {
      verifyCalls++
      return verifyResult(false)
    },
    inject: async (input) => {
      return { kind: 'refused_cost_cap', reason: 'over_daily_cost_cap' } as any
    },
  })
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('fail')
  expect(verifyCalls).toBe(1) // stopped after the refused fix — no re-verify
  expect(res.iterations).toBe(1)
})

// ── 6. missing config / target → skipped no-op ────────────────────────────────
test('missing Coolify config → skipped, run-log written, no crash', async () => {
  const { deps, injectCalls } = spyDeps({ configFromEnv: () => null })
  const res = await runVerifyTail(CTX, deps, TARGET)
  expect(res.verdict).toBe('skipped')
  expect(res.reason).toBe('no_coolify_config')
  expect(injectCalls.length).toBe(0)
  expect(runLogCalls.length).toBe(1)
  expect(runLogCalls[0].outcome).toContain('verify_skipped')
})

test('missing target (no env) → skipped no_verify_target', async () => {
  const prevUuid = process.env.REMO_VERIFY_APP_UUID
  const prevUrl = process.env.REMO_VERIFY_BASE_URL
  delete process.env.REMO_VERIFY_APP_UUID
  delete process.env.REMO_VERIFY_BASE_URL
  try {
    const { deps } = spyDeps()
    const res = await runVerifyTail(CTX, deps, null)
    expect(res.verdict).toBe('skipped')
    expect(res.reason).toBe('no_verify_target')
    expect(runLogCalls[0].outcome).toContain('no_verify_target')
  } finally {
    if (prevUuid !== undefined) process.env.REMO_VERIFY_APP_UUID = prevUuid
    if (prevUrl !== undefined) process.env.REMO_VERIFY_BASE_URL = prevUrl
  }
})

test('resolveVerifyTargetFromEnv reads env + default routes', () => {
  const prev = {
    u: process.env.REMO_VERIFY_APP_UUID,
    b: process.env.REMO_VERIFY_BASE_URL,
    r: process.env.REMO_VERIFY_ROUTES,
  }
  process.env.REMO_VERIFY_APP_UUID = 'uuid-x'
  process.env.REMO_VERIFY_BASE_URL = 'https://h.example.com/'
  delete process.env.REMO_VERIFY_ROUTES
  try {
    const t = resolveVerifyTargetFromEnv()
    expect(t).not.toBeNull()
    expect(t!.appUuid).toBe('uuid-x')
    expect(t!.baseUrl).toBe('https://h.example.com') // trailing slash stripped
    expect(t!.routes.length).toBeGreaterThan(0)
  } finally {
    for (const [k, v] of [['REMO_VERIFY_APP_UUID', prev.u], ['REMO_VERIFY_BASE_URL', prev.b], ['REMO_VERIFY_ROUTES', prev.r]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
})

// ── no userId → cannot dispatch fix; bounded fail without inject ───────────────
test('no userId → no fix dispatched, still bounded fail', async () => {
  const { deps, injectCalls } = spyDeps({ runDeployVerify: async () => verifyResult(false) })
  const res = await runVerifyTail({ ...CTX, userId: null }, deps, TARGET)
  expect(res.verdict).toBe('fail')
  expect(injectCalls.length).toBe(0)
  expect(res.iterations).toBe(1) // stops after first pass (can't inject a fix)
})

// ── 5. flag-OFF dormancy ──────────────────────────────────────────────────────
describe('flag-OFF dormancy', () => {
  test('REMO_ORCHESTRATOR_ENABLED unset → cycle-runner NOT registered', () => {
    const prev = process.env.REMO_ORCHESTRATOR_ENABLED
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    try {
      expect(registerCycleRunnerIfEnabled()).toBe(false)
    } finally {
      if (prev !== undefined) process.env.REMO_ORCHESTRATOR_ENABLED = prev
    }
  })
})
