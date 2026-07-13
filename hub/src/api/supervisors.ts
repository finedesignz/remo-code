import { Hono } from 'hono'
import { z } from 'zod'
import {
  listSupervisorsForUser, getSupervisor, listRunsForSupervisor,
  setSupervisorOverride, setPreferredSupervisor, setSupervisorRoots,
} from '../db/supervisor-dal'
import { validateRoots } from '../lib/roots-validate'
import { getSessionSkipPermissionsByRepo } from '../db/dal'
import {
  getSupervisor as getSupervisorRegistryEntry, isSupervisorOnline,
  sendRequest, sendToSupervisor, updateSupervisorState,
  getUserInventory, getSupervisorCircuitBreakers, getSupervisorStatusServer,
} from '../ws/supervisor-registry'
import { isGitHubAppConfigured, mintTokenizedCloneUrl } from '../auth/github-app'
import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget'
import { broadcastToUser } from '../ws/registry'

export const supervisors = new Hono()

supervisors.get('/', async (c) => {
  const userId = c.get('userId') as string
  const rows = await listSupervisorsForUser(userId)
  const enriched = rows.map((r: any) => ({
    ...r,
    online: isSupervisorOnline(r.id),
    // fix/stop-the-bleed — an OPEN spawn circuit-breaker means this supervisor is
    // refusing to spawn CLIs for those repos (silent autonomy loss in prod
    // 2026-07). Empty array = healthy, or a pre-fix supervisor that doesn't report.
    circuit_breakers: getSupervisorCircuitBreakers(r.id),
    // fix/headless-autoupdate — `{healthy:false}` means this supervisor is running
    // WITHOUT its loopback status server (bind failed, e.g. a zombie listener on
    // 9106): /sup/status is gone and it is retrying the bind. null = pre-fix
    // supervisor that doesn't report.
    status_server: getSupervisorStatusServer(r.id),
  }))
  return c.json({ supervisors: enriched })
})

async function authorizeSupervisor(c: any) {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const row = await getSupervisor(id, userId)
  if (!row) return { error: c.json({ error: 'not found' }, 404) }
  if (!isSupervisorOnline(id)) return { error: c.json({ error: 'supervisor offline' }, 503) }
  return { userId, supervisorId: id, row }
}

supervisors.post('/:id/scan', async (c) => {
  const a = await authorizeSupervisor(c)
  if ('error' in a) return a.error
  try {
    const res: any = await sendRequest(a.supervisorId, { type: 'repo.scan' } as any, 20_000)
    // The legacy `repo.scan` shape (ScannedRepo) carries no worktree/canonical
    // introspection, so the web's worktree filter (SupervisorPage) had nothing
    // to act on and clones-on-a-branch / worktrees still cluttered the list.
    // Enrich each entry from the supervisor's `repo_inventory` (already stored
    // in the registry per scan), joining by normalized local_path — no new MSI.
    if (res && Array.isArray(res.repos)) {
      res.repos = enrichScanWithInventory(res.repos, getUserInventory(a.userId)?.repos)
    }
    return c.json(res)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

/** Normalize a local path for cross-shape joins: forward slashes, no trailing
 * separator, lower-cased (Windows paths are case-insensitive). */
function normPath(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Stamp `is_worktree` / `is_canonical` onto legacy `repo.scan_result` entries by
 * joining (on normalized local_path) to the supervisor's introspection
 * `repo_inventory`. The scan shape (ScannedRepo) has no worktree metadata, so
 * without this the web's Connections worktree filter has nothing to act on and
 * worktrees / branch-checkout sibling clones clutter the list. Entries with no
 * inventory match are returned unchanged (legacy → treated as canonical/shown).
 * Exported for unit testing.
 */
export function enrichScanWithInventory(
  repos: Array<{ path: string; [k: string]: any }>,
  inventory?: Array<{ local_path: string; is_worktree: boolean; canonical?: boolean }>,
): Array<{ path: string; is_worktree?: boolean; is_canonical?: boolean; [k: string]: any }> {
  if (!Array.isArray(inventory) || inventory.length === 0) return repos
  const byPath = new Map<string, { is_worktree: boolean; canonical: boolean }>()
  for (const e of inventory) {
    byPath.set(normPath(e.local_path), { is_worktree: e.is_worktree, canonical: !!e.canonical })
  }
  return repos.map((r) => {
    const m = byPath.get(normPath(r.path))
    return m ? { ...r, is_worktree: m.is_worktree, is_canonical: m.canonical } : r
  })
}

supervisors.get('/:id/branches', async (c) => {
  const a = await authorizeSupervisor(c)
  if ('error' in a) return a.error
  const repoPath = c.req.query('repo_path')
  if (!repoPath) return c.json({ error: 'repo_path required' }, 400)
  try {
    const res: any = await sendRequest(a.supervisorId, { type: 'repo.list_branches', repo_path: repoPath } as any, 15_000)
    if (!res?.ok) return c.json({ error: res?.error || 'list failed' }, 500)
    return c.json({ branches: res.data?.branches || [], current: res.data?.current || null })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

const CloneBody = z.object({
  installation_id: z.coerce.number(), // BIGINT from postgres comes back as string
  owner: z.string().min(1),
  repo: z.string().min(1),
  target_dir_name: z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
})

supervisors.post('/:id/clone', async (c) => {
  if (!isGitHubAppConfigured()) return c.json({ error: 'github app not configured' }, 503)
  const a = await authorizeSupervisor(c)
  if ('error' in a) return a.error
  const raw = await c.req.json().catch(() => ({}))
  const body = CloneBody.safeParse(raw)
  if (!body.success) return c.json({ error: 'bad body', details: body.error.flatten(), received: raw }, 400)

  // Use first root as clone parent
  const root = (a.row.roots && a.row.roots[0]) as string | undefined
  if (!root) return c.json({ error: 'supervisor has no configured roots' }, 400)
  const target = `${root.replace(/[/\\]+$/, '')}/${body.data.target_dir_name}`
  const cloneUrl = await mintTokenizedCloneUrl(body.data.installation_id, body.data.owner, body.data.repo)
  try {
    const res: any = await sendRequest(a.supervisorId, {
      type: 'repo.clone',
      clone_url: cloneUrl,
      target_path: target,
      repo_full_name: `${body.data.owner}/${body.data.repo}`,
    } as any, 300_000)
    return c.json(res)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

const StartBody = z.object({
  repo_path: z.string().min(1),
  branch: z.string().optional(),
  pull: z.boolean().optional(),
  initial_prompt: z.string().max(8000).optional(),
})

supervisors.post('/:id/start', async (c) => {
  const a = await authorizeSupervisor(c)
  if ('error' in a) return a.error
  const body = StartBody.safeParse(await c.req.json().catch(() => ({})))
  if (!body.success) return c.json({ error: 'bad body' }, 400)

  // Phase 04 plan 003: hub-authoritative concurrency gate. Reserve atomically
  // before creating the run row so concurrent /start calls at cap can't both
  // win the race.
  // Reserve + consume the run row atomically inside the FOR-UPDATE tx.
  const reservation = await reserveSessionSlot(a.userId, a.supervisorId, {
    sessionId: null,
    repoPath: body.data.repo_path,
    branch: body.data.branch ?? null,
    pulled: body.data.pull ?? false,
    initialPrompt: body.data.initial_prompt ?? null,
  })
  if (!reservation.ok) {
    if (reservation.reason === 'supervisor_not_found') {
      return c.json({ error: 'not found' }, 404)
    }
    return c.json({
      error: 'at_capacity',
      running: reservation.running,
      cap: reservation.cap,
    }, 429)
  }
  if (!reservation.run) {
    return c.json({ error: 'run_insert_failed' }, 500)
  }

  // Concurrent runs allowed — supervisor manages N children.
  // We re-use the supervisor's own api_key (it has agent capability too); the
  // supervisor uses its locally configured key via the `__use_local__` sentinel.
  const run = reservation.run
  await updateSupervisorState(a.supervisorId, 'starting', run.id)

  const skipPerms = await getSessionSkipPermissionsByRepo(a.userId, body.data.repo_path)
  try {
    sendToSupervisor(a.supervisorId, {
      type: 'session.start',
      req_id: run.id,
      run_id: run.id,
      repo_path: body.data.repo_path,
      branch: body.data.branch,
      pull: body.data.pull ?? false,
      initial_prompt: body.data.initial_prompt,
      api_key: '__use_local__', // sentinel — supervisor uses its configured key
      hub_url: '__same__',
      dangerously_skip_permissions: skipPerms,
    } as any)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }

  // Broadcast capacity change so UI re-renders without polling.
  try {
    const snap = await getCapacitySnapshot(a.userId, a.supervisorId)
    if (snap) {
      broadcastToUser(a.userId, {
        type: 'supervisor_capacity_changed',
        supervisor_id: a.supervisorId,
        running: snap.running,
        cap: snap.cap,
      })
    }
  } catch {}

  return c.json({ run_id: run.id })
})

const StopBody = z.object({ reason: z.string().max(120).optional(), run_id: z.string().optional() })

supervisors.post('/:id/stop', async (c) => {
  const a = await authorizeSupervisor(c)
  if ('error' in a) return a.error
  const body = StopBody.safeParse(await c.req.json().catch(() => ({})))
  const reason = (body.success ? body.data.reason : 'user') || 'user'
  const runId = body.success ? body.data.run_id : undefined

  // Mark the affected open session_runs as `user_stopped` BEFORE telling the
  // supervisor to kill the CLI. This is the sacred sentinel that prevents the
  // orphan-resume path (agent.ts supervisor.hello + client.ts client connect)
  // from resurrecting a session the user explicitly killed.
  try {
    const { sql } = await import('../db/postgres')
    if (runId) {
      await sql`
        UPDATE session_runs
        SET ended_at = COALESCE(ended_at, now()), exit_reason = 'user_stopped'
        WHERE id = ${runId} AND supervisor_id = ${a.supervisorId} AND ended_at IS NULL
      `
    } else {
      // empty run_id = stop all open runs for this supervisor
      await sql`
        UPDATE session_runs
        SET ended_at = COALESCE(ended_at, now()), exit_reason = 'user_stopped'
        WHERE supervisor_id = ${a.supervisorId} AND ended_at IS NULL
      `
    }
  } catch (err: any) {
    console.error('[stop] failed to mark user_stopped', err?.message)
  }

  try {
    sendToSupervisor(a.supervisorId, {
      type: 'session.stop',
      req_id: `stop_${Date.now()}`,
      run_id: runId ?? '',  // empty string => stop all
      reason,
    } as any)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
  return c.json({ ok: true })
})

// List active runs for a supervisor (one row per running child)
supervisors.get('/:id/active', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const row = await getSupervisor(id, userId)
  if (!row) return c.json({ error: 'not found' }, 404)
  const { sql } = await import('../db/postgres')
  const rows = await sql`
    SELECT id, repo_path, branch, started_at, restart_count, session_id
    FROM session_runs
    WHERE supervisor_id = ${id} AND user_id = ${userId} AND ended_at IS NULL
    ORDER BY started_at DESC
  `
  return c.json({ runs: rows })
})

// Phase 12 W2 — PATCH /api/supervisors/:id/roots. Set the supervisor's root
// repo folder paths from the web UI. Persists to DB, then pushes set_roots
// over WS to the live supervisor connection if online (best-effort with a
// 5s timeout). Broadcasts supervisor.roots_changed so other client tabs
// re-render. CSRF is enforced by the global guard; license-gated by the
// global gate; auth verified by middleware.
// REVIEW HI-03: step-up auth (requireRecentAuth) IS now enforced via
// app.use in hub/src/index.ts — roots determine which filesystems
// supervisor scans/exposes, so stolen-cookie attack is a privilege primitive.
const RootsBody = z.object({
  roots: z.array(z.string()).max(50),
})

supervisors.patch('/:id/roots', async (c) => {
  const userId = c.get('userId') as string
  const supervisorId = c.req.param('id')
  const row = await getSupervisor(supervisorId, userId)
  if (!row) return c.json({ error: 'not_found' }, 404)

  const raw = await c.req.json().catch(() => ({}))
  const parsed = RootsBody.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400)
  }
  const v = validateRoots(parsed.data.roots)
  if (!v.ok) {
    return c.json({ error: v.error, index: (v as any).index, value: (v as any).value }, 400)
  }

  const updated = await setSupervisorRoots({ supervisorId, userId, roots: v.roots })
  if (!updated) return c.json({ error: 'not_found' }, 404)

  // Push to the live supervisor connection if any. Best-effort: a 5s timeout
  // covers most apply+ack round-trips; if offline OR ack times out, the
  // updated value remains in DB and the supervisor will pick it up on next
  // auth_ok via the standard upsert path.
  let applied: 'live' | 'queued' = 'queued'
  let supervisorError: string | null = null
  if (isSupervisorOnline(supervisorId)) {
    try {
      const ack: any = await sendRequest(
        supervisorId,
        { type: 'supervisor.set_roots', roots: v.roots } as any,
        5_000,
      )
      if (ack?.ok) applied = 'live'
      else supervisorError = ack?.error || 'set_roots_ack_failed'
    } catch (err: any) {
      supervisorError = err?.message || String(err)
    }
  }

  // Broadcast to the user's other browser tabs so the new value reflects
  // everywhere without a refresh.
  try {
    broadcastToUser(userId, {
      type: 'supervisor.roots_changed',
      supervisor_id: supervisorId,
      roots: v.roots,
    } as any)
  } catch {}

  return c.json({
    ok: true,
    applied,
    roots: v.roots,
    supervisor_error: supervisorError,
  })
})

// Phase 04 plan 002 — concurrency override (hub clamps to [1, budget*2]).
// Setting null clears the override (hub then uses raw concurrency_budget).
const OverrideBody = z.object({
  concurrency_override: z.number().int().nullable(),
})

supervisors.patch('/:id/override', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const row = await getSupervisor(id, userId)
  if (!row) return c.json({ error: 'not found' }, 404)
  const raw = await c.req.json().catch(() => ({}))
  const body = OverrideBody.safeParse(raw)
  if (!body.success) return c.json({ error: 'bad body', details: body.error.flatten() }, 400)

  const budget = Number(row.concurrency_budget ?? 1)
  const max = Math.max(1, budget * 2)
  let val = body.data.concurrency_override
  if (val !== null) {
    if (!Number.isInteger(val) || val < 1) {
      return c.json({ error: 'override_below_floor', min: 1 }, 400)
    }
    if (val > max) {
      return c.json({ error: 'override_exceeds_ceiling', max }, 400)
    }
  }
  const updated = await setSupervisorOverride({ supervisorId: id, userId, override: val })
  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json(updated)
})

// Phase 04 plan 002 — user-level preferred supervisor (consumed by Plan 008).
// Mounted at /api/users/me/preferred-supervisor (see hub/src/index.ts).
export const usersMe = new Hono()

const PreferredBody = z.object({
  supervisor_id: z.string().nullable(),
})

// Phase 12 W2 — PATCH /api/users/me/prompts. Persists auto_nudge_idle_sessions
// + instruction blobs (claude_global_md, codex_agents_md, codex_config_toml).
// codex_config_toml is secret-stripped via the same pattern as PUT /api/instructions
// (keys: api_key/apikey/token/secret/password).
const PromptsBody = z.object({
  auto_nudge_idle_sessions: z.boolean().optional(),
  claude_global_md: z.string().max(100_000).nullable().optional(),
  codex_agents_md: z.string().max(100_000).nullable().optional(),
  codex_config_toml: z.string().max(100_000).nullable().optional(),
})

const SECRET_LINE_RE = /^\s*(api[_-]?key|apikey|token|secret|password)\s*=/i
function stripSecretLines(input: string | null | undefined): { sanitized: string | null; stripped: number } {
  if (input == null) return { sanitized: null, stripped: 0 }
  const kept: string[] = []
  let stripped = 0
  for (const line of input.split(/\r?\n/)) {
    if (SECRET_LINE_RE.test(line)) { stripped++; continue }
    kept.push(line)
  }
  return { sanitized: kept.join('\n'), stripped }
}

usersMe.patch('/prompts', async (c) => {
  const userId = c.get('userId') as string
  const raw = await c.req.json().catch(() => ({}))
  const parsed = PromptsBody.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400)
  }
  const patch = { ...parsed.data } as any
  let stripped = 0
  if (patch.codex_config_toml !== undefined) {
    const r = stripSecretLines(patch.codex_config_toml)
    patch.codex_config_toml = r.sanitized
    stripped = r.stripped
  }
  const { updateUserPrompts } = await import('../db/dal')
  const updated = await updateUserPrompts(userId, patch)
  return c.json({ ...updated, stripped_secret_lines: stripped })
})

// Phase 12 W2 — PATCH /api/users/me/profile. Extended profile editor for the
// Settings → Profile tab. Validates timezone, avatar shape, notifications shape.
// (Existing PATCH /api/profile remains the canonical narrower endpoint; this
// one adds the `notifications` JSONB blob and accepts `name` as an alias for
// `display_name` for the new UI's nomenclature.)
const ProfileExtBody = z.object({
  name: z.string().max(200).nullable().optional(),
  display_name: z.string().max(200).nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  timezone: z.string().max(80).optional(),
  notifications: z.record(z.unknown()).optional(),
})

const MAX_AVATAR_BYTES_PROFILE = 1_400_000
function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

usersMe.patch('/profile', async (c) => {
  const userId = c.get('userId') as string
  const raw = await c.req.json().catch(() => ({}))
  const parsed = ProfileExtBody.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400)
  }
  const b = parsed.data
  const fields: any = {}
  // `name` is sugar for display_name. If both are provided, display_name wins.
  if (b.name !== undefined) fields.display_name = b.name
  if (b.display_name !== undefined) fields.display_name = b.display_name
  if (b.avatar_url !== undefined) {
    const v = b.avatar_url
    if (v === null || v === '') fields.avatar_url = null
    else if (typeof v !== 'string') return c.json({ error: 'invalid_avatar_url' }, 400)
    else if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) {
      return c.json({ error: 'invalid_avatar_format', message: 'avatar_url must be a data:image/* URL' }, 400)
    } else if (v.length > MAX_AVATAR_BYTES_PROFILE) {
      return c.json({ error: 'avatar_too_large', max_bytes: MAX_AVATAR_BYTES_PROFILE }, 413)
    } else {
      fields.avatar_url = v
    }
  }
  if (b.timezone !== undefined) {
    if (!isValidTz(b.timezone)) return c.json({ error: 'invalid_timezone' }, 400)
    fields.timezone = b.timezone
  }
  if (b.notifications !== undefined) fields.notifications = b.notifications

  const { updateUserProfileExt } = await import('../db/dal')
  const updated = await updateUserProfileExt(userId, fields)
  return c.json(updated)
})

usersMe.patch('/preferred-supervisor', async (c) => {
  const userId = c.get('userId') as string
  const raw = await c.req.json().catch(() => ({}))
  const body = PreferredBody.safeParse(raw)
  if (!body.success) return c.json({ error: 'bad body', details: body.error.flatten() }, 400)

  // When non-null, verify the supervisor belongs to this user. 404 on any
  // mismatch (no existence leak — cross-user PATCH attempts get the same
  // 'not found' as a non-existent id).
  if (body.data.supervisor_id !== null) {
    const row = await getSupervisor(body.data.supervisor_id, userId)
    if (!row) return c.json({ error: 'not found' }, 404)
  }
  const updated = await setPreferredSupervisor({ userId, supervisorId: body.data.supervisor_id })
  if (!updated) return c.json({ error: 'not found' }, 404)
  return c.json(updated)
})

supervisors.get('/:id/runs', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const row = await getSupervisor(id, userId)
  if (!row) return c.json({ error: 'not found' }, 404)
  const rows = await listRunsForSupervisor(id, userId, 100)
  return c.json({ runs: rows })
})
