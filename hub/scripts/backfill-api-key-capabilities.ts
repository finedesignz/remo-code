/**
 * api-key capabilities backfill (2026-07-12) — one-shot.
 *
 * This statement used to live in `hub/src/db/schema.sql`:
 *
 *   UPDATE api_keys SET capabilities = ARRAY['agent','supervisor']
 *     WHERE capabilities IS NULL OR NOT ('supervisor' = ANY(capabilities));
 *
 * schema.sql RE-RUNS IN FULL ON EVERY HUB BOOT, so that was a standing
 * privilege-escalation landmine: the day a least-privilege key is minted (e.g.
 * agent-only, or a per-tenant key), the next boot would silently REWRITE it to
 * ['agent','supervisor'] — escalating it AND stripping any extra caps — on every
 * single deploy. It was inert only because both current minters
 * (`orchestrator-dal.ts`, `orchestrator/auto-launch.ts`) happen to mint a superset.
 *
 * schema.sql keeps only the idempotent DDL:
 *   ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capabilities TEXT[]
 *     NOT NULL DEFAULT ARRAY['agent','supervisor'];
 * so every NEW key still gets the default. This script is the one-shot backfill for
 * legacy rows, run deliberately by an operator.
 *
 * Scope: ONLY rows with NULL/empty capabilities (genuine legacy rows — treated as
 * all-caps by `supervisor-dal.ts`'s verifier anyway). It deliberately does NOT touch
 * a key that carries a NON-EMPTY capability set, whatever it is: a narrower set is a
 * deliberate least-privilege choice, not drift.
 *
 * Idempotent — re-running against a migrated DB flips 0 rows.
 *
 * Usage:
 *   bun run hub/scripts/backfill-api-key-capabilities.ts            # apply
 *   bun run hub/scripts/backfill-api-key-capabilities.ts --dry-run  # report only
 */

const DRY = process.argv.includes('--dry-run')

async function main(): Promise<number> {
  const { sql } = await import('../src/db/postgres.ts')

  const before = (await sql`
    SELECT
      count(*) FILTER (WHERE capabilities IS NULL OR cardinality(capabilities) = 0)::int AS empty_count,
      count(*)::int AS total
    FROM api_keys
  `)[0]
  console.log('[backfill-api-key-capabilities] before:', before)

  if (DRY) {
    console.log(
      `[backfill-api-key-capabilities] DRY-RUN — would set ${before.empty_count} key(s) to ARRAY['agent','supervisor'].`,
    )
    return 0
  }

  const flipped = await sql`
    UPDATE api_keys SET capabilities = ARRAY['agent','supervisor']
    WHERE capabilities IS NULL OR cardinality(capabilities) = 0
    RETURNING id
  `
  console.log(`[backfill-api-key-capabilities] set ${flipped.length} key(s) to the default capability set.`)
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[backfill-api-key-capabilities] FAILED:', err?.message ?? err)
    process.exit(1)
  })
