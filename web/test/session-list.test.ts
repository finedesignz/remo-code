// Shared session-list selector contract (web/src/lib/session-list).
//
// Guards the two regressions it fixes:
//   1. Worktree collapse — one row per repo_key, never a `<repo>-<slug>`
//      worktree dir as its own entry; canonical (non-worktree) session wins.
//   2. Connected-first ordering + orchestrator pinned to the top.
import { describe, expect, test } from 'bun:test'
import {
  collapseWorktrees,
  sortConnectedFirst,
  repoSessionList,
  isSessionOnline,
} from '../src/lib/session-list'
import type { CodeSession } from '../src/hooks/useSessions'

function mk(p: Partial<CodeSession>): CodeSession {
  return {
    id: p.id ?? Math.random().toString(36).slice(2),
    name: p.name ?? 'sess',
    project_dir: p.project_dir ?? null,
    status: p.status ?? 'offline',
    last_activity: p.last_activity ?? null,
    created_at: '',
    ...p,
  } as CodeSession
}

describe('collapseWorktrees', () => {
  test('collapses worktree sessions into the one canonical repo entry', () => {
    const canonical = mk({
      id: 'main', repo_key: 'github://acme/app', project_dir: 'C:/gh/app',
      local_paths: [{ local_path: 'C:/gh/app', branch: 'main', is_worktree: false, canonical: true }],
    })
    const worktree = mk({
      id: 'wt', repo_key: 'github://acme/app', project_dir: 'C:/gh/app-feat-x',
      local_paths: [{ local_path: 'C:/gh/app-feat-x', branch: 'feat/x', is_worktree: true, canonical: false }],
    })
    const out = collapseWorktrees([worktree, canonical])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('main')              // canonical kept
    expect(out[0].project_dir).toBe('C:/gh/app') // never the `…-feat-x` worktree dir
  })

  test('keeps null-repo_key (local-only) sessions distinct, keyed by id', () => {
    const a = mk({ id: 'a', repo_key: null, project_dir: 'C:/x' })
    const b = mk({ id: 'b', repo_key: null, project_dir: 'C:/y' })
    expect(collapseWorktrees([a, b])).toHaveLength(2)
  })

  test('non-array input is tolerated', () => {
    // @ts-expect-error — defensive runtime guard
    expect(collapseWorktrees(null)).toEqual([])
  })
})

describe('sortConnectedFirst', () => {
  test('online (online/thinking/active) sessions sort before offline', () => {
    const offline = mk({ id: 'off', name: 'zzz', status: 'offline' })
    const online = mk({ id: 'on', name: 'aaa', status: 'online' })
    const thinking = mk({ id: 'tk', name: 'mmm', status: 'thinking' })
    const out = sortConnectedFirst([offline, online, thinking])
    expect(out.map((s) => s.id).slice(0, 2).sort()).toEqual(['on', 'tk'])
    expect(out[2].id).toBe('off')
  })

  test('the supervisor `active` flag counts as online', () => {
    expect(isSessionOnline(mk({ status: 'offline', active: true }))).toBe(true)
    expect(isSessionOnline(mk({ status: 'offline' }))).toBe(false)
  })
})

describe('repoSessionList', () => {
  test('collapses worktrees, sorts connected-first, pins orchestrator to top', () => {
    const orch = mk({ id: 'orch', name: 'orchestrator', status: 'online', is_orchestrator: true })
    const onlineRepo = mk({ id: 'r1', name: 'beta', status: 'online', repo_key: 'github://acme/beta' })
    const onlineRepoWt = mk({
      id: 'r1wt', status: 'online', repo_key: 'github://acme/beta',
      project_dir: 'C:/gh/beta-feat', local_paths: [{ local_path: 'C:/gh/beta-feat', branch: 'f', is_worktree: true, canonical: false }],
    })
    const offlineRepo = mk({ id: 'r2', name: 'alpha', status: 'offline', repo_key: 'github://acme/alpha' })

    const out = repoSessionList([offlineRepo, onlineRepoWt, onlineRepo, orch])
    expect(out[0].id).toBe('orch')                    // orchestrator pinned
    expect(out.map((s) => s.id)).not.toContain('r1wt') // worktree collapsed away
    expect(out[1].id).toBe('r1')                       // online before offline
    expect(out[out.length - 1].id).toBe('r2')          // offline last
  })
})
