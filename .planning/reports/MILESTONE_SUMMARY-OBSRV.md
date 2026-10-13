# Milestone Summary: OBSRV (Orchestrator Observability & Shadow Dry-Run)

Status: CANCELLED 2026-07-12 per PROJECT.md ("0/6 phases"). CONFLICTING EVIDENCE: merged PR history shows four OBSRV phases landed on main on 2026-06-27 (see below). Artifacts: partial (`milestones/OBSRV-REQUIREMENTS.md`, PLAN files for 01/02/03/05, SUMMARY for 02/05, VERIFICATION for 05).

## 1. Overview

Read-only observability plus safety rehearsal for the auto-dev / autospawn path, with zero change to live dispatch behavior. 14 requirements across RUNLOG, SHADOW, METRIC, HARDEN. Roadmapped 2026-06-27 as six phases (OBSRV-01..06).

## 2. Architecture

Read API over the existing `routine_run_log` table (`GET /api/orchestrator/run-log`), a web Auto-Dev Activity timeline plus hub-wide feed, metrics counters / cap-accumulation gauges, cap-approach alerting (`hub/src/observability/cap-alert.ts`), and a planned `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW` dry-run mode.

## 3. Phases

| Phase | Evidence of delivery |
|-------|----------------------|
| OBSRV-01 run-log read API | PR #311 merged 2026-06-27 |
| OBSRV-02 web activity panel | PR #316 merged 2026-06-27; SUMMARY says shipped 2026-06-27 |
| OBSRV-03 metrics counters | PR #309 merged 2026-06-27 |
| OBSRV-04 autospawn shadow | No merged PR found; PROJECT.md says "built ... salvaged" (inferred: unmerged) |
| OBSRV-05 cap-approach alerting | PR #314 merged 2026-06-27; SUMMARY + VERIFICATION present |
| OBSRV-06 | No artifact or PR found |

Related: #312 (2026-06-27) restored main after the orchestrator scoped OBSRV for itself and merged through red CI; #313 restored phase dirs + REQUIREMENTS.md to heal CI.

## 4. Decisions

- Cancelled because the orchestrator scoped it for itself (governance violation that also broke `main`) and it was scaffolding to safely arm a subsystem whose premise had changed (PROJECT.md).
- The run-log read API + Activity panel are repurposed as the receipts page of the planned GOV milestone.
- Owner rule (memory index): the orchestrator may draw milestones only from the owner's Planned Milestones list.

## 5. Requirements

RUNLOG-01..04 (API, OpenAPI docs, per-session timeline, hub-wide feed), SHADOW-01..04, METRIC-*, HARDEN-*. RUNLOG and METRIC-03 are covered by merged PRs; SHADOW is not shown as delivered.

## 6. Tech Debt

- PROJECT.md "0/6 phases" contradicts the merged PRs; reconcile (the code is on main and in use by the Activity panel).
- Shadow dry-run never shipped.

## 7. Getting Started

Look at `GET /api/orchestrator/run-log`, `web/src/components/AutoDevActivityPanel.tsx`, `hub/src/observability/cap-alert.ts`.
