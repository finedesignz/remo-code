// 2026-08-18 QC round 2 (D7-R2) — regression test for the scanRoots()
// in-flight guard. The first version returned the SAME in-flight promise for
// ANY call while a scan was running, without comparing cfg — so a call
// landing mid-scan with DIFFERENT roots (exactly the set_roots/rescan case)
// silently got back the FIRST caller's results. Reproduced by the round-two
// QC as: same-promise? true; second call asked for roots B, got paths under
// A. This test fires two scanRoots() calls back-to-back (synchronously, no
// await between them, so the second genuinely lands while the first is
// in-flight — verified this ordering guarantee holds even with Bun's shared
// module state across test files, since scanRootsInFlight/scanRootsQueued
// are always drained back to null by the time a prior test's awaited call
// returns) against two DIFFERENT roots trees, and asserts each caller gets
// back ONLY entries from its own roots — never the other caller's.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { scanRoots } from '../src/repo-scanner'
import { DEFAULT_SCAN_SETTINGS } from '../src/config'

function git(cwd: string, args: string[]): { ok: boolean; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true })
  return { ok: typeof r.status === 'number' && r.status === 0, stderr: (r.stderr ?? '').toString() }
}

function makeRepo(parent: string, name: string, remote: string): string {
  const repo = join(parent, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['remote', 'add', 'origin', remote])
  writeFileSync(join(repo, 'README.md'), 'hi\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'initial'])
  return repo
}

let root: string
let rootA: string
let rootB: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'remo-scan-inflight-'))
  rootA = mkdtempSync(join(root, 'roots-a-'))
  rootB = mkdtempSync(join(root, 'roots-b-'))
  // A handful of repos in each so the scan isn't instantaneous — gives the
  // second call a real window to land mid-scan, not that it strictly needs
  // one: the two scanRoots() calls below are issued synchronously with no
  // await between them, so the second is guaranteed to observe the first as
  // in-flight regardless of how fast either scan actually completes.
  for (let i = 0; i < 3; i++) makeRepo(rootA, `repo-a${i}`, `git@github.com:AcmeA/RepoA${i}.git`)
  for (let i = 0; i < 3; i++) makeRepo(rootB, `repo-b${i}`, `git@github.com:AcmeB/RepoB${i}.git`)
})

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

describe('scanRoots() in-flight guard respects cfg (D7-R2)', () => {
  test('a call with different roots landing mid-scan gets ITS OWN results, not the first caller\'s', async () => {
    const cfgA = { roots: [rootA], scan: DEFAULT_SCAN_SETTINGS }
    const cfgB = { roots: [rootB], scan: DEFAULT_SCAN_SETTINGS }

    // Synchronous back-to-back — pB is issued while pA is still in flight.
    const pA = scanRoots(cfgA)
    const pB = scanRoots(cfgB)

    const [resultsA, resultsB] = await Promise.all([pA, pB])

    const normA = rootA.replace(/\\/g, '/')
    const normB = rootB.replace(/\\/g, '/')

    expect(resultsA.length).toBeGreaterThan(0)
    expect(resultsB.length).toBeGreaterThan(0)

    for (const e of resultsA) {
      expect(e.local_path.startsWith(normA)).toBe(true)
    }
    for (const e of resultsB) {
      expect(e.local_path.startsWith(normB)).toBe(true)
    }

    // The specific failure mode QC reproduced: caller B's results must not
    // silently be caller A's roots.
    expect(resultsB.some((e) => e.local_path.startsWith(normA))).toBe(false)
    expect(resultsA.some((e) => e.local_path.startsWith(normB))).toBe(false)
  })

  test('a call with the SAME cfg landing mid-scan shares the in-flight result (dedup still works)', async () => {
    const cfg = { roots: [rootA], scan: DEFAULT_SCAN_SETTINGS }
    const p1 = scanRoots(cfg)
    const p2 = scanRoots(cfg)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2) // same array reference — proves they shared one scan
  })
})
