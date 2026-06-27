<!-- updated: 2026-06-27 -->
# Roadmap — Milestone OBSRV (Orchestrator Observability & Shadow Dry-Run)

> Read-only observability + safety-rehearsal layer for the auto-dev/autospawn path, built
> *before* the owner arms `REMO_ORCHESTRATOR_AUTOSPAWN=1`. **ZERO behavior change to the live
> dispatch path** — pure additive read/shadow work over seams OEE already proved. Phase
> dirs/labels are milestone-scoped (`OBSRV-NN-slug`). Prior-milestone roadmaps archived under
> `.planning/milestones/`.

## Hard invariants (encoded in every relevant phase's success criteria)

- ZERO behavior change to the live dispatch path (`hub/src/dispatch/`).
- Shadow mode NEVER calls `launchSessionForUser` and NEVER dispatches a prompt.
- Never flip `REMO_ORCHESTRATOR_AUTOSPAWN` / never populate `orchestrator_autospawn_allowlist`.
- Never change cap *behavior* in `hub/src/dispatch/gates.ts` (read counters only).
- Never touch the no-auto-merge guard.
- Additive idempotent DDL only (`hub/src/db/schema.sql` re-runs every boot); backfills → `hub/scripts/` one-shots. No DROP/ALTER of existing columns.

## Phases

- [ ] **Phase 1: Run-Log Read DAL + API** — read-only user-scoped paginated `GET /api/orchestrator/run-log` over `routine_run_log` + OpenAPI docs.
- [ ] **Phase 2: Web Auto-Dev Activity** — per-session timeline panel + hub-wide orchestrator run feed (blue accent, no indigo).
- [ ] **Phase 3: Orchestrator Metrics Counters** — orchestrator counters + skip-reason histogram + daily token/cost vs ceilings in `metrics.ts`.
- [ ] **Phase 4: Autospawn Shadow Dry-Run** — `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1` records would-be spawns with no spawn/dispatch; guard test.
- [ ] **Phase 5: Cap-Approach Alerting** — stage-gated throttled `notify.ts` fan-out at a configurable % of either cap.
- [ ] **Phase 6: E2E Hardening + Docs + Release** — real-Postgres e2e, docs, version bump, ship + smoke-verify live.

## Phase Details

### Phase 1: Run-Log Read DAL + API
**Goal**: A user can fetch their orchestrator run history through a read-only, user-scoped, paginated API over the existing `routine_run_log` table.
**Depends on**: Nothing (first phase; reads an existing table — no schema change required, additive read index only if needed).
**Requirements**: RUNLOG-01, RUNLOG-02
**Success Criteria** (what must be TRUE):
  1. `GET /api/orchestrator/run-log` returns the caller's own runs only, paginated, with `?session_id=` per-session filter and a hub-wide (no filter) mode.
  2. Each row exposes rationale, command, outcome, PR url, reviewer verdict, deploy-verify result, and per-cycle token/cost.
  3. The route is documented in `/openapi.json` + `docs/api.md` with `bun run docs:sync` clean (docs-drift CI green).
  4. No write path, no dispatch path, and `hub/src/dispatch/gates.ts` are touched; any DDL is additive idempotent only.
**Plans**: TBD

### Phase 2: Web Auto-Dev Activity
**Goal**: A user can see what the orchestrator did, per session and across all their sessions, in the web UI.
**Depends on**: Phase 1 (consumes `GET /api/orchestrator/run-log`).
**Requirements**: RUNLOG-03, RUNLOG-04
**Success Criteria** (what must be TRUE):
  1. A per-session "Auto-Dev Activity" panel renders a timeline: rationale → command → outcome → PR/verdict/deploy-verify.
  2. A hub-wide orchestrator run feed shows runs across all the user's sessions.
  3. Accent is blue, with no indigo (passes `web/test/no-indigo.test.ts`).
  4. The UI is read-only — no control that can trigger a spawn or dispatch.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Orchestrator Metrics Counters
**Goal**: The orchestrator's cycle activity and cap headroom are observable as metrics.
**Depends on**: Nothing (additive counters in `metrics.ts`; parallel with Phases 1/2/4).
**Requirements**: METRIC-01, METRIC-02
**Success Criteria** (what must be TRUE):
  1. `hub/src/observability/metrics.ts` exposes counters for cycles enqueued/drained/skipped and a skip-reason histogram including `no_session` and `offline`.
  2. Dispatch outcomes are counted as metrics.
  3. Daily accumulated token + cost are tracked against the 50M-token / dollar ceilings and exposed as metrics (read-only — cap behavior in `gates.ts` unchanged).
**Plans**: TBD

### Phase 4: Autospawn Shadow Dry-Run
**Goal**: The owner can see exactly what arming autospawn would do against real due rows, with zero spend and zero side effects.
**Depends on**: Phase 1 (shadow records surface through the same run-log API/UI per SHADOW-03).
**Requirements**: SHADOW-01, SHADOW-02, SHADOW-03, SHADOW-04
**Success Criteria** (what must be TRUE):
  1. With `REMO_ORCHESTRATOR_AUTOSPAWN_SHADOW=1`, `maybeAutospawnOffline` runs the full gate/allowlist/cap AND-chain and records a "would-have-spawned" record (spawn + macro prompt).
  2. A guard test asserts that while shadow mode is active, `launchSessionForUser` is never called and no prompt is dispatched.
  3. Shadow records appear in the same run-log API/UI as real runs, clearly flagged as shadow.
  4. Shadow mode is OFF by default and a true no-op when off or when the allowlist is empty; `REMO_ORCHESTRATOR_AUTOSPAWN` is never flipped and the allowlist is never populated.
**Plans**: TBD

### Phase 5: Cap-Approach Alerting
**Goal**: The owner is warned before the daily token or cost ceiling is reached.
**Depends on**: Phase 3 (reads the daily token/cost-vs-ceiling metrics).
**Requirements**: METRIC-03
**Success Criteria** (what must be TRUE):
  1. A stage-gated `notify.ts` fan-out fires when daily token OR cost accumulation crosses a configurable % threshold of either cap.
  2. The alert is throttled (no repeated spam within a window) and reuses existing notify plumbing.
  3. The threshold % is configurable via env/config and the alert is a true no-op below threshold.
  4. No cap *behavior* in `dispatch/gates.ts` changes — alerting is observe-only.
**Plans**: TBD

### Phase 6: E2E Hardening + Docs + Release
**Goal**: The whole observability + shadow surface is proven against real Postgres, documented, and shipped live.
**Depends on**: Phases 1–5.
**Requirements**: HARDEN-01, HARDEN-02, HARDEN-03
**Success Criteria** (what must be TRUE):
  1. E2E coverage extending `hub/test/e2e/` proves the run-log API, the shadow no-op invariant, and the alert-threshold crossing against real Postgres (Woodpecker qc gate green).
  2. `docs/orchestrator-observability.md` documents the surface and CLAUDE.md's env section lists the new flag(s) + thresholds.
  3. Version is bumped (semver) across all sources in lockstep; deployed; the new `GET /api/orchestrator/run-log` route is smoke-verified live at app.remo-code.com.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Run-Log Read DAL + API | 0/0 | Not started | - |
| 2. Web Auto-Dev Activity | 0/0 | Not started | - |
| 3. Orchestrator Metrics Counters | 0/0 | Not started | - |
| 4. Autospawn Shadow Dry-Run | 0/0 | Not started | - |
| 5. Cap-Approach Alerting | 0/0 | Not started | - |
| 6. E2E Hardening + Docs + Release | 0/0 | Not started | - |

## Dependency graph (parallelism)

```
Phase 1 ──┬─> Phase 2
          └─> Phase 4
Phase 3 ──────> Phase 5
All ──────────> Phase 6
```

Parallel-startable now: **Phase 1** and **Phase 3** (no deps). Phase 4 unblocks after 1; Phase 2 after 1; Phase 5 after 3; Phase 6 last.
