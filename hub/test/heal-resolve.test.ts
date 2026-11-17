/**
 * PTYCAP-07-05 Task 1 -- resolveHealTarget (AM-F2-1, AM-F2-2, AM-F2-3, SH-03). DB-free:
 * every collaborator is injected, so no module mocks are needed.
 */
import { describe, test, expect } from 'bun:test'
import { resolveHealTarget, type ResolveDeps } from '../src/heal/resolve.ts'
import { parseHealEvent } from '../src/heal/types.ts'

const REPO = 'github://acme/web'

function sess(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    repo_key: REPO,
    github_owner: null,
    github_repo: null,
    project_dir: null,
    is_rootless: false,
    runner_type: 'stream-json',
    ...over,
  }
}

function mkDeps(opts: {
  sessions?: Record<string, any>
  list?: string[]
  live?: Set<string>
}) {
  const calls = { list: 0, getSession: [] as Array<[string, string]> }
  const deps: ResolveDeps = {
    getSession: async (id, userId) => {
      calls.getSession.push([id, userId])
      const s = opts.sessions?.[`${userId}:${id}`]
      return s ?? null
    },
    listSessionIdsForRepoKey: async () => {
      calls.list++
      return opts.list ?? []
    },
    isSessionLive: async (id) => opts.live?.has(id) ?? false,
  }
  return { deps, calls }
}

function boundEvent(hint: string | null = null, extra: Record<string, unknown> = {}) {
  return parseHealEvent({
    source: 'error_capture',
    user_id: 'u1',
    repo_ident: hint,
    prompt: 'boom',
    metadata_run_id: null,
    trigger_run_id: null,
    dedupe_key: 'err:e1',
    bound_session_id: 's1',
    ctx: { error_id: 'e1', project_id: 'p1' },
    ...extra,
  })
}

function coolifyEvent(ident: string | null) {
  return parseHealEvent({
    source: 'coolify_deploy',
    user_id: 'u1',
    repo_ident: ident,
    prompt: 'deploy failed',
    metadata_run_id: 'r1',
    trigger_run_id: null,
    dedupe_key: 'coolify:d1',
    ctx: { application_uuid: 'a1', deployment_uuid: 'd1', log_snippet: 'x' },
  })
}

describe('bound path (AM-F2-1, AM-F2-2)', () => {
  const invalid: Array<[string, Record<string, any> | undefined, string]> = [
    ['missing/deleted/foreign row', undefined, 'bound_session_unavailable'],
    ['rootless', sess({ is_rootless: true }), 'bound_session_rootless'],
    ['pty-interactive', sess({ runner_type: 'pty-interactive' }), 'bound_session_pty_ineligible'],
    ['no derivable ident even though live', sess({ repo_key: null }), 'no_repo_identity'],
  ]
  for (const [label, row, reason] of invalid) {
    test(`${label} => none ${reason}, repo listing never called`, async () => {
      const { deps, calls } = mkDeps({
        sessions: row ? { 'u1:s1': row } : {},
        list: ['other'],
        live: new Set(['s1', 'other']),
      })
      const r = await resolveHealTarget(boundEvent(), deps)
      expect(r).toEqual({ kind: 'none', reason })
      expect(calls.list).toBe(0)
    })
  }

  test('a live bound session with no derivable ident returns none no_repo_identity', async () => {
    const { deps } = mkDeps({
      sessions: { 'u1:s1': sess({ repo_key: null, project_dir: null }) },
      live: new Set(['s1']),
    })
    expect(await resolveHealTarget(boundEvent(), deps)).toEqual({ kind: 'none', reason: 'no_repo_identity' })
  })

  test('hint that differs from the derived ident => repo_mismatch, no repo fallback', async () => {
    const { deps, calls } = mkDeps({ sessions: { 'u1:s1': sess() }, list: ['x'], live: new Set(['s1']) })
    const r = await resolveHealTarget(boundEvent('github://acme/other'), deps)
    expect(r).toEqual({ kind: 'none', reason: 'repo_mismatch' })
    expect(calls.list).toBe(0)
  })

  test('healthy live bound session => routable_live with the DERIVED ident (hint null ok)', async () => {
    const { deps } = mkDeps({ sessions: { 'u1:s1': sess() }, live: new Set(['s1']) })
    expect(await resolveHealTarget(boundEvent(null), deps)).toEqual({
      kind: 'routable_live',
      sessionId: 's1',
      repoIdent: REPO,
    })
  })

  test('healthy but not live (no channel / ghost) => offline_candidate with derived ident', async () => {
    const { deps } = mkDeps({ sessions: { 'u1:s1': sess() }, live: new Set() })
    expect(await resolveHealTarget(boundEvent(REPO), deps)).toEqual({
      kind: 'offline_candidate',
      sessionId: 's1',
      repoIdent: REPO,
    })
  })

  test('two-user isolation: getSession is always called with the event user; another user row is never routable', async () => {
    const { deps, calls } = mkDeps({
      sessions: { 'u2:s1': sess() }, // only user 2 owns s1
      live: new Set(['s1']),
    })
    const r = await resolveHealTarget(boundEvent(), deps)
    expect(r).toEqual({ kind: 'none', reason: 'bound_session_unavailable' })
    expect(calls.getSession).toEqual([['s1', 'u1']])
  })
})

describe('repo path (coolify_deploy)', () => {
  test('null repo_ident => none no_repo_identity', async () => {
    const { deps, calls } = mkDeps({})
    expect(await resolveHealTarget(coolifyEvent(null), deps)).toEqual({ kind: 'none', reason: 'no_repo_identity' })
    expect(calls.list).toBe(0)
  })

  test('path:// ident => none no_session_for_repo (path idents are not session-keyed)', async () => {
    const { deps, calls } = mkDeps({})
    expect(await resolveHealTarget(coolifyEvent('path:///srv/app'), deps)).toEqual({
      kind: 'none',
      reason: 'no_session_for_repo',
    })
    expect(calls.list).toBe(0)
  })

  test('first live candidate wins; PTY and rootless candidates are skipped', async () => {
    const { deps } = mkDeps({
      sessions: {
        'u1:a': sess({ id: 'a', runner_type: 'pty-interactive' }),
        'u1:b': sess({ id: 'b', is_rootless: true }),
        'u1:c': sess({ id: 'c' }),
        'u1:d': sess({ id: 'd' }),
      },
      list: ['a', 'b', 'c', 'd'],
      live: new Set(['a', 'b', 'd']),
    })
    // c is usable but offline, d is usable and live => d wins
    expect(await resolveHealTarget(coolifyEvent(REPO), deps)).toEqual({
      kind: 'routable_live',
      sessionId: 'd',
      repoIdent: REPO,
    })
  })

  test('no live candidate => most recently active usable one is the offline candidate', async () => {
    const { deps } = mkDeps({
      sessions: {
        'u1:a': sess({ id: 'a', runner_type: 'pty-interactive' }),
        'u1:c': sess({ id: 'c' }),
        'u1:d': sess({ id: 'd' }),
      },
      list: ['a', 'c', 'd'],
      live: new Set(),
    })
    expect(await resolveHealTarget(coolifyEvent(REPO), deps)).toEqual({
      kind: 'offline_candidate',
      sessionId: 'c',
      repoIdent: REPO,
    })
  })

  test('zero usable candidates => none no_session_for_repo', async () => {
    const { deps } = mkDeps({ sessions: {}, list: ['gone'], live: new Set(['gone']) })
    expect(await resolveHealTarget(coolifyEvent(REPO), deps)).toEqual({ kind: 'none', reason: 'no_session_for_repo' })
  })

  test('at most 5 candidates are inspected', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7']
    const { deps, calls } = mkDeps({ sessions: {}, list: ids })
    await resolveHealTarget(coolifyEvent(REPO), deps)
    expect(calls.getSession.length).toBe(5)
  })

  test('a live session bound to a DIFFERENT repo is never returned', async () => {
    // the repo listing is the only candidate source; an unrelated live session is unreachable
    const { deps } = mkDeps({
      sessions: { 'u1:other': sess({ id: 'other', repo_key: 'github://acme/y' }) },
      list: [],
      live: new Set(['other']),
    })
    expect(await resolveHealTarget(coolifyEvent(REPO), deps)).toEqual({ kind: 'none', reason: 'no_session_for_repo' })
  })
})
