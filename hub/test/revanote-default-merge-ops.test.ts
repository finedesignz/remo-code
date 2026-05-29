/**
 * Real-impl tests for defaultMergeOps openPr / squashMerge + ensureBranch.
 *
 * Mocks the GitHub API surface (`apiRequest`) and git ops (`gitOps`) so the
 * tests don't shell out or touch the network. Asserts call shape, idempotency
 * on 422, and clear error surfacing on 405 / 409.
 */
import { describe, expect, test } from 'bun:test'
import { defaultMergeOps, ensureBranch } from '../src/revanote/merge-gate'

class FakeApiError extends Error {
  status: number
  body: string
  constructor(status: number, body = '') {
    super(`fake ${status}`)
    this.status = status
    this.body = body
  }
}

interface ApiCall { method: string; path: string; body?: unknown }

function fakeApi(handlers: Array<(c: ApiCall) => any>): {
  fn: (installationId: number, method: any, path: string, body?: unknown) => Promise<any>
  calls: ApiCall[]
} {
  const calls: ApiCall[] = []
  let idx = 0
  return {
    calls,
    fn: async (_inst, method, path, body) => {
      const call: ApiCall = { method, path, body }
      calls.push(call)
      const h = handlers[idx++]
      if (!h) throw new Error(`unexpected api call #${calls.length}: ${method} ${path}`)
      const out = h(call)
      if (out instanceof FakeApiError) throw out
      return out
    },
  }
}

function fakeGit(branch = 'revanote/sandbox/abcdef') {
  const pushes: Array<{ remote: string; branch: string }> = []
  return {
    pushes,
    gitOps: {
      currentBranch: async () => branch,
      push: async (_dir: string, remote: string, b: string) => {
        pushes.push({ remote, branch: b })
      },
    },
  }
}

describe('defaultMergeOps.openPr', () => {
  test('happy path — pushes branch, opens PR, returns html_url', async () => {
    const { fn: api, calls } = fakeApi([
      // POST /repos/{o}/{r}/pulls
      () => ({ html_url: 'https://github.com/acme/site/pull/42', number: 42 }),
    ])
    const { gitOps, pushes } = fakeGit()
    const ops = defaultMergeOps({ installationId: 999, apiRequest: api, gitOps })

    const url = await ops.openPr({
      sandboxDir: '/tmp/sb',
      repoSlug: 'acme/site',
      batchId: 'batch-abc',
      title: 'revanote: minor change',
      body: 'risk_class=minor\nbase_branch=agent-auto\n\nstuff',
    })

    expect(url).toBe('https://github.com/acme/site/pull/42')
    expect(pushes).toEqual([{ remote: 'origin', branch: 'revanote/sandbox/abcdef' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].path).toBe('/repos/acme/site/pulls')
    expect(calls[0].body).toMatchObject({
      title: 'revanote: minor change',
      head: 'revanote/sandbox/abcdef',
      base: 'agent-auto',
    })
  })

  test('falls back to repo default_branch when body has no base_branch line', async () => {
    const { fn: api, calls } = fakeApi([
      // GET /repos/{o}/{r}
      () => ({ default_branch: 'main' }),
      // POST /repos/{o}/{r}/pulls
      () => ({ html_url: 'https://github.com/acme/site/pull/7', number: 7 }),
    ])
    const { gitOps } = fakeGit()
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps })

    const url = await ops.openPr({
      sandboxDir: '/tmp/sb',
      repoSlug: 'acme/site',
      batchId: 'b',
      title: 't',
      body: 'no base branch here',
    })

    expect(url).toBe('https://github.com/acme/site/pull/7')
    expect(calls[0].path).toBe('/repos/acme/site')
    expect(calls[1].body).toMatchObject({ base: 'main' })
  })

  test('idempotency — 422 triggers lookup of existing open PR', async () => {
    const { fn: api, calls } = fakeApi([
      // POST → 422
      () => new FakeApiError(422, 'A pull request already exists for acme:revanote/sandbox/abcdef.'),
      // GET existing
      () => ([{ html_url: 'https://github.com/acme/site/pull/11', number: 11 }]),
    ])
    const { gitOps } = fakeGit()
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps })

    const url = await ops.openPr({
      sandboxDir: '/tmp/sb',
      repoSlug: 'acme/site',
      batchId: 'b',
      title: 't',
      body: 'base_branch=agent-auto\n',
    })

    expect(url).toBe('https://github.com/acme/site/pull/11')
    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe('GET')
    expect(calls[1].path).toContain('/repos/acme/site/pulls?head=')
    expect(calls[1].path).toContain('state=open')
  })

  test('422 with empty existing list rethrows', async () => {
    const { fn: api } = fakeApi([
      () => new FakeApiError(422, 'something else'),
      () => ([]),
    ])
    const { gitOps } = fakeGit()
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps })

    await expect(
      ops.openPr({ sandboxDir: '/tmp/sb', repoSlug: 'acme/site', batchId: 'b', title: 't', body: 'base_branch=main\n' }),
    ).rejects.toThrow()
  })

  test('non-422 errors bubble up', async () => {
    const { fn: api } = fakeApi([
      () => new FakeApiError(500, 'boom'),
    ])
    const { gitOps } = fakeGit()
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps })

    await expect(
      ops.openPr({ sandboxDir: '/tmp/sb', repoSlug: 'acme/site', batchId: 'b', title: 't', body: 'base_branch=main\n' }),
    ).rejects.toThrow(/fake 500/)
  })

  test('invalid repoSlug throws', async () => {
    const { fn: api } = fakeApi([])
    const { gitOps } = fakeGit()
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps })
    await expect(
      ops.openPr({ sandboxDir: '/tmp/sb', repoSlug: 'not-a-slug', batchId: 'b', title: 't', body: '' }),
    ).rejects.toThrow(/invalid repoSlug/)
  })
})

describe('defaultMergeOps.squashMerge', () => {
  test('happy path — returns merged URL convention', async () => {
    const { fn: api, calls } = fakeApi([
      () => ({ sha: 'deadbeef', merged: true, message: 'squashed' }),
    ])
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps: fakeGit().gitOps })

    const url = await ops.squashMerge({
      sandboxDir: '/tmp/sb',
      repoSlug: 'acme/site',
      prUrl: 'https://github.com/acme/site/pull/42',
    })

    expect(url).toBe('https://github.com/acme/site/pull/42/merged')
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].path).toBe('/repos/acme/site/pulls/42/merge')
    expect(calls[0].body).toEqual({ merge_method: 'squash' })
  })

  test('405 surfaces clear "not mergeable" error', async () => {
    const { fn: api } = fakeApi([
      () => new FakeApiError(405, '{"message":"Pull Request is not mergeable"}'),
    ])
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps: fakeGit().gitOps })

    await expect(
      ops.squashMerge({ sandboxDir: '/tmp/sb', repoSlug: 'acme/site', prUrl: 'https://github.com/acme/site/pull/42' }),
    ).rejects.toThrow(/not mergeable/)
  })

  test('409 surfaces clear "head changed" error', async () => {
    const { fn: api } = fakeApi([
      () => new FakeApiError(409, '{"message":"Head branch was modified."}'),
    ])
    const ops = defaultMergeOps({ installationId: 1, apiRequest: api, gitOps: fakeGit().gitOps })

    await expect(
      ops.squashMerge({ sandboxDir: '/tmp/sb', repoSlug: 'acme/site', prUrl: 'https://github.com/acme/site/pull/42' }),
    ).rejects.toThrow(/head SHA changed/)
  })

  test('unparseable PR URL throws', async () => {
    const ops = defaultMergeOps({ installationId: 1, apiRequest: fakeApi([]).fn, gitOps: fakeGit().gitOps })
    await expect(
      ops.squashMerge({ sandboxDir: '/tmp/sb', repoSlug: 'acme/site', prUrl: 'not-a-pr-url' }),
    ).rejects.toThrow(/cannot parse PR URL/)
  })
})

describe('ensureBranch', () => {
  test('no-op when branch exists (200 on GET ref)', async () => {
    const { fn: api, calls } = fakeApi([
      () => ({ ref: 'refs/heads/agent-staging', object: { sha: 'abc' } }),
    ])
    await ensureBranch({
      installationId: 1,
      repoSlug: 'acme/site',
      branch: 'agent-staging',
      fromSha: 'abc123',
      apiRequest: api,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].path).toBe('/repos/acme/site/git/ref/heads/agent-staging')
  })

  test('creates when 404', async () => {
    const { fn: api, calls } = fakeApi([
      () => new FakeApiError(404, 'Not Found'),
      () => ({ ref: 'refs/heads/agent-staging' }),
    ])
    await ensureBranch({
      installationId: 1,
      repoSlug: 'acme/site',
      branch: 'agent-staging',
      fromSha: 'abc123',
      apiRequest: api,
    })
    expect(calls).toHaveLength(2)
    expect(calls[1].method).toBe('POST')
    expect(calls[1].path).toBe('/repos/acme/site/git/refs')
    expect(calls[1].body).toEqual({ ref: 'refs/heads/agent-staging', sha: 'abc123' })
  })

  test('non-404 error rethrows without trying to create', async () => {
    const { fn: api, calls } = fakeApi([
      () => new FakeApiError(500, 'boom'),
    ])
    await expect(
      ensureBranch({ installationId: 1, repoSlug: 'acme/site', branch: 'x', fromSha: 'y', apiRequest: api }),
    ).rejects.toThrow(/fake 500/)
    expect(calls).toHaveLength(1)
  })
})
