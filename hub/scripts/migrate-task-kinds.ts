/**
 * Phase 11 — one-shot data migration: rewrite legacy `scheduled_tasks.task_type`
 * values to the new triad.
 *
 *   'prompt'       → 'dev'
 *   'skill'        → 'dev'
 *   'continue_dev' → 'dev'
 *
 * The legacy `prompt` column is preserved verbatim — no auto-explosion into
 * chained workflow rows (PLAN.md decision #7). Legacy rows stay single-step
 * `dev` until the user re-saves through the new editor.
 *
 * The CHECK constraint was tightened by the schema migration in commit
 * b9edb82, so this script is safe to run AFTER `bun run hub/src/db/migrate.ts`
 * (or whatever currently applies schema.sql).
 *
 * Idempotent — re-running against a fully-migrated DB updates 0 rows.
 *
 * Usage:
 *   bun run hub/scripts/migrate-task-kinds.ts            # apply
 *   bun run hub/scripts/migrate-task-kinds.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  const before = (await sql`
    SELECT task_type, count(*)::int AS n
    FROM scheduled_tasks
    WHERE task_type IN ('prompt', 'skill', 'continue_dev')
    GROUP BY task_type
  `) as Array<{ task_type: string; n: number }>

  if (before.length === 0) {
    console.log('[phase-11] no legacy rows to migrate (already converged).')
    return 0
  }

  const total = before.reduce((s, r) => s + r.n, 0)
  console.log(`[phase-11] legacy rows pending:`)
  for (const r of before) console.log(`  ${r.task_type.padEnd(14)} ${r.n}`)
  console.log(`[phase-11] total: ${total}`)

  if (DRY) {
    console.log('[phase-11] --dry-run; no rows updated.')
    return 0
  }

  const updated = (await sql`
    UPDATE scheduled_tasks
    SET task_type = 'dev'
    WHERE task_type IN ('prompt', 'skill', 'continue_dev')
    RETURNING id
  `) as Array<{ id: string }>

  console.log(`[phase-11] updated ${updated.length} row(s) → 'dev'`)
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[phase-11] fatal:', err)
      process.exit(2)
    })
}
