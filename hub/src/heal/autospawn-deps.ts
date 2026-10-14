// hub/src/heal/autospawn-deps.ts
//
// PTYCAP-07-06 (SH-04, AM-F1-1): the injectable collaborators of the heal autospawn branch and
// their real bindings. Split from route.ts so the route seam never names the launch primitive:
// REAL_AUTOSPAWN.launchSessionForUser is only a pass-through handed to governedLaunch, which is the
// sole launch caller and always supplies machine: true. Every DB/WS-touching binding is a lazy import.

import { runGates, type DispatchRequest, type DispatchGate } from '../dispatch/pipeline.ts';
import { getTokenCapStatus, isOverAutospawnDailyLaunchCap } from '../dispatch/gates.ts';
import { getGraceBuffer } from '../dispatch/grace.ts';
import type { GovernedLaunchDeps } from '../dispatch/governed-launch.ts';
import type { ReserveArgs, releaseInject } from '../dispatch/automation-controls.ts';
import { healAutospawnArmed } from './config.ts';

// The budget-key field is never spelled here: only allowlisted modules may assign it.
type ReleaseArgs = Parameters<typeof releaseInject>[0];

/** Everything the autospawn branch touches, injectable so tests need no process-global mocks. */
export interface AutospawnDeps extends GovernedLaunchDeps {
  /** Heal flag AND autospawn flag only - never the orchestrator-enabled predicate (AM-F1-1). */
  armed(): boolean;
  tzForUser(userId: string): Promise<string>;
  /** The pipeline gate runner over the single builder's gate list: a refusal reason or null. */
  checkGates(req: DispatchRequest, gateList: DispatchGate[]): Promise<string | null>;
  reserve(a: ReserveArgs): Promise<{ ok: true } | { ok: false; reason: string }>;
  release(a: ReleaseArgs): Promise<void>;
  /** One deadline timer (event-driven, never polling). Real impl is unref'd. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const REAL_AUTOSPAWN: AutospawnDeps = {
  armed: () => healAutospawnArmed(),
  tzForUser: async (userId) => {
    try {
      const u = (await (await import('../db/dal.ts')).getUserById(userId)) as { timezone?: string } | null;
      return u?.timezone || 'UTC';
    } catch {
      return 'UTC';
    }
  },
  checkGates: (req, gateList) => runGates(req, gateList),
  reserve: async (a) => (await import('../dispatch/automation-controls.ts')).reserveInject(a),
  release: async (a) => (await import('../dispatch/automation-controls.ts')).releaseInject(a),
  isRepoAutospawnAllowed: async (u, r) => (await import('../db/orchestrator-rows-dal.ts')).isRepoAutospawnAllowed(u, r),
  supervisorOnlineForUser: async (userId) => {
    try {
      const sups = (await (await import('../db/supervisor-dal.ts')).listSupervisorsForUser(userId)) as unknown as Array<{ id: string }>;
      const { isSupervisorOnline } = await import('../ws/supervisor-registry.ts');
      return sups.some((s) => isSupervisorOnline(s.id));
    } catch {
      return false;
    }
  },
  getTokenCapStatus: (userId, tz) => getTokenCapStatus(userId, tz),
  countAutospawnLaunchesToday: async (userId, tz) =>
    (await import('../db/orchestrator-rows-dal.ts')).countAutospawnLaunchesToday(userId, tz),
  isOverAutospawnDailyLaunchCap,
  graceParkPending: (sessionId) => {
    try {
      return getGraceBuffer()._pendingCount(sessionId) > 0;
    } catch {
      return false;
    }
  },
  // Passed through governedLaunch, which is the only caller and always supplies machine: true.
  launchSessionForUser: async (a) => {
    const { launchSessionForUser: launch } = await import('../telegram/launch.ts');
    return launch(a);
  },
  appendRunLog: async (row) => (await import('../orchestrator/run-log.ts')).appendRunLog(row as any),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as any)?.unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

