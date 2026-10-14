// hub/src/heal/resolve.ts
//
// PTYCAP-07-05 (SH-03, AM-F2-1, AM-F2-2, AM-F2-3): heal target resolution.
// Owner-scoped, ghost-aware, PTY-safe, and it never crosses repos: the ONLY candidate
// sources are the owner-scoped bound-session lookup and the owner-scoped repo-key listing.
// No online-session lister, no capacity picker, no channel-only resolver. The allowlist
// decision for an offline candidate happens later (plan 07-06), not here.

import type { HealEvent } from './types.ts';
import { canonicalRepoIdent, isCanonicalRepoIdent, type RepoIdentSession } from './repo-ident.ts';

export type HealTarget =
  | { kind: 'routable_live'; sessionId: string; repoIdent: string }
  | { kind: 'offline_candidate'; sessionId: string; repoIdent: string }
  | { kind: 'none'; reason: string };

export interface HealSessionRow extends RepoIdentSession {
  runner_type?: string | null;
}

export interface ResolveDeps {
  getSession(sessionId: string, userId: string): Promise<HealSessionRow | null>;
  listSessionIdsForRepoKey(userId: string, repoKey: string): Promise<string[]>;
  isSessionLive(sessionId: string): Promise<boolean>;
}

/** Real deps: lazy imports so this module (and its tests) never load the DB at import time. */
export const REAL_RESOLVE_DEPS: ResolveDeps = {
  getSession: async (id, userId) => {
    const { getSession } = await import('../db/dal.ts');
    return (await getSession(id, userId)) as HealSessionRow | null;
  },
  listSessionIdsForRepoKey: async (userId, repoKey) => {
    const { listSessionIdsForRepoKey } = await import('../db/dal.ts');
    return listSessionIdsForRepoKey(userId, repoKey);
  },
  isSessionLive: async (id) => {
    const { isSessionLive } = await import('../sessions/liveness.ts');
    return isSessionLive(id);
  },
};

const MAX_CANDIDATES = 5;
const PTY_RUNNER = 'pty-interactive';

export async function resolveHealTarget(
  event: HealEvent,
  deps: ResolveDeps = REAL_RESOLVE_DEPS,
): Promise<HealTarget> {
  const boundId = 'bound_session_id' in event ? event.bound_session_id : null;
  if (boundId) return resolveBound(event, boundId as string, deps);
  return resolveByRepo(event, deps);
}

async function resolveBound(event: HealEvent, boundId: string, deps: ResolveDeps): Promise<HealTarget> {
  // Owner-scoped: missing, deleted and foreign-user rows all come back null.
  const s = await deps.getSession(boundId, event.user_id);
  if (!s) return { kind: 'none', reason: 'bound_session_unavailable' };
  if (s.is_rootless) return { kind: 'none', reason: 'bound_session_rootless' };
  if (s.runner_type === PTY_RUNNER) return { kind: 'none', reason: 'bound_session_pty_ineligible' };
  const derived = canonicalRepoIdent(s);
  if (!derived) return { kind: 'none', reason: 'no_repo_identity' };
  if (event.repo_ident != null && event.repo_ident !== derived) return { kind: 'none', reason: 'repo_mismatch' };
  return (await deps.isSessionLive(boundId))
    ? { kind: 'routable_live', sessionId: boundId, repoIdent: derived }
    : { kind: 'offline_candidate', sessionId: boundId, repoIdent: derived };
}

async function resolveByRepo(event: HealEvent, deps: ResolveDeps): Promise<HealTarget> {
  const ident = event.repo_ident;
  if (!isCanonicalRepoIdent(ident)) return { kind: 'none', reason: 'no_repo_identity' };
  if (!ident.startsWith('github://')) return { kind: 'none', reason: 'no_session_for_repo' };

  const ids = (await deps.listSessionIdsForRepoKey(event.user_id, ident)).slice(0, MAX_CANDIDATES);
  let offline: string | null = null;
  for (const id of ids) {
    const s = await deps.getSession(id, event.user_id);
    if (!s || s.is_rootless || s.runner_type === PTY_RUNNER) continue;
    if (await deps.isSessionLive(id)) return { kind: 'routable_live', sessionId: id, repoIdent: ident };
    offline ??= id; // listing is most-recently-active first
  }
  return offline
    ? { kind: 'offline_candidate', sessionId: offline, repoIdent: ident }
    : { kind: 'none', reason: 'no_session_for_repo' };
}
