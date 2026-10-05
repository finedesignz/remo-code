/**
 * fix/triage-task-email-noise: `__internal_triage` SUCCESS findings must
 * forward to AgentAutofix (never the owner's inbox), deduped per deployment,
 * with an owner-email fallback ONLY if the AAF forward itself fails.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x';
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x';

import { describe, test, expect, beforeEach } from 'bun:test'
import { mock } from 'bun:test'

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)

let claims: string[] = []
let claimResult = true
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  claimTriageFindingForward: async (userId: string, deploymentKey: string) => {
    claims.push(`${userId}:${deploymentKey}`)
    return claimResult
  },
}))

const realSTD = await import(`../src/db/scheduled-tasks-dal.ts?real=${Date.now()}`)
// runId → run row. Default: triage run 'run1' triggered by metadata run 'dep-run'
// which carries the real Coolify deployment_uuid.
let runs: Record<string, any> = {}
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realSTD,
  getRun: async (runId: string) => runs[runId] ?? null,
}))

let aafCalls: any[] = []
let aafResult = true
mock.module('../src/agentautofix/reporter.ts', () => ({
  reportSelfErrorToAgentautofix: async (fields: any) => {
    aafCalls.push({ kind: 'self-error', fields })
  },
  scrub: (t: string) => t.replace(/\bghp_[A-Za-z0-9_-]{10,}/g, '[REDACTED_TOKEN]'),
  reportTriageFindingToAgentautofix: async (fields: any) => {
    aafCalls.push({ kind: 'finding', fields })
    return aafResult
  },
}))

let emailFires: any[] = []
mock.module('../src/scheduler/post-run/email.ts', () => ({
  executeEmail: async (action: any, ctx: any) => {
    emailFires.push({ action, ctx })
  },
}))

const { handleInternalTriageRun, buildDefaultEmailActions } = await import(
  '../src/scheduler/post-run/dispatcher.ts'
)

function makeArgs(over: Partial<any> = {}) {
  return {
    task: { id: 't1', user_id: 'u1', name: '__internal_triage', task_type: 'triage' } as any,
    runId: 'run1',
    status: 'success' as const,
    error: null,
    cost_usd: 0,
    duration_ms: 1000,
    output_snippet: JSON.stringify({
      error_type: 'NoBuildFailureInLogs',
      severity: 'low',
      root_cause: 'The fetched log window did not contain the actual failing build step.',
      suggested_fix:
        'Re-fetch the full Coolify deployment log for deployment 4au6whenfchjugqfs3spppzf and re-run triage.',
      confidence: 0.6,
    }),
    parentFireId: null,
    chainDepth: 0,
    ...over,
  }
}

describe('handleInternalTriageRun', () => {
  beforeEach(() => {
    claims = []
    claimResult = true
    aafCalls = []
    aafResult = true
    emailFires = []
    runs = {
      run1: { id: 'run1', deployment_uuid: null, triggered_by_run_id: 'dep-run' },
      'dep-run': { id: 'dep-run', deployment_uuid: 'dpl-real-uuid-1' },
    }
  })

  test('success with a parseable finding forwards to AAF, no owner email', async () => {
    await handleInternalTriageRun(makeArgs())
    expect(aafCalls.length).toBe(1)
    expect(aafCalls[0].kind).toBe('finding')
    expect(aafCalls[0].fields.errorValue).toContain('NoBuildFailureInLogs')
    expect(aafCalls[0].fields.errorValue).toContain('[triage low]')
    expect(emailFires.length).toBe(0)
    expect(claims.length).toBe(1)
    expect(claims[0]).toBe('u1:dpl-real-uuid-1')
    expect(aafCalls[0].fields.errorValue).toContain('Deployment: dpl-real-uuid-1')
  })

  test('dedup key is the real deployment_uuid, never words from model prose', async () => {
    // Prose mentioning "deployment completed" / "deployment returned" must not
    // become the key (old regex grabbed ordinary words).
    await handleInternalTriageRun(
      makeArgs({
        output_snippet: JSON.stringify({
          error_type: 'BuildFailed',
          severity: 'medium',
          root_cause: 'The deployment returned exit 1; deployment container crashed.',
          suggested_fix: 'Fix the deployment pipeline.',
          confidence: 0.7,
        }),
      }),
    )
    expect(claims).toEqual(['u1:dpl-real-uuid-1'])
  })

  test('deployment_uuid on the triage run row itself is used directly', async () => {
    runs = { run1: { id: 'run1', deployment_uuid: 'dpl-own', triggered_by_run_id: null } }
    await handleInternalTriageRun(makeArgs())
    expect(claims).toEqual(['u1:dpl-own'])
  })

  test('no recoverable deployment_uuid → no dedup claim, finding still delivered', async () => {
    runs = { run1: { id: 'run1', deployment_uuid: null, triggered_by_run_id: null } }
    claimResult = false // would suppress if consulted
    await handleInternalTriageRun(makeArgs())
    expect(claims.length).toBe(0)
    expect(aafCalls.length).toBe(1)
    expect(aafCalls[0].kind).toBe('finding')
  })

  test('run lookup throwing → treated as no uuid, delivered', async () => {
    runs = new Proxy({}, { get() { throw new Error('db down') } }) as any
    await handleInternalTriageRun(makeArgs())
    expect(claims.length).toBe(0)
    expect(aafCalls.length).toBe(1)
  })

  test('a duplicate deployment (claim already taken) is not re-sent', async () => {
    claimResult = false
    await handleInternalTriageRun(makeArgs())
    expect(aafCalls.length).toBe(0)
    expect(emailFires.length).toBe(0)
    expect(claims.length).toBe(1)
  })

  test('an AAF failure falls back to email once', async () => {
    aafResult = false
    await handleInternalTriageRun(makeArgs())
    expect(aafCalls.length).toBe(1)
    expect(emailFires.length).toBe(1)
    expect(emailFires[0].action.config.subject).toContain('AAF forward failed')
    expect(emailFires[0].ctx.userId).toBe('u1')
  })

  test('fallback email body is scrubbed', async () => {
    aafResult = false
    await handleInternalTriageRun(
      makeArgs({
        output_snippet: JSON.stringify({
          error_type: 'AuthFailed',
          severity: 'low',
          root_cause: 'Token ghp_abcdefghijklmnopqrstuvwxyz was rejected.',
          suggested_fix: 'Rotate it.',
          confidence: 0.5,
        }),
      }),
    )
    expect(emailFires.length).toBe(1)
    expect(emailFires[0].action.config.body).not.toContain('ghp_abcdefghijklmnop')
    expect(emailFires[0].action.config.body).toContain('[REDACTED_TOKEN]')
  })

  test('high/critical: AAF failure does not send a second (fallback) email', async () => {
    aafResult = false
    await handleInternalTriageRun(
      makeArgs({
        output_snippet: JSON.stringify({
          error_type: 'OOMKilled',
          severity: 'critical',
          root_cause: 'r',
          suggested_fix: 's',
          confidence: 0.9,
        }),
      }),
    )
    expect(aafCalls.length).toBe(1)
    expect(emailFires.length).toBe(0) // owner already emailed via buildDefaultEmailActions
  })

  test('failure status keeps prior behavior: self-error forward, no finding forward, no email from this function', async () => {
    await handleInternalTriageRun(
      makeArgs({ status: 'failed', error: 'Coolify API returned 401', output_snippet: null }),
    )
    expect(aafCalls.length).toBe(1)
    expect(aafCalls[0].kind).toBe('self-error')
    expect(emailFires.length).toBe(0) // owner email for failure comes from buildDefaultEmailActions, not this fn
    expect(claims.length).toBe(0)
  })

  test('blocked (terminal Summary:) status keeps prior behavior: self-error forward', async () => {
    await handleInternalTriageRun(
      makeArgs({ status: 'success', output_snippet: 'Summary: BLOCKED: Coolify API returned HTTP 401' }),
    )
    expect(aafCalls.length).toBe(1)
    expect(aafCalls[0].kind).toBe('self-error')
    expect(claims.length).toBe(0)
  })

  test('success with unparseable output forwards nothing (no actionable JSON)', async () => {
    await handleInternalTriageRun(makeArgs({ output_snippet: 'triage ran cleanly, no JSON' }))
    expect(aafCalls.length).toBe(0)
    expect(emailFires.length).toBe(0)
    expect(claims.length).toBe(0)
  })

  test('non-root (chained) runs are ignored', async () => {
    await handleInternalTriageRun(makeArgs({ chainDepth: 1 }))
    expect(aafCalls.length).toBe(0)
    expect(claims.length).toBe(0)
  })

  test('non-internal-triage tasks are ignored', async () => {
    await handleInternalTriageRun(makeArgs({ task: { id: 't2', user_id: 'u1', name: 'Nightly' } as any }))
    expect(aafCalls.length).toBe(0)
    expect(claims.length).toBe(0)
  })
})

describe('buildDefaultEmailActions — internal triage severity', () => {
  const task = { id: 't1', user_id: 'u1', name: '__internal_triage', task_type: 'triage' } as any
  const finding = (severity: string) =>
    JSON.stringify({ error_type: 'X', severity, root_cause: 'r', suggested_fix: 's', confidence: 0.5 })

  for (const sev of ['high', 'critical']) {
    test(`success + ${sev} finding → emails owner`, () => {
      expect(buildDefaultEmailActions(task, 0, [], { status: 'success', output_snippet: finding(sev) }).length).toBe(1)
    })
  }
  for (const sev of ['low', 'medium']) {
    test(`success + ${sev} finding → silent`, () => {
      expect(buildDefaultEmailActions(task, 0, [], { status: 'success', output_snippet: finding(sev) })).toEqual([])
    })
  }
  test('high severity on a non-triage internal task stays silent', () => {
    const other = { ...task, name: '__internal_coolify_deployment' }
    expect(buildDefaultEmailActions(other, 0, [], { status: 'success', output_snippet: finding('high') })).toEqual([])
  })
})
