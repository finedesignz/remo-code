/**
 * BSA-06 — operator one-shot: PREPARE an autospawn BUILD-continuation task.
 *
 * Milestone "Orchestrator Build-Session Autospawn". The autospawn capability only
 * acts on a BUILD macro (`scheduled_tasks.macro_task_type='dev'`) whose repo is on
 * the per-user `orchestrator_autospawn_allowlist` (fail-closed: empty ⇒ nothing
 * autospawns). The 31 live prod orchestrator tasks are monitoring tasks, NOT 'dev',
 * so they are never eligible. This script makes ONE build-continuation task land on
 * the autospawn inject path by, idempotently:
 *
 *   1. ADDING the repo_ident to the user's autospawn allowlist
 *      (addRepoToAutospawnAllowlist — ON CONFLICT DO NOTHING).
 *   2. CREATING (or CONVERTING) the session's one orchestrator task to
 *      macro_task_type='dev' on the given schedule, ENABLED.
 *
 * It changes DATA ONLY. It NEVER flips a gate: REMO_ORCHESTRATOR_ENABLED and
 * REMO_ORCHESTRATOR_AUTOSPAWN stay env flips the OWNER makes by hand, and it never
 * sets a token cap. After a successful run it prints the exact remaining manual
 * steps (token cap + env flips). No DROP / DELETE / reset. Idempotent — re-running
 * adds nothing new and reports the steady state.
 *
 * The session→repo mapping: a session's repo_ident is its `repo_key`
 * (github://owner/repo) when GitHub-keyed, else `path://<project_dir>`. Pass
 * --repo-ident to override the derived value (e.g. to allowlist the canonical repo
 * when the session is a worktree).
 *
 * Usage:
 *   bun run hub/scripts/create-autospawn-build-task.ts \
 *     --user <userId> --session <sessionId> \
 *     [--repo-ident github://owner/repo] \
 *     [--every 4 --unit hours] [--start-at <ISO>] [--name "..."] \
 *     [--dry-run]
 *
 *   # repo derived from the session row when --repo-ident omitted.
 *   bun run hub/scripts/create-autospawn-build-task.ts --user U --session S --dry-run
 *
 * Requires DATABASE_URL (or REMO_E2E_DB_URL) for a non-dry run. --dry-run still
 * needs a reachable DB to read the current state; without one it fails gracefully
 * (no mutation) and tells you to set DATABASE_URL.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry-run');

function fail(msg: string): never {
  console.error(`[create-autospawn-build-task] ERROR: ${msg}`);
  process.exit(2);
}

async function main(): Promise<number> {
  const userId = arg('user');
  const sessionId = arg('session');
  let repoIdent = arg('repo-ident');
  const every = arg('every');
  const unit = (arg('unit') ?? 'hours') as 'minutes' | 'hours' | 'days' | 'weeks' | 'months';
  const startAt = arg('start-at') ?? new Date().toISOString();
  const name = arg('name') ?? 'Build (autospawn)';

  if (!userId) fail('--user <userId> is required');
  if (!sessionId) fail('--session <sessionId> is required');

  if (!process.env.DATABASE_URL && !process.env.REMO_E2E_DB_URL) {
    fail('no DATABASE_URL / REMO_E2E_DB_URL set — refusing to run (set one and retry).');
  }
  // REMO_E2E_DB_URL → DATABASE_URL so postgres.ts (reads DATABASE_URL) connects to it.
  if (!process.env.DATABASE_URL && process.env.REMO_E2E_DB_URL) {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL;
  }

  const { sql } = await import('../src/db/postgres.ts');
  const {
    addRepoToAutospawnAllowlist,
    isRepoAutospawnAllowed,
    getOrchestratorTaskForSession,
    createOrchestratorTaskForSession,
    updateOrchestratorTaskMacroType,
  } = await import('../src/db/orchestrator-rows-dal.ts');
  const { GLOBAL_CONCURRENCY } = await import('../src/orchestrator/queue.ts');

  // 1. Resolve the session and (when not overridden) its repo_ident.
  const srows = await sql<{ user_id: string; repo_key: string | null; project_dir: string | null }[]>`
    SELECT user_id, repo_key, project_dir FROM sessions WHERE id = ${sessionId} LIMIT 1
  `;
  const session = srows[0];
  if (!session) fail(`session ${sessionId} not found`);
  if (session.user_id !== userId) fail(`session ${sessionId} is owned by ${session.user_id}, not ${userId}`);

  if (!repoIdent) {
    if (session.repo_key) repoIdent = session.repo_key;
    else if (session.project_dir) repoIdent = `path://${session.project_dir}`;
    else fail(`session ${sessionId} has neither repo_key nor project_dir — pass --repo-ident explicitly`);
  }

  // Build-eligibility bound: warn if enabling this dev task would push the user's
  // enabled BUILD-task count over the global concurrent-cycle cap (data prep only;
  // never blocks — the runtime queue is the real ceiling).
  const enabledDevCount = Number(
    (
      await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM scheduled_tasks
        WHERE user_id = ${userId} AND task_type = 'orchestrator'
          AND macro_task_type = 'dev' AND enabled = true
      `
    )[0]?.n ?? '0',
  );

  const existing = await getOrchestratorTaskForSession(userId, sessionId);
  const alreadyAllowed = await isRepoAutospawnAllowed(userId, repoIdent!);

  const schedule_rule =
    every != null
      ? { interval: Math.max(1, parseInt(every, 10) || 1), unit, start_at: startAt }
      : null;

  console.log('[create-autospawn-build-task] plan:');
  console.log(`  user_id       = ${userId}`);
  console.log(`  session_id    = ${sessionId}`);
  console.log(`  repo_ident    = ${repoIdent}  (allowlisted now: ${alreadyAllowed})`);
  console.log(`  schedule      = ${schedule_rule ? `every ${schedule_rule.interval} ${schedule_rule.unit} from ${schedule_rule.start_at}` : '(none — task fires only when its row schedule is set in the UI)'}`);
  console.log(`  existing task = ${existing ? `${existing.id} (macro_task_type=${existing.macro_task_type}, enabled=${existing.enabled})` : '(none — will create)'}`);
  console.log(`  enabled dev tasks for user (before) = ${enabledDevCount} / REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY=${GLOBAL_CONCURRENCY}`);

  const willBeEnabledDev =
    enabledDevCount + (existing && existing.macro_task_type === 'dev' && existing.enabled ? 0 : 1);
  if (willBeEnabledDev > GLOBAL_CONCURRENCY) {
    console.warn(
      `  WARNING: ${willBeEnabledDev} enabled dev tasks would exceed REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY=${GLOBAL_CONCURRENCY}; ` +
        `excess cycles wait in the routine_queue (not a failure, but they will not run concurrently).`,
    );
  }

  if (DRY) {
    console.log('[create-autospawn-build-task] DRY-RUN — no writes performed. Re-run without --dry-run to apply.');
    return 0;
  }

  // 2. APPLY (idempotent): allowlist add, then create/convert the task.
  await addRepoToAutospawnAllowlist(userId, repoIdent!);
  console.log(`[create-autospawn-build-task] allowlist: ${repoIdent} ensured present for ${userId}.`);

  let taskId: string;
  if (existing) {
    taskId = existing.id;
    if (existing.macro_task_type !== 'dev') {
      await updateOrchestratorTaskMacroType(userId, existing.id, 'dev');
      console.log(`[create-autospawn-build-task] converted task ${taskId} macro_task_type → 'dev'.`);
    } else {
      console.log(`[create-autospawn-build-task] task ${taskId} already macro_task_type='dev' (no change).`);
    }
  } else {
    const created = await createOrchestratorTaskForSession(userId, sessionId, {
      name,
      macroTaskType: 'dev',
    });
    taskId = created.id;
    console.log(`[create-autospawn-build-task] created orchestrator task ${taskId} (macro_task_type='dev').`);
  }

  // Enable the task + (when given) set its schedule. createOrchestratorTaskForSession
  // inserts enabled=false (the controller arms it); the operator wants it armed.
  await sql`
    UPDATE scheduled_tasks SET
      enabled       = true,
      schedule_rule = ${schedule_rule ? sql.json(schedule_rule as any) : sql`schedule_rule`},
      updated_at    = now()
    WHERE id = ${taskId} AND user_id = ${userId} AND task_type = 'orchestrator'
  `;
  console.log(`[create-autospawn-build-task] task ${taskId} enabled${schedule_rule ? ' + schedule set' : ''}.`);

  console.log('');
  console.log('[create-autospawn-build-task] DATA READY. Remaining MANUAL operator steps (NOT done by this script):');
  console.log('  1. Set a daily TOKEN cap for the user (BSA-04 ceiling) so an autospawn run is bounded.');
  console.log('  2. Flip the gate envs in Coolify (hub) — BOTH required, default OFF:');
  console.log('       REMO_ORCHESTRATOR_ENABLED=1');
  console.log('       REMO_ORCHESTRATOR_AUTOSPAWN=1');
  console.log('  3. Ensure a supervisor for this user is ONLINE (autospawn needs a host to spawn into).');
  console.log('  4. Redeploy the hub for the env flip to take effect, then watch routine_run_log');
  console.log(`     for command='autospawn-launch' rows on session ${sessionId}.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[create-autospawn-build-task] FAILED:', err?.message ?? err);
    process.exit(1);
  });
