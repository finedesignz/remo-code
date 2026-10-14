/**
 * PTYCAP-05 plan 02 task 1: the read-only ProofGithub adapter.
 * No network: the request function is injected and records (method, path).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { makeProofGithub } from '../src/orchestrator/proof-github.ts'
import { ProofGithubError } from '../src/orchestrator/proof-types.ts'

const O = 'acme'
const R = 'proof'
const REPO = `/repos/${O}/${R}`
const SHA = 'a'.repeat(40)

type Resp = unknown | ((path: string) => unknown)

function fakeRequest(routes: Record<string, Resp>) {
  const calls: Array<{ method: string; path: string }> = []
  const request = async (_installationId: number, method: string, path: string) => {
    calls.push({ method, path })
    if (!(path in routes)) throw Object.assign(new Error(`no route ${path}`), { status: 404 })
    const v = routes[path]
    if (v instanceof Error) throw v
    return typeof v === 'function' ? (v as (p: string) => unknown)(path) : v
  }
  return { request: request as never, calls }
}

const httpErr = (status: number) => Object.assign(new Error(`github api GET ${status}`), { status })

describe('makeProofGithub paths and normalization', () => {
  test('every method issues only GET requests on the documented paths', async () => {
    const { request, calls } = fakeRequest({
      [REPO]: { full_name: 'acme/proof', default_branch: 'main' },
      [`${REPO}/branches/main`]: { commit: { sha: SHA } },
      [`${REPO}/rules/branches/main`]: [
        { type: 'update', ruleset_id: 7, ruleset_source_type: 'Repository' },
        { type: 'required_status_checks', ruleset_id: 7, ruleset_source_type: 'Repository', parameters: { required_status_checks: [{ context: 'ci' }] } },
      ],
      [`${REPO}/rulesets/7?includes_parents=true`]: {
        id: 7, name: 'lock', target: 'branch', source_type: 'Repository', enforcement: 'active',
        bypass_actors: [], conditions: { a: 1 }, rules: [{ type: 'update' }], updated_at: '2026-10-01T00:00:00Z',
      },
      [`${REPO}/compare/${SHA}...main?per_page=1`]: { status: 'ahead', ahead_by: 2, behind_by: 0 },
      [`${REPO}/pulls?state=all&sort=created&direction=desc&per_page=50`]: [
        { number: 3, html_url: 'u3', state: 'closed', merged_at: '2026-10-02T00:00:00Z', draft: false, head: { ref: 'proof/x', sha: 'h3' }, base: { ref: 'main' } },
        { number: 4, html_url: 'u4', state: 'open', merged_at: null, draft: true, head: { ref: 'feat/y', sha: 'h4' }, base: { ref: 'main' } },
      ],
      [`${REPO}/commits/${SHA}/check-runs?per_page=100`]: { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
      [`${REPO}/commits/${SHA}/status?per_page=100`]: { total_count: 1, statuses: [{ context: 'lint', state: 'success' }] },
      [`${REPO}/contents/.github/workflows?ref=main`]: [{ name: 'ci.yml' }, { name: 'README.md' }, { name: 'b.yaml' }],
      [`${REPO}/collaborators/bot/permission`]: { permission: 'write' },
    })
    const gh = makeProofGithub({ installationId: 1 }, { request })

    expect(await gh.getRepo(O, R)).toEqual({ fullName: 'acme/proof', defaultBranch: 'main' })
    expect(await gh.getBranchHeadSha(O, R, 'main')).toBe(SHA)
    const rules = await gh.getEffectiveBranchRules(O, R, 'main')
    expect(rules[0]).toEqual({ type: 'update', rulesetId: 7, rulesetSourceType: 'Repository', parameters: null })
    expect(rules[1]?.parameters).toEqual({ required_status_checks: [{ context: 'ci' }] })
    const rs = await gh.getRuleset(O, R, 7)
    expect(rs).toMatchObject({ id: 7, sourceType: 'Repository', enforcement: 'active', bypassActors: [], updatedAt: '2026-10-01T00:00:00Z' })
    expect(rs.rules).toEqual([{ type: 'update', parameters: null }])
    expect(await gh.compare(O, R, SHA, 'main')).toEqual({ status: 'ahead', aheadBy: 2, behindBy: 0 })
    const pulls = await gh.listPullsWithHeadPrefix(O, R, 'proof/')
    expect(pulls).toHaveLength(1)
    expect(pulls[0]).toMatchObject({ number: 3, merged: true, mergedAt: '2026-10-02T00:00:00Z', headRef: 'proof/x', headSha: 'h3', baseRef: 'main', htmlUrl: 'u3' })
    expect(await gh.getCheckState(O, R, SHA)).toEqual({
      checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
      statuses: [{ context: 'lint', state: 'success' }],
      truncated: false,
    })
    expect(await gh.listWorkflowFiles(O, R, 'main')).toEqual(['ci.yml', 'b.yaml'])
    expect(await gh.getCollaboratorPermission(O, R, 'bot')).toBe('write')

    expect(calls.length).toBe(10)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.map((c) => c.path)).toContain(`${REPO}/compare/${SHA}...main?per_page=1`)
  })

  test('bypass_actors absent maps to null (never to an empty array)', async () => {
    const { request } = fakeRequest({
      [`${REPO}/rulesets/9?includes_parents=true`]: {
        id: 9, name: 'n', target: 'branch', source_type: 'Repository', enforcement: 'active', conditions: null, rules: [], updated_at: null,
      },
    })
    const rs = await makeProofGithub({ installationId: 1 }, { request }).getRuleset(O, R, 9)
    expect(rs.bypassActors).toBeNull()
    expect(rs.updatedAt).toBeNull()
  })

  test('check state is truncated when totals exceed the returned items', async () => {
    const { request } = fakeRequest({
      [`${REPO}/commits/${SHA}/check-runs?per_page=100`]: { total_count: 150, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
      [`${REPO}/commits/${SHA}/status?per_page=100`]: { total_count: 0, statuses: [] },
    })
    const cs = await makeProofGithub({ installationId: 1 }, { request }).getCheckState(O, R, SHA)
    expect(cs.truncated).toBe(true)
  })

  test('path segments are URL-encoded', async () => {
    const { request, calls } = fakeRequest({ [`${REPO}/branches/feat%2Fx`]: { commit: { sha: SHA } } })
    await makeProofGithub({ installationId: 1 }, { request }).getBranchHeadSha(O, R, 'feat/x')
    expect(calls[0]?.path).toBe(`${REPO}/branches/feat%2Fx`)
  })

  test('the installation id is forwarded to the transport', async () => {
    let seen: unknown
    const request = (async (id: number) => {
      seen = id
      return { full_name: 'a/b', default_branch: 'main' }
    }) as never
    await makeProofGithub({ installationId: '4242' }, { request }).getRepo(O, R)
    expect(seen).toBe(4242)
  })
})

describe('makeProofGithub error mapping', () => {
  const kindOf = async (err: unknown): Promise<ProofGithubError> => {
    const { request } = fakeRequest({ [REPO]: err as Error })
    try {
      await makeProofGithub({ installationId: 1 }, { request }).getRepo(O, R)
    } catch (e) {
      return e as ProofGithubError
    }
    throw new Error('expected rejection')
  }

  test('a 403 maps to kind forbidden and keeps the status', async () => {
    const e = await kindOf(httpErr(403))
    expect(e).toBeInstanceOf(ProofGithubError)
    expect(e.kind).toBe('forbidden')
    expect(e.status).toBe(403)
  })

  test('a 404 maps to not_found', async () => {
    const e = await kindOf(httpErr(404))
    expect(e.kind).toBe('not_found')
    expect(e.status).toBe(404)
  })

  test('any other status maps to unavailable and keeps the status', async () => {
    const e = await kindOf(httpErr(502))
    expect(e.kind).toBe('unavailable')
    expect(e.status).toBe(502)
  })

  test('a thrown non-GitHubApiError maps to unavailable with a null status', async () => {
    const e = await kindOf(new Error('socket hang up'))
    expect(e.kind).toBe('unavailable')
    expect(e.status).toBeNull()
  })

  test('a malformed payload is unavailable (fail closed), never a silent default', async () => {
    const { request } = fakeRequest({ [`${REPO}/compare/${SHA}...main?per_page=1`]: { status: 'weird' } })
    const gh = makeProofGithub({ installationId: 1 }, { request })
    await expect(gh.compare(O, R, SHA, 'main')).rejects.toMatchObject({ kind: 'unavailable' })
  })
})

describe('makeProofGithub.probePermissions', () => {
  const ok = { ok: true }
  const routes = (): Record<string, Resp> => ({
    [REPO]: { full_name: 'acme/proof', default_branch: 'main' },
    [`${REPO}/rulesets?per_page=1`]: [],
    [`${REPO}/commits/main/check-runs?per_page=1`]: ok,
    [`${REPO}/commits/main/status?per_page=1`]: ok,
    [`${REPO}/pulls?per_page=1`]: [],
    [`${REPO}/branches/main`]: ok,
  })

  test('all true when every probe succeeds; all GET', async () => {
    const { request, calls } = fakeRequest(routes())
    const p = await makeProofGithub({ installationId: 1 }, { request }).probePermissions(O, R)
    expect(p).toEqual({ administrationRead: true, checksRead: true, statusesRead: true, pullsRead: true, contentsRead: true })
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  test('a 403 yields false for that permission only and never throws', async () => {
    const r = routes()
    r[`${REPO}/rulesets?per_page=1`] = httpErr(403)
    r[`${REPO}/commits/main/check-runs?per_page=1`] = httpErr(403)
    const { request } = fakeRequest(r)
    const p = await makeProofGithub({ installationId: 1 }, { request }).probePermissions(O, R)
    expect(p).toEqual({ administrationRead: false, checksRead: false, statusesRead: true, pullsRead: true, contentsRead: true })
  })

  test('an unreadable repo yields all false without throwing', async () => {
    const { request } = fakeRequest({ [REPO]: httpErr(404) })
    const p = await makeProofGithub({ installationId: 1 }, { request }).probePermissions(O, R)
    expect(Object.values(p).every((v) => v === false)).toBe(true)
  })
})

describe('proof-github.ts source properties', () => {
  const src = readFileSync(new URL('../src/orchestrator/proof-github.ts', import.meta.url), 'utf8')
  test('no write HTTP verb string and no plain-Error transport', () => {
    for (const verb of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'"]) expect(src.includes(verb)).toBe(false)
    expect(src.includes('githubApiGet')).toBe(false)
  })
  test('does not read process.env', () => {
    expect(src.includes('process.env')).toBe(false)
  })
})
