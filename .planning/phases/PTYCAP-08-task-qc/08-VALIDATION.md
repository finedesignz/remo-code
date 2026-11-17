---
phase: "8"
slug: "task-qc"
status: draft
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-13"
---

# Phase 8 - Validation Strategy

> Per-phase validation contract for PTYCAP Phase 8 (Periodic Task QC + Optimization). The engine is deterministic hub code (FORK-1) so every behavior is provable DB-free with leaf-module mocks and the strict fake sql `hub/test/fixtures/task-qc-fake-sql.ts` (plan 01). One bun process per test file (Bun `mock.module` is process-global). No local Postgres exists: real-database proof is the helper `hub/test/e2e/task-qc-checks.ts` called from the BODY of two existing REMO_E2E_DB_URL-gated e2e tests (plan 09), so it adds zero tests and zero skips and runs only in Woodpecker (postgres:16). The locked fork verdict (`GATES/verdict.md`) overrides 08-SPEC / 08-CONTEXT wherever they differ.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test (hub unit tests are DB-free; leaf-module mocks; fake `sql` from `hub/test/fixtures/task-qc-fake-sql.ts`) |
| **Config file** | `hub/bunfig.toml` (preload `./test/_setup.ts`) |
| **Quick run command** | `cd hub; bun test test/<touched>.test.ts` (one file per process) |
| **Full suite command** | `bun run check-baseline` (per-file isolation; floors pass_min 1850, skip_max 260, fail_max 0; 600 s timeout) |
| **Type gate** | `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` must not exceed the count recorded at plan 01 PLAN_BASE (Phase 4 baseline was 427) |
| **Other gates** | `bun run schema-lint` (exit 0); `bun run docs:sync` then `git diff --exit-code docs/openapi.json docs/api.md`; the Phase 4 pin suites unchanged and green |
| **Skip budget** | skip baseline 259, `skip_max` 260: ZERO new skipped tests in this phase. No new `test()` in any e2e file; the real-Postgres proof is a helper |
| **Estimated runtime** | quick 2-10 s per file; full baseline several minutes |

---

## Sampling Rate

- **After every task commit:** the quick command for each test file the task touched, plus `bun run schema-lint` when schema.sql changed.
- **After every plan (wave end):** the plan's `<verification>` block plus the tsc count; plans 03, 06, 07, 08 additionally re-run the unchanged-suite list named in their verify blocks (scheduler-halt, kill-switch-coverage, post-run-default-email, dev-controller-routing, scheduler-log-check-uuid, scheduler, once-due-sweep, automation-boot-order, reserve-caller-guard, counter-key-assignment-guard, session-start-senders-guard).
- **Before `/gsd-verify-work`:** plan 10 Task 3 full gate green.
- **Max feedback latency:** 60 s for quick runs.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 08-01-T1 | 01 | 1 | TQC-01, F2-B2, F2-B4 | T-08-01, T-08-05 | additive DDL; `task_qc` in the single CHECK list; per-user partial unique index; findings table; nullability pins; four-carrier enum pin with exemption table | static DDL + source parse | `cd hub; bun test test/task-qc-schema.test.ts` ; `cd hub; bun test test/task-qc-enum-sync.test.ts` ; `bun run schema-lint` | created in task | pending |
| 08-01-T2 | 01 | 1 | (infra) | T-08-04 | strict statement-recording fake sql with write spy and unknown-statement tripwire | unit | `cd hub; bun test test/task-qc-fake-sql.test.ts` | created in task | pending |
| 08-01-T3 | 01 | 1 | TQC-08, F1-A3 | T-08-02, T-08-03, T-08-04 | flags default OFF, AUTOFIX needs ENABLED, FAIL_STREAK never 0, cadence floor 60 min, frozen unraisable bounds, idempotent findings DAL | unit | `cd hub; bun test test/task-qc-flags.test.ts` ; `cd hub; bun test test/task-qc-findings.test.ts` | created in task | pending |
| 08-02-T1 | 02 | 1 | TQC-02, F2-B7 | T-08-06, T-08-07 | audit-set predicate excludes internal anchors, task_qc, orchestrator, once; FAILING (incl. 500-failure high) and SKIP_FOREVER with benign list | unit | `cd hub; bun test test/task-qc-detectors.test.ts` | created in task | pending |
| 08-02-T2 | 02 | 1 | TQC-02 | T-08-06, T-08-09 | NEVER_FIRED (age gates, no fake repair), MISCONFIGURED real log_check case + mapped repo_key control, DEAD_SESSION | unit | `cd hub; bun test test/task-qc-detectors.test.ts` | created in task | pending |
| 08-02-T3 | 02 | 1 | TQC-02 | T-08-08, T-08-09 | OPTIMIZE arms; runDetectors de-dup + determinism; zero sql calls + import allowlist (purity) | unit + static | `cd hub; bun test test/task-qc-detectors.test.ts` ; `cd hub; bun test test/task-qc-detectors-purity.test.ts` | created in task | pending |
| 08-03-T1 | 03 | 2 | TQC-01, TQC-05, TQC-08, F2-B1 | T-08-13 | TRACER: flag-on fire -> one null-session claimed run -> FAILING proposed finding -> one digest email -> finalize; zero scheduled_tasks UPDATE | tracer (integration over fake sql) | `cd hub; bun test test/task-qc-tracer.test.ts` | created in task | pending |
| 08-03-T2 | 03 | 2 | TQC-01, TQC-08, F2-B1 | T-08-11, T-08-12 | branch ordering (no threshold/cost/target calls); flag-OFF early return even with halt engaged; atomic single open run; anti-chain sink; misroute guard | unit | `cd hub; bun test test/task-qc-fire-branch.test.ts` ; `cd hub; bun test test/scheduler-halt.test.ts` ; `cd hub; bun test test/kill-switch-coverage.test.ts` | created in task | pending |
| 08-03-T3 | 03 | 2 | F1-A2 | T-08-10 | terminal lifecycle: no post-run action, default email, chain, user_message, dispatch, session launch or token_usage even with malformed stored data | integration over fake sql | `cd hub; bun test test/task-qc-terminal.test.ts` ; `cd hub; bun test test/post-run-default-email.test.ts` ; `cd hub; bun test test/dev-controller-routing.test.ts` | created in task | pending |
| 08-04-T1 | 04 | 2 | TQC-03, TQC-04, SC2 | T-08-15, T-08-16, T-08-20 | immutable 3-kind allowlist; hostile kinds throw before any SQL; quoter + rollback templates; static UPDATE-template guard (extractor proven non-vacuous) | unit + static | `cd hub; bun test test/task-qc-safe-fixes.test.ts` ; `cd hub; bun test test/task-qc-never-disables.test.ts` | created in task | pending |
| 08-04-T2 | 04 | 2 | TQC-03, TQC-06, F2-B7 | T-08-17, T-08-19, T-08-21 | one tx per fix: FOR UPDATE, auditable + precondition re-check, in-flight refusal, update + audit row in the same tx, abort on error | unit (fake sql, statement order) | `cd hub; bun test test/task-qc-in-flight.test.ts` ; `cd hub; bun test test/task-qc-safe-fixes.test.ts` | created in task | pending |
| 08-04-T3 | 04 | 2 | TQC-03 | T-08-18 | pure planFix: exactly-one-distinct-candidate rule; ambiguity and AUTOFIX-off become proposals | unit | `cd hub; bun test test/task-qc-fix-planning.test.ts` | created in task | pending |
| 08-05-T1 | 05 | 2 | F2-B5, TQC-01 | T-08-24, T-08-25 | POST rejects task_qc; DELETE 409; row stays visible; run-now not blocked | route unit | `cd hub; bun test test/task-qc-api-guards.test.ts` | created in task | pending |
| 08-05-T2 | 05 | 2 | F2-B5 | T-08-22, T-08-23 | PATCH allows only enabled, validated cadence (>= 60 min), valid timezone; compare-to-stored immutability; no rename; docs:openapi clean | route unit | `cd hub; bun test test/task-qc-api-guards.test.ts` ; `cd hub; bun test test/scheduled-tasks-patch-target.test.ts` ; `cd hub; bun test test/mount-order.test.ts` | created in task | pending |
| 08-06-T1 | 06 | 3 | TQC-02, F2-B7 | T-08-30, T-08-31 | bounded read-only layer; audit set enforced in SQL; windowed history; statement timeout + advisory lock; exported sender resolver reused | unit (fake sql) | `cd hub; bun test test/task-qc-load.test.ts` ; `cd hub; bun test test/scheduler-log-check-uuid.test.ts` | created in task | pending |
| 08-06-T2 | 06 | 3 | TQC-03, TQC-04, TQC-05, SC5 | T-08-29, T-08-31 | full pass: report-only = zero UPDATE; AUTOFIX applies 3 fixes; ambiguity/in-flight stay proposals; 500-failure task stays enabled; halt re-check read-only; idempotent findings | unit (fake sql) | `cd hub; bun test test/task-qc-engine.test.ts` ; `cd hub; bun test test/task-qc-tracer.test.ts` | created in task | pending |
| 08-06-T3 | 06 | 3 | TQC-07, F1-A3, F1-A4 | T-08-26, T-08-27, T-08-28 | each deterministic bound enforced; scope narrows only; closed per-file import allowlist; zero token_usage; Phase 9 reverse-direction guard | unit + static | `cd hub; bun test test/task-qc-bounds.test.ts` ; `cd hub; bun test test/task-qc-engine-scope.test.ts` ; `cd hub; bun test test/task-qc-no-llm-guard.test.ts` | created in task | pending |
| 08-07-T1 | 07 | 3 | TQC-05, SC4, F1-A5 | T-08-32, T-08-33, T-08-37 | digest: typed fields only, fixed command templates, ASCII, html escaping, caps; one email for findings, none for zero | unit | `cd hub; bun test test/task-qc-proposals.test.ts` ; `cd hub; bun test test/task-qc-digest-escape.test.ts` | created in task | pending |
| 08-07-T2 | 07 | 3 | D-20, D-21, D-22 | T-08-34, T-08-35, T-08-36 | one reserve per run under taskqc:<user>; exhausted skips before engine; release on throw; ENGINE failure email once per UTC day, no raw text | unit (mocks) | `cd hub; bun test test/task-qc-counter.test.ts` ; `cd hub; bun test test/task-qc-engine-failure.test.ts` ; `cd hub; bun test test/task-qc-tracer.test.ts` | created in task | pending |
| 08-07-T3 | 07 | 3 | D-22 | T-08-36 | reserve-caller allowlist + argument-shape pin; taskqc: key family registered | static pin | `cd hub; bun test test/reserve-caller-guard.test.ts` ; `cd hub; bun test test/counter-key-assignment-guard.test.ts` ; `cd hub; bun test test/session-start-senders-guard.test.ts` | exists (extended) | pending |
| 08-08-T1 | 08 | 3 | TQC-01, F2-B2, F2-B3 | T-08-39, T-08-40, T-08-41 | idempotent boot seed with NULL session anchor; flag-off zero DB calls; seed before loadAll + catchup (source-order pin) | unit + static | `cd hub; bun test test/task-qc-seed.test.ts` ; `cd hub; bun test test/task-qc-boot-order.test.ts` ; `cd hub; bun test test/automation-boot-order.test.ts` | created in task | pending |
| 08-08-T2 | 08 | 3 | TQC-08, SC5, F2-B3 | T-08-38 | flag OFF true no-op: registry load/register/replace, catchup, armed callback, seed, email; flag ON control | integration (mocks) | `cd hub; bun test test/task-qc-flag-off.test.ts` ; `cd hub; bun test test/scheduler.test.ts` ; `cd hub; bun test test/once-due-sweep.test.ts` | created in task | pending |
| 08-08-T3 | 08 | 3 | F2-B6 | T-08-42 | user/global halt stops the auditor; session-scope halt does not (null anchor, sessionId undefined pinned); malformed anchored row fails closed | integration (mocks) | `cd hub; bun test test/task-qc-halt-scope.test.ts` ; `cd hub; bun test test/scheduler-halt.test.ts` | created in task | pending |
| 08-09-T1 | 09 | 4 | TQC-01, F2-B2, F2-B4 | T-08-43, T-08-44 | REAL PG: CHECK accepts task_qc + survives re-apply with rows; partial unique index; NULL anchor survives session delete; findings CHECKs, uniqueness, ENGINE claim, cascade | CI-only helper | `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` ; `cd hub; bun test test/task-qc-schema.test.ts` | created in task | pending (CI) |
| 08-09-T2 | 09 | 4 | TQC-03, TQC-04, TQC-06 | T-08-43, T-08-44 | REAL PG: report-only row snapshot identical; 3 fixes + audit rows + executed rollback SQL; full-window-failed task stays enabled; row-lock serialization; open run blocks write; one claim under overlap | CI-only helper | `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` | created in task | pending (CI) |
| 08-09-T3 | 09 | 4 | (budget) | T-08-45 | helpers called from two existing gated test bodies; zero new test(), zero new skips | build + baseline | `cd hub; bun test test/e2e/schema-double-apply.e2e.test.ts` ; `cd hub; bun test test/e2e/orchestrator-tokencap.e2e.test.ts` | exists (extended) | pending (CI) |
| 08-10-T1 | 10 | 5 | F1-A1, F1-A6, TQC-07 | T-08-46, T-08-47 | 08-SPEC TQC-07 + 09-SPEC inherited-budget rows rewritten; stale cost rationale removed; planner decision record; consistency test | doc-consistency unit | `cd hub; bun test test/task-qc-spec-supersession.test.ts` | created in task | pending |
| 08-10-T2 | 10 | 5 | TQC-08 | T-08-48 | docs: scheduled-tasks section, CLAUDE.md env knobs, usage-cost counter key; ASCII only; docs-drift clean | docs + generator | `cd hub; bun test test/task-qc-spec-supersession.test.ts` ; `bun run docs:sync` | exists (extended) | pending |
| 08-10-T3 | 10 | 5 | SC3, SC5 | T-08-SC2 | roadmap plan list + SC3 wording; baseline re-measured with zero new skips; full phase gate | full gate | `bun run check-baseline` ; `bun run schema-lint` ; `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` ; `cd hub; Get-ChildItem test/task-qc-*.test.ts \| ForEach-Object { bun test $_.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }` | exists (extended) | pending |

---

## Success Criterion -> Test Map (ROADMAP Phase 8)

| SC | Statement | Proving test files |
|----|-----------|--------------------|
| SC1 | Six detectors run against real rows and classify without writing | `task-qc-detectors.test.ts` (fire + no-fire per detector, real unresolvable log_check, mapped repo_key control, internal anchors ignored), `task-qc-detectors-purity.test.ts` (zero sql calls + import allowlist), `task-qc-load.test.ts` (real-column queries), e2e helper `runTaskQcEngineChecks` (CI) |
| SC2 | Literal allowlist; an unlisted fix is impossible and a guard test asserts the writer rejects it | `task-qc-safe-fixes.test.ts` (hostile kinds, zero statements, immutable set), `task-qc-never-disables.test.ts` (static UPDATE-template guard), `task-qc-fix-planning.test.ts` |
| SC3 | Never auto-disables, never mutates in-flight work, never opens a dev loop; own ceiling | `task-qc-never-disables.test.ts`, `task-qc-engine.test.ts` (500-failure stays enabled), `task-qc-in-flight.test.ts`, `task-qc-no-llm-guard.test.ts` (import allowlist, zero token_usage), `task-qc-bounds.test.ts` (deterministic bounds), `task-qc-counter.test.ts` (lifetime counter); the literal 500K token knob is superseded by FORK-1 (08-10 Task 1) |
| SC4 | Everything not auto-fixed is one digest email with a proposal per finding | `task-qc-proposals.test.ts`, `task-qc-digest-escape.test.ts`, `task-qc-engine-failure.test.ts`, `task-qc-tracer.test.ts` |
| SC5 | Flag-gated, default OFF, empty allowlist => report-only | `task-qc-flags.test.ts`, `task-qc-flag-off.test.ts`, `task-qc-seed.test.ts`, `task-qc-fire-branch.test.ts`, `task-qc-engine.test.ts` (AUTOFIX off => zero UPDATE), e2e helper row-snapshot check (CI) |

## SPEC Requirement -> Test Map

| Req | Proving test files |
|-----|--------------------|
| TQC-01 recurring bounded meta-task, CHECK extended, second run dropped, no self-QC | `task-qc-schema.test.ts`, `task-qc-fire-branch.test.ts` (concurrent fire), `task-qc-detectors.test.ts` (self-exclusion), `task-qc-seed.test.ts`, CI helper (partial unique index) |
| TQC-02 six detectors | `task-qc-detectors.test.ts`, `task-qc-detectors-purity.test.ts` |
| TQC-03 allowlist-only writer, audit row, ambiguity => proposal, AUTOFIX default OFF | `task-qc-safe-fixes.test.ts`, `task-qc-fix-planning.test.ts`, `task-qc-engine.test.ts` |
| TQC-04 never auto-disables | `task-qc-never-disables.test.ts`, `task-qc-engine.test.ts` |
| TQC-05 one digest, zero findings => no email, body names every finding and fix | `task-qc-proposals.test.ts`, `task-qc-tracer.test.ts` |
| TQC-06 never mutates in-flight; concurrent runs cannot both write | `task-qc-in-flight.test.ts`, CI helper (row-lock overlap) |
| TQC-07 (superseded by FORK-1) no dev loop, no model, cannot enqueue a QC run | `task-qc-no-llm-guard.test.ts`, `task-qc-fire-branch.test.ts` (anti-chain), `task-qc-terminal.test.ts`, `task-qc-spec-supersession.test.ts` |
| TQC-08 flag OFF = true no-op | `task-qc-flag-off.test.ts`, `task-qc-fire-branch.test.ts`, `task-qc-seed.test.ts`, `task-qc-flags.test.ts` |

## Locked Verdict Amendment -> Task -> Test Map (GATES/verdict.md)

| Amendment | Encoded in | Proving test |
|-----------|------------|--------------|
| F1-A1 Rewrite 08-SPEC TQC-07 and the 09-SPEC inherited-budget table in this PR | 08-10 T1 | `task-qc-spec-supersession.test.ts` |
| F1-A2 task_qc terminal across the lifecycle: no generic post-run actions, no legacy chaining, even from malformed DB data; run produces no user_message, dispatch call, session launch, chain_task, token_usage row | 08-03 T3 (and T2 anti-chain sink) | `task-qc-terminal.test.ts`, `task-qc-fire-branch.test.ts` |
| F1-A3 Deterministic bounds replace the token bound: max audited tasks, history rows per task, auto-fixes per pass, statement/wall-clock timeout, rows written per run | 08-01 T3 (constants), 08-06 T1 (statement timeout + windowed read), 08-06 T3 (enforcement) | `task-qc-flags.test.ts`, `task-qc-load.test.ts`, `task-qc-bounds.test.ts` |
| F1-A4 Pure `runTaskQcPass(scope)`; scope can only narrow (Phase 9 seam) | 08-03 T1 (signature), 08-06 T2/T3 | `task-qc-engine-scope.test.ts`, `task-qc-no-llm-guard.test.ts` |
| F1-A5 Digest built only from typed fields | 08-03 T1 (minimal), 08-07 T1 | `task-qc-digest-escape.test.ts` |
| F1-A6 Remove the stale "cost is unmeasurable" rationale | 08-10 T1 | `task-qc-spec-supersession.test.ts` |
| F2-B1 Dedicated task_qc branch right after the kill-switch check, before quota/cost gates and target resolution; flag checked before any run insert; atomic one-open-run claim; one null-session run; engine; fire timestamps; finalize; return | 08-03 T1, T2 | `task-qc-tracer.test.ts`, `task-qc-fire-branch.test.ts` |
| F2-B2 Verify session_id nullability; do not anchor on a deletable session | 08-01 T1 (pins), 08-08 T1 (seed NULL), 08-09 T1 (real PG: session delete does not cascade) | `task-qc-schema.test.ts`, `task-qc-seed.test.ts`, CI helper |
| F2-B3 Seed before registry.loadAll + catchup; flag OFF excludes task_qc from loading AND catchup; armed callback returns before inserting a run; OFF = true no-op | 08-08 T1, T2 (and 08-03 T2 early return) | `task-qc-boot-order.test.ts`, `task-qc-flag-off.test.ts`, `task-qc-fire-branch.test.ts` |
| F2-B4 CHECK list edited in place (teab/work precedent); enum-sync test across scheduled-tasks.ts DAL, zod, auto-name, TaskType union, run-reaper | 08-01 T1 | `task-qc-enum-sync.test.ts`, `task-qc-schema.test.ts`, CI helper |
| F2-B5 System-owned row: PATCH/DELETE reject locked changes and deletion; allow only enable/disable + validated cadence/timezone | 08-05 T1, T2 | `task-qc-api-guards.test.ts` |
| F2-B6 Session-scope halt behavior pinned; hub kill switch stops it | 08-08 T3 (and 08-07 T2 sender halt) | `task-qc-halt-scope.test.ts`, `task-qc-counter.test.ts` |
| F2-B7 `__internal_*` rows (enabled=false by design) never flagged or fixed | 08-02 T1, 08-04 T2, 08-06 T1 (three layers) | `task-qc-detectors.test.ts`, `task-qc-in-flight.test.ts`, `task-qc-load.test.ts`, CI helper |
| X-1 (seat B pin) static grep guard: no on/off column in any UPDATE scheduled_tasks under hub/src/task-qc | 08-04 T1 | `task-qc-never-disables.test.ts` |
| X-2 (seat B pin) FOR UPDATE + in-flight re-check inside the same tx as the write and the findings insert | 08-04 T2 | `task-qc-in-flight.test.ts`, CI helper |
| X-3 (seat B pin) AUTOFIX default OFF with ENABLED prerequisite | 08-01 T3, 08-06 T2 | `task-qc-flags.test.ts`, `task-qc-engine.test.ts` |
| X-4 (seat B pin) lifetime counter reserved before the first write | 08-07 T2 | `task-qc-counter.test.ts` |
| X-5 (seat B) module-graph guard in both directions (Phase 9 imports Phase 8, never the reverse) | 08-06 T3 | `task-qc-no-llm-guard.test.ts` |

## Known Limitations (carried, not hidden)

- Real-Postgres assertions (plan 09) cannot run on the dev host; they execute in the PR's Woodpecker qc pipeline and must be green before merge.
- `recompute_next_run_at` is NOT on the allowlist (planner decision, 08-CONTEXT risk 2, evidence: `next_fire_at` mirrors the live registry). Unarmed-job findings are proposals carrying the exact PATCH that re-arms the job.
- Boot-only seeding: a user created after boot is audited from the next boot (08-CONTEXT A-08).
- The supervisor and web packages are untouched by this phase; no MSI or SPA release is required.

---

## Phase Gate (plan 10 Task 3)

1. Every `hub/test/task-qc-*.test.ts` exits 0 individually.
2. Phase 4 pin suites and the touched-neighbor suites named in the verify blocks exit 0 unchanged.
3. `bun run check-baseline` exit 0, skip count 259.
4. `bun run schema-lint` exit 0; no data-mutating statement added to `schema.sql`.
5. tsc error count not above the plan 01 PLAN_BASE count.
6. `bun run docs:sync` leaves `docs/openapi.json` and `docs/api.md` unchanged (or regenerated and committed).
7. Woodpecker qc pipeline green on the PR (runs the plan 09 real-Postgres helpers).
