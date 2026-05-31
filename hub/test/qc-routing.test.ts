import { describe, it, expect, mock, afterAll } from 'bun:test'

// Mock the chain executor + task lookup + idempotency BEFORE importing the
// dispatcher so the router under test uses our stubs. Cache-bust the import to
// avoid cross-file bun mock.module pollution (feedback_bun_mock_pollution).
const chainCalls: Array<{ taskId: string; depth: number }> = []
mock.module('../src/scheduler/post-run/chain.ts', () => ({
  executeChain: async (action: any, ctx: any) => {
    chainCalls.push({ taskId: action.config.task_id, depth: ctx.chainDepth })
  },
}))

// task_id → task_type for getTaskById stub.
const childTypes: Record<string, string> = {
  fix_task: 'qc_fix',
  verify_task: 'qc_verify',
}
const realSchedDal = await import('../src/db/scheduled-tasks-dal.ts')
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realSchedDal,
  getTaskById: async (id: string) =>
    childTypes[id] ? { id, task_type: childTypes[id] } : null,
  findQcReviewSnippetForRun: async () => null,
}))

// Idempotency: a configurable set of "already verified" hashes.
const verifiedHashes = new Set<string>()
const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  hasVerifiedFinding: async (_u: string, hash: string) => verifiedHashes.has(hash),
  recordVerifiedFinding: async () => {},
}))

const mod = await import('../src/scheduler/post-run/dispatcher.ts?qc-routing')
const { routeQcReviewDecision } = mod as {
  routeQcReviewDecision: (args: any, actions: any[]) => Promise<boolean>
}
const { findingHash } = await import('../src/scheduler/qc-schema.ts')

afterAll(() => mock.restore())

const FINDING_LINE =
  'finding: severity=high; file=hub/src/x.ts:42; finding_type=correctness; root_cause=rc; suggested_fix=sf'

function args(snippet: string, taskType = 'qc') {
  return {
    task: { id: 'root', user_id: 'u1', task_type: taskType, name: 'repo', payload: { repo: 'repo' } },
    runId: 'run1',
    status: 'success',
    error: null,
    cost_usd: null,
    duration_ms: null,
    output_snippet: snippet,
    parentFireId: null,
    chainDepth: 0,
  }
}

const edges = [{ type: 'chain_task', on: 'success', config: { task_id: 'fix_task' } }]
const block = (lines: string[]) => `<<FINDINGS\n${lines.join('\n')}\nFINDINGS`

describe('routeQcReviewDecision (auto-dev P4)', () => {
  it('≥1 finding → chains qc_fix, handled=true', async () => {
    chainCalls.length = 0
    verifiedHashes.clear()
    const handled = await routeQcReviewDecision(args(block([FINDING_LINE])), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([{ taskId: 'fix_task', depth: 0 }])
  })

  it('zero findings → no chain, finalize clean', async () => {
    chainCalls.length = 0
    const handled = await routeQcReviewDecision(args('Summary: QC review: clean'), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })

  it('malformed block → no actionable findings → no chain', async () => {
    chainCalls.length = 0
    const handled = await routeQcReviewDecision(args(block(['finding: garbage with no fields'])), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })

  it('all findings already verified within 24h → skipped → no chain', async () => {
    chainCalls.length = 0
    verifiedHashes.clear()
    const f = {
      severity: 'high' as const,
      file: 'hub/src/x.ts:42',
      finding_type: 'correctness' as const,
      root_cause: 'rc',
      suggested_fix: 'sf',
    }
    verifiedHashes.add(findingHash('repo', f))
    const handled = await routeQcReviewDecision(args(block([FINDING_LINE])), edges)
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })

  it('one verified + one new → still chains qc_fix (new finding actionable)', async () => {
    chainCalls.length = 0
    verifiedHashes.clear()
    const f = {
      severity: 'high' as const,
      file: 'hub/src/x.ts:42',
      finding_type: 'correctness' as const,
      root_cause: 'rc',
      suggested_fix: 'sf',
    }
    verifiedHashes.add(findingHash('repo', f))
    const out = await routeQcReviewDecision(
      args(
        block([
          FINDING_LINE, // verified, skipped
          'finding: severity=low; file=hub/src/new.ts:1; finding_type=reuse; root_cause=r; suggested_fix=s',
        ]),
      ),
      edges,
    )
    expect(out).toBe(true)
    expect(chainCalls).toEqual([{ taskId: 'fix_task', depth: 0 }])
  })

  it('findings but no qc_fix edge wired → safe no-op, no chain', async () => {
    chainCalls.length = 0
    verifiedHashes.clear()
    const handled = await routeQcReviewDecision(args(block([FINDING_LINE])), [
      { type: 'chain_task', on: 'success', config: { task_id: 'verify_task' } }, // wrong kind
    ])
    expect(handled).toBe(true)
    expect(chainCalls).toEqual([])
  })
})
