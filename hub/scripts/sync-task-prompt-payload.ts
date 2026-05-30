/**
 * One-shot backfill — reconcile the split prompt storage on `scheduled_tasks`.
 *
 * Historically the custom prompt for a `dev` task was written to two places
 * that drifted out of sync:
 *   - the top-level `prompt` column (set by the CREATE path / legacy clients)
 *   - `payload->>'prompt'` (read by the editor + preferred by the dispatcher)
 *
 * The editor read `payload.prompt` only, so rows with the prompt in the column
 * but empty `payload.prompt` displayed blank and the run fell back to the
 * default "Continue where you left off." (and vice-versa for older rows).
 *
 * Fix (single source of truth = `prompt` column, mirrored into payload.prompt):
 *   1. column non-empty, payload.prompt empty/missing  → set payload.prompt = column
 *   2. payload.prompt non-empty, column empty          → set column = payload.prompt
 *
 * Both directions are idempotent: once column == payload.prompt the row is
 * skipped. Re-running against a converged DB updates 0 rows.
 *
 * MUST live here, not in schema.sql — schema.sql re-runs in full every hub boot,
 * so data backfills belong in one-shot scripts (repo invariant).
 *
 * Usage:
 *   bun run hub/scripts/sync-task-prompt-payload.ts            # apply
 *   bun run hub/scripts/sync-task-prompt-payload.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  // Direction 1: prompt column → payload.prompt (legacy/create-only rows).
  const pending1 = (await sql`
    SELECT count(*)::int AS n
    FROM scheduled_tasks
    WHERE coalesce(prompt, '') <> ''
      AND coalesce(payload->>'prompt', '') = ''
  `) as Array<{ n: number }>

  // Direction 2: payload.prompt → prompt column (editor-only rows).
  const pending2 = (await sql`
    SELECT count(*)::int AS n
    FROM scheduled_tasks
    WHERE coalesce(payload->>'prompt', '') <> ''
      AND coalesce(prompt, '') = ''
  `) as Array<{ n: number }>

  const n1 = pending1[0]?.n ?? 0
  const n2 = pending2[0]?.n ?? 0
  console.log(`[prompt-sync] column→payload pending: ${n1}`)
  console.log(`[prompt-sync] payload→column pending: ${n2}`)

  if (n1 === 0 && n2 === 0) {
    console.log('[prompt-sync] nothing to sync (already converged).')
    return 0
  }

  if (DRY) {
    console.log('[prompt-sync] --dry-run; no rows updated.')
    return 0
  }

  const updated1 = (await sql`
    UPDATE scheduled_tasks
    SET payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{prompt}', to_jsonb(prompt)),
        updated_at = now()
    WHERE coalesce(prompt, '') <> ''
      AND coalesce(payload->>'prompt', '') = ''
    RETURNING id
  `) as Array<{ id: string }>

  const updated2 = (await sql`
    UPDATE scheduled_tasks
    SET prompt = payload->>'prompt',
        updated_at = now()
    WHERE coalesce(payload->>'prompt', '') <> ''
      AND coalesce(prompt, '') = ''
    RETURNING id
  `) as Array<{ id: string }>

  console.log(`[prompt-sync] column→payload synced: ${updated1.length}`)
  console.log(`[prompt-sync] payload→column synced: ${updated2.length}`)
  console.log(`[prompt-sync] total rows synced: ${updated1.length + updated2.length}`)
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[prompt-sync] fatal:', err)
      process.exit(2)
    })
}
