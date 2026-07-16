import { Hono } from 'hono'
import { z } from 'zod'
import { createSession, getSession, deleteSession, updateSessionToken, markSessionDisconnected, markSessionOffline, getPendingPrompts, dismissLocalSession, setSessionAutoNudge, setSessionRunnerType, getSessionPtyIdentity, setSessionSkipPermissions, getSessionSkipPermissions, getSessionSkipPermissionsByRepo, getCoolifyAppByRepoKey } from '../db/dal'
import { parseGitRemote } from '../lib/repo-key.ts'
import { getMessagesForSessions } from '../db/chat-tabs-dal.ts'
import { hashToken } from '../lib/crypto'
import { getChannel } from '../ws/registry'
import { generateToken } from '../utils/token'
import { pickSessionTarget } from '../sessions/routing.ts'
import {
  sendToSupervisor,
  sendRequest,
  updateSupervisorState,
  listOnlineSupervisorIdsForUser,
  resolveLocalPathForRepoKey,
  getUserInventory,
  getKnownLocalPathsForRepoKey,
  findSupervisorForSession,
} from '../ws/supervisor-registry.ts'
import { releaseSessionSlot, reserveSessionSlot } from '../sessions/budget.ts'
import { listSessionsForUserEnriched } from '../sessions/enrich.ts'
import { probeGithubAppScope } from '../lib/github-scope.ts'
import { enqueueCreateGithubRepoJob } from '../lib/github-repo-job.ts'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const CreateSessionBody = z.object({
  name: z.string().min(1).max(100).trim(),
  project_dir: z.string().max(500).optional(),
})

// Hard cap on the number of session ids a single batch-messages request can
// fetch. Matches the WS subscribe cap (PLAN-002, SUBSCRIBE_MAX=12).
const BATCH_MESSAGES_MAX_IDS = 12
const BATCH_MESSAGES_DEFAULT_LIMIT = 30
const BATCH_MESSAGES_MAX_LIMIT = 100

const sessions = new Hono()

// List all sessions for the authenticated user
sessions.get('/', async (c) => {
  const userId = c.get('userId') as string
  // Bug A (2026-05-28) — `active` derives from the supervisor's
  // session_inventory push; Phase 08.6 — `local_paths` from the inventory
  // cache. Both live in the shared enricher, which the WS `session_list`
  // broadcasts use too: the web replaces its whole list on each broadcast, so
  // the two payloads must stay identical (see hub/src/sessions/enrich.ts).
  return c.json(await listSessionsForUserEnriched(userId))
})

// Batch-fetch messages for up to 12 sessions at once. Used by the multichat
// grid view to hydrate every cell with one round-trip per tab activation.
// MUST be declared BEFORE the `/:id` GET so it isn't captured as a session id.
sessions.get('/messages', async (c) => {
  const userId = c.get('userId') as string
  const idsParam = c.req.query('ids') ?? ''
  const limitParam = c.req.query('limit')
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
  if (ids.length === 0) return c.json({})
  if (ids.length > BATCH_MESSAGES_MAX_IDS) {
    return c.json({ error: 'too_many_sessions', max: BATCH_MESSAGES_MAX_IDS }, 400)
  }
  let limit = BATCH_MESSAGES_DEFAULT_LIMIT
  if (limitParam !== undefined) {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) {
      return c.json({ error: 'invalid_limit' }, 400)
    }
    limit = Math.min(n, BATCH_MESSAGES_MAX_LIMIT)
  }
  // DAL filters by user_id — sessions not owned by the caller are silently
  // dropped, so the response simply omits them (no existence leak).
  const grouped = await getMessagesForSessions(userId, ids, limit)
  return c.json(grouped)
})

// ── Phase 08 plan 004 — pending-prompts + dismiss-local ──────────────────────
// MUST be declared BEFORE the `/:id` GET so the path segments don't collide.

const DismissLocalBody = z.object({
  hostname: z.string().min(1).max(255),
  project_dir: z.string().min(1).max(4096),
})

sessions.get('/pending-prompts', async (c) => {
  const userId = c.get('userId') as string
  const pending = await getPendingPrompts(userId)
  return c.json({ pending })
})

sessions.post('/dismiss-local', async (c) => {
  const userId = c.get('userId') as string
  const parsed = DismissLocalBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  await dismissLocalSession(userId, parsed.data.hostname, parsed.data.project_dir)
  return c.json({ dismissed: true })
})

// Get a single session
sessions.get('/:id', async (c) => {
  const userId = c.get('userId') as string
  const session = await getSession(c.req.param('id'), userId)
  if (!session) return c.json({ error: 'not found' }, 404)
  return c.json(session)
})

/**
 * Resolve the Coolify app bound to a session's repo, for auto-filling the
 * `<coolify-uuid>` / `<coolify-app-slug>` placeholders in a scheduled-task's
 * notes template. Best-effort + non-throwing: returns nulls when the session
 * is not GitHub-keyed or no Coolify app has been mapped to its repo yet (the
 * `coolify_app_repo` cache is lazily populated from deploy-failure webhooks).
 * The client leaves unresolved placeholders intact.
 */
sessions.get('/:id/coolify-app', async (c) => {
  const userId = c.get('userId') as string
  const session = await getSession(c.req.param('id'), userId)
  if (!session) return c.json({ error: 'not found' }, 404)

  const repoKey = (session as any).repo_key as string | null
  if (!repoKey) return c.json({ application_uuid: null, app_slug: null })

  let applicationUuid: string | null = null
  let gitUrl: string | null = null
  try {
    const row = await getCoolifyAppByRepoKey(repoKey, userId)
    if (row) {
      applicationUuid = row.application_uuid
      gitUrl = row.git_full_url
    }
  } catch { /* best-effort — fall through to nulls */ }

  // Derive a slug from the git remote's repo name (the common Coolify app slug
  // convention), preferring the cached git URL, then the session's GitHub repo.
  const fromGit = parseGitRemote(gitUrl)?.repo ?? null
  const appSlug = fromGit ?? ((session as any).github_repo as string | null) ?? null

  return c.json({ application_uuid: applicationUuid, app_slug: appSlug })
})

// Create a new session — returns the raw token ONCE
sessions.post('/', async (c) => {
  const userId = c.get('userId') as string
  const parsed = CreateSessionBody.safeParse(await c.req.json())
  if (!parsed.success) {
    return c.json({ error: 'invalid input' }, 400)
  }

  const rawToken = generateToken('remo_')
  const tokenHash = await hashToken(rawToken)

  const session = await createSession(userId, parsed.data.name, parsed.data.project_dir || null, tokenHash)

  return c.json({ ...session, token: rawToken }, 201)
})

// Disconnect / delete a session.
// 1. Tell the connected agent to shut down (kill Claude subprocess + close WS + exit).
// 2. Soft-delete the row so the agent cannot resurrect it via findOrCreateAgentSession.
// 3. Close the channel.
sessions.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  try {
    const channel = getChannel(sessionId)
    if (channel) {
      try { channel.ws.send(JSON.stringify({ type: 'shutdown', reason: 'user_disconnect' })) } catch {}
    }
    // Mark any open session_runs bound to this session as `user_stopped` so
    // the orphan-resume path (agent.ts + client.ts) skips them. Sacred
    // invariant: a session the user deleted is never auto-resurrected.
    try {
      const { sql } = await import('../db/postgres')
      await sql`
        UPDATE session_runs
        SET ended_at = COALESCE(ended_at, now()), exit_reason = 'user_stopped'
        WHERE session_id = ${sessionId} AND user_id = ${userId} AND ended_at IS NULL
      `
    } catch (err: any) {
      console.error('[sessions.delete] failed to mark user_stopped', err?.message)
    }
    await markSessionDisconnected(sessionId, userId)
    // Give the agent ~5s to gracefully exit before forcibly closing the socket.
    setTimeout(() => {
      const ch = getChannel(sessionId)
      if (ch) {
        try { ch.ws.close(4010, 'session disconnected') } catch {}
      }
    }, 5_000)
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'not found' }, 404)
  }
})

// ── POST /api/sessions/:id/disconnect — user-initiated Disconnect ────────────
// Takes a RUNNING session OFFLINE without removing it. Distinct from DELETE:
//   - DELETE soft-deletes the row (deleted_at set) → findOrCreateAgentSession
//     spawns a NEW session on the next connect, losing history.
//   - disconnect KEEPS the row (deleted_at stays NULL), so a later /launch for
//     the SAME session_id resumes the same row with its persisted messages —
//     "I don't want a new session created every time it reconnects."
// Steps:
//   1. Ownership-check the session (404 when missing / not owned).
//   2. Send `{type:'shutdown', reason:'user_disconnect'}` to the session's
//      channel so the SessionBridge stops the runner (SIGINT→SIGKILL).
//   3. End any open session_runs for this session so the supervisor / #223
//      reconcile frees the concurrency slot.
//   4. Mark the session status `offline` (KEEP the row).
// Idempotent: when already offline + no channel + no open runs, it's a no-op
// 200. Reversible — reconnect via /launch resumes; no destructive confirm.
sessions.post('/:id/disconnect', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')

  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not_found' }, 404)

  // Tell the runner to shut down (best-effort; offline sessions have no channel).
  const channel = getChannel(sessionId)
  if (channel) {
    try {
      channel.ws.send(JSON.stringify({ type: 'shutdown', reason: 'user_disconnect' }))
    } catch {}
  }

  // End open runs so the slot is freed. Best-effort — never blocks the offline
  // transition (the supervisor's runner.exit / #223 reconcile is the backstop).
  try {
    const { endOpenRunsForSession } = await import('../db/supervisor-dal.ts')
    await endOpenRunsForSession(sessionId, userId, 'user_disconnect')
  } catch (err: any) {
    console.error('[sessions.disconnect] failed to end open runs', err?.message)
  }

  // KEEP the row — status offline only, never soft-delete.
  await markSessionOffline(sessionId, userId)

  // Give the runner ~5s to exit gracefully before forcibly closing the socket.
  if (channel) {
    setTimeout(() => {
      const ch = getChannel(sessionId)
      if (ch) {
        try { ch.ws.close(4011, 'session disconnected by user') } catch {}
      }
    }, 5_000)
  }

  return c.json({ ok: true, status: 'offline' as const })
})

// Rotate session token — returns new raw token, invalidates old
sessions.post('/:id/rotate-token', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')

  // Verify ownership
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not found' }, 404)

  const rawToken = generateToken('remo_')
  const tokenHash = await hashToken(rawToken)
  await updateSessionToken(sessionId, tokenHash)

  // Close existing channel connection
  const channel = getChannel(sessionId)
  if (channel) {
    try { channel.ws.close(4004, 'token rotated') } catch {}
  }

  return c.json({ token: rawToken })
})

// ── Phase 10 — PATCH /api/sessions/:id/auto-nudge ────────────────────────────
// Set this session's per-session auto-nudge override. `auto_nudge: null` clears
// the override so the session inherits the user's global default
// (users.auto_nudge_idle_sessions). User-scoped: only the owner can update.
// CSRF is enforced by the global /api/* csrfGuard (hub/src/index.ts).
const AutoNudgeBody = z.object({
  auto_nudge: z.boolean().nullable(),
})

sessions.patch('/:id/auto-nudge', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const parsed = AutoNudgeBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  const updated = await setSessionAutoNudge(sessionId, userId, parsed.data.auto_nudge)
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: sessionId, auto_nudge: updated.auto_nudge })
})

// ── PATCH /api/sessions/:id/skip-permissions ─────────────────────────────────
// Per-session "bypass permissions" override (default OFF). When ON, the hub
// REQUESTS --dangerously-skip-permissions on session.start; the supervisor's
// config `allow_dangerous_skip_permissions` is the HARD CEILING (applied =
// requested && allowed), so a per-session opt-in can never exceed the host
// config. User-scoped: only the owner can update. CSRF via the global /api/*
// csrfGuard (hub/src/index.ts). Mirrors the auto-nudge PATCH shape.
const SkipPermsBody = z.object({
  enabled: z.boolean(),
})

sessions.patch('/:id/skip-permissions', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const parsed = SkipPermsBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  const updated = await setSessionSkipPermissions(sessionId, userId, parsed.data.enabled)
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: sessionId, dangerously_skip_permissions: updated.dangerously_skip_permissions })
})

// ── Phase 16 — per-session runner type (opt-in; default stream-json) ──────────
const RunnerTypeBody = z.object({
  runner_type: z.enum(['stream-json', 'pty-interactive']),
})

// PATCH the session's runner_type. Opt-in per session. A Telegram-default
// session cannot be switched to 'pty-interactive' (R-PTY-11 — the DAL guard
// rejects it; Phase 20 supersedes by re-sourcing Telegram onto the PTY surface).
sessions.patch('/:id/runner-type', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const parsed = RunnerTypeBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  const result = await setSessionRunnerType(sessionId, userId, parsed.data.runner_type)
  if (!result) return c.json({ error: 'not_found' }, 404)
  if ('error' in result) {
    // Telegram-default guard tripped — 409 Conflict (the session is reserved for
    // the stream-json Telegram bridge this phase).
    return c.json({ error: result.error }, 409)
  }
  return c.json({ id: sessionId, runner_type: result.runner_type })
})

// GET the persisted runner identity (runner_type + backend id + transcript
// path). The resume path READS this so a session is re-bound to the SAME
// backend on reconnect/restart — never dual-spawned or mis-routed (H10).
sessions.get('/:id/runner-identity', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const identity = await getSessionPtyIdentity(sessionId, userId)
  if (!identity) return c.json({ error: 'not_found' }, 404)
  return c.json({ id: sessionId, ...identity })
})

// ── Phase 04 plan 008 — POST /api/sessions/heal ──────────────────────────────
// The external claude-code-self-heal service (port 9114) calls this to launch
// a fresh session on whatever target is available, deterministically. See
// docs/self-heal-integration.md for the consumer contract.
const HealBody = z.object({
  repo: z.string().min(1).max(500),
  branch: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  model: z.string().max(120).optional(),
  exclude_supervisor_ids: z.array(z.string()).max(20).optional(),
})

const HEAL_MAX_HOPS = 3

sessions.post('/heal', async (c) => {
  const userId = c.get('userId') as string
  const parsed = HealBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }
  const { repo, branch, prompt, model } = parsed.data

  // Build a mutable exclude list so we can extend it on WS dispatch failure
  // and re-route to the next supervisor (up to HEAL_MAX_HOPS attempts).
  const exclude = new Set<string>(parsed.data.exclude_supervisor_ids ?? [])

  for (let hop = 0; hop < HEAL_MAX_HOPS; hop++) {
    const pick = await pickSessionTarget(userId, {
      excludeSupervisorIds: Array.from(exclude),
      // Consume the run row atomically inside the reservation tx (closes the
      // over-admission race — see budget.ts reserveSessionSlot).
      runFields: {
        sessionId: null,
        repoPath: repo,
        branch,
        pulled: false,
        initialPrompt: prompt,
      },
    })

    if (pick.kind === 'quota_blocked') {
      return c.json({
        error: 'quota_threshold_reached',
        reason: pick.reason,
        utilization_pct: pick.utilization_pct,
        threshold_pct: pick.threshold_pct,
        resets_at: pick.resets_at,
      }, 503)
    }

    if (pick.kind === 'none') {
      return c.json({ error: 'no_target_available' }, 503)
    }

    if (pick.kind === 'supervisor') {
      // Run row already consumed atomically inside the reservation tx.
      if (!pick.run) {
        return c.json({ error: 'run_insert_failed' }, 500)
      }
      const run = pick.run

      const skipPerms = await getSessionSkipPermissionsByRepo(userId, repo)
      try {
        sendToSupervisor(pick.supervisor_id, {
          type: 'session.start',
          req_id: run.id,
          run_id: run.id,
          repo_path: repo,
          branch,
          pull: false,
          initial_prompt: prompt,
          api_key: '__use_local__',
          hub_url: '__same__',
          dangerously_skip_permissions: skipPerms,
          ...(model ? { model } : {}),
        } as any)
      } catch (err: any) {
        // WS write failed — release the slot and the run row, then exclude
        // this supervisor from the next hop and retry.
        try {
          const { endRun } = await import('../db/supervisor-dal.ts')
          await endRun(run.id, null, `dispatch_failed: ${err?.message ?? 'unknown'}`)
        } catch {}
        await releaseSessionSlot(userId, pick.supervisor_id)
        exclude.add(pick.supervisor_id)
        continue
      }

      try { await updateSupervisorState(pick.supervisor_id, 'starting', run.id) } catch {}

      return c.json({
        session_id: run.id,
        target_kind: 'supervisor' as const,
        supervisor_id: pick.supervisor_id,
        url: `/s/${run.id}`,
      }, 202)
    }

    // pick.kind === 'local_agent'
    return c.json({
      session_id: pick.agent_session_id,
      target_kind: 'local_agent' as const,
      url: `/s/${pick.agent_session_id}`,
    }, 202)
  }

  // Exhausted hop budget — every supervisor we tried failed to dispatch.
  return c.json({ error: 'no_target_available', reason: 'all_dispatches_failed' }, 503)
})

// ── Phase 08 §16 — POST /api/sessions/:id/launch ─────────────────────────────
// Hub→supervisor `session.launch` directive. The supervisor spawns the runner
// against the canonical local_path resolved from its most recent inventory.
// Returns 202 immediately; the UI listens for `session.launch_failed` (e.g.
// `local_path_missing`) over its websocket. Per ARCHITECTURE §16, the hub does
// NOT pre-validate `cwd` existence on disk — the supervisor owns disk truth.

const LaunchBody = z.object({
  cli_kind: z.enum(['claude', 'codex']).optional(),
  /**
   * Phase 08.6 — user-picked worktree path. Must be one of the supervisor's
   * known local paths for this session's `repo_key`; falls back to the
   * canonical inventory path when omitted.
   */
  local_path: z.string().max(4096).optional(),
})

// In-memory one-shot launch nonces (per ARCHITECTURE §16 — the session token
// is never exposed to clients; we mint a per-run nonce instead). The
// supervisor doesn't validate this against anything today; it's reserved for
// future supervisor → hub re-auth. Memory-only.
const launchNonces = new Map<string, { user_id: string; session_id: string; expires: number }>()
function mintLaunchNonce(userId: string, sessionId: string): string {
  const nonce = `launch_${randomUUID()}`
  launchNonces.set(nonce, { user_id: userId, session_id: sessionId, expires: Date.now() + 5 * 60_000 })
  return nonce
}

// List git branches for a session's bound repo. Mirrors the Connect/Start flow
// branch source (`supervisors/:id/branches` → `repo.list_branches`) but keyed by
// session, so the scheduled-task editor can offer the SAME repo→branch picker
// the launch dialog does. Resolves the session's working tree (repo_key →
// supervisor inventory canonical, else recorded project_dir) and the supervisor
// hosting it (live host, else the user's first online supervisor). Read-only;
// returns `{ branches, current }`. Empty/offline → `{ branches: [], current: null }`
// so the editor falls back to a free-text branch input (never blocks the form).
sessions.get('/:id/branches', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not_found' }, 404)

  // Resolve the repo working tree the same way /launch does.
  const repoKey = (session as any).repo_key as string | null
  let cwd: string | null = repoKey ? resolveLocalPathForRepoKey(userId, repoKey) : null
  const inventoryHasRepo = !!repoKey && getKnownLocalPathsForRepoKey(userId, repoKey).length > 0
  if (!cwd && !inventoryHasRepo) cwd = (session as any).project_dir ?? null
  if (!cwd) return c.json({ branches: [], current: null })

  // Prefer the supervisor currently hosting the session; fall back to the
  // user's first online supervisor (branches live on disk regardless of host).
  const hosted = findSupervisorForSession(sessionId)
  const supervisorId =
    hosted?.userId === userId && hosted.supervisorId
      ? hosted.supervisorId
      : listOnlineSupervisorIdsForUser(userId)[0]
  if (!supervisorId) return c.json({ branches: [], current: null })

  try {
    const res: any = await sendRequest(
      supervisorId,
      { type: 'repo.list_branches', repo_path: cwd } as any,
      15_000,
    )
    if (!res?.ok) return c.json({ branches: [], current: null })
    return c.json({ branches: res.data?.branches || [], current: res.data?.current || null })
  } catch {
    return c.json({ branches: [], current: null })
  }
})

sessions.post('/:id/launch', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const parsed = LaunchBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)

  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not_found' }, 404)

  // Already online? Refuse — caller should disconnect first.
  if ((session as any).status === 'online') {
    return c.json({ error: 'already_online' }, 409)
  }

  // Resolve target supervisor (first online for this user — multi-host out of
  // scope for v1; future plan can extend with a `hostname` filter).
  const supervisorIds = listOnlineSupervisorIdsForUser(userId)
  if (supervisorIds.length === 0) {
    return c.json({ error: 'supervisor_offline' }, 409)
  }
  const supervisorId = supervisorIds[0]

  // Resolve cwd: prefer caller-supplied local_path (must match inventory),
  // then repo_key → inventory canonical, then session.project_dir (legacy).
  const repoKey = (session as any).repo_key as string | null
  let cwd: string | null = null
  if (parsed.data.local_path && repoKey) {
    const known = getKnownLocalPathsForRepoKey(userId, repoKey)
    const requested = parsed.data.local_path
    if (known.some((k) => k.local_path === requested)) cwd = requested
    else return c.json({ error: 'invalid_local_path', detail: 'path not in supervisor inventory for this repo' }, 400)
  }
  if (!cwd && repoKey) cwd = resolveLocalPathForRepoKey(userId, repoKey)
  // Fall back to the session's recorded project_dir ONLY when the supervisor
  // inventory has nothing for this repo (cold start, or pre-canonical-flag
  // supervisor). If the inventory DOES list this repo but the resolver still
  // returned null, every candidate was a worktree — trusting a stale
  // project_dir here is exactly the bug that stranded sessions in a worktree,
  // so we refuse and report local_path_missing instead.
  const inventoryHasRepo = !!repoKey && getKnownLocalPathsForRepoKey(userId, repoKey).length > 0
  if (!cwd && !inventoryHasRepo) cwd = (session as any).project_dir ?? null
  if (!cwd) {
    // Suggest where to clone (first known root for this user).
    const inv = getUserInventory(userId)
    const suggestedRoot = inv?.roots?.[0] ?? null
    return c.json({
      error: 'local_path_missing',
      repo_key: repoKey,
      suggested_clone_dir: suggestedRoot && repoKey
        ? path.join(suggestedRoot, repoKey.replace(/^github:\/\//i, '').split('/').pop() || 'repo')
        : null,
    }, 409)
  }

  // Note: `cli_kind` (body override / session default) is intentionally not on
  // the wire — `session.start` resolves the CLI kind supervisor-side via its
  // inventory, the same as every other start sender. The body field is still
  // accepted (LaunchBody) for forward-compat and to preserve the API contract.

  // Protocol-drift fix (2026-05-30): the supervisor's message switch has NO
  // `case 'session.launch'` — the Phase-08 §16 `session.launch` directive was
  // never implemented supervisor-side, so the old emit was silently dropped and
  // no runner ever spawned (the "can't connect" prod report). Emit the canonical
  // `session.start` (the only handled spawn type) instead, mirroring every other
  // start sender (api/supervisors.ts, telegram/launch.ts, scheduler, orchestrator
  // auto-launch). Runner↔session binding is by `repo_path`/project_dir match in
  // the supervisor's session_inventory push — identical to those senders — so the
  // resolved `cwd` (canonical-clone-preferring, worktree-safe) is what binds the
  // spawned runner to THIS session's working tree. `session.start` carries no
  // top-level session_id or cli_kind (resolved supervisor-side via inventory),
  // matching the wire type in ws/supervisor-protocol.ts.
  //
  // Mint the launch nonce for parity with the prior contract / future re-auth,
  // but the wire api_key is the `__use_local__` sentinel the supervisor expects
  // (it uses its own configured key), same as the other start senders.
  void mintLaunchNonce(userId, sessionId)

  // Concurrency gate — MUST come before createRun, exactly as the other
  // session.start senders (api/supervisors.ts, telegram/launch.ts).
  // Reserve + consume the run row atomically inside the FOR-UPDATE tx.
  //
  // Bind the REAL session_id (we have it — see mintLaunchNonce above). Reserving
  // this row with `session_id = NULL` made it indistinguishable from an orphan:
  // `finalizeOrphanedRunsForSupervisor` reaps every NULL-session row 30s past
  // creation (correctly — a NULL row can never appear in supervisor inventory,
  // and leaked ones wedged every launch at `at_capacity`). But THIS run is alive,
  // so closing its row makes `budget.ts` — which counts open runs — UNDER-count
  // the supervisor's concurrency, silently over-admitting past the cap. Binding
  // the id lets the reaper match the row against live inventory and leave it be.
  let reservation
  try {
    reservation = await reserveSessionSlot(userId, supervisorId, {
      sessionId,
      repoPath: cwd,
      branch: null,
      pulled: false,
      initialPrompt: null,
    })
  } catch (err: any) {
    return c.json({ error: 'run_insert_failed', detail: err?.message ?? String(err) }, 500)
  }
  if (!reservation.ok) {
    if (reservation.reason === 'at_capacity') {
      return c.json({ error: 'at_capacity', running: reservation.running, cap: reservation.cap }, 429)
    }
    return c.json({ error: 'supervisor_offline' }, 409)
  }
  if (!reservation.run) {
    return c.json({ error: 'run_insert_failed' }, 500)
  }
  const run_id = reservation.run.id

  try {
    sendToSupervisor(supervisorId, {
      type: 'session.start',
      req_id: run_id,
      run_id,
      repo_path: cwd,
      branch: undefined,
      pull: false,
      initial_prompt: undefined,
      api_key: '__use_local__', // sentinel — supervisor uses its configured key
      hub_url: '__same__',
      // Per-session bypass-permissions REQUEST (default OFF). The supervisor's
      // config `allow_dangerous_skip_permissions` is the hard ceiling
      // (applied = requested && allowed).
      dangerously_skip_permissions: (session as any).dangerously_skip_permissions === true,
    } as any)
  } catch (err: any) {
    try {
      const { endRun } = await import('../db/supervisor-dal.ts')
      await endRun(run_id, null, `dispatch_failed: ${err?.message ?? 'unknown'}`)
    } catch {}
    await releaseSessionSlot(userId, supervisorId)
    return c.json({ error: 'dispatch_failed', detail: err?.message ?? 'unknown' }, 503)
  }

  try { await updateSupervisorState(supervisorId, 'starting', run_id) } catch {}

  return c.json({ launching: true, run_id }, 202)
})

// ── Phase 08 §16 — POST /api/sessions/:id/clone-here ────────────────────────
// Reuses the existing `repo.clone` supervisor message; supervisor re-scans
// after clone completes and emits a fresh `supervisor.repo_inventory`.

const CloneHereBody = z.object({
  target_root: z.string().max(1024).optional(),
})

sessions.post('/:id/clone-here', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not_found' }, 404)

  const repoKey = (session as any).repo_key as string | null
  if (!repoKey) {
    return c.json({ error: 'no_repo_key', detail: 'session is not GitHub-keyed' }, 400)
  }
  const owner = (session as any).github_owner as string | null
  const repoName = (session as any).github_repo as string | null
  if (!owner || !repoName) {
    return c.json({ error: 'missing_owner_or_repo' }, 400)
  }

  const inv = getUserInventory(userId)
  if (!inv) return c.json({ error: 'supervisor_offline_or_no_inventory' }, 409)
  const supervisorIds = listOnlineSupervisorIdsForUser(userId)
  if (supervisorIds.length === 0) return c.json({ error: 'supervisor_offline' }, 409)
  const supervisorId = supervisorIds[0]

  const body = await c.req.json().catch(() => ({}))
  const parsed = CloneHereBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_input' }, 400)

  const targetRoot = parsed.data.target_root ?? inv.roots[0]
  if (!targetRoot) return c.json({ error: 'no_root_configured' }, 400)
  if (!inv.roots.includes(targetRoot)) {
    return c.json({ error: 'target_root_not_in_inventory' }, 400)
  }
  const targetPath = path.join(targetRoot, repoName)
  const cloneUrl = `https://github.com/${owner}/${repoName}.git`
  const reqId = randomUUID()

  try {
    sendToSupervisor(supervisorId, {
      type: 'repo.clone',
      req_id: reqId,
      clone_url: cloneUrl,
      target_path: targetPath,
      repo_full_name: `${owner}/${repoName}`,
    })
  } catch (err: any) {
    return c.json({ error: 'dispatch_failed', detail: err?.message }, 503)
  }
  return c.json({ cloning: true, req_id: reqId, target_path: targetPath }, 202)
})

// ── Phase 08 §6 — POST /api/sessions/:id/create-github-repo ─────────────────
// Validates GitHub App scope via the gateway pair; if missing
// `administration: write` → 412. Otherwise enqueues an in-memory background
// job that creates the empty remote via Octokit and asks the supervisor to
// push the initial commit. Progress streams to the user via WS
// `repo_create_progress { job_id, stage, percent }`.

const CreateGithubRepoBody = z.object({
  visibility: z.enum(['private', 'public']).default('private'),
  org: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100).optional(),
})

sessions.post('/:id/create-github-repo', async (c) => {
  const userId = c.get('userId') as string
  const sessionId = c.req.param('id')
  const session = await getSession(sessionId, userId)
  if (!session) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = CreateGithubRepoBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_input', detail: parsed.error.issues[0]?.message }, 400)
  }

  // Gate: must have a local_path to push from.
  const projectDir = (session as any).project_dir as string | null
  const repoKey = (session as any).repo_key as string | null
  let localPath: string | null = repoKey ? resolveLocalPathForRepoKey(userId, repoKey) : null
  if (!localPath) localPath = projectDir
  if (!localPath) return c.json({ error: 'local_path_missing' }, 409)

  const supervisorIds = listOnlineSupervisorIdsForUser(userId)
  if (supervisorIds.length === 0) return c.json({ error: 'supervisor_offline' }, 409)

  // Probe GitHub App scope (cached 5min).
  const scope = await probeGithubAppScope()
  if (!scope.hasAdminWrite) {
    return c.json({
      error: 'github_app_missing_scope',
      missing_scope: 'administration:write',
      kind: scope.kind,
      detail: 'GitHub App installation does not have `administration: write`. Re-install with the required permission or configure a PAT in Settings → Integrations → GitHub.',
    }, 412)
  }

  const name = parsed.data.name ?? path.basename(localPath)
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return c.json({ error: 'invalid_repo_name' }, 400)
  }

  const job = enqueueCreateGithubRepoJob({
    user_id: userId,
    session_id: sessionId,
    local_path: localPath,
    name,
    visibility: parsed.data.visibility,
    org: parsed.data.org,
  })

  return c.json({ job_id: job.job_id, status: 'queued' as const }, 202)
})

export { sessions }
