// 2026-08-18 QC (D1/D4) — regression coverage for the introspection cache in
// repo-scanner.ts. Prior to the fix, the cache key was `mtime('.git/HEAD')`
// (falling back to the directory's own mtime), which is stale for:
//   (a) a branch switch INSIDE A WORKTREE — `.git` there is a file, so
//       `.git/HEAD` never existed at that path and the key silently fell
//       back to the worktree directory's own mtime, which a branch switch
//       does not touch.
//   (b) `git remote set-url` on a canonical repo — writes `.git/config`,
//       touching neither `.git/HEAD` nor the directory.
//
// Both are exercised end-to-end here via the real public `scanRoots()` API
// (not the internal cache functions), calling it twice with a git mutation
// in between and asserting the SECOND call reflects the change. This is a
// black-box test of the same shape as the QC verifier's own probe — it
// would have failed against the pre-fix cache key.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { scanRoots } from '../src/repo-scanner'
import { DEFAULT_SCAN_SETTINGS } from '../src/config'

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true })
  return {
    ok: typeof r.status === 'number' && r.status === 0,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
  }
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'remo-scan-cache-'))
})

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

describe('scanRoots() introspection cache — staleness', () => {
  test('canonical repo: git_origin_github updates after `remote set-url` (touches only .git/config)', async () => {
    const repoRoot = mkdtempSync(join(root, 'remote-'))
    const repo = join(repoRoot, 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/WidgetOne.git'])
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'initial'])

    const cfg = { roots: [repoRoot], scan: DEFAULT_SCAN_SETTINGS }

    const first = await scanRoots(cfg)
    const firstEntry = first.find((e) => e.local_path.endsWith('/repo'))
    expect(firstEntry?.git_origin_github).toEqual({ owner: 'acme', repo: 'widgetone' })

    // `remote set-url` writes ONLY .git/config — neither .git/HEAD nor the
    // repo directory's own mtime change.
    const setUrl = git(repo, ['remote', 'set-url', 'origin', 'git@github.com:Acme/WidgetTwo.git'])
    expect(setUrl.ok).toBe(true)

    const second = await scanRoots(cfg)
    const secondEntry = second.find((e) => e.local_path.endsWith('/repo'))
    // Pre-fix (HEAD/dir-mtime-only key): this would still read WidgetOne —
    // the cache never noticed the config change.
    expect(secondEntry?.git_origin_github).toEqual({ owner: 'acme', repo: 'widgettwo' })
  })

  test('worktree: branch updates after a checkout inside the worktree (touches only the worktree-private HEAD)', async () => {
    const repoRoot = mkdtempSync(join(root, 'worktree-'))
    const repo = join(repoRoot, 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, ['init', '-b', 'main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'test'])
    git(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/WorktreeRepo.git'])
    writeFileSync(join(repo, 'README.md'), 'hi\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-m', 'initial'])
    git(repo, ['branch', 'feat-a'])
    git(repo, ['branch', 'feat-b'])

    const wtPath = join(repoRoot, 'repo-worktree')
    const wtRes = git(repo, ['worktree', 'add', wtPath, 'feat-a'])
    if (!wtRes.ok) throw new Error(`git worktree add failed: ${wtRes.stderr}`)

    const cfg = { roots: [repoRoot], scan: DEFAULT_SCAN_SETTINGS }

    const first = await scanRoots(cfg)
    const firstWt = first.find((e) => e.local_path.endsWith('/repo-worktree'))
    expect(firstWt?.is_worktree).toBe(true)
    expect(firstWt?.branch).toBe('feat-a')

    // Checkout a different branch INSIDE the worktree. `.git` at the worktree
    // root is a FILE (never changes); this only touches the worktree-private
    // HEAD under `<repo>/.git/worktrees/<name>/HEAD`, not the worktree
    // directory's own mtime.
    const checkout = git(wtPath, ['checkout', 'feat-b'])
    expect(checkout.ok).toBe(true)

    const second = await scanRoots(cfg)
    const secondWt = second.find((e) => e.local_path.endsWith('/repo-worktree'))
    // Pre-fix (HEAD lookup always ENOENT'd for a worktree -> fell back to the
    // worktree DIRECTORY's mtime, unchanged by an in-place checkout): this
    // would still read feat-a.
    expect(secondWt?.branch).toBe('feat-b')
  })
})
