/**
 * Phase 32 (auto-dev-orchestrator) — one-shot migration that folds the LEGACY
 * many-tasks-per-session scheduled-task model (and the standalone dev / qc
 * routines) into the new orchestrator model: ONE `task_type='orchestrator'` task
 * per session + per-command `orchestrator_rows` (locked decision 3 — REPLACE).
 *
 * This is a STANDALONE one-shot. It is NOT in schema.sql (schema.sql re-runs every
 * boot — a data backfill there would re-fire destructively). Run it deliberately.
 *
 * Behavior (per session that owns ≥1 legacy ENABLED dev/qc-family task):
 *   1. Ensure exactly one orchestrator task exists for the session (create if not;
 *      the partial unique index idx_scheduled_tasks_orchestrator_unique is the
 *      backstop). Stage defaults to `development`.
 *   2. Seed orchestrator_rows from the union of commands implied by the legacy
 *      tasks (dev → plan + execute; qc → audit-fix + gsd-code-review +
 *      gsd-verify-work; security/log_check → gap-scan). Idempotent: a row for a
 *      (task_id, command) pair is only inserted when absent.
 *   3. DISABLE the migrated legacy tasks (enabled=false) so the legacy cron engine
 *      stops firing them. Rows are NOT deleted (reversible; audit trail kept).
 *
 * Idempotent + re-runnable: step 1 no-ops when the orchestrator task already
 * exists; step 2 skips commands already present; step 3 flips only still-enabled
 * legacy tasks. A second run reports 0 changes.
 *
 * SAFE: never touches `orchestrator` tasks themselves, never deletes anything,
 * never merges/deploys. --dry-run reports the plan and writes nothing.
 *
 * Usage:
 *   bun run hub/scripts/migrate-legacy-tasks-to-orchestrator.ts --dry-run  # report
 *   bun run hub/scripts/migrate-legacy-tasks-to-orchestrator.ts            # apply
 *
 * Do NOT auto-run against prod — run by hand after reviewing the dry-run output.
 */

const DRY = process.argv.includes('--dry-run');

// Legacy task_type → the orchestrator command rows it folds into. dev/qc-family
// roots only; chained step types (dev_plan, qc_review, …) are byproducts of the
// same root and need no separate rows. security/log are folded to a gap-scan.
export const LEGACY_TYPE_TO_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  dev: ['gsd-plan-phase', 'gsd-execute-phase'],
  continue_dev: ['gsd-plan-phase', 'gsd-execute-phase'],
  qc: ['gsd-audit-fix', 'gsd-code-review', 'gsd-verify-work'],
  security: ['gap-scan'],
  log_check: ['gap-scan'],
});

/** The legacy ROOT task types this migration folds (chained steps + orchestrator excluded). */
export const MIGRATABLE_LEGACY_TYPES = Object.keys(LEGACY_TYPE_TO_COMMANDS);

/**
 * Pure planner: given a session's legacy tasks, compute the set of orchestrator
 * commands to seed. De-duped, stable order. Exported for tests (no DB).
 */
export function commandsForLegacyTasks(
  legacy: { task_type: string }[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of legacy) {
    for (const cmd of LEGACY_TYPE_TO_COMMANDS[t.task_type] ?? []) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
    }
  }
  return out;
}

interface LegacyTask {
  id: string;
  user_id: string;
  session_id: string;
  task_type: string;
}

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts');
  const {
    getOrchestratorTaskForSession,
    createOrchestratorTaskForSession,
    listOrchestratorRows,
    insertOrchestratorRow,
  } = await import('../src/db/orchestrator-rows-dal.ts');

  // All ENABLED legacy root tasks bound to a session, grouped per (user, session).
  const legacy = await sql<LegacyTask[]>`
    SELECT id, user_id, session_id, task_type FROM scheduled_tasks
    WHERE enabled = true
      AND session_id IS NOT NULL
      AND task_type IN ${sql(MIGRATABLE_LEGACY_TYPES)}
    ORDER BY user_id, session_id, created_at
  `;

  const bySession = new Map<string, { userId: string; sessionId: string; tasks: LegacyTask[] }>();
  for (const t of legacy) {
    const key = `${t.user_id}:${t.session_id}`;
    const g = bySession.get(key) ?? { userId: t.user_id, sessionId: t.session_id, tasks: [] };
    g.tasks.push(t);
    bySession.set(key, g);
  }

  console.log(
    `[migrate-legacy-tasks] ${legacy.length} legacy task(s) across ${bySession.size} session(s).`,
  );

  let tasksCreated = 0;
  let rowsInserted = 0;
  let legacyDisabled = 0;

  for (const { userId, sessionId, tasks } of bySession.values()) {
    const commands = commandsForLegacyTasks(tasks);
    if (commands.length === 0) continue;

    let task = await getOrchestratorTaskForSession(userId, sessionId);
    if (!task) {
      if (DRY) {
        console.log(`[dry] session=${sessionId} → CREATE orchestrator task + rows [${commands.join(', ')}]`);
        tasksCreated++;
        rowsInserted += commands.length;
        legacyDisabled += tasks.length;
        continue;
      }
      try {
        task = await createOrchestratorTaskForSession(userId, sessionId, { stage: 'development' });
        tasksCreated++;
      } catch (err: any) {
        // Unique-violation race (concurrent run): re-read and continue.
        task = await getOrchestratorTaskForSession(userId, sessionId);
        if (!task) {
          console.warn(`[migrate-legacy-tasks] session=${sessionId} task create+reread failed: ${err?.message ?? err}`);
          continue;
        }
      }
    }

    // Seed only the commands not already present (idempotent).
    const existing = new Set((await listOrchestratorRows(task.id)).map((r) => r.command));
    let sortOrder = existing.size;
    for (const command of commands) {
      if (existing.has(command)) continue;
      if (DRY) {
        console.log(`[dry] task=${task.id} session=${sessionId} → ADD row ${command}`);
      } else {
        // Seed parked/on-demand (frequency 'Never', disabled) so migration NEVER
        // silently starts firing work — the user enables cadence in the UI. The
        // orchestrator live path is itself flag-gated (REMO_ORCHESTRATOR_ENABLED).
        await insertOrchestratorRow({
          task_id: task.id,
          command,
          enabled: false,
          frequency_label: 'Never',
          schedule_rule: null,
          sort_order: sortOrder,
        });
      }
      sortOrder++;
      rowsInserted++;
    }

    // Disable the migrated legacy tasks so the legacy engine stops firing them.
    if (!DRY) {
      const ids = tasks.map((t) => t.id);
      const flipped = await sql`
        UPDATE scheduled_tasks SET enabled = false, updated_at = now()
        WHERE id IN ${sql(ids)} AND enabled = true
        RETURNING id
      `;
      legacyDisabled += flipped.length;
    }
  }

  const verb = DRY ? 'WOULD' : 'DID';
  console.log(
    `[migrate-legacy-tasks] ${verb}: create ${tasksCreated} orchestrator task(s), ` +
      `insert ${rowsInserted} row(s), disable ${legacyDisabled} legacy task(s).`,
  );
  if (DRY) console.log('[migrate-legacy-tasks] DRY-RUN — nothing written.');
  return 0;
}

// Only run when invoked directly (so tests can import the pure helpers).
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[migrate-legacy-tasks] FAILED:', err?.message ?? err);
      process.exit(1);
    });
}
