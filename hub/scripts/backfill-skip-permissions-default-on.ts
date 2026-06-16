/**
 * skip-permissions-default-on (2026-06-15) — one-shot migration to flip the
 * per-session `dangerously_skip_permissions` default ON and backfill the existing
 * fleet of sessions.
 *
 * The matching statements live in `hub/src/db/schema.sql` (idempotent):
 *   ALTER TABLE sessions ALTER COLUMN dangerously_skip_permissions SET DEFAULT TRUE;
 * so a normal schema apply already sets the DEFAULT for NEW sessions. This script
 * additionally backfills EXISTING rows that are NULL/FALSE up to TRUE, and exists
 * for an explicit standalone run (and a --dry-run report).
 *
 * This only REQUESTS the bypass per session. The supervisor's host config
 * `allow_dangerous_skip_permissions` remains the HARD CEILING (applied =
 * requested && allowed), so the backfill can never exceed host config. Users can
 * still turn an individual session OFF via the web toggle afterward.
 *
 * Idempotent — re-running against a migrated DB flips 0 rows.
 *
 * Usage:
 *   bun run hub/scripts/backfill-skip-permissions-default-on.ts            # apply
 *   bun run hub/scripts/backfill-skip-permissions-default-on.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  const before = (await sql`
    SELECT
      count(*) FILTER (WHERE dangerously_skip_permissions IS TRUE)::int AS on_count,
      count(*) FILTER (WHERE dangerously_skip_permissions IS NOT TRUE)::int AS off_count
    FROM sessions
  `)[0]
  console.log('[backfill-skip-permissions-default-on] before:', before)

  if (DRY) {
    console.log(`[backfill-skip-permissions-default-on] DRY-RUN — would set ${before.off_count} session(s) to TRUE.`)
    return 0
  }

  const flipped = await sql`
    UPDATE sessions SET dangerously_skip_permissions = TRUE
    WHERE dangerously_skip_permissions IS NOT TRUE
    RETURNING id
  `
  console.log(`[backfill-skip-permissions-default-on] set ${flipped.length} session(s) to TRUE.`)

  const after = (await sql`
    SELECT count(*) FILTER (WHERE dangerously_skip_permissions IS TRUE)::int AS on_count FROM sessions
  `)[0]
  console.log('[backfill-skip-permissions-default-on] after:', after)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[backfill-skip-permissions-default-on] FAILED:', err?.message ?? err)
    process.exit(1)
  })
