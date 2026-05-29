/**
 * orchestrator-autolaunch (2026-05-28) — one-shot migration to flip the
 * orchestrator default ON and backfill the existing fleet.
 *
 * The same statements live in `hub/src/db/schema.sql` (all idempotent), so a
 * normal schema apply already does this. This script exists for an explicit,
 * standalone run (and a --dry-run report) on a DB where you don't want to re-run
 * the full schema.
 *
 * Behavior:
 *   1. ALTER COLUMN orchestrator_enabled SET DEFAULT true   (new users → on)
 *   2. ADD COLUMN orchestrator_disabled_explicitly DEFAULT false (sentinel)
 *   3. UPDATE users SET orchestrator_enabled = true
 *        WHERE orchestrator_disabled_explicitly = false      (fleet backfill)
 *
 * Step 3 NEVER overrides a user who carries the explicit-disable sentinel, so
 * re-running on a partially-opted-out fleet is safe.
 *
 * Idempotent — re-running against a migrated DB flips 0 rows in step 3.
 *
 * Usage:
 *   bun run hub/scripts/migrate-orchestrator-default.ts            # apply
 *   bun run hub/scripts/migrate-orchestrator-default.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  // Ensure the sentinel column exists before we read it (idempotent).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_disabled_explicitly BOOLEAN NOT NULL DEFAULT false`

  const before = (await sql`
    SELECT
      count(*) FILTER (WHERE orchestrator_enabled)::int AS enabled,
      count(*) FILTER (WHERE NOT orchestrator_enabled)::int AS disabled,
      count(*) FILTER (WHERE orchestrator_disabled_explicitly)::int AS explicit_off
    FROM users
  `)[0]
  console.log('[migrate-orchestrator-default] before:', before)

  if (DRY) {
    const wouldFlip = (await sql`
      SELECT count(*)::int AS n FROM users
      WHERE NOT orchestrator_enabled AND orchestrator_disabled_explicitly = false
    `)[0].n
    console.log(`[migrate-orchestrator-default] DRY-RUN — would enable ${wouldFlip} user(s); ${before.explicit_off} explicitly-off user(s) untouched.`)
    return 0
  }

  await sql`ALTER TABLE users ALTER COLUMN orchestrator_enabled SET DEFAULT true`
  const flipped = await sql`
    UPDATE users SET orchestrator_enabled = true
    WHERE orchestrator_disabled_explicitly = false AND orchestrator_enabled = false
    RETURNING id
  `
  console.log(`[migrate-orchestrator-default] enabled ${flipped.length} previously-off user(s); ${before.explicit_off} explicitly-off user(s) left alone.`)

  const after = (await sql`
    SELECT count(*) FILTER (WHERE orchestrator_enabled)::int AS enabled FROM users
  `)[0]
  console.log('[migrate-orchestrator-default] after:', after)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[migrate-orchestrator-default] FAILED:', err?.message ?? err)
    process.exit(1)
  })
