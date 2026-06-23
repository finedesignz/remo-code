/**
 * Tests for Phase 08 Plan 005 — launch + create-github-repo endpoints.
 *
 * DAL + ws/supervisor-registry + github-scope are mocked via `mock.module`
 * so no DB and no supervisor WS connection are required.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111'
const TEST_SESSION_ID = 'sess_test_abc'
const TEST_SUPERVISOR_ID = 'sup_test_xyz'

// ── Mock state ───────────────────────────────────────────────────────────
const state: {
  session: any
  supervisorOnline: boolean
  inventory: any
  scope: { hasAdminWrite: boolean; hasContentsWrite: boolean; kind: string }
  sentMessages: any[]
  // Fault injection + call tracking for the rollback / capacity safety tests.
  throwOnSend: boolean
  throwOnCreateRun: boolean
  reserveResult: any
  createdRuns: any[]
  endRunCalls: Array<{ runId: string; reason: any }>
  releaseSlotCalls: Array<{ userId: string; supervisorId: string }>
  // Disconnect-endpoint tracking.
  channelOnline: boolean
  channelSends: string[]
  channelCloses: Array<{ code?: number; reason?: string }>
  markOfflineCalls: Array<{ id: string; userId: string }>
  endOpenRunsCalls: Array<{ sessionId: string; userId: string; reason: any }>
  openRunsCount: number
} = {
  session: null,
  supervisorOnline: true,
  inventory: null,
  scope: { hasAdminWrite: true, hasContentsWrite: true, kind: 'app_installation' },
  sentMessages: [],
  throwOnSend: false,
  throwOnCreateRun: false,
  reserveResult: { ok: true, running: 0, cap: 4 },
  createdRuns: [],
  endRunCalls: [],
  releaseSlotCalls: [],
  channelOnline: false,
  channelSends: [],
  channelCloses: [],
  markOfflineCalls: [],
  endOpenRunsCalls: [],
  openRunsCount: 1,
}

// Spread the real shared modules so any export not explicitly overridden below
// stays resolvable for sibling files in the full suite (Bun mock.module is
// process-global, first-write-wins). Overrides after the spread always win.
// See memory: bun-mock-pollution.
const realDalSL = await import(`../src/db/dal.ts?real=${Date.now()}`)
const realBudgetSL = await import(`../src/sessions/budget.ts?real=${Date.now()}`)

mock.module('../src/db/dal.ts', () => ({
  ...realDalSL,
  // Surface mocks for everything sessions.ts imports.
  createSession: async () => ({}),
  listSessions: async () => [],
  getSession: async (id: string, userId: string) => {
    if (id !== TEST_SESSION_ID) return null
    if (userId !== TEST_USER_ID) return null
    return state.session
  },
  deleteSession: async () => ({}),
  updateSessionToken: async () => ({}),
  markSessionDisconnected: async () => ({}),
  markSessionOffline: async (id: string, userId: string) => {
    state.markOfflineCalls.push({ id, userId })
    if (id === TEST_SESSION_ID && userId === TEST_USER_ID && state.session) {
      state.session.status = 'offline'
      return true
    }
    return false
  },
  getPendingPrompts: async () => [],
  dismissLocalSession: async () => ({}),
}))

mock.module('../src/db/chat-tabs-dal.ts', () => ({
  getMessagesForSessions: async () => ({}),
}))

mock.module('../src/db/supervisor-dal.ts', () => ({
  createRun: async (args: any) => {
    if (state.throwOnCreateRun) throw new Error('createRun boom')
    const row = { id: 'run_x', ...args }
    state.createdRuns.push(row)
    return row
  },
  endRun: async (runId: string, _exit: any, reason: any) => {
    state.endRunCalls.push({ runId, reason })
    return {}
  },
  endOpenRunsForSession: async (sessionId: string, userId: string, reason: any) => {
    state.endOpenRunsCalls.push({ sessionId, userId, reason })
    return state.openRunsCount
  },
  // Phase 12 W2 — keep full export surface so the api/supervisors import in
  // cross-test load order resolves setSupervisorRoots.
  setSupervisorRoots: async () => null,
  listSupervisorsForUser: async () => [],
  getSupervisor: async () => null,
  listRunsForSupervisor: async () => [],
  setSupervisorOverride: async () => null,
  setPreferredSupervisor: async () => null,
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: (sessionId: string) => {
    if (!state.channelOnline || sessionId !== TEST_SESSION_ID) return null
    return {
      ws: {
        send: (raw: string) => { state.channelSends.push(raw) },
        close: (code?: number, reason?: string) => { state.channelCloses.push({ code, reason }) },
      },
    }
  },
  broadcastToUser: (..._args: any[]) => {},
}))

// Bundle 2 (PR #109) — `mock.module` is process-global in `bun test` and
// FIRST-write-wins per spec across files. If this mock omits any export
// that another test file (e.g. `supervisor-registry.test.ts`,
// `ws-protocol-cluster.test.ts`) imports from
// `../src/ws/supervisor-registry`, that file's dynamic import will see an
// undefined binding and fail with "X is not a function". Keep the full
// surface here. The functional register/unregister/isOnline/sendRequest
// impls below mirror the real module narrowly — they exist purely so
// cross-test imports get working symbols. This file's own tests never
// exercise them; they use the state-driven getSupervisor stub.
const _mockSupervisors = new Map<string, { ws: any; supervisorId: string; userId: string; apiKeyId: string; pendingReqs: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }> }>()
const _mockSupervisorsByApiKey = new Map<string, string>()
let _mockReqCounter = 0

mock.module('../src/ws/supervisor-registry.ts', () => ({
  sendToSupervisor: (supId: string, msg: any) => {
    if (state.throwOnSend) throw new Error('ws send boom')
    state.sentMessages.push({ supId, msg })
  },
  updateSupervisorState: async () => {},
  listOnlineSupervisorIdsForUser: () =>
    state.supervisorOnline ? [TEST_SUPERVISOR_ID] : [],
  getSupervisor: (supervisorId: string) => {
    if (state.supervisorOnline && supervisorId === TEST_SUPERVISOR_ID) {
      return { supervisorId: TEST_SUPERVISOR_ID }
    }
    return _mockSupervisors.get(supervisorId)
  },
  // Mirror the real canonical-preference impl so the launch route's cwd
  // resolution is exercised faithfully (Bug fix 2026-05-28).
  resolveLocalPathForRepoKey: (_uid: string, repoKey: string) => {
    if (!state.inventory) return null
    const target = repoKey.toLowerCase()
    const repoName = target.split('/').pop() ?? ''
    const matches = state.inventory.repos.filter((r: any) => {
      if (!r.git_origin_github) return false
      const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
      return k === target
    })
    if (matches.length === 0) return null
    const primary = matches.find((m: any) => m.canonical && !m.is_worktree)
    if (primary) return primary.local_path
    const base = (p: string) => p.split(/[\\/]+/).filter(Boolean).pop() ?? ''
    const byBasename = matches.find((m: any) => !m.is_worktree && base(m.local_path).toLowerCase() === repoName)
    return byBasename?.local_path ?? null
  },
  getUserInventory: () => state.inventory,
  getKnownLocalPathsForRepoKey: (_uid: string, repoKey: string) => {
    if (!state.inventory) return []
    const target = repoKey.toLowerCase()
    const matches = state.inventory.repos.filter((r: any) => {
      if (!r.git_origin_github) return false
      const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
      return k === target
    })
    return matches.map((r: any) => ({
      local_path: r.local_path,
      branch: r.branch ?? null,
      is_worktree: !!r.is_worktree,
      canonical: !!r.canonical,
    }))
  },
  // ── Real-enough impls so cross-test files get working bindings ──────────
  registerSupervisor: (args: { ws: any; supervisorId: string; userId: string; apiKeyId: string; roots: string[]; hostname?: string }) => {
    const existingId = _mockSupervisorsByApiKey.get(args.apiKeyId)
    if (existingId) {
      const e = _mockSupervisors.get(existingId)
      if (e && e.ws !== args.ws) {
        for (const [, p] of e.pendingReqs) {
          clearTimeout(p.timer)
          p.reject(new Error('supervisor_replaced'))
        }
        e.pendingReqs.clear()
        try { e.ws.close(4003, 'replaced') } catch {}
      }
    }
    const entry = {
      ws: args.ws,
      supervisorId: args.supervisorId,
      userId: args.userId,
      apiKeyId: args.apiKeyId,
      pendingReqs: new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>(),
    }
    _mockSupervisors.set(args.supervisorId, entry)
    _mockSupervisorsByApiKey.set(args.apiKeyId, args.supervisorId)
    return entry
  },
  unregisterSupervisor: (supervisorId: string, ws?: any) => {
    const entry = _mockSupervisors.get(supervisorId)
    if (!entry) return
    if (ws && entry.ws !== ws) return
    for (const [, p] of entry.pendingReqs) {
      clearTimeout(p.timer)
      p.reject(new Error('supervisor disconnected'))
    }
    _mockSupervisors.delete(supervisorId)
    _mockSupervisorsByApiKey.delete(entry.apiKeyId)
  },
  isSupervisorOnline: (supervisorId: string) => _mockSupervisors.has(supervisorId),
  sendRequest: (supervisorId: string, msg: any, timeoutMs = 30_000) => {
    const entry = _mockSupervisors.get(supervisorId)
    if (!entry) return Promise.reject(new Error('supervisor offline'))
    const req_id = msg.req_id || `req_${Date.now()}_${++_mockReqCounter}`
    const full = { ...msg, req_id }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingReqs.delete(req_id)
        reject(new Error('supervisor request timed out'))
      }, timeoutMs)
      entry.pendingReqs.set(req_id, { resolve, reject, timer })
      try { entry.ws.send(JSON.stringify(full)) } catch (err) {
        clearTimeout(timer); entry.pendingReqs.delete(req_id); reject(err as Error)
      }
    })
  },
  resolveRequest: (supervisorId: string, reqId: string, payload: any) => {
    const entry = _mockSupervisors.get(supervisorId)
    if (!entry) return false
    const p = entry.pendingReqs.get(reqId)
    if (!p) return false
    clearTimeout(p.timer)
    entry.pendingReqs.delete(reqId)
    p.resolve(payload)
    return true
  },
  rejectRequest: (supervisorId: string, reqId: string, error: string) => {
    const entry = _mockSupervisors.get(supervisorId)
    if (!entry) return false
    const p = entry.pendingReqs.get(reqId)
    if (!p) return false
    clearTimeout(p.timer)
    entry.pendingReqs.delete(reqId)
    p.reject(new Error(error))
    return true
  },
  heartbeatSupervisor: async () => {},
  pushKeyRotatedToUser: () => 0,
  getSupervisorByApiKey: (apiKeyId: string) => {
    const id = _mockSupervisorsByApiKey.get(apiKeyId)
    return id ? _mockSupervisors.get(id) : undefined
  },
  setUserInventory: () => {},
  listSupervisorsForUser: async () => [],
  // Benign stubs so this file's own transitive imports (and any sibling's) can
  // resolve these exports even when this partial mock is the active one.
  findSupervisorForSession: () => null,
  getActiveSessionIdsForUser: () => new Set<string>(),
  setSupervisorSessionInventory: () => {},
  listSupervisors: () => [],
}))

mock.module('../src/lib/github-scope.ts', () => ({
  probeGithubAppScope: async () => state.scope,
  resetGithubScopeCache: () => {},
}))

mock.module('../src/lib/github-repo-job.ts', () => ({
  enqueueCreateGithubRepoJob: (_opts: any) => ({ job_id: 'job_test_123' }),
}))

mock.module('../src/sessions/routing.ts', () => ({
  pickSessionTarget: async () => ({ kind: 'none' as const }),
}))

mock.module('../src/sessions/budget.ts', () => ({
  ...realBudgetSL,
  releaseSessionSlot: async (userId: string, supervisorId: string) => {
    state.releaseSlotCalls.push({ userId, supervisorId })
  },
  // Phase 12 W2 — keep full surface so cross-test imports of api/supervisors
  // (which imports reserveSessionSlot + getCapacitySnapshot) don't break when
  // this stub is the active mock. The /launch route now reserves a slot before
  // dispatching session.start (protocol-drift fix 2026-05-30), so this must
  // grant a slot for the happy-path launch tests; per-test capacity faults are
  // driven via state.reserveResult. The run row is now consumed INSIDE the
  // reservation tx (atomic gate), so when runFields is supplied a granted
  // reservation also carries the created run (and honours throwOnCreateRun).
  reserveSessionSlot: async (_uid: string, _sid: string, runFields?: any) => {
    const r = state.reserveResult
    if (r.ok && runFields) {
      if (state.throwOnCreateRun) throw new Error('createRun boom')
      const row = { id: 'run_x', ...runFields }
      state.createdRuns.push(row)
      return { ...r, run: { id: row.id } }
    }
    return r
  },
  getCapacitySnapshot: async () => null,
}))

mock.module('../src/utils/token.ts', () => ({
  generateToken: (prefix: string) => `${prefix}testtoken`,
}))

mock.module('../src/lib/crypto.ts', () => ({
  hashToken: async (t: string) => `hash_${t}`,
}))

// ── App under test ───────────────────────────────────────────────────────
let app: Hono

beforeAll(async () => {
  const { sessions } = await import('../src/api/sessions.ts')
  app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId', TEST_USER_ID)
    await next()
  })
  app.route('/api/sessions', sessions)
})

beforeEach(() => {
  state.session = {
    id: TEST_SESSION_ID,
    user_id: TEST_USER_ID,
    name: 'test',
    project_dir: 'C:/Users/artic/GitHub/remo-code',
    status: 'offline',
    cli_kind: 'claude',
    repo_key: 'github://finedesignz/remo-code',
    github_owner: 'finedesignz',
    github_repo: 'remo-code',
    system_prompt: null,
  }
  state.supervisorOnline = true
  state.inventory = {
    scanned_at: new Date().toISOString(),
    supervisor_id: TEST_SUPERVISOR_ID,
    roots: ['C:/Users/artic/GitHub'],
    repos: [
      {
        local_path: 'C:/Users/artic/GitHub/remo-code',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: 'git@github.com:finedesignz/remo-code.git',
        git_origin_github: { owner: 'finedesignz', repo: 'remo-code' },
        canonical: true,
      },
    ],
  }
  state.scope = { hasAdminWrite: true, hasContentsWrite: true, kind: 'app_installation' }
  state.sentMessages = []
  state.throwOnSend = false
  state.throwOnCreateRun = false
  state.reserveResult = { ok: true, running: 0, cap: 4 }
  state.createdRuns = []
  state.endRunCalls = []
  state.releaseSlotCalls = []
  state.channelOnline = false
  state.channelSends = []
  state.channelCloses = []
  state.markOfflineCalls = []
  state.endOpenRunsCalls = []
  state.openRunsCount = 1
})

// ── Tests ────────────────────────────────────────────────────────────────
describe('POST /api/sessions/:id/launch', () => {
  // The supervisor's message switch (supervisor/src/hub-client.ts) only handles
  // these `session.*` types. Asserting the hub never emits anything outside this
  // set is the regression guard against the protocol drift this fix repairs
  // (`session.launch` was emitted but unhandled → silently dropped → no runner).
  const SUPERVISOR_HANDLED_SESSION_TYPES = new Set([
    'session.start',
    'session.stop',
    'session.status',
  ])

  test('happy path → 202 + session.start dispatched with canonical cwd as repo_path', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(202)
    const body: any = await res.json()
    expect(body.launching).toBe(true)
    expect(typeof body.run_id).toBe('string')
    expect(state.sentMessages).toHaveLength(1)
    const sent = state.sentMessages[0]
    expect(sent.supId).toBe(TEST_SUPERVISOR_ID)
    // Emits the HANDLED type — not the dropped `session.launch`.
    expect(sent.msg.type).toBe('session.start')
    // Runner↔session binding: repo_path = resolved canonical cwd (project_dir
    // match drives the supervisor's session_inventory correlation).
    expect(sent.msg.repo_path).toBe('C:/Users/artic/GitHub/remo-code')
    // session.start uses the local-key sentinel + same-hub marker.
    expect(sent.msg.api_key).toBe('__use_local__')
    expect(sent.msg.hub_url).toBe('__same__')
    expect(sent.msg.run_id).toBe(body.run_id)
  })

  test('regression guard: /launch never emits a session.* type the supervisor cannot handle', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(202)
    const sent = state.sentMessages[0]
    expect(String(sent.msg.type).startsWith('session.')).toBe(true)
    expect(SUPERVISOR_HANDLED_SESSION_TYPES.has(sent.msg.type)).toBe(true)
  })

  test('supervisor offline → 409 supervisor_offline', async () => {
    state.supervisorOnline = false
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('supervisor_offline')
  })

  test('session already online → 409 already_online', async () => {
    state.session.status = 'online'
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('already_online')
  })

  test('session not found (or not owned) → 404', async () => {
    const res = await app.request(`/api/sessions/sess_nope/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(404)
  })

  test('local_path missing → 409 local_path_missing with suggested_clone_dir', async () => {
    state.session.repo_key = 'github://someorg/missingrepo'
    state.session.project_dir = null
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(409)
    const body: any = await res.json()
    expect(body.error).toBe('local_path_missing')
    expect(body.repo_key).toBe('github://someorg/missingrepo')
    expect(body.suggested_clone_dir).toContain('missingrepo')
  })

  test('local_path body param pins worktree cwd when in inventory', async () => {
    state.inventory.repos.push({
      local_path: 'C:/Users/artic/GitHub/remo-code-feat',
      is_git_repo: true,
      is_worktree: true,
      worktree_parent_path: 'C:/Users/artic/GitHub/remo-code',
      git_remote: 'git@github.com:finedesignz/remo-code.git',
      git_origin_github: { owner: 'finedesignz', repo: 'remo-code' },
      branch: 'feat/x',
      canonical: false,
    })
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_path: 'C:/Users/artic/GitHub/remo-code-feat' }),
    })
    expect(res.status).toBe(202)
    expect(state.sentMessages[0].msg.repo_path).toBe('C:/Users/artic/GitHub/remo-code-feat')
  })

  test('local_path body param rejected when not in inventory → 400', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_path: 'C:/totally/unknown' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_local_path')
  })

  test('resolves cwd to canonical clone, never a worktree, even when stale project_dir points at a worktree', async () => {
    // Session row's project_dir was last overwritten by a worktree connect.
    state.session.project_dir = 'C:/Users/artic/GitHub/remo-code-refactor-hub-deepening'
    // Inventory lists BOTH the canonical clone and the worktree.
    state.inventory.repos = [
      {
        local_path: 'C:/Users/artic/GitHub/remo-code-refactor-hub-deepening',
        is_git_repo: true,
        is_worktree: true,
        worktree_parent_path: 'C:/Users/artic/GitHub/remo-code',
        git_remote: 'git@github.com:finedesignz/remo-code.git',
        git_origin_github: { owner: 'finedesignz', repo: 'remo-code' },
        canonical: false,
      },
      {
        local_path: 'C:/Users/artic/GitHub/remo-code',
        is_git_repo: true,
        is_worktree: false,
        worktree_parent_path: null,
        git_remote: 'git@github.com:finedesignz/remo-code.git',
        git_origin_github: { owner: 'finedesignz', repo: 'remo-code' },
        canonical: true,
      },
    ]
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(202)
    expect(state.sentMessages[0].msg.repo_path).toBe('C:/Users/artic/GitHub/remo-code')
  })

  test('inventory lists only worktrees (no canonical) → refuses stale worktree project_dir, 409 local_path_missing', async () => {
    state.session.project_dir = 'C:/Users/artic/GitHub/remo-code-feat'
    state.inventory.repos = [
      {
        local_path: 'C:/Users/artic/GitHub/remo-code-feat',
        is_git_repo: true,
        is_worktree: true,
        worktree_parent_path: 'C:/Users/artic/GitHub/remo-code',
        git_remote: 'git@github.com:finedesignz/remo-code.git',
        git_origin_github: { owner: 'finedesignz', repo: 'remo-code' },
        canonical: false,
      },
    ]
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('local_path_missing')
  })

  test('cold inventory (repo absent) → falls back to recorded project_dir', async () => {
    state.session.project_dir = 'C:/Users/artic/GitHub/remo-code'
    state.inventory.repos = [] // supervisor reported nothing for this repo
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(202)
    expect(state.sentMessages[0].msg.repo_path).toBe('C:/Users/artic/GitHub/remo-code')
  })

  test('cli_kind body override accepted (not on wire — resolved supervisor-side)', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli_kind: 'codex' }),
    })
    // session.start carries no cli_kind; the override is still accepted by the
    // route (no 400) and the launch dispatches normally.
    expect(res.status).toBe(202)
    expect(state.sentMessages[0].msg.type).toBe('session.start')
    expect(state.sentMessages[0].msg.cli_kind).toBeUndefined()
  })

  // ── Safety paths (triple-QC coverage gap) ────────────────────────────────

  test('dispatch failure (ws send throws) → 503, run ended + slot released (no leak)', async () => {
    state.throwOnSend = true
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as any).error).toBe('dispatch_failed')
    // A run row WAS created (reserve+createRun precede send)...
    expect(state.createdRuns).toHaveLength(1)
    // ...but it was rolled back: endRun called with the created run id + a
    // failure reason, and the reserved slot released. No leaked slot/run.
    expect(state.endRunCalls).toHaveLength(1)
    expect(state.endRunCalls[0].runId).toBe(state.createdRuns[0].id)
    expect(String(state.endRunCalls[0].reason)).toContain('dispatch_failed')
    expect(state.releaseSlotCalls).toHaveLength(1)
    expect(state.releaseSlotCalls[0]).toEqual({ userId: TEST_USER_ID, supervisorId: TEST_SUPERVISOR_ID })
    // Nothing reached the supervisor.
    expect(state.sentMessages).toHaveLength(0)
  })

  test('run_insert_failed (reservation INSERT throws) → 500, no leak, no dispatch', async () => {
    state.throwOnCreateRun = true
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(500)
    expect(((await res.json()) as any).error).toBe('run_insert_failed')
    // The run row is consumed INSIDE the reservation tx now: when the INSERT
    // throws the whole tx rolls back, so the slot is never committed — there is
    // nothing to release. No run row, no endRun, no dispatch, no leaked slot.
    expect(state.releaseSlotCalls).toHaveLength(0)
    expect(state.createdRuns).toHaveLength(0)
    expect(state.endRunCalls).toHaveLength(0)
    expect(state.sentMessages).toHaveLength(0)
  })

  test('at capacity → 429 with {running,cap}; gate blocks before createRun (no run, no dispatch)', async () => {
    state.reserveResult = { ok: false, reason: 'at_capacity', running: 4, cap: 4 }
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(429)
    const body: any = await res.json()
    expect(body.error).toBe('at_capacity')
    expect(body.running).toBe(4)
    expect(body.cap).toBe(4)
    // Gate is before createRun + dispatch: no run, no session.start, no release.
    expect(state.createdRuns).toHaveLength(0)
    expect(state.sentMessages).toHaveLength(0)
    expect(state.releaseSlotCalls).toHaveLength(0)
  })
})

describe('POST /api/sessions/:id/disconnect', () => {
  test('online session → 200, shutdown sent to channel, runs ended, row KEPT + offline (no soft-delete)', async () => {
    state.session.status = 'online'
    state.channelOnline = true
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('offline')
    // Shutdown directive went to the channel with the user_disconnect reason.
    expect(state.channelSends).toHaveLength(1)
    const sent = JSON.parse(state.channelSends[0])
    expect(sent.type).toBe('shutdown')
    expect(sent.reason).toBe('user_disconnect')
    // Open runs ended (slot freed) — scoped to this session + user.
    expect(state.endOpenRunsCalls).toHaveLength(1)
    expect(state.endOpenRunsCalls[0]).toEqual({ sessionId: TEST_SESSION_ID, userId: TEST_USER_ID, reason: 'user_disconnect' })
    // Row marked offline via markSessionOffline (KEEP) — NOT markSessionDisconnected/delete.
    expect(state.markOfflineCalls).toHaveLength(1)
    expect(state.markOfflineCalls[0]).toEqual({ id: TEST_SESSION_ID, userId: TEST_USER_ID })
    // The session row still resolves (not soft-deleted) and is offline.
    expect(state.session.status).toBe('offline')
    const after = await app.request(`/api/sessions/${TEST_SESSION_ID}`, { method: 'GET' })
    expect(after.status).toBe(200)
    expect(((await after.json()) as any).id).toBe(TEST_SESSION_ID)
  })

  test('idempotent: already offline + no channel → 200 no-op (no shutdown, row kept)', async () => {
    state.session.status = 'offline'
    state.channelOnline = false
    state.openRunsCount = 0
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/disconnect`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(state.channelSends).toHaveLength(0)
    // Still flips/keeps offline + frees any runs (no-op when none open).
    expect(state.markOfflineCalls).toHaveLength(1)
    expect(state.session.status).toBe('offline')
  })

  test('not found / not owned → 404', async () => {
    const res = await app.request(`/api/sessions/sess_nope/disconnect`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(state.channelSends).toHaveLength(0)
    expect(state.markOfflineCalls).toHaveLength(0)
  })

  test('disconnect → launch reuses the SAME session_id (no new session created, history kept)', async () => {
    // 1. Online session gets disconnected (row kept, status offline).
    state.session.status = 'online'
    state.channelOnline = true
    const disc = await app.request(`/api/sessions/${TEST_SESSION_ID}/disconnect`, { method: 'POST' })
    expect(disc.status).toBe(200)
    expect(state.session.status).toBe('offline')

    // 2. The SAME session id still resolves via getSession (no soft-delete).
    //    /launch resolves the existing row (it 404s when the row is gone) and
    //    dispatches session.start bound to this session's repo_path — resuming
    //    the same session, NOT creating a new one.
    state.channelOnline = false // runner has exited
    const launch = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(launch.status).toBe(202)
    // No new session row was created (createSession is never called on launch);
    // the dispatched start targets the existing session's canonical cwd.
    expect(state.sentMessages).toHaveLength(1)
    expect(state.sentMessages[0].msg.type).toBe('session.start')
    expect(state.sentMessages[0].msg.repo_path).toBe('C:/Users/artic/GitHub/remo-code')
  })
})

describe('POST /api/sessions/:id/clone-here', () => {
  test('happy path → 202 + repo.clone dispatched to default root', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/clone-here`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(202)
    const body: any = await res.json()
    expect(body.cloning).toBe(true)
    expect(state.sentMessages[0].msg.type).toBe('repo.clone')
    expect(state.sentMessages[0].msg.clone_url).toBe('https://github.com/finedesignz/remo-code.git')
    expect(state.sentMessages[0].msg.target_path).toContain('remo-code')
  })

  test('non-GitHub-keyed session → 400 no_repo_key', async () => {
    state.session.repo_key = null
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/clone-here`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('no_repo_key')
  })

  test('target_root not in inventory → 400', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/clone-here`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_root: 'D:/Evil' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('target_root_not_in_inventory')
  })
})

describe('POST /api/sessions/:id/create-github-repo', () => {
  test('happy path → 202 + job_id', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/create-github-repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private', name: 'remo-code' }),
    })
    expect(res.status).toBe(202)
    const body: any = await res.json()
    expect(body.job_id).toBe('job_test_123')
    expect(body.status).toBe('queued')
  })

  test('GitHub App missing administration:write → 412', async () => {
    state.scope = { hasAdminWrite: false, hasContentsWrite: true, kind: 'app_installation' }
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/create-github-repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(res.status).toBe(412)
    const body: any = await res.json()
    expect(body.error).toBe('github_app_missing_scope')
    expect(body.missing_scope).toBe('administration:write')
  })

  test('supervisor offline → 409', async () => {
    state.supervisorOnline = false
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/create-github-repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error).toBe('supervisor_offline')
  })

  test('invalid repo name → 400', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/create-github-repo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad name with spaces' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe('invalid_repo_name')
  })
})
