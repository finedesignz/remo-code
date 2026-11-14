# CORCH-01 - `check-baseline` with REMO_E2E_DB_URL: root-cause verdict

Date: 2026-11-13. Branch: `phase-corch-01-backlog-dispatcher` (HEAD b6a723a). Base: `origin/main` ed65cc3 (detached throwaway worktree, since removed).
Postgres 16 at 127.0.0.1:55432 (user remo, trust auth). Every run used a brand-new empty database.

## Verdict: LOCAL ENVIRONMENT. Not CORCH-caused, not a branch defect.

Run exactly as CI runs it (`.woodpecker/qc.yaml` pr-gate env: `DATABASE_URL` + `REMO_E2E_DB_URL` pointing at the
same DB, plus `JWT_SECRET`), the branch is GREEN. The 28 local failures appear only when `DATABASE_URL` is NOT set,
and the identical failure signature occurs on unmodified `origin/main`.

## Evidence (all 4 runs, fresh DB each)

| # | Tree | Env | Result |
|---|------|-----|--------|
| 1 | branch | `REMO_E2E_DB_URL` only (DB `bl_branch`) | exit 1: pass=3837 skip=0 fail=28 total=3865 |
| 2 | branch | `DATABASE_URL`=`REMO_E2E_DB_URL`=DB + `JWT_SECRET` (CI env, DB `bl_branch2`) | exit 0: pass=3881 skip=0 fail=0 total=3881, "OK - within tolerance" |
| 3 | origin/main | `REMO_E2E_DB_URL` only (DB `bl_main`) | exit 1: pass=3702 skip=0 fail=27 total=3729 |
| 4 | origin/main | CI env (DB `bl_main2`) | exit 0: pass=3745 skip=0 fail=0 total=3745 |

Branch minus main under the CI env: +136 passes (the new CORCH tests; `hub/test/e2e/corch-dispatcher.e2e.test.ts`
ran 28 tests, 0 fail) and 0 new failures. Skip=0 in all four because the DB-gated e2e files un-skip once
`REMO_E2E_DB_URL` is set (baseline.skip 323 is the no-DB FLOOR number; skip_max is a ceiling, so 0 is fine).

## Root cause of the local failures

`hub/src/config.ts:202`: `databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/remocode"`.
The e2e harness reads `REMO_E2E_DB_URL`, but product code the tests drive through (heal routing `[heal] provenance
probe failed (fail closed)`, orchestrator macro-cycle / verify-tail / queue / run-log DALs, repo-groups, approvals)
opens the app-level `sql` client from `DATABASE_URL`. With it unset the client dials the default `localhost:5432`
and gets `ECONNREFUSED 127.0.0.1:5432` / `::1:5432` (nothing listens there). 16 of the failures carry that error
verbatim; the rest are downstream asserts (`pending` instead of `skipped/no_routable_session`, missing run-log rows)
and 5000ms test timeouts. CI sets both variables, so CI never sees this.

Failing files (same set on branch and main, none touched by CORCH-01: `git diff --name-only origin/main...HEAD`
has no heal/orchestrator/macro/verify-tail file):

- `hub/test/e2e/heal-incident-replay.e2e.test.ts` (6)
- `hub/test/e2e/orchestrator-macro-cycle.e2e.test.ts` (OEE-05, 4 on main / 5 on branch)
- `hub/test/e2e/orchestrator-verify-tail.e2e.test.ts` (OEE-08, 2)
- Suites identified by name only (file path not resolved from the log): OEE-03 queue (3), OEE-01/02 run-log (1), BSA-07 autospawn (6)
- `orchestrator_approvals` DAL, `routine queue`, `run-log`, `stage-presets`, `repo-groups` e2e blocks (5, "(unnamed)" = beforeAll/connect failure)

Only branch-vs-main delta in the broken-env runs is one extra failure (28 vs 27):
`OEE-05 ... > NO open gate at a halting stage -> re-injects (continues)`, a 5000ms timeout in a file CORCH-01 does not
touch, in the cascade after preceding OEE-05 tests timed out on the same ECONNREFUSED. It does not reproduce with the
CI env (run 2: 0 failures). It is timing noise inside an already-broken configuration, not a CORCH effect.

## DB reuse

Not a factor. All four runs used a brand-new empty database; CI uses a fresh postgres:16 per pipeline. CORCH tests
are isolated enough that the full suite (including `corch-dispatcher.e2e`, 28 tests) passes on a fresh DB and the
CORCH schema applies cleanly (only idempotent `already exists, skipping` NOTICEs on re-boot of schema.sql within a run).
Repeat-run-on-same-DB was not exercised (outside the question: CI is always fresh).

## Fix

None needed in code. To reproduce CI locally, set BOTH variables to the same DB:

```
DATABASE_URL=postgres://remo@127.0.0.1:55432/<fresh> REMO_E2E_DB_URL=postgres://remo@127.0.0.1:55432/<fresh> \
JWT_SECRET=ci-placeholder-jwt-secret-min-32-chars-please-do-not-use-in-prod bun run check-baseline
```

(`REMO_E2E_ALLOW_NONLOCAL=1` only matters for a non-localhost DB host, as in CI's `postgres` service.)
The pre-existing sharp edge (running with only `REMO_E2E_DB_URL` produces a confusing 27-failure wall on main) is a
harness-ergonomics issue, separate from CORCH-01; a harness that derived `DATABASE_URL` from `REMO_E2E_DB_URL` (or
failed fast with a clear message when only one is set) would remove it. No ticket filed: not a product defect, no
tool error hit.
