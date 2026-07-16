/**
 * fix/ui-session-nav — the WS `session_list` payload MUST carry the same
 * derived fields as `GET /api/sessions`.
 *
 * REGRESSION (owner, 2026-07-16): "the grid view doesn't currently load
 * sessions". The grid's virtual Default tab computes its membership from
 * `allSessions.filter(s => s.active)` (web/src/components/GridPage.tsx:273),
 * while the sidebar / List View filters on `status` — which is why List View
 * kept working and only the grid went empty.
 *
 * `active` is a DERIVED field: it does not exist as a column on `sessions`, and
 * the raw DAL `listSessions()` cannot return it. `GET /api/sessions` derives it
 * from the supervisor inventory (`getActiveSessionIdsForUser`) ∪ status. The WS
 * `session_list` broadcasts, however, sent RAW `listSessions()` rows with no
 * `active` (and no `local_paths`).
 *
 * `useSessions` REPLACES its whole list on every `session_list` message
 * (web/src/hooks/useSessions.ts:100), and the hub pushes one immediately on
 * client WS auth (hub/src/ws/client.ts). So the good REST rows were clobbered
 * within milliseconds by unenriched ones → every `active` became `undefined` →
 * the Default tab filtered to [] → "No active sessions".
 *
 * Because `useSessions` replaces wholesale, the WS payload and the REST payload
 * MUST be the same shape. That is the invariant these tests pin: one shared
 * enricher, and no `session_list` broadcast built from the raw DAL.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')

// ── Unit: the shared enricher derives `active` the same way REST always did ──

const activeIds = new Set<string>()
const knownPaths: Record<string, any[]> = {}

mock.module(join(SRC, 'ws', 'supervisor-registry.ts'), () => ({
  getActiveSessionIdsForUser: () => activeIds,
  getKnownLocalPathsForRepoKey: (_u: string, repoKey: string) => knownPaths[repoKey] ?? [],
}))

const rows: any[] = []
mock.module(join(SRC, 'db', 'dal.ts'), () => ({
  listSessions: async () => rows,
}))

const { enrichSessionsForUser, listSessionsForUserEnriched } = await import('../src/sessions/enrich.ts')

beforeEach(() => {
  activeIds.clear()
  rows.length = 0
  for (const k of Object.keys(knownPaths)) delete knownPaths[k]
})
afterEach(() => { mock.restore() })

describe('enrichSessionsForUser', () => {
  test('active=true when the supervisor inventory hosts the session', () => {
    activeIds.add('s1')
    const out = enrichSessionsForUser('u1', [{ id: 's1', status: 'offline', repo_key: null }])
    expect(out[0].active).toBe(true)
  })

  test('active=true from status alone (pre-0.5.7 supervisor pushes no inventory)', () => {
    const out = enrichSessionsForUser('u1', [
      { id: 's1', status: 'online', repo_key: null },
      { id: 's2', status: 'thinking', repo_key: null },
    ])
    expect(out.map(s => s.active)).toEqual([true, true])
  })

  test('active=false — never undefined — when neither inventory nor status says so', () => {
    const out = enrichSessionsForUser('u1', [{ id: 's1', status: 'offline', repo_key: null }])
    // `undefined` is the bug: GridPage's `filter(s => s.active)` treats it as
    // absent, so the Default tab renders "No active sessions".
    expect(out[0].active).toBe(false)
    expect('active' in out[0]).toBe(true)
  })

  test('local_paths enriched for GitHub-keyed rows, [] otherwise', () => {
    knownPaths['github://o/r'] = [{ local_path: '/c/r', branch: 'main', is_worktree: false, canonical: true }]
    const out = enrichSessionsForUser('u1', [
      { id: 's1', status: 'online', repo_key: 'github://o/r' },
      { id: 's2', status: 'online', repo_key: null },
    ])
    expect(out[0].local_paths).toHaveLength(1)
    expect(out[1].local_paths).toEqual([])
  })
})

describe('listSessionsForUserEnriched', () => {
  test('is the DAL rows PLUS the derived fields — the shape session_list must send', async () => {
    activeIds.add('s1')
    rows.push({ id: 's1', name: 'a', status: 'offline', repo_key: null })
    const out = await listSessionsForUserEnriched('u1')
    expect(out[0]).toMatchObject({ id: 's1', name: 'a', active: true, local_paths: [] })
  })
})

// ── Contract: no `session_list` broadcast may be built from the raw DAL ──────
//
// The unit tests above cannot catch a NEW broadcast site that forgets to
// enrich — which is exactly how this bug shipped. Scan every source file that
// emits a `session_list` frame and require it to source its `sessions` from the
// shared enricher.

describe('session_list broadcast sites', () => {
  const files = ['ws/client.ts', 'ws/agent.ts']

  for (const rel of files) {
    test(`${rel} builds session_list from the shared enricher, never raw listSessions`, () => {
      const src = readFileSync(join(SRC, rel), 'utf8')
      if (!src.includes("type: 'session_list'")) return // no broadcast here

      expect(src).toContain('listSessionsForUserEnriched')

      // The raw DAL `listSessions` cannot return `active` (no such column), so
      // its presence in a session_list emitter means an unenriched payload.
      const rawCalls = [...src.matchAll(/(?<!Enriched\w*)\blistSessions\s*\(/g)]
      expect(rawCalls.length).toBe(0)
    })
  }
})
