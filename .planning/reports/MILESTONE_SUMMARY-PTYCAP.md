# Milestone Summary: PTYCAP (Token-Gate the Interactive PTY Path)

Status: IN PROGRESS. Phases 1-2 merged (#395, #493), Phase 3 PR #505 open (verified SHIP-WITH-NOTES 2026-10-13). Phase 4 PR #506 is also open (stacked on #505; opened 2026-10-13), although ROADMAP/STATE still say Phase 4 is "not started". Phases 5-9 not built (7-9 specced). Artifacts: good for P1-P3 (plans, summaries, verification), specs for P7-P9.

## 1. Overview

Goal: no programmatic turn may reach the interactive PTY without passing the full non-bypassable gate chain. This blocks every later milestone, because the owner decided the orchestrator will drive the PTY, and the PTY path had no token ceiling (dollar caps are theatre on a flat-rate subscription). Arming automation on an ungated PTY would repeat the 2026-07-11 incident (see BLEED).

## 2. Architecture

- Supervisor tails the PTY's own transcript JSONL (`pty-usage-emitter.ts`) and emits `usage_event` tagged `runner_type='pty-interactive'` into `token_usage` (additive column + CHECK), keeping interactive and programmatic buckets separate.
- `hub/src/dispatch/pty-preflight.ts`: programmatic writes must pass `[thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]`; a human variant omits the inject-rate ceiling. Wired into the `term.input` relay in `hub/src/ws/client.ts`.
- `hub/src/dispatch/governed-pty.ts`: `governedAutomationPtyGate` admits a non-human actor only with token cap + inject-rate ceiling + lifetime counter + kill switch; flag `REMO_GOVERNED_AUTOMATION_PTY`, default OFF.

Invariants (ROADMAP): no provider API key on the PTY path; actor server-inferred, never client-asserted; no dispatch path may spend outside the gate chain (`token-cap-coverage.test.ts`); caps denominated in tokens; additive idempotent DDL only.

## 3. Phases

| Phase | Status | PR / evidence |
|-------|--------|---------------|
| 1 PTY Token Accounting | Shipped, 4/4 plans. Verification: gaps_found (G-1 MAJOR, G-2 MINOR) | #395 merged 2026-09-10 |
| 2 PTY Pre-Flight Gate | Done, verification passed 3/3 | #493 merged 2026-09-28 |
| 3 Governed-Automation Guard | Complete 4/4 plans, SHIP-WITH-NOTES | #505 open |
| 4 Lifetime Inject Counter + Kill Switch | PR open (ROADMAP says not started; conflicting) | #506 open, stacked on #505 |
| 5 Throwaway-Repo Due-to-PR Proof | Not started | none |
| 6 Hardening + Docs + Release | Not started | none |
| 7 Unified Self-Heal Routing | Spec only (`07-SPEC.md`) | spec PR #353 |
| 8 Periodic Task QC + Optimization | Spec only (`08-SPEC.md`) | #353 |
| 9 Cap-Hit to QC Trigger | Spec only (`09-SPEC.md`) | #353 |

Dependency graph: P1 -> P2 -> P3 -> P4 -> P5 -> P6 strictly serial; P7 and P8 hang off P4; P9 needs P4 and P8.

## 4. Decisions

- Phase 2's first design (check once per fresh turn, only on `pty-interactive` sessions) was found dead in prod by a 3-lens QC panel (sessions default `runner_type='stream-json'`) and would have refused Ctrl-C/Esc mid-turn; redesigned (02-01-SUMMARY).
- Phase 3 admits nothing in production with the flag ON until Phase 4 replaces the fail-closed `kill_switch` and `lifetime_counter` placeholder governors.
- Phases 7-9 are written now, built later; they arm unattended AI spawning and require the Phase 4 counter + kill switch.
- Default daily token cap to be lowered from 50M to about 20M and an alarm at 60% (Phase 4 criteria).

## 5. Requirements

Success criteria per phase live in `.planning/ROADMAP.md`. P1: SC-1..3 PASS. P2: SC-1..3 PASS. P3: SC-1..4 PASS (SC-1 structurally). P4+: not yet verified.

## 6. Tech Debt

- P1 G-1 (MAJOR): dedupe keyed on record `uuid` overcounts; one API response spans several transcript records (measured 165 records vs 89 unique `message.id`, about 1.84x on a real transcript). Fail-safe for a cap but falsifies spend and skews the bucket comparison. Proposed fix: key on `message.id`.
- P1 G-2 (MINOR): live-Postgres proofs not observed in the verifier run (DB-gated).
- Bookkeeping: ROADMAP checkbox for Phase 1 unchecked and progress table lines stale; STATE.md pointer still at Phase 04 "planning".
- P3 note: ask/work/telegram gate call sites are not the PTY door; the door is the preflight plus structural pins.
- Phase 7 must rebase on #346 (already merged as BLEED).

## 7. Getting Started

Read `.planning/ROADMAP.md`, `docs/usage-cost.md` ("PTYCAP Phase 2" and "Phase 3"), `hub/src/dispatch/{pty-preflight,governed-pty}.ts`, `hub/test/token-cap-coverage.test.ts`, `hub/test/pty-door-guard.test.ts`. Next work is Phase 4 on top of #505/#506.
