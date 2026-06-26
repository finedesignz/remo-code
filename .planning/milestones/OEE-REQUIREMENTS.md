<!-- updated: 2026-06-25 -->
# Milestone OEE — Orchestrator E2E Prove-Out — REQUIREMENTS

**Builds on:** Auto-Dev Orchestrator (Phases 21–32) + Milestone TMAC (macro path).
**Milestone CODE:** `OEE` (phase dirs/labels prefixed `OEE-NN-slug`, collision-safe per global rule).
**Nature:** Pure VALIDATION of already-merged, flag-gated-OFF code. No new product scope, no prod flag flip.

## Goal

Prove the Auto-Dev Orchestrator + TMAC macro path works end-to-end against **real Postgres**
and a **scripted bound-session sink** in an **isolated harness** — never in prod, never against
the prod DB — so the `REMO_ORCHESTRATOR_ENABLED` flag can later be flipped with EVIDENCE instead
of hope. The live cycle (drain worker → per-session lock → controller → dependency-aware waves →
cost-cap gate → `runMacroCycle` sentinel reconciliation → stage-gated notify → verify-tail) has
strong unit coverage but has NEVER run e2e against real Postgres + a real bound session
(`docs/auto-dev-orchestrator.md` flags it "e2e-unproven, dormant"). This milestone closes that
single gap and produces a written go/no-go enablement runbook.

## Requirements (REQ-IDs)

- **OEE-01 (harness + ephemeral PG):** An isolated e2e harness boots the real `hub/src/db/schema.sql`
  unmodified against an EPHEMERAL non-prod Postgres, guarded by an explicit non-prod DSN check that
  refuses to run if `DATABASE_URL` resembles the Coolify prod DSN.
- **OEE-02 (scripted session sink):** A scripted bound-session sink captures prompts injected by the
  orchestrator and replays canned agent replies containing `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>`
  sentinels — deterministic, no live `claude` subprocess.
- **OEE-03 (queue + lock concurrency):** E2e-prove `routine_queue` + drain worker + per-session
  running-lock under real PG: global concurrency cap holds, per-session coalescing (no stacking),
  stale/foreign queue entries are no-ops.
- **OEE-04 (due-rows → waves):** E2e-prove real `orchestrator_rows` + `schedule_rule` windows flow
  through the due-scan → controller → dependency-aware wave ordering (plan→execute→ship;
  merge-to-main excluded outside its active window).
- **OEE-05 (macro cycle + sentinels):** E2e-prove TMAC `runMacroCycle`: one macro prompt per
  `macro_task_type`, sentinel reconciliation into `routine_run_log` (STATE→rationale/outcome),
  halt on an open mandatory gate per `lifecycle_stage`, re-inject otherwise.
- **OEE-06 (cost-cap holds on live path):** E2e-prove every injected turn traverses the
  non-bypassable `dailyCostCapGate`; force the cap and confirm dispatch is BLOCKED. Prove, never weaken.
- **OEE-07 (stage-gated notify):** E2e-prove `notify.ts` stage matrix fires correctly off reconciled
  `<<NOTIFY>>`/`<<GATE>>` sentinels (dev=silent, prod-maintenance=halt+notify) with NO real outbound
  side effects (channels stubbed/captured).
- **OEE-08 (verify-tail):** E2e-prove the terminal verify-tail runs every tick with `REMO_VERIFY_*`
  pointed at a stub target and records its result; confirm it is a clean no-op when the envs are unset.
- **OEE-09 (legacy-wave rollback parity):** Smoke the documented rollback lever
  (`REMO_ORCHESTRATOR_LEGACY_WAVES=1`) through the same harness so it is proven, not assumed.
- **OEE-10 (entrypoint + runbook):** A single `bun run orchestrator:e2e` entrypoint wires the harness
  (OEE-01..09); a go/no-go enablement runbook (staging-first flip checklist, concurrency/cost defaults,
  rollback) is written. Prod flag stays OFF.
- **OEE-11 (QC + docs reconcile):** Triple-QC green (`bun run check-baseline`); docs sweep replaces
  "e2e-unproven" in `docs/auto-dev-orchestrator.md` with the proven matrix + runbook link; STATE.md
  reconciled.

## Non-negotiable invariants (carried)

- **NEVER flip `REMO_ORCHESTRATOR_ENABLED` in prod as part of this milestone.** Validation runs in the
  isolated harness only; the prod flag-flip is a separate, later, human go/no-go — OUT OF SCOPE here.
- **NEVER point the harness `DATABASE_URL` at the Coolify prod DB.** Explicit non-prod DSN guard (OEE-01).
- **Cost-cap is proven, not weakened** — no bypass added for "test convenience" (OEE-06).
- **Zero schema changes expected** — `schema.sql` re-runs every boot (idempotent DDL only); any fixture
  seeding is a one-shot/harness-local script, never inline in `schema.sql`. This is validation, not feature work.
- **No provider API key on the human PTY path** — the orchestrator path is the programmatic/stream-json
  automation path (legitimately cost-capped); keep it strictly separate from the human PTY surface.
- **Real-session caution:** prefer the scripted sink over a live `claude` subprocess; never perturb the
  prod orchestrator session or the `idx_sessions_orchestrator_unique` one-per-user invariant.
- `bun run check-baseline` green before PR. One phase = one branch = one PR.
- Never DROP/reset a DB without approval.

## Out of scope (this milestone)

- Flipping the orchestrator live in prod on real repos (separate human go/no-go).
- The PTY cutover-flip + ChatSurface deletion (blocked on the postponed Anthropic billing measurement).
- Full maintenance/security/brainstorming macro prompt bodies (still stubs).
- New orchestrator product features — this milestone only EARNS the right to propose enablement.
