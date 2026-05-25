import { Hono } from 'hono'
import { z } from 'zod'
import {
  listSupervisorsForUser, getSupervisor, createRun, listRunsForSupervisor,
  setSupervisorOverride, setPreferredSupervisor,
} from '../db/supervisor-dal'
import {
  getSupervisor as getSupervisorRegistryEntry, isSupervisorOnline,
  sendRequest, sendToSupervisor, updateSupervisorState,
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
    return c.json(res)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

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
  const reservation = await reserveSessionSlot(a.userId, a.supervisorId)
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

  // Concurrent runs allowed — supervisor manages N children.
  // We need an api_key to pass to the supervisor so it can spawn claude-remote
  // talking to this hub. We re-use the supervisor's own api_key (it has agent capability too).
  // The supervisor sends "hello" with its api_key_id; the actual raw key is stored client-side.
  // Tell the supervisor to use its configured api_key (the supervisor already has it locally).
  const run = await createRun({
    userId: a.userId,
    sessionId: null,
    supervisorId: a.supervisorId,
    repoPath: body.data.repo_path,
    branch: body.data.branch ?? null,
    pulled: body.data.pull ?? false,
    initialPrompt: body.data.initial_prompt ?? null,
  })
  await updateSupervisorState(a.supervisorId, 'starting', run.id)

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
