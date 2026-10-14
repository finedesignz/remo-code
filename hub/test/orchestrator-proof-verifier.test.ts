/**
 * PTYCAP-05 plan 03: hub-side proof verifier. Pure function over the ProofGithub
 * contract; the shared fake supplies GitHub, so nothing here touches network or env.
 */
import { describe, expect, test } from 'bun:test'
import { verifyProof, type ProofObservation } from '../src/orchestrator/proof-verifier.ts'
import { ProofGithubError, type CheckState, type ProofGithub, type ProofRun } from '../src/orchestrator/proof-types.ts'
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
  headRepoFullName: 'acme/proof',
  authorLogin: 'proof-agent',
  createdAt: '2026-10-02T00:00:00Z',
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
  test('a fork PR reusing the exact run branch name is pr_scope_violation, never pr_open_green (codex #5)', async () => {
    const gh = makeFakeProofGithub(greenPr({ headRepoFullName: 'attacker/proof' }))
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:pr_scope_violation')
    expect(t.detail).toContain('attacker/proof')
  })

  test('a deleted head repository (null) is foreign; head repo comparison is case-insensitive', async () => {
    const del = terminal(await verifyProof(makeFakeProofGithub(greenPr({ headRepoFullName: null })), run()))
    expect(del.outcome).toBe('terminated:pr_scope_violation')
    const ok = await verifyProof(makeFakeProofGithub(greenPr({ headRepoFullName: 'ACME/Proof' })), run())
    expect(ok.kind === 'terminal' ? ok.outcome : 'pending').toBe('pr_open_green')
  })

  test('a NEW off-prefix PR is pr_scope_violation even with a green proof PR present (codex #5)', async () => {
    const gh = makeFakeProofGithub({
      ...greenPr(),
      pulls: [pr(), pr({ number: 9, headRef: 'feature/x', htmlUrl: 'https://x/9', authorLogin: 'agent-bot' })],
    })
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('terminated:pr_scope_violation')
    expect(t.detail).toContain('off_prefix_head feature/x by agent-bot')
    expect(t.prNumber).toBe(9)
  })

  test('an off-prefix PR created BEFORE arming is not the agent: ignored; one with no created_at fails closed', async () => {
    const old = pr({ number: 9, headRef: 'feature/old', createdAt: '2026-09-01T00:00:00Z' })
    const okRun = await verifyProof(makeFakeProofGithub({ ...greenPr(), pulls: [pr(), old] }), run())
    expect(okRun.kind === 'terminal' ? okRun.outcome : 'pending').toBe('pr_open_green')
    const undated = terminal(await verifyProof(makeFakeProofGithub({ pulls: [pr({ number: 9, headRef: 'feature/z', createdAt: null })] }), run()))
    expect(undated.outcome).toBe('terminated:pr_scope_violation')
  })

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
    const gh = makeFakeProofGithub({ fail: { listPulls: new ProofGithubError('forbidden', 403) } })
    const o = pending(await verifyProof(gh, run()))
    expect(o.state).toBe('ci_unverifiable')
    expect(o.detail).toBe('pulls_unreadable')
  })

  test('the verifier is read-only: only contract read methods are called', async () => {
    const gh = makeFakeProofGithub(greenPr())
    await verifyProof(gh, run())
    const allowed = new Set(['compare', 'listPulls', 'getCheckState'])
    for (const c of gh.calls) expect(allowed.has(c.method)).toBe(true)
  })
})

// CI evaluation and the pr_open_green decision (D-13)

const withChecks = (cs: Partial<CheckState>, runOver: Partial<ProofRun> = {}) => ({
  gh: makeFakeProofGithub({
    pulls: [pr()],
    checks: { [PR_HEAD_SHA]: { checkRuns: [], statuses: [], truncated: false, ...cs } },
  }),
  r: run(runOver),
})
const cr = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion })

describe('verifyProof: CI matrix', () => {
  test('green: required context succeeded -> pr_open_green with PR ref', async () => {
    const gh = makeFakeProofGithub(greenPr())
    const t = terminal(await verifyProof(gh, run()))
    expect(t.outcome).toBe('pr_open_green')
    expect(t.prNumber).toBe(1)
    expect(t.prUrl).toBe('https://github.com/acme/proof/pull/1')
  })

  test('checks are requested for the exact head sha the PR read returned', async () => {
    const gh = makeFakeProofGithub(greenPr())
    await verifyProof(gh, run())
    const call = gh.calls.find((c) => c.method === 'getCheckState')
    expect(call?.args).toEqual(['acme', 'proof', PR_HEAD_SHA])
  })

  for (const status of ['queued', 'in_progress']) {
    test(`pending check-run (${status}) -> ci_pending`, async () => {
      const { gh, r } = withChecks({ checkRuns: [cr('ci', status, null)] })
      expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
    })
  }

  test('pending commit status -> ci_pending', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'success')], statuses: [{ context: 'x', state: 'pending' }] })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
  })

  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']) {
    test(`red conclusion (${conclusion}) -> ci_red`, async () => {
      const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', conclusion)] })
      const o = pending(await verifyProof(gh, r))
      expect(o.state).toBe('ci_red')
      expect(o.prNumber).toBe(1)
    })
  }

  for (const state of ['failure', 'error']) {
    test(`red commit status (${state}) -> ci_red`, async () => {
      const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'success')], statuses: [{ context: 'x', state }] })
      expect(pending(await verifyProof(gh, r)).state).toBe('ci_red')
    })
  }

  test('red wins over a sibling still pending', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'failure'), cr('lint', 'in_progress', null)] })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_red')
  })

  test('no checks at all is never green', async () => {
    const { gh, r } = withChecks({})
    const o = await verifyProof(gh, r)
    expect(o.kind).toBe('pending')
    expect(pending(o).state).toBe('ci_pending')
  })

  test('no checks at all with empty required_contexts is never green', async () => {
    const { gh, r } = withChecks({}, { required_contexts: [] })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
  })

  test('required context missing (other check green) is ci_pending, never green', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('lint', 'completed', 'success')] })
    const o = pending(await verifyProof(gh, r))
    expect(o.state).toBe('ci_pending')
    expect(o.detail).toContain('ci')
  })

  test('skipped required context is ci_pending, never green', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'skipped')] })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
  })

  test('neutral required context is not success evidence', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'neutral')] })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
  })

  test('a skipped non-required check does not block green', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'success'), cr('optional', 'completed', 'skipped')] })
    expect(terminal(await verifyProof(gh, r)).outcome).toBe('pr_open_green')
  })

  test('truncated check list is ci_unverifiable even when everything listed is green', async () => {
    const { gh, r } = withChecks({ checkRuns: [cr('ci', 'completed', 'success')], truncated: true })
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_unverifiable')
  })

  test('forbidden checks read is ci_unverifiable', async () => {
    const gh = makeFakeProofGithub({ ...greenPr(), fail: { getCheckState: new ProofGithubError('forbidden', 403) } })
    expect(pending(await verifyProof(gh, run())).state).toBe('ci_unverifiable')
  })

  test('unavailable and not_found checks reads are ci_unverifiable', async () => {
    for (const e of [new ProofGithubError('unavailable', 502), new ProofGithubError('not_found', 404)]) {
      const gh = makeFakeProofGithub({ ...greenPr(), fail: { getCheckState: e } })
      expect(pending(await verifyProof(gh, run())).state).toBe('ci_unverifiable')
    }
  })

  test('empty headSha is ci_unverifiable and the checks are never requested', async () => {
    const gh = makeFakeProofGithub({ pulls: [pr({ headSha: '' })] })
    expect(pending(await verifyProof(gh, run())).state).toBe('ci_unverifiable')
    expect(gh.calls.some((c) => c.method === 'getCheckState')).toBe(false)
  })

  test('mixed check-runs and statuses: required contexts satisfied across both', async () => {
    const { gh, r } = withChecks(
      { checkRuns: [cr('ci', 'completed', 'success')], statuses: [{ context: 'legacy/ci', state: 'success' }] },
      { required_contexts: ['ci', 'legacy/ci'] },
    )
    expect(terminal(await verifyProof(gh, r)).outcome).toBe('pr_open_green')
  })

  test('mixed: required status context still pending is not green', async () => {
    const { gh, r } = withChecks(
      { checkRuns: [cr('ci', 'completed', 'success')], statuses: [{ context: 'legacy/ci', state: 'pending' }] },
      { required_contexts: ['ci', 'legacy/ci'] },
    )
    expect(pending(await verifyProof(gh, r)).state).toBe('ci_pending')
  })

  test('empty required_contexts still requires at least one passing check', async () => {
    const skippedOnly = withChecks({ checkRuns: [cr('x', 'completed', 'skipped')] }, { required_contexts: [] })
    expect(pending(await verifyProof(skippedOnly.gh, skippedOnly.r)).state).toBe('ci_pending')
    const passing = withChecks({ checkRuns: [cr('x', 'completed', 'success')] }, { required_contexts: [] })
    expect(terminal(await verifyProof(passing.gh, passing.r)).outcome).toBe('pr_open_green')
  })

  test('re-compare race: main advances after the first read and before green -> main_advanced', async () => {
    const fake = makeFakeProofGithub(greenPr())
    let n = 0
    const racy: ProofGithub = Object.create(fake)
    racy.compare = async (...a) => {
      n++
      return n === 1 ? fake.compare(...a) : { status: 'ahead', aheadBy: 1, behindBy: 0 }
    }
    const t = terminal(await verifyProof(racy, run()))
    expect(t.outcome).toBe('terminated:main_advanced')
    expect(t.prNumber).toBe(1)
    expect(n).toBe(2)
  })

  test('re-compare unreadable at the end is ci_unverifiable, never green', async () => {
    const fake = makeFakeProofGithub(greenPr())
    let n = 0
    const racy: ProofGithub = Object.create(fake)
    racy.compare = async (...a) => {
      n++
      if (n === 1) return fake.compare(...a)
      throw new ProofGithubError('unavailable', 503)
    }
    expect(pending(await verifyProof(racy, run())).state).toBe('ci_unverifiable')
  })

  test('the verifier signature takes only github and the run (no agent-supplied text input)', () => {
    expect(verifyProof.length).toBe(2)
  })
})
