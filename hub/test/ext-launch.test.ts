/**
 * Milestone LAUNCH (gsd-console Phase 8) - POST /api/ext/sessions/:id/launch and /stop.
 *
 * A key with ext:read plus an EXPLICIT ext:launch may start/stop the owner's EXISTING
 * sessions. Scope matrix, every D-16 response, the audit event, and the shared-disconnect
 * stop semantics. The real extApiKeyMiddleware + ext router run; the DB-facing leaves
 * (ask-dal key lookup, dal getSession/markSessionOffline/recordAuthEvent, supervisor-dal
 * endOpenRunsForSession, launchSessionForUser, ws registry channel) are mocked.
 *
 * mock.module is process-global in Bun: this file runs in its own process (the QC gate runs
 * each hub test file separately) and spreads the REAL modules first so unrelated exports stay
 * resolvable (see sessions-launch.test.ts).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { hashToken } from '../src/lib/crypto'

const USER = '11111111-1111-1111-1111-111111111111'
const OTHER_USER = '22222222-2222-2222-2222-222222222222'

// Test credentials: obviously fake, never key-shaped secrets (regex only needs the prefix).
const KEYS = {
  launch: 'remokey_testlaunch',
  readOnly: 'remokey_testreadonly',
  legacy: 'remokey_testlegacy',
  emptyScopes: 'remokey_testempty',
  launchOnly: 'remokey_testlaunchonly',
  askWork: 'remokey_testaskwork',
} as const
const SCOPES_BY_KEY: Record<string, string[] | null> = {
  [KEYS.launch]: ['ext:read', 'ext:launch'],
  [KEYS.readOnly]: ['ext:read'],
  [KEYS.legacy]: null,
  [KEYS.emptyScopes]: [],
  [KEYS.launchOnly]: ['ext:launch'],
  [KEYS.askWork]: ['ext:read', 'ext:ask', 'ext:work'],
}
const byHash = new Map<string, { id: string; scopes: string[] | null }>()
for (const [raw, scopes] of Object.entries(SCOPES_BY_KEY)) {
  byHash.set(await hashToken(raw), { id: `key-${raw}`, scopes })
}

type Launch = (a: { userId: string; sessionId: string; machine?: true }) => Promise<any>
const s = {
  sessions: new Map<string, any>(),
  channels: new Set<string>(),
  launchCalls: [] as any[],
  launchResult: { ok: true, runId: 'run-1', supervisorId: 'sup-1', hostname: 'devbox', repoPath: '/x' } as any,
  auditEvents: [] as any[],
  endOpenRunsCalls: [] as any[],
  openRuns: 1,
  markOfflineCalls: [] as any[],
  sent: [] as string[],
  closed: [] as Array<{ code?: number; reason?: string }>,
  auditThrows: false,
}

const realAskDal = await import(`../src/db/ask-dal.ts?real=${Date.now()}`)
const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
const realSupDal = await import(`../src/db/supervisor-dal.ts?real=${Date.now()}`)
const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)

mock.module('../src/db/ask-dal.ts', () => ({
  ...realAskDal,
  verifyApiKeyForExt: async (hash: string) => {
    const k = byHash.get(hash)
    return k ? { id: k.id, user_id: USER, scopes: k.scopes } : null
  },
}))
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  // Exact id for the owning user only - mirrors the real WHERE user_id AND deleted_at IS NULL.
  getSession: async (id: string, userId: string) => {
    const row = s.sessions.get(id)
    return row && row.user_id === userId ? row : null
  },
  markSessionOffline: async (id: string, userId: string) => {
    s.markOfflineCalls.push({ id, userId })
    const row = s.sessions.get(id)
    if (row) row.status = 'offline'
    return !!row
  },
  recordAuthEvent: async (e: any) => {
    if (s.auditThrows) throw new Error('audit db down')
    s.auditEvents.push(e)
  },
}))
mock.module('../src/db/supervisor-dal.ts', () => ({
  ...realSupDal,
  endOpenRunsForSession: async (sessionId: string, userId: string, reason: string) => {
    s.endOpenRunsCalls.push({ sessionId, userId, reason })
    const n = s.openRuns
    s.openRuns = 0
    return n
  },
}))
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: (id: string) =>
    s.channels.has(id)
      ? {
          ws: {
            send: (raw: string) => { s.sent.push(raw) },
            close: (code?: number, reason?: string) => { s.closed.push({ code, reason }) },
          },
        }
      : null,
}))
mock.module('../src/telegram/launch.ts', () => ({
  launchSessionForUser: (async (a) => {
    s.launchCalls.push(a)
    return s.launchResult
  }) as Launch,
}))

const { extApiKeyMiddleware } = await import('../src/auth/ext-api-key-middleware.ts')
const { ext } = await import('../src/api/ext.ts')

const app = new Hono()
app.use('/api/ext/*', extApiKeyMiddleware)
app.route('/api/ext', ext)

const post = (path: string, key?: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const launch = (id: string, key?: string, body?: unknown) => post(`/api/ext/sessions/${id}/launch`, key, body)
const stop = (id: string, key?: string) => post(`/api/ext/sessions/${id}/stop`, key)

beforeEach(() => {
  s.sessions = new Map([
    ['sess-off', { id: 'sess-off', user_id: USER, status: 'offline', is_orchestrator: false, project_dir: '/repos/a', repo_key: 'github://acme/repo-a', github_repo: 'repo-a' }],
    ['sess-on', { id: 'sess-on', user_id: USER, status: 'online', is_orchestrator: false, project_dir: '/repos/b' }],
    ['sess-think', { id: 'sess-think', user_id: USER, status: 'thinking', is_orchestrator: false, project_dir: '/repos/b2' }],
    ['sess-orch', { id: 'sess-orch', user_id: USER, status: 'offline', is_orchestrator: true, project_dir: '/repos' }],
    ['sess-foreign', { id: 'sess-foreign', user_id: OTHER_USER, status: 'offline', is_orchestrator: false, project_dir: '/repos/c' }],
  ])
  s.channels = new Set()
  s.launchCalls = []
  s.launchResult = { ok: true, runId: 'run-1', supervisorId: 'sup-1', hostname: 'devbox', repoPath: '/x' }
  s.auditEvents = []
  s.endOpenRunsCalls = []
  s.openRuns = 1
  s.markOfflineCalls = []
  s.sent = []
  s.closed = []
  s.auditThrows = false
})

describe('scope matrix (D-12 / D-13)', () => {
  test('no key / bad key -> 401, nothing launched', async () => {
    expect((await launch('sess-off')).status).toBe(401)
    expect((await launch('sess-off', 'remokey_unknownkey')).status).toBe(401)
    expect((await stop('sess-off')).status).toBe(401)
    expect(s.launchCalls).toHaveLength(0)
  })

  test.each([
    ['ext:read-only key', KEYS.readOnly],
    ['legacy NULL-scopes key (explicit only)', KEYS.legacy],
    ['empty-array scopes key (explicit only)', KEYS.emptyScopes],
    ['ext:read + ext:ask + ext:work key (not sufficient)', KEYS.askWork],
  ])('%s -> 403 required ext:launch on launch and stop', async (_n, key) => {
    for (const res of [await launch('sess-off', key), await stop('sess-on', key)]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'ext:launch' })
    }
    expect(s.launchCalls).toHaveLength(0)
    expect(s.endOpenRunsCalls).toHaveLength(0)
  })

  test('ext:launch without ext:read -> 403 required ext:read', async () => {
    for (const res of [await launch('sess-off', KEYS.launchOnly), await stop('sess-on', KEYS.launchOnly)]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'insufficient_scope', required: 'ext:read' })
    }
    expect(s.launchCalls).toHaveLength(0)
  })

  test('the ext:launch rule is only on the launch/stop routes: a read-only key still reads', async () => {
    const res = await app.request('/api/ext/sessions/sess-off/launch', { method: 'GET', headers: { Authorization: `Bearer ${KEYS.readOnly}` } })
    // GET is not a launch route: the middleware lets it through to the router (no such GET route -> 404).
    expect(res.status).toBe(404)
  })
})

describe('POST /api/ext/sessions/:id/launch (D-14 / D-16)', () => {
  test('ext:read + ext:launch on an offline session -> 202 {launching, run_id}; machine primitive called once with machine:true and nothing else on the wire', async () => {
    const res = await launch('sess-off', KEYS.launch)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ launching: true, run_id: 'run-1' })
    expect(s.launchCalls).toEqual([{ userId: USER, sessionId: 'sess-off', machine: true }])
  })

  test('request body is ignored: no prompt, path, branch or CLI kind reaches the primitive', async () => {
    const res = await launch('sess-off', KEYS.launch, {
      initial_prompt: 'rm -rf /', project_dir: '/etc', branch: 'evil', cli_kind: 'x', machine: false,
    })
    expect(res.status).toBe(202)
    expect(s.launchCalls).toEqual([{ userId: USER, sessionId: 'sess-off', machine: true }])
  })

  test('audit event ext_launch: key owner, key id, session id, server-inferred actor, outcome', async () => {
    await launch('sess-off', KEYS.launch)
    expect(s.auditEvents).toHaveLength(1)
    const e = s.auditEvents[0]
    expect(e.eventType).toBe('ext_launch')
    expect(e.userId).toBe(USER)
    expect(e.metadata).toEqual({ key_id: `key-${KEYS.launch}`, session_id: 'sess-off', actor: 'external-launch', outcome: 'accepted' })
  })

  test('an audit write failure does not change the response', async () => {
    s.auditThrows = true
    expect((await launch('sess-off', KEYS.launch)).status).toBe(202)
  })

  test('unknown id and another user\'s id -> 404 session_not_found, never launched', async () => {
    for (const id of ['nope', 'sess-foreign']) {
      const res = await launch(id, KEYS.launch)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'session_not_found' })
    }
    expect(s.launchCalls).toHaveLength(0)
  })

  test('a bare repo name or repo_ident is NOT an id (no resolveSession matching) -> 404', async () => {
    for (const id of ['repo-a', 'github:%2F%2Facme%2Frepo-a']) {
      expect((await launch(id, KEYS.launch)).status).toBe(404)
    }
    expect(s.launchCalls).toHaveLength(0)
  })

  test('orchestrator session -> 409 use_orchestrator_start, never launched', async () => {
    const res = await launch('sess-orch', KEYS.launch)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'use_orchestrator_start' })
    expect(s.launchCalls).toHaveLength(0)
  })

  test('online / mid-turn / live-channel session -> 409 already_online, never launched', async () => {
    s.channels.add('sess-off') // status offline but a live channel
    for (const id of ['sess-on', 'sess-think', 'sess-off']) {
      const res = await launch(id, KEYS.launch)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'already_online' })
    }
    expect(s.launchCalls).toHaveLength(0)
  })

  test.each([
    [{ ok: false, reason: 'automation_halted:user' }, 409, { error: 'automation_halted', scope: 'user' }],
    [{ ok: false, reason: 'automation_halted:global' }, 409, { error: 'automation_halted', scope: 'global' }],
    [{ ok: false, reason: 'session_not_found' }, 404, { error: 'session_not_found' }],
    [{ ok: false, reason: 'no_project_dir' }, 409, { error: 'no_project_dir' }],
    [{ ok: false, reason: 'no_online_supervisor' }, 409, { error: 'supervisor_offline' }],
    [{ ok: false, reason: 'at_capacity', running: 4, cap: 4 }, 429, { error: 'at_capacity', running: 4, cap: 4 }],
    [{ ok: false, reason: 'send_failed', error: 'ws boom' }, 503, { error: 'dispatch_failed' }],
    [{ ok: false, reason: 'internal_error', error: 'secret db detail' }, 500, { error: 'internal_error' }],
  ])('LaunchResult %j -> %d %j', async (result, status, body) => {
    s.launchResult = result
    const res = await launch('sess-off', KEYS.launch)
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual(body)
  })

  test('supervisor_ambiguous -> 409 supervisor_ambiguous (error name pinned, detail present)', async () => {
    s.launchResult = { ok: false, reason: 'supervisor_ambiguous', count: 2 }
    const res = await launch('sess-off', KEYS.launch)
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error).toBe('supervisor_ambiguous')
    expect(typeof body.detail).toBe('string')
  })

  test('a refusal is audited with its reason', async () => {
    s.launchResult = { ok: false, reason: 'at_capacity', running: 4, cap: 4 }
    await launch('sess-off', KEYS.launch)
    expect(s.auditEvents.map((e) => e.metadata.outcome)).toEqual(['at_capacity'])
  })
})

describe('POST /api/ext/sessions/:id/stop (D-15 shared disconnect)', () => {
  test('online session: shutdown(user_disconnect) sent, open runs ended with user_disconnect, offline, row kept -> 200 {stopped}', async () => {
    s.channels.add('sess-on')
    const res = await stop('sess-on', KEYS.launch)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stopped: true })
    expect(s.sent).toHaveLength(1)
    expect(JSON.parse(s.sent[0])).toEqual({ type: 'shutdown', reason: 'user_disconnect' })
    expect(s.endOpenRunsCalls).toEqual([{ sessionId: 'sess-on', userId: USER, reason: 'user_disconnect' }])
    expect(s.markOfflineCalls).toEqual([{ id: 'sess-on', userId: USER }])
    expect(s.sessions.get('sess-on')?.status).toBe('offline') // kept, not deleted
    expect(s.sessions.has('sess-on')).toBe(true)
  })

  test('stop uses the SAME exit reason as the human disconnect route (orphan-resume never resurrects it)', async () => {
    const { USER_DISCONNECT_REASON } = await import('../src/sessions/disconnect.ts')
    expect(USER_DISCONNECT_REASON).toBe('user_disconnect')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const resume = readFileSync(join(import.meta.dir, '..', 'src/orchestrator/orphan-resume.ts'), 'utf8')
    expect(resume).toMatch(/NON_RESUMABLE_EXIT_REASONS[\s\S]*'user_disconnect'/)
  })

  test('a repeat stop answers 200 already_offline (idempotent, nothing sent)', async () => {
    s.channels.add('sess-on')
    expect((await stop('sess-on', KEYS.launch)).status).toBe(200)
    s.channels.clear()
    s.sent = []
    const res = await stop('sess-on', KEYS.launch)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stopped: true, already_offline: true })
    expect(s.sent).toHaveLength(0)
  })

  test('an offline session with an open run is stopped (run ended), not reported already_offline', async () => {
    s.openRuns = 1
    const res = await stop('sess-off', KEYS.launch)
    expect(await res.json()).toEqual({ stopped: true })
    expect(s.endOpenRunsCalls).toHaveLength(1)
  })

  test('stop never consults the kill switch and works while automation is halted', async () => {
    s.launchResult = { ok: false, reason: 'automation_halted:global' }
    s.channels.add('sess-on')
    const res = await stop('sess-on', KEYS.launch)
    expect(res.status).toBe(200)
    expect(s.launchCalls).toHaveLength(0) // the machine primitive (kill switch) is never on the stop path
  })

  test('the shared disconnect module never references the automation kill switch', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dir, '..', 'src/sessions/disconnect.ts'), 'utf8')
    expect(/automation-controls|isAutomationHalted|haltBeforeMachineSend/.test(src)).toBe(false)
  })

  test('orchestrator -> 409 use_orchestrator_start, nothing stopped', async () => {
    const res = await stop('sess-orch', KEYS.launch)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'use_orchestrator_start' })
    expect(s.endOpenRunsCalls).toHaveLength(0)
    expect(s.markOfflineCalls).toHaveLength(0)
  })

  test('unknown, foreign and bare-name ids -> 404, nothing stopped', async () => {
    for (const id of ['nope', 'sess-foreign', 'repo-a']) {
      const res = await stop(id, KEYS.launch)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'session_not_found' })
    }
    expect(s.endOpenRunsCalls).toHaveLength(0)
    expect(s.markOfflineCalls).toHaveLength(0)
  })

  test('audit event ext_stop with the server-inferred actor', async () => {
    s.channels.add('sess-on')
    await stop('sess-on', KEYS.launch)
    expect(s.auditEvents).toHaveLength(1)
    expect(s.auditEvents[0].eventType).toBe('ext_stop')
    expect(s.auditEvents[0].userId).toBe(USER)
    expect(s.auditEvents[0].metadata).toEqual({ key_id: `key-${KEYS.launch}`, session_id: 'sess-on', actor: 'external-launch', outcome: 'stopped' })
  })
})
