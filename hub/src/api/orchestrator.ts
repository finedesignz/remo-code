// hub/src/api/orchestrator.ts
// REST surface for the orchestrator-session feature.
//
//   GET  /api/orchestrator         — read prefs + current session state
//   PUT  /api/orchestrator         — update prefs (enabled/name/instructions)
//   POST /api/orchestrator/start   — pick supervisor, mint key, dispatch session.start
//   POST /api/orchestrator/stop    — send session.stop for the orchestrator's run_id
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
  createOrchestratorSession,
  mintOrchestratorApiKey,
} from '../db/orchestrator-dal';
import { listSupervisorsForUser } from '../db/supervisor-dal';
import { isSupervisorOnline, sendToSupervisor, listOnlineSupervisorIdsForUser } from '../ws/supervisor-registry';
import { sql } from '../db/postgres';
import { generateToken } from '../utils/token';
import { hashToken } from '../lib/crypto';
import { buildOrchestratorPrompt } from '../orchestrator/seed-prompt';

export const orchestrator = new Hono();

function publicHubUrl(): string {
  return (process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com').replace(/\/+$/, '');
}

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

  // Already running? Surface it instead of re-spawning.
  const existing = await findOpenOrchestratorSession(userId);
  if (existing && (existing.status === 'online' || existing.status === 'thinking')) {
    return c.json({ session_id: existing.id, already_running: true }, 200);
  }

  // Pick a supervisor: preferred (when online) → first online.
  const preferredRow = await sql<{ preferred_supervisor_id: string | null }[]>`
    SELECT preferred_supervisor_id FROM users WHERE id = ${userId}
  `;
  const preferredId = preferredRow[0]?.preferred_supervisor_id ?? null;

  const all = await listSupervisorsForUser(userId);
  const online = all.filter((s: any) => isSupervisorOnline(s.id));
  if (online.length === 0) {
    return c.json({ error: 'no_online_supervisor' }, 409);
  }
  const target = (preferredId && online.find((s: any) => s.id === preferredId)) || online[0];

  const roots: string[] = Array.isArray((target as any).roots) ? (target as any).roots : [];
  if (roots.length === 0) {
    return c.json({ error: 'supervisor_has_no_roots', detail: 'configure at least one root in the supervisor tray app' }, 409);
  }
  const cwd = roots[0];
  const hostnameStr = String((target as any).hostname || '');

  // Either reuse existing offline row or create one. The partial unique index
  // guarantees at most one open orchestrator session per user.
  const rawSessionToken = generateToken('remo_');
  const sessionTokenHash = await hashToken(rawSessionToken);
  let sessionRow = existing;
  if (!sessionRow) {
    sessionRow = await createOrchestratorSession({
      userId,
      name: prefs.orchestrator_name,
      projectDir: cwd,
      tokenHash: sessionTokenHash,
      hostname: hostnameStr,
    });
  }

  // Mint a fresh full-power hub API key (purpose='orchestrator'). Used by
  // Claude inside the orchestrator session to reach the hub REST API.
  const rawHubApiKey = generateToken('remokey_');
  const hubApiKeyHash = await hashToken(rawHubApiKey);
  await mintOrchestratorApiKey(userId, hubApiKeyHash);

  // Build the system prompt with the user's custom append.
  const systemPrompt = buildOrchestratorPrompt({
    name: prefs.orchestrator_name,
    hubUrl: publicHubUrl(),
    customInstructions: prefs.orchestrator_custom_instructions,
  });

  // Dispatch session.start with the orchestrator extension. The supervisor
  // recognizes the field and routes env + cwd + system-prompt accordingly.
  const runId = crypto.randomUUID();
  try {
    sendToSupervisor(target.id, {
      type: 'session.start',
      req_id: runId,
      run_id: runId,
      repo_path: cwd,
      pull: false,
      api_key: '__use_local__',
      hub_url: '__same__',
      orchestrator: {
        session_id: sessionRow.id,
        name: prefs.orchestrator_name,
        cwd,
        system_prompt: systemPrompt,
        hub_api_key: rawHubApiKey,
        hub_url: publicHubUrl(),
      },
    } as any);
  } catch (err: any) {
    return c.json({ error: 'dispatch_failed', detail: err?.message ?? 'unknown' }, 503);
  }

  return c.json({
    session_id: sessionRow.id,
    run_id: runId,
    supervisor_id: target.id,
    cwd,
  }, 202);
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
