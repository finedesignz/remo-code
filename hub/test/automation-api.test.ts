/**
 * PTYCAP-04-05 Task 1: /api/automation router. The controls module and the
 * session-ownership query are leaf-mocked; the router is driven through
 * Hono's app.request behind a middleware that sets userId / userRole.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const calls: { fn: string; args: any }[] = []
let ownedSessions = new Set<string>()
let resetResult: any = { ok: true }
let engageAlready = false
let releaseResult = true

mock.module('../src/db/postgres.ts', () => ({
  // The only statement the router issues: session ownership. Values: [sessionId, userId].
  sql: async (_s: TemplateStringsArray, ...vals: any[]) => {
    calls.push({ fn: 'ownership', args: vals })
    return ownedSessions.has(`${vals[1]}:${vals[0]}`) ? [{ id: vals[0] }] : []
  },
}))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  engageKillSwitch: async (a: any) => {
    calls.push({ fn: 'engage', args: a })
    return { engaged: true, alreadyEngaged: engageAlready }
  },
  releaseKillSwitch: async (a: any) => {
    calls.push({ fn: 'release', args: a })
    return { released: releaseResult }
  },
  getKillSwitchState: async (a: any) => {
    calls.push({ fn: 'state', args: a })
    return stateOverride ?? { env: false, global: null, user: null, sessions: [] }
  },
  resetLifetimeCounter: async (a: any) => {
    calls.push({ fn: 'reset', args: a })
    return resetResult
  },
}))

// PTYCAP-04-07: release-time resume. The orphan-resume module is leaf-mocked: a lister for the
// releasing scope and the supervisor-scoped sweep, both recorded.
let resumeSups: Array<{ supervisorId: string; userId: string }> = []
let resumeThrows = false
let listerRejects = false
mock.module('../src/orchestrator/orphan-resume', () => ({
  listOnlineSupervisorsForRelease: async (a: any) => {
    calls.push({ fn: 'lister', args: a })
    if (listerRejects) throw new Error('registry boom')
    return resumeSups
  },
  resumeOrphansForSupervisor: async (a: any) => {
    calls.push({ fn: 'resume', args: a })
    if (resumeThrows) throw new Error('resume boom')
    return {}
  },
}))
let stateOverride: any = null
const flush = () => new Promise((r) => setTimeout(r, 0))

const { automationApi } = await import('../src/api/automation.ts')

function appAs(userId: string, role: string): Hono<any> {
  const app = new Hono<{ Variables: { userId: string; userRole: string } }>()
  app.use('*', async (c, next) => {
    c.set('userId', userId)
    c.set('userRole', role)
    await next()
  })
  app.route('/api/automation', automationApi)
  return app
}
const post = (app: Hono<any>, path: string, body: unknown) =>
  app.request(`/api/automation${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const last = (fn: string) => calls.filter((c) => c.fn === fn).at(-1)

beforeEach(() => {
  calls.length = 0
  ownedSessions = new Set(['u1:s-own'])
  resetResult = { ok: true }
  engageAlready = false
  releaseResult = true
  resumeSups = []
  resumeThrows = false
  listerRejects = false
  stateOverride = null
})

const GLOBAL_ROW = {
  id: '11111111-1111-4111-8111-111111111111', scope: 'global', user_id: null, session_id: null,
  engaged: true, reason: 'incident INC-7', engaged_by: 'admin1', engaged_at: '2026-10-13T00:00:00Z',
}
describe('GET /kill-switch', () => {
  test('QC m1: a non-admin sees only {engaged:true} for the global row (no engaged_by / reason / id)', async () => {
    stateOverride = { env: false, global: GLOBAL_ROW, user: null, sessions: [] }
    const res = await appAs('u1', 'user').request('/api/automation/kill-switch')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.global).toEqual({ engaged: true })
    expect(JSON.stringify(body)).not.toContain('admin1')
    expect(JSON.stringify(body)).not.toContain('INC-7')
  })

  test('QC m1: an admin still sees the full global row; the own user row stays full for a non-admin', async () => {
    const userRow = { ...GLOBAL_ROW, scope: 'user', user_id: 'u1', reason: 'mine', engaged_by: 'u1' }
    stateOverride = { env: false, global: GLOBAL_ROW, user: userRow, sessions: [] }
    expect(((await (await appAs('admin1', 'admin').request('/api/automation/kill-switch')).json()) as any).global).toEqual(GLOBAL_ROW)
    const body = (await (await appAs('u1', 'user').request('/api/automation/kill-switch')).json()) as any
    expect(body.user).toEqual(userRow)
    expect(body.global).toEqual({ engaged: true })
  })

  test('returns state scoped to the caller', async () => {
    const res = await appAs('u1', 'user').request('/api/automation/kill-switch')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ env: false, global: null, user: null, sessions: [] })
    expect(last('state')!.args).toEqual({ userId: 'u1' })
  })
})

describe('POST /kill-switch/engage', () => {
  test('global as non-admin -> 403 admin_required, engage not called', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'global' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden', reason: 'admin_required' })
    expect(last('engage')).toBeUndefined()
  })

  test('global as admin -> engaged_by is the caller', async () => {
    const res = await post(appAs('admin1', 'admin'), '/kill-switch/engage', { scope: 'global', reason: 'incident' })
    expect(res.status).toBe(200)
    const a = last('engage')!.args
    expect(a.scope).toBe('global')
    expect(a.engagedBy).toBe('admin1')
    expect(a.userId).toBeNull()
    expect(a.reason).toBe('incident')
  })

  test('user scope acts on the caller only; a body user_id is ignored', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'user', user_id: 'victim' })
    expect(res.status).toBe(200)
    const a = last('engage')!.args
    expect(a.scope).toBe('user')
    expect(a.userId).toBe('u1')
    expect(JSON.stringify(a)).not.toContain('victim')
  })

  test('session scope on a session the caller does not own -> 404, engage not called', async () => {
    const res = await post(appAs('u2', 'user'), '/kill-switch/engage', { scope: 'session', session_id: 's-own' })
    expect(res.status).toBe(404)
    expect(last('engage')).toBeUndefined()
  })

  test('session scope on a missing/deleted session -> 404', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'session', session_id: 'gone' })
    expect(res.status).toBe(404)
    expect(last('engage')).toBeUndefined()
  })

  test('session scope on an owned session -> engaged', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'session', session_id: 's-own' })
    expect(res.status).toBe(200)
    const a = last('engage')!.args
    expect(a.scope).toBe('session')
    expect(a.sessionId).toBe('s-own')
    expect(a.userId).toBe('u1')
  })

  test('engaging twice reports alreadyEngaged and is still 200', async () => {
    engageAlready = true
    const res = await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'user' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).alreadyEngaged).toBe(true)
  })

  test('invalid scope, missing session_id and malformed body -> 400', async () => {
    const app = appAs('u1', 'user')
    expect((await post(app, '/kill-switch/engage', { scope: 'planet' })).status).toBe(400)
    expect((await post(app, '/kill-switch/engage', { scope: 'session' })).status).toBe(400)
    expect((await post(app, '/kill-switch/engage', '{not json')).status).toBe(400)
    expect(last('engage')).toBeUndefined()
  })
})

describe('POST /kill-switch/release', () => {
  test('global as non-admin -> 403', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'global' })
    expect(res.status).toBe(403)
    expect(last('release')).toBeUndefined()
  })

  test('user scope releases the caller only and reports released', async () => {
    const res = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'user', user_id: 'victim' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).released).toBe(true)
    const a = last('release')!.args
    expect(a.userId).toBe('u1')
    expect(a.releasedBy).toBe('u1')
  })

  test('session scope IDOR -> 404; owned + nothing engaged -> released false', async () => {
    const other = await post(appAs('u2', 'user'), '/kill-switch/release', { scope: 'session', session_id: 's-own' })
    expect(other.status).toBe(404)
    expect(last('release')).toBeUndefined()
    releaseResult = false
    const mine = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'session', session_id: 's-own' })
    expect(mine.status).toBe(200)
    expect(((await mine.json()) as any).released).toBe(false)
  })
})

describe('PTYCAP-04-07 release triggers an event-driven orphan resume (panel F-4)', () => {
  test('user release sweeps each online supervisor of the releasing owner (supervisor-scoped function)', async () => {
    resumeSups = [{ supervisorId: 'sup-a', userId: 'u1' }, { supervisorId: 'sup-b', userId: 'u1' }]
    const res = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'user' })
    expect(res.status).toBe(200)
    await flush()
    expect(last('lister')!.args).toEqual({ scope: 'user', userId: 'u1' })
    expect(calls.filter((c) => c.fn === 'resume').map((c) => c.args)).toEqual([
      { userId: 'u1', supervisorId: 'sup-a' },
      { userId: 'u1', supervisorId: 'sup-b' },
    ])
  })

  test('session release sweeps the owner supervisors; global release sweeps every user supervisor with its own user id', async () => {
    resumeSups = [{ supervisorId: 'sup-a', userId: 'u1' }]
    await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'session', session_id: 's-own' })
    await flush()
    expect(last('lister')!.args).toEqual({ scope: 'session', userId: 'u1' })
    expect(calls.filter((c) => c.fn === 'resume')).toHaveLength(1)

    calls.length = 0
    resumeSups = [{ supervisorId: 'sup-a', userId: 'u1' }, { supervisorId: 'sup-z', userId: 'u9' }]
    const g = await post(appAs('admin1', 'admin'), '/kill-switch/release', { scope: 'global' })
    expect(g.status).toBe(200)
    await flush()
    expect(last('lister')!.args).toEqual({ scope: 'global', userId: 'admin1' })
    expect(calls.filter((c) => c.fn === 'resume').map((c) => c.args)).toEqual([
      { userId: 'u1', supervisorId: 'sup-a' },
      { userId: 'u9', supervisorId: 'sup-z' },
    ])
  })

  test('engage never triggers a resume; a release that released nothing triggers none', async () => {
    resumeSups = [{ supervisorId: 'sup-a', userId: 'u1' }]
    await post(appAs('u1', 'user'), '/kill-switch/engage', { scope: 'user' })
    releaseResult = false
    await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'user' })
    await flush()
    expect(calls.filter((c) => c.fn === 'lister' || c.fn === 'resume')).toHaveLength(0)
  })

  test('a rejected resume (or lister) still returns 200 with the released state', async () => {
    resumeSups = [{ supervisorId: 'sup-a', userId: 'u1' }]
    resumeThrows = true
    const a = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'user' })
    expect(a.status).toBe(200)
    expect(((await a.json()) as any).released).toBe(true)
    await flush()
    listerRejects = true
    const b = await post(appAs('u1', 'user'), '/kill-switch/release', { scope: 'user' })
    expect(b.status).toBe(200)
    expect(((await b.json()) as any).released).toBe(true)
    await flush()
  })
})

describe('POST /lifetime/reset', () => {
  test('known key -> 200, actor is the caller', async () => {
    const res = await post(appAs('u1', 'user'), '/lifetime/reset', { counter_key: 'task:abc' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).counter_key).toBe('task:abc')
    expect(last('reset')!.args).toEqual({ userId: 'u1', counterKey: 'task:abc', actor: 'u1' })
  })

  test('unknown key -> 404 unknown_counter_key', async () => {
    resetResult = { ok: false, reason: 'unknown_counter_key' }
    const res = await post(appAs('u1', 'user'), '/lifetime/reset', { counter_key: 'task:nope' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'unknown_counter_key' })
  })

  test('missing or non-string counter_key -> 400', async () => {
    const app = appAs('u1', 'user')
    expect((await post(app, '/lifetime/reset', {})).status).toBe(400)
    expect((await post(app, '/lifetime/reset', { counter_key: 5 })).status).toBe(400)
    expect(last('reset')).toBeUndefined()
  })
})

describe('D-07 static pin', () => {
  test('automation.ts never stops a session or touches the supervisor registry', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'automation.ts'), 'utf8')
    const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toContain('session.stop')
    expect(code).not.toContain('sendToSupervisor')
    expect(code).not.toContain('supervisor-registry')
  })

  test('automation.ts uses the supervisor-scoped sweep, never the rate-limited user-scoped one (04-07)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'automation.ts'), 'utf8')
    expect(src).toContain('resumeOrphansForSupervisor')
    expect(src).not.toContain('resumeOrphanSessionsForUser')
  })
})
