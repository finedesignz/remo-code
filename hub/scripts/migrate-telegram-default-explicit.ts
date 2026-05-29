/**
 * orchestrator-as-default (2026-05-29) — one-shot backfill of
 * `users.telegram_default_explicit`.
 *
 * WHY this is a standalone script and NOT in schema.sql:
 *   `hub/src/db/schema.sql` is re-applied on EVERY hub boot (see
 *   `hub/src/db/migrate.ts::runMigrations`, called from `hub/src/index.ts`). A
 *   `UPDATE users SET telegram_default_explicit = true WHERE
 *   telegram_default_session_id IS NOT NULL` placed there would re-run on every
 *   redeploy and flip legitimate POST-launch auto-pins (lazy-pin / prewarm write
 *   explicit=false on purpose so the orchestrator can still win for a no-choice
 *   user) to true — permanently killing orchestrator-as-default for those users.
 *
 * WHAT it does (run ONCE, against the existing prod DB, right after the deploy
 * that ships the column, BEFORE any new auto-pins exist):
 *   Marks every PRE-EXISTING non-null Telegram default as EXPLICIT. We cannot
 *   distinguish an old prewarm-auto-pin from an old `/session` pick post-hoc, and
 *   the user's hard constraint ("my prior pick must never be auto-overridden")
 *   forces erring toward honoring the pin.
 *
 * A FRESH database needs NO backfill (no pre-existing pins) — the column's
 * DEFAULT false is correct there.
 *
 * Safe-by-design: it only ever sets true. It is NOT safe to re-run LATER (after
 * users have auto-pinned defaults) — run it exactly once. `--dry-run` reports
 * the count without writing.
 *
 * Usage:
 *   bun run hub/scripts/migrate-telegram-default-explicit.ts            # apply
 *   bun run hub/scripts/migrate-telegram-default-explicit.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  // Ensure the column exists before we touch it (idempotent — matches schema.sql).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_default_explicit BOOLEAN NOT NULL DEFAULT false`

  const before = (await sql`
    SELECT
      count(*) FILTER (WHERE telegram_default_session_id IS NOT NULL)::int AS with_default,
      count(*) FILTER (WHERE telegram_default_session_id IS NOT NULL AND telegram_default_explicit)::int AS already_explicit,
      count(*) FILTER (WHERE telegram_default_session_id IS NOT NULL AND NOT telegram_default_explicit)::int AS to_flip
    FROM users
  `)[0]
  console.log('[migrate-telegram-default-explicit] before:', before)

  if (DRY) {
    console.log(`[migrate-telegram-default-explicit] DRY-RUN — would mark ${before.to_flip} pre-existing default(s) explicit; ${before.already_explicit} already explicit.`)
    return 0
  }

  const flipped = await sql`
    UPDATE users SET telegram_default_explicit = true
    WHERE telegram_default_session_id IS NOT NULL AND telegram_default_explicit = false
    RETURNING id
  `
  console.log(`[migrate-telegram-default-explicit] marked ${flipped.length} pre-existing default(s) explicit.`)

  const after = (await sql`
    SELECT count(*) FILTER (WHERE telegram_default_session_id IS NOT NULL AND telegram_default_explicit)::int AS explicit_defaults
    FROM users
  `)[0]
  console.log('[migrate-telegram-default-explicit] after:', after)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[migrate-telegram-default-explicit] FAILED:', err?.message ?? err)
    process.exit(1)
  })
