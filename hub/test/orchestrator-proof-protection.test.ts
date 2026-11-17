/**
 * PTYCAP-05 plan 02 task 2: protection assertion, freeze, drift, permission probe,
 * agent-admin check. Pure functions over the ProofGithub contract; the shared fake
 * supplies GitHub, so nothing here touches the network or env.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import {
  assertAgentNotAdmin,
  assertGithubPermissions,
  canonicalJson,
  evaluateProtection,
  protectionDigest,
  reassertProtection,
  type FrozenProtection,
} from '../src/orchestrator/proof-protection.ts'
import { ProofGithubError, type EffectiveRule, type RulesetDetail } from '../src/orchestrator/proof-types.ts'
import { defaultScenario, makeFakeProofGithub, type FakeGithubScenario } from './fixtures/proof-fake-github.ts'

const T = { owner: 'acme', repo: 'proof', defaultBranch: 'main' }

const effUpdate = (id = 1): EffectiveRule => ({ type: 'update', rulesetId: id, rulesetSourceType: 'Repository', parameters: null })
const effRsc = (id = 1, ctxs: string[] = ['ci']): EffectiveRule => ({
  type: 'required_status_checks',
  rulesetId: id,
  rulesetSourceType: 'Repository',
  parameters: { required_status_checks: ctxs.map((context) => ({ context })) },
})
const effPr = (id = 1, approvals = 1, lastPush = true): EffectiveRule => ({
  type: 'pull_request',
  rulesetId: id,
  rulesetSourceType: 'Repository',
  parameters: { required_approving_review_count: approvals, require_last_push_approval: lastPush },
})
const effNonFf = (id = 1): EffectiveRule => ({ type: 'non_fast_forward', rulesetId: id, rulesetSourceType: 'Repository', parameters: null })

const ruleset = (id: number, eff: EffectiveRule[], over: Partial<RulesetDetail> = {}): RulesetDetail => ({
  id,
  name: `rs-${id}`,
  target: 'branch',
  sourceType: 'Repository',
  enforcement: 'active',
  bypassActors: [],
  conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
  rules: eff.map((e) => ({ type: e.type, parameters: e.parameters })),
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
})

function scenario(eff: EffectiveRule[], rulesets: RulesetDetail[]): Partial<FakeGithubScenario> {
  return { effectiveRules: eff, rulesets: Object.fromEntries(rulesets.map((r) => [r.id, r])) }
}

const lock = () => scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)])])
const reviewGate = () =>
  scenario([effPr(1), effNonFf(1), effRsc(1)], [ruleset(1, [effPr(1), effNonFf(1), effRsc(1)])])

async function frozenOf(patch: Partial<FakeGithubScenario>): Promise<FrozenProtection> {
  const r = await evaluateProtection(makeFakeProofGithub(patch), T)
  if (!r.ok) throw new Error(`setup evaluate failed: ${r.reason} ${r.detail}`)
  return r.frozen
}

describe('evaluateProtection: accepted shapes', () => {
  test('branch_lock (update + required checks, zero bypass) is accepted and frozen', async () => {
    const r = await evaluateProtection(makeFakeProofGithub(lock()), T)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frozen).toMatchObject({
      shape: 'branch_lock',
      rulesetIds: [1],
      requiredContexts: ['ci'],
      defaultBranch: 'main',
      updatedAt: '2026-10-01T00:00:00Z',
      owner: 'acme',
      repo: 'proof',
    })
    expect(r.frozen.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  test('review_gate (approval + last-push approval + non_fast_forward + checks) is accepted', async () => {
    const r = await evaluateProtection(makeFakeProofGithub(reviewGate()), T)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.frozen.shape).toBe('review_gate')
  })

  test('branch_lock wins when both shapes are present', async () => {
    const eff = [effUpdate(1), effRsc(1), effPr(1), effNonFf(1)]
    const r = await evaluateProtection(makeFakeProofGithub(scenario(eff, [ruleset(1, eff)])), T)
    expect(r.ok && r.frozen.shape).toBe('branch_lock')
  })

  test('digest is the sha256 of the canonical JSON and is stable across calls', async () => {
    const a = await frozenOf(lock())
    const b = await frozenOf(lock())
    expect(a.digest).toBe(b.digest)
    const rs = ruleset(1, [effUpdate(1), effRsc(1)])
    expect(a.digest).toBe(protectionDigest([effUpdate(1), effRsc(1)], [rs]))
    const normRs = {
      id: 1,
      enforcement: 'active',
      target: 'branch',
      sourceType: 'Repository',
      conditions: rs.conditions,
      rules: [
        { type: 'required_status_checks', parameters: effRsc(1).parameters },
        { type: 'update', parameters: null },
      ],
      bypassActors: [],
      updatedAt: rs.updatedAt,
    }
    const independent = createHash('sha256')
      .update(canonicalJson({ effectiveRules: [effRsc(1), effUpdate(1)], rulesets: [normRs] }))
      .digest('hex')
    expect(a.digest).toBe(independent)
  })

  test('multi-ruleset: ids sorted, contexts sorted and de-duplicated, updatedAt is the max', async () => {
    const eff = [effUpdate(5), effRsc(2, ['zeta', 'ci']), effRsc(5, ['ci', 'alpha'])]
    const r = await evaluateProtection(
      makeFakeProofGithub(
        scenario(eff, [
          ruleset(5, [effUpdate(5), effRsc(5, ['ci', 'alpha'])], { updatedAt: '2026-10-05T00:00:00Z' }),
          ruleset(2, [effRsc(2, ['zeta', 'ci'])], { updatedAt: '2026-10-02T00:00:00Z' }),
        ]),
      ),
      T,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.frozen.rulesetIds).toEqual([2, 5])
    expect(r.frozen.requiredContexts).toEqual(['alpha', 'ci', 'zeta'])
    expect(r.frozen.updatedAt).toBe('2026-10-05T00:00:00Z')
  })
})

describe('evaluateProtection: insufficient shapes (not preventive)', () => {
  test('pull_request + required_status_checks only (the dev macro squash-merges on green) is proof_protection_insufficient', async () => {
    const eff = [effPr(1, 0, false), effRsc(1)]
    const r = await evaluateProtection(makeFakeProofGithub(scenario(eff, [ruleset(1, eff)])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_insufficient' })
  })

  test('approval required but no last-push approval is insufficient (author can self-supply)', async () => {
    const eff = [effPr(1, 1, false), effNonFf(1), effRsc(1)]
    const r = await evaluateProtection(makeFakeProofGithub(scenario(eff, [ruleset(1, eff)])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_insufficient' })
  })

  test('review gate without non_fast_forward is insufficient', async () => {
    const eff = [effPr(1), effRsc(1)]
    const r = await evaluateProtection(makeFakeProofGithub(scenario(eff, [ruleset(1, eff)])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_insufficient' })
  })

  test('update rule with no required status check context is insufficient', async () => {
    const eff = [effUpdate(1), effRsc(1, [])]
    const r = await evaluateProtection(makeFakeProofGithub(scenario(eff, [ruleset(1, eff)])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_insufficient' })
  })

  test('a non-empty bypass_actors list is insufficient', async () => {
    const r = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { bypassActors: [{ actor_id: 5, actor_type: 'RepositoryRole' }] })])),
      T,
    )
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_insufficient' })
  })
})

describe('evaluateProtection: fail closed (proof_protection_unverifiable)', () => {
  test('bypassActors null (not visible to a read-only token) is unverifiable, never assumed empty', async () => {
    const r = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { bypassActors: null })])),
      T,
    )
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable', detail: 'bypass_actors_not_visible' })
  })

  test('bypassActors undefined is also unverifiable', async () => {
    const rs = ruleset(1, [effUpdate(1), effRsc(1)])
    delete (rs as Partial<RulesetDetail>).bypassActors
    const r = await evaluateProtection(makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [rs])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('empty effective rule list', async () => {
    const r = await evaluateProtection(makeFakeProofGithub(scenario([], [])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('a rule with rulesetId null', async () => {
    const r = await evaluateProtection(makeFakeProofGithub(scenario([{ ...effUpdate(1), rulesetId: null }, effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)])])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test.each([
    ['getEffectiveBranchRules', 'forbidden'],
    ['getEffectiveBranchRules', 'not_found'],
    ['getEffectiveBranchRules', 'unavailable'],
    ['getRuleset', 'forbidden'],
    ['getRuleset', 'not_found'],
    ['getRuleset', 'unavailable'],
    ['getRepo', 'unavailable'],
  ] as const)('%s rejecting with %s', async (method, kind) => {
    const gh = makeFakeProofGithub({ ...lock(), fail: { [method]: new ProofGithubError(kind, kind === 'forbidden' ? 403 : null) } })
    const r = await evaluateProtection(gh, T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('an unexpected thrown error (not a ProofGithubError) is unverifiable, not a crash', async () => {
    const gh = makeFakeProofGithub(lock())
    gh.getRuleset = async () => {
      throw new TypeError('boom')
    }
    const r = await evaluateProtection(gh, T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('malformed required_status_checks parameters', async () => {
    const bad: EffectiveRule = { ...effRsc(1), parameters: { required_status_checks: 'nope' } }
    const r = await evaluateProtection(makeFakeProofGithub(scenario([effUpdate(1), bad], [ruleset(1, [effUpdate(1), bad])])), T)
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('the repo default branch differs from the expected one', async () => {
    const r = await evaluateProtection(makeFakeProofGithub(lock()), { ...T, defaultBranch: 'trunk' })
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable', detail: 'default_branch_mismatch' })
  })

  test('an inactive ruleset', async () => {
    const r = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { enforcement: 'evaluate' })])),
      T,
    )
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('a ruleset that is not branch-targeted', async () => {
    const r = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { target: 'tag' })])),
      T,
    )
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('a ruleset detail whose id differs from the requested id, or with an empty rule set', async () => {
    const a = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [{ ...ruleset(1, [effUpdate(1), effRsc(1)]), id: 99 }])),
      T,
    )
    expect(a).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
    const b = await evaluateProtection(makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [])])), T)
    expect(b).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })

  test('a missing updated_at (drift undetectable) is unverifiable', async () => {
    const r = await evaluateProtection(
      makeFakeProofGithub(scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { updatedAt: null })])),
      T,
    )
    expect(r).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })
})

describe('reassertProtection', () => {
  test('ok when nothing changed', async () => {
    const frozen = await frozenOf(lock())
    expect(await reassertProtection(makeFakeProofGithub(lock()), frozen)).toMatchObject({ ok: true })
  })

  test('drift when a rule parameter changes (digest)', async () => {
    const frozen = await frozenOf(lock())
    const changed = scenario([effUpdate(1), effRsc(1, ['ci', 'extra'])], [ruleset(1, [effUpdate(1), effRsc(1, ['ci', 'extra'])])])
    expect(await reassertProtection(makeFakeProofGithub(changed), frozen)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })

  test('drift when only updated_at moved (frozen updatedAt differs)', async () => {
    const frozen = await frozenOf(lock())
    const moved = scenario([effUpdate(1), effRsc(1)], [ruleset(1, [effUpdate(1), effRsc(1)], { updatedAt: '2026-10-09T00:00:00Z' })])
    expect(await reassertProtection(makeFakeProofGithub(moved), frozen)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
    // and with a tampered frozen record whose digest happens to match, updatedAt alone still trips
    const tampered = { ...frozen, updatedAt: '2026-09-01T00:00:00Z' }
    expect(await reassertProtection(makeFakeProofGithub(lock()), tampered)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })

  test('drift when the contributing ruleset id set changes', async () => {
    const frozen = await frozenOf(lock())
    const moved = scenario([effUpdate(2), effRsc(2)], [ruleset(2, [effUpdate(2), effRsc(2)])])
    expect(await reassertProtection(makeFakeProofGithub(moved), frozen)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })

  test('drift when the default branch changed', async () => {
    const frozen = await frozenOf(lock())
    const gh = makeFakeProofGithub({ ...lock(), repo: { fullName: 'acme/proof', defaultBranch: 'trunk' } })
    expect(await reassertProtection(gh, frozen)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })

  test('drift when protection weakened to a non-preventive shape', async () => {
    const frozen = await frozenOf(lock())
    const weak = scenario([effPr(1, 0, false), effRsc(1)], [ruleset(1, [effPr(1, 0, false), effRsc(1)])])
    expect(await reassertProtection(makeFakeProofGithub(weak), frozen)).toMatchObject({ ok: false, reason: 'proof_protection_drift' })
  })

  test('unverifiable on any read failure, and it never throws', async () => {
    const frozen = await frozenOf(lock())
    const gh = makeFakeProofGithub({ ...lock(), fail: { getRuleset: new ProofGithubError('forbidden', 403) } })
    expect(await reassertProtection(gh, frozen)).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
    const boom = makeFakeProofGithub(lock())
    boom.getRepo = async () => {
      throw new Error('kaboom')
    }
    expect(await reassertProtection(boom, frozen)).toMatchObject({ ok: false, reason: 'proof_protection_unverifiable' })
  })
})

describe('assertGithubPermissions', () => {
  const tgt = { owner: 'acme', repo: 'proof' }
  test('ok when every probe passes', async () => {
    expect(await assertGithubPermissions(makeFakeProofGithub(), tgt)).toEqual({ ok: true })
  })

  test('names every missing permission', async () => {
    const probe = { administrationRead: false, checksRead: false, statusesRead: false, pullsRead: false, contentsRead: false }
    const r = await assertGithubPermissions(makeFakeProofGithub({ probe }), tgt)
    expect(r).toMatchObject({ ok: false, reason: 'proof_permissions_missing' })
    if (!r.ok) expect(r.missing).toEqual(['administration_read', 'checks_read', 'commit_statuses_read', 'pull_requests_read', 'contents_read'])
  })

  test('a single missing permission is named alone', async () => {
    const r = await assertGithubPermissions(makeFakeProofGithub({ probe: { ...defaultScenario().probe, checksRead: false } }), tgt)
    expect(r).toMatchObject({ ok: false, reason: 'proof_permissions_missing', missing: ['checks_read'] })
  })

  test('a throwing probe fails closed with everything missing', async () => {
    const gh = makeFakeProofGithub({ fail: { probePermissions: new ProofGithubError('unavailable', 500) } })
    const r = await assertGithubPermissions(gh, tgt)
    expect(r).toMatchObject({ ok: false, reason: 'proof_permissions_missing' })
  })
})

describe('assertAgentNotAdmin', () => {
  const tgt = { owner: 'acme', repo: 'proof' }
  test('admin is refused', async () => {
    const r = await assertAgentNotAdmin(makeFakeProofGithub({ permissions: { bot: 'admin' } }), tgt, 'bot')
    expect(r).toEqual({ ok: false, reason: 'agent_credential_is_admin' })
  })

  test.each(['maintain', 'write', 'triage', 'read', 'none'])('%s is accepted and verified', async (perm) => {
    const r = await assertAgentNotAdmin(makeFakeProofGithub({ permissions: { bot: perm } }), tgt, 'bot')
    expect(r).toEqual({ ok: true, verified: true })
  })

  test.each([
    ['forbidden', 403],
    ['not_found', 404],
    ['unavailable', 500],
  ] as const)('an unreadable permission (%s) is ok but unverified', async (kind, status) => {
    const gh = makeFakeProofGithub({ fail: { getCollaboratorPermission: new ProofGithubError(kind, status) } })
    const r = await assertAgentNotAdmin(gh, tgt, 'bot')
    expect(r).toMatchObject({ ok: true, verified: false })
  })

  test('no login supplied records unverified', async () => {
    expect(await assertAgentNotAdmin(makeFakeProofGithub(), tgt, undefined)).toEqual({ ok: true, verified: false, detail: 'no_agent_login' })
  })
})

describe('F1-6: credential scrubbing is not a control', () => {
  test('no proof module imports or references scrub helpers', () => {
    for (const f of ['proof-github.ts', 'proof-protection.ts']) {
      const src = readFileSync(new URL(`../src/orchestrator/${f}`, import.meta.url), 'utf8')
      for (const needle of ['env-sanitize', 'sanitizeSpawnEnv', 'scrubDeployCredentials']) {
        expect(src.includes(needle)).toBe(false)
      }
    }
  })
})
