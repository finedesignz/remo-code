# Milestone Summary: once (One-Time Scheduled Tasks)

Status: SHIPPED (PR #371 merged 2026-07-14). Artifacts thin: summarized from CLAUDE.md and the PR title. Not listed in PROJECT.md.

## 1. Overview

One-time tasks are `scheduled_tasks` rows with `schedule_kind='once'` and `run_at`: they fire exactly once, then self-finalize with no re-arm. `/api/ext/work` enqueues each item as a gated one-time task.

## 2. Architecture

Reuses the whole cron pipeline: dispatch, gates, `finalizeRun`, post-run actions, email summary. Trust checks (repo allowlist, site, sender) run at CREATE (403 before any row/spend) and the non-bypassable gate list runs again at RUN.

## 3. Phases

Single PR #371. `/api/ext/ask` still on its own path (TODO in CLAUDE.md docs map).

## 4. Decisions

No parallel queue; no scheduling path may reach a repo or site that direct dispatch could not.

## 5. Requirements

None on disk. Contract tests: `hub/test/scheduler.test.ts`, `once-tasks.test.ts`, `once-work-sender.test.ts`.

## 6. Tech Debt

`/ask` not yet migrated onto one-time tasks.

## 7. Getting Started

`docs/scheduled-tasks.md` section on one-time tasks.
