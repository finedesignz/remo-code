# Milestone Summary: TMAC (Autonomous Task-Type Macro Prompts)

Status: SHIPPED 2026-06-08 per PROJECT.md (PRs merged 2026-06-08 to 2026-06-09). Artifacts thin: only `milestones/TMAC-REQUIREMENTS.md`; phases TMAC-01..06 have no directories on disk.

## 1. Overview

Replace the per-micro-command-row orchestrator cycle with ONE autonomous macro prompt per `task_type` (dev, maintenance, security, brainstorming), a resume-heartbeat controller, a specialist-decides gate ladder, a stage-aware notification matrix, and three sentinel blocks (`<<STATE>>`, `<<NOTIFY>>`, `<<GATE>>`). Spec: `.planning/architecture/auto-dev-task-prompts-SPEC.md` (locked 2026-06-08).

## 2. Architecture

`hub/src/orchestrator/`: `sentinels.ts` (pure parse), `task-macros.ts` (registry), `notify.ts` (best-effort fan-out), `macro-cycle.ts` (`runMacroCycle`). Controller reconciles the prior reply's sentinels into `routine_run_log`, halts on a mandatory gate per `lifecycle_stage`, else re-injects, cost-capped. The repo's own `.planning/STATE.md` is the resume source of truth.

## 3. Phases

TMAC-01..06 (names not recoverable from artifacts). PRs: #270 spec (2026-06-08), #271 macro prompts milestone (2026-06-09), #273 maintenance/security/brainstorming prompts (2026-06-09), #274 hybrid run fixes F-01/F-02/F-05, #275 macro-seam observability F-10/F-11/F-12, #280 F-11 over-skip fix (2026-06-11).

## 4. Decisions

- A task is one row (`task_type` + schedule), not N command rows (R-TMAC-05).
- Micro-row path retired (R-TMAC-06); its `REMO_ORCHESTRATOR_LEGACY_WAVES` rollback lever was later deleted (CLAUDE.md: guarded by `orchestrator-macro-path-guard.test.ts`).
- Idempotent DDL only; backfills in one-shot `hub/scripts/` (`migrate-orchestrator-macro-task-type.ts`).

## 5. Requirements

R-TMAC-01 sentinels, 02 task-macros, 03 notify, 04 controller resume-heartbeat, 05 data + UI, 06 retire micro-row path. Per-requirement verification not on disk; later proven by OEE.

## 6. Tech Debt

- Maintenance, security, brainstorming macros were stubs at first (completed by #273).
- 2026-06-27: orchestrator self-scoped OBSRV and broke main (#309 through red CI); #312 added roadmap-scoped milestone selection.

## 7. Getting Started

`docs/auto-dev-orchestrator.md`, `.planning/architecture/auto-dev-task-prompts-SPEC.md`, `hub/src/orchestrator/macro-cycle.ts`.
