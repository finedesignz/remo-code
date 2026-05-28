/**
 * Merge gate orchestration tests.
 *
 * Mocks `diff-sandbox.getSandboxDiff` so the gate runs without spawning git.
 * Mocks `MergeOps` so PR opening + squash-merge are observable in-process.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// Mock the shell-out before importing merge-gate.
const fakeDiffs: Record<string, string> = {}

mock.module('../src/revanote/diff-sandbox.ts', () => {
  const actual = require('../src/revanote/diff-sandbox.ts')
  return {
    ...actual,
    getSandboxDiff: async (dir: string) => fakeDiffs[dir] ?? '',
  }
})

import { runMergeGate, _resetBatchState, applyGateToCallback, type MergeOps } from '../src/revanote/merge-gate'

function makeMergeOps(): MergeOps & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    async openPr(opts) {
      calls.push({ kind: 'openPr', ...opts })
      return `https://github.com/${opts.repoSlug}/pull/${calls.length}`
    },
    async squashMerge(opts) {
      calls.push({ kind: 'squashMerge', ...opts })
      return opts.prUrl + '/merged'
    },
    async ciGreen() {
      return true
    },
  }
}

const cssOnlyDiff = `diff --git a/src/styles.css b/src/styles.css
index abc..def 100644
--- a/src/styles.css
+++ b/src/styles.css
@@ -1 +1 @@
-.btn { color: red; }
+.btn { color: blue; }
`

const envDiff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`

const migrationDiff = `diff --git a/migrations/0001.sql b/migrations/0001.sql
new file mode 100644
--- /dev/null
+++ b/migrations/0001.sql
@@ -0,0 +1 @@
+ALTER TABLE foo ADD COLUMN x int;
`

describe('runMergeGate', () => {
  beforeEach(() => {
    _resetBatchState()
    for (const k of Object.keys(fakeDiffs)) delete fakeDiffs[k]
  })

  test('clean + minor single-shot → auto_merged', async () => {
    const dir = '/tmp/sb-a'
    fakeDiffs[dir] = cssOnlyDiff
    const ops = makeMergeOps()
    const out = await runMergeGate({
      batchId: null,
      batchSize: null,
      annotationId: 'ann1',
      sandboxDir: dir,
      repoSlug: 'acme/site',
      needsClarification: false,
      resolved: true,
      mergeOps: ops,
    })
    expect(out.decision).toBe('auto_merged')
    expect(out.riskClass).toBe('minor')
    expect(out.prUrl).toContain('/merged')
    expect(ops.calls.find((c) => c.kind === 'squashMerge')).toBeDefined()
  })

  test('clean + major → pr_opened (no merge)', async () => {
    const dir = '/tmp/sb-b'
    fakeDiffs[dir] = migrationDiff
    const ops = makeMergeOps()
    const out = await runMergeGate({
      batchId: null,
      batchSize: null,
      annotationId: 'ann2',
      sandboxDir: dir,
      repoSlug: 'acme/site',
      needsClarification: false,
      resolved: true,
      mergeOps: ops,
    })
    expect(out.decision).toBe('pr_opened')
    expect(out.riskClass).toBe('major')
    expect(ops.calls.some((c) => c.kind === 'squashMerge')).toBe(false)
  })

  test('dirty (.env touched) → blocked', async () => {
    const dir = '/tmp/sb-c'
    fakeDiffs[dir] = envDiff
    const ops = makeMergeOps()
    const out = await runMergeGate({
      batchId: null,
      batchSize: null,
      annotationId: 'ann3',
      sandboxDir: dir,
      repoSlug: 'acme/site',
      needsClarification: false,
      resolved: true,
      mergeOps: ops,
    })
    expect(out.decision).toBe('blocked')
    expect(out.riskClass).toBeNull()
    expect(out.reasons.some((r) => r.startsWith('blocked_path'))).toBe(true)
    expect(ops.calls.length).toBe(0)
  })

  test('batched: holds until all reports arrive, then auto-merges', async () => {
    const ops = makeMergeOps()
    const batchId = '11111111-1111-1111-1111-111111111111'
    const dirA = '/tmp/sb-d-a'
    const dirB = '/tmp/sb-d-b'
    fakeDiffs[dirA] = cssOnlyDiff
    fakeDiffs[dirB] = cssOnlyDiff

    const out1 = await runMergeGate({
      batchId, batchSize: 2, annotationId: 'ann-a',
      sandboxDir: dirA, repoSlug: 'acme/site',
      needsClarification: false, resolved: true, mergeOps: ops,
    })
    expect(out1.decision).toBeNull() // batch incomplete

    const out2 = await runMergeGate({
      batchId, batchSize: 2, annotationId: 'ann-b',
      sandboxDir: dirB, repoSlug: 'acme/site',
      needsClarification: false, resolved: true, mergeOps: ops,
    })
    expect(out2.decision).toBe('auto_merged')
  })

  test('batched: sibling clarification blocks whole batch', async () => {
    const ops = makeMergeOps()
    const batchId = '22222222-2222-2222-2222-222222222222'
    const dirA = '/tmp/sb-e-a'
    const dirB = '/tmp/sb-e-b'
    fakeDiffs[dirA] = cssOnlyDiff
    fakeDiffs[dirB] = cssOnlyDiff

    await runMergeGate({
      batchId, batchSize: 2, annotationId: 'ann-a',
      sandboxDir: dirA, repoSlug: 'acme/site',
      needsClarification: true, resolved: false, mergeOps: ops,
    })
    const out2 = await runMergeGate({
      batchId, batchSize: 2, annotationId: 'ann-b',
      sandboxDir: dirB, repoSlug: 'acme/site',
      needsClarification: false, resolved: true, mergeOps: ops,
    })
    expect(out2.decision).toBe('blocked')
    expect(out2.reasons).toContain('batch_blocked_on_clarification')
  })
})

describe('applyGateToCallback', () => {
  test('folds gate outcome into callback payload', () => {
    const payload = {
      annotation_id: 'ext-id',
      resolved: true,
      action_taken: 'fix',
      agent_reply: null,
      files_changed: ['a.tsx'],
      deployed: false,
    }
    const result = applyGateToCallback(payload, {
      decision: 'auto_merged',
      riskClass: 'minor',
      prUrl: 'https://github.com/x/y/pull/1/merged',
      diffHash: 'abc',
      diffSummary: '1 files, +1/-1 lines: a.tsx',
      reasons: [],
    }, 'batch-1')
    expect(result.merge_decision).toBe('auto_merged')
    expect(result.risk_class).toBe('minor')
    expect(result.batch_id).toBe('batch-1')
    expect(result.diff_hash).toBe('abc')
  })
})
