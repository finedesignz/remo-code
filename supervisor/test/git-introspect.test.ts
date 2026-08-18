// supervisor/test/git-introspect.test.ts
//
// Phase 08 / Plan 001: real-filesystem tests for the supervisor git
// introspection module. Uses `spawnSync` with arg-vectors (NEVER shell:true,
// NEVER string concatenation) to build temp git repos.
//
// Skips the suite if `git` isn't on PATH.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { introspect } from '../src/git-introspect'

function hasGit(): boolean {
  try {
    const r = spawnSync('git', ['--version'], { shell: false, windowsHide: true })
    return r.status === 0
  } catch {
    return false
  }
}

const GIT_AVAILABLE = hasGit()

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, shell: false, windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
  }
}

let TMP: string

beforeAll(() => {
  if (!GIT_AVAILABLE) return
  TMP = mkdtempSync(join(tmpdir(), 'remo-introspect-'))
})

afterAll(() => {
  if (!GIT_AVAILABLE || !TMP) return
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe.skipIf(!GIT_AVAILABLE)('introspect()', () => {
  test('non-git directory → is_git_repo:false', async () => {
    const dir = join(TMP, 'empty-' + Date.now())
    mkdirSync(dir, { recursive: true })
    const r = await introspect(dir)
    expect(r.is_git_repo).toBe(false)
    expect(r.is_worktree).toBe(false)
    expect(r.git_remote).toBeNull()
    expect(r.git_origin_github).toBeNull()
  })

  test('git init with no remote → is_git_repo:true, no origin', async () => {
    const dir = join(TMP, 'plain-' + Date.now())
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q'])
    const r = await introspect(dir)
    expect(r.is_git_repo).toBe(true)
    expect(r.is_worktree).toBe(false)
    expect(r.git_remote).toBeNull()
    expect(r.git_origin_github).toBeNull()
  })

  test('SSH GitHub origin → parsed correctly', async () => {
    const dir = join(TMP, 'ssh-' + Date.now())
    mkdirSync(dir, { recursive: true })
    git(dir, ['init', '-q'])
    git(dir, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
    const r = await introspect(dir)
    expect(r.is_git_repo).toBe(true)
    // Note: a user's global `url.<X>.insteadOf` config can rewrite the remote
    // (e.g. `git@github.com:` → `https://github.com/`). We only assert that
    // origin parses to the right (owner, repo); the raw URL form is host-env
    // dependent and not part of the contract.
    expect(r.git_remote).not.toBeNull()
    expect(r.git_origin_github).toEqual({ owner: 'acme', repo: 'widget' })
  })

  test('git worktree → is_worktree:true with parent path', async () => {
    const parent = join(TMP, 'parent-' + Date.now())
    mkdirSync(parent, { recursive: true })
    git(parent, ['init', '-q'])
    // Need at least one commit to create a worktree.
    git(parent, ['config', 'user.email', 'test@example.com'])
    git(parent, ['config', 'user.name', 'test'])
    writeFileSync(join(parent, 'README.md'), '# test\n')
    git(parent, ['add', 'README.md'])
    git(parent, ['commit', '-q', '-m', 'init'])
    git(parent, ['remote', 'add', 'origin', 'git@github.com:Acme/Widget.git'])
    const sibling = join(TMP, 'parent-sibling-' + Date.now())
    git(parent, ['worktree', 'add', '-q', '-b', 'feat/test', sibling])

    const r = await introspect(sibling)
    expect(r.is_git_repo).toBe(true)
    expect(r.is_worktree).toBe(true)
    expect(r.worktree_parent_path).not.toBeNull()
    // parent path should end with the parent dir's basename
    expect(basename(r.worktree_parent_path ?? '')).toBe(basename(parent))
    // Worktree inherits the origin URL.
    expect(r.git_origin_github).toEqual({ owner: 'acme', repo: 'widget' })
  })
})
