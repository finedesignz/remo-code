---
phase: "4"
slug: "lifetime-inject-counter-kill-switch"
status: draft
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-13"
---

# Phase 4 - Validation Strategy

> Per-phase validation contract. Every command is ONE bun process per test file (Bun `mock.module` is process-global). No local Postgres exists: DB-backed proof is the single Woodpecker e2e test (04-08 T1) and runs in CI only.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Bun test 1.3.14 (hub unit tests are DB-free; leaf-module mocks; fake `sql` local to each test file) |
| **Config file** | `hub/bunfig.toml` (preload `./test/_setup.ts`) |
| **Quick run command** | `cd hub; bun test test/<touched>.test.ts` (one file per process); supervisor: `cd supervisor; bun test test/<file>.test.ts` |
| **Full suite command** | `bun run check-baseline` (per-file isolation; floors pass_min 1850, skip_max 260, fail_max 0; run with a 600 s timeout) |
| **Type gate** | `cd hub; bunx tsc --noEmit -p tsconfig.json \| grep -c "error TS"` must be <= 427 (baseline; CI treats tsc as informational, this is the usable gate) |
| **Other gates** | `bun run schema-lint` (exit 0); `bun run docs:sync` then no diff in `docs/openapi.json` / `docs/api.md` (docs-drift CI); supervisor tests below |
| **Skip budget** | baseline skip 259, `skip_max` 260: exactly ONE new skipped test is allowed in the whole phase (04-08 T1). Any other new skip, any `skip_max` bump, or a vacuous early-return in place of the DB gate fails the phase. |
| **Estimated runtime** | quick 2-10 s per file; full baseline several minutes |

---

## Sampling Rate

- **After every task commit:** the quick command for each test file the task touched, plus `bun run schema-lint` when schema.sql changed.
- **After every plan (wave end):** `bun run check-baseline` + the tsc count (plans 02-08 each end with it; mock breakage from the new `automation-controls` import is repaired with a leaf mock, never by weakening an assertion).
- **Before `/gsd-verify-work`:** full phase gate (below) green.
- **Max feedback latency:** 60 s for quick runs.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-T1 | 01 | 1 | G-1 | T-04-01, T-04-02 | one count per message.id, positive deltas only, replay-safe, bounded | unit (CI-gated file) | `cd supervisor; bun test test/pty-usage-tail.test.ts` ; `cd supervisor; bun test test/pty-usage-path-containment.test.ts` | extended in task | pending |
| 04-01-T2 | 01 | 1 | G-1 | T-04-03 | version 0.15.1 single-sourced | unit | `cd supervisor; bun test test/version-drift.test.ts` | yes | pending |
| 04-02-T1 | 02 | 2 | SC-1, SC-2 | T-04-04, T-04-05, T-04-07, T-04-09 | TRACER: counted before send, exhausts, halts, releases, frees slot; fail closed | integration over real pipeline+controls, fake sql | `cd hub; bun test test/automation-tracer.test.ts` ; `cd hub; bun test test/dispatch-pipeline.test.ts` ; `bun run schema-lint` | created in task | pending |
| 04-02-T2 | 02 | 2 | SC-1, SC-2 | T-04-08 | ledger count, reset marker, one page per epoch, kill DAL, boot asserts | unit (fake sql) | `cd hub; bun test test/automation-controls-core.test.ts` ; `cd hub; bun test test/automation-controls-config.test.ts` | created in task | pending |
| 04-02-T3 | 02 | 2 | SC-1, SC-2 | T-04-06 | env assert before listen, table assert after migrations | static pin | `cd hub; bun test test/automation-boot-order.test.ts` ; `cd hub; bun test test/mount-order.test.ts` | created in task | pending |
| 04-03-T1 | 03 | 3 | SC-1 | T-04-10, T-04-11, T-04-13 | one budget per orchestrator; replay re-enters dispatch; benign classes | unit | `cd hub; bun test test/orchestrator-inject-counterkey.test.ts` ; `cd hub; bun test test/orchestrator-autospawn-inject.test.ts` ; `cd hub; bun test test/orchestrator-macro-cycle.test.ts` | created/extended | pending |
| 04-03-T2 | 03 | 3 | SC-1 | T-04-11, T-04-12, T-04-14 | scheduler agent + triage carry `task:<id>` and both gates | unit | `cd hub; bun test test/scheduler-counter-keys.test.ts` ; `cd hub; bun test test/scheduler-dispatch.test.ts` | created in task | pending |
| 04-03-T3 | 03 | 3 | SC-1 | T-04-10, T-04-11 | reserve semantics, idempotency, D-10 promotion re-gate, key + replay static pins | unit + static pin + full baseline | `cd hub; bun test test/dispatch-reserve.test.ts` ; `cd hub; bun test test/counter-key-assignment-guard.test.ts` ; `cd hub; bun test test/replay-reentry-guard.test.ts` ; `bun run check-baseline` | created in task | pending |
| 04-04-T1 | 04 | 3 | SC-1, SC-2 | T-04-16, T-04-17 | real delegates (identity), counting rate governor, no not-implemented reasons | unit | `cd hub; bun test test/governed-pty-gate.test.ts` ; `cd hub; bun test test/telegram-human-only-guard.test.ts` ; `cd hub; bun test test/human-only-guard.test.ts` ; `cd hub; bun test test/token-cap-coverage.test.ts` | yes (rewritten) | pending |
| 04-04-T2 | 04 | 3 | SC-1, SC-2 | T-04-15, T-04-17..T-04-20 | door reserves after governors; human chain untouched; supplier + reserve-caller pins | unit + static pin | `cd hub; bun test test/pty-preflight.test.ts` ; `cd hub; bun test test/reserve-caller-guard.test.ts` ; `cd hub; bun test test/human-interactive-flag-guard.test.ts` ; `cd hub; bun test test/pty-door-guard.test.ts` ; `cd hub; bun test test/ws-client-pty-preflight.test.ts` | yes / created | pending |
| 04-05-T1 | 05 | 3 | SC-2 | T-04-21..T-04-23 | tenancy (admin global, session IDOR), no stop on engage | route unit | `cd hub; bun test test/automation-api.test.ts` | created in task | pending |
| 04-05-T2 | 05 | 3 | SC-2 | T-04-22 | step-up on release/reset only; OpenAPI + docs drift clean | mount + generator | `cd hub; bun test test/mount-order.test.ts` ; `bun run docs:sync` | yes | pending |
| 04-05-T3 | 05 | 3 | SC-3 | T-04-24..T-04-26 | event-driven alarm, durable claim, delivered flag, trailing edge, existing DAL tests untouched | unit (injected deps) | `cd hub; bun test test/token-usage-listener.test.ts` ; `cd hub; bun test test/token-cap-alarm.test.ts` ; `cd hub; bun test test/usage-event-handler.test.ts` ; `cd hub; bun test test/token-usage-runner-type.test.ts` ; `cd hub; bun test test/pty-usage-midflight-visibility.test.ts` | created in task | pending |
| 04-06-T1 | 06 | 4 | SC-2 | T-04-27 | kill gate first in error-capture, feedback, revanote lists | unit | `cd hub; bun test test/error-capture-dispatch.test.ts` ; `cd hub; bun test test/revanote-dispatch.test.ts` ; `cd hub; bun test test/token-cap-coverage.test.ts` | yes | pending |
| 04-06-T2 | 06 | 4 | SC-2 | T-04-27, T-04-29 | kill gate first in ask/work; structural coverage + human allowlist + counter exemption set | static scan | `cd hub; bun test test/kill-switch-coverage.test.ts` ; `cd hub; bun test test/ext-ask-gates.test.ts` ; `cd hub; bun test test/ext-work-gates.test.ts` ; `cd hub; bun test test/cloud-send.test.ts` | created in task | pending |
| 04-06-T3 | 06 | 4 | SC-2 | T-04-28, T-04-30, T-04-31 | fireTask halt incl. isManual, once-task not claimed, tick idles | unit + full baseline | `cd hub; bun test test/scheduler-halt.test.ts` ; `cd hub; bun test test/orchestrator-tick-halt.test.ts` ; `cd hub; bun test test/once-tasks.test.ts` ; `bun run check-baseline` | created in task | pending |
| 04-07-T1 | 07 | 5 | SC-2 | T-04-32..T-04-35 | machine option on launch primitives; auto-launch halt before debounce; orchestrator orphan defer | unit | `cd hub; bun test test/launch-machine-guard.test.ts` ; `cd hub; bun test test/orchestrator-autolaunch-halt.test.ts` ; `cd hub; bun test test/orphan-resume-halt.test.ts` ; `cd hub; bun test test/orphan-resume.test.ts` | created in task | pending |
| 04-07-T2 | 07 | 5 | SC-2 | T-04-32, T-04-36, T-04-37 | machine callers pass the option; launch-caller and session.start enumerating pins | static pin | `cd hub; bun test test/launch-callers-guard.test.ts` ; `cd hub; bun test test/session-start-senders-guard.test.ts` ; `cd hub; bun test test/orchestrator-autospawn-inject.test.ts` | created in task | pending |
| 04-07-T3 | 07 | 5 | SC-2 | T-04-35 | release resumes deferred orchestrator orphans (best-effort, supervisor-scoped) | route unit + full baseline | `cd hub; bun test test/automation-api.test.ts` ; `bun run check-baseline` | extended | pending |
| 04-08-T1 | 08 | 6 | SC-1, SC-2, SC-3 | T-04-04, T-04-40 | real Postgres: concurrent reserve = exactly cap rows, unique indexes, claims, real inject path | e2e (CI only, 1 skipped locally) | `cd hub; bun test test/e2e/automation-controls.e2e.test.ts` (expect 1 skip) ; `grep -c "^\s*test(" hub/test/e2e/automation-controls.e2e.test.ts` = 1 | created in task | pending |
| 04-08-T2 | 08 | 6 | SC-2 (docs) | T-04-41 | emergency paths + residuals documented; stale not-implemented text gone | doc test + grep | `cd hub; bun test test/docs-supersession.test.ts` ; `git grep -n "governor_not_implemented" -- docs CLAUDE.md` (empty) | yes | pending |
| 04-08-T3 | 08 | 6 | SC-4 (+ all) | T-04-38, T-04-39 | cap 20M LAST commit; baseline re-measured; phase gate | full suite + guards | `bun run check-baseline` ; `cd hub; bun test test/token-cap-gate-fires.test.ts` ; `cd hub; bun test test/orchestrator-token-cap.test.ts` ; `cd hub; bun test test/orchestrator-inject-rate-gate.test.ts` ; `bun run schema-lint` ; supervisor tests + five SC-4 guards | yes | pending |

*Status: pending / green / red / flaky*

---

## Phase gate (before `/gsd-verify-work`)

1. `bun run check-baseline` -> fail 0, skip <= 260, pass >= pass_min.
2. `cd hub; bunx tsc --noEmit -p tsconfig.json | grep -c "error TS"` <= 427.
3. `bun run schema-lint` exit 0; `bun run docs:sync` leaves no diff.
4. Supervisor: `cd supervisor; bun test test/pty-usage-tail.test.ts`, `...pty-usage-path-containment.test.ts`, `...version-drift.test.ts` pass; the five SC-4 guards (`no-api-key-no-streamjson-pty`, `no-apikey-fallback-guard`, `default-backend-selector`, `pty-spawn-interception`, `no-legacy-agent-spawn`) pass with no file under `supervisor/test` changed except `pty-usage-tail.test.ts`.
5. Commit order: 04-01 commits first; the cap commit (04-08 T3) is the final commit on the branch.
6. Woodpecker (CI only): `automation-controls.e2e.test.ts` plus every existing orchestrator e2e through the new reserve / kill-switch / key-resolver path; `schema-double-apply.e2e.test.ts` converges with the three new tables.

---

## Wave 0 Requirements

Existing infrastructure covers the phase; two conventions are established in the tracer and reused:
- Leaf mock of `../src/dispatch/automation-controls.ts` (pass-through gates, `isAutomationHalted` -> `{halted:false}`, constant key resolver) with cache-busted `?t=${Date.now()}` imports, the `pty-preflight.test.ts` pattern.
- A local fake `sql` (tagged template with `.begin(fn)`) per test file that emulates only the statements that file exercises (`token-usage-runner-type.test.ts` pattern).
Known mock-breakage set (research S11, S14), repaired only where `check-baseline` shows a break: dispatcher-disabled-guard, error-capture-dispatch, once-tasks, orchestrator-metrics, revanote-dispatch, scheduler-bounds-autodisable, scheduler-dispatch, teab-e2e, teab-sender (mock `dispatch/gates.ts`); orchestrator-autospawn-inject, orchestrator-command-prompts (inject deps); the three `recordTokenUsage` DAL tests must NOT need changes (listener registry).

---

## Source coverage audit (GOAL / REQ / RESEARCH / CONTEXT)

**GOAL "A slow grind is as impossible as a fast loop":** SC-1 lifetime ledger (04-02/03/04/08), SC-2 kill switch (04-02/05/06/07), SC-3 alarm (04-05), SC-4 cap (04-08). **REQ:** G-1 -> 04-01; SC-1 -> 02,03,04,08; SC-2 -> 02,04,05,06,07,08; SC-3 -> 05; SC-4 -> 08. No requirement id is unplanned.

| CONTEXT | Covered by | | RESEARCH | Covered by |
|---|---|---|---|---|
| D-01 key + ledger | 02-T1, 03-T1/T2/T3 (pin) | | S1 boot split | 02-T3 (F-1) |
| D-02 reserve | 02-T1, 03-T3, 08-T1 | | S2 cloud send human | 06-T2 (F-2) |
| D-03 replay + PTY reserve | 03-T1/T3, 04-T2 (F-6) | | S3 pre-dispatch spawns | 07-T1/T2 (F-2) |
| D-04 cap, boot, reset, classes | 02-T2/T3, 03-T1, 05-T1 | | S4 orphan defer | 07-T1/T3 (F-4) |
| D-05 coverage matrix | 03-T1/T2, 06-T2 | | S5 atomicity | 02-T1, 08-T1 (F-3) |
| D-06 kill table, routes | 02-T1/T2, 05-T1/T2 | | S6 slot release | 02-T1, 03-T3 (F-3) |
| D-07 no blanket stop | 05-T1 (pin) | | S7 skip headroom | 08-T1 (F-8) |
| D-08 gate first everywhere | 03-T1/T2, 04-T1, 06-T1/T2 | | S8 qc.yaml supervisor | 01-T1, 08-T2 (PR body) |
| D-09 entry points + pins | 02-T1 (c), 06-T3, 07-T1/T2 | | S9 cron/triage budgets | 03-T2 (F-5a/b) |
| D-10 queue not purged | 03-T3 | | S10 orchestrator budgets | 02-T1, 03-T1 (F-5c) |
| D-11 slot hand-off | 04-T1 | | S11 gates.ts mocks | all plans (leaf-mock repair) |
| D-12 no gate signature change | 02-T1, 03-T3 (reason pin) | | S12 Telegram source union | 06-T2 (exemption pin) |
| D-13 alarm | 05-T3 (F-7) | | S13 once-task burn | 06-T3 (F-4) |
| D-14 20M last | 08-T3 | | S14 DAL tests | 05-T3 (F-7) |
| D-15 G-1 first | 01 | | S15 tsc baseline | every plan gate |
| D-16 boot asserts | 02-T2/T3 | | Phase 3 QC adversary item | 04-T1/T2 (F-6) |
| D-17 emergency path docs | 08-T2 | | ROADMAP hand-off (counted before trusted) | 04-T2 |
| D-18 top-level only | 03-T3 | | | |
| D-19 invariants | schema-lint in 02; skip budget 08-T1 | | | |

Deferred items (kill-switch UI/Telegram trigger, active-run cancellation, per-user aggregate ceiling, Phase 5/7/8/9 consumers) appear in no plan task; 04-08 T2 records them in ROADMAP.

---

## Validation Sign-Off

- [x] Every task has an `<automated>` verify or an explicit CI-only note
- [x] Sampling continuity: no 3 consecutive tasks without an automated check
- [x] Wave 0 conventions stated
- [x] No watch-mode flags; one bun process per test file
- [ ] `nyquist_compliant` stays true only if every pending row turns green

**Approval:** pending execution
