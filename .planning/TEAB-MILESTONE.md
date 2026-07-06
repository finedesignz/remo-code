# Milestone TEAB — TEAB-as-a-Scheduled-Task

> **Collision note:** This milestone runs CONCURRENTLY with milestone **OBSRV** (other session, PR #315).
> To avoid clobbering OBSRV's shared `.planning/` narrative, ALL TEAB planning lives in THIS self-contained
> file rather than overwriting `PROJECT.md` / `ROADMAP.md` / `STATE.md`. Phase dirs (if created) use the
> `TEAB-NN-slug` code prefix. At merge to `main`, do NOT clobber OBSRV's `PROJECT.md`/`ROADMAP.md`/`STATE.md`.

## Goal

Make **Titanium Edge AutoBuilder** (TEAB, repo `C:\Users\artic\GitHub\titanium-edge-autobuilder`) a
**first-class remo-code scheduled-task action** — scheduled and targeted exactly like existing tasks, but
whose executor is `teab run --repo <X>` on the supervisor host instead of a Claude prompt into a session.

## Why this shape

- TEAB is a standalone Node CLI (`teab run --repo <project>`) that itself spawns headless `claude`
  subagents to drive a `.planning/` roadmap to completion. It MUST run on the **supervisor host** (where
  the repos + `claude` + `teab` live); the hub is containerized and cannot see them.
- remo-code tasks today only inject a prompt into a session. The supervisor already exposes a generic,
  allowlisted `run_command` registry (`supervisor/src/commands/index.ts` → `getHandler`). A new `teab_run`
  handler slots in there with zero new RPC surface and no arbitrary-shell hole.
- Long roadmaps (hours) must survive the hub's idle-teardown → **background spawn + poll**, never a blocking
  foreground turn.

## Architecture (load-bearing seams)

- **Supervisor** (`supervisor/src/commands/`): new allowlisted `teab_run` handler. Background-spawns
  `teab run --repo <repo>` detached, returns immediately with a started ack; tracks the child + exposes a
  `teab_status` poll handler (running / exit code / last events tail). Advertised in
  `nativeSupervisorCommands()`. Honors TEAB prereqs (fail-closed with a clear error if `teab`/`claude` not
  on PATH, target repo missing `.planning/` or the D3 `irreversible-action-guard.mjs` hook). Workers run
  **without** `bypassPermissions` (the D3 hook is what enforces TEAB's Tier-1 contract). Env routed through
  the existing `env-sanitize.ts`. **New supervisor capability ⇒ a new signed MSI release is required**
  (release-gated — note it, do NOT auto-cut).
- **Hub** (`hub/src/scheduler/`, `hub/src/db/`): new `task_type: 'teab'` in
  `scheduled-tasks-dal.ts TaskType`; additive columns for the TEAB repo target + last poll status via a
  **one-shot `hub/scripts/` migration** (NEVER inline in `schema.sql` — it re-runs every boot). Route
  `task_type === 'teab'` in `dispatcher.ts` to a supervisor sender that issues `run_command teab_run` with
  the target repo, then **polls** `teab_status` until terminal, finalizes the `scheduled_task_runs` row, and
  fires the existing post-run action pipeline (email/telegram/webhook). Cron, fan-out, catchup, and the
  **non-bypassable cost/token cap gates stay unchanged**.
- **Web** (`web/src/`): task editor surfaces the new TEAB task type + a repo picker mirroring the existing
  repo→session Connect flow. Accent stays **blue** (CI-guarded).

## Cross-cutting invariants (do not violate)

- Cost cap non-bypassable (`dispatch/gates.ts`) — TEAB tasks still flow through the gate list.
- No provider API key on the human PTY path (unrelated; don't regress).
- `schema.sql` re-runs every boot — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- Webhook mount-order, Woodpecker-first CI, docs-drift CI (`bun run docs:sync` if routes change).
- Respect milestone OBSRV — do not touch its `.planning/` files, phase dirs, or orchestrator code.

## Requirements

- **TEAB-R1** — Supervisor `teab_run` handler background-spawns `teab run --repo <repo>` and returns a
  started ack without blocking; advertised in `nativeSupervisorCommands()`.
- **TEAB-R2** — Supervisor `teab_status` handler reports running / exited(+code) / recent events tail for a
  given run; preflight fails closed with a specific error when prereqs are missing.
- **TEAB-R3** — Hub `task_type: 'teab'` exists end-to-end (DAL type, validation, auto-name) with an additive
  one-shot migration for the repo-target + status columns.
- **TEAB-R4** — Dispatcher routes `'teab'` to a supervisor sender (background dispatch + poll-to-terminal),
  finalizes the run row, and fires post-run actions; cost/token cap gates unchanged.
- **TEAB-R5** — Web task editor can create/edit a TEAB task with a repo picker; renders status; accent=blue.
- **TEAB-R6** — Tests green (`bun run check-baseline`), docs synced (`docs:sync` if routes change), CLAUDE.md
  env/docs updated, and a release note that the supervisor MSI must be rebuilt (gated; not auto-cut).

## Roadmap (8 phases, fine granularity, TEAB-NN)

### Phase TEAB-01: Supervisor `teab_run` + `teab_status` handlers
**Goal:** A new allowlisted supervisor command background-spawns TEAB and a sibling reports its status.
**Depends on:** none.
**Requirements:** TEAB-R1, TEAB-R2
**Success Criteria:**
  1. `supervisor/src/commands/teab-run.ts` background-spawns `teab run --repo <repo>` detached, tracks the
     child PID + buffered events tail in an in-memory run registry, and returns a started result immediately.
  2. A `teab_status` handler returns `{ state: running|exited, exit_code?, events_tail }` for a run id.
  3. Preflight fails closed with a SPECIFIC error (`teab`/`claude` missing, no `.planning/`, no D3 hook).
  4. Both registered in `HANDLERS` + advertised in `nativeSupervisorCommands()`; spawn never sets
     `bypassPermissions` and routes env through `env-sanitize.ts`.
  5. Unit tests cover spawn-args construction, preflight failure modes, and status transitions.

### Phase TEAB-02: Supervisor run lifecycle + breadcrumb + canary test
**Goal:** TEAB runs are robust across supervisor restart and observable.
**Depends on:** TEAB-01.
**Requirements:** TEAB-R1, TEAB-R2
**Success Criteria:**
  1. The run registry survives concurrent runs (keyed by run id) and reaps finished children.
  2. A fail-open breadcrumb records each TEAB run start/stop (reuse the session-breadcrumb pattern).
  3. A canary test asserts the handler NEVER passes a forbidden token (`-p`/`--print`/API key) — TEAB owns
     its own claude spawns; the supervisor only launches the `teab` binary.
  4. `bun test` for the supervisor package green for the new files.

### Phase TEAB-03: Hub `task_type: 'teab'` + additive migration
**Goal:** The hub data model knows about TEAB tasks.
**Depends on:** none (parallel with TEAB-01).
**Requirements:** TEAB-R3
**Success Criteria:**
  1. `'teab'` added to `TaskType` in `scheduled-tasks-dal.ts`; Zod/validation + `auto-name.ts` label updated.
  2. One-shot `hub/scripts/migrate-*.ts` adds additive columns (`teab_repo_ident`, `teab_last_status`)
     — idempotent, NOT in `schema.sql`.
  3. `hub/test/` unit coverage for the new type + DAL round-trip; `migration-verify` stays green.

### Phase TEAB-04: Hub supervisor sender + dispatcher routing
**Goal:** A due TEAB task issues `run_command teab_run` to the target repo's supervisor.
**Depends on:** TEAB-03 (and TEAB-01 for the wire contract).
**Requirements:** TEAB-R4
**Success Criteria:**
  1. `dispatcher.ts` routes `task_type === 'teab'` to a new sender (`senders/teab.ts`) that resolves the
     target supervisor + repo and sends `run_command teab_run` with the repo param.
  2. The dispatch flows through the existing gate list (threshold → cost-cap) — cap behavior unchanged.
  3. Run row inserted as in-flight; unit tests cover routing + gate pass-through.

### Phase TEAB-05: Background poll-to-terminal + finalize + post-run actions
**Goal:** The hub tracks a long TEAB run to completion without a blocking turn and fires post-run actions.
**Depends on:** TEAB-04.
**Requirements:** TEAB-R4
**Success Criteria:**
  1. After dispatch, the hub polls `teab_status` on an interval until terminal (or a configurable max), then
     `finalizeRun(success, …)` runs and the post-run pipeline (email/telegram/webhook) fires.
  2. A long run survives idle-teardown (no subscriber dependency; poll is hub-driven).
  3. `teab_last_status` is updated on each poll; unit tests cover poll→finalize + timeout.

### Phase TEAB-06: Web — TEAB task type + repo picker
**Goal:** A user can create/edit/monitor a TEAB task from the task editor.
**Depends on:** TEAB-03 (type), TEAB-05 (status surface).
**Requirements:** TEAB-R5
**Success Criteria:**
  1. The task editor offers a "TEAB build" task type and a repo picker mirroring the Connect repo→session
     flow; saving persists `teab_repo_ident`.
  2. The task row/detail renders `teab_last_status`; accent stays blue (`no-indigo` test green).
  3. Web typecheck + relevant tests green.

### Phase TEAB-07: Tests + docs + CLAUDE.md
**Goal:** The feature is documented and the contract is captured.
**Depends on:** TEAB-01..06.
**Requirements:** TEAB-R6
**Success Criteria:**
  1. `bun run check-baseline` green; `bun run docs:sync` run if any route changed (docs-drift CI green).
  2. New `docs/teab-tasks.md` documents the task type, supervisor handler, prereqs, and the background+poll
     model; CLAUDE.md Docs map + env section updated.
  3. Canary/guard tests from TEAB-02 wired into the suite.

### Phase TEAB-08: E2E + release gating note
**Goal:** Prove the wire end-to-end and capture the release requirement.
**Depends on:** TEAB-01..07.
**Requirements:** TEAB-R6
**Success Criteria:**
  1. An integration test (mock supervisor socket) proves: due TEAB task → `run_command teab_run` sent →
     poll → finalize → post-run action — without a real `teab`/`claude`.
  2. PR body + `docs/teab-tasks.md` state clearly that a NEW signed supervisor MSI is REQUIRED for the
     `teab_run` capability to exist on installed hosts (release-gated — not auto-cut here).
  3. Final QC verifier PASS across all TEAB success criteria.

## Dependency graph

```
TEAB-01 ─> TEAB-02
TEAB-01 ─┐
TEAB-03 ─┴─> TEAB-04 ─> TEAB-05 ─┬─> TEAB-06
                                 └─> TEAB-07 ─> TEAB-08
```
Parallel-startable now: **TEAB-01** and **TEAB-03**.
