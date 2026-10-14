// hub/src/heal/sources/feedback.ts
//
// PTYCAP-07-09 (SH-01, SH-02, D-02, D-10, AM-F1-5, AM-F2-1, AM-F2-4): turn an end-user feedback
// submission into a HealEvent for routeHeal. Pure. The prompt is the already built, untrusted-fenced
// feedback prompt; feedback_keys.session_id and user_id are plain TEXT with no foreign key, so the
// bound session id is passed through unchanged and the seam's owner-scoped lookup enforces tenancy.

import type { FeedbackDispatchOutcome, FeedbackSubmission } from '../../feedback/dispatcher.ts';
import type { HealEvent, HealOutcome } from '../types.ts';

export function buildFeedbackHealEvent(sub: FeedbackSubmission, prompt: string, storedContent: string): HealEvent {
  return {
    source: 'feedback',
    user_id: sub.userId,
    repo_ident: null,
    prompt,
    stored_content: storedContent,
    images: sub.screenshot ? [{ media_type: sub.screenshot.media_type, data: sub.screenshot.data }] : undefined,
    metadata_run_id: null,
    trigger_run_id: null,
    dedupe_key: `fb:${sub.submissionId}`,
    bound_session_id: sub.sessionId,
    notify_summary: `In-app feedback${sub.label ? ` (${sub.label})` : ''} could not be routed to a session`.slice(0, 500),
    ctx: { submission_id: sub.submissionId, label: sub.label ?? undefined },
  } as HealEvent;
}

/** Map a heal outcome onto the vocabulary dispatchFeedback has always returned. */
export function healOutcomeToFeedbackOutcome(outcome: HealOutcome): FeedbackDispatchOutcome {
  switch (outcome.kind) {
    case 'dispatched_live':
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
      return { status: 'skipped', skip_reason: 'deduped' };
  }
}
