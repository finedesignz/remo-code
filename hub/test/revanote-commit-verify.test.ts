/**
 * fix/revanote-verify-pushed — the hub accepts `resolved: true` only for a
 * commit it can see on the remote. Covers the verifier (DB/network-free) and
 * the finalize path's downgrade (DAL + callback mocked).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

import { verifyPushedCommit, isPushVerificationRequired } from '../src/revanote/commit-verify.ts'

function notFound(): never {
  throw Object.assign(new Error('404'), { status: 404 })
}

const SHA = 'a'.repeat(40)
const base = { owner: 'acme', repo: 'site', commitSha: SHA, installationIds: [1] }

describe('verifyPushedCommit', () => {
  test('commit on the remote → ok with the full sha', async () => {
    const r = await verifyPushedCommit(base, async () => ({ sha: SHA }))
    expect(r).toEqual({ ok: true, sha: SHA, repo: 'acme/site' })
  })

  test('missing / malformed sha → rejected before any API call', async () => {
    let calls = 0
    const get = async () => (calls++, { sha: SHA })
    expect(await verifyPushedCommit({ ...base, commitSha: null }, get)).toMatchObject({ ok: false, reason: 'commit_sha_missing' })
    expect(await verifyPushedCommit({ ...base, commitSha: 'HEAD' }, get)).toMatchObject({ ok: false, reason: 'commit_sha_invalid' })
    expect(calls).toBe(0)
  })

  test('404 on every installation → commit_not_pushed', async () => {
    const r = await verifyPushedCommit({ ...base, installationIds: [1, 2] }, async () => notFound())
    expect(r).toMatchObject({ ok: false, reason: 'commit_not_pushed' })
  })

  test('first installation cannot see the repo, second can → ok', async () => {
    const r = await verifyPushedCommit({ ...base, installationIds: [1, 2] }, async (inst) =>
      inst === 1 ? notFound() : { sha: SHA },
    )
    expect(r.ok).toBe(true)
  })

  test('branch given: must contain the commit', async () => {
    const onBranch = await verifyPushedCommit({ ...base, branch: 'main' }, async (_i, path) =>
      path.includes('/compare/') ? { status: 'behind' } : { sha: SHA },
    )
    expect(onBranch.ok).toBe(true)
    const diverged = await verifyPushedCommit({ ...base, branch: 'main' }, async (_i, path) =>
      path.includes('/compare/') ? { status: 'diverged' } : { sha: SHA },
    )
    expect(diverged).toMatchObject({ ok: false, reason: 'commit_not_on_branch' })
  })

  test('no repo / no installation → fail closed', async () => {
    const get = async () => ({ sha: SHA })
    expect(await verifyPushedCommit({ ...base, owner: null }, get)).toMatchObject({ reason: 'repo_unknown' })
    expect(await verifyPushedCommit({ ...base, installationIds: [] }, get)).toMatchObject({ reason: 'no_github_installation' })
  })

  test('non-404 API error → verify_error (never treated as pushed)', async () => {
    const r = await verifyPushedCommit(base, async () => {
      throw Object.assign(new Error('boom'), { status: 500 })
    })
    expect(r).toMatchObject({ ok: false, reason: 'verify_error' })
  })

  test('escape hatch parsing: default ON, explicit off values disable', () => {
    expect(isPushVerificationRequired({})).toBe(true)
    expect(isPushVerificationRequired({ REMO_REVANOTE_REQUIRE_PUSHED_COMMIT: '1' })).toBe(true)
    expect(isPushVerificationRequired({ REMO_REVANOTE_REQUIRE_PUSHED_COMMIT: 'off' })).toBe(false)
    expect(isPushVerificationRequired({ REMO_REVANOTE_REQUIRE_PUSHED_COMMIT: '0' })).toBe(false)
  })
})

// ── finalize path ────────────────────────────────────────────────────────────
const runUpdates: any[] = []
const statusUpdates: any[] = []
const callbacks: any[] = []

mock.module('../src/db/revanote-dal.ts', () => ({
  updateAnnotationRun: async (id: string, patch: any) => void runUpdates.push({ id, ...patch }),
  updateAnnotationStatus: async (id: string, status: string, opts: any) => void statusUpdates.push({ id, status, ...opts }),
  getAnnotationById: async () => ({
    id: 'ann-1',
    annotation_id_external: 'ext-1',
    annotation_url: null,
    payload_raw: {},
  }),
}))
mock.module('../src/ws/registry.ts', () => ({ broadcastRevanoteEvent: () => {} }))
mock.module('../src/revanote/callback.ts', () => ({
  scheduleImmediateCallback: async (_ann: any, payload: any) => void callbacks.push(payload),
}))

const { finalizeAnnotationReply } = await import('../src/revanote/run-lifecycle.ts')

function reply(envelope: object): string {
  return `Done.\n<<JSON>>\n${JSON.stringify(envelope)}\n<<END>>`
}

const args = (content: string) => ({
  sessionId: 's1',
  runId: 'run-1',
  annotationId: 'ann-1',
  userId: 'u1',
  startedAt: Date.now(),
  content,
})

describe('finalizeAnnotationReply — pushed-commit gate', () => {
  beforeEach(() => {
    runUpdates.length = 0
    statusUpdates.length = 0
    callbacks.length = 0
    delete process.env.REMO_REVANOTE_REQUIRE_PUSHED_COMMIT
  })

  test('verified commit → resolved, callback carries the real sha', async () => {
    await finalizeAnnotationReply(
      args(reply({ resolved: true, action_taken: 'fixed', files_changed: ['a.css'], commit_sha: SHA, deployed: true })),
      { verify: async () => ({ ok: true, sha: SHA, repo: 'acme/site' }) },
    )
    expect(statusUpdates[0].status).toBe('resolved')
    expect(callbacks[0]).toMatchObject({ resolved: true, commit_sha: SHA, deployed: true })
    expect(runUpdates[0]).toMatchObject({ resolved: true, commit_sha: SHA })
  })

  test('unpushed commit → downgraded to failed, resolved:false, deployed:false', async () => {
    let seen: any
    await finalizeAnnotationReply(
      args(reply({ resolved: true, action_taken: 'fixed', files_changed: ['a.css'], commit_sha: SHA, branch: 'main', deployed: true })),
      {
        verify: async (a) => {
          seen = a
          return { ok: false, reason: 'commit_not_pushed' }
        },
      },
    )
    expect(seen).toMatchObject({ commitSha: SHA, branch: 'main', sessionId: 's1' })
    expect(statusUpdates[0]).toMatchObject({ status: 'failed', skip_reason: 'unverified_resolve:commit_not_pushed' })
    expect(callbacks[0]).toMatchObject({
      resolved: false,
      deployed: false,
      commit_sha: null,
      error: 'unverified_resolve:commit_not_pushed',
    })
  })

  test('resolved without any commit_sha → rejected by the default verifier', async () => {
    await finalizeAnnotationReply(args(reply({ resolved: true, action_taken: 'bulk resolved', deployed: true })))
    expect(statusUpdates[0].status).toBe('failed')
    expect(callbacks[0].error).toBe('unverified_resolve:commit_sha_missing')
  })

  test('resolved:false is never sent through verification', async () => {
    let called = false
    await finalizeAnnotationReply(
      args(reply({ resolved: false, needs_clarification: true, clarification_question: 'which page?' })),
      { verify: async () => ((called = true), { ok: true, sha: SHA, repo: 'x/y' }) },
    )
    expect(called).toBe(false)
    expect(callbacks[0].resolved).toBe(false)
    expect(callbacks[0].error).toBe(null)
  })

  test('escape hatch off → agent self-report passes through unchanged', async () => {
    process.env.REMO_REVANOTE_REQUIRE_PUSHED_COMMIT = 'off'
    await finalizeAnnotationReply(args(reply({ resolved: true, action_taken: 'fixed' })), {
      verify: async () => ({ ok: false, reason: 'commit_not_pushed' }),
    })
    expect(statusUpdates[0].status).toBe('resolved')
  })
})
