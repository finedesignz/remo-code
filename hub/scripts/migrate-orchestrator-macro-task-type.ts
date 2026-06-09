/**
 * Milestone TMAC (autonomous task-type macro prompts) — one-shot migration.
 *
 * The macro model REPLACES the per-orchestrator_rows micro-command model: an
 * orchestrator task now carries ONE `macro_task_type` (dev|maintenance|security|
 * brainstorming) that the controller resolves to a single autonomous macro prompt.
 *
 * The `scheduled_tasks.macro_task_type` column (DEFAULT 'dev', CHECK-constrained)
 * already lives in schema.sql (idempotent), so a normal schema apply provisions
 * it. This script exists for an explicit standalone run + a --dry-run report on a
 * DB where you don't want to re-run the full schema, and to make the intent
 * (every existing orchestrator task → 'dev') auditable.
 *
 * Behavior:
 *   1. Ensure the column + CHECK exist (idempotent DDL, same as schema.sql).
 *   2. Backfill any orchestrator task with a NULL macro_task_type → 'dev'
 *      (the column is NOT NULL DEFAULT 'dev', so this only catches a hand-crafted
 *      pre-column row; normal fleets flip 0).
 *
 * It does NOT delete orchestrator_rows — the legacy micro-rows are retired from
 * the LIVE path (controller routes through the macro path) but the row data is
 * KEPT until the migration is verified (SPEC §5, the dedicated cleanup phase).
 * No DROP/reset. Idempotent — re-running flips 0 rows.
 *
 * Usage:
 *   bun run hub/scripts/migrate-orchestrator-macro-task-type.ts            # apply
 *   bun run hub/scripts/migrate-orchestrator-macro-task-type.ts --dry-run  # report
 */

const DRY = process.argv.includes('--dry-run');

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts');

  // 1. Idempotent DDL (mirrors schema.sql).
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS macro_task_type TEXT NOT NULL DEFAULT 'dev'`;
  await sql`DO $$ BEGIN
    ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_macro_task_type_check
      CHECK (macro_task_type IN ('dev','maintenance','security','brainstorming'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`;

  const before = (await sql`
    SELECT
      count(*) FILTER (WHERE task_type = 'orchestrator')::int AS orchestrator_tasks,
      count(*) FILTER (WHERE task_type = 'orchestrator' AND macro_task_type = 'dev')::int AS dev,
      count(*) FILTER (WHERE task_type = 'orchestrator' AND macro_task_type IS NULL)::int AS null_type
    FROM scheduled_tasks
  `)[0];
  console.log('[migrate-macro-task-type] before:', before);

  if (DRY) {
    console.log(
      `[migrate-macro-task-type] DRY-RUN — would set macro_task_type='dev' on ${before.null_type} ` +
        `orchestrator task(s) with a NULL type; ${before.orchestrator_tasks} orchestrator task(s) total. ` +
        `orchestrator_rows are PRESERVED (legacy micro-rows retired from the live path only).`,
    );
    return 0;
  }

  const flipped = await sql`
    UPDATE scheduled_tasks SET macro_task_type = 'dev', updated_at = now()
    WHERE task_type = 'orchestrator' AND macro_task_type IS NULL
    RETURNING id
  `;
  console.log(`[migrate-macro-task-type] backfilled ${flipped.length} orchestrator task(s) to 'dev'.`);

  const after = (await sql`
    SELECT count(*) FILTER (WHERE task_type = 'orchestrator' AND macro_task_type IS NOT NULL)::int AS typed
    FROM scheduled_tasks
  `)[0];
  console.log('[migrate-macro-task-type] after:', after);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[migrate-macro-task-type] FAILED:', err?.message ?? err);
    process.exit(1);
  });
