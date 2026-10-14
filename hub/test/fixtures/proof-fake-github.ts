/**
 * PTYCAP-05 deterministic in-memory ProofGithub (read-only contract, no network).
 * Shared by plans 02, 03, 05, 06, 07. Scenarios are plain data assigned to
 * `fake.scenario` (or merged with `fake.apply(patch)`); every call is appended to
 * `fake.calls`; `fake.fail[method]` makes that method reject with a chosen
 * ProofGithubError; calling a method the fake does not model throws.
 */
import {
  ProofGithubError,
  type CheckState,
  type CompareResult,
  type EffectiveRule,
  type PermissionProbe,
  type ProofGithub,
  type PullSummary,
  type RepoInfo,
  type RulesetDetail,
} from '../../src/orchestrator/proof-types.ts'

export interface FakeGithubScenario {
  repo: RepoInfo
  /** branch -> head sha */
  heads: Record<string, string>
  effectiveRules: EffectiveRule[]
  rulesets: Record<number, RulesetDetail>
  compare: CompareResult
  pulls: PullSummary[]
  /** sha -> check state */
  checks: Record<string, CheckState>
  workflowFiles: string[]
  /** username -> permission ('admin' | 'write' | 'read' | 'none') */
  permissions: Record<string, string>
  probe: PermissionProbe
}

export type FakeGithubFail = Partial<Record<keyof ProofGithub, ProofGithubError>>

export const BASE_SHA = 'a'.repeat(40)
export const ADVANCED_SHA = 'c'.repeat(40)
export const PR_HEAD_SHA = 'b'.repeat(40)

export function defaultScenario(): FakeGithubScenario {
  return {
    repo: { fullName: 'acme/proof', defaultBranch: 'main' },
    heads: { main: BASE_SHA },
    effectiveRules: [{ type: 'update', rulesetId: 1, rulesetSourceType: 'Repository', parameters: null }],
    rulesets: {
      1: {
        id: 1,
        name: 'proof-lock',
        target: 'branch',
        sourceType: 'Repository',
        enforcement: 'active',
        bypassActors: [],
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'update', parameters: null }],
        updatedAt: '2026-10-01T00:00:00Z',
      },
    },
    compare: { status: 'identical', aheadBy: 0, behindBy: 0 },
    pulls: [],
    checks: {},
    workflowFiles: [],
    permissions: {},
    probe: { administrationRead: true, checksRead: true, statusesRead: true, pullsRead: true, contentsRead: true },
  }
}

const pull = (over: Partial<PullSummary> = {}): PullSummary => ({
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

// ── Shared scenario patches (spread into makeFakeProofGithub or fake.apply) ──

/** An open proof PR whose required check passed. */
export function greenPr(over: Partial<PullSummary> = {}): Partial<FakeGithubScenario> {
  const p = pull(over)
  return {
    pulls: [p],
    checks: { [p.headSha]: { checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }], statuses: [], truncated: false } },
  }
}

/** An open proof PR whose required check failed. */
export function redPr(over: Partial<PullSummary> = {}): Partial<FakeGithubScenario> {
  const p = pull(over)
  return {
    pulls: [p],
    checks: { [p.headSha]: { checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'failure' }], statuses: [], truncated: false } },
  }
}

/** The default branch moved past the arm-time base sha. */
export function mainAdvanced(): Partial<FakeGithubScenario> {
  return {
    heads: { main: ADVANCED_SHA },
    compare: { status: 'ahead', aheadBy: 1, behindBy: 0 },
  }
}

/** The ruleset detail is not readable by this token (403): protection is unverifiable. */
export function unreadableRulesets(): { fail: FakeGithubFail } {
  return { fail: { getRuleset: new ProofGithubError('forbidden', 403), getEffectiveBranchRules: new ProofGithubError('forbidden', 403) } }
}

// ── The fake ─────────────────────────────────────────────────────────────────

export interface FakeProofGithub extends ProofGithub {
  scenario: FakeGithubScenario
  calls: Array<{ method: string; args: unknown[] }>
  fail: FakeGithubFail
  apply(patch: Partial<FakeGithubScenario> & { fail?: FakeGithubFail }): FakeProofGithub
}

export function makeFakeProofGithub(patch: Partial<FakeGithubScenario> & { fail?: FakeGithubFail } = {}): FakeProofGithub {
  const state = {
    scenario: defaultScenario(),
    calls: [] as Array<{ method: string; args: unknown[] }>,
    fail: {} as FakeGithubFail,
  }

  const enter = async (method: keyof ProofGithub, args: unknown[]) => {
    state.calls.push({ method, args })
    const f = state.fail[method]
    if (f) throw f
  }
  const notFound = () => new ProofGithubError('not_found', 404)

  const impl: ProofGithub = {
    async getRepo(owner, repo) {
      await enter('getRepo', [owner, repo])
      return state.scenario.repo
    },
    async getBranchHeadSha(owner, repo, branch) {
      await enter('getBranchHeadSha', [owner, repo, branch])
      const sha = state.scenario.heads[branch]
      if (!sha) throw notFound()
      return sha
    },
    async getEffectiveBranchRules(owner, repo, branch) {
      await enter('getEffectiveBranchRules', [owner, repo, branch])
      return state.scenario.effectiveRules
    },
    async getRuleset(owner, repo, rulesetId) {
      await enter('getRuleset', [owner, repo, rulesetId])
      const r = state.scenario.rulesets[rulesetId]
      if (!r) throw notFound()
      return r
    },
    async compare(owner, repo, base, head) {
      await enter('compare', [owner, repo, base, head])
      return state.scenario.compare
    },
    async listPulls(owner, repo) {
      await enter('listPulls', [owner, repo])
      return state.scenario.pulls
    },
    async getCheckState(owner, repo, sha) {
      await enter('getCheckState', [owner, repo, sha])
      return state.scenario.checks[sha] ?? { checkRuns: [], statuses: [], truncated: false }
    },
    async listWorkflowFiles(owner, repo, ref) {
      await enter('listWorkflowFiles', [owner, repo, ref])
      return state.scenario.workflowFiles
    },
    async getCollaboratorPermission(owner, repo, username) {
      await enter('getCollaboratorPermission', [owner, repo, username])
      const p = state.scenario.permissions[username]
      if (p === undefined) throw notFound()
      return p
    },
    async probePermissions(owner, repo) {
      await enter('probePermissions', [owner, repo])
      return state.scenario.probe
    },
  }

  const apply = (p: Partial<FakeGithubScenario> & { fail?: FakeGithubFail }) => {
    const { fail, ...scenario } = p
    Object.assign(state.scenario, scenario)
    if (fail) Object.assign(state.fail, fail)
    return proxy
  }

  const extras = {
    get scenario() {
      return state.scenario
    },
    set scenario(v: FakeGithubScenario) {
      state.scenario = v
    },
    calls: state.calls,
    fail: state.fail,
    apply,
  }

  // Unmodeled members throw instead of silently returning undefined.
  const proxy = new Proxy(Object.assign(Object.create(null), impl, extras) as FakeProofGithub, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop in target) {
        return Reflect.get(target, prop, receiver)
      }
      return () => {
        throw new Error(`proof-fake-github: unmodeled method '${String(prop)}'`)
      }
    },
  })
  apply(patch)
  return proxy
}
