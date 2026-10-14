/**
 * PTYCAP-05 plan 03: hub-side proof verifier. Pure function over the ProofGithub
 * contract; the shared fake supplies GitHub, so nothing here touches network or env.
 */
import { describe, expect, test } from 'bun:test'
import { verifyProof, type ProofObservation } from '../src/orchestrator/proof-verifier.ts'
import { ProofGithubError, type ProofRun } from '../src/orchestrator/proof-types.ts'
import {
  BASE_SHA,
  PR_HEAD_SHA,
  greenPr,
  mainAdvanced,
  makeFakeProofGithub,
  redPr,
  type FakeGithubScenario,
} from './fixtures/proof-fake-github.ts'

const run = (over: Partial<ProofRun> = {}): ProofRun => ({
  id: 'run1',
  user_id: 'u1',
  task_id: 't1',
  session_id: 's1',
  repo_ident: 'github://acme/proof',
  counter_key: 'task:t1',
  branch: 'proof/run1',
  installation_id: 1,
  repo_owner: 'acme',
  repo_name: 'proof',
  default_branch: 'main',
  base_sha: BASE_SHA,
  ruleset_ids: [1],
  ruleset_digest: 'd',
  ruleset_updated_at: null,
  protection_shape: 'branch_lock',
  required_contexts: ['ci'],
  arm_preconditions: {},
  max_injects: 3,
  max_tokens: 1000,
  max_wall_ms: 1000,
  status: 'running',
  outcome: null,
  outcome_detail: null,
  pr_url: null,
  pr_number: null,
  last_ci_state: null,
  last_inject_outcome: null,
  tokens_hwm: 0,
  armed_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  started_at: null,
  terminal_at: null,
  ...over,
})

const pr = (over: Partial<FakeGithubScenario['pulls'][number]> = {}): FakeGithubScenario['pulls'][number] => ({
  number: 1,
  htmlUrl: 'https://github.com/acme/proof/pull/1',
  state: 'open',
  merged: false,
  mergedAt: null,
  headRef: 'proof/run1',
  headSha: PR_HEAD_SHA,
  baseRef: 'main',
  draft: false,
  ...over,
})

const terminal = (o: ProofObservation) => {
  expect(o.kind).toBe('terminal')
  return o as Extract<ProofObservation, { kind: 'terminal' }>
}
const pending = (o: ProofObservation) => {
  expect(o.kind).toBe('pending')
  return o as Extract<ProofObservation, { kind: 'pending' }>
}

describe('verifyProof: default-branch advance (F1-3)', () => {
  test('identical compare continues past the advance check', async () => {
    const gh = makeFakeProofGithub()
    const o = await verifyProof(gh, run())
    expect(pending(o).state).toBe('no_pr')
    expect(gh.calls[0]).toEqual({ method: 'compare', args: ['acme', 'proof', BASE_SHA, 'main'] })
  })

  test('ahead_by 1 is main_advanced even though the default-branch HEAD sha equals base_sha', async () => {
    const gh = makeFakeProofGithub({ compare: { status: 'ahead', aheadBy: 1, behindBy: 0 } })
    expect(gh.scenario.heads.main).toBe(BASE_SHA)
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.detail).toContain('ahead')
    expect(t.detail).toContain('1')
  })

  test('main moved forward via the shared helper is main_advanced', async () => {
    const t = terminal(await verifyProof(makeFakeProofGithub(mainAdvanced()), run()))
    expect(t.outcome).toBe('terminated:main_advanced')
  })

  test('behind is terminal main_advanced', async () => {
    const gh = makeFakeProofGithub({ compare: { status: 'behind', aheadBy: 0, behindBy: 2 } })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.detail).toContain('behind')
  })

  test('diverged is terminal main_advanced', async () => {
    const gh = makeFakeProofGithub({ compare: { status: 'diverged', aheadBy: 1, behindBy: 1 } })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.detail).toContain('diverged')
  })

  test('compare not_found (base gone after a history rewrite) is terminal main_advanced, not a retry', async () => {
    const gh = makeFakeProofGithub({ fail: { compare: new ProofGithubError('not_found', 404) } })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.detail).toContain('not_found')
  })

  test('compare forbidden is pending ci_unverifiable, never green', async () => {
    const gh = makeFakeProofGithub({ ...greenPr(), fail: { compare: new ProofGithubError('forbidden', 403) } })
    const o = pending(await verifyProof(gh, run()))
    expect(o.state).toBe('ci_unverifiable')
    expect(o.detail).toBe('compare_unreadable')
  })

  test('compare unavailable is pending ci_unverifiable', async () => {
    const gh = makeFakeProofGithub({ fail: { compare: new ProofGithubError('unavailable', 503) } })
    const o = pending(await verifyProof(gh, run()))
    expect(o.state).toBe('ci_unverifiable')
  })
})

describe('verifyProof: PR scope', () => {
  test('a proof/ PR from a different head is pr_scope_violation', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ headRef: 'proof/other', number: 7, htmlUrl: 'https://x/7' })] })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:pr_scope_violation')
    expect(t.detail).toContain('proof/other')
  })

  test('the run PR with a non-default base is pr_scope_violation and carries the PR url', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ baseRef: 'release' })] })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:pr_scope_violation')
    expect(t.prNumber).toBe(1)
    expect(t.prUrl).toBe('https://github.com/acme/proof/pull/1')
  })

  test('a merged proof PR (merged flag) is terminal main_advanced', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ merged: true, state: 'closed' })] })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.prNumber).toBe(1)
  })

  test('a merged proof PR (mergedAt only) is terminal main_advanced', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ mergedAt: '2026-10-02T00:00:00Z', state: 'closed' })] })
    expect(terminal(await verifyProof(gh, run())).outcome).toBe('terminated:main_advanced')
  })

  test('no PR is pending no_pr', async () => {
    const o = pending(await verifyProof(makeFakeProofGithub(), run()))
    expect(o.state).toBe('no_pr')
    expect(o.prUrl).toBeUndefined()
  })

  test('only a closed unmerged PR is pending no_pr with detail pr_closed', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ state: 'closed' })] })
    const o = pending(await verifyProof(gh, run()))
    expect(o.state).toBe('no_pr')
    expect(o.detail).toBe('pr_closed')
    expect(o.prNumber).toBe(1)
  })

  test('an open PR beats a closed one for the same branch', async () => {
    const gh = makeFakeProofGithub({
      ...redPr({ number: 2, htmlUrl: 'https://x/2' }),
    })
    gh.scenario.pulls.push(pr({ number: 3, state: 'closed', htmlUrl: 'https://x/3' }))
    const o = pending(await verifyProof(gh, run()))
    expect(o.prNumber).toBe(2)
  })

  test('pulls unreadable is pending ci_unverifiable, never green', async () => {
    const gh = makeFakeProofGithub({ fail: { listPullsWithHeadPrefix: new ProofGithubError('forbidden', 403) } })
    const o = pending(await verifyProof(gh, run()))
    expect(o.state).toBe('ci_unverifiable')
    expect(o.detail).toBe('pulls_unreadable')
  })

  test('the verifier is read-only: only contract read methods are called', async () => {
    const gh = makeFakeProofGithub(greenPr())
    await verifyProof(gh, run())
    const allowed = new Set(['compare', 'listPullsWithHeadPrefix', 'getCheckState'])
    for (const c of gh.calls) expect(allowed.has(c.method)).toBe(true)
  })
})
