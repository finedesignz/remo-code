// Repo-grouping pure-logic contract (web/src/lib/repo-ident + group-partition).
//
// Guards the locked product rules:
//   - repo_ident mapping: github:// wins over path://; null when unidentifiable.
//   - a repo in N groups renders under EACH group (duplication).
//   - repos in zero groups fall into a trailing "Ungrouped" section.
//   - empty group sections are kept; Ungrouped only when non-empty.
import { describe, expect, test } from 'bun:test'
import { repoIdent, buildGithubIdent, githubIdentFromFullName, UNGROUPED_ID } from '../src/lib/repo-ident'
import {
  buildIdentToGroupIds,
  partitionIntoGroups,
} from '../src/lib/group-partition'
import type { RepoGroup } from '../src/lib/repo-groups'
import { sessionRepoIdent } from '../src/lib/session-list'
import type { CodeSession } from '../src/hooks/useSessions'

describe('repoIdent', () => {
  test('github identity wins over path; lowercased', () => {
    expect(repoIdent({ owner: 'Acme', repo: 'App', path: 'C:/x' })).toBe('github://acme/app')
    expect(repoIdent({ repo_key: 'github://acme/app' })).toBe('github://acme/app')
    expect(repoIdent({ full_name: 'Acme/App' })).toBe('github://acme/app')
  })
  test('path fallback for local-only', () => {
    expect(repoIdent({ path: 'C:/repos/local' })).toBe('path://C:/repos/local')
  })
  test('null when unidentifiable', () => {
    expect(repoIdent({})).toBeNull()
    expect(githubIdentFromFullName('noslash')).toBeNull()
    expect(buildGithubIdent('O', 'R')).toBe('github://o/r')
  })
})

function grp(id: string, name: string, idents: string[], sort = 0): RepoGroup {
  return {
    id,
    name,
    sort_order: sort,
    created_at: '',
    updated_at: '',
    members: idents.map((repo_ident) => ({ repo_ident, created_at: '' })),
  }
}

describe('buildIdentToGroupIds', () => {
  test('inverse map: a repo in 2 groups lists both group ids', () => {
    const groups = [grp('g1', 'A', ['github://acme/x', 'github://acme/y']), grp('g2', 'B', ['github://acme/x'])]
    const map = buildIdentToGroupIds(groups)
    expect(map.get('github://acme/x')!.sort()).toEqual(['g1', 'g2'])
    expect(map.get('github://acme/y')).toEqual(['g1'])
  })
})

describe('partitionIntoGroups', () => {
  const items = [
    { id: 'x', ident: 'github://acme/x' },
    { id: 'y', ident: 'github://acme/y' },
    { id: 'z', ident: 'path://C:/local' }, // ungrouped
    { id: 'n', ident: null }, // ungroupable → ungrouped
  ]
  const groups = [grp('g1', 'Frontends', ['github://acme/x', 'github://acme/y']), grp('g2', 'Shared', ['github://acme/x'])]

  test('a repo in N groups renders under each group', () => {
    const sections = partitionIntoGroups(items, groups, (i) => i.ident)
    const g1 = sections.find((s) => s.id === 'g1')!
    const g2 = sections.find((s) => s.id === 'g2')!
    expect(g1.items.map((i) => i.id).sort()).toEqual(['x', 'y'])
    expect(g2.items.map((i) => i.id)).toEqual(['x']) // x under BOTH g1 and g2
  })

  test('zero-group + null-ident items fall into a trailing Ungrouped section', () => {
    const sections = partitionIntoGroups(items, groups, (i) => i.ident)
    const last = sections[sections.length - 1]
    expect(last.id).toBe(UNGROUPED_ID)
    expect(last.isUngrouped).toBe(true)
    expect(last.items.map((i) => i.id).sort()).toEqual(['n', 'z'])
  })

  test('empty group section is kept; Ungrouped hidden when empty', () => {
    const onlyGrouped = [{ id: 'x', ident: 'github://acme/x' }]
    const sections = partitionIntoGroups(onlyGrouped, groups, (i) => i.ident)
    // g2 has x, g1 has x too → both present; no Ungrouped section (none ungrouped)
    expect(sections.some((s) => s.id === UNGROUPED_ID)).toBe(false)
    // a group with no matching items still renders (empty), e.g. add a 3rd group
    const withEmpty = [...groups, grp('g3', 'Empty', ['github://nope/none'])]
    const s2 = partitionIntoGroups(onlyGrouped, withEmpty, (i) => i.ident)
    const empty = s2.find((s) => s.id === 'g3')!
    expect(empty.count).toBe(0)
    expect(empty.items).toEqual([])
  })

  test('count reflects per-section membership', () => {
    const sections = partitionIntoGroups(items, groups, (i) => i.ident)
    expect(sections.find((s) => s.id === 'g1')!.count).toBe(2)
    expect(sections.find((s) => s.id === 'g2')!.count).toBe(1)
  })
})

describe('sessionRepoIdent', () => {
  function mk(p: Partial<CodeSession>): CodeSession {
    return { id: 'a', name: 's', project_dir: null, status: 'online', last_activity: null, created_at: '', ...p } as CodeSession
  }
  test('repo_key wins', () => {
    expect(sessionRepoIdent(mk({ repo_key: 'github://acme/app' }))).toBe('github://acme/app')
  })
  test('canonical local path → path:// ident', () => {
    const s = mk({
      repo_key: null,
      project_dir: 'C:/gh/app',
      local_paths: [{ local_path: 'C:/gh/app', branch: 'main', is_worktree: false, canonical: true }],
    })
    expect(sessionRepoIdent(s)).toBe('path://C:/gh/app')
  })
  test('null when no identity', () => {
    expect(sessionRepoIdent(mk({ repo_key: null, project_dir: null }))).toBeNull()
  })
})
