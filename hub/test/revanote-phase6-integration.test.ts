/**
 * Phase 6 smoke E2E.
 *
 * Three scenarios via mocked diff + mocked MergeOps + mocked notifier:
 *   1. clean CSS diff → auto_merged (minor, ci_green).
 *   2. migration diff → pr_opened (major) + notifier fired.
 *   3. secret in diff → blocked; no PR, no notify.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const fakeDiffs: Record<string, string> = {}
mock.module('../src/revanote/diff-sandbox.ts', () => {
  const actual = require('../src/revanote/diff-sandbox.ts')
  return {
    ...actual,
    getSandboxDiff: async (dir: string) => fakeDiffs[dir] ?? '',
  }
})

import { runMergeGate, _resetBatchState, type MergeOps } from '../src/revanote/merge-gate'

const cssOnlyDiff = `diff --git a/src/styles.css b/src/styles.css
index abc..def 100644
--- a/src/styles.css
+++ b/src/styles.css
@@ -1 +1 @@
-.btn { color: red; }
+.btn { color: blue; }
`

const migrationDiff = `diff --git a/migrations/0001.sql b/migrations/0001.sql
new file mode 100644
--- /dev/null
+++ b/migrations/0001.sql
@@ -0,0 +1 @@
+ALTER TABLE foo ADD COLUMN x int;
`

const envDiff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`

function makeOps(): MergeOps & { calls: any[] } {
  const calls: any[] = []
  return {
    calls,
    async openPr(opts) {
      calls.push({ kind: 'openPr', ...opts })
      return `https://github.com/${opts.repoSlug}/pull/${calls.length}`
    },
    async squashMerge(opts) {
      calls.push({ kind: 'squashMerge', ...opts })
      return `${opts.prUrl}/merged`
    },
    async ciGreen() { return true },
  }
}

describe('phase6 integration', () => {
  beforeEach(() => {
    _resetBatchState()
    for (const k of Object.keys(fakeDiffs)) delete fakeDiffs[k]
  })

  test('clean CSS → auto_merged with notifier NOT called', async () => {
    const dir = '/tmp/p6-clean'
    fakeDiffs[dir] = cssOnlyDiff
    const ops = makeOps()
    let notified = 0
    const out = await runMergeGate({
      batchId: null, batchSize: null, annotationId: 'a',
      sandboxDir: dir, repoSlug: 'acme/site', repoKind: 'github',
      needsClarification: false, resolved: true,
      mergeOps: ops,
      notifier: async () => { notified++; return true },
    })
    expect(out.decision).toBe('auto_merged')
    expect(out.riskClass).toBe('minor')
    expect(notified).toBe(0)
    expect(ops.calls.some((c) => c.kind === 'squashMerge')).toBe(true)
  })

  test('migration → pr_opened, notifier called once', async () => {
    const dir = '/tmp/p6-mig'
    fakeDiffs[dir] = migrationDiff
    const ops = makeOps()
    let notified = 0
    let lastNotify: any = null
    const out = await runMergeGate({
      batchId: null, batchSize: null, annotationId: 'a',
      sandboxDir: dir, repoSlug: 'acme/site', repoKind: 'github',
      needsClarification: false, resolved: true,
      mergeOps: ops,
      annotationUrl: 'https://app.revanote.com/review/p1#a',
      notifyEmail: 'reviewer@example.com',
      notifier: async (opts) => { notified++; lastNotify = opts; return true },
    })
    expect(out.decision).toBe('pr_opened')
    expect(out.riskClass).toBe('major')
    expect(notified).toBe(1)
    expect(lastNotify.payloadNotifyEmail).toBe('reviewer@example.com')
    expect(lastNotify.annotationUrl).toContain('app.revanote.com')
    // No squash merge
    expect(ops.calls.some((c) => c.kind === 'squashMerge')).toBe(false)
  })

  test('secret in diff → blocked; no PR, no notify', async () => {
    const dir = '/tmp/p6-env'
    fakeDiffs[dir] = envDiff
    const ops = makeOps()
    let notified = 0
    const out = await runMergeGate({
      batchId: null, batchSize: null, annotationId: 'a',
      sandboxDir: dir, repoSlug: 'acme/site', repoKind: 'github',
      needsClarification: false, resolved: true,
      mergeOps: ops,
      notifier: async () => { notified++; return true },
    })
    expect(out.decision).toBe('blocked')
    expect(notified).toBe(0)
    expect(ops.calls.length).toBe(0)
  })

  test('local_path + minor → no auto-merge, no notify, no PR', async () => {
    const dir = '/tmp/p6-local'
    fakeDiffs[dir] = cssOnlyDiff
    const ops = makeOps()
    let notified = 0
    const out = await runMergeGate({
      batchId: null, batchSize: null, annotationId: 'a',
      sandboxDir: dir, repoSlug: 'my-app', repoKind: 'local_path',
      needsClarification: false, resolved: true,
      mergeOps: ops,
      notifier: async () => { notified++; return true },
    })
    expect(out.decision).toBe('pr_opened')
    expect(out.prUrl).toBeNull()
    expect(notified).toBe(0)
    expect(ops.calls.some((c) => c.kind === 'squashMerge')).toBe(false)
    expect(ops.calls.some((c) => c.kind === 'openPr')).toBe(false)
  })
})
