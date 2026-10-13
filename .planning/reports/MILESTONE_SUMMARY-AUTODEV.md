# Milestone Summary: Auto-Dev Orchestrator (Phases 21-32)

Status: SHIPPED flag-OFF 2026-06-07 (PR #266). Artifacts thin: no milestone directory; summarized from CLAUDE.md, STATE.md and PR history. Cycle design superseded by TMAC.

## 1. Overview

Session-level auto-dev: one `orchestrator` task per session plus `orchestrator_rows`, a global `routine_queue` with a per-session lock, and a verify-tail. Gated by `REMO_ORCHESTRATOR_ENABLED` (default OFF; STATE.md notes it was later ON in prod in monitoring mode).

## 2. Architecture

`hub/src/orchestrator/` (queue, controller, inject, verify-tail). Dispatch rides the shared `hub/src/dispatch/` gates. Spec: `.planning/architecture/auto-dev-task-prompts-SPEC.md`; doc: `docs/auto-dev-orchestrator.md`.

## 3. Phases

Phases 21-32 delivered in one PR (#266), plus #267 (Postgres e2e gate in CI). Precursor "auto-dev build" PRs, all 2026-05-31: #216 (schedule windows), #217 (dev_controller state-gate), #218 (propose-to-chat), #219 (qc-review loop), #220 (Coolify error-fix-redeploy loop).

## 4. Decisions

Gate the existing scheduler dev chain rather than build a parallel engine (from memory index entry project_auto_dev_build; not verified against a primary artifact).

## 5. Requirements

No requirements file. Not auditable.

## 6. Tech Debt

E2e-unproven at ship time (closed later by OEE). Legacy per-row wave path later deleted (see TMAC, BLEED).

## 7. Getting Started

`docs/auto-dev-orchestrator.md`, then the OEE and TMAC summaries.
