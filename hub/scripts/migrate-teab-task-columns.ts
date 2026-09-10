/**
 * Milestone TEAB (TEAB-as-a-scheduled-task) — one-shot, additive migration.
 *
 * Adds the two additive columns that back the `task_type: 'teab'` action:
 *   - `teab_repo_ident`  — target repo for `teab run --repo <X>`.
 *   - `teab_last_status` — most recent supervisor `teab_status` poll result.
 *
 * Both columns also live in schema.sql as `ADD COLUMN IF NOT EXISTS` (so a fresh
 * boot is self-sufficient), but this one-shot is the canonical provision/verify
 * path for an existing DB you don't want to re-run the full schema against.
 *
 * Purely additive — no DROP, no reset, no data backfill. Idempotent: re-running
 * is a no-op once the columns exist. Also widens the task_type CHECK to allow
 * 'teab' (idempotent rebuild, mirrors schema.sql).
 *
 * Usage:
 *   bun run hub/scripts/migrate-teab-task-columns.ts            # apply
 *   bun run hub/scripts/migrate-teab-task-columns.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  const cols = (await sql<{ name: string }[]>`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_name = 'scheduled_tasks'
      AND column_name IN ('teab_repo_ident', 'teab_last_status')
  `).map((r) => r.name)
  const missing = ['teab_repo_ident', 'teab_last_status'].filter((c) => !cols.includes(c))
  console.log('[migrate-teab-task-columns] existing TEAB columns:', cols)

  if (DRY) {
    console.log(
      `[migrate-teab-task-columns] DRY-RUN — would add ${missing.length} column(s): ` +
        `${missing.join(', ') || '(none — already present)'}; ` +
        `and ensure the task_type CHECK allows 'teab'. No data backfill.`,
    )
    return 0
  }

  // 1. Additive columns (idempotent, mirrors schema.sql).
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS teab_repo_ident TEXT`
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS teab_last_status TEXT`

  // 2. Widen the task_type CHECK to allow 'teab' (idempotent rebuild — same set
  //    as schema.sql so the two never drift). DROP IF EXISTS is safe on fresh
  //    and prod DBs alike.
  await sql`ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_task_type_check`
  await sql`ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_task_type_check
    CHECK (task_type IN (
      'dev', 'security', 'log_check', 'qc',
      'dev_controller', 'dev_plan', 'dev_execute', 'dev_ship',
      'security_scan', 'security_triage', 'security_fix_or_issue',
      'log_pull', 'log_classify', 'log_triage',
      'qc_review', 'qc_fix', 'qc_verify',
      'orchestrator',
      'teab',
      'triage'
    ))`

  const after = (await sql<{ name: string }[]>`
    SELECT column_name AS name
    FROM information_schema.columns
    WHERE table_name = 'scheduled_tasks'
      AND column_name IN ('teab_repo_ident', 'teab_last_status')
  `).map((r) => r.name)
  console.log('[migrate-teab-task-columns] after — TEAB columns present:', after)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[migrate-teab-task-columns] FAILED:', err?.message ?? err)
    process.exit(1)
  })
