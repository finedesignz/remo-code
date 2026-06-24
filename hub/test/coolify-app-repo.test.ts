/**
 * feat/coolify-uuid-repo-map — resolveRepoKeyFromAppUuid unit tests.
 *
 * Coolify's `deployment.failed` webhook has no `git_repository` — only
 * `application_uuid`. This resolver maps the uuid → repo_key via a cache table,
 * falling back to the Coolify API on miss/stale, normalizing through the existing
 * `repoKeyFromGitRepository`. It must NEVER throw (errors → null → caller falls
 * back to capacity routing).
 *
 * Mocks: dal get/upsert helpers + global fetch + COOLIFY_TOKEN env.
 */
import { describe, it, expect, mock, afterAll, beforeEach } from 'bun:test'

// Mutable cache + fetch state.
const cache: Record<string, any> = {}
const upserts: any[] = []
let fetchImpl: (url: string, init?: any) => Promise<any> = async () => {
  throw new Error('fetch not configured')
}

const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  getCoolifyAppRepo: async (uuid: string, userId: string) => cache[`${userId}:${uuid}`] ?? null,
  upsertCoolifyAppRepo: async (row: any) => {
    upserts.push(row)
    cache[`${row.user_id}:${row.application_uuid}`] = { ...row, updated_at: new Date().toISOString() }
  },
}))

const origFetch = globalThis.fetch
// @ts-expect-error override
globalThis.fetch = (url: string, init?: any) => fetchImpl(url, init)

const { resolveRepoKeyFromAppUuid, extractGitUrl } = await import(
  '../src/sessions/coolify-app-repo.ts?app-repo'
)

afterAll(() => {
  globalThis.fetch = origFetch
  mock.restore()
})

beforeEach(() => {
  for (const k of Object.keys(cache)) delete cache[k]
  upserts.length = 0
  process.env.COOLIFY_TOKEN = 'tok'
  process.env.COOLIFY_BASE_URL = 'https://coolify.example.com'
  fetchImpl = async () => {
    throw new Error('fetch not configured')
  }
})

function jsonRes(body: any, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('extractGitUrl', () => {
  it('prefers git_full_url', () => {
    expect(extractGitUrl({ git_full_url: 'https://github.com/o/r.git', git_repository: 'x/y' })).toBe(
      'https://github.com/o/r.git',
    )
  })
  it('falls back to git_repository', () => {
    expect(extractGitUrl({ git_repository: 'o/r' })).toBe('o/r')
  })
  it('null when neither present', () => {
    expect(extractGitUrl({})).toBeNull()
    expect(extractGitUrl(null)).toBeNull()
  })
})

describe('resolveRepoKeyFromAppUuid', () => {
  it('cache hit (fresh) → returns cached repo_key, no fetch', async () => {
    cache['u1:app-1'] = {
      application_uuid: 'app-1',
      user_id: 'u1',
      repo_key: 'github://o/r',
      git_full_url: null,
      updated_at: new Date().toISOString(),
    }
    let fetched = false
    fetchImpl = async () => {
      fetched = true
      return jsonRes({})
    }
    const r = await resolveRepoKeyFromAppUuid('app-1', 'u1')
    expect(r).toBe('github://o/r')
    expect(fetched).toBe(false)
  })

  it('cache miss → fetches Coolify API, normalizes, upserts', async () => {
    fetchImpl = async (url: string, init?: any) => {
      expect(url).toContain('/api/v1/applications/app-2')
      expect(init?.headers?.Authorization).toBe('Bearer tok')
      return jsonRes({ git_full_url: 'git@github.com:Finedesignz/Remo-Code.git' })
    }
    const r = await resolveRepoKeyFromAppUuid('app-2', 'u1')
    expect(r).toBe('github://finedesignz/remo-code')
    expect(upserts.length).toBe(1)
    expect(upserts[0]).toMatchObject({ application_uuid: 'app-2', user_id: 'u1', repo_key: 'github://finedesignz/remo-code' })
  })

  it('stale cache (>24h) → re-resolves via API', async () => {
    cache['u1:app-3'] = {
      application_uuid: 'app-3',
      user_id: 'u1',
      repo_key: 'github://old/key',
      git_full_url: null,
      updated_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    fetchImpl = async () => jsonRes({ git_repository: 'new/repo' })
    const r = await resolveRepoKeyFromAppUuid('app-3', 'u1')
    expect(r).toBe('github://new/repo')
  })

  it('no COOLIFY_TOKEN → null on miss (no throw)', async () => {
    delete process.env.COOLIFY_TOKEN
    const r = await resolveRepoKeyFromAppUuid('app-4', 'u1')
    expect(r).toBeNull()
  })

  it('Coolify HTTP error → null (never throws)', async () => {
    fetchImpl = async () => jsonRes({}, false, 500)
    const r = await resolveRepoKeyFromAppUuid('app-5', 'u1')
    expect(r).toBeNull()
    expect(upserts.length).toBe(0)
  })

  it('fetch rejects (network) → null (never throws)', async () => {
    fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await resolveRepoKeyFromAppUuid('app-6', 'u1')
    expect(r).toBeNull()
  })

  it('non-github / unparseable remote → null, no upsert', async () => {
    fetchImpl = async () => jsonRes({ git_full_url: 'https://gitlab.com/a/b.git' })
    const r = await resolveRepoKeyFromAppUuid('app-7', 'u1')
    expect(r).toBeNull()
    expect(upserts.length).toBe(0)
  })

  it('stale cache + API failure → serves stale repo_key (LOW-1)', async () => {
    cache['u1:app-stale'] = {
      application_uuid: 'app-stale',
      user_id: 'u1',
      repo_key: 'github://stale/key',
      git_full_url: null,
      updated_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    }
    // HTTP error
    fetchImpl = async () => jsonRes({}, false, 500)
    expect(await resolveRepoKeyFromAppUuid('app-stale', 'u1')).toBe('github://stale/key')
    // network reject
    fetchImpl = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await resolveRepoKeyFromAppUuid('app-stale', 'u1')).toBe('github://stale/key')
    // unconfigured token
    delete process.env.COOLIFY_TOKEN
    expect(await resolveRepoKeyFromAppUuid('app-stale', 'u1')).toBe('github://stale/key')
  })

  it('cross-user isolation: same uuid, each user resolves own repo_key, no clobber (MED-1)', async () => {
    const uuid = 'shared-app-uuid'
    cache[`u1:${uuid}`] = {
      application_uuid: uuid,
      user_id: 'u1',
      repo_key: 'github://o/repo-one',
      git_full_url: null,
      updated_at: new Date().toISOString(),
    }
    cache[`u2:${uuid}`] = {
      application_uuid: uuid,
      user_id: 'u2',
      repo_key: 'github://o/repo-two',
      git_full_url: null,
      updated_at: new Date().toISOString(),
    }
    let fetched = false
    fetchImpl = async () => {
      fetched = true
      return jsonRes({})
    }
    expect(await resolveRepoKeyFromAppUuid(uuid, 'u1')).toBe('github://o/repo-one')
    expect(await resolveRepoKeyFromAppUuid(uuid, 'u2')).toBe('github://o/repo-two')
    expect(fetched).toBe(false)
    // u2's upsert (on its own miss) must not overwrite u1's row.
    delete cache[`u2:${uuid}`]
    fetchImpl = async () => jsonRes({ git_repository: 'o/repo-two' })
    expect(await resolveRepoKeyFromAppUuid(uuid, 'u2')).toBe('github://o/repo-two')
    expect(cache[`u1:${uuid}`].repo_key).toBe('github://o/repo-one')
  })

  it('empty / null appUuid → null (no fetch)', async () => {
    let fetched = false
    fetchImpl = async () => {
      fetched = true
      return jsonRes({})
    }
    expect(await resolveRepoKeyFromAppUuid('', 'u1')).toBeNull()
    expect(await resolveRepoKeyFromAppUuid(null, 'u1')).toBeNull()
    expect(fetched).toBe(false)
  })
})
