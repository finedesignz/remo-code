// hub/src/heal/types.ts
//
// PTYCAP-07-01 (SH-02, D-02, AM-F2-4): the closed HealEvent union and HealOutcome vocabulary.
// Pure: no dispatch / DB / network imports. parseHealEvent THROWS (ZodError) on invalid input.

import { z } from 'zod';

const nonEmpty = z.string().min(1);

const common = {
  user_id: nonEmpty,
  /** For bound sources this is only a hint; it must equal the session-derived ident (AM-F2-2). */
  repo_ident: z.string().nullable(),
  prompt: nonEmpty,
  stored_content: z.string().optional(),
  images: z.array(z.object({ media_type: z.string(), data: z.string() })).optional(),
  /** The scheduled_task_runs row that MUST reach a terminal status. */
  metadata_run_id: z.string().nullable(),
  /** The run that caused the event (AM-F5-3). */
  trigger_run_id: z.string().nullable(),
  notify_summary: z.string().max(500).optional(),
};

const coolifyDeploy = z
  .object({
    ...common,
    source: z.literal('coolify_deploy'),
    dedupe_key: z.string().startsWith('coolify:'),
    ctx: z.object({
      application_uuid: nonEmpty,
      deployment_uuid: nonEmpty,
      git_repository: z.string().optional(),
      commit_sha: z.string().optional(),
      log_snippet: z.string(),
    }),
  })
  .strict(); // bound_session_id rejected: a deploy failure has no session binding (AM-F2-4)

const scheduledTask = z
  .object({
    ...common,
    source: z.literal('scheduled_task'),
    dedupe_key: z.string().startsWith('task:'),
    bound_session_id: nonEmpty,
    ctx: z.object({ task_id: nonEmpty, task_name: z.string(), error_signature: z.string() }),
  })
  .strict();

const errorCapture = z
  .object({
    ...common,
    source: z.literal('error_capture'),
    dedupe_key: z.string().startsWith('err:'),
    bound_session_id: nonEmpty,
    ctx: z.object({ error_id: nonEmpty, project_id: nonEmpty }),
  })
  .strict();

const feedback = z
  .object({
    ...common,
    source: z.literal('feedback'),
    dedupe_key: z.string().startsWith('fb:'),
    bound_session_id: nonEmpty,
    ctx: z.object({ submission_id: nonEmpty, label: z.string().optional() }),
  })
  .strict();

const healEventSchema = z.discriminatedUnion('source', [coolifyDeploy, scheduledTask, errorCapture, feedback]);

export type HealEvent = Omit<z.infer<typeof healEventSchema>, 'stored_content'> & { stored_content: string };
export type HealSource = HealEvent['source'];

/** Validate an untrusted/loosely-typed event. Throws ZodError on any violation. */
export function parseHealEvent(input: unknown): HealEvent {
  const parsed = healEventSchema.parse(input);
  return { ...parsed, stored_content: parsed.stored_content ?? parsed.prompt } as HealEvent;
}

/**
 * `notifyClaimed` (optional, set only by routeHeal's finalization): the heal path WON the owner
 * notification claim for this event, whether or not the send succeeded. A caller that has its own
 * notifier (the scheduler default failure email) suppresses it exactly when this is true, so the
 * owner gets exactly one notification per heal event. `notified` (no_routable_session) is the
 * narrower "the send succeeded" fact and is kept for existing readers.
 */
export type HealOutcome =
  | { kind: 'dispatched_live' }
  | { kind: 'autospawn_launched' }
  | { kind: 'autospawn_parked' }
  | { kind: 'no_routable_session'; reason: string; notified: boolean; notifyClaimed?: boolean }
  | { kind: 'deduped' }
  | { kind: 'refused'; reason: string; notifyClaimed?: boolean }
  | { kind: 'failed'; reason: string; notifyClaimed?: boolean };

/** Persisted vocabulary: dispatched_live, autospawn_launched, autospawn_parked, no_routable_session, deduped, refused:{r}, failed:{r}. */
export function outcomeToString(o: HealOutcome): string {
  switch (o.kind) {
    case 'refused':
    case 'failed':
      return `${o.kind}:${o.reason}`;
    default:
      return o.kind;
  }
}
