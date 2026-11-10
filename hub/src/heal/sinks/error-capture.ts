// hub/src/heal/sinks/error-capture.ts
//
// PTYCAP-07-07: error-capture sink. Run lifecycle and broadcasts come from the legacy store
// extracted from error-capture/dispatcher.ts (buildErrorCaptureRunStore). Its legacy throttled
// notifier is DISABLED here: owner notification is the per-event heal claim (QC r1), taken by
// routeHeal for immediate outcomes and by this sink for deferred skip/send failures (QC r2). The legacy
// post-dispatch transitions are expressed through the existing HealSink callbacks. Per AM-F1-5 there is no ensure-online hook here: that exists only
// on the flag-OFF legacy path.

import { buildErrorCaptureRunStore } from '../../error-capture/dispatcher.ts';
import { updateErrorDispatchStatus } from '../../db/error-capture-dal.ts';
import type { ErrorProject } from '../../db/error-capture-dal.ts';
import { broadcastErrorEvent } from '../../ws/registry.ts';
import type { HealEvent } from '../types.ts';
import { sendUserMessage, type SendDeps } from './shared.ts';
import { notifyOnceDetailed, REAL_NOTIFY_DEPS, type NotifyDeps } from '../notify.ts';
import type { HealSink, HealTerminalOutcome, SinkContext } from './types.ts';

export interface ErrorCaptureDeps {
  load(errorId: string, projectId: string): Promise<{ project: ErrorProject; error: { error_type: string; error_value: string } }>;
  send?: SendDeps;
  /** Owner-notification seam for deferred failures (defaults to the real claim + email sender). */
  notify?: NotifyDeps;
}

export const REAL_ERROR_CAPTURE_DEPS: ErrorCaptureDeps = {
  load: async (errorId, projectId) => {
    const { sql } = await import('../../db/postgres.ts');
    const errs = await sql<Array<{ error_type: string; error_value: string }>>`SELECT * FROM errors WHERE id = ${errorId} LIMIT 1`;
    const projs = await sql<ErrorProject[]>`SELECT * FROM error_projects WHERE id = ${projectId} LIMIT 1`;
    if (!errs[0] || !projs[0]) throw new Error('error_capture_context_missing');
    return { project: projs[0], error: errs[0] };
  },
};

export async function buildErrorCaptureSink(
  event: HealEvent,
  ctx: SinkContext,
  deps: ErrorCaptureDeps = REAL_ERROR_CAPTURE_DEPS,
): Promise<HealSink> {
  if (event.source !== 'error_capture' || !('bound_session_id' in event)) {
    throw new Error('error_capture sink built for a different source');
  }
  const { error_id: errorId, project_id: projectId } = event.ctx as { error_id: string; project_id: string };
  const { project, error } = await deps.load(errorId, projectId);
  // The ledger event names the user; the project row must agree before any write is made on its behalf.
  if (project.user_id !== event.user_id) throw new Error('error_project_owner_mismatch');

  const userId = event.user_id;
  const legacy = buildErrorCaptureRunStore({
    errorId,
    project,
    sessionId: event.bound_session_id as string,
    userId,
    notifyCtx: { error_type: error.error_type, error_value: error.error_value },
    notify: false, // routeHeal is the sole owner-notification path inside the unified flow
  });

  // QC r2: a deferred outcome (a queued turn promoted later, then skipped or failing to send) happens
  // AFTER routeHeal returned dispatched_live, so routeHeal never gets to notify it. The sink claims
  // the SAME per-event notification slot routeHeal uses (keyed by eventId), so a synchronous failure
  // that routeHeal also reports still yields exactly one notice, and a deferred one yields one too.
  const notifyOwner = async (reason: string) => {
    if (!ctx.eventId) return;
    await notifyOnceDetailed(ctx.eventId, event, reason, deps.notify ?? REAL_NOTIFY_DEPS);
  };

  /** Set by the first terminal dispatch-status write; a later terminalization is a no-op. */
  let settled = false;

  const skip = async (reason: string) => {
    await updateErrorDispatchStatus(errorId, 'skipped', reason);
    broadcastErrorEvent(userId, {
      type: 'error_skipped',
      error_id: errorId,
      project_id: project.id,
      dispatch_status: 'skipped',
      skip_reason: reason,
    });
  };

  return {
    open: legacy.open!,
    async markSkipped(token, reason) {
      settled = true;
      await legacy.markSkipped(token, reason);
      await notifyOwner(reason);
    },
    // Legacy post-send step: status dispatched + the error_dispatched broadcast.
    async markDispatched(runId) {
      await updateErrorDispatchStatus(errorId, 'dispatched');
      broadcastErrorEvent(userId, {
        type: 'error_dispatched',
        error_id: errorId,
        project_id: project.id,
        run_id: runId,
        dispatched_at: new Date().toISOString(),
      });
    },
    onFinalize: legacy.onFinalize,
    async markFailed(runId, errMsg) {
      settled = true;
      await legacy.markFailed(runId, errMsg);
      await notifyOwner(`agent_send: ${errMsg}`);
    },
    send: (req) => sendUserMessage(req, { storedContent: event.stored_content }, deps.send),
    async finalizeTerminal(outcome: HealTerminalOutcome) {
      if (settled) return;
      settled = true;
      switch (outcome.kind) {
        case 'failed':
          return updateErrorDispatchStatus(errorId, 'failed', outcome.reason);
        case 'deduped':
          return skip('deduped');
        default:
          return skip(outcome.reason);
      }
    },
    async onParkExpire() {
      settled = true;
      await updateErrorDispatchStatus(errorId, 'skipped', 'target_offline_expired');
    },
  };
}
