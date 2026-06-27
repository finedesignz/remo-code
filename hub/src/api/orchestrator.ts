// hub/src/api/orchestrator.ts
// REST surface for the orchestrator-session feature.
//
//   GET  /api/orchestrator            — read prefs + current session state
//   PUT  /api/orchestrator            — update prefs (enabled/name/instructions)
//   POST /api/orchestrator/start      — pick supervisor, mint key, dispatch session.start
//   POST /api/orchestrator/stop       — send session.stop for the orchestrator's run_id
//   GET  /api/orchestrator/run-log    — paginated run-log read (OBSRV-01 / RUNLOG-01/02)
//
// License-gating: GET passes during EXPIRED grace via the existing
// `readOnlyOk: true` gate. Mutations remain ACTIVE-only and additionally
// require `requireRecentAuth()` (15-min step-up window). Recent-auth is
// applied at mount time in hub/src/index.ts.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  getOrchestratorState,
  updateOrchestratorState,
  findOpenOrchestratorSession,
} from '../db/orchestrator-dal';
import { sendToSupervisor, listOnlineSupervisorIdsForUser } from '../ws/supervisor-registry';
import { launchOrchestrator } from '../orchestrator/auto-launch';
import { listRunLog } from '../orchestrator/run-log';

export const orchestrator = new Hono();

type SessionState = 'disabled' | 'enabled_idle' | 'running';

async function snapshot(userId: string) {
  const prefs = await getOrchestratorState(userId);
  const sessionRow = await findOpenOrchestratorSession(userId);
  let status: SessionState;
  if (!prefs.orchestrator_enabled) status = 'disabled';
  else if (!sessionRow) status = 'enabled_idle';
  else status = (sessionRow.status === 'online' || sessionRow.status === 'thinking') ? 'running' : 'enabled_idle';
  return {
    enabled: prefs.orchestrator_enabled,
    name: prefs.orchestrator_name,
    custom_instructions: prefs.orchestrator_custom_instructions,
    session_id: sessionRow?.id ?? null,
    status,
  };
}

orchestrator.get('/', async (c) => {
  const userId = c.get('userId') as string;
  return c.json(await snapshot(userId));
});

const PutBody = z.object({
  enabled: z.boolean().optional(),
  name: z.string().trim().min(1).max(64).optional(),
  custom_instructions: z.string().max(8000).nullable().optional(),
});

orchestrator.put('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = PutBody.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'invalid_input', detail: body.error.flatten() }, 400);
  await updateOrchestratorState(userId, {
    orchestrator_enabled: body.data.enabled,
    orchestrator_name: body.data.name,
    orchestrator_custom_instructions:
      'custom_instructions' in body.data ? body.data.custom_instructions ?? null : undefined,
  });
  return c.json(await snapshot(userId));
});

orchestrator.post('/start', async (c) => {
  const userId = c.get('userId') as string;
  const prefs = await getOrchestratorState(userId);
  if (!prefs.orchestrator_enabled) {
    return c.json({ error: 'orchestrator_disabled' }, 409);
  }

  // Delegate to the shared primitive — this is the SAME path the machine-
  // triggered auto-launch uses, so both go through `reserveSessionSlot` +
  // `createRun` (fixing the pre-existing concurrency-gate / ledger bypass).
  const res = await launchOrchestrator({
    userId,
    requireEnabled: true,
    skipIfRunning: true,
  });

  if (res.ok) {
    return c.json({
      session_id: res.sessionId,
      run_id: res.runId,
      supervisor_id: res.supervisorId,
      cwd: res.cwd,
    }, 202);
  }

  switch (res.reason) {
    case 'disabled':
      return c.json({ error: 'orchestrator_disabled' }, 409);
    case 'already_running':
      return c.json({ session_id: res.sessionId, already_running: true }, 200);
    case 'no_online_supervisor':
      return c.json({ error: 'no_online_supervisor' }, 409);
    case 'supervisor_has_no_roots':
      return c.json({ error: 'supervisor_has_no_roots', detail: 'configure at least one root in the supervisor tray app' }, 409);
    case 'at_capacity':
      return c.json({ error: 'at_capacity', running: res.running, cap: res.cap }, 429);
    case 'send_failed':
      return c.json({ error: 'dispatch_failed', detail: res.error }, 503);
    default:
      return c.json({ error: 'internal_error', detail: res.error }, 500);
  }
});

// OBSRV-01 / RUNLOG-01/02 — read-only, user-scoped, paginated run-log.
// GET /api/orchestrator/run-log?limit=50&offset=0&session_id=<optional>
// Returns rows newest-first. Zero dispatch-path changes.
const RunLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  session_id: z.string().optional(),
});

orchestrator.get('/run-log', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = RunLogQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) return c.json({ error: 'invalid_query', detail: parsed.error.flatten() }, 400);
  const { limit, offset, session_id } = parsed.data;
  const rows = await listRunLog({ userId, sessionId: session_id ?? null, limit, offset });
  return c.json({ items: rows, limit, offset });
});

orchestrator.post('/stop', async (c) => {
  const userId = c.get('userId') as string;
  const sessionRow = await findOpenOrchestratorSession(userId);
  if (!sessionRow) return c.json({ ok: true, no_session: true });
  // Fan out a stop to every online supervisor for this user. The supervisor
  // ignores stops for run_ids it doesn't know about, so this is safe.
  const targets = listOnlineSupervisorIdsForUser(userId);
  for (const supId of targets) {
    try {
      sendToSupervisor(supId, {
        type: 'session.stop',
        req_id: `orch_stop_${Date.now()}`,
        run_id: `orchestrator:${sessionRow.id}`,
        reason: 'user_stop',
      } as any);
    } catch {}
  }
  return c.json({ ok: true });
});
