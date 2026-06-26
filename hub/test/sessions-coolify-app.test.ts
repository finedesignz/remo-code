/**
 * Tests for GET /api/sessions/:id/coolify-app — resolves the Coolify app bound
 * to a session's repo (for auto-filling the schedule-editor notes placeholders).
 *
 * DAL is mocked via `mock.module` (spread-real so sibling files keep the full
 * export surface; see memory: bun-mock-pollution). No DB required.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111'
const SESSION_KEYED = 'sess_keyed'
const SESSION_NOREPO = 'sess_norepo'
const SESSION_NOAPP = 'sess_noapp'

const state: {
  sessions: Record<string, any>
  appByRepoKey: Record<string, any>
} = {
  sessions: {
    [SESSION_KEYED]: {
      id: SESSION_KEYED,
      repo_key: 'github://finedesignz/remo-code',
      github_repo: 'remo-code',
    },
    [SESSION_NOREPO]: { id: SESSION_NOREPO, repo_key: null, github_repo: null },
    [SESSION_NOAPP]: {
      id: SESSION_NOAPP,
      repo_key: 'github://finedesignz/other',
      github_repo: 'other',
    },
  },
  appByRepoKey: {
    'github://finedesignz/remo-code': {
      application_uuid: 'app-uuid-123',
      user_id: TEST_USER_ID,
      repo_key: 'github://finedesignz/remo-code',
      git_full_url: 'https://github.com/finedesignz/remo-code.git',
      updated_at: new Date().toISOString(),
    },
  },
}

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getSession: async (id: string, userId: string) => {
    if (userId !== TEST_USER_ID) return null
    return state.sessions[id] ?? null
  },
  getCoolifyAppByRepoKey: async (repoKey: string, userId: string) => {
    if (userId !== TEST_USER_ID) return null
    return state.appByRepoKey[repoKey] ?? null
  },
}))

mock.module('../src/db/chat-tabs-dal.ts', () => ({
  getMessagesForSessions: async () => ({}),
}))

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

beforeEach(() => {})

describe('GET /api/sessions/:id/coolify-app', () => {
  test('resolves uuid + slug for a repo-keyed session with a cached app', async () => {
    const res = await app.request(`/api/sessions/${SESSION_KEYED}/coolify-app`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.application_uuid).toBe('app-uuid-123')
    // Slug derived from the git remote's repo name.
    expect(body.app_slug).toBe('remo-code')
  })

  test('returns nulls for a session with no repo_key', async () => {
    const res = await app.request(`/api/sessions/${SESSION_NOREPO}/coolify-app`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.application_uuid).toBeNull()
    expect(body.app_slug).toBeNull()
  })

  test('falls back to github_repo slug when no Coolify app is cached', async () => {
    const res = await app.request(`/api/sessions/${SESSION_NOAPP}/coolify-app`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.application_uuid).toBeNull()
    expect(body.app_slug).toBe('other')
  })

  test('404s for an unknown session', async () => {
    const res = await app.request(`/api/sessions/sess_missing/coolify-app`)
    expect(res.status).toBe(404)
  })
})
