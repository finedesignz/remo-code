import { sql } from "./postgres.ts";
import { buildRepoKey, type GitOriginGithub } from "../lib/repo-key.ts";

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function listSessions(userId: string) {
  return sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at, agent_info,
           cli_kind, is_rootless, hostname, is_orchestrator,
           repo_key, github_owner, github_repo
    FROM sessions WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST
  `;
}

export async function updateSessionAgentInfo(sessionId: string, info: unknown) {
  await sql`UPDATE sessions SET agent_info = ${JSON.stringify(info)}::jsonb WHERE id = ${sessionId}`;
}

export async function getSession(sessionId: string, userId: string) {
  const rows = await sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at,
           cli_kind, is_rootless, hostname, is_orchestrator,
           repo_key, github_owner, github_repo
    FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

// ── Phase 08 plan 004 — pending local repos + dismiss-local ───────────────────

export type PendingPrompt = {
  hostname: string
  project_dir: string
  is_git_repo: boolean
  first_seen_at: string
  last_seen_at: string
}

export async function getPendingPrompts(userId: string): Promise<PendingPrompt[]> {
  const rows = await sql`
    SELECT p.hostname, p.project_dir, p.is_git_repo, p.first_seen_at, p.last_seen_at
    FROM pending_local_repos p
    LEFT JOIN dismissed_local_sessions d
      ON d.user_id = p.user_id
     AND d.hostname = p.hostname
     AND d.project_dir = p.project_dir
    WHERE p.user_id = ${userId} AND d.user_id IS NULL
    ORDER BY p.last_seen_at DESC
  `
  return rows as unknown as PendingPrompt[]
}

export async function dismissLocalSession(
  userId: string,
  hostname: string,
  projectDir: string,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO dismissed_local_sessions (user_id, hostname, project_dir)
      VALUES (${userId}, ${hostname}, ${projectDir})
      ON CONFLICT (user_id, hostname, project_dir) DO NOTHING
    `
    await tx`
      DELETE FROM pending_local_repos
      WHERE user_id = ${userId} AND hostname = ${hostname} AND project_dir = ${projectDir}
    `
  })
}

export async function getSessionById(sessionId: string) {
  const rows = await sql`SELECT * FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL`;
  return rows[0] ?? null;
}

export async function findSessionByProjectDir(userId: string, projectDir: string) {
  const rows = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId} AND project_dir = ${projectDir} AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST LIMIT 1
  `;
  return rows[0] ?? null;
}

// Was there a session for this project_dir that the user disconnected in the
// last `withinSeconds` seconds? Used to reject stale agent reconnects after
// an explicit "Disconnect" click in the UI.
export async function recentlyDisconnectedForProjectDir(
  userId: string,
  projectDir: string,
  withinSeconds: number = 30,
) {
  const rows = await sql`
    SELECT id, deleted_at FROM sessions
    WHERE user_id = ${userId}
      AND project_dir = ${projectDir}
      AND deleted_at IS NOT NULL
      AND deleted_at > now() - (${withinSeconds} || ' seconds')::interval
    ORDER BY deleted_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createSession(
  userId: string,
  name: string,
  projectDir: string | null,
  tokenHash: string,
  cliKind: 'claude' | 'codex' = 'claude',
  isRootless: boolean = false,
  hostname: string | null = null,
) {
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, is_rootless, hostname)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash}, ${cliKind}, ${isRootless}, ${hostname})
    RETURNING *
  `;
  return rows[0];
}

// Find-or-create an ambient (rootless) session for (user, hostname, cli_kind).
// Guaranteed idempotent under concurrent inserts by the partial unique index
// idx_sessions_rootless_unique. The ON CONFLICT DO NOTHING + re-SELECT pattern
// covers the race where two agents authenticate simultaneously.
export async function findOrCreateRootlessSession(
  userId: string,
  hostname: string,
  cliKind: 'claude' | 'codex',
  tokenHashIfCreating: string,
  nameIfCreating: string,
) {
  const existing = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId}
      AND hostname = ${hostname}
      AND cli_kind = ${cliKind}
      AND is_rootless = true
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing[0]) {
    await sql`UPDATE sessions SET token_hash = ${tokenHashIfCreating}, last_activity = now() WHERE id = ${existing[0].id}`;
    return { ...existing[0], token_hash: tokenHashIfCreating, created: false };
  }
  await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, is_rootless, hostname)
    VALUES (${userId}, ${nameIfCreating}, NULL, ${tokenHashIfCreating}, ${cliKind}, true, ${hostname})
    ON CONFLICT DO NOTHING
  `;
  const rows = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId}
      AND hostname = ${hostname}
      AND cli_kind = ${cliKind}
      AND is_rootless = true
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return { ...rows[0], created: true };
}

// Find existing session by project_dir (reuse) or create a new one.
// Returns { ...session, created: boolean }
//
// Atomic upsert via the partial unique index idx_sessions_user_project_unique
// (user_id, project_dir) WHERE deleted_at IS NULL AND is_rootless=false. Two
// concurrent reconnects for the same project_dir converge on ONE row instead
// of racing into duplicates. We use xmax=0 to detect insert-vs-update so we
// can return the `created` flag correctly without a re-SELECT.
export async function findOrCreateAgentSession(
  userId: string,
  projectDir: string,
  tokenHash: string,
  cliKind: 'claude' | 'codex' = 'claude',
) {
  // Derive a human-readable name from the last path segment (only used when
  // the row actually gets inserted; conflicting upserts keep the existing name).
  const name = projectDir.split('/').filter(Boolean).pop() ?? 'session';
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash}, ${cliKind})
    ON CONFLICT (user_id, project_dir)
      WHERE deleted_at IS NULL AND is_rootless = false
      DO UPDATE SET token_hash = EXCLUDED.token_hash, last_activity = now()
    RETURNING *, (xmax = 0) AS created
  `;
  const row = rows[0];
  return { ...row, created: !!row.created };
}

// Phase 08: GitHub-keyed session resolution. Wraps the priority-1/2/3
// algorithm from ARCHITECTURE §4 in a single transaction with `FOR UPDATE`
// locks so that two worktrees of the same GitHub repo authenticating in
// parallel converge on ONE session row.
//
// - No `git` field, or not a git repo, or no GitHub remote → upsert
//   `pending_local_repos` and fall through to legacy `findOrCreateAgentSession`.
// - GitHub remote → check existing repo-keyed row (P1); else upgrade matching
//   legacy row(s) in place and supersede siblings (P2); else insert new
//   repo-keyed row protected by the partial unique index (P3).
//
// Returns the existing session shape plus `created`, `repo_keyed`, and
// `migrated` flags so the WS handler can log the rollout signal.
export type FindOrCreateV2Result = {
  // session row (postgres.js returns plain row objects)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
  id: string
  created: boolean
  repo_keyed: boolean
  migrated?: boolean
}

export type GitIntrospectionInput = {
  is_git_repo: boolean
  is_worktree: boolean
  worktree_parent_path: string | null
  git_remote: string | null
  git_origin_github: GitOriginGithub | null
}

/**
 * Plan 08-003 (T4): tokenHash may be null when the caller is the supervisor
 * inventory path — no runner is attached yet, so we don't have a token to
 * bind. Whenever tokenHash is null we skip overwriting the existing
 * `token_hash` column (preserving whatever a prior runner-bound connect set).
 */
export async function findOrCreateAgentSessionV2(
  userId: string,
  projectDir: string,
  tokenHash: string | null,
  cliKind: 'claude' | 'codex' = 'claude',
  git?: GitIntrospectionInput,
  hostname: string | null = null,
): Promise<FindOrCreateV2Result> {
  // Step 1: no usable github identity → legacy path + pending_local_repos.
  if (!git || !git.is_git_repo || !git.git_origin_github) {
    if (hostname) {
      try {
        await sql`
          INSERT INTO pending_local_repos (user_id, hostname, project_dir, is_git_repo)
          VALUES (${userId}, ${hostname}, ${projectDir}, ${git?.is_git_repo ?? false})
          ON CONFLICT (user_id, hostname, project_dir) DO UPDATE
            SET last_seen_at = now(),
                is_git_repo = EXCLUDED.is_git_repo
        `
      } catch (err: any) {
        console.warn('[session-v2] pending_local_repos upsert failed:', err?.message)
      }
    }
    // Plan 08-003 T4: supervisor-inventory callers pass tokenHash=null and
    // only want pending_local_repos populated — they're not opening a runner.
    // Skip the legacy findOrCreateAgentSession upsert in that case.
    if (tokenHash === null) {
      return {
        id: '',
        user_id: userId,
        name: '',
        project_dir: projectDir,
        token_hash: '',
        cli_kind: cliKind,
        is_rootless: false,
        status: 'offline',
        last_activity: null,
        created_at: new Date(),
        repo_key: null,
        github_owner: null,
        github_repo: null,
        superseded_by: null,
        deleted_at: null,
        created: false,
        repo_keyed: false,
      } as any
    }
    const legacy = await findOrCreateAgentSession(userId, projectDir, tokenHash, cliKind)
    return { ...legacy, repo_keyed: false }
  }

  const repoKey = buildRepoKey(git.git_origin_github)
  const owner = git.git_origin_github.owner.toLowerCase()
  const repo = git.git_origin_github.repo.toLowerCase()
  const candidatePaths = [projectDir, git.worktree_parent_path].filter((p): p is string => !!p)

  return sql.begin(async (tx) => {
    // Priority 1: existing github-keyed row for this user.
    const p1 = await tx`
      SELECT * FROM sessions
      WHERE user_id = ${userId}
        AND repo_key = ${repoKey}
        AND is_rootless = false
        AND deleted_at IS NULL
      FOR UPDATE
    `
    if (p1[0]) {
      const row = p1[0]
      // Plan 08-003 T4: when tokenHash is null (supervisor inventory path)
      // preserve the existing token_hash so a previously-attached runner row
      // keeps its binding. Otherwise overwrite.
      const updated = tokenHash === null
        ? await tx`
            UPDATE sessions
               SET project_dir = ${projectDir},
                   last_activity = now()
             WHERE id = ${row.id}
             RETURNING *
          `
        : await tx`
            UPDATE sessions
               SET token_hash = ${tokenHash},
                   project_dir = ${projectDir},
                   last_activity = now()
             WHERE id = ${row.id}
             RETURNING *
          `
      return { ...updated[0], created: false, repo_keyed: true }
    }

    // Priority 2: legacy rows (repo_key IS NULL) whose project_dir matches
    // the connecting path OR the worktree parent. Pick the most-recently-
    // active as the keeper and supersede the rest.
    let legacyRows: any[] = []
    if (candidatePaths.length > 0) {
      legacyRows = await tx`
        SELECT * FROM sessions
        WHERE user_id = ${userId}
          AND repo_key IS NULL
          AND is_rootless = false
          AND deleted_at IS NULL
          AND project_dir = ANY(${candidatePaths}::text[])
        ORDER BY last_activity DESC NULLS LAST
        FOR UPDATE
      `
    }

    if (legacyRows.length > 0) {
      const keeper = legacyRows[0]
      const updated = tokenHash === null
        ? await tx`
            UPDATE sessions
               SET repo_key = ${repoKey},
                   github_owner = ${owner},
                   github_repo = ${repo},
                   project_dir = ${projectDir},
                   last_activity = now()
             WHERE id = ${keeper.id}
             RETURNING *
          `
        : await tx`
            UPDATE sessions
               SET repo_key = ${repoKey},
                   github_owner = ${owner},
                   github_repo = ${repo},
                   token_hash = ${tokenHash},
                   project_dir = ${projectDir},
                   last_activity = now()
             WHERE id = ${keeper.id}
             RETURNING *
          `
      for (let i = 1; i < legacyRows.length; i++) {
        const other = legacyRows[i]
        await tx`
          UPDATE sessions
             SET superseded_by = ${keeper.id},
                 deleted_at = now()
           WHERE id = ${other.id}
        `
      }
      return { ...updated[0], created: false, repo_keyed: true, migrated: true }
    }

    // Priority 3: brand-new repo-keyed row. ON CONFLICT handles the final-mile
    // race where two transactions both miss P1 but only one wins the INSERT.
    // Plan 08-003 T4: when called from supervisor inventory, tokenHash is null
    // — the sessions.token_hash column is NOT NULL so we insert a synthetic
    // marker. The marker tells `/api/sessions/:id/launch` there is no runner
    // attached yet (status stays 'offline'). When a real runner connects later
    // via /ws/agent → findOrCreateAgentSessionV2, the P1 path overwrites the
    // marker with the runner's real tokenHash. ON CONFLICT in the null-token
    // case preserves the existing token_hash (don't clobber a real runner
    // binding with our marker).
    const PENDING_TOKEN_MARKER = 'pending_supervisor_inventory'
    const insertTokenValue = tokenHash ?? PENDING_TOKEN_MARKER
    const name = `${owner}/${repo}`
    const inserted = tokenHash === null
      ? await tx`
          INSERT INTO sessions (
            user_id, name, project_dir, token_hash, cli_kind,
            repo_key, github_owner, github_repo
          )
          VALUES (
            ${userId}, ${name}, ${projectDir}, ${insertTokenValue}, ${cliKind},
            ${repoKey}, ${owner}, ${repo}
          )
          ON CONFLICT (user_id, repo_key)
            WHERE repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL
            DO UPDATE SET
              project_dir = EXCLUDED.project_dir,
              last_activity = now()
          RETURNING *, (xmax = 0) AS inserted_fresh
        `
      : await tx`
          INSERT INTO sessions (
            user_id, name, project_dir, token_hash, cli_kind,
            repo_key, github_owner, github_repo
          )
          VALUES (
            ${userId}, ${name}, ${projectDir}, ${insertTokenValue}, ${cliKind},
            ${repoKey}, ${owner}, ${repo}
          )
          ON CONFLICT (user_id, repo_key)
            WHERE repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL
            DO UPDATE SET
              token_hash = EXCLUDED.token_hash,
              project_dir = EXCLUDED.project_dir,
              last_activity = now()
          RETURNING *, (xmax = 0) AS inserted_fresh
        `
    const row = inserted[0]
    const created = row?.inserted_fresh === true
    // strip the diagnostic column before returning
    const { inserted_fresh, ...clean } = row
    return { ...clean, created, repo_keyed: true }
  }) as Promise<FindOrCreateV2Result>
}

/**
 * Plan 08-003 (T4): batch-upsert local-only / non-git folders into
 * `pending_local_repos`. Called from the supervisor `supervisor.repo_inventory`
 * handler for every entry without a GitHub origin. Uses a single multi-row
 * INSERT … ON CONFLICT DO UPDATE so a 200-repo inventory hits the DB once.
 */
export async function upsertPendingLocalRepoBatch(
  rows: Array<{ user_id: string; hostname: string; project_dir: string; is_git_repo: boolean }>,
): Promise<number> {
  if (rows.length === 0) return 0
  // postgres.js arg-array form: each row's values are positional.
  const userIds = rows.map((r) => r.user_id)
  const hostnames = rows.map((r) => r.hostname)
  const projectDirs = rows.map((r) => r.project_dir)
  // postgres.js infers boolean[] params with an OID PG refuses to cast back
  // to boolean[]; round-trip through text[] ('t'/'f') instead.
  const isGitTxt = rows.map((r) => (r.is_git_repo ? 't' : 'f'))
  const result = await sql`
    INSERT INTO pending_local_repos (user_id, hostname, project_dir, is_git_repo)
    SELECT
      unnest(${userIds}::uuid[]),
      unnest(${hostnames}::text[]),
      unnest(${projectDirs}::text[]),
      unnest(${isGitTxt}::text[])::boolean
    ON CONFLICT (user_id, hostname, project_dir) DO UPDATE
      SET last_seen_at = now(),
          is_git_repo = EXCLUDED.is_git_repo
  `
  return result.count ?? rows.length
}

// Create a session for a legacy channel/plugin connection
export async function createPluginSession(userId: string, projectDir: string, tokenHash: string) {
  const name = projectDir.split('/').filter(Boolean).pop() ?? 'session';
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash})
    RETURNING *
  `;
  return rows[0];
}

export async function updateSessionStatus(sessionId: string, status: string) {
  await sql`UPDATE sessions SET status = ${status}, last_activity = now() WHERE id = ${sessionId}`;
}

export async function updateSessionToken(sessionId: string, tokenHash: string) {
  await sql`UPDATE sessions SET token_hash = ${tokenHash} WHERE id = ${sessionId}`;
}

export async function deleteSession(sessionId: string, userId: string) {
  // Soft-delete so an agent process trying to reconnect after the user clicked
  // "Disconnect" cannot resurrect the row via findOrCreateAgentSession.
  await sql`UPDATE sessions SET deleted_at = now(), status = 'offline' WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL`;
}

export async function markSessionDisconnected(sessionId: string, userId: string) {
  await sql`UPDATE sessions SET deleted_at = now(), status = 'offline' WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL`;
}

export async function setOfflineStaleAgentSessions() {
  await sql`UPDATE sessions SET status = 'offline' WHERE status = 'online'`;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function listMessages(sessionId: string, userId: string) {
  return sql`
    SELECT m.id, m.session_id, m.role, m.content, m.status, m.created_at
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id = ${sessionId} AND s.user_id = ${userId}
    ORDER BY m.created_at ASC, m.seq ASC
  `;
}

export async function insertMessage(sessionId: string, role: string, content: string) {
  const rows = await sql`
    INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, ${role}, ${content}) RETURNING *
  `;
  return rows[0];
}

// Insert an empty assistant placeholder for incremental streaming. The row is
// created as soon as Claude starts a turn so the response survives a hub
// restart mid-stream.
export async function insertAssistantPlaceholder(sessionId: string) {
  const rows = await sql`
    INSERT INTO messages (session_id, role, content, status)
    VALUES (${sessionId}, 'assistant', '', 'streaming') RETURNING *
  `;
  return rows[0];
}

// Append a delta chunk to a streaming message. Called from a per-session
// throttled flush (~500ms / 1KB) so we don't hammer Postgres on every event.
export async function appendToMessage(messageId: string, delta: string) {
  await sql`
    UPDATE messages SET content = content || ${delta}
    WHERE id = ${messageId} AND status = 'streaming'
  `;
}

// Final overwrite at turn end — ensures the persisted content matches the
// fully assembled text from the agent (covers any deltas dropped during
// throttle flush or network blips) and flips status to 'complete'.
export async function finalizeMessage(messageId: string, content: string) {
  const rows = await sql`
    UPDATE messages SET content = ${content}, status = 'complete'
    WHERE id = ${messageId}
    RETURNING *
  `;
  return rows[0];
}

// Boot-time sweep: any messages still marked 'streaming' must have been left
// over by a previous hub process that died mid-turn. Mark them interrupted so
// the UI can show them with a distinct indicator.
export async function markStreamingMessagesAsInterrupted() {
  await sql`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

export async function verifyApiKey(keyHash: string) {
  const rows = await sql`
    SELECT user_id FROM api_keys WHERE key_hash = ${keyHash} AND revoked_at IS NULL LIMIT 1
  `;
  if (!rows[0]) return null;
  await sql`UPDATE api_keys SET last_used_at = now() WHERE key_hash = ${keyHash} AND revoked_at IS NULL`;
  return rows[0].user_id as string;
}

export async function listApiKeys(userId: string) {
  return sql`
    SELECT id, name, created_at, last_used_at FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY created_at DESC
  `;
}

export async function createApiKey(userId: string, keyHash: string, name: string) {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  const rows = await sql`
    INSERT INTO api_keys (user_id, key_hash, name) VALUES (${userId}, ${keyHash}, ${name}) RETURNING *
  `;
  return rows[0];
}

export async function revokeApiKey(userId: string) {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

// Phase 07-G: admin force-reissue. Revokes ALL active api_keys + deletes ALL
// auth_sessions for the target user. Returns counts.
export async function revokeAllUserCredentials(userId: string): Promise<{ revoked_api_keys: number; revoked_sessions: number }> {
  const keyRows = await sql`
    UPDATE api_keys SET revoked_at = now()
    WHERE user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  const sessionRows = await sql`
    DELETE FROM auth_sessions WHERE user_id = ${userId} RETURNING id
  `;
  return { revoked_api_keys: keyRows.length, revoked_sessions: sessionRows.length };
}

// ── Users / Profiles ──────────────────────────────────────────────────────────

export async function getUserById(id: string) {
  const rows = await sql`SELECT id, email, display_name, avatar_url, role, system_prompt, timezone, daily_cost_cap_usd, web_push_enabled, claude_session_threshold_pct, claude_week_threshold_pct, created_at, updated_at FROM users WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function getUserTimezone(id: string): Promise<string> {
  const rows = await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id = ${id}`;
  return rows[0]?.timezone || 'UTC';
}

export async function getUserSystemPrompt(id: string): Promise<string | null> {
  const rows = await sql`SELECT system_prompt FROM users WHERE id = ${id}`;
  return (rows[0]?.system_prompt as string | null) ?? null;
}

// ── Claude usage thresholds ──────────────────────────────────────────────────
export interface ClaudeThresholds {
  claude_session_threshold_pct: number | null;
  claude_week_threshold_pct: number | null;
}

export async function getUserClaudeThresholds(userId: string): Promise<ClaudeThresholds> {
  const rows = await sql<ClaudeThresholds[]>`
    SELECT claude_session_threshold_pct, claude_week_threshold_pct
    FROM users WHERE id = ${userId}
  `;
  const row = rows[0];
  return {
    claude_session_threshold_pct: row?.claude_session_threshold_pct ?? null,
    claude_week_threshold_pct: row?.claude_week_threshold_pct ?? null,
  };
}

export async function setUserClaudeThresholds(
  userId: string,
  thresholds: ClaudeThresholds,
): Promise<ClaudeThresholds> {
  const rows = await sql<ClaudeThresholds[]>`
    UPDATE users
       SET claude_session_threshold_pct = ${thresholds.claude_session_threshold_pct},
           claude_week_threshold_pct = ${thresholds.claude_week_threshold_pct},
           updated_at = now()
     WHERE id = ${userId}
     RETURNING claude_session_threshold_pct, claude_week_threshold_pct
  `;
  return rows[0] ?? thresholds;
}

export type UserInstructions = {
  claude_global_md: string | null;
  codex_agents_md: string | null;
  codex_config_toml: string | null;
};

export async function getUserInstructions(userId: string): Promise<UserInstructions> {
  const rows = await sql<UserInstructions[]>`
    SELECT claude_global_md, codex_agents_md, codex_config_toml
    FROM users WHERE id = ${userId}
  `;
  const r = rows[0];
  return {
    claude_global_md: r?.claude_global_md ?? null,
    codex_agents_md: r?.codex_agents_md ?? null,
    codex_config_toml: r?.codex_config_toml ?? null,
  };
}

export async function updateUserInstructions(
  userId: string,
  patch: Partial<UserInstructions>,
): Promise<UserInstructions> {
  // Dynamic SET clause — only update keys present in patch
  const keys = Object.keys(patch) as Array<keyof UserInstructions>;
  if (keys.length === 0) return getUserInstructions(userId);

  // postgres.js does not support arbitrary identifier interpolation,
  // so we branch by key set. Three columns => 7 combinations.
  // Use a sequence of single-column updates inside a transaction-ish bundle.
  for (const key of keys) {
    const val = patch[key] ?? null;
    if (key === 'claude_global_md') {
      await sql`UPDATE users SET claude_global_md = ${val}, updated_at = now() WHERE id = ${userId}`;
    } else if (key === 'codex_agents_md') {
      await sql`UPDATE users SET codex_agents_md = ${val}, updated_at = now() WHERE id = ${userId}`;
    } else if (key === 'codex_config_toml') {
      await sql`UPDATE users SET codex_config_toml = ${val}, updated_at = now() WHERE id = ${userId}`;
    }
  }
  return getUserInstructions(userId);
}

export async function rotateUserCoolifyWebhookSecret(userId: string): Promise<string> {
  // Rotating also clears the legacy-hit flag: the user is moving to URL-token
  // auth, so the deprecation banner should disappear on next status fetch.
  const rows = await sql<{ coolify_webhook_secret: string }[]>`
    UPDATE users
       SET coolify_webhook_secret = gen_random_uuid()::text,
           coolify_webhook_legacy_hit_at = NULL,
           updated_at = now()
     WHERE id = ${userId}
     RETURNING coolify_webhook_secret
  `;
  const secret = rows[0]?.coolify_webhook_secret;
  if (!secret) throw new Error('rotate_failed: user not found');
  return secret;
}

export async function getUserCoolifyWebhookStatus(
  userId: string,
): Promise<{ configured: boolean; legacy_in_use: boolean; legacy_hit_at: string | null }> {
  const rows = await sql<{
    configured: boolean;
    legacy_hit_at: string | null;
  }[]>`
    SELECT
      (coolify_webhook_secret IS NOT NULL) AS configured,
      coolify_webhook_legacy_hit_at AS legacy_hit_at
      FROM users
     WHERE id = ${userId}
  `;
  const row = rows[0];
  const hitAt = row?.legacy_hit_at ?? null;
  return {
    configured: !!row?.configured,
    legacy_in_use: hitAt != null,
    legacy_hit_at: hitAt ? new Date(hitAt).toISOString() : null,
  };
}

/**
 * Set/refresh the legacy-HMAC-route-hit marker on the user row. Idempotent —
 * each successful hit just bumps the timestamp. Cleared by
 * `rotateUserCoolifyWebhookSecret`.
 */
export async function markUserCoolifyWebhookLegacyHit(userId: string): Promise<void> {
  await sql`
    UPDATE users
       SET coolify_webhook_legacy_hit_at = now()
     WHERE id = ${userId}
  `;
}

// ── Coolify webhook ingress (Phase 06 / plan 004) ─────────────────────────────

/**
 * Read the user's HMAC secret for verifying inbound Coolify webhook payloads.
 * Returns null when the user has never rotated/generated one (plan 005 rotate
 * endpoint sets it via gen_random_uuid()). Distinct from
 * `getUserCoolifyWebhookStatus` which only exposes presence to the owning user.
 */
export async function getUserCoolifyWebhookSecret(userId: string): Promise<string | null> {
  const rows = await sql<{ coolify_webhook_secret: string | null }[]>`
    SELECT coolify_webhook_secret FROM users WHERE id = ${userId}
  `;
  return rows[0]?.coolify_webhook_secret ?? null;
}

/**
 * fix/coolify-webhook-url-token (Part 3): unified per-user webhook config.
 * Returns secret + parsed allowlist in a single round-trip. Allowlist is
 * NULL or empty CSV → returned as []. Parse errors on stored data → [].
 */
export async function getUserCoolifyWebhookConfig(
  userId: string,
): Promise<{ secret: string | null; allowedIps: string[] }> {
  const rows = await sql<{ coolify_webhook_secret: string | null; coolify_webhook_allowed_ips: string | null }[]>`
    SELECT coolify_webhook_secret, coolify_webhook_allowed_ips
      FROM users WHERE id = ${userId}
  `;
  if (!rows[0]) return { secret: null, allowedIps: [] };
  const csv = rows[0].coolify_webhook_allowed_ips;
  let allowedIps: string[] = [];
  if (csv && csv.trim()) {
    // Defensive: stored data is already validated on write, but parse safely.
    try {
      const { parseAllowlist } = await import('../lib/cidr.ts');
      allowedIps = parseAllowlist(csv);
    } catch {
      allowedIps = [];
    }
  }
  return { secret: rows[0].coolify_webhook_secret, allowedIps };
}

export async function getUserCoolifyWebhookAllowedIps(userId: string): Promise<string> {
  const rows = await sql<{ coolify_webhook_allowed_ips: string | null }[]>`
    SELECT coolify_webhook_allowed_ips FROM users WHERE id = ${userId}
  `;
  return rows[0]?.coolify_webhook_allowed_ips ?? '';
}

/**
 * Validates + persists the allowlist. Empty string clears the column (NULL).
 * Throws Error('invalid_cidr_entry: <entry>') on any bad input.
 * Returns the cleaned CSV that was actually saved.
 */
export async function setUserCoolifyWebhookAllowedIps(
  userId: string,
  raw: string,
): Promise<string> {
  const { parseAllowlist } = await import('../lib/cidr.ts');
  const entries = raw && raw.trim() ? parseAllowlist(raw) : [];
  const csv = entries.length ? entries.join(',') : null;
  await sql`UPDATE users SET coolify_webhook_allowed_ips = ${csv}, updated_at = now() WHERE id = ${userId}`;
  return csv ?? '';
}

// ── fix/coolify-webhook-url-token (Part 2): webhook attempt audit log ────────

export type CoolifyAttemptStatus =
  | 'success'
  | 'auth_failed'
  | 'ip_rejected'
  | 'bad_payload'
  | 'rate_limited'
  | 'legacy_hmac';

export interface CoolifyAttemptInput {
  user_id: string;
  source_ip: string | null;
  event_type: string | null;
  status: CoolifyAttemptStatus;
  reason: string | null;
  raw_body_preview: string | null;
}

export interface CoolifyAttemptRow {
  id: string;
  received_at: string;
  source_ip: string | null;
  event_type: string | null;
  status: string;
  reason: string | null;
}

/**
 * Insert one attempt row, then trim the user's history back to the 100 most
 * recent rows. Both ops run independently; failure of the trim never
 * blocks the insert response.
 */
export async function recordCoolifyWebhookAttempt(input: CoolifyAttemptInput): Promise<void> {
  const preview = input.raw_body_preview ? input.raw_body_preview.slice(0, 500) : null;
  await sql`
    INSERT INTO coolify_webhook_attempts
      (user_id, source_ip, event_type, status, reason, raw_body_preview)
    VALUES
      (${input.user_id}, ${input.source_ip}, ${input.event_type}, ${input.status}, ${input.reason}, ${preview})
  `;
  // Trim — keep last 100.
  try {
    await sql`
      DELETE FROM coolify_webhook_attempts
       WHERE user_id = ${input.user_id}
         AND id IN (
           SELECT id FROM coolify_webhook_attempts
            WHERE user_id = ${input.user_id}
            ORDER BY received_at DESC
            OFFSET 100
         )
    `;
  } catch (err: any) {
    console.warn('[coolify-webhook] attempts trim failed:', err?.message);
  }
}

export async function listCoolifyWebhookAttempts(userId: string, limit: number): Promise<CoolifyAttemptRow[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await sql<CoolifyAttemptRow[]>`
    SELECT id, received_at, source_ip, event_type, status, reason
      FROM coolify_webhook_attempts
     WHERE user_id = ${userId}
     ORDER BY received_at DESC
     LIMIT ${safeLimit}
  `;
  return rows;
}

/**
 * Lazily find-or-create the per-user internal scheduled_tasks anchor used for
 * deployment-event runs. `scheduled_task_runs.task_id` is NOT NULL, so every
 * webhook-derived run needs a parent task. We allocate exactly one of these
 * per user, matched by name marker. enabled=false keeps croner from ever
 * scheduling it. session_id is NULL (column was made nullable in schema.sql
 * line 187).
 */
const INTERNAL_DEPLOY_TASK_NAME = '__internal_coolify_deployment';
const INTERNAL_TRIAGE_TASK_NAME = '__internal_triage';

/**
 * Phase 06 plan 008 — lazy per-user internal triage task. task_type='triage'
 * so dispatcher.fireTask routes through senders/triage.ts; enabled=false so
 * cron never auto-fires it.
 */
export async function ensureInternalTriageTask(userId: string): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM scheduled_tasks
    WHERE user_id = ${userId} AND name = ${INTERNAL_TRIAGE_TASK_NAME}
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;
  const NEVER = '0 0 31 2 *';
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_tasks (
      user_id, session_id, name, cron_expression, prompt,
      enabled, task_type, target_kind, payload, cron_expr, timezone
    ) VALUES (
      ${userId}, NULL, ${INTERNAL_TRIAGE_TASK_NAME}, ${NEVER}, '',
      false, 'triage', 'session', '{}'::jsonb, ${NEVER}, 'UTC'
    )
    RETURNING id
  `;
  return rows[0].id;
}

export async function ensureInternalDeploymentTask(userId: string): Promise<string> {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM scheduled_tasks
    WHERE user_id = ${userId} AND name = ${INTERNAL_DEPLOY_TASK_NAME}
    LIMIT 1
  `;
  if (existing[0]) return existing[0].id;
  // cron_expression / cron_expr are required NOT NULL — use a never-firing
  // pattern (Feb 31 doesn't exist).
  const NEVER = '0 0 31 2 *';
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_tasks (
      user_id, session_id, name, cron_expression, prompt,
      enabled, task_type, target_kind, payload, cron_expr, timezone
    ) VALUES (
      ${userId}, NULL, ${INTERNAL_DEPLOY_TASK_NAME}, ${NEVER}, '',
      false, 'log_check', 'session', '{}'::jsonb, ${NEVER}, 'UTC'
    )
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * Insert a scheduled_task_runs row that carries Coolify deployment metadata.
 * pending → triage will pick this up (plan 008 wire-up).
 * success → metadata-only marker for deployment.succeeded / in_progress.
 */
export async function insertDeploymentRun(input: {
  task_id: string;
  user_id: string;
  status: 'pending' | 'success';
  deployment_uuid: string;
  application_uuid: string;
  git_repository: string | null;
  commit_sha: string | null;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_task_runs (
      task_id, user_id, session_id, status, target_kind, target_id,
      deployment_uuid, application_uuid, git_repository, commit_sha,
      started_at, finished_at, completed_at
    ) VALUES (
      ${input.task_id}, ${input.user_id}, NULL, ${input.status}, NULL, NULL,
      ${input.deployment_uuid}, ${input.application_uuid}, ${input.git_repository}, ${input.commit_sha},
      ${sql`now()`},
      ${input.status === 'success' ? sql`now()` : null},
      ${input.status === 'success' ? sql`now()` : null}
    )
    RETURNING id
  `;
  return rows[0];
}

export async function getUserByEmail(email: string) {
  const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
  return rows[0] ?? null;
}

export async function countUsers() {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  return rows[0].count as number;
}

export async function createUser(email: string, passwordHash: string, role: string = 'user') {
  const rows = await sql`
    INSERT INTO users (email, password_hash, role) VALUES (${email}, ${passwordHash}, ${role}) RETURNING id, email, display_name, role, created_at
  `;
  return rows[0];
}

export async function updateProfile(userId: string, fields: { display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string }) {
  // Build a partial update — only touch the columns provided.
  const sets: any[] = [];
  if (fields.display_name !== undefined) sets.push(sql`display_name = ${fields.display_name}`);
  if (fields.avatar_url !== undefined) sets.push(sql`avatar_url = ${fields.avatar_url}`);
  if (fields.system_prompt !== undefined) sets.push(sql`system_prompt = ${fields.system_prompt}`);
  if (fields.timezone !== undefined) sets.push(sql`timezone = ${fields.timezone}`);
  if (sets.length === 0) return getUserById(userId);
  sets.push(sql`updated_at = now()`);
  let q = sql`UPDATE users SET `;
  for (let i = 0; i < sets.length; i++) {
    q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`;
  }
  await sql`${q} WHERE id = ${userId}`;
  return getUserById(userId);
}

// ── GitHub-issue post-run idempotency (Phase 06 plan 007) ────────────────────
//
// Backed by `github_issue_idempotency` (see schema.sql). Skips duplicate
// issue creation for the same (repo, application_uuid, deployment_uuid)
// within `windowHours`.

export async function hasOpenIssueForHash(
  userId: string,
  hash: string,
  windowHours: number,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM github_issue_idempotency
    WHERE user_id = ${userId}
      AND hash = ${hash}
      AND created_at > now() - (${String(windowHours)} || ' hours')::interval
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function recordOpenIssueForHash(
  userId: string,
  hash: string,
  issueNumber: number,
  repoFullName: string,
): Promise<void> {
  await sql`
    INSERT INTO github_issue_idempotency (user_id, hash, repo_full_name, issue_number)
    VALUES (${userId}, ${hash}, ${repoFullName}, ${issueNumber})
    ON CONFLICT (user_id, hash) DO NOTHING
  `;
}

// Placeholder write BEFORE the octokit.issues.create call narrows the race
// window: two concurrent failure webhooks for the same (repo, app, deploy)
// can't both win the gate. Returns true if WE claimed the row (other caller
// loses); false if someone else already had a row. Issue_number 0 is a
// sentinel that updateOpenIssuePlaceholder overwrites on success or
// deleteOpenIssuePlaceholder removes on terminal failure.
export async function placeOpenIssuePlaceholder(
  userId: string,
  hash: string,
  repoFullName: string,
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO github_issue_idempotency (user_id, hash, repo_full_name, issue_number)
    VALUES (${userId}, ${hash}, ${repoFullName}, 0)
    ON CONFLICT (user_id, hash) DO NOTHING
    RETURNING user_id
  `;
  return rows.length > 0;
}

export async function updateOpenIssuePlaceholder(
  userId: string,
  hash: string,
  issueNumber: number,
): Promise<void> {
  await sql`
    UPDATE github_issue_idempotency
    SET issue_number = ${issueNumber}
    WHERE user_id = ${userId} AND hash = ${hash}
  `;
}

export async function deleteOpenIssuePlaceholder(
  userId: string,
  hash: string,
): Promise<void> {
  await sql`
    DELETE FROM github_issue_idempotency
    WHERE user_id = ${userId} AND hash = ${hash} AND issue_number = 0
  `;
}

// ── Phase 07: Titanium auth (additive) ────────────────────────────────────────
//
// Helpers for linking remo-code `users` rows to Titanium Licensing (Keygen)
// subjects, recording opaque server-side auth sessions, and writing the
// `auth_events` audit log. The `link_mismatch` event type folds in what an
// earlier draft called `mapping_conflicts` — search
// `WHERE event_type='link_mismatch'` for those rows.
//
// `auth_sessions` is the server-side session-id store (NOT the Claude
// conversation `sessions` table). IDs in `auth_sessions` are stored as
// sha-256 hashes of the opaque random token — same pattern as `api_keys`.
// Callers handle the hashing (so the raw token never reaches the DAL).

import { randomBytes, createHash } from 'crypto';

export type AuthSessionRow = {
  id: string;
  user_id: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
};

export async function getUserByTitaniumSubject(subject: string) {
  const rows = await sql`
    SELECT * FROM users WHERE titanium_subject = ${subject} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function linkTitaniumSubject(
  userId: string,
  subject: string,
  email: string,
): Promise<void> {
  await sql`
    UPDATE users
       SET titanium_subject = ${subject},
           titanium_email = ${email},
           last_titanium_sync_at = now(),
           titanium_link_status = 'linked',
           candidate_subject = NULL,
           updated_at = now()
     WHERE id = ${userId}
  `;
}

export async function setPendingVerify(
  userId: string,
  candidateSubject: string,
  candidateEmail: string,
): Promise<void> {
  await sql`
    UPDATE users
       SET candidate_subject = ${candidateSubject},
           titanium_email = ${candidateEmail},
           titanium_link_status = 'pending_verify',
           updated_at = now()
     WHERE id = ${userId}
  `;
}

// Promote candidate_subject → titanium_subject. Only acts when the user is
// currently in pending_verify state; returns true if promotion happened.
export async function promoteCandidateSubject(userId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE users
       SET titanium_subject = candidate_subject,
           titanium_link_status = 'linked',
           candidate_subject = NULL,
           last_titanium_sync_at = now(),
           updated_at = now()
     WHERE id = ${userId}
       AND titanium_link_status = 'pending_verify'
       AND candidate_subject IS NOT NULL
     RETURNING id
  `;
  return rows.length > 0;
}

export type UserLicenseFields = {
  license_status: string | null;
  license_id: string | null;
  license_checked_at: Date | null;
  titanium_subject: string | null;
};

export async function getUserLicenseFields(
  userId: string,
): Promise<UserLicenseFields | null> {
  const rows = await sql<UserLicenseFields[]>`
    SELECT license_status, license_id, license_checked_at, titanium_subject
      FROM users
     WHERE id = ${userId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateLicenseStatus(
  userId: string,
  status: string,
  licenseId: string | null,
): Promise<void> {
  await sql`
    UPDATE users
       SET license_status = ${status},
           license_id = ${licenseId},
           license_checked_at = now(),
           updated_at = now()
     WHERE id = ${userId}
  `;
}

// Returns { updated: true } on success, { updated: false, conflict: true }
// when a different user already owns the target email (UNIQUE violation 23505).
export async function updateUserEmail(
  userId: string,
  newEmail: string,
): Promise<{ updated: boolean; conflict: boolean }> {
  try {
    const rows = await sql`
      UPDATE users SET email = ${newEmail}, updated_at = now()
       WHERE id = ${userId}
       RETURNING id
    `;
    return { updated: rows.length > 0, conflict: false };
  } catch (err: any) {
    if (err?.code === '23505') return { updated: false, conflict: true };
    throw err;
  }
}

// ── Auth sessions (opaque token, sha-256 stored — same pattern as api_keys) ──

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createAuthSession(opts: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  ttlSeconds: number;
}): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = 'remo_' + randomBytes(32).toString('base64url');
  const id = hashSessionToken(token);
  const ttl = Math.max(1, Math.floor(opts.ttlSeconds));
  const rows = await sql<{ expires_at: Date }[]>`
    INSERT INTO auth_sessions (id, user_id, expires_at, ip, user_agent)
    VALUES (${id}, ${opts.userId}, now() + (${String(ttl)} || ' seconds')::interval, ${opts.ip ?? null}, ${opts.userAgent ?? null})
    RETURNING expires_at
  `;
  return { token, id, expiresAt: rows[0].expires_at };
}

// Look up a session by its raw token. Returns null if missing OR expired.
export async function getAuthSessionByToken(token: string): Promise<AuthSessionRow | null> {
  const id = hashSessionToken(token);
  const rows = await sql<AuthSessionRow[]>`
    SELECT * FROM auth_sessions
     WHERE id = ${id} AND expires_at > now()
     LIMIT 1
  `;
  return rows[0] ?? null;
}

// Bump last_used_at. expires_at is NOT advanced here — PLAN-C governs idle
// extension policy.
export async function touchAuthSession(token: string): Promise<void> {
  const id = hashSessionToken(token);
  await sql`UPDATE auth_sessions SET last_used_at = now() WHERE id = ${id}`;
}

export async function deleteAuthSession(token: string): Promise<void> {
  const id = hashSessionToken(token);
  await sql`DELETE FROM auth_sessions WHERE id = ${id}`;
}

// Returns the number of rows deleted. Safe to call from a periodic cron.
export async function purgeExpiredAuthSessions(): Promise<number> {
  const rows = await sql`DELETE FROM auth_sessions WHERE expires_at <= now() RETURNING id`;
  return rows.length;
}

// ── Phase 12.1: mobile auth handoff tokens (one-time, single-use, 60s TTL) ──

const HANDOFF_TTL_SECONDS = 60;

export async function createAuthHandoffToken(
  userId: string,
  opts: { purpose?: string; ttlSeconds?: number } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = 'mh_' + randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const ttl = Math.max(1, Math.floor(opts.ttlSeconds ?? HANDOFF_TTL_SECONDS));
  const purpose = opts.purpose ?? 'mobile_handoff';
  const rows = await sql<{ expires_at: Date }[]>`
    INSERT INTO auth_handoff_tokens (user_id, token_hash, purpose, expires_at)
    VALUES (${userId}, ${tokenHash}, ${purpose}, now() + (${String(ttl)} || ' seconds')::interval)
    RETURNING expires_at
  `;
  return { token, expiresAt: rows[0].expires_at };
}

// Atomic single-use claim. Returns { userId } when the token existed, was
// unexpired, and was unconsumed; returns null otherwise. The UPDATE …
// RETURNING with `consumed_at IS NULL` guarantees that a second concurrent
// caller cannot also succeed.
export async function consumeAuthHandoffToken(
  token: string,
): Promise<{ userId: string; purpose: string } | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await sql<{ user_id: string; purpose: string }[]>`
    UPDATE auth_handoff_tokens
       SET consumed_at = now()
     WHERE token_hash = ${tokenHash}
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING user_id, purpose
  `;
  if (rows.length === 0) return null;
  return { userId: rows[0].user_id, purpose: rows[0].purpose };
}

// ── Audit log ────────────────────────────────────────────────────────────────

export async function recordAuthEvent(opts: {
  userId?: string | null;
  eventType: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await sql`
    INSERT INTO auth_events (user_id, event_type, ip, user_agent, metadata)
    VALUES (
      ${opts.userId ?? null},
      ${opts.eventType},
      ${opts.ip ?? null},
      ${opts.userAgent ?? null},
      ${opts.metadata ? JSON.stringify(opts.metadata) : null}::jsonb
    )
  `;
}

