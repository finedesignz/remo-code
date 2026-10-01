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

let aafCalls: any[] = []
let aafResult = true
mock.module('../src/agentautofix/reporter.ts', () => ({
  reportSelfErrorToAgentautofix: async (fields: any) => {
    aafCalls.push({ kind: 'self-error', fields })
  },
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

const { handleInternalTriageRun, extractDeploymentKey } = await import(
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
  })

  test('success with a parseable finding forwards to AAF, no owner email', async () => {
    await handleInternalTriageRun(makeArgs())
    expect(aafCalls.length).toBe(1)
    expect(aafCalls[0].kind).toBe('finding')
    expect(aafCalls[0].fields.errorValue).toContain('NoBuildFailureInLogs')
    expect(aafCalls[0].fields.errorValue).toContain('[triage low]')
    expect(emailFires.length).toBe(0)
    expect(claims.length).toBe(1)
    expect(claims[0]).toContain('4au6whenfchjugqfs3spppzf')
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

describe('extractDeploymentKey', () => {
  test('extracts an explicit deployment id from free text', () => {
    const key = extractDeploymentKey(
      {
        error_type: 'X',
        severity: 'low',
        root_cause: 'r',
        suggested_fix: 'Re-fetch the log for deployment 4au6whenfchjugqfs3spppzf please.',
        confidence: 0.5,
      } as any,
      '',
    )
    expect(key).toBe('4au6whenfchjugqfs3spppzf')
  })

  test('falls back to a content-based key with no extractable id', () => {
    const key = extractDeploymentKey(
      { error_type: 'LogFetchUnauthenticated', severity: 'medium', root_cause: 'bad token', suggested_fix: 'rotate it', confidence: 0.4 } as any,
      '',
    )
    expect(key).toContain('LogFetchUnauthenticated')
    expect(key).toContain('bad token')
  })
})
