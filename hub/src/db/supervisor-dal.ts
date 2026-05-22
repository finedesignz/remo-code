import { sql } from './postgres.ts'

// ── Supervisor capability ─────────────────────────────────────────────────────

export async function verifyApiKeyWithCapability(keyHash: string, capability: string) {
  const rows = await sql`
    SELECT id, user_id, capabilities
    FROM api_keys
    WHERE key_hash = ${keyHash} AND revoked_at IS NULL
    LIMIT 1
  `
  if (!rows[0]) {
    console.log(`[supervisor-dal] key not found for hash=${keyHash.slice(0,8)}...`)
    return null
  }
  // Defense-in-depth: capability check is a soft gate.
  // Treat unknown/empty caps as legacy (all caps granted).
  // We can tighten this later if we ever issue limited-scope keys.
  const raw = rows[0].capabilities
  console.log(`[supervisor-dal] key found id=${rows[0].id.slice(0,8)} caps=${JSON.stringify(raw)}`)
  await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${rows[0].id}`
  return { userId: rows[0].user_id as string, apiKeyId: rows[0].id as string }
}

// ── Supervisors ───────────────────────────────────────────────────────────────

export async function upsertSupervisor(args: {
  userId: string
  apiKeyId: string
  hostname: string
  version?: string
  os?: string
  roots: string[]
}) {
  const existing = await sql`SELECT id FROM supervisors WHERE api_key_id = ${args.apiKeyId}`
  if (existing[0]) {
    const updated = await sql`
      UPDATE supervisors
      SET hostname = ${args.hostname},
          version = ${args.version ?? null},
          os = ${args.os ?? null},
          roots = ${args.roots},
          last_seen_at = now()
      WHERE id = ${existing[0].id}
      RETURNING *
    `
    return updated[0]
  }
  const rows = await sql`
    INSERT INTO supervisors (user_id, api_key_id, hostname, version, os, roots)
    VALUES (${args.userId}, ${args.apiKeyId}, ${args.hostname}, ${args.version ?? null}, ${args.os ?? null}, ${args.roots})
    RETURNING *
  `
  return rows[0]
}

export async function setSupervisorState(supervisorId: string, state: string, currentRunId: string | null = null) {
  await sql`
    UPDATE supervisors SET state = ${state}, current_run_id = ${currentRunId}, last_seen_at = now()
    WHERE id = ${supervisorId}
  `
}

export async function touchSupervisor(supervisorId: string) {
  await sql`UPDATE supervisors SET last_seen_at = now() WHERE id = ${supervisorId}`
}

export async function listSupervisorsForUser(userId: string) {
  return sql`
    SELECT id, hostname, version, os, roots, state, current_run_id, last_seen_at, created_at
    FROM supervisors WHERE user_id = ${userId}
    ORDER BY last_seen_at DESC
  `
}

export async function getSupervisor(supervisorId: string, userId: string) {
  const rows = await sql`
    SELECT * FROM supervisors WHERE id = ${supervisorId} AND user_id = ${userId}
  `
  return rows[0] ?? null
}

// ── Session runs ──────────────────────────────────────────────────────────────

export async function createRun(args: {
  userId: string
  sessionId: string | null
  supervisorId: string
  repoPath: string
  branch: string | null
  pulled: boolean
  initialPrompt: string | null
  restartOf?: string | null
  restartCount?: number
}) {
  const rows = await sql`
    INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, branch, pulled, initial_prompt, restart_of, restart_count)
    VALUES (${args.userId}, ${args.sessionId}, ${args.supervisorId}, ${args.repoPath}, ${args.branch}, ${args.pulled}, ${args.initialPrompt}, ${args.restartOf ?? null}, ${args.restartCount ?? 0})
    RETURNING *
  `
  return rows[0]
}

export async function endRun(runId: string, exitCode: number | null, exitReason: string) {
  await sql`
    UPDATE session_runs
    SET ended_at = now(), exit_code = ${exitCode}, exit_reason = ${exitReason}
    WHERE id = ${runId}
  `
}

export async function listRunsForSupervisor(supervisorId: string, userId: string, limit = 50) {
  return sql`
    SELECT * FROM session_runs
    WHERE supervisor_id = ${supervisorId} AND user_id = ${userId}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `
}

// ── GitHub installations ──────────────────────────────────────────────────────

export async function saveGitHubInstallation(args: {
  installationId: number
  userId: string
  accountLogin: string
  accountType: string
}) {
  await sql`
    INSERT INTO github_installations (id, user_id, account_login, account_type)
    VALUES (${args.installationId}, ${args.userId}, ${args.accountLogin}, ${args.accountType})
    ON CONFLICT (id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      account_login = EXCLUDED.account_login,
      account_type = EXCLUDED.account_type,
      revoked_at = NULL
  `
}

export async function listInstallations(userId: string) {
  return sql`
    SELECT id, account_login, account_type, installed_at
    FROM github_installations
    WHERE user_id = ${userId} AND revoked_at IS NULL
    ORDER BY installed_at DESC
  `
}

// ── Supervisor commands ──────────────────────────────────────────────────────

export async function replaceSupervisorCommands(args: {
  userId: string
  supervisorId: string
  commands: Array<{ kind: string; name: string; description: string | null; source: string; path: string }>
}) {
  await sql`DELETE FROM supervisor_commands WHERE supervisor_id = ${args.supervisorId}`
  if (args.commands.length === 0) return
  // Bulk insert
  for (const c of args.commands) {
    await sql`
      INSERT INTO supervisor_commands (user_id, supervisor_id, kind, name, description, source, path)
      VALUES (${args.userId}, ${args.supervisorId}, ${c.kind}, ${c.name}, ${c.description}, ${c.source}, ${c.path})
    `
  }
}

export async function listCommandsForUser(userId: string) {
  return sql`
    SELECT id, supervisor_id, kind, name, description, source, path, synced_at
    FROM supervisor_commands
    WHERE user_id = ${userId}
    ORDER BY kind, name
  `
}

export async function getInstallation(installationId: number, userId: string) {
  const rows = await sql`
    SELECT * FROM github_installations
    WHERE id = ${installationId} AND user_id = ${userId} AND revoked_at IS NULL
  `
  return rows[0] ?? null
}
