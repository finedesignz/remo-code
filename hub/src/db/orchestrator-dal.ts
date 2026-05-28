// hub/src/db/orchestrator-dal.ts
// DAL for the orchestrator-session feature. Keeps orchestrator-specific SQL
// out of the main dal.ts so the surface is grep-friendly + easy to roll back.

import { sql } from './postgres.ts';

export type OrchestratorPrefs = {
  orchestrator_enabled: boolean;
  orchestrator_name: string;
  orchestrator_custom_instructions: string | null;
};

export async function getOrchestratorState(userId: string): Promise<OrchestratorPrefs> {
  const rows = await sql<OrchestratorPrefs[]>`
    SELECT orchestrator_enabled, orchestrator_name, orchestrator_custom_instructions
    FROM users WHERE id = ${userId}
  `;
  const row = rows[0];
  return {
    orchestrator_enabled: !!row?.orchestrator_enabled,
    orchestrator_name: row?.orchestrator_name || 'Orchestrator',
    orchestrator_custom_instructions: row?.orchestrator_custom_instructions ?? null,
  };
}

export async function updateOrchestratorState(
  userId: string,
  patch: Partial<OrchestratorPrefs>,
): Promise<OrchestratorPrefs> {
  // Build a single UPDATE — only touch supplied keys.
  const enabled = patch.orchestrator_enabled;
  const name = patch.orchestrator_name;
  const instructions = patch.orchestrator_custom_instructions;
  await sql`
    UPDATE users SET
      orchestrator_enabled = COALESCE(${enabled ?? null}::boolean, orchestrator_enabled),
      orchestrator_name = COALESCE(${name ?? null}::text, orchestrator_name),
      orchestrator_custom_instructions = CASE
        WHEN ${instructions === undefined}::boolean THEN orchestrator_custom_instructions
        ELSE ${instructions ?? null}::text
      END,
      updated_at = now()
    WHERE id = ${userId}
  `;
  return getOrchestratorState(userId);
}

// Find the user's open orchestrator session row (status != 'closed' is
// implemented via deleted_at IS NULL, matching the partial unique index).
export async function findOpenOrchestratorSession(userId: string) {
  const rows = await sql`
    SELECT id, name, project_dir, status, last_activity, created_at,
           cli_kind, is_rootless, hostname, is_orchestrator
    FROM sessions
    WHERE user_id = ${userId}
      AND is_orchestrator = true
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Create a fresh orchestrator session row. Caller has already verified there
// is no existing open one (the partial unique index will also prevent races).
export async function createOrchestratorSession(args: {
  userId: string;
  name: string;
  projectDir: string;
  tokenHash: string;
  hostname: string;
}) {
  const rows = await sql`
    INSERT INTO sessions (
      user_id, name, project_dir, token_hash,
      cli_kind, is_rootless, hostname, is_orchestrator
    ) VALUES (
      ${args.userId}, ${args.name}, ${args.projectDir}, ${args.tokenHash},
      'claude', false, ${args.hostname}, true
    )
    RETURNING id, name, project_dir, status, last_activity, created_at,
              cli_kind, is_rootless, hostname, is_orchestrator
  `;
  return rows[0];
}

// Mint a fresh api_key with purpose='orchestrator'. Revokes any prior active
// orchestrator-purpose key for the same user (per the partial unique index).
// NEVER touches purpose='supervisor' rows.
export async function mintOrchestratorApiKey(
  userId: string,
  keyHash: string,
): Promise<{ id: string }> {
  await sql`
    UPDATE api_keys SET revoked_at = now()
    WHERE user_id = ${userId} AND purpose = 'orchestrator' AND revoked_at IS NULL
  `;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO api_keys (user_id, key_hash, name, purpose, capabilities)
    VALUES (${userId}, ${keyHash}, 'orchestrator', 'orchestrator', ARRAY['agent','supervisor','orchestrator'])
    RETURNING id
  `;
  return rows[0];
}
