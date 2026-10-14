// hub/src/heal/sources/error-capture.ts
//
// PTYCAP-07-09 (SH-01, SH-02, D-02, D-10, AM-F1-5, AM-F2-1, AM-F2-4): turn a captured error into a
// HealEvent for routeHeal. Pure. The prompt is the already fenced error content (buildErrorMessage
// fences the untrusted fields); routeHeal appends the scope contract once. repo_ident is null on
// purpose: the seam derives it from the owner-scoped bound session, so a stored project row can
// never smuggle a different repo or tenant in. bound_session_id appears only on bound sources.

import type { ErrorProject, ErrorRow } from '../../db/error-capture-dal.ts';
import type { DispatchOutcome } from '../../error-capture/dispatcher.ts';
import type { HealEvent, HealOutcome } from '../types.ts';

export function buildErrorCaptureHealEvent(
  error: Pick<ErrorRow, 'id' | 'fingerprint' | 'error_type'>,
  project: Pick<ErrorProject, 'id' | 'user_id' | 'name'> & { session_id: string },
  content: string,
  storedContent: string,
): HealEvent {
  return {
    source: 'error_capture',
    user_id: project.user_id,
    repo_ident: null,
    prompt: content,
    stored_content: storedContent,
    metadata_run_id: null,
    trigger_run_id: null,
    // Scoped to the project so two apps sharing a fingerprint are not collapsed into one heal.
    dedupe_key: `err:${project.id}:${error.fingerprint}`,
    bound_session_id: project.session_id,
    notify_summary: `Error in ${project.name}: ${error.error_type}`.slice(0, 500),
    ctx: { error_id: error.id, project_id: project.id },
  } as HealEvent;
}

/** Map a heal outcome onto the vocabulary dispatchPendingError has always returned. */
export function healOutcomeToErrorOutcome(outcome: HealOutcome): DispatchOutcome {
  switch (outcome.kind) {
    case 'dispatched_live':
      // The heal ledger, not this return value, records the run; callers only await completion.
      return { status: 'dispatched', run_id: '' };
    case 'autospawn_launched':
    case 'autospawn_parked':
      return { status: 'queued' };
    case 'no_routable_session':
    case 'refused':
      return { status: 'skipped', skip_reason: outcome.reason };
    case 'failed':
      return { status: 'failed', skip_reason: outcome.reason };
    case 'deduped':
      return { status: 'noop', skip_reason: 'deduped' };
  }
}
