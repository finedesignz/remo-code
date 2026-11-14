// CORCH-01 (CORCH-R1.8-R1.13, R3.4, R3.5): gates, keys, refusal schedule, request builder, and the
// dispatcher's launch/requeue behaviour with fake deps. No DB, no module mocks.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCorchPipelineDeps,
  buildCorchRequest,
  refusalSchedule,
  DEFAULT_WORKSPACE,
  DEFAULT_PR_LOOKUP,
} from '../src/corch/dispatcher.ts'
import { corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate } from '../src/corch/gates.ts'
import { DEFAULT_QUOTA_PROVIDER } from '../src/corch/quota-provider.ts'
import { buildCorchKey, buildCorchRunToken, runIdFromToken } from '../src/corch/keys.ts'
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../src/dispatch/automation-controls.ts'
import { dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../src/dispatch/gates.ts'

const SRC = join(import.meta.dir, '..', 'src')

const savedFlag = process.env.REMO_CORCH_ENABLED
afterEach(() => {
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

function ctx(over: Record<string, unknown> = {}) {
  return {
    run: { id: 'r1', user_id: 'u1', project_id: 'p1', work_item_id: 'w1' },
    item: { id: 'w1' },
    project: { id: 'p1', daily_token_budget: 1000, repo_ident: 'github://a/b' },
    maxConcurrent: 1,
    tz: 'UTC',
    ...over,
  }
}

function fakeStore(over: Record<string, unknown> = {}) {
  return {
    runContext: async () => ctx(),
    liveRunsForUser: async () => 0,
    projectTokensToday: async () => 0,
    ...over,
  } as any
}

const TOKEN = buildCorchRunToken('r1')
const req = (token = TOKEN) => ({ userId: 'u1', sessionId: 's1', token, prompt: 'p' })

describe('gate list (CORCH-R1.9)', () => {
  test('buildCorchPipelineDeps gates are the exact 8, in order', () => {
    const deps = buildCorchPipelineDeps({ store: fakeStore(), quota: DEFAULT_QUOTA_PROVIDER, pipeline: {} } as any)
    expect(deps.gates.map((g) => g.name)).toEqual([
      automationKillSwitchGate.name,
      dailyCostCapGate.name,
      dailyTokenCapGate.name,
      'corch_project_budget',
      'corch_concurrency',
      'corch_quota',
      sessionInjectRateGate.name,
      automationLifetimeCounterGate.name,
    ])
  })
})

describe('corch gates', () => {
  test('corchConcurrencyGate refuses at cap (excluding own run) and passes below', async () => {
    const at = corchConcurrencyGate(fakeStore({ liveRunsForUser: async () => 1 }))
    expect(await at.check(req())).toEqual({ ok: false, reason: 'corch_concurrency' })
    const below = corchConcurrencyGate(fakeStore({ liveRunsForUser: async () => 0 }))
    expect(await below.check(req())).toEqual({ ok: true })
    const cap2 = corchConcurrencyGate(fakeStore({ runContext: async () => ctx({ maxConcurrent: 2 }), liveRunsForUser: async () => 1 }))
    expect(await cap2.check(req())).toEqual({ ok: true })
  })
  test('corchConcurrencyGate excludes the request run from the live count', async () => {
    let seen: unknown[] = []
    const g = corchConcurrencyGate(fakeStore({ liveRunsForUser: async (...a: unknown[]) => ((seen = a), 0) }))
    await g.check(req())
    expect(seen).toEqual(['u1', 'r1'])
  })
  test('corchProjectBudgetGate refuses project_budget at or over budget', async () => {
    const over = corchProjectBudgetGate(fakeStore({ projectTokensToday: async () => 1000 }))
    expect(await over.check(req())).toEqual({ ok: false, reason: 'project_budget' })
    const under = corchProjectBudgetGate(fakeStore({ projectTokensToday: async () => 999 }))
    expect(await under.check(req())).toEqual({ ok: true })
  })
  test('corchQuotaGate: default provider refuses quota_no_snapshot; ok provider passes (CORCH-R1.13)', async () => {
    const store = fakeStore()
    expect(await corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store).check(req())).toEqual({ ok: false, reason: 'quota_no_snapshot' })
    const ok = { snapshotFor: async () => ({ ok: true as const, account_slot: null, supervisor_id: null }) }
    expect(await corchQuotaGate(ok, store).check(req())).toEqual({ ok: true })
  })
  test('every corch gate fails closed for a non corch-run token', async () => {
    const store = fakeStore()
    for (const g of [corchProjectBudgetGate(store), corchConcurrencyGate(store), corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store)]) {
      expect(await g.check(req('heal:x'))).toEqual({ ok: false, reason: 'corch_bad_token' })
    }
  })
  test('every corch gate fails closed when the run is unknown', async () => {
    const store = fakeStore({ runContext: async () => null })
    for (const g of [corchProjectBudgetGate(store), corchConcurrencyGate(store), corchQuotaGate(DEFAULT_QUOTA_PROVIDER, store)]) {
      expect(await g.check(req())).toEqual({ ok: false, reason: 'corch_bad_token' })
    }
  })
})

describe('keys (LD-3)', () => {
  test('buildCorchKey and run token round trip', () => {
    expect(buildCorchKey('abc')).toBe('corch:abc')
    expect(runIdFromToken(buildCorchRunToken('r9'))).toBe('r9')
    expect(runIdFromToken('heal:x')).toBeNull()
    expect(runIdFromToken('corch-run:')).toBeNull()
  })
})

describe('refusalSchedule (LD-7)', () => {
  test('the gates.ts literals the map matches by prefix are pinned', () => {
    const g = readFileSync(join(SRC, 'dispatch/gates.ts'), 'utf-8')
    expect(g).toContain('`over_daily_cost_cap:')
    expect(g).toContain('`over_daily_token_cap:')
    expect(g).toContain('`over_session_inject_rate:')
  })
  test('midnight kinds', () => {
    for (const r of ['project_budget', 'over_daily_cost_cap:$10.42>=$10.00', 'over_daily_token_cap:5>=4', 'over_token_cap', 'launch_cap']) {
      expect([r, refusalSchedule(r).notBefore]).toEqual([r, 'midnight'])
    }
  })
  test('inject rate is plus_60m; autospawn_launch_ prefix is plus_lease', () => {
    expect(refusalSchedule('over_session_inject_rate:4>=4').notBefore).toBe('plus_60m')
    expect(refusalSchedule('autospawn_launch_no_supervisor').notBefore).toBe('plus_lease')
  })
  test('event-driven reasons carry no not_before', () => {
    for (const r of [
      'automation_halted:global', 'corch_concurrency', 'quota_no_snapshot', 'lifetime_inject_exhausted:1000>=1000',
      'workspace_unavailable', 'supervisor_offline', 'disabled', 'not_allowlisted', 'in_flight', 'ledger_unavailable', 'weird_unknown',
    ]) {
      expect([r, refusalSchedule(r).notBefore]).toEqual([r, null])
    }
  })
  test('end_reason normalizes automation_halted:<scope>; wait_reason keeps the full string', () => {
    expect(refusalSchedule('automation_halted:user')).toEqual({ endReason: 'automation_halted', waitReason: 'automation_halted:user', notBefore: null })
    expect(refusalSchedule('quota_no_snapshot').endReason).toBe('quota_no_snapshot')
  })
})

describe('buildCorchRequest (CORCH-R1.10)', () => {
  test('counterKey comes from the work item id, never from the caller', () => {
    const r = buildCorchRequest({
      userId: 'u1', sessionId: 's1', runId: 'r1', workItemId: 'w1', prompt: 'hi',
      counterKey: 'task:evil', token: 'evil',
    } as any)
    expect(r.counterKey).toBe('corch:w1')
    expect(r.token).toBe('corch-run:r1')
    expect(r.prompt).toBe('hi')
  })
})

describe('defaults fail closed (LD-11)', () => {
  test('workspace and pr lookup', async () => {
    expect(await DEFAULT_WORKSPACE.resolve({} as any)).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(await DEFAULT_PR_LOOKUP.lookup({} as any)).toEqual({ kind: 'unavailable' })
  })
})
