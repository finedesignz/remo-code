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
// 2026-08-18 QC round 3 (R3-2) — import the dependency-free LEAF module, not
// process-manager.ts. process-manager.ts sits at the center of the
// supervisor's runtime graph; hub/tsconfig.json includes "test", so
// importing it here pulled the supervisor's entire transitive dependency
// graph (sandbox, audit, session-bridge -> claude-runner, runner-factory,
// pty-persistence) into what the hub's tsconfig typechecks — measured +10
// tsc errors on the branch vs main, all inside
// supervisor/src/runners/claude-runner.ts, now counted against the hub.
// start-rejection-reasons.ts has zero imports, so this import brings in
// exactly the one array and nothing else — matching the shape of the
// existing git-introspect.ts -> hub/src/lib/repo-key.ts precedent (also a
// leaf on the other side of the boundary).
import { START_REJECTION_REASONS } from '../../supervisor/src/start-rejection-reasons.ts'

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

  // 2026-08-18 (repo_path placeholder investigation) — was an exact-equality
  // lock-step assertion. Changed to superset: the hub serves supervisors
  // that don't upgrade atomically with the hub, so the hub's accepted set
  // legitimately carries LEGACY reasons (e.g. 'sandbox_escape') a
  // not-yet-upgraded supervisor still emits, even after current supervisor
  // code (START_REJECTION_REASONS) stops emitting them. Exact equality would
  // force deleting a legacy reason the moment the supervisor-side code
  // changes, which is precisely the version-skew bug this split introduced —
  // see the 'sandbox_escape' backward-compat comment in hub/src/ws/agent.ts.
  const LEGACY_HUB_ONLY_REASONS = new Set(['sandbox_escape'])

  test('hub accepts every reason the CURRENT supervisor can emit', () => {
    // One-directional lock-step: every reason process-manager.ts can
    // currently return MUST be in the hub's accepted set, or a rejection
    // from an up-to-date supervisor gets mis-treated as a lifecycle stop —
    // the original 2026-05-28 bug. The reverse (hub accepting something the
    // CURRENT supervisor no longer emits) is fine and expected for legacy
    // compat — see LEGACY_HUB_ONLY_REASONS above.
    for (const reason of START_REJECTION_REASONS) {
      expect(SUPERVISOR_START_REJECT_REASONS.has(reason)).toBe(true)
    }
  })

  test('every hub-only reason beyond the current supervisor union is an explicitly known legacy value', () => {
    // Catches the opposite drift: an reason lingering in the hub's set that
    // isn't in START_REJECTION_REASONS and isn't accounted for as a known
    // legacy compat value (e.g. a typo, or a reason removed from both sides
    // that should have been deleted here too).
    const currentSet = new Set<string>(START_REJECTION_REASONS)
    const extras = [...SUPERVISOR_START_REJECT_REASONS].filter((r) => !currentSet.has(r))
    expect(extras.sort()).toEqual([...LEGACY_HUB_ONLY_REASONS].sort())
  })
})
