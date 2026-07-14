/**
 * Work GATE proofs (milestone WORK) — the repo-allowlist gate (audit finding F6)
 * and the per-user work-rate ceiling, exercised against the REAL gate objects with
 * the DAL mocked.
 *
 * Lives in its own file because `mock.module` is process-global in Bun (see
 * feedback_bun_mock_pollution) — the QC gate runs each hub test file in its own
 * process, so an isolated mock here cannot pollute a sibling.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, mock, afterAll } from 'bun:test'
import type { DispatchRequest } from '../src/dispatch/pipeline.ts'

let allowed = false
let throwOnCheck = false
let workCount = 0

mock.module('../src/db/work-dal.ts', () => ({
  isRepoWorkAllowed: async () => {
    if (throwOnCheck) throw new Error('db down')
    return allowed
  },
  countWorkRunsForUserSince: async () => workCount,
}))

const { workRepoAllowlistGate, workRateGate, maxWorkPerHour } = await import(
  '../src/dispatch/gates.ts'
)

const REQ: DispatchRequest = { userId: 'u1', sessionId: 's1', token: 'w1', prompt: 'p' }

afterAll(() => mock.restore())

describe('workRepoAllowlistGate (audit F6) — EMPTY allowlist drives nothing', () => {
  test('a repo NOT on the allowlist blocks: no dispatch, no spend', async () => {
    allowed = false
    throwOnCheck = false
    const res = await workRepoAllowlistGate('u1', 'github://acme/not-allowed').check(REQ)
    expect(res.ok).toBe(false)
    expect((res as any).reason).toContain('repo_not_allowlisted')
  })

  test('an allowlisted repo passes', async () => {
    allowed = true
    throwOnCheck = false
    const res = await workRepoAllowlistGate('u1', 'github://acme/allowed').check(REQ)
    expect(res.ok).toBe(true)
  })

  test('FAILS CLOSED: a DB error blocks rather than admits', async () => {
    allowed = true
    throwOnCheck = true
    const res = await workRepoAllowlistGate('u1', 'github://acme/allowed').check(REQ)
    expect(res.ok).toBe(false)
    expect((res as any).reason).toContain('work_allowlist_check_failed')
    throwOnCheck = false
  })
})

describe('workRateGate — bounds an inbox turned into a spend pump', () => {
  test('default ceiling is 4/hour', () => {
    delete process.env.REMO_WORK_MAX_PER_HOUR
    expect(maxWorkPerHour()).toBe(4)
  })

  test('under the ceiling passes, over it blocks', async () => {
    delete process.env.REMO_WORK_MAX_PER_HOUR
    workCount = 4 // this item is already counted (the row is inserted pre-dispatch)
    expect((await workRateGate('u1').check(REQ)).ok).toBe(true)
    workCount = 5
    const res = await workRateGate('u1').check(REQ)
    expect(res.ok).toBe(false)
    expect((res as any).reason).toContain('over_work_rate')
  })

  test('a non-positive ceiling disables the gate (fail-open, like every other rate gate)', async () => {
    process.env.REMO_WORK_MAX_PER_HOUR = '0'
    workCount = 9_999
    expect((await workRateGate('u1').check(REQ)).ok).toBe(true)
    delete process.env.REMO_WORK_MAX_PER_HOUR
  })
})
