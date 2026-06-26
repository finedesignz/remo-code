<!-- updated: 2026-06-26 -->
# Milestone BSA — Orchestrator Build-Session Autospawn — REQUIREMENTS

**Builds on:** Auto-Dev Orchestrator (Phases 21–32) + TMAC macro path + OEE e2e prove-out.
**Milestone CODE:** `BSA` (phase dirs/labels prefixed `BSA-NN-slug`, collision-safe per global rule).
**Architect-scoped 2026-06-26** (Backend Architect advisory recorded in STATE).

## Goal

Give the resume-heartbeat macro path an **online, hub-visible build session** to drive when a
build task is due, so the orchestrator can actually take an allowlisted target repo from
due→PR autonomously. Today the macro path only injects into ONLINE supervisor-connected
sessions; the owner's builds run as standalone local `claude` (invisible to the hub), so every
prod cycle is `no_session` and `pr_url` is NULL forever. Close that dead-end by **reusing the
already battle-tested scheduler launch path** (`launchSessionForUser` / `maybeLaunchOfflineSession`):
when a `dev` build task's session is offline but its supervisor is online and autospawn is enabled,
spawn a supervisor-hosted (hub-visible) session, park the macro prompt in grace, and let the
launched runner drain it. The whole capability sits behind a new **OFF-by-default** gate, an
**empty-by-default repo allowlist**, and a new **non-bypassable daily token/run ceiling** — so it
is safe to build + merge now without arming destructive autonomy.

## Requirements (REQ-IDs)

- **BSA-01 (autospawn gate):** New `REMO_ORCHESTRATOR_AUTOSPAWN` env gate (default OFF;
  accepts `1|true|yes|on`) + `isAutospawnEnabled()` helper, threaded into the macro cycle.
  No behavior change when OFF. Carries the existing `REMO_ORCHESTRATOR_ENABLED` gate (both must be ON).
- **BSA-02 (inject launch seam):** In `injectOrchestratorPrompt`, when `getChannel(sessionId)==null`
  AND autospawn ON AND the macro is a build type, call the existing `maybeLaunchOfflineSession` /
  `launchSessionForUser` path instead of returning `no_session`; let `dispatch()` park the prompt in
  grace exactly as the scheduler does. Map `launched`/`launch_pending`/`park`/`skip` onto `InjectOutcome`.
- **BSA-03 (repo allowlist):** Per-user/per-task repo allowlist (idempotent DDL only; any backfill a
  one-shot `hub/scripts/*.ts`, never inline in `schema.sql`). Autospawn refuses any repo not on the
  allowlist (`refused:not_allowlisted`). Default EMPTY = drives nothing.
- **BSA-04 (token/rate ceiling):** New **non-bypassable** `dailyTokenCapGate` in `hub/src/dispatch/gates.ts`
  (counts real tokens from `token_usage`, tz-day boundary, mirroring `getTodayTokenCostUsd`) + a per-day
  autospawn-launch count cap. Added to the orchestrator gate list ALONGSIDE the cost cap (never replacing
  it). Closes the reality-doc issue #6 (dollar cost cap is meaningless on a Max subscription).
- **BSA-05 (plan-first + no-auto-merge guard):** Assert the build macro prompt is plan-first and that an
  autospawned session cannot auto-merge to main (merge stays the off-hours window-gated `runMergeToMain`
  path). Guard test mirroring `orchestrator-macro-path-guard.test.ts`.
- **BSA-06 (autospawn build task type):** Ensure build-continuation tasks carry `macro_task_type=dev`
  (the 31 live tasks are all `log_check`); one-shot script to create/convert an allowlisted build task.
  Bound concurrency via existing `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY`.
- **BSA-07 (e2e prove-out):** OEE-style e2e test (real Postgres + stub supervisor): due build task +
  offline session + online supervisor → assert `session.start` fired, prompt parked, drain delivers,
  `routine_run_log.pr_url` populated on a simulated reply. `REMO_E2E_DB_URL`-gated, skips clean.
- **BSA-08 (docs + gated-flip runbook):** Update `docs/auto-dev-orchestrator.md` + `CLAUDE.md` env
  section; write the flip runbook (set allowlist → set token ceiling → flip `REMO_ORCHESTRATOR_AUTOSPAWN=1`
  → monitor `routine_run_log` for first real `pr_url`). `bun run docs:sync` if routes change.

## Non-negotiable invariants (carried)

- **Default OFF** — `REMO_ORCHESTRATOR_AUTOSPAWN` AND `REMO_ORCHESTRATOR_ENABLED` both required ON;
  empty allowlist = no-op. Nothing changes prod behavior on merge.
- **Cost cap stays non-bypassable** — `inject.ts` keeps `[thresholdGate, dailyCostCapGate]` and ADDS the
  token gate; never replaces the cost cap. The launch path goes through `reserveSessionSlot` (concurrency).
- **Plan-first + QC→PR, NEVER auto-merge** from an autospawned session (guard-tested).
- **No API key on the human PTY path** — this milestone touches only the automation (stream-json) injection
  path, which is legitimately cost+token-capped; keep it OFF the human `TerminalSurface`.
- `schema.sql` re-runs every boot → idempotent DDL only; backfills → `hub/scripts/` one-shots.
- `bun run check-baseline` green before PR. Never DROP/reset a DB without approval.

## Out of scope (this milestone)

- **Flipping `REMO_ORCHESTRATOR_AUTOSPAWN=1` in prod** — owner-authorized (outward-facing autonomy escalation).
- **Populating the repo allowlist values** — owner decision (which repos the bot may drive).
- **Setting the final prod token-ceiling number** — owner decision; this milestone ships a conservative default.
- Adopting/attaching to externally-launched standalone `claude` processes (architecturally impossible — the
  supervisor only manages sessions it spawns).
- Auto-merge to main from autospawned sessions; maintenance/security/brainstorming macro bodies (still stubs).
