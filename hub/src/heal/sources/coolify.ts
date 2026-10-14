// hub/src/heal/sources/coolify.ts
//
// PTYCAP-07-08 (SH-01, SH-02, D-06, D-10, AM-F2-4, AM-F3-3): turn a Coolify deploy-failure
// webhook payload into a HealEvent for routeHeal. Pure apart from the injected app-uuid resolver.
// The source renders and fences the prompt (renderTriagePrompt fences logs and the webhook-supplied
// repo string as untrusted data); routeHeal appends the scope contract. No bound_session_id: a
// deploy failure has no session binding. Nothing here touches the Coolify idempotency table.

import { createHash } from 'node:crypto';
import { renderTriagePrompt } from '../../scheduler/triage-prompt.ts';
import { canonicalRepoIdentFromGit, isCanonicalRepoIdent } from '../repo-ident.ts';
import type { HealEvent } from '../types.ts';

export interface CoolifyPayloadLike {
  application_uuid: string;
  deployment_uuid: string;
  git_repository?: string;
  commit_sha?: string;
}

export interface CoolifySourceDeps {
  /** The already-fetched (and already length-bounded) deployment log snippet. */
  logSnippet: string;
  /** Application uuid -> canonical repo key, or null. Lazy real default. */
  resolveRepoKeyFromAppUuid?: (appUuid: string, userId: string) => Promise<string | null>;
}

/** Time-free: the ledger owns the dedupe window. */
function shortHash(...parts: Array<string | undefined>): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('\u0000')).digest('hex').slice(0, 16);
}

export async function buildCoolifyHealEvent(
  userId: string,
  deploymentRunId: string,
  payload: CoolifyPayloadLike,
  deps: CoolifySourceDeps,
): Promise<HealEvent> {
  let repoIdent = canonicalRepoIdentFromGit(payload.git_repository);
  if (!isCanonicalRepoIdent(repoIdent)) {
    const resolve =
      deps.resolveRepoKeyFromAppUuid ??
      (async (appUuid: string, uid: string) => (await import('../../sessions/coolify-app-repo.ts')).resolveRepoKeyFromAppUuid(appUuid, uid));
    const resolved = await resolve(payload.application_uuid, userId);
    repoIdent = isCanonicalRepoIdent(resolved) ? resolved : null;
  }

  const prompt = renderTriagePrompt({
    application_uuid: payload.application_uuid,
    deployment_uuid: payload.deployment_uuid,
    git_repository: payload.git_repository,
    commit_sha: payload.commit_sha,
    log_snippet: deps.logSnippet,
  });

  return {
    source: 'coolify_deploy',
    user_id: userId,
    repo_ident: repoIdent,
    prompt,
    // Legacy chat framing (senders/triage.ts): `[triage: <task name>]\n\n<prompt>`.
    stored_content: `[triage: __internal_triage]\n\n${prompt}`,
    metadata_run_id: deploymentRunId,
    trigger_run_id: deploymentRunId,
    dedupe_key: `coolify:${payload.application_uuid}:${shortHash(payload.git_repository, payload.commit_sha)}`,
    notify_summary: `Deploy failed: application ${payload.application_uuid}, deployment ${payload.deployment_uuid}`.slice(0, 500),
    ctx: {
      application_uuid: payload.application_uuid,
      deployment_uuid: payload.deployment_uuid,
      git_repository: payload.git_repository,
      commit_sha: payload.commit_sha,
      log_snippet: deps.logSnippet,
    },
  } as HealEvent;
}
