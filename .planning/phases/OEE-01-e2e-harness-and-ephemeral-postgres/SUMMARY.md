# OEE-01 — E2E Harness + Ephemeral Postgres — SUMMARY

**Branch:** `feat/orchestrator-e2e-proveout` · **Status:** built; worktree baseline pre-broken by an unrelated unresolved merge conflict (see Known Issues).

## What was built

A reusable, isolated e2e harness that boots the REAL `hub/src/db/schema.sql`
(UNMODIFIED) against an ephemeral, non-prod Postgres — so later OEE phases can drive
the flag-gated-OFF Auto-Dev Orchestrator against real PG without ever touching prod.

- **`hasE2eDb()` / `maybeDescribe`** — env gate on `REMO_E2E_DB_URL`, identical to
  `hub/test/phase-08.e2e.test.ts`. Without the env var every DB test `describe.skip`s.
- **Non-prod DSN guard (`assertNonProdDsn`)** — conservative, refuse-to-run-is-safe:
  rejects empty DSNs; rejects any DSN containing a prod marker (`coolify`,
  `titaniumlabs`, `remo-code.com`, prod IP `46.224.61.233`, `supabase.co`,
  `rds.amazonaws.com`, `neon.tech`, `pooler.`); rejects a non-local host UNLESS
  `REMO_E2E_ALLOW_NONLOCAL=1`. Connects ONLY via `REMO_E2E_DB_URL`; NEVER reads the
  ambient prod `DATABASE_URL`.
- **`setupHarness()`** — guard-checks the DSN, opens a PRIVATE `postgres` client (not
  the hub's shared `sql`), applies `schema.sql` statement-by-statement via the hub's
  own `splitSqlStatements` (idempotent, best-effort per stmt), seeds one synthetic
  `users` row + one `sessions` row (FK target for orchestrator tables).
- **`teardownHarness()`** — cascade-deletes the synthetic user (FK `ON DELETE
  CASCADE`) and closes the pool.

## Files

- `hub/test/e2e/orchestrator-harness.ts` — harness module (OEE-01 + OEE-02).
- `hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts` — smoke test.

## How to run

```bash
# Pure DSN-guard tests always run (no DB):
bun test hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts
# Full schema-boot e2e against a DISPOSABLE LOCAL Postgres:
REMO_E2E_DB_URL=postgres://localhost:5432/remo_e2e bun test hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts
```

## Constraints honored

- ZERO changes to `schema.sql` (run unmodified; idempotent re-run). No migrations.
- No production-runtime seam added — orchestrator already exposes DI seams
  (`injectOrchestratorPrompt(input, deps)`, `runMacroCycle(input, deps)`); the harness
  plugs into THOSE. `hub/src/**` untouched, so live behavior is unchanged.

## Known issues

- The worktree was handed over mid-merge: `hub/src/ws/supervisor-protocol.ts` has live
  `<<<<<<<`/`=======`/`>>>>>>>` conflict markers (`git status`: `both modified`),
  which breaks `bun run check-baseline` (fail=22 with my files REMOVED). NOT in OEE
  scope; left untouched so it isn't clobbered. Resolve that conflict (or fast-forward
  the branch to `origin/main`, which is +1 commit ahead) before relying on the gate.

## How later phases build on it

- OEE-03/04/05 call `setupHarness()` in `beforeAll`, use `h.sql` for direct row seeding
  (`orchestrator_rows`, `routine_queue`, `schedule_rule`) and `h.userId`/`h.sessionId`
  as FK targets, then drive the real queue/controller/macro-cycle. The non-prod guard
  fires inside `setupHarness`, so every phase inherits prod safety automatically.
