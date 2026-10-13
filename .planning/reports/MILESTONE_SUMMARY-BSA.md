# Milestone Summary: BSA (Orchestrator Build-Session Autospawn)

Status: SHIPPED 2026-06-26 (PR #303), all capability OFF by default. Artifacts: good (`milestones/BSA-REQUIREMENTS.md`, 8 phase SUMMARY files).

## 1. Overview

Give the macro path an online, hub-visible build session to drive when a `dev` build task is due. Before BSA every prod cycle was `no_session` and `pr_url` stayed NULL because the owner's builds ran as standalone local `claude`. BSA reuses the scheduler launch path (`launchSessionForUser`) to spawn a supervisor-hosted session, parks the macro prompt in grace, and lets the runner drain it.

## 2. Architecture

`maybeAutospawnOffline` in `hub/src/orchestrator/inject.ts`: AND-chain of orchestrator ON, autospawn ON, build macro, repo allowlisted, supervisor online, under token cap, under launch cap. Any miss returns the unchanged `no_session`. Allowlist table `orchestrator_autospawn_allowlist` (default empty). Runbook `docs/orchestrator-autospawn-runbook.md`.

## 3. Phases

| Phase | Outcome |
|-------|---------|
| BSA-01 | `REMO_ORCHESTRATOR_AUTOSPAWN` gate, `isAutospawnEnabled()` |
| BSA-02 | Inject launch seam; `dailyTokenCapGate` added alongside cost cap |
| BSA-03 | Repo allowlist, fail-closed when empty |
| BSA-04 | Token cap (default 50M/day) + daily launch cap (20) |
| BSA-05 | Plan-first and no-auto-merge guard test |
| BSA-06 | Autospawn build task type + operator one-shot script |
| BSA-07 | E2E prove-out (happy path + 5 gate no-ops) |
| BSA-08 | Docs and owner GO/NO-GO flip runbook |

## 4. Decisions

- Token ceiling added ALONGSIDE the dollar cap (dollar cap is meaningless on a flat-rate Max subscription).
- Capability inert until the owner arms: allowlist plus flag flip.
- Seam structurally cannot trigger merge-to-main.

## 5. Requirements

BSA-01..BSA-08 each map to the same-numbered phase; all have SUMMARY files.

## 6. Tech Debt

- The token cap shipped blind to cache-read tokens; this contributed to the 2026-07-11 incident fixed in BLEED (#342).
- Arming remained an owner decision; memory notes report overnight autonomy not reliably achieved.

## 7. Getting Started

Read `docs/orchestrator-autospawn-runbook.md` and `hub/test/e2e/orchestrator-autospawn.e2e.test.ts`.
