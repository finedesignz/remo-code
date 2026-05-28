// Phase 08.6 — getKnownLocalPathsForRepoKey: surfaces all known worktrees +
// branches for a given github://owner/repo, canonical first, capped at 20.

import { describe, test, expect, mock, beforeEach } from 'bun:test'

mock.module('../src/db/supervisor-dal', () => ({
  setSupervisorState: async () => {},
  touchSupervisor: async () => {},
  listSupervisorsForUser: async () => [],
  // Phase 12 W2 — full surface so api/supervisors imports don't break.
  setSupervisorRoots: async () => null,
  createRun: async () => ({ id: 'r_stub' }),
  endRun: async () => ({}),
  getSupervisor: async () => null,
  listRunsForSupervisor: async () => [],
  setSupervisorOverride: async () => null,
  setPreferredSupervisor: async () => null,
}))

const {
  setUserInventory,
  getKnownLocalPathsForRepoKey,
  resolveLocalPathForRepoKey,
} = await import('../src/ws/supervisor-registry')

const USER = 'user_known_paths_1'

function inv(repos: any[]) {
  return {
    scanned_at: new Date().toISOString(),
    supervisor_id: 'sup_known_1',
    roots: ['/work'],
    repos,
  }
}

describe('getKnownLocalPathsForRepoKey', () => {
  beforeEach(() => {
    setUserInventory(USER, inv([]))
  })

  test('returns empty when no inventory or no matches', () => {
    expect(getKnownLocalPathsForRepoKey('nobody', 'github://x/y')).toEqual([])
    expect(getKnownLocalPathsForRepoKey(USER, 'github://x/y')).toEqual([])
  })

  test('groups all worktrees of the same repo, canonical first', () => {
    setUserInventory(USER, inv([
      {
        local_path: '/work/foo-feat',
        is_git_repo: true,
        is_worktree: true,
        worktree_parent_path: '/work/foo',
        git_remote: 'https://github.com/acme/foo',
        git_origin_github: { owner: 'acme', repo: 'foo' },
        branch: 'feat/x',
        canonical: false,
      },
      {
        local_path: '/work/foo',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: 'https://github.com/acme/foo',
        git_origin_github: { owner: 'acme', repo: 'foo' },
        branch: 'main',
        canonical: true,
      },
      {
        local_path: '/work/other',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: null,
        git_origin_github: { owner: 'other', repo: 'thing' },
        branch: 'main',
        canonical: true,
      },
    ]))

    const out = getKnownLocalPathsForRepoKey(USER, 'github://acme/foo')
    expect(out.length).toBe(2)
    expect(out[0].local_path).toBe('/work/foo')
    expect(out[0].canonical).toBe(true)
    expect(out[0].branch).toBe('main')
    expect(out[1].local_path).toBe('/work/foo-feat')
    expect(out[1].is_worktree).toBe(true)
    expect(out[1].branch).toBe('feat/x')
  })

  test('case-insensitive repo_key match', () => {
    setUserInventory(USER, inv([
      {
        local_path: '/work/foo',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: null,
        git_origin_github: { owner: 'ACME', repo: 'Foo' },
        branch: 'main',
        canonical: true,
      },
    ]))
    expect(getKnownLocalPathsForRepoKey(USER, 'github://acme/foo').length).toBe(1)
    expect(getKnownLocalPathsForRepoKey(USER, 'github://ACME/FOO').length).toBe(1)
  })

  test('cap at 20 entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      local_path: `/work/foo-${i}`,
      is_git_repo: true,
      is_worktree: i !== 0,
      worktree_parent_path: i === 0 ? null : '/work/foo-0',
      git_remote: null,
      git_origin_github: { owner: 'acme', repo: 'foo' },
      branch: `b${i}`,
      canonical: i === 0,
    }))
    setUserInventory(USER, inv(many))
    const out = getKnownLocalPathsForRepoKey(USER, 'github://acme/foo')
    expect(out.length).toBe(20)
    expect(out[0].canonical).toBe(true)
  })

  test('null branch tolerated (pre-0.5 supervisor / detached HEAD)', () => {
    setUserInventory(USER, inv([
      {
        local_path: '/work/foo',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: null,
        git_origin_github: { owner: 'acme', repo: 'foo' },
        canonical: true,
        // branch omitted
      },
    ]))
    const out = getKnownLocalPathsForRepoKey(USER, 'github://acme/foo')
    expect(out[0].branch).toBeNull()
  })

  test('resolveLocalPathForRepoKey still returns canonical path', () => {
    setUserInventory(USER, inv([
      {
        local_path: '/work/foo',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: null,
        git_origin_github: { owner: 'acme', repo: 'foo' },
        canonical: true,
        branch: 'main',
      },
    ]))
    expect(resolveLocalPathForRepoKey(USER, 'github://acme/foo')).toBe('/work/foo')
  })
})
