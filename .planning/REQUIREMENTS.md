<!-- updated: 2026-06-27 -->
# Requirements — Milestone OBSRV (Orchestrator Observability & Shadow Dry-Run)

> Scope: read-only observability + safety-rehearsal for the auto-dev/autospawn path. ZERO behavior
> changes to the live dispatch path. Additive idempotent DDL only. Prior-milestone requirements are
> archived under `.planning/milestones/` (v1.0, TMAC, OEE, BSA).

## Milestone OBSRV Requirements

### Run-Log Surface (RUNLOG)
- [ ] **RUNLOG-01**: A user can fetch their orchestrator run history via a read-only, user-scoped,
  paginated `GET /api/orchestrator/run-log` (per-session filter + hub-wide), reading the existing
  `routine_run_log` table — including rationale, command, outcome, PR url, reviewer verdict,
  deploy-verify result, and per-cycle token/cost.
- [ ] **RUNLOG-02**: The endpoint is documented in `/openapi.json` + `docs/api.md` (docs:sync clean).
- [ ] **RUNLOG-03**: A user can view per-session auto-dev activity as a timeline in the web UI
  (rationale → command → outcome → PR/verdict/deploy-verify), blue accent, no indigo.
- [ ] **RUNLOG-04**: A user can view a hub-wide orchestrator run feed across all their sessions.

### Shadow Dry-Run (SHADOW)
- [ ] **SHADOW-01**: With `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1`, `maybeAutospawnOffline` runs the full
  gate/allowlist/cap AND-chain and records the would-be spawn + macro prompt (a "would-have-spawned"
  record) WITHOUT calling `launchSessionForUser` or dispatching any prompt.
- [ ] **SHADOW-02**: A guard test asserts no spawn and no dispatch fires while shadow mode is active.
- [ ] **SHADOW-03**: Shadow records are surfaced through the same run-log API/UI so the owner sees
  exactly what arming would do against real due rows, with no spend.
- [ ] **SHADOW-04**: Shadow mode is OFF by default and a true no-op when off / allowlist empty.

### Metrics & Alerting (METRIC)
- [ ] **METRIC-01**: `hub/src/observability/metrics.ts` exposes orchestrator counters: cycles
  enqueued/drained/skipped, a skip-reason histogram (incl `no_session`/`offline`), and dispatch outcomes.
- [ ] **METRIC-02**: Daily accumulated token + cost are tracked against the 50M-token / dollar ceilings
  and exposed as metrics.
- [ ] **METRIC-03**: A stage-gated `notify.ts` fan-out fires when daily token or cost accumulation crosses
  a configurable % threshold of either cap (throttled, reusing existing notify plumbing).

### Hardening & Release (HARDEN)
- [ ] **HARDEN-01**: E2E coverage (extending `hub/test/e2e/`) proves the run-log API, the shadow no-op
  invariant, and the alert-threshold crossing against real Postgres.
- [ ] **HARDEN-02**: `docs/orchestrator-observability.md` documents the surface; CLAUDE.md env section
  updated with the new flag + thresholds.
- [ ] **HARDEN-03**: Version bumped (semver) across all sources in lockstep; shipped, deployed, and
  verified live (smoke the new route).

## Out of Scope (explicit — owner gates)
- Flipping `REMO_ORCHESTRATOR_AUTOSPAWN=1` or populating `orchestrator_autospawn_allowlist` — the arming
  decision itself (shadow mode is the deliberate substitute; it must never spawn or dispatch).
- Changing the 50M token cap, the dollar cost cap, or any cap *behavior* in `hub/src/dispatch/gates.ts`.
- Auto-merge / removing the no-auto-merge guard — untouched.
- Any destructive/altering migration — additive idempotent DDL only; no DROP/ALTER of existing columns.
- Redesigning how supervisor-invisible local builds become hub-visible — OBSRV only makes that gap visible
  via skip-reason metrics.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| RUNLOG-01 | Phase 1 — OBSRV-01-run-log-read-api | Pending |
| RUNLOG-02 | Phase 1 — OBSRV-01-run-log-read-api | Pending |
| RUNLOG-03 | Phase 2 — OBSRV-02-web-auto-dev-activity | Pending |
| RUNLOG-04 | Phase 2 — OBSRV-02-web-auto-dev-activity | Pending |
| SHADOW-01 | Phase 4 — OBSRV-04-autospawn-shadow-dry-run | Pending |
| SHADOW-02 | Phase 4 — OBSRV-04-autospawn-shadow-dry-run | Pending |
| SHADOW-03 | Phase 4 — OBSRV-04-autospawn-shadow-dry-run | Pending |
| SHADOW-04 | Phase 4 — OBSRV-04-autospawn-shadow-dry-run | Pending |
| METRIC-01 | Phase 3 — OBSRV-03-orchestrator-metrics | Pending |
| METRIC-02 | Phase 3 — OBSRV-03-orchestrator-metrics | Pending |
| METRIC-03 | Phase 5 — OBSRV-05-cap-approach-alerting | Pending |
| HARDEN-01 | Phase 6 — OBSRV-06-e2e-hardening-docs-release | Pending |
| HARDEN-02 | Phase 6 — OBSRV-06-e2e-hardening-docs-release | Pending |
| HARDEN-03 | Phase 6 — OBSRV-06-e2e-hardening-docs-release | Pending |

**Coverage:** 14/14 OBSRV requirements mapped, each to exactly one phase. No orphans, no duplicates.
