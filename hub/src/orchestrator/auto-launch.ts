// hub/src/orchestrator/auto-launch.ts
//
// orchestrator-autolaunch (2026-05-28)
//
// One shared `launchOrchestrator` primitive, used by THREE call paths:
//   1. machine-triggered auto-launch on `supervisor.hello` (this file's
//      `maybeAutoLaunchOrchestrator`),
//   2. the interactive REST `POST /api/orchestrator/start`,
//   3. Telegram autoheal when the default target IS the orchestrator session.
//
// All three converge here so the cost-cap / concurrency gate (`reserveSessionSlot`)
// and the `session_runs` ledger (orphan-resume eligibility) apply uniformly.
// The pre-existing REST `/start` bypassed both — this fixes that gap.
//
// Security (PLAN §4.3): the machine path mints the full-power orchestrator key
// WITHOUT step-up, gated ONLY on the persisted `orchestrator_enabled &&
// !orchestrator_disabled_explicitly` flag. A valid supervisor `api_keys`
// connection already spawns arbitrary FS-access Claude processes, so the
// orchestrator key grants no escalation; the one thing step-up protects —
// turning the feature ON — stays behind the interactive cookie+step-up `PUT`.
//
// Idempotency (PLAN §4.1 / Invariant I1): exactly one open orchestrator session
// per user, enforced by `idx_sessions_orchestrator_unique`. Concurrent
// supervisor.hello connects race on the INSERT; the loser catches the 23505
// unique violation and reuses the winner's row — never a second spawn.

import { sql } from '../db/postgres.ts';
import { generateToken } from '../utils/token.ts';
import { hashToken } from '../lib/crypto.ts';
import {
  getOrchestratorState,
  findOpenOrchestratorSession,
} from '../db/orchestrator-dal.ts';
import { buildOrchestratorPrompt } from './seed-prompt.ts';
import {
  getSupervisor,
  isSupervisorOnline,
  sendToSupervisor,
  updateSupervisorState,
} from '../ws/supervisor-registry.ts';
import { listSupervisorsForUser } from '../db/supervisor-dal.ts';
import { markOrchestratorSession } from '../ws/idle-teardown.ts';
import { getSessionSkipPermissions } from '../db/dal.ts';

function publicHubUrl(): string {
  return (process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com').replace(/\/+$/, '');
}

export type LaunchOrchestratorResult =
  | { ok: true; sessionId: string; runId: string; supervisorId: string; cwd: string; reused: boolean }
  | { ok: false; reason: 'disabled' }
  | { ok: false; reason: 'no_online_supervisor' }
  | { ok: false; reason: 'supervisor_has_no_roots' }
  | { ok: false; reason: 'already_running'; sessionId: string }
  | { ok: false; reason: 'at_capacity'; running: number; cap: number }
  | { ok: false; reason: 'send_failed'; error: string }
  | { ok: false; reason: 'internal_error'; error: string };

/**
 * Resolve cwd + supervisor: prefer the explicitly-requested supervisor (when
 * online), else the user's `preferred_supervisor_id` (when online), else the
 * first online supervisor. cwd is that supervisor's `roots[0]`.
 *
 * Reads roots from the in-memory registry entry first (authoritative, freshest)
 * and falls back to the DB supervisor row.
 */
async function resolveTarget(
  userId: string,
  preferSupervisorId?: string,
): Promise<
  | { ok: true; supervisorId: string; cwd: string; hostname: string }
  | { ok: false; reason: 'no_online_supervisor' | 'supervisor_has_no_roots' }
> {
  const all = (await listSupervisorsForUser(userId)) as Array<{
    id: string;
    hostname: string;
    roots?: string[];
  }>;
  const online = all.filter((s) => isSupervisorOnline(s.id));
  if (online.length === 0) return { ok: false, reason: 'no_online_supervisor' };

  const preferredRow = await sql<{ preferred_supervisor_id: string | null }[]>`
    SELECT preferred_supervisor_id FROM users WHERE id = ${userId}
  `;
  const preferredId = preferSupervisorId ?? preferredRow[0]?.preferred_supervisor_id ?? null;

  const target =
    (preferSupervisorId && online.find((s) => s.id === preferSupervisorId)) ||
    (preferredId && online.find((s) => s.id === preferredId)) ||
    online[0]!;

  const entry = getSupervisor(target.id);
  const roots: string[] = (entry?.roots && entry.roots.length > 0)
    ? entry.roots
    : (Array.isArray(target.roots) ? target.roots : []);
  if (roots.length === 0) return { ok: false, reason: 'supervisor_has_no_roots' };

  return { ok: true, supervisorId: target.id, cwd: roots[0]!, hostname: String(target.hostname || '') };
}

/**
 * The shared launch primitive. Resolves target, reserves a slot, find-or-creates
 * the session row, creates a `session_runs` row LINKED to the session (so the
 * orphan-resume path can recognise + respawn it on reconnect), mints the key,
 * builds the prompt, and dispatches the orchestrator `session.start`.
 *
 * `requireEnabled` (default true): the machine path passes true so the gate also
 * honours the explicit-disable sentinel. The interactive REST `/start` performs
 * its own `orchestrator_disabled` 409 BEFORE calling, so it may pass true too.
 *
 * `skipIfRunning` (default true): when an orchestrator session is already live
 * (status online/thinking) returns `already_running` rather than re-spawning.
 */
export async function launchOrchestrator(args: {
  userId: string;
  preferSupervisorId?: string;
  requireEnabled?: boolean;
  skipIfRunning?: boolean;
}): Promise<LaunchOrchestratorResult> {
  const requireEnabled = args.requireEnabled ?? true;
  const skipIfRunning = args.skipIfRunning ?? true;

  try {
    const prefs = await getOrchestratorState(args.userId);
    if (requireEnabled && (!prefs.orchestrator_enabled || prefs.orchestrator_disabled_explicitly)) {
      return { ok: false, reason: 'disabled' };
    }

    const existing = await findOpenOrchestratorSession(args.userId);
    if (skipIfRunning && existing && (existing.status === 'online' || existing.status === 'thinking')) {
      return { ok: false, reason: 'already_running', sessionId: existing.id };
    }

    const target = await resolveTarget(args.userId, args.preferSupervisorId);
    if (!target.ok) return { ok: false, reason: target.reason };

    const rawHubApiKey = generateToken('remokey_');

    // ── Serialized launch critical section ──────────────────────────────────
    // `idx_sessions_orchestrator_unique` guarantees one SESSION row but NOT one
    // RUN. Two DISTINCT supervisors helloing in the race window would otherwise
    // BOTH reuse the session row and BOTH reserve + createRun + mint + send →
    // two full-power Claude processes on one session_id, 2× cost, and the second
    // mint revoking the first run's key mid-session. `reserveSessionSlot`'s
    // FOR UPDATE is per-supervisor, so it does NOT serialize across supervisors.
    //
    // We close the window with a per-user `pg_advisory_xact_lock` held for the
    // whole find-or-create → run-existence re-check → reserve → createRun → mint
    // transaction. After the lock, if an OPEN orchestrator run already exists
    // (the winner launched), the loser NO-OPS. Everything DB-side runs on `tx`
    // so it's inside the locked transaction; the supervisor send happens after
    // commit. Single-host users hit the lock uncontended → no added latency.
    const txResult = await sql.begin(async (tx: any) => {
      // Per-user mutex. hashtext → int4; bigint cast keeps the 1-arg signature.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'orchestrator:' + args.userId})::bigint)`;

      // (1) find-or-create the session row, inside the lock.
      let sessionRow = (await tx`
        SELECT id, name, project_dir, status, cli_kind, is_rootless, hostname, is_orchestrator
        FROM sessions
        WHERE user_id = ${args.userId} AND is_orchestrator = true AND deleted_at IS NULL
        LIMIT 1
      `)[0] ?? null;
      let createdRow = false;
      if (!sessionRow) {
        const tokenHash = await hashToken(generateToken('remo_'));
        sessionRow = (await tx`
          INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, is_rootless, hostname, is_orchestrator)
          VALUES (${args.userId}, ${prefs.orchestrator_name}, ${target.cwd}, ${tokenHash}, 'claude', false, ${target.hostname}, true)
          RETURNING id, name, project_dir, status, cli_kind, is_rootless, hostname, is_orchestrator
        `)[0];
        createdRow = true;
      }

      // (2) RE-CHECK: does an OPEN run already exist for this orchestrator
      //     session? If so the winner already launched — loser no-ops.
      const openRun = (await tx`
        SELECT id FROM session_runs
        WHERE session_id = ${sessionRow.id} AND ended_at IS NULL
        LIMIT 1
      `)[0] ?? null;
      if (openRun) {
        return { kind: 'noop_existing_run' as const, sessionId: sessionRow.id };
      }

      // (3) Concurrency gate — replicate reserveSessionSlot's cap math on `tx`
      //     so it is INSIDE the advisory lock (the module helper opens its own
      //     per-supervisor transaction and would not serialize across hosts).
      const supRows = await tx`
        SELECT concurrency_budget, concurrency_override
        FROM supervisors
        WHERE id = ${target.supervisorId} AND user_id = ${args.userId}
        FOR UPDATE
      `;
      const sup = supRows[0];
      if (!sup) return { kind: 'no_supervisor' as const };
      const budget = Math.max(1, Number(sup.concurrency_budget ?? 1));
      const override = sup.concurrency_override == null ? null : Math.max(1, Number(sup.concurrency_override));
      const cap = Math.min(override ?? budget, budget * 2);
      const running = Number((await tx`
        SELECT COUNT(*)::text AS running FROM session_runs
        WHERE supervisor_id = ${target.supervisorId} AND ended_at IS NULL
      `)[0]?.running ?? 0);
      if (running >= cap) {
        return { kind: 'at_capacity' as const, running, cap };
      }

      // (4) Run row linked to the orchestrator session (orphan-resumable).
      const run = (await tx`
        INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, branch, pulled, initial_prompt, restart_of, restart_count)
        VALUES (${args.userId}, ${sessionRow.id}, ${target.supervisorId}, ${target.cwd}, ${null}, false, ${null}, ${null}, 0)
        RETURNING id
      `)[0];

      // (5) Mint the full-power hub key (revoke prior active orchestrator key).
      //     Inside the lock so the loser can never revoke the winner's key.
      const hubApiKeyHash = await hashToken(rawHubApiKey);
      await tx`
        UPDATE api_keys SET revoked_at = now()
        WHERE user_id = ${args.userId} AND purpose = 'orchestrator' AND revoked_at IS NULL
      `;
      await tx`
        INSERT INTO api_keys (user_id, key_hash, name, purpose, capabilities)
        VALUES (${args.userId}, ${hubApiKeyHash}, 'orchestrator', 'orchestrator', ARRAY['agent','supervisor','orchestrator'])
      `;

      return {
        kind: 'launched' as const,
        sessionId: sessionRow.id as string,
        runId: run.id as string,
        createdRow,
      };
    });

    if (txResult.kind === 'noop_existing_run') {
      // The winning supervisor already launched this orchestrator. Mark exempt
      // (idempotent) and report a non-spawning result so the loser does nothing.
      markOrchestratorSession(txResult.sessionId);
      return { ok: false, reason: 'already_running', sessionId: txResult.sessionId };
    }
    if (txResult.kind === 'no_supervisor') {
      return { ok: false, reason: 'no_online_supervisor' };
    }
    if (txResult.kind === 'at_capacity') {
      return { ok: false, reason: 'at_capacity', running: txResult.running, cap: txResult.cap };
    }

    const { sessionId, runId, createdRow } = txResult;
    const reused = !createdRow;

    // Mark for idle-teardown exemption (the orchestrator is not a WS subscriber).
    markOrchestratorSession(sessionId);

    const systemPrompt = buildOrchestratorPrompt({
      name: prefs.orchestrator_name,
      hubUrl: publicHubUrl(),
      customInstructions: prefs.orchestrator_custom_instructions,
    });

    await updateSupervisorState(target.supervisorId, 'starting', runId);

    const skipPerms = await getSessionSkipPermissions(sessionId, args.userId);
    try {
      sendToSupervisor(target.supervisorId, {
        type: 'session.start',
        req_id: runId,
        run_id: runId,
        repo_path: target.cwd,
        pull: false,
        api_key: '__use_local__',
        hub_url: '__same__',
        dangerously_skip_permissions: skipPerms,
        orchestrator: {
          session_id: sessionId,
          name: prefs.orchestrator_name,
          cwd: target.cwd,
          system_prompt: systemPrompt,
          hub_api_key: rawHubApiKey,
          hub_url: publicHubUrl(),
        },
      } as any);
    } catch (err: any) {
      return { ok: false, reason: 'send_failed', error: err?.message ?? String(err) };
    }

    return {
      ok: true,
      sessionId,
      runId,
      supervisorId: target.supervisorId,
      cwd: target.cwd,
      reused,
    };
  } catch (err: any) {
    return { ok: false, reason: 'internal_error', error: err?.message ?? String(err) };
  }
}

// Per-user reconnect-storm debounce. A flapping supervisor (or several
// supervisors for one user) can fire `supervisor.hello` repeatedly in quick
// succession; each would otherwise hit the DB find-or-create + advisory-lock
// path even though `skipIfRunning` makes the spawn itself idempotent. The
// debounce short-circuits redundant attempts within a short window so a
// reconnect storm can't hammer the launch path. `skipIfRunning` + the unique
// index remain the DURABLE correctness guards; this is purely load-shedding.
const AUTOLAUNCH_DEBOUNCE_MS = 5_000;
const lastAutoLaunchAttemptAt = new Map<string, number>();

/**
 * Machine-triggered hook, called from the `supervisor.hello` handler AFTER the
 * orphan-resume sweep (which already respawns an EXISTING orphaned orchestrator
 * run). This only fills the "no orchestrator session row exists yet" gap, so it
 * MUST NOT double-spawn:
 *
 *   - bail if the feature flag is off,
 *   - bail (debounced) if an attempt for this user fired in the last
 *     `AUTOLAUNCH_DEBOUNCE_MS` (reconnect-storm shedding),
 *   - bail if disabled / explicitly-disabled,
 *   - bail (no-op) if an open orchestrator session row already exists — the
 *     orphan-resume that ran moments earlier owns respawn of its run, and the
 *     sacred `user_stopped` guard there blocks resurrection of a Stopped run.
 *
 * Errors are swallowed — this is best-effort and MUST never tear down hello
 * (Invariant I6).
 */
export async function maybeAutoLaunchOrchestrator(args: {
  userId: string;
  supervisorId: string;
}): Promise<{ launched: boolean; reason?: string }> {
  if (process.env.REMO_ORCHESTRATOR_AUTOLAUNCH === 'false') {
    return { launched: false, reason: 'feature_flag_off' };
  }
  const now = Date.now();
  const prevAt = lastAutoLaunchAttemptAt.get(args.userId);
  if (prevAt !== undefined && now - prevAt < AUTOLAUNCH_DEBOUNCE_MS) {
    return { launched: false, reason: 'debounced' };
  }
  lastAutoLaunchAttemptAt.set(args.userId, now);
  try {
    const prefs = await getOrchestratorState(args.userId);
    if (!prefs.orchestrator_enabled || prefs.orchestrator_disabled_explicitly) {
      return { launched: false, reason: 'disabled' };
    }
    // Row already exists → orphan-resume owns the run. No-op (no double-spawn).
    const existing = await findOpenOrchestratorSession(args.userId);
    if (existing) return { launched: false, reason: 'already_exists' };

    const res = await launchOrchestrator({
      userId: args.userId,
      preferSupervisorId: args.supervisorId,
      requireEnabled: true,
      skipIfRunning: true,
    });
    if (res.ok) {
      console.log(`[orchestrator] auto-launched session=${res.sessionId} run=${res.runId} supervisor=${res.supervisorId}`);
      return { launched: true };
    }
    return { launched: false, reason: res.reason };
  } catch (err: any) {
    console.error('[orchestrator] auto-launch failed', err?.message ?? err);
    return { launched: false, reason: 'error' };
  }
}

/**
 * Test-only: clear the per-user reconnect-storm debounce map so unit tests do
 * not leak attempt timestamps across cases. Not used in production paths.
 */
export function __resetAutoLaunchDebounceForTests(): void {
  lastAutoLaunchAttemptAt.clear();
}
