import { sql } from "./postgres.ts";
import { buildRepoKey, type GitOriginGithub } from "../lib/repo-key.ts";
import { log } from "../observability/logger.ts";

// ── Sessions ──────────────────────────────────────────────────────────────────

// auto-dev P5: candidate session IDs bound to a given `repo_key` for a user,
// used by the repo-keyed deploy-failure resolver to land a triage fix in the
// session actually bound to the failing repo (not a capacity-picked stranger).
// Most-recently-active first; the caller intersects with online agent channels.
export async function listSessionIdsForRepoKey(
  userId: string,
  repoKey: string,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sessions
    WHERE user_id = ${userId}
      AND repo_key = ${repoKey}
      AND is_rootless = false
      AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST
  `;
  return rows.map((r) => r.id);
}

export async function listSessions(userId: string) {
  return sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at, agent_info,
           cli_kind, is_rootless, hostname, is_orchestrator,
           repo_key, github_owner, github_repo, auto_nudge,
           dangerously_skip_permissions
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
           repo_key, github_owner, github_repo, auto_nudge,
           dangerously_skip_permissions,
           runner_type, pty_backend_id, transcript_path
    FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

// ── Phase 16 — per-session runner type + persisted PTY backend identity (H10) ─

export type RunnerType = 'stream-json' | 'pty-interactive'

/**
 * Set a session's runner_type. User-scoped. GUARD (R-PTY-11): a Telegram-default
 * session MUST NOT be switched to 'pty-interactive' this phase (Telegram stays
 * stream-json until Phase 20 re-sources it onto the PTY surface). Returns:
 *   - { runner_type } on success
 *   - { error: 'telegram_default_pty_forbidden' } when blocked by the guard
 *   - undefined when no owned session matched
 */
export async function setSessionRunnerType(
  sessionId: string,
  userId: string,
  runnerType: RunnerType,
): Promise<{ runner_type: RunnerType } | { error: string } | undefined> {
  // Telegram-default guard — refuse pty-interactive for the user's tg-default session.
  if (runnerType === 'pty-interactive') {
    const tg = await sql<{ telegram_default_session_id: string | null }[]>`
      SELECT telegram_default_session_id FROM users WHERE id = ${userId} LIMIT 1
    `
    if (tg[0]?.telegram_default_session_id === sessionId) {
      return { error: 'telegram_default_pty_forbidden' }
    }
  }
  const rows = await sql<{ runner_type: RunnerType }[]>`
    UPDATE sessions SET runner_type = ${runnerType}
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING runner_type
  `
  return rows[0]
}

/** Read the persisted runner_type (authoritative on resume — H10). Defaults to
 *  'stream-json' for any row predating the column / missing it. */
export async function getSessionRunnerType(
  sessionId: string,
  userId: string,
): Promise<RunnerType> {
  const rows = await sql<{ runner_type: RunnerType | null }[]>`
    SELECT runner_type FROM sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `
  return (rows[0]?.runner_type as RunnerType) ?? 'stream-json'
}

/** Persist the backend PTY/tmux identity + transcript path captured at spawn so
 *  a reconnect/restart re-binds the SAME backend (no dual-spawn — H10). */
export async function setSessionPtyIdentity(
  sessionId: string,
  userId: string,
  ptyBackendId: string | null,
  transcriptPath: string | null,
): Promise<void> {
  await sql`
    UPDATE sessions SET pty_backend_id = ${ptyBackendId}, transcript_path = ${transcriptPath}
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `
}

/**
 * Phase 20 — resolve everything a `TranscriptSource.open(ctx)` needs for a
 * session, by sessionId alone (server-side; the bridge operates per-session, not
 * per-user). Returns the cli_kind, project_dir, and the PERSISTED transcript
 * identity captured at PTY spawn (transcript_path + codex rollout id). The
 * adapter degrades to scrape-mode when these are absent (never a newest-file
 * guess). Null when no live (non-deleted) session row matches.
 *
 * `codex_rollout_id` is read from `pty_backend_id` for codex sessions: the
 * Phase-16 spawn-time capture stores the backend identity there, and for codex
 * the rollout `session_meta` id IS that backend identity. (When a future Phase-16
 * revision adds a dedicated column this helper is the single place to update.)
 */
export async function getTranscriptOpenContext(
  sessionId: string,
): Promise<{
  sessionId: string
  projectDir: string
  cliKind: 'claude' | 'codex'
  transcriptPath: string | null
  codexRolloutId: string | null
} | null> {
  const rows = await sql<
    { project_dir: string | null; cli_kind: string | null; transcript_path: string | null; pty_backend_id: string | null }[]
  >`
    SELECT project_dir, cli_kind, transcript_path, pty_backend_id
      FROM sessions
     WHERE id = ${sessionId} AND deleted_at IS NULL
     LIMIT 1
  `
  if (!rows[0]) return null
  const cliKind = (rows[0].cli_kind as 'claude' | 'codex') ?? 'claude'
  return {
    sessionId,
    projectDir: rows[0].project_dir ?? '',
    cliKind,
    transcriptPath: rows[0].transcript_path ?? null,
    codexRolloutId: cliKind === 'codex' ? (rows[0].pty_backend_id ?? null) : null,
  }
}

/** Read the persisted PTY backend identity (resume re-binds it — H10). */
export async function getSessionPtyIdentity(
  sessionId: string,
  userId: string,
): Promise<{ runner_type: RunnerType; pty_backend_id: string | null; transcript_path: string | null } | null> {
  const rows = await sql<{ runner_type: RunnerType | null; pty_backend_id: string | null; transcript_path: string | null }[]>`
    SELECT runner_type, pty_backend_id, transcript_path FROM sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `
  if (!rows[0]) return null
  return {
    runner_type: (rows[0].runner_type as RunnerType) ?? 'stream-json',
    pty_backend_id: rows[0].pty_backend_id ?? null,
    transcript_path: rows[0].transcript_path ?? null,
  }
}

/**
 * Server-side write-authorization for a terminal session (H2 / R-PTY-29). A
 * `term.input`/`term.attach`/`term.reattach` is only allowed when the connection's
 * user OWNS the target session. This is the DB-backed ownership check the relay
 * composes with the per-connection subscribedSessions set — no cross-user/
 * cross-session PTY hijack via a forged session_id.
 */
export async function canWriteTerminal(userId: string, sessionId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `
  return rows.length > 0
}

/** Read the session's owning hostname (DB ground-truth for the H3/NH-1
 *  cross-host validation — a supervisor may only relay term.* for sessions whose
 *  DB hostname matches its own). Null when the row has no recorded hostname. */
export async function getSessionHostname(sessionId: string): Promise<string | null> {
  const rows = await sql<{ hostname: string | null }[]>`
    SELECT hostname FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL LIMIT 1
  `
  return rows[0]?.hostname ?? null
}

// Phase 10 — set a session's per-session auto-nudge override. NULL clears the
// override (session inherits users.auto_nudge_idle_sessions). User-scoped: a row
// is only updated when it belongs to the caller. Returns the new value, or
// undefined when no owned session matched.
export async function setSessionAutoNudge(
  sessionId: string,
  userId: string,
  autoNudge: boolean | null,
): Promise<{ auto_nudge: boolean | null } | undefined> {
  const rows = await sql<{ auto_nudge: boolean | null }[]>`
    UPDATE sessions SET auto_nudge = ${autoNudge}
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING auto_nudge
  `;
  return rows[0];
}

// Per-session "bypass permissions" override. User-scoped. The hub passes the
// REQUESTED value on session.start; the supervisor's config
// `allow_dangerous_skip_permissions` is the hard ceiling (applied = requested
// && allowed). Default OFF: a row that was never set reads as NULL (== OFF).
export async function setSessionSkipPermissions(
  sessionId: string,
  userId: string,
  enabled: boolean,
): Promise<{ dangerously_skip_permissions: boolean } | undefined> {
  const rows = await sql<{ dangerously_skip_permissions: boolean | null }[]>`
    UPDATE sessions SET dangerously_skip_permissions = ${enabled}
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING dangerously_skip_permissions
  `;
  if (!rows[0]) return undefined;
  return { dangerously_skip_permissions: rows[0].dangerously_skip_permissions === true };
}

/** Effective per-session skip-permissions (default OFF when null/missing). The
 *  supervisor still ANDs this with its host config ceiling. */
export async function getSessionSkipPermissions(
  sessionId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql<{ dangerously_skip_permissions: boolean | null }[]>`
    SELECT dangerously_skip_permissions FROM sessions
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0]?.dangerously_skip_permissions === true;
}

/** Effective per-session skip-permissions resolved by repo working tree, for the
 *  spawn paths that only have (userId, projectDir) and no sessionId. Picks the
 *  most-recently-active matching session. Returns TRUE when no session row
 *  matches (the column now defaults TRUE; absent-row mirrors that default-ON
 *  intent). The supervisor still ANDs this with its host config ceiling, so a
 *  spurious TRUE can never exceed host policy. */
export async function getSessionSkipPermissionsByRepo(
  userId: string,
  projectDir: string,
): Promise<boolean> {
  const rows = await sql<{ dangerously_skip_permissions: boolean | null }[]>`
    SELECT dangerously_skip_permissions FROM sessions
    WHERE user_id = ${userId} AND project_dir = ${projectDir} AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST
    LIMIT 1
  `;
  if (rows.length === 0) return true;
  return rows[0].dangerously_skip_permissions === true;
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
// REVIEW BL-04: Atomic upsert via the partial unique index
// idx_sessions_user_project_unique (user_id, project_dir) WHERE
// deleted_at IS NULL AND is_rootless=false. Two concurrent reconnects for
// the same project_dir converge on ONE row instead of racing into
// duplicates. xmax=0 detects insert-vs-update so we can return the
// `created` flag correctly without a re-SELECT.
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
      // ── Worktree overwrite guard (Bug fix 2026-05-28) ──────────────────────
      // All worktrees of a repo share one origin → one repo_key → this single
      // row. The previous code blindly overwrote `project_dir` with whichever
      // checkout authenticated last (last-writer-wins), so a worktree connect
      // could strand the row's path on `…/remo-code-<slug>` and every launch
      // would then resolve to the worktree instead of the real clone.
      //
      // Rule: never downgrade a canonical/primary `project_dir` to a worktree
      // path. When the connecting checkout IS a worktree, prefer its
      // `worktree_parent_path` (the real clone) for the column; if the parent
      // is unknown, keep whatever path the row already has rather than writing
      // the worktree path. A primary (non-worktree) connect always wins and
      // refreshes the column.
      const incomingIsWorktree = !!git.is_worktree
      const nextProjectDir = incomingIsWorktree
        ? (git.worktree_parent_path ?? row.project_dir ?? projectDir)
        : projectDir
      // Plan 08-003 T4: when tokenHash is null (supervisor inventory path)
      // preserve the existing token_hash so a previously-attached runner row
      // keeps its binding. Otherwise overwrite.
      const updated = tokenHash === null
        ? await tx`
            UPDATE sessions
               SET project_dir = ${nextProjectDir},
                   last_activity = now()
             WHERE id = ${row.id}
             RETURNING *
          `
        : await tx`
            UPDATE sessions
               SET token_hash = ${tokenHash},
                   project_dir = ${nextProjectDir},
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
      // Supersede the non-keeper siblings FIRST. The keeper UPDATE below adopts
      // `projectDir`, which may equal a sibling's current project_dir; the partial
      // unique index idx_sessions_user_project_unique(user_id, project_dir)
      // WHERE deleted_at IS NULL AND is_rootless=false would reject the keeper
      // UPDATE while that sibling is still live. Soft-deleting siblings first
      // removes them from the index so the keeper can take over the path.
      for (let i = 1; i < legacyRows.length; i++) {
        const other = legacyRows[i]
        await tx`
          UPDATE sessions
             SET superseded_by = ${keeper.id},
                 deleted_at = now()
           WHERE id = ${other.id}
        `
      }
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
      return { ...updated[0], created: false, repo_keyed: true, migrated: true }
    }

    // Priority 2.5: an active non-rootless row already occupies (user_id, project_dir)
    // but with a different (or null) repo_key — e.g. the remote was changed, or a
    // row was previously upserted by the legacy path before repo_key was known.
    // The partial unique index idx_sessions_user_project_unique(user_id, project_dir)
    // WHERE deleted_at IS NULL AND is_rootless=false will reject the P3 INSERT in
    // that case. Adopt the existing row instead: stamp it with the new repo_key
    // (and github_owner/repo) so subsequent P1 lookups hit it directly.
    const projectDirRows = await tx`
      SELECT * FROM sessions
      WHERE user_id = ${userId}
        AND project_dir = ${projectDir}
        AND is_rootless = false
        AND deleted_at IS NULL
      FOR UPDATE
    `
    if (projectDirRows[0]) {
      const row = projectDirRows[0]
      const updated = tokenHash === null
        ? await tx`
            UPDATE sessions
               SET repo_key = ${repoKey},
                   github_owner = ${owner},
                   github_repo = ${repo},
                   last_activity = now()
             WHERE id = ${row.id}
             RETURNING *
          `
        : await tx`
            UPDATE sessions
               SET repo_key = ${repoKey},
                   github_owner = ${owner},
                   github_repo = ${repo},
                   token_hash = ${tokenHash},
                   last_activity = now()
             WHERE id = ${row.id}
             RETURNING *
          `
      return { ...updated[0], created: false, repo_keyed: true }
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

// User-initiated Disconnect (distinct from delete/markSessionDisconnected).
// Takes the session OFFLINE — the caller stops the runner by sending a
// `shutdown` to the channel — but KEEPS the row (deleted_at stays NULL) so the
// SAME session_id can be relaunched later, resuming its persisted messages.
// Returns true when an owned, non-deleted row matched (already-offline still
// returns true — idempotent). NEVER soft-deletes; that is the whole point —
// a soft-deleted row would force findOrCreateAgentSession to spawn a NEW
// session on reconnect, losing history.
export async function markSessionOffline(sessionId: string, userId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE sessions SET status = 'offline'
    WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
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
  const rows = await sql`SELECT id, email, display_name, avatar_url, role, system_prompt, timezone, daily_cost_cap_usd, programmatic_halt_usd, web_push_enabled, claude_session_threshold_pct, claude_week_threshold_pct, auto_nudge_idle_sessions, notifications, notify_channels, created_at, updated_at FROM users WHERE id = ${id}`;
  return rows[0] ?? null;
}

// ── Milestone TMAC §7.1: per-channel orchestrator-notify opt-in ──────────────
// users.notify_channels is a JSONB map {telegram,inapp,email,push}->bool.
// Default all-on (set by the schema column default); a MISSING key reads as
// opted-IN, so the notifier only mutes a channel on an explicit `false`.
export type NotifyChannelKey = 'telegram' | 'inapp' | 'email' | 'push';
export type NotifyChannelPrefs = Partial<Record<NotifyChannelKey, boolean>>;
const NOTIFY_CHANNEL_KEYS: NotifyChannelKey[] = ['telegram', 'inapp', 'email', 'push'];

export async function getUserNotifyChannels(userId: string): Promise<NotifyChannelPrefs> {
  const rows = await sql<{ notify_channels: NotifyChannelPrefs | null }[]>`
    SELECT notify_channels FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0]?.notify_channels ?? {};
}

// Merge a partial opt-in patch over the stored map (only provided keys change).
// Returns the merged map. ATOMIC: a single JSONB `||` concat merges the sanitized
// patch in-DB (no read-modify-write race; `||` overrides only the provided keys
// and preserves the all-on default for unset keys). Unknown keys are dropped here.
export async function updateUserNotifyChannels(
  userId: string,
  patch: NotifyChannelPrefs,
): Promise<NotifyChannelPrefs> {
  const sanitized: NotifyChannelPrefs = {};
  for (const k of NOTIFY_CHANNEL_KEYS) {
    if (typeof patch[k] === 'boolean') sanitized[k] = patch[k];
  }
  const rows = await sql<{ notify_channels: NotifyChannelPrefs | null }[]>`
    UPDATE users
    SET notify_channels = COALESCE(notify_channels, '{}'::jsonb) || ${sql.json(sanitized)}::jsonb,
        updated_at = now()
    WHERE id = ${userId}
    RETURNING notify_channels
  `;
  return rows[0]?.notify_channels ?? sanitized;
}

// Phase 12 W2 — preferences / prompts / profile (extended)
// `auto_nudge_idle_sessions` lives on `users` as its own column (small,
// frequently-read boolean). `notifications` is a JSONB blob — UI fills schema
// lazily. `display_name` is the existing column used for the "name" field on
// the new Profile tab.
export type UserPromptsPatch = {
  auto_nudge_idle_sessions?: boolean;
  claude_global_md?: string | null;
  codex_agents_md?: string | null;
  codex_config_toml?: string | null;
};

export async function updateUserPrompts(userId: string, patch: UserPromptsPatch) {
  if (patch.auto_nudge_idle_sessions !== undefined) {
    await sql`UPDATE users SET auto_nudge_idle_sessions = ${patch.auto_nudge_idle_sessions}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.claude_global_md !== undefined) {
    await sql`UPDATE users SET claude_global_md = ${patch.claude_global_md ?? null}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.codex_agents_md !== undefined) {
    await sql`UPDATE users SET codex_agents_md = ${patch.codex_agents_md ?? null}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.codex_config_toml !== undefined) {
    await sql`UPDATE users SET codex_config_toml = ${patch.codex_config_toml ?? null}, updated_at = now() WHERE id = ${userId}`;
  }
  // Re-read so caller always sees a coherent post-write snapshot.
  const rows = await sql<any[]>`
    SELECT auto_nudge_idle_sessions, claude_global_md, codex_agents_md, codex_config_toml
    FROM users WHERE id = ${userId}
  `;
  return rows[0] ?? null;
}

export type UserProfilePatch = {
  display_name?: string | null;
  avatar_url?: string | null;
  timezone?: string;
  notifications?: Record<string, unknown>;
};

export async function updateUserProfileExt(userId: string, patch: UserProfilePatch) {
  if (patch.display_name !== undefined) {
    await sql`UPDATE users SET display_name = ${patch.display_name}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.avatar_url !== undefined) {
    await sql`UPDATE users SET avatar_url = ${patch.avatar_url}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.timezone !== undefined) {
    await sql`UPDATE users SET timezone = ${patch.timezone}, updated_at = now() WHERE id = ${userId}`;
  }
  if (patch.notifications !== undefined) {
    const json = JSON.stringify(patch.notifications);
    await sql`UPDATE users SET notifications = ${json}::jsonb, updated_at = now() WHERE id = ${userId}`;
  }
  return getUserById(userId);
}

// Phase 12 W2 — aggregated cost rollup for /api/usage/summary.
// Computed in the user's IANA timezone. Returns total cost in USD per window.
export async function sumUserCostWindows(userId: string, timezone: string) {
  const tz = timezone || 'UTC';
  const rows = await sql<{ today: string; week: string; month: string }[]>`
    SELECT
      COALESCE(SUM(CASE WHEN scheduled_for >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} THEN cost_usd ELSE 0 END), 0)::text AS today,
      COALESCE(SUM(CASE WHEN scheduled_for >= date_trunc('week', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} THEN cost_usd ELSE 0 END), 0)::text AS week,
      COALESCE(SUM(CASE WHEN scheduled_for >= date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz} THEN cost_usd ELSE 0 END), 0)::text AS month
    FROM scheduled_task_runs
    WHERE user_id = ${userId}
      AND status IN ('success', 'failed', 'in_flight', 'running')
  `;
  const r = rows[0] ?? { today: '0', week: '0', month: '0' };
  return {
    today_usd: Number(r.today),
    week_usd: Number(r.week),
    month_usd: Number(r.month),
  };
}

// Phase 12 W2 — list runs across user's tasks for Tasks → Activity feed.
// Keyset pagination on (started_at, id) — DESC order. Status filter is
// optional ('in_progress' is sugar for the in-flight set).
export async function listUserActivityRuns(args: {
  userId: string;
  status?: string;
  before?: Date;
  limit?: number;
}) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const inFlight = new Set(['running', 'pending', 'in_flight']);
  const status = args.status;

  // Build statement variants — postgres.js tagged template doesn't support
  // arbitrary identifier interpolation, so we branch.
  if (status === 'in_progress') {
    if (args.before) {
      return sql`
        SELECT r.*, t.name AS task_name, t.task_type
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE r.user_id = ${args.userId}
          AND r.status IN ('running','pending','in_flight')
          AND r.started_at < ${args.before}
        ORDER BY r.started_at DESC
        LIMIT ${limit}
      `;
    }
    return sql`
      SELECT r.*, t.name AS task_name, t.task_type
      FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE r.user_id = ${args.userId}
        AND r.status IN ('running','pending','in_flight')
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    `;
  }
  if (status === 'completed') {
    if (args.before) {
      return sql`
        SELECT r.*, t.name AS task_name, t.task_type
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE r.user_id = ${args.userId}
          AND r.status = 'success'
          AND r.started_at < ${args.before}
        ORDER BY r.started_at DESC
        LIMIT ${limit}
      `;
    }
    return sql`
      SELECT r.*, t.name AS task_name, t.task_type
      FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE r.user_id = ${args.userId}
        AND r.status = 'success'
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    `;
  }
  if (status === 'failed') {
    if (args.before) {
      return sql`
        SELECT r.*, t.name AS task_name, t.task_type
        FROM scheduled_task_runs r
        LEFT JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE r.user_id = ${args.userId}
          AND r.status = 'failed'
          AND r.started_at < ${args.before}
        ORDER BY r.started_at DESC
        LIMIT ${limit}
      `;
    }
    return sql`
      SELECT r.*, t.name AS task_name, t.task_type
      FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE r.user_id = ${args.userId}
        AND r.status = 'failed'
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    `;
  }
  // No status filter — return all.
  if (args.before) {
    return sql`
      SELECT r.*, t.name AS task_name, t.task_type
      FROM scheduled_task_runs r
      LEFT JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE r.user_id = ${args.userId}
        AND r.started_at < ${args.before}
      ORDER BY r.started_at DESC
      LIMIT ${limit}
    `;
  }
  return sql`
    SELECT r.*, t.name AS task_name, t.task_type
    FROM scheduled_task_runs r
    LEFT JOIN scheduled_tasks t ON t.id = r.task_id
    WHERE r.user_id = ${args.userId}
    ORDER BY r.started_at DESC
    LIMIT ${limit}
  `;
}

// Phase 12 W2 — list upcoming tasks ordered by next_fire_at ASC.
// Used by Tasks → Upcoming tab.
export async function listUpcomingTasks(args: {
  userId: string;
  limit?: number;
  offset?: number;
}) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const offset = Math.max(args.offset ?? 0, 0);
  return sql`
    SELECT id, name, name_prefix, name_suffix, task_type, target_kind, target_id,
           session_id, cron_expression, cron_expr, timezone, next_fire_at, next_run_at,
           enabled, payload
    FROM scheduled_tasks
    WHERE user_id = ${args.userId}
      AND enabled = true
      AND next_fire_at IS NOT NULL
      AND next_fire_at > now()
    ORDER BY next_fire_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// Phase 12 W2 — list tasks grouped by repo (derived from sessions.project_dir).
// Tasks targeting all_agents / all_supervisors / supervisor land in 'unassigned'.
// Returned shape: { groups: [{ key, label, tasks: [...] }] }.
export async function listTasksGroupedByRepo(userId: string) {
  const rows = await sql<any[]>`
    SELECT t.id, t.name, t.name_prefix, t.name_suffix, t.task_type,
           t.target_kind, t.target_id, t.session_id,
           t.cron_expression, t.cron_expr, t.timezone,
           t.enabled, t.next_fire_at, t.last_fire_at,
           s.project_dir AS session_project_dir,
           s.name AS session_name
    FROM scheduled_tasks t
    LEFT JOIN sessions s ON s.id = t.session_id
    WHERE t.user_id = ${userId}
    ORDER BY t.created_at DESC
  `;
  // Group in JS — task counts per user are small (< few hundred).
  const groups = new Map<string, { key: string; label: string; tasks: any[] }>();
  for (const r of rows) {
    let key: string;
    let label: string;
    if (r.target_kind === 'session' && r.session_project_dir) {
      key = `repo:${r.session_project_dir}`;
      label = r.session_project_dir;
    } else {
      key = 'unassigned';
      label = 'Unassigned';
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, label, tasks: [] };
      groups.set(key, g);
    }
    g.tasks.push(r);
  }
  return Array.from(groups.values());
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
): Promise<{ secret: string | null; allowedIps: string[]; autoTriageEnabled: boolean }> {
  const rows = await sql<{
    coolify_webhook_secret: string | null;
    coolify_webhook_allowed_ips: string | null;
    coolify_auto_triage_enabled: boolean | null;
  }[]>`
    SELECT coolify_webhook_secret, coolify_webhook_allowed_ips, coolify_auto_triage_enabled
      FROM users WHERE id = ${userId}
  `;
  if (!rows[0]) return { secret: null, allowedIps: [], autoTriageEnabled: true };
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
  // Default true when NULL (column added later; existing rows backfill via DDL default).
  const autoTriageEnabled = rows[0].coolify_auto_triage_enabled ?? true;
  return { secret: rows[0].coolify_webhook_secret, allowedIps, autoTriageEnabled };
}

/** fix/coolify-triage-guard: read the master auto-triage switch (defaults true). */
export async function getUserCoolifyAutoTriageEnabled(userId: string): Promise<boolean> {
  const rows = await sql<{ coolify_auto_triage_enabled: boolean | null }[]>`
    SELECT coolify_auto_triage_enabled FROM users WHERE id = ${userId}
  `;
  return rows[0]?.coolify_auto_triage_enabled ?? true;
}

/** fix/coolify-triage-guard: set the master auto-triage switch. Returns saved value. */
export async function setUserCoolifyAutoTriageEnabled(
  userId: string,
  enabled: boolean,
): Promise<boolean> {
  await sql`
    UPDATE users SET coolify_auto_triage_enabled = ${enabled}, updated_at = now()
    WHERE id = ${userId}
  `;
  return enabled;
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
  | 'legacy_hmac'
  // Well-formed Coolify event we recognize but intentionally do not act on
  // (e.g. `task_failed` — a scheduled-command failure, NOT a deploy failure).
  // Recorded so it never lands as `bad_payload`; no run/triage.
  | 'ignored';

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
    log.warn('coolify_webhook.attempts_trim_failed', { error: err?.message });
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

export async function updateProfile(userId: string, fields: { display_name?: string; avatar_url?: string | null; system_prompt?: string | null; timezone?: string; programmatic_halt_usd?: number | null }) {
  // Build a partial update — only touch the columns provided.
  const sets: any[] = [];
  if (fields.display_name !== undefined) sets.push(sql`display_name = ${fields.display_name}`);
  if (fields.avatar_url !== undefined) sets.push(sql`avatar_url = ${fields.avatar_url}`);
  if (fields.system_prompt !== undefined) sets.push(sql`system_prompt = ${fields.system_prompt}`);
  if (fields.timezone !== undefined) sets.push(sql`timezone = ${fields.timezone}`);
  // Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt bound. null clears
  // it (OFF — the default).
  if (fields.programmatic_halt_usd !== undefined) sets.push(sql`programmatic_halt_usd = ${fields.programmatic_halt_usd}`);
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

// REVIEW HI-06: placeholder-claim race-prevention restored. Wave 5 deleted
// these and left a `void hash` stub; two concurrent failure webhooks for the
// same (repo, app_uuid, deploy_uuid) could both pass hasOpenIssueForHash and
// both call octokit.issues.create → duplicate issues. The placeholder write
// (issue_number=0) narrows the race window: only one caller wins the claim.
// updateOpenIssuePlaceholder overwrites on success; deleteOpenIssuePlaceholder
// removes on terminal failure (issue_number 0 = sentinel).
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

// ── auto-dev P4: QC finding-hash idempotency ─────────────────────────────────
//
// Backed by `qc_finding_idempotency` (see schema.sql). Loop-safety guard: a
// finding fixed-and-verified within `windowHours` is skipped by the qc_review
// router so the routine can't oscillate on an unfixable finding.

export async function hasVerifiedFinding(
  userId: string,
  hash: string,
  windowHours: number,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM qc_finding_idempotency
    WHERE user_id = ${userId}
      AND hash = ${hash}
      AND created_at > now() - (${String(windowHours)} || ' hours')::interval
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function recordVerifiedFinding(
  userId: string,
  hash: string,
  repo: string,
): Promise<void> {
  await sql`
    INSERT INTO qc_finding_idempotency (user_id, hash, repo)
    VALUES (${userId}, ${hash}, ${repo})
    ON CONFLICT (user_id, hash) DO UPDATE SET created_at = now()
  `;
}

// ── auto-dev P5: Coolify deploy-failure storm dedupe ─────────────────────────
//
// Backed by `coolify_deploy_idempotency`. Atomic claim: the FIRST failed deploy
// for a (user, application_uuid, fingerprint) wins and dispatches a fix; a storm
// of repeats within the same fingerprint window loses the claim and is dropped.
// INSERT ... ON CONFLICT DO NOTHING + RETURNING is the race-safe claim — only
// one concurrent caller gets a returned row.

export async function claimDeployFailure(
  userId: string,
  applicationUuid: string,
  fingerprint: string,
  prevFingerprint?: string,
): Promise<boolean> {
  // Opportunistic reaping: rows are never otherwise deleted, so bound the table
  // by dropping claims older than 2h (well past the 15-min dedupe window) on
  // every claim. Cheap, idempotent.
  await sql`
    DELETE FROM coolify_deploy_idempotency WHERE created_at < now() - interval '2 hours'
  `;
  // Sliding-window guard: a failure straddling a 15-min bucket boundary would
  // otherwise hash into a fresh bucket and double-dispatch. If a claim already
  // exists for the PREVIOUS bucket's fingerprint, treat this as a duplicate.
  if (prevFingerprint) {
    const prior = await sql`
      SELECT 1 FROM coolify_deploy_idempotency
      WHERE user_id = ${userId}
        AND application_uuid = ${applicationUuid}
        AND fingerprint = ${prevFingerprint}
      LIMIT 1
    `;
    if (prior.length > 0) return false;
  }
  const rows = await sql`
    INSERT INTO coolify_deploy_idempotency (user_id, application_uuid, fingerprint)
    VALUES (${userId}, ${applicationUuid}, ${fingerprint})
    ON CONFLICT (user_id, application_uuid, fingerprint) DO NOTHING
    RETURNING fingerprint
  `;
  return rows.length > 0;
}

// ── feat/coolify-uuid-repo-map: application_uuid → repo_key cache ─────────────
// Lazy-populated mapping resolved from the Coolify API (see
// hub/src/sessions/coolify-app-repo.ts). user-scoped.

export interface CoolifyAppRepoRow {
  application_uuid: string;
  user_id: string;
  repo_key: string | null;
  git_full_url: string | null;
  updated_at: string;
}

export async function getCoolifyAppRepo(
  applicationUuid: string,
  userId: string,
): Promise<CoolifyAppRepoRow | null> {
  const rows = await sql<CoolifyAppRepoRow[]>`
    SELECT application_uuid, user_id, repo_key, git_full_url, updated_at
    FROM coolify_app_repo
    WHERE application_uuid = ${applicationUuid} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function upsertCoolifyAppRepo(input: {
  application_uuid: string;
  user_id: string;
  repo_key: string | null;
  git_full_url: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO coolify_app_repo (application_uuid, user_id, repo_key, git_full_url, updated_at)
    VALUES (${input.application_uuid}, ${input.user_id}, ${input.repo_key}, ${input.git_full_url}, now())
    ON CONFLICT (application_uuid, user_id) DO UPDATE SET
      repo_key = EXCLUDED.repo_key,
      git_full_url = EXCLUDED.git_full_url,
      updated_at = now()
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

// ── Phase 12: Telegram bridge DAL ────────────────────────────────────────────

export type TelegramUserRow = {
  id: string;
  email: string;
  telegram_chat_id: string | number | null;
  telegram_default_session_id: string | null;
  // True only when the user explicitly chose the default (/session or a /list
  // button tap). Auto-pins leave it false. Drives orchestrator-as-default
  // resolution: a non-explicit (or null) default never blocks the orchestrator
  // preference, an explicit one is always honored.
  telegram_default_explicit: boolean;
};

export async function getUserByTelegramChatId(chatId: number | bigint | string): Promise<TelegramUserRow | null> {
  const rows = await sql<TelegramUserRow[]>`
    SELECT id, email, telegram_chat_id, telegram_default_session_id,
           COALESCE(telegram_default_explicit, false) AS telegram_default_explicit
      FROM users
     WHERE telegram_chat_id = ${chatId as any}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function setTelegramChatId(userId: string, chatId: number | bigint | string): Promise<void> {
  await sql`
    UPDATE users
       SET telegram_chat_id = ${chatId as any},
           telegram_link_code = NULL,
           telegram_link_code_expires_at = NULL
     WHERE id = ${userId}
  `;
}

export async function clearTelegramChatId(userId: string): Promise<void> {
  await sql`
    UPDATE users
       SET telegram_chat_id = NULL,
           telegram_default_session_id = NULL,
           telegram_default_explicit = false
     WHERE id = ${userId}
  `;
}

/**
 * Phase 12 W3 — Outbound bridge lookup. Returns every user whose
 * `telegram_default_session_id` points at the given session AND who has a
 * non-null `telegram_chat_id` (i.e. a usable Telegram destination).
 *
 * In practice a session can match at most one user (default-session is per-
 * user and a session belongs to one user), but the signature is an array to
 * keep the helper general and to make the SQL straightforward.
 */
export async function getUsersWithTelegramDefaultSession(
  sessionId: string,
): Promise<Array<{ id: string; telegram_chat_id: string | number }>> {
  const rows = await sql<Array<{ id: string; telegram_chat_id: string | number }>>`
    SELECT id, telegram_chat_id
      FROM users
     WHERE telegram_default_session_id = ${sessionId}
       AND telegram_chat_id IS NOT NULL
  `;
  return rows;
}

/**
 * Set (or clear) the Telegram default session.
 *
 * `explicit` records WHETHER the user deliberately chose this default — it is
 * REQUIRED so every call site must consciously decide (a silent default is what
 * let the web-UI dropdown path regress):
 *   - `/session <id>`, a `/list` button tap, and the web Settings dropdown pass
 *     `explicit: true`.
 *   - The inbound dispatcher's lazy-pin (orchestrator fallback) and the
 *     prewarm-on-link path pass `explicit: false`.
 *
 * The flag lets orchestrator-as-default resolution prefer the root orchestrator
 * for a no-choice user while never surprise-switching a user away from a repo
 * they explicitly picked.
 */
export async function setTelegramDefaultSession(
  userId: string,
  sessionId: string | null,
  explicit: boolean,
): Promise<void> {
  await sql`
    UPDATE users
       SET telegram_default_session_id = ${sessionId},
           telegram_default_explicit = ${explicit}
     WHERE id = ${userId}
  `;
}

export async function setTelegramLinkCode(
  userId: string,
  code: string | null,
  expiresAt: Date | null,
): Promise<void> {
  await sql`
    UPDATE users
       SET telegram_link_code = ${code},
           telegram_link_code_expires_at = ${expiresAt}
     WHERE id = ${userId}
  `;
}

export async function findUserByLinkCode(code: string): Promise<{ id: string; expiresAt: Date | null } | null> {
  const rows = await sql<{ id: string; telegram_link_code_expires_at: Date | null }[]>`
    SELECT id, telegram_link_code_expires_at
      FROM users
     WHERE telegram_link_code = ${code}
     LIMIT 1
  `;
  if (!rows[0]) return null;
  return { id: rows[0].id, expiresAt: rows[0].telegram_link_code_expires_at };
}

export interface TelegramInboundLogInput {
  user_id: string | null;
  chat_id: number | bigint | string | null;
  update_id: number | bigint | null;
  outcome: string;
  error?: string | null;
  raw?: unknown;
}

/**
 * Insert one inbound-log row, then trim the user's history to 100. Mirrors
 * recordCoolifyWebhookAttempt. Inserts on (chat_id, update_id) UNIQUE
 * collide silently — Telegram retries the same update_id when we 5xx, so
 * the dispatch path checks for an existing row before re-firing.
 */
export async function logTelegramInbound(input: TelegramInboundLogInput): Promise<{ inserted: boolean }> {
  let inserted = false;
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO telegram_inbound_log
        (user_id, chat_id, update_id, outcome, error, raw)
      VALUES
        (${input.user_id},
         ${input.chat_id as any},
         ${input.update_id as any},
         ${input.outcome},
         ${input.error ?? null},
         ${input.raw === undefined ? null : JSON.stringify(input.raw)}::jsonb)
      ON CONFLICT (chat_id, update_id) DO NOTHING
      RETURNING id
    `;
    inserted = rows.length > 0;
  } catch (err: any) {
    log.warn("telegram.inbound_log_insert_failed", { error: err?.message });
    return { inserted: false };
  }
  if (!input.user_id) return { inserted };
  try {
    await sql`
      DELETE FROM telegram_inbound_log
       WHERE user_id = ${input.user_id}
         AND id IN (
           SELECT id FROM telegram_inbound_log
            WHERE user_id = ${input.user_id}
            ORDER BY received_at DESC
            OFFSET 100
         )
    `;
  } catch (err: any) {
    log.warn("telegram.inbound_log_trim_failed", { error: err?.message });
  }
  return { inserted };
}
