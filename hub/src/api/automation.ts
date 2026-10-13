// hub/src/api/automation.ts
// PTYCAP-04-05: owner-facing automation controls (no UI; API plus env break-glass, D-17).
//
//   GET  /api/automation/kill-switch          - env flag + the caller's engaged rows (+ global)
//   POST /api/automation/kill-switch/engage   - {scope, session_id?, reason?}; NO step-up (emergency stop)
//   POST /api/automation/kill-switch/release  - same body; step-up applied at mount time (index.ts)
//   POST /api/automation/lifetime/reset       - {counter_key}; step-up applied at mount time (index.ts)
//
// Tenancy: user scope is always the caller's own id (a body user_id is never read);
// session scope verifies sessions.user_id equals the caller; global requires the
// admin role (checked here, not by prefix middleware, because user and session scope
// are open to every authenticated user). Engage writes a row only (D-07): it never
// stops a running session and this module must not import the supervisor registry.

import { Hono } from 'hono'
import { z } from 'zod'
import { sql } from '../db/postgres'
import {
  engageKillSwitch,
  releaseKillSwitch,
  getKillSwitchState,
  resetLifetimeCounter,
  type KillScope,
} from '../dispatch/automation-controls'

type Env = { Variables: { userId: string; userRole?: string } }

export const automationApi = new Hono<Env>()

const ScopeBody = z.object({
  scope: z.enum(['global', 'user', 'session']),
  session_id: z.string().min(1).max(200).optional(),
  reason: z.string().max(500).optional(),
})

const ResetBody = z.object({
  counter_key: z.string().min(1).max(300),
})

function audit(actor: string, action: string, target: string): void {
  console.log(`[automation-api] audit actor=${actor} action=${action} target=${target}`)
}

async function ownsSession(userId: string, sessionId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sessions
    WHERE id::text = ${sessionId} AND user_id::text = ${userId} AND deleted_at IS NULL
    LIMIT 1
  `
  return rows.length > 0
}

type Resolved =
  | { ok: true; scope: KillScope; sessionId: string | null; reason: string | null }
  | { ok: false; res: Response }

/** Shared body + tenancy validation for engage and release. */
async function resolveScope(c: any): Promise<Resolved> {
  const userId = c.get('userId') as string
  const parsed = ScopeBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return { ok: false, res: c.json({ error: 'invalid_input', detail: parsed.error.flatten() }, 400) }
  }
  const { scope, session_id, reason } = parsed.data
  if (scope === 'global') {
    if ((c.get('userRole') as string | undefined) !== 'admin') {
      return { ok: false, res: c.json({ error: 'forbidden', reason: 'admin_required' }, 403) }
    }
    return { ok: true, scope, sessionId: null, reason: reason ?? null }
  }
  if (scope === 'session') {
    if (!session_id) {
      return { ok: false, res: c.json({ error: 'invalid_input', detail: 'session_id required for session scope' }, 400) }
    }
    if (!(await ownsSession(userId, session_id))) {
      return { ok: false, res: c.json({ error: 'not_found' }, 404) }
    }
    return { ok: true, scope, sessionId: session_id, reason: reason ?? null }
  }
  return { ok: true, scope, sessionId: null, reason: reason ?? null }
}

automationApi.get('/kill-switch', async (c) => {
  const userId = c.get('userId') as string
  return c.json(await getKillSwitchState({ userId }))
})

automationApi.post('/kill-switch/engage', async (c) => {
  const userId = c.get('userId') as string
  const r = await resolveScope(c)
  if (!r.ok) return r.res
  const out = await engageKillSwitch({
    scope: r.scope,
    userId: r.scope === 'global' ? null : userId,
    sessionId: r.sessionId,
    reason: r.reason,
    engagedBy: userId,
  })
  audit(userId, 'kill_switch_engage', r.scope === 'session' ? `session:${r.sessionId}` : r.scope)
  return c.json({ engaged: true, alreadyEngaged: out.alreadyEngaged, scope: r.scope })
})

automationApi.post('/kill-switch/release', async (c) => {
  const userId = c.get('userId') as string
  const r = await resolveScope(c)
  if (!r.ok) return r.res
  const out = await releaseKillSwitch({
    scope: r.scope,
    userId: r.scope === 'global' ? null : userId,
    sessionId: r.sessionId,
    releasedBy: userId,
  })
  audit(userId, 'kill_switch_release', r.scope === 'session' ? `session:${r.sessionId}` : r.scope)
  return c.json({ released: out.released, scope: r.scope })
})

automationApi.post('/lifetime/reset', async (c) => {
  const userId = c.get('userId') as string
  const parsed = ResetBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'invalid_input', detail: parsed.error.flatten() }, 400)
  const out = await resetLifetimeCounter({ userId, counterKey: parsed.data.counter_key, actor: userId })
  if (!out.ok) return c.json({ error: 'unknown_counter_key' }, 404)
  audit(userId, 'lifetime_reset', parsed.data.counter_key)
  return c.json({ ok: true, counter_key: parsed.data.counter_key })
})
