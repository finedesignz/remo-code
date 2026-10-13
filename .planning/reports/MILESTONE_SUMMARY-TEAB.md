# Milestone Summary: TEAB (TEAB-as-a-scheduled-task)

Status: SHIPPED (PR #323 merged 2026-06-29; supervisor v0.12.0 PR #324 merged 2026-07-06). Artifacts thin for this summary: `.planning/TEAB-MILESTONE.md` and `docs/teab-tasks.md` exist in the repo per CLAUDE.md but were not read; summarized from CLAUDE.md + PR titles. TEAB is not listed in PROJECT.md Shipped Milestones.

## 1. Overview

Run `teab run --repo <X>` as a scheduled task on the supervisor host. A `task_type:'teab'` scheduled task drives it through allowlisted `teab_run` / `teab_status` supervisor commands, with a hub-driven poll-to-terminal loop.

## 2. Architecture

Hub `task_type:'teab'` sender, columns `teab_repo_ident` / `teab_last_status`; supervisor handlers; preflight fails closed; no `bypassPermissions` and no programmatic claude flags. Poll loop is idle-teardown-safe, then `finalizeRun` and post-run actions; cost/token cap unchanged.

## 3. Phases

Not recoverable from artifacts read. PRs: #323, #324.

## 4. Decisions

- Hub-side background poll to terminal; knobs `REMO_TEAB_POLL_INTERVAL_MS` (30s) and `REMO_TEAB_MAX_RUN_MS` (6h).
- Stale-run reaper ceiling coupled so a TEAB build is never reaped inside its own poll window.

## 5. Requirements

Not read (see `.planning/TEAB-MILESTONE.md`).

## 6. Tech Debt

A new signed supervisor MSI is required for `teab_run` to exist on installed hosts (release-gated). PROJECT.md DEBT milestone lists "TEAB MSI" as a half-live item.

## 7. Getting Started

`docs/teab-tasks.md`, `.planning/TEAB-MILESTONE.md`.
