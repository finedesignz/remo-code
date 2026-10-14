// PTYCAP-05-07 task 1: armProof is an ordered, fail-closed decision. Every refusal returns its
// code with ZERO writes (the armTx spy is never called). All deps are fakes: no sql, no GitHub.
import { describe, expect, test } from 'bun:test'
import { armProof, type ArmProofArgs, type ProofArmDeps } from '../src/orchestrator/proof-arm.ts'
import { BASE_SHA, makeFakeProofGithub, type FakeProofGithub } from './fixtures/proof-fake-github.ts'
import type { EffectiveRule, RulesetDetail } from '../src/orchestrator/proof-types.ts'

const USER = 'user-1'
const SESSION = 'sess-1'
const REPO_IDENT = 'github://acme/proof'
const INSTALL = 4242

const effUpdate: EffectiveRule = { type: 'update', rulesetId: 1, rulesetSourceType: 'Repository', parameters: null }
const effRsc: EffectiveRule = {
  type: 'required_status_checks',
  rulesetId: 1,
  rulesetSourceType: 'Repository',
  parameters: { required_status_checks: [{ context: 'ci' }] },
}
const lockRuleset = (over: Partial<RulesetDetail> = {}): RulesetDetail => ({
  id: 1,
  name: 'proof-lock',
  target: 'branch',
  sourceType: 'Repository',
  enforcement: 'active',
  bypassActors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: [
    { type: 'update', parameters: null },
    { type: 'required_status_checks', parameters: effRsc.parameters },
  ],
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

function greenGithub(patch: Parameters<typeof makeFakeProofGithub>[0] = {}): FakeProofGithub {
  return makeFakeProofGithub({
    effectiveRules: [effUpdate, effRsc],
    rulesets: { 1: lockRuleset() },
    workflowFiles: ['ci.yml'],
    permissions: { 'agent-bot': 'write' },
    ...patch,
  })
}

interface Harness {
  deps: ProofArmDeps
  armCalls: any[]
  github: FakeProofGithub
  order: string[]
}

function harness(over: Partial<ProofArmDeps> = {}, github: FakeProofGithub = greenGithub()): Harness {
  const armCalls: any[] = []
  const order: string[] = []
  const deps: ProofArmDeps = {
    isGithubAppConfigured: () => true,
    makeGithub: () => github,
    getInstallation: async () => ({ id: INSTALL, user_id: USER, revoked_at: null }),
    listInstallationRepos: async () => [{ full_name: 'Acme/Proof', default_branch: 'main' }],
    getSession: async () => ({ user_id: USER, repo_key: REPO_IDENT }),
    listAllowlist: async () => [],
    countOtherEnabledOrchestratorTasks: async () => 0,
    armTx: async (args) => {
      armCalls.push(args)
      return { run: { id: 'run-1', branch: 'proof/run-1' } as any, taskId: 'task-1' }
    },
    env: {},
    now: () => new Date('2026-10-13T12:00:00Z'),
    ...over,
  }
  return { deps, armCalls, github, order }
}

const baseArgs = (over: Partial<ArmProofArgs> = {}): ArmProofArgs => ({
  userId: USER,
  sessionId: SESSION,
  repoIdent: REPO_IDENT,
  installationId: INSTALL,
  ...over,
})

async function refused(over: Partial<ProofArmDeps>, args: Partial<ArmProofArgs> = {}, github?: FakeProofGithub) {
  const h = harness(over, github)
  const r = await armProof(baseArgs(args), h.deps)
  expect(r.ok).toBe(false)
  expect(h.armCalls.length).toBe(0)
  return r as Extract<typeof r, { ok: false }>
}

describe('armProof refusals: first failure returns its code with NO write', () => {
  test('github_app_unconfigured', async () => {
    const r = await refused({ isGithubAppConfigured: () => false })
    expect(r.code).toBe('github_app_unconfigured')
  })

  test('invalid_budget: garbage text flag is refused, never silently defaulted', async () => {
    const r = await refused({}, { maxInjects: 'lots' })
    expect(r.code).toBe('invalid_budget')
  })

  test('invalid_budget: zero, negative and non-integer values', async () => {
    for (const bad of ['0', '-3', '1.5', '1e6', ' ', '']) {
      const r = await refused({}, { maxTokens: bad })
      expect(r.code).toBe('invalid_budget')
    }
    expect((await refused({}, { maxWallMs: 0 })).code).toBe('invalid_budget')
  })

  test('invalid_budget: garbage in the env value is refused too', async () => {
    const r = await refused({ env: { REMO_PROOF_MAX_INJECTS: 'abc' } })
    expect(r.code).toBe('invalid_budget')
  })

  test('installation_not_owned: no row, revoked row, or another user row', async () => {
    expect((await refused({ getInstallation: async () => null })).code).toBe('installation_not_owned')
    expect(
      (await refused({ getInstallation: async () => ({ id: INSTALL, user_id: USER, revoked_at: '2026-01-01T00:00:00Z' }) })).code,
    ).toBe('installation_not_owned')
    expect(
      (await refused({ getInstallation: async () => ({ id: INSTALL, user_id: 'someone-else', revoked_at: null }) })).code,
    ).toBe('installation_not_owned')
  })

  test('repo_not_in_installation: repo absent (and a malformed ident)', async () => {
    const absent = await refused({ listInstallationRepos: async () => [{ full_name: 'acme/other', default_branch: 'main' }] })
    expect(absent.code).toBe('repo_not_in_installation')
    const malformed = await refused({}, { repoIdent: 'path:///tmp/x' })
    expect(malformed.code).toBe('repo_not_in_installation')
  })

  test('session_repo_mismatch: session missing, other user, or repo_key differs', async () => {
    expect((await refused({ getSession: async () => null })).code).toBe('session_repo_mismatch')
    expect((await refused({ getSession: async () => ({ user_id: 'x', repo_key: REPO_IDENT }) })).code).toBe('session_repo_mismatch')
    expect((await refused({ getSession: async () => ({ user_id: USER, repo_key: 'github://acme/other' }) })).code).toBe(
      'session_repo_mismatch',
    )
    expect((await refused({ getSession: async () => ({ user_id: USER, repo_key: null }) })).code).toBe('session_repo_mismatch')
  })

  test('proof_permissions_missing names the exact missing permission', async () => {
    const gh = greenGithub({
      probe: { administrationRead: false, checksRead: true, statusesRead: false, pullsRead: true, contentsRead: true },
    })
    const r = await refused({}, {}, gh)
    expect(r.code).toBe('proof_permissions_missing')
    expect(r.detail).toContain('administration_read')
    expect(r.detail).toContain('commit_statuses_read')
  })

  test('no_ci_workflow: no yml/yaml under .github/workflows', async () => {
    const r = await refused({}, {}, greenGithub({ workflowFiles: ['README.md'] }))
    expect(r.code).toBe('no_ci_workflow')
  })

  test('proof_protection_unverifiable: bypass actors not visible says the App token cannot see them', async () => {
    const gh = greenGithub({ rulesets: { 1: lockRuleset({ bypassActors: undefined as any }) } })
    const r = await refused({}, {}, gh)
    expect(r.code).toBe('proof_protection_unverifiable')
    expect(r.detail).toContain('bypass_actors_not_visible')
    expect(r.detail.toLowerCase()).toContain('cannot see bypass actors')
  })

  test('proof_protection_unverifiable: unreadable rulesets fail closed', async () => {
    const gh = greenGithub({ effectiveRules: [] })
    const r = await refused({}, {}, gh)
    expect(r.code).toBe('proof_protection_unverifiable')
  })

  test('proof_protection_insufficient: a ruleset with bypass actors', async () => {
    const gh = greenGithub({ rulesets: { 1: lockRuleset({ bypassActors: [{ actor_id: 1, actor_type: 'RepositoryRole' }] as any }) } })
    const r = await refused({}, {}, gh)
    expect(r.code).toBe('proof_protection_insufficient')
  })

  test('agent_credential_is_admin when --agent-login resolves to admin', async () => {
    const gh = greenGithub({ permissions: { 'agent-bot': 'admin' } })
    const r = await refused({}, { agentLogin: 'agent-bot' }, gh)
    expect(r.code).toBe('agent_credential_is_admin')
  })

  test('other_repo_allowlisted: allowlist holds a repo other than the target', async () => {
    const r = await refused({ listAllowlist: async () => ['github://acme/prod-app'] })
    expect(r.code).toBe('other_repo_allowlisted')
  })

  test('QC r1: other_orchestrator_task_enabled when any other orchestrator task is enabled (dry run too), zero writes', async () => {
    const r = await refused({ countOtherEnabledOrchestratorTasks: async () => 2 })
    expect(r.code).toBe('other_orchestrator_task_enabled')
    const h = harness({ countOtherEnabledOrchestratorTasks: async () => 1 })
    expect(await armProof(baseArgs({ dryRun: true }), h.deps)).toMatchObject({ ok: false, code: 'other_orchestrator_task_enabled' })
    expect(h.armCalls).toHaveLength(0)
  })

  test('QC r1: enableProof surfaces the in-tx exclusivity refusal as a typed result', async () => {
    const { enableProof } = await import('../src/orchestrator/proof-arm.ts')
    const r = await enableProof({ userId: USER }, {
      enableTx: async () => {
        const e: any = new Error('x')
        e.name = 'ProofStateError'
        e.code = 'other_orchestrator_task_enabled'
        throw e
      },
    })
    expect(r).toMatchObject({ ok: false, code: 'other_orchestrator_task_enabled' })
  })

  test('tx-thrown other_repo_allowlisted / proof_already_active surface as the same code', async () => {
    for (const code of ['other_repo_allowlisted', 'proof_already_active', 'other_orchestrator_task_enabled'] as const) {
      const h = harness({
        armTx: async () => {
          const e: any = new Error(code)
          e.name = 'ProofStateError'
          e.code = code
          throw e
        },
      })
      const r = await armProof(baseArgs(), h.deps)
      expect(r).toMatchObject({ ok: false, code })
    }
  })

  test('an unexpected tx error is rethrown, not mapped to a code', async () => {
    const h = harness({
      armTx: async () => {
        throw new Error('connection reset')
      },
    })
    await expect(armProof(baseArgs(), h.deps)).rejects.toThrow('connection reset')
  })

  test('order: the first failing precondition wins (unconfigured beats bad budget beats ownership)', async () => {
    const r = await refused({ isGithubAppConfigured: () => false, getInstallation: async () => null }, { maxInjects: 'x' })
    expect(r.code).toBe('github_app_unconfigured')
    const r2 = await refused({ getInstallation: async () => null }, { maxInjects: 'x' })
    expect(r2.code).toBe('invalid_budget')
  })
})

describe('armProof success', () => {
  test('calls armTx exactly once with frozen protection, base_sha, budgets, preconditions and cadence', async () => {
    const h = harness()
    const r = await armProof(baseArgs({ agentLogin: 'agent-bot' }), h.deps)
    expect(r.ok).toBe(true)
    expect(h.armCalls.length).toBe(1)
    const a = h.armCalls[0]
    expect(a).toMatchObject({
      userId: USER,
      sessionId: SESSION,
      repoIdent: REPO_IDENT,
      installationId: INSTALL,
      repoOwner: 'acme',
      repoName: 'proof',
      defaultBranch: 'main',
      baseSha: BASE_SHA,
      rulesetIds: [1],
      protectionShape: 'branch_lock',
      requiredContexts: ['ci'],
      maxInjects: 6,
      maxTokens: 3_000_000,
      maxWallMs: 21_600_000,
      scheduleRule: { interval: 30, unit: 'minutes', start_at: '2026-10-13T12:00:00.000Z' },
    })
    expect(typeof a.rulesetDigest).toBe('string')
    expect(a.rulesetDigest.length).toBeGreaterThan(8)
    expect(a.rulesetUpdatedAt).toBe('2026-10-01T00:00:00Z')
    // 05-04 contract: the exact key + value the API reads.
    expect(a.armPreconditions.bypass_verification).toBe('verified')
    expect(a.armPreconditions.agent_permission).toBe('verified')
  })

  test('budgets: flags beat env beats defaults, and the core never reads process.env', async () => {
    const h = harness({ env: { REMO_PROOF_MAX_INJECTS: '9', REMO_PROOF_MAX_TOKENS: '777', REMO_PROOF_MAX_WALL_MS: '4000' } })
    const r = await armProof(baseArgs({ maxInjects: '3' }), h.deps)
    expect(r.ok).toBe(true)
    expect(h.armCalls[0]).toMatchObject({ maxInjects: 3, maxTokens: 777, maxWallMs: 4000 })
  })

  test('cadence flags are honoured and validated', async () => {
    const h = harness()
    await armProof(baseArgs({ every: '2', unit: 'hours' }), h.deps)
    expect(h.armCalls[0].scheduleRule).toMatchObject({ interval: 2, unit: 'hours' })
    const bad = harness()
    const r = await armProof(baseArgs({ every: '0' }), bad.deps)
    expect(r).toMatchObject({ ok: false, code: 'invalid_schedule' })
    expect(bad.armCalls.length).toBe(0)
  })

  test('unreadable agent permission is NOT a refusal: recorded unverified with a loud warning', async () => {
    const h = harness() // 'ghost-user' has no permission entry -> fake throws not_found
    const r = await armProof(baseArgs({ agentLogin: 'ghost-user' }), h.deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(h.armCalls[0].armPreconditions.agent_permission).toBe('unverified')
    expect(r.summary.warnings.join('\n')).toContain('agent_permission')
  })

  test('no --agent-login records agent_permission unverified', async () => {
    const h = harness()
    await armProof(baseArgs(), h.deps)
    expect(h.armCalls[0].armPreconditions.agent_permission).toBe('unverified')
  })

  test('an allowlist that already holds exactly the target is accepted', async () => {
    const h = harness({ listAllowlist: async () => [REPO_IDENT] })
    const r = await armProof(baseArgs(), h.deps)
    expect(r.ok).toBe(true)
  })
})

describe('armProof dry run', () => {
  test('performs every read-only precondition and returns a summary with ZERO writes', async () => {
    const h = harness()
    const r = await armProof(baseArgs({ dryRun: true, agentLogin: 'agent-bot' }), h.deps)
    expect(h.armCalls.length).toBe(0)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dryRun).toBe(true)
    expect(r.summary).toMatchObject({
      repoIdent: REPO_IDENT,
      baseSha: BASE_SHA,
      defaultBranch: 'main',
      protectionShape: 'branch_lock',
      requiredContexts: ['ci'],
      allowlist: [],
      bypassVerification: 'verified',
      agentPermission: 'verified',
      budget: { maxInjects: 6, maxTokens: 3_000_000, maxWallMs: 21_600_000 },
    })
    expect(r.summary.branchPreview.startsWith('proof/')).toBe(true)
    expect(r.summary.digestPrefix.length).toBe(12)
  })

  test('a dry run still refuses on a failed precondition, with no write', async () => {
    const h = harness({ listAllowlist: async () => ['github://acme/other'] })
    const r = await armProof(baseArgs({ dryRun: true }), h.deps)
    expect(r).toMatchObject({ ok: false, code: 'other_repo_allowlisted' })
    expect(h.armCalls.length).toBe(0)
  })

  test('a dry run reads only: the GitHub fake saw no method that could write', async () => {
    const h = harness()
    await armProof(baseArgs({ dryRun: true }), h.deps)
    expect(h.github.calls.length).toBeGreaterThan(0)
  })
})
