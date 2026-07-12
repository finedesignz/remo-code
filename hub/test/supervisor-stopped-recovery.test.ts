/**
 * Regression — TRIAGE-2026-05-28
 *
 * Bug: supervisor's `process-manager.ts` wraps every start rejection in
 * `onStateChange('stopped', { lastExit: { reason } })`. The hub's
 * `supervisor.state` handler used to persist that unconditionally, so a
 * single stale-slot rejection (e.g. `concurrency_cap`) left the supervisor
 * row stuck at `state='stopped'`. Subsequent `/doctor` launches then created
 * `session_runs` rows that ended 200ms later with the same exit reason,
 * because the in-memory supervisor slots never recovered and the DB-side
 * mirror was wedged at `stopped`.
 *
 * Fix: `isStartRejectStateMessage` predicate identifies per-run rejection
 * announcements; the handler forces `state='idle'` for those instead of
 * persisting the misleading `'stopped'`. Real supervisor exits (e.g.
 * crashes, user_stopped, runtime exits) still flow through unchanged.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:55432/test'

import { describe, test, expect } from 'bun:test'
import {
  isStartRejectStateMessage,
  SUPERVISOR_START_REJECT_REASONS,
} from '../src/ws/agent.ts'

describe('isStartRejectStateMessage', () => {
  test('treats concurrency_cap as start-reject (the prod symptom)', () => {
    expect(
      isStartRejectStateMessage({
        state: 'stopped',
        last_exit: { code: null, reason: 'concurrency_cap' },
      }),
    ).toBe(true)
  })

  test('treats all start-reject reasons as start-reject', () => {
    for (const reason of SUPERVISOR_START_REJECT_REASONS) {
      expect(
        isStartRejectStateMessage({
          state: 'stopped',
          last_exit: { code: null, reason },
        }),
      ).toBe(true)
    }
  })

  test('runtime exit codes (non-reject reasons) are NOT start-reject', () => {
    // A real Claude crash or user-stop is a genuine state transition and
    // must flow through to the DB.
    for (const reason of ['user_stopped', 'crashed', 'runtime_error', 'killed', 'reboot']) {
      expect(
        isStartRejectStateMessage({
          state: 'stopped',
          last_exit: { code: 1, reason },
        }),
      ).toBe(false)
    }
  })

  test('state !== stopped is never a start-reject', () => {
    expect(
      isStartRejectStateMessage({
        state: 'running',
        last_exit: { code: null, reason: 'concurrency_cap' },
      }),
    ).toBe(false)
    expect(
      isStartRejectStateMessage({
        state: 'idle',
        last_exit: { code: null, reason: 'concurrency_cap' },
      }),
    ).toBe(false)
  })

  test('absent last_exit is never a start-reject', () => {
    expect(isStartRejectStateMessage({ state: 'stopped' })).toBe(false)
    expect(isStartRejectStateMessage({ state: 'stopped', last_exit: null })).toBe(false)
  })

  test('reason set matches process-manager.ts StartRejection union', () => {
    // Lock-step contract with supervisor/src/process-manager.ts:33.
    // If the supervisor adds a new StartRejection reason, this test fails
    // loudly so the hub mirror is updated in lock-step.
    expect([...SUPERVISOR_START_REJECT_REASONS].sort()).toEqual([
      'circuit_open',
      'concurrency_cap',
      'duplicate_run',
      'legacy_agent_spawn_disabled',
      'not_git_repo',
      'sandbox_escape',
    ])
  })
})
