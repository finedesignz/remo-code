---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 08
subsystem: orchestrator-tests
tags: [proof, differential, flag-off, real-postgres, e2e-helper, baseline]
requires: [05-05, 05-06, 05-07]
provides:
  - flag-OFF differential matrix (hub/test/orchestrator-proof-noop.test.ts, 39 tests)
  - real-Postgres proof helper (hub/test/e2e/proof-checks.ts, 8 sections, no test() call)
  - baseline re-measured (tools/regression-baseline.json)
affects: [05-09]
key-files:
  created:
    - hub/test/orchestrator-proof-noop.test.ts
    - hub/test/e2e/proof-checks.ts
  modified:
    - hub/test/e2e/orchestrator-autospawn.e2e.test.ts
    - tools/regression-baseline.json
decisions:
  - "The OFF differential mocks db/postgres.ts with a throwing, recording sql and the proof guard / verifier / github modules with recorders, so both a stray DB read and a stray dynamic import of proof code are detected"
  - "The e2e helper creates its OWN four synthetic users (cascade-deleted in finally) because the autospawn test leaves an allowlist row for the harness user that would trip other_repo_allowlisted; the harness user's allowlist is only observed"
  - "Section 6 uses a raw-inserted running run bound to a temp session (recordProofObservation only updates ACTIVE runs and the arm path would need the earlier run terminal first)"
status: complete
plan_head_before: 629a66926df91d1e007965a6c5a340cfb1ad5ba5
commits: 3
actuals:
  tokens: 12000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-05 Plan 08: OFF no-op differential and real-Postgres proof Summary

Flag-OFF is now provably identical to today across all 7 OFF combinations of the three-flag stack, and the database-enforced F2 invariants have a CI-executed proof that adds no tests and no skips.

## What was built

**Task 1 (848d955)** - `hub/test/orchestrator-proof-noop.test.ts`, 39 tests, single process. Predicate matrix: only all-on is true; accepted spellings (`1 true TRUE Yes on ON "  on  "`) match `isOrchestratorEnabled` / `isAutospawnEnabled` exactly; garbage and unset are off. For each of the 7 OFF combinations: `runMacroCycle` (with and without injected proof hooks) sees 0 sql, 0 fetch, 0 guard-module loads, 0 verifier / github calls, never calls `deps.proof`, and its inject args deep-equal both an unflagged baseline run and an independently rendered `renderMacro('dev', ctx)` expectation (token normalized for the timestamp). Both gates pass through with a tripwire deps object and with the real default instances; merge routing is unchanged (lookup dep never consulted, dispatched). A sanity test proves the sql trap is live (all-on merge without a lookup dep reaches the DAL and fails closed).

**Task 2 (e3fffcd)** - `hub/test/e2e/proof-checks.ts` (`runProofChecks`, no test()/it()/describe()) awaited from the end of the first existing test in `orchestrator-autospawn.e2e.test.ts` (timeout raised 5s default to 120s for the added work). Eight numbered sections: (1) PTYCAP-05 DDL block re-applied twice, 6 named CHECKs + 3 partial unique indexes present; (2) 5 parallel `armProofRunTx` -> exactly 1 wins, 4 `proof_already_active`, one allowlist row, one active row; (3) raw INSERTs rejected 23505 for a second active per user / repo / task, same rows accepted with a terminal status; (4) five CHECK violations rejected 23514; (5) concurrent claims return the same running row, 10 parallel `terminalizeProofRun` -> exactly 1 winner; (6) four-bucket token sum since `started_at`, `sessionExists=false` after session delete, `tokens_hwm` monotone (GREATEST), budget gate fails closed `proof_budget_attribution_lost`; (7) real `reserveInject` ledger rows, `proofBudgetGate` ok at 2 of 3, blocked `proof_budget_injects:3>=3` at 3; (8) `disarmProofRunTx` removes only the exact `(user_id, repo_ident)` allowlist row, idempotent, harness user's allowlist unchanged. Cleanup is by exact id / prefix in a finally block; env restored. Locally the enclosing describe is skipped (8 skipped, 0 fail); the helper type-checks and imports cleanly.

**Task 3 (ac8def4)** - `bun run schema-lint` OK; `bun run check-baseline` OK; `bun run docs:sync` produced no diff; tsc error count 427 (limit 427, none in files touched here). `tools/regression-baseline.json`: pass 2652 -> 3090, total 2911 -> 3349, skip stays 259, new `_skip_note_ptycap_phase5`; `pass_min` 1850, `skip_max` 260, `fail_max` 0 untouched.

## Verification

- `bun test test/orchestrator-proof-noop.test.ts`: 39 pass, 0 fail.
- `bun test test/e2e/orchestrator-autospawn.e2e.test.ts`: 0 pass, 8 skip (expected, no REMO_E2E_DB_URL), 0 fail.
- `bun run check-baseline`: pass=3090 skip=259 fail=0 total=3349, OK within tolerance (final run, after the baseline edit).
- Acceptance greps: no added `test(` / `it(` / `describe(` line in the autospawn e2e diff; none in `proof-checks.ts`.
- The real-Postgres section is UNVERIFIED locally by design (no local Postgres): it is first executed by Woodpecker's qc pipeline on the draft PR. Raw SQL shapes (array casts, `sql.unsafe` multi-statement DDL, the arm transaction's `scheduled_tasks` insert on a real database) are the most likely places for a first-run CI surprise.

## Deviations from Plan

None to plan scope. One out-of-scope observation: the first full `check-baseline` run failed once with a single timeout (`hub/test/transcript-adapter-codex.test.ts`, "persisted id present but no matching file", 5000 ms limit, measured 51 s under load). The file passes alone (8 pass) and the whole gate passed on immediate rerun and again afterwards. Not fixed (out of scope, pre-existing file); ticketed once in AgentAutofix (annotation 74489ffe-e4c1-4aab-ae99-367f70acf56c).

## Known Stubs

None.

## Threat Flags

None. The helper only runs against the disposable CI database (harness `assertNonProdDsn`), uses its own synthetic users, and no package was installed.

## Self-Check: PASSED

- hub/test/orchestrator-proof-noop.test.ts, hub/test/e2e/proof-checks.ts: present.
- Commits 848d955, e3fffcd, ac8def4: present on phase-ptycap-05-throwaway-repo-proof.
