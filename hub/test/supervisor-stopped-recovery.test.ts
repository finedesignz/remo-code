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
// 2026-08-18 QC round 2 follow-up — import the supervisor's actual runtime
// source of truth instead of a second hand-copied literal array. Round-one
// D2 was exactly this drift: a new reason added supervisor-side with no hub
// update, and a hardcoded-literal test couldn't catch it because nothing
// forced the literal to track the supervisor's type. This makes the
// assertion below fail the moment the two definitions diverge in either
// direction (a hub-side deletion OR a supervisor-side addition).
import { START_REJECTION_REASONS } from '../../supervisor/src/process-manager.ts'

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
    // Lock-step contract with supervisor/src/process-manager.ts's
    // START_REJECTION_REASONS (the runtime source of truth for
    // StartRejection.reason). Derived from the actual export, not a second
    // hand-copied literal — see the import comment above. If the supervisor
    // adds or removes a reason, this test fails loudly so the hub mirror is
    // updated in lock-step, in EITHER direction.
    expect([...SUPERVISOR_START_REJECT_REASONS].sort()).toEqual(
      [...START_REJECTION_REASONS].sort(),
    )
  })
})
