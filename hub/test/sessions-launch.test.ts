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
} = {
  session: null,
  supervisorOnline: true,
  inventory: null,
  scope: { hasAdminWrite: true, hasContentsWrite: true, kind: 'app_installation' },
  sentMessages: [],
}

mock.module('../src/db/dal.ts', () => ({
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
  getPendingPrompts: async () => [],
  dismissLocalSession: async () => ({}),
}))

mock.module('../src/db/chat-tabs-dal.ts', () => ({
  getMessagesForSessions: async () => ({}),
}))

mock.module('../src/db/supervisor-dal.ts', () => ({
  createRun: async () => ({ id: 'run_x' }),
  endRun: async () => ({}),
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
  getChannel: () => null,
  broadcastToUser: (..._args: any[]) => {},
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  sendToSupervisor: (supId: string, msg: any) => {
    state.sentMessages.push({ supId, msg })
  },
  updateSupervisorState: async () => {},
  listOnlineSupervisorIdsForUser: () =>
    state.supervisorOnline ? [TEST_SUPERVISOR_ID] : [],
  getSupervisor: () => (state.supervisorOnline ? { supervisorId: TEST_SUPERVISOR_ID } : undefined),
  resolveLocalPathForRepoKey: (_uid: string, repoKey: string) => {
    if (!state.inventory) return null
    const m = state.inventory.repos.find((r: any) => {
      if (!r.git_origin_github) return false
      const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
      return k === repoKey.toLowerCase()
    })
    return m?.local_path ?? null
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
  releaseSessionSlot: async () => {},
  // Phase 12 W2 — keep full surface so cross-test imports of api/supervisors
  // (which imports reserveSessionSlot + getCapacitySnapshot) don't break when
  // this stub is the active mock.
  reserveSessionSlot: async () => ({ ok: false as const, reason: 'noop' as const }),
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
})

// ── Tests ────────────────────────────────────────────────────────────────
describe('POST /api/sessions/:id/launch', () => {
  test('happy path → 202 + session.launch dispatched with canonical cwd', async () => {
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
    expect(sent.msg.type).toBe('session.launch')
    expect(sent.msg.cwd).toBe('C:/Users/artic/GitHub/remo-code')
    expect(sent.msg.cli_kind).toBe('claude')
    expect(sent.msg.session_id).toBe(TEST_SESSION_ID)
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
    expect(state.sentMessages[0].msg.cwd).toBe('C:/Users/artic/GitHub/remo-code-feat')
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

  test('cli_kind override applied', async () => {
    const res = await app.request(`/api/sessions/${TEST_SESSION_ID}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cli_kind: 'codex' }),
    })
    expect(res.status).toBe(202)
    expect(state.sentMessages[0].msg.cli_kind).toBe('codex')
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
