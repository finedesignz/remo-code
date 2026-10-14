/**
 * PTYCAP-05 plan 05, task 3 (D-10 i): the only auto-merge path refuses a repo that has an
 * armed or running proof run. Injectable deps only: no DB, no network, no mock.module.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMergeToMain, MERGE_COMMAND, type MergeDeps, type MergeRunContext } from '../src/orchestrator/merge-command.ts'

const FLAGS = ['REMO_ORCHESTRATOR_PROOF', 'REMO_ORCHESTRATOR_ENABLED', 'REMO_ORCHESTRATOR_AUTOSPAWN'] as const
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of FLAGS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
const flagsOn = () => {
  for (const k of FLAGS) process.env[k] = '1'
}

const ctx: MergeRunContext = { sessionId: 's1', userId: 'u1', repoKey: 'github://acme/proof', scheduleRule: null, tz: 'UTC' }

function mk(find?: MergeDeps['findActiveProofRunForRepo']) {
  const calls = { runLog: [] as any[], injected: [] as any[], find: [] as string[] }
  const deps: MergeDeps = {
    now: () => new Date('2026-10-13T03:00:00Z'),
    recentRunLog: async () => [{ session_id: 's1', command: 'execute', pr_url: 'https://gh/pr/1', reviewer_verdict: 'PASS', repo_key: ctx.repoKey }] as any,
    listUnconsumedApprovals: async () => [],
    markApprovalConsumed: async () => null as any,
    injectOrchestratorPrompt: async (i: any) => {
      calls.injected.push(i)
      return { kind: 'dispatched' } as any
    },
    notifyChatSurface: async () => {},
    appendRunLog: async (e: any) => {
      calls.runLog.push(e)
      return e
    },
    ...(find
      ? {
          findActiveProofRunForRepo: async (r: string) => {
            calls.find.push(r)
            return find(r)
          },
        }
      : {}),
  }
  return { deps, calls }
}

describe('runMergeToMain proof-repo refusal', () => {
  test('flag ON + armed/running proof run for the repo: refused, one run-log row, nothing injected', async () => {
    flagsOn()
    const { deps, calls } = mk(async () => ({ id: 'r1', status: 'running' }))
    const out = await runMergeToMain(ctx, deps)
    expect(out).toEqual({ kind: 'refused', reason: 'proof_repo_never_merges', held: [] })
    expect(calls.injected).toHaveLength(0)
    expect(calls.runLog).toHaveLength(1)
    expect(calls.runLog[0].command).toBe(MERGE_COMMAND)
    expect(calls.runLog[0].decision_rationale).toContain('proof_repo_never_merges')
    expect(calls.find).toEqual(['github://acme/proof'])
  })

  test('flag ON but no active proof run (other repo, or only terminal rows): existing behavior', async () => {
    flagsOn()
    const { deps, calls } = mk(async () => null)
    const out = await runMergeToMain(ctx, deps)
    expect(out.kind).toBe('dispatched')
    expect(calls.injected).toHaveLength(1)
  })

  test('flag OFF: the lookup is never consulted and behavior is unchanged', async () => {
    const { deps, calls } = mk(async () => ({ id: 'r1' }))
    const out = await runMergeToMain(ctx, deps)
    expect(out.kind).toBe('dispatched')
    expect(calls.find).toEqual([])
    expect(calls.injected).toHaveLength(1)
  })

  test('partial flag stack (proof ON only) is also a no-op', async () => {
    process.env.REMO_ORCHESTRATOR_PROOF = '1'
    const { deps, calls } = mk(async () => ({ id: 'r1' }))
    expect((await runMergeToMain(ctx, deps)).kind).toBe('dispatched')
    expect(calls.find).toEqual([])
  })

  test('flag ON + lookup error fails CLOSED: refused :unverifiable, nothing injected', async () => {
    flagsOn()
    const { deps, calls } = mk(async () => {
      throw new Error('db down')
    })
    const out = await runMergeToMain(ctx, deps)
    expect(out).toEqual({ kind: 'refused', reason: 'proof_repo_never_merges:unverifiable', held: [] })
    expect(calls.injected).toHaveLength(0)
    expect(calls.runLog).toHaveLength(1)
  })
})
