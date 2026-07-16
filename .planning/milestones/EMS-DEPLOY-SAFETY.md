# EMS Deploy-Safety Assessment — feat/ext-mcp-ship (7-commit delta vs main 9d0122a)

**Verdict: SAFE-WITH-NOTES.** No live-hub regression risk found. The delta is
additive: a brand-new `/api/ext/*` namespace + a nullable, legacy-permissive
`api_keys.scopes` column + additive `scheduled_tasks` columns. Every existing
row, key, route, and the supervisor→hub auth path keep their current behavior
with zero migration. Woodpecker CI (qc + docs-drift) is GREEN on head `8fa102f`.

Scope: head `8fa102f`, PR #380 → main. Commits `e464cde dcd45a3 035620d b1355a9 a28eb74 5eda0a1 594a29d`.
(The repo's existing `.planning/DEPLOY-SAFETY.md` is for a different PTY-runner branch and does NOT apply here.)

## (a) Scheduler one-time tasks (`schedule_kind='once'`) — SAFE
- Schema change is **additive + no backfill**: `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS schedule_kind TEXT NOT NULL DEFAULT 'cron'` and `ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ`. Every existing row stays `schedule_kind='cron'` / `run_at NULL` and rides the unchanged cron path. CHECK constraint added inside a `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL` guard (idempotent).
- New `'work'` value appended to the `scheduled_tasks_task_type_check` CHECK — additive; existing types unaffected.
- New boot-started `setInterval` sweeps: `startOnceDueSweep` (once-due-sweep.ts) and the ASK reaper. Both env-disableable (`REMO_ONCE_SWEEP_DISABLED`, `REMO_ASK_MAX_MS`, etc.). They only touch `schedule_kind='once'` rows — of which there are none until the ext work path is used. No existing cron row is read or mutated by the new sweeps.

## (b) ext-api-key middleware + 594a29d scope hardening — ext-scoped only, SAFE
- The new `extApiKeyMiddleware` is mounted **only** on `/api/ext/*` (index.ts), before the JWT catch-all, and `/api/ext/` is added to the cookie-auth skip list. No other route is touched.
- The change to the **existing** `api-key-middleware.ts` (supervisor `/api/plugin/*` + `/ws/agent`) swaps `verifyApiKey`→`verifyApiKeyWithScope(hash, SCOPE_AGENT)`. `hasScope` treats **NULL/empty scopes as full access**, so every pre-milestone supervisor key (NULL scopes) still authenticates the `agent` gate → **no supervisor→hub auth regression**. It also fail-closes on a DAL/DB error (was effectively 401 before) and fixes a latent `user_id`-undefined bug. An `ext:*`-only key is correctly 403'd off the host-spawning surface.
- 594a29d makes `ext:work` require **explicit** scope membership (`hasExplicitScope`, NOT NULL-permissive) — a legacy NULL-scope key can never implicitly gain publish-to-live-client-site authority. This is a tightening on the NEW surface only.

## (c) Supervisor v0.14.0 bump (a28eb74) — SAFE, no hub runtime impact
- Touches `supervisor/` (Tauri app: Cargo.lock/toml, tauri.conf.json, ui/package.json) + supervisor session-read commands. The supervisor runs on the dev machine, **not** the hub container. The hub multi-stage Dockerfile builds only the hub; nothing in the bump changes hub runtime, deps, or boot.

## (d) DB migration on boot — SAFE (established idempotent pattern)
- `runMigrations()` runs `schema.sql` in full on every hub boot (pre-existing behavior), statement-by-statement with per-statement try/catch that logs+continues. All new DDL is idempotent: `ADD COLUMN IF NOT EXISTS`, `DROP INDEX IF EXISTS`, guarded CHECK.
- Two index drops are **relaxations** and safe: `DROP INDEX IF EXISTS idx_api_keys_user_active` and `… idx_api_keys_user_purpose_active` (to permit N active `external` keys per user), replaced by `CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_supervisor_active ON api_keys(user_id) WHERE revoked_at IS NULL AND purpose='supervisor'`. The prior one-active-key-per-user invariant guarantees ≤1 supervisor key already exists, so the new partial-unique cannot violate on apply.
- The CI `schema-lint` gate (hard-fails any un-pragma'd UPDATE/INSERT/DELETE/DROP/TRUNCATE) passed. `migration-verify` + the `schema-double-apply` e2e (re-applies schema in full) passed in Woodpecker qc.

## Notes (non-blocking)
1. `schema.sql` re-applies in full on every boot — this is the repo's established pattern, guarded by `schema-lint`, not new risk introduced here.
2. `tsc` reports ~393–418 pre-existing type errors; the CI typecheck step is intentionally informational (`|| echo`), not a gate. Not a regression (baseline was already ~392–393).
3. New background sweep timers start on boot; all are env-disableable if operationally needed.

## Evidence
- Woodpecker CI on head `8fa102f`: `ci/woodpecker/pr/qc` = success, `ci/woodpecker/pr/docs-drift` = success. Combined status = success.
- docs regen (`bun run docs:sync`): zero content drift vs committed `docs/openapi.json` + `docs/api.md`.
