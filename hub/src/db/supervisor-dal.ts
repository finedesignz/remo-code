import { sql } from './postgres.ts'

// ── Supervisor capability ─────────────────────────────────────────────────────

export type VerifyApiKeyResult =
  | { ok: true; userId: string; apiKeyId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'revoked' }
  | { ok: false; reason: 'deleted' }
  | { ok: false; reason: 'missing_capability'; have: string[]; need: string }

/**
 * Disambiguated supervisor api-key verification.
 *
 * Returns a discriminated union so callers can log + send a precise reason
 * rather than a generic "auth failed". The legacy single-query (revoked_at IS
 * NULL) collapsed three distinct failure modes (not_found / revoked / missing
 * capability) into one null — making prod auth bugs un-diagnosable.
 *
 * Note: the `api_keys` table does not currently have a `deleted_at` column.
 * The `deleted` reason is reserved in the union for forward compatibility (the
 * column may be added when soft-delete is introduced); for now it is never
 * returned at runtime.
 */
export async function verifyApiKeyWithCapability(
  keyHash: string,
  capability: string,
): Promise<VerifyApiKeyResult> {
  const rows = await sql`
    SELECT id, user_id, capabilities, revoked_at
    FROM api_keys
    WHERE key_hash = ${keyHash}
    LIMIT 1
  `
  if (!rows[0]) {
    console.log(`[supervisor-dal] key not_found hash=${keyHash.slice(0,8)}...`)
    return { ok: false, reason: 'not_found' }
  }
  const row = rows[0]
  if (row.revoked_at) {
    console.log(`[supervisor-dal] key revoked id=${row.id.slice(0,8)} revoked_at=${row.revoked_at}`)
    return { ok: false, reason: 'revoked' }
  }
  const caps: string[] = Array.isArray(row.capabilities) ? row.capabilities : []
  // Empty/null caps = legacy keys, treated as all-caps. Non-empty caps must
  // contain the requested capability.
  if (caps.length > 0 && !caps.includes(capability)) {
    console.log(`[supervisor-dal] key missing_capability id=${row.id.slice(0,8)} have=${JSON.stringify(caps)} need=${capability}`)
    return { ok: false, reason: 'missing_capability', have: caps, need: capability }
  }
  console.log(`[supervisor-dal] key ok id=${row.id.slice(0,8)} caps=${JSON.stringify(caps)}`)
  await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`
  return { ok: true, userId: row.user_id as string, apiKeyId: row.id as string }
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

// ── Phase 04 plan 002: persist host_resources budget snapshot ─────────────────
// Caller MUST pass the WS-authenticated supervisorId — never trust a payload id.
export async function updateSupervisorResources(args: {
  supervisorId: string
  cpuCores: number
  totalMemMb: number
  freeMemMb: number
  concurrencyBudget: number
  budgetSource: 'cgroup_v2' | 'cgroup_v1' | 'host_fallback'
}) {
  const rows = await sql`
    UPDATE supervisors
    SET cpu_cores = ${args.cpuCores},
        total_mem_mb = ${args.totalMemMb},
        free_mem_mb = ${args.freeMemMb},
        concurrency_budget = ${args.concurrencyBudget},
        budget_source = ${args.budgetSource},
        budget_updated_at = now(),
        last_seen_at = now()
    WHERE id = ${args.supervisorId}
    RETURNING id, cpu_cores, total_mem_mb, free_mem_mb,
              concurrency_budget, concurrency_override, budget_source, budget_updated_at
  `
  return rows[0] ?? null
}

// PATCH /api/supervisors/:id/override — hub callers must clamp the value
// to [1, concurrency_budget * 2] BEFORE calling this. Passing null clears.
export async function setSupervisorOverride(args: {
  supervisorId: string
  userId: string
  override: number | null
}) {
  const rows = await sql`
    UPDATE supervisors
    SET concurrency_override = ${args.override}
    WHERE id = ${args.supervisorId} AND user_id = ${args.userId}
    RETURNING id, cpu_cores, total_mem_mb, free_mem_mb,
              concurrency_budget, concurrency_override, budget_source, budget_updated_at
  `
  return rows[0] ?? null
}

// PATCH /api/users/me/preferred-supervisor — caller MUST have already verified
// the supervisor (when non-null) belongs to userId. Passing null clears it.
export async function setPreferredSupervisor(args: {
  userId: string
  supervisorId: string | null
}) {
  const rows = await sql`
    UPDATE users
    SET preferred_supervisor_id = ${args.supervisorId},
        updated_at = now()
    WHERE id = ${args.userId}
    RETURNING id, preferred_supervisor_id
  `
  return rows[0] ?? null
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

// Phase 12 W2 — update supervisor roots from the web UI. Caller MUST have
// already verified ownership via getSupervisor(). Returns the updated row or
// null if the supervisor disappeared mid-request.
export async function setSupervisorRoots(args: {
  supervisorId: string
  userId: string
  roots: string[]
}) {
  const rows = await sql`
    UPDATE supervisors
    SET roots = ${args.roots}::text[],
        last_seen_at = now()
    WHERE id = ${args.supervisorId} AND user_id = ${args.userId}
    RETURNING id, user_id, hostname, version, os, roots, state, last_seen_at
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

/**
 * Bundle 3 — zombie-run cleanup. When a supervisor's WebSocket closes, any
 * `session_runs` rows it left open (`ended_at IS NULL`) are unreachable: the
 * runner is gone, no `runner.exit` will ever land. Mark them ended with
 * exit_reason='socket_close' so the UI/scheduler stop treating them as live.
 */
export async function finalizeOpenRunsForSupervisor(supervisorId: string) {
  await sql`
    UPDATE session_runs
    SET ended_at = now(), exit_reason = 'socket_close'
    WHERE supervisor_id = ${supervisorId} AND ended_at IS NULL
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

// ── Paused repos ─────────────────────────────────────────────────────────────
// Pause flag is set on user "Disconnect" so the supervisor never auto-spawns
// (or restart-on-crash respawns) an agent for that repo until the user
// explicitly clicks "Start" again.

export async function addPausedRepo(args: {
  userId: string
  supervisorId: string
  repoPath: string
  reason?: string | null
}) {
  await sql`
    INSERT INTO paused_repos (user_id, supervisor_id, repo_path, paused_reason)
    VALUES (${args.userId}, ${args.supervisorId}, ${args.repoPath}, ${args.reason ?? null})
    ON CONFLICT (user_id, supervisor_id, repo_path)
    DO UPDATE SET paused_at = now(), paused_reason = EXCLUDED.paused_reason
  `
}

export async function removePausedRepo(args: {
  userId: string
  supervisorId: string
  repoPath: string
}) {
  await sql`
    DELETE FROM paused_repos
    WHERE user_id = ${args.userId} AND supervisor_id = ${args.supervisorId} AND repo_path = ${args.repoPath}
  `
}

export async function listPausedRepos(supervisorId: string): Promise<string[]> {
  const rows = await sql`
    SELECT repo_path FROM paused_repos WHERE supervisor_id = ${supervisorId}
  `
  return rows.map((r: any) => r.repo_path as string)
}

export async function isRepoPaused(supervisorId: string, repoPath: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM paused_repos
    WHERE supervisor_id = ${supervisorId} AND repo_path = ${repoPath} LIMIT 1
  `
  return rows.length > 0
}

// Find the supervisor (for a given user) whose roots contain the given repo
// path. Used by sessions.delete to find which supervisor manages a repo.
export async function findSupervisorForRepoPath(userId: string, repoPath: string) {
  // roots is a TEXT[] of parent directories; a repo "belongs" to a supervisor
  // if any root is a prefix of repo_path.
  const rows = await sql`
    SELECT id, roots FROM supervisors WHERE user_id = ${userId}
  `
  for (const r of rows as any[]) {
    const roots = (r.roots || []) as string[]
    for (const root of roots) {
      if (!root) continue
      const norm = root.replace(/[\/\\]+$/, '')
      if (repoPath === norm) continue // root itself, not a repo
      if (repoPath.startsWith(norm + '/') || repoPath.startsWith(norm + '\\')) {
        return r.id as string
      }
    }
  }
  return null
}

export async function getInstallation(installationId: number, userId: string) {
  const rows = await sql`
    SELECT * FROM github_installations
    WHERE id = ${installationId} AND user_id = ${userId} AND revoked_at IS NULL
  `
  return rows[0] ?? null
}
