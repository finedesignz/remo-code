// Phase 08 §15 — scanRoots: max_depth, ignore_globs, worktree grouping.
//
// Builds a tmpdir tree with real `git init` calls, runs scanRoots, asserts the
// canonical entry is the non-worktree and that ignore_globs prunes
// node_modules. spawnSync arg-vector form throughout (no shell strings).

import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawnSync } from 'child_process'
import { scanRoots, scanAll, type RepoEntry } from '../src/repo-scanner'
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
  root = mkdtempSync(join(tmpdir(), 'remo-scan-'))

  // repo-a: real git init + GitHub origin
  const repoA = join(root, 'repo-a')
  mkdirSync(repoA, { recursive: true })
  git(repoA, ['init', '-b', 'main'])
  git(repoA, ['config', 'user.email', 'test@example.com'])
  git(repoA, ['config', 'user.name', 'test'])
  git(repoA, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
  // Need at least one commit before `git worktree add` will succeed.
  writeFileSync(join(repoA, 'README.md'), 'hi\n')
  git(repoA, ['add', '-A'])
  git(repoA, ['commit', '-m', 'initial'])

  // repo-a-worktree: linked worktree of repo-a
  const wtPath = join(root, 'repo-a-worktree')
  const wtRes = git(repoA, ['worktree', 'add', wtPath])
  if (!wtRes.ok) {
    // git versions <2.5 lack `worktree`; the test environment requires modern git.
    throw new Error(`git worktree add failed: ${wtRes.stderr}`)
  }

  // local-only: a plain directory, no git
  mkdirSync(join(root, 'local-only'), { recursive: true })

  // node_modules/something/.git/ — must be ignored by default ignore_globs
  const nm = join(root, 'node_modules', 'something')
  mkdirSync(nm, { recursive: true })
  // make it look like a repo to be sure the ignore (not the introspection) is what excludes it
  git(nm, ['init', '-b', 'main'])
})

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

describe('scanRoots', () => {
  test('walks max_depth=2 honoring ignore_globs and returns RepoEntry list', async () => {
    const entries = await scanRoots({
      roots: [root],
      scan: { max_depth: 2, ignore_globs: ['**/node_modules/**'], follow_symlinks: false },
    })

    // Locate by basename (paths are forward-slash normalized inside scanRoots).
    const byName = (name: string) =>
      entries.find((e) => e.local_path.toLowerCase().endsWith('/' + name.toLowerCase()))

    expect(byName('repo-a')).toBeTruthy()
    expect(byName('repo-a-worktree')).toBeTruthy()

    // node_modules entry must NOT appear.
    expect(entries.find((e) => e.local_path.includes('node_modules'))).toBeUndefined()
  })

  test('groups worktrees by GitHub origin and stamps exactly one canonical=true (non-worktree)', async () => {
    const entries = await scanRoots({
      roots: [root],
      scan: { max_depth: 2, ignore_globs: ['**/node_modules/**'], follow_symlinks: false },
    })

    const githubEntries = entries.filter(
      (e) => e.git_origin_github?.owner === 'acme' && e.git_origin_github?.repo === 'widget'
    )
    expect(githubEntries.length).toBe(2)

    const canonicalCount = githubEntries.filter((e) => e.canonical).length
    expect(canonicalCount).toBe(1)

    const canonical = githubEntries.find((e) => e.canonical)!
    expect(canonical.is_worktree).toBe(false)
  })

  test('local-only dir is emitted only when it is itself a configured root (depth pruning)', async () => {
    // local-only is at depth 1 inside `root` and is NOT a git repo → dropped per
    // the policy in scanRoots (only roots themselves are emitted when non-git).
    const entries = await scanRoots({
      roots: [root],
      scan: { max_depth: 2, ignore_globs: ['**/node_modules/**'], follow_symlinks: false },
    })
    const localOnly = entries.find((e) => e.local_path.toLowerCase().endsWith('/local-only'))
    expect(localOnly).toBeUndefined()

    // But when configured AS a root, it shows up (non-git, ready for pending_local_repos).
    const localRoot = join(root, 'local-only').replace(/\\/g, '/')
    const entries2 = await scanRoots({
      roots: [localRoot],
      scan: { max_depth: 1, ignore_globs: [], follow_symlinks: false },
    })
    const found = entries2.find((e) => e.local_path === localRoot)
    expect(found).toBeTruthy()
    expect(found!.is_git_repo).toBe(false)
    expect(found!.git_origin_github).toBeNull()
    expect(found!.canonical).toBe(true)
  })

  test('legacy scanAll filters out git worktrees (worktree has .git as file, not dir)', () => {
    // repo-a has `.git` as a directory → kept. repo-a-worktree has `.git` as a
    // FILE (gitdir: pointer) → filtered. Fix for app.remo-code.com 2026-05-27
    // showing `<repo>-<branch>` dirs in the picker as if they were repos.
    const repos = scanAll([root])
    const names = repos.map((r) => r.name)
    expect(names).toContain('repo-a')
    expect(names).not.toContain('repo-a-worktree')
  })

  test('default ignore_globs include node_modules, .next, dist, target', () => {
    expect(DEFAULT_SCAN_SETTINGS.ignore_globs).toContain('**/node_modules/**')
    expect(DEFAULT_SCAN_SETTINGS.ignore_globs).toContain('**/.next/**')
    expect(DEFAULT_SCAN_SETTINGS.ignore_globs).toContain('**/dist/**')
    expect(DEFAULT_SCAN_SETTINGS.ignore_globs).toContain('**/target/**')
  })
})
