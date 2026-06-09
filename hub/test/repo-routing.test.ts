import { describe, it, expect, mock, afterAll } from 'bun:test'
import { repoKeyFromGitRepository, buildRepoKey } from '../src/lib/repo-key.ts'

// ── repoKeyFromGitRepository (pure) ──────────────────────────────────────────
describe('repoKeyFromGitRepository (auto-dev P5)', () => {
  it('parses HTTPS remote', () => {
    expect(repoKeyFromGitRepository('https://github.com/finedesignz/remo-code.git')).toBe(
      'github://finedesignz/remo-code',
    )
  })
  it('parses SSH remote', () => {
    expect(repoKeyFromGitRepository('git@github.com:Finedesignz/Remo-Code.git')).toBe(
      'github://finedesignz/remo-code',
    )
  })
  it('parses bare owner/repo slug (Coolify form)', () => {
    expect(repoKeyFromGitRepository('finedesignz/remo-code')).toBe('github://finedesignz/remo-code')
  })
  it('strips .git on bare slug', () => {
    expect(repoKeyFromGitRepository('owner/repo.git')).toBe('github://owner/repo')
  })
  it('returns null for empty / absent', () => {
    expect(repoKeyFromGitRepository(null)).toBeNull()
    expect(repoKeyFromGitRepository(undefined)).toBeNull()
    expect(repoKeyFromGitRepository('')).toBeNull()
  })
  it('returns null for non-github / unparseable', () => {
    expect(repoKeyFromGitRepository('gitlab.com/a/b')).toBeNull()
    expect(repoKeyFromGitRepository('just-a-word')).toBeNull()
  })
  it('matches buildRepoKey output for the same repo', () => {
    expect(repoKeyFromGitRepository('owner/repo')).toBe(buildRepoKey({ owner: 'owner', repo: 'repo' }))
  })
})

// ── resolveRepoKeyedAgentSession (mocked dal + registry) ─────────────────────
// Configurable state for stubs.
const sessionsForKey: Record<string, string[]> = {}
const onlineSessions = new Set<string>()

const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  listSessionIdsForRepoKey: async (_u: string, key: string) => sessionsForKey[key] ?? [],
}))

const realReg = await import('../src/ws/registry.ts')
mock.module('../src/ws/registry.ts', () => ({
  ...realReg,
  getChannel: (sid: string) => (onlineSessions.has(sid) ? ({} as any) : undefined),
}))

// feat/coolify-uuid-repo-map: uuid→repo_key resolver stub. Keyed by appUuid.
const repoKeyForUuid: Record<string, string | null> = {}
mock.module('../src/sessions/coolify-app-repo.ts', () => ({
  resolveRepoKeyFromAppUuid: async (uuid: string) => repoKeyForUuid[uuid] ?? null,
}))

const { resolveRepoKeyedAgentSession } = await import(
  '../src/sessions/repo-routing.ts?repo-routing'
)

afterAll(() => mock.restore())

describe('resolveRepoKeyedAgentSession (auto-dev P5)', () => {
  it('git_repository matches a session.repo_key with a live socket → that session', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    onlineSessions.clear()
    sessionsForKey['github://finedesignz/remo-code'] = ['sess-A']
    onlineSessions.add('sess-A')
    const r = await resolveRepoKeyedAgentSession('u1', 'finedesignz/remo-code')
    expect(r).toEqual({
      kind: 'repo_keyed_agent',
      agent_session_id: 'sess-A',
      repo_key: 'github://finedesignz/remo-code',
    })
  })

  it('bound session exists but socket offline → null (caller falls back)', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    onlineSessions.clear()
    sessionsForKey['github://finedesignz/remo-code'] = ['sess-A']
    // no online sessions
    const r = await resolveRepoKeyedAgentSession('u1', 'finedesignz/remo-code')
    expect(r).toBeNull()
  })

  it('no session bound to the repo → null', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    onlineSessions.clear()
    const r = await resolveRepoKeyedAgentSession('u1', 'finedesignz/remo-code')
    expect(r).toBeNull()
  })

  it('unparseable git_repository → null (no DB call needed)', async () => {
    const r = await resolveRepoKeyedAgentSession('u1', 'not-a-repo')
    expect(r).toBeNull()
  })

  it('no git_repository but application_uuid resolves repo_key → matches bound session', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    for (const k of Object.keys(repoKeyForUuid)) delete repoKeyForUuid[k]
    onlineSessions.clear()
    repoKeyForUuid['app-xyz'] = 'github://o/r'
    sessionsForKey['github://o/r'] = ['sess-U']
    onlineSessions.add('sess-U')
    const r = await resolveRepoKeyedAgentSession('u1', null, 'app-xyz')
    expect(r).toEqual({ kind: 'repo_keyed_agent', agent_session_id: 'sess-U', repo_key: 'github://o/r' })
  })

  it('git_repository present takes precedence over application_uuid resolver', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    for (const k of Object.keys(repoKeyForUuid)) delete repoKeyForUuid[k]
    onlineSessions.clear()
    repoKeyForUuid['app-xyz'] = 'github://wrong/key' // must NOT be used
    sessionsForKey['github://finedesignz/remo-code'] = ['sess-G']
    onlineSessions.add('sess-G')
    const r = await resolveRepoKeyedAgentSession('u1', 'finedesignz/remo-code', 'app-xyz')
    expect(r?.repo_key).toBe('github://finedesignz/remo-code')
  })

  it('no git_repository + uuid resolves null → null (caller falls back)', async () => {
    for (const k of Object.keys(repoKeyForUuid)) delete repoKeyForUuid[k]
    const r = await resolveRepoKeyedAgentSession('u1', null, 'unknown-app')
    expect(r).toBeNull()
  })

  it('picks first ONLINE among multiple bound sessions', async () => {
    for (const k of Object.keys(sessionsForKey)) delete sessionsForKey[k]
    onlineSessions.clear()
    sessionsForKey['github://o/r'] = ['offline-1', 'online-2', 'online-3']
    onlineSessions.add('online-2')
    onlineSessions.add('online-3')
    const r = await resolveRepoKeyedAgentSession('u1', 'o/r')
    expect(r?.agent_session_id).toBe('online-2')
  })
})
