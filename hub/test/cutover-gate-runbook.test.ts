/**
 * Phase 19 / 19-01 — cutover-gate runbook presence + reference test.
 *
 * Asserts the June-15 cutover-gate runbook + checklist artifact exist, encode the
 * four SPEC checks, reference the Phase-18 dual-bucket poll, state the
 * not-a-build-blocker posture, and carry the unambiguous decision rule. Locks the
 * gate documentation so it cannot silently drift out of existence (T-19-01).
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const RUNBOOK = join(REPO, 'docs', 'cutover-gate-june15.md')

// The checklist lives under a Phase-19 dir that migrates as milestones rotate
// (e.g. `.planning/phases/19-…` → `.planning/archive/phases-pre-OBSRV/19-…`). Resolve
// it wherever it currently sits under `.planning/` rather than pinning a brittle path.
function findUnderPlanning(filename: string): string {
  const root = join(REPO, '.planning')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      const p = join(dir, name)
      let isDir = false
      try { isDir = statSync(p).isDirectory() } catch { continue }
      if (isDir) stack.push(p)
      else if (name === filename) return p
    }
  }
  return join(root, filename) // non-existent fallback → existsSync(...) === false, test fails loudly
}

const CHECKLIST = findUnderPlanning('cutover-gate-checklist.md')

describe('Phase 19 — cutover-gate runbook (R-PTY-21 / T-19-01)', () => {
  test('runbook + checklist artifacts exist', () => {
    expect(existsSync(RUNBOOK)).toBe(true)
    expect(existsSync(CHECKLIST)).toBe(true)
  })

  test('runbook references the Phase-18 dual-bucket poll measurement', () => {
    const md = readFileSync(RUNBOOK, 'utf8')
    expect(md).toContain('subscription_usage')
    expect(md.toLowerCase()).toContain('dual-bucket')
    // snapshot -> turn -> snapshot -> diff procedure
    expect(md.toLowerCase()).toContain('snapshot')
    expect(md.toLowerCase()).toContain('diff')
  })

  test('runbook states it is NOT a build blocker', () => {
    const md = readFileSync(RUNBOOK, 'utf8').toLowerCase()
    expect(md).toContain('not a build blocker')
  })

  test('runbook encodes the unambiguous decision rule (interactive=>claude, programmatic=>codex)', () => {
    const md = readFileSync(RUNBOOK, 'utf8').toLowerCase()
    expect(md).toContain('interactive')
    expect(md).toContain('programmatic')
    expect(md).toContain('fail-safe')
    expect(md).toContain('codex-pty')
    expect(md).toContain('claude-pty')
  })

  test('runbook documents how to unblock the deletion gate (attestation triplet)', () => {
    const md = readFileSync(RUNBOOK, 'utf8')
    expect(md).toContain('cutover-deletion-gate.mjs')
    expect(md).toContain('manual_attestation')
    expect(md).toContain('device_build')
  })

  test('checklist has one row per SPEC check with a Result column', () => {
    const md = readFileSync(CHECKLIST, 'utf8')
    expect(md).toContain('| Result |')
    // the four checks (2 splits into 2a/2b but all four concepts present)
    expect(md.toLowerCase()).toContain('which bucket')
    expect(md.toLowerCase()).toContain('setup-token vs login')
    expect(md.toLowerCase()).toContain('subagents / hooks / mcp')
    expect(md.toLowerCase()).toContain('reclassification')
  })

  test('login-credential reclassification is an ONGOING watch, not one-time', () => {
    const runbook = readFileSync(RUNBOOK, 'utf8').toLowerCase()
    const checklist = readFileSync(CHECKLIST, 'utf8').toLowerCase()
    expect(runbook).toContain('ongoing watch')
    expect(runbook).toContain('not a one-time check')
    expect(checklist).toContain('ongoing watch')
  })
})
