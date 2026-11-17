// hub/src/db/orchestrator-proof-arm-reads.ts
// PTYCAP-05-07: the READ-ONLY lookups the arm core needs (installation ownership, session
// repo binding). Kept in the DAL layer so the operator script and proof-arm.ts hold no SQL.

import { sql } from './postgres.ts';

export async function getGithubInstallationForUser(
  userId: string,
  installationId: number,
): Promise<{ id: number | string; user_id: string; revoked_at: unknown } | null> {
  const rows = await sql<{ id: number | string; user_id: string; revoked_at: unknown }[]>`
    SELECT id, user_id, revoked_at FROM github_installations
    WHERE id = ${installationId} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getSessionRepoBinding(sessionId: string): Promise<{ user_id: string; repo_key: string | null } | null> {
  const rows = await sql<{ user_id: string; repo_key: string | null }[]>`
    SELECT user_id, repo_key FROM sessions WHERE id = ${sessionId} LIMIT 1
  `;
  return rows[0] ?? null;
}
