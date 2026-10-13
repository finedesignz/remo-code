# Milestone Summary: OEE (Orchestrator E2E Prove-Out)

Status: SHIPPED 2026-06-26 (PR #300; docs closeout #301; STATE mark #302). Artifacts: good (`milestones/OEE-REQUIREMENTS.md`, 10 phase SUMMARY files).

## 1. Overview

Pure validation of already-merged, flag-gated-OFF orchestrator + TMAC code: prove the live cycle works end to end against REAL Postgres and a scripted bound-session sink in an isolated harness, so the flag can be flipped on evidence. No product scope, no prod flag flip, zero `hub/src` or `schema.sql` change.

## 2. Architecture

`hub/test/e2e/` harness boots the real `schema.sql` unmodified against ephemeral non-prod Postgres (refuses a DSN resembling the Coolify prod DSN). A scripted sink (`createScriptedSink`) captures injected prompts and replays canned sentinel replies, with no live `claude`. Entry point `bun run orchestrator:e2e`, run in Woodpecker `qc.yaml` against `postgres:16` (`REMO_E2E_DB_URL`).

## 3. Phases

| Phase | Outcome |
|-------|---------|
| OEE-01 | E2E harness + ephemeral Postgres with prod-DSN guard |
| OEE-02 | Scripted bound-session sink |
| OEE-03 | Queue + per-session lock concurrency |
| OEE-04 | Due rows to dependency-aware waves |
| OEE-05 | `runMacroCycle` + sentinel reconciliation (8 tests) |
| OEE-06 | Non-bypassable cost cap holds on the real inject path |
| OEE-07 | Stage-gated notify with no real outbound |
| OEE-08 | Verify-tail always runs / no-op when unset |
| OEE-09 | Legacy-wave rollback parity (lever later deleted) |
| OEE-10 | Entrypoint, runbook, CI wiring, docs sweep |

## 4. Decisions

- Validate through existing DI seams; add no production seam.
- Tests skip cleanly without `REMO_E2E_DB_URL`; green Woodpecker CI is the standing proof.

## 5. Requirements

OEE-01..OEE-11 defined; OEE-01..10 have SUMMARY files. OEE-11 (triple-QC + docs reconcile) is folded into the OEE-10/11 summary.

## 6. Tech Debt

- STATE.md notes the remaining gap is architectural: the macro path only drives ONLINE supervisor-connected sessions, so owner local builds never produce a PR (motivated BSA).
- OEE-01 summary records a worktree baseline pre-broken by an unrelated merge conflict.
- Later lesson (memory index): local PGlite is laxer than CI `postgres:16`.

## 7. Getting Started

`bun run orchestrator:e2e` with `REMO_E2E_DB_URL` pointing at a disposable Postgres; read `hub/test/e2e/`.
