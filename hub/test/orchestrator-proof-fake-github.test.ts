/**
 * PTYCAP-05: the shared ProofGithub fake is deterministic and honest (typed failures,
 * call log, unmodeled-method throw, shared scenario helpers). Pure, no network.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADVANCED_SHA,
  BASE_SHA,
  greenPr,
  mainAdvanced,
  makeFakeProofGithub,
  redPr,
  unreadableRulesets,
} from './fixtures/proof-fake-github.ts'
import { ProofGithubError } from '../src/orchestrator/proof-types.ts'

describe('makeFakeProofGithub', () => {
  test('defaults: repo, default-branch head, a readable update-restriction ruleset with zero bypass actors', async () => {
    const g = makeFakeProofGithub()
    expect((await g.getRepo('acme', 'proof')).defaultBranch).toBe('main')
    expect(await g.getBranchHeadSha('acme', 'proof', 'main')).toBe(BASE_SHA)
    const rules = await g.getEffectiveBranchRules('acme', 'proof', 'main')
    expect(rules[0].type).toBe('update')
    const rs = await g.getRuleset('acme', 'proof', rules[0].rulesetId!)
    expect(rs.bypassActors).toEqual([])
    expect((await g.probePermissions('acme', 'proof')).administrationRead).toBe(true)
  })

  test('every call is appended to the call log with its args', async () => {
    const g = makeFakeProofGithub()
    await g.getRepo('acme', 'proof')
    await g.compare('acme', 'proof', BASE_SHA, 'main')
    expect(g.calls).toEqual([
      { method: 'getRepo', args: ['acme', 'proof'] },
      { method: 'compare', args: ['acme', 'proof', BASE_SHA, 'main'] },
    ])
  })

  test('typed failures: a per-method fail map rejects with ProofGithubError kind + status', async () => {
    const g = makeFakeProofGithub({
      fail: {
        getRepo: new ProofGithubError('forbidden', 403),
        compare: new ProofGithubError('unavailable', 503),
      },
    })
    await expect(g.getRepo('a', 'b')).rejects.toMatchObject({ name: 'ProofGithubError', kind: 'forbidden', status: 403 })
    await expect(g.compare('a', 'b', 'x', 'y')).rejects.toMatchObject({ kind: 'unavailable', status: 503 })
    // other methods unaffected, but a failing call is still logged
    expect(await g.getBranchHeadSha('a', 'b', 'main')).toBe(BASE_SHA)
    expect(g.calls.map((c) => c.method)).toEqual(['getRepo', 'compare', 'getBranchHeadSha'])
  })

  test('missing data is a typed not_found, never a silent default', async () => {
    const g = makeFakeProofGithub()
    await expect(g.getBranchHeadSha('a', 'b', 'nope')).rejects.toMatchObject({ kind: 'not_found', status: 404 })
    await expect(g.getRuleset('a', 'b', 999)).rejects.toMatchObject({ kind: 'not_found' })
    await expect(g.getCollaboratorPermission('a', 'b', 'ghost')).rejects.toMatchObject({ kind: 'not_found' })
  })

  test('bypassActors null means "not returned to this token"', async () => {
    const g = makeFakeProofGithub()
    g.scenario.rulesets[1] = { ...g.scenario.rulesets[1], bypassActors: null }
    expect((await g.getRuleset('a', 'b', 1)).bypassActors).toBeNull()
  })

  test('calling an unmodeled method throws', () => {
    const g = makeFakeProofGithub() as any
    expect(() => g.createPull('a', 'b')).toThrow(/unmodeled method 'createPull'/)
    expect(() => g.mergePull(1)).toThrow(/unmodeled/)
  })
})

describe('shared scenario helpers', () => {
  test('greenPr / redPr: an open proof PR and its check conclusion', async () => {
    const green = makeFakeProofGithub(greenPr())
    const [p] = await green.listPulls('a', 'b')
    expect(p).toMatchObject({ number: 1, state: 'open', merged: false, baseRef: 'main' })
    expect((await green.getCheckState('a', 'b', p.headSha)).checkRuns[0].conclusion).toBe('success')

    const red = makeFakeProofGithub(redPr())
    const [q] = await red.listPulls('a', 'b')
    expect((await red.getCheckState('a', 'b', q.headSha)).checkRuns[0].conclusion).toBe('failure')
  })

  test('mainAdvanced: head moved and compare reports ahead', async () => {
    const g = makeFakeProofGithub(mainAdvanced())
    expect(await g.getBranchHeadSha('a', 'b', 'main')).toBe(ADVANCED_SHA)
    expect((await g.compare('a', 'b', BASE_SHA, 'main')).status).toBe('ahead')
  })

  test('unreadableRulesets: ruleset reads are forbidden', async () => {
    const g = makeFakeProofGithub(unreadableRulesets())
    await expect(g.getEffectiveBranchRules('a', 'b', 'main')).rejects.toMatchObject({ kind: 'forbidden' })
    await expect(g.getRuleset('a', 'b', 1)).rejects.toMatchObject({ kind: 'forbidden' })
  })

  test('apply() merges a patch and returns the fake', async () => {
    const g = makeFakeProofGithub()
    expect(g.apply(greenPr())).toBe(g)
    expect(await g.listPulls('a', 'b')).toHaveLength(1)
  })
})

describe('ProofGithub contract is read-only', () => {
  test('the interface declares no write-shaped method', () => {
    const src = readFileSync(join(import.meta.dir, '../src/orchestrator/proof-types.ts'), 'utf8')
    const start = src.indexOf('export interface ProofGithub {')
    const body = src.slice(start, src.indexOf('\n}', start))
    const names = [...body.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1])
    expect(names.length).toBe(10)
    for (const n of names) expect(n).not.toMatch(/^(create|update|delete|merge|push|post)/i)
  })
})
