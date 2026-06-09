// hub/src/orchestrator/stage-detect.ts
// Milestone TMAC §7.2 — auto-detected lifecycle_stage default.
//
// Infers a repo/session's lifecycle_stage from PROD DEPLOY STATE where derivable.
// This is used ONLY as the DEFAULT when a task has NO explicit, user-set stage; an
// explicit user-set stage ALWAYS wins (the controller never calls this when the
// stage was set explicitly — see resolveCycleContext). The detector NEVER flips an
// already-explicit stage.
//
// Conservative-by-design: we only return 'production-maintenance' when there is a
// CONCRETE positive signal that the repo has a live prod deploy (a Coolify app
// mapped to it, or a recorded successful deploy for it). With no signal we return
// 'development' — the safe default that runs silently and fully autonomously
// (SPEC §3). We never guess 'beta' (no derivable signal exists for it).
//
// SCOPE: PURE decision (`deriveStageFromSignal`) + a thin best-effort DB probe
// (`detectLifecycleStage`) behind an injectable dep. The probe NEVER throws — a
// failure degrades to 'development' rather than wedging a tick.

import { sql } from '../db/postgres.ts';
import type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';

export const DEFAULT_STAGE: LifecycleStage = 'development';

/** A best-effort, hub-derivable view of a repo's prod-deploy state. */
export interface DeploySignal {
  /** A Coolify application is mapped to this repo (deploy target exists). */
  hasCoolifyApp: boolean;
  /** At least one successful prod deploy has been recorded for this repo. */
  hasRecordedDeploy: boolean;
}

/**
 * PURE: map a derived deploy signal → the DEFAULT lifecycle stage. A live prod
 * deploy (mapped Coolify app OR a recorded deploy) ⇒ 'production-maintenance';
 * otherwise 'development'. Never returns 'beta' (not derivable) and never throws.
 */
export function deriveStageFromSignal(signal: DeploySignal): LifecycleStage {
  if (signal.hasCoolifyApp || signal.hasRecordedDeploy) {
    return 'production-maintenance';
  }
  return DEFAULT_STAGE;
}

export interface StageDetectInput {
  userId: string;
  /** The session's coolify_app_uuid mapping, when the hub knows one (else null). */
  coolifyAppUuid?: string | null;
}

export interface StageDetectDeps {
  /** Count recorded prod deploys for (user, application_uuid). Best-effort. */
  countRecordedDeploys: (userId: string, appUuid: string) => Promise<number>;
}

const REAL_DEPS: StageDetectDeps = {
  countRecordedDeploys: async (userId, appUuid) => {
    const rows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM coolify_deploy_idempotency
      WHERE user_id = ${userId} AND application_uuid = ${appUuid}
    `;
    return rows[0]?.n ?? 0;
  },
};

/**
 * Best-effort: probe prod-deploy state for a session's repo and derive the
 * DEFAULT lifecycle stage. Returns 'development' on any uncertainty (no mapped
 * Coolify app, or a DB error). Use ONLY when the task has no explicit stage.
 */
export async function detectLifecycleStage(
  input: StageDetectInput,
  deps: StageDetectDeps = REAL_DEPS,
): Promise<LifecycleStage> {
  const appUuid = (input.coolifyAppUuid ?? '').trim();
  // No mapped Coolify app ⇒ no derivable prod signal ⇒ stay development.
  if (!appUuid) return DEFAULT_STAGE;

  let hasRecordedDeploy = false;
  try {
    hasRecordedDeploy = (await deps.countRecordedDeploys(input.userId, appUuid)) > 0;
  } catch {
    return DEFAULT_STAGE;
  }

  return deriveStageFromSignal({ hasCoolifyApp: true, hasRecordedDeploy });
}
