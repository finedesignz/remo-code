# Phase 04 — Plan Revision Notes (Round 1)

**Date:** 2026-05-25
**Trigger:** `PLAN-CHECK.md` PASS-WITH-REVISIONS (2 MAJOR + 7 MINOR)
**Author:** gsd-planner (revision mode)

Audit trail mapping every edit to the plan-check issue it resolves. No new plan files were created; every fix is folded into existing plans per the orchestrator brief.

---

## X1 — Slot release on supervisor crash/disconnect (MAJOR)

**File:** `04-PLAN-003-hub-concurrency-gate.md`

- Added **task T4** (`reapSupervisorSessions`) wired into the WS close/error handler in `hub/src/ws/supervisor-registry.ts`. Single UPDATE: `UPDATE session_runs SET ended_at=now(), close_reason='supervisor_disconnected' WHERE supervisor_id=$1 AND user_id=$2 AND ended_at IS NULL`. Broadcasts `supervisor_capacity_changed` and per-session `session_status: 'crashed'`. Idempotent.
- Added **task T5** — integration test `hub/test/supervisor-disconnect-reaper.test.ts`: spawn supervisor WS, reserve 2 slots, `ws.terminate()`, assert running=0 in DB and capacity-changed broadcast received. Matches the plan-check's explicit ask.
- Added `hub/test/supervisor-disconnect-reaper.test.ts` to `files_modified`.
- Added the deferred-row risk to the rollback note.

## X2 — `reserveSessionSlot` atomicity (MAJOR)

**File:** `04-PLAN-003-hub-concurrency-gate.md`

- **Rewrote T1** with the single-transaction contract: `BEGIN; SELECT … FROM supervisors WHERE id=$1 FOR UPDATE; SELECT COUNT(*) FROM session_runs WHERE supervisor_id=$1 AND ended_at IS NULL; if running>=cap rollback; INSERT INTO session_runs RETURNING id; COMMIT`. The signature now takes `sessionRun: { session_id, started_at?, source?, override_cap? }` and returns `session_run_id` on success.
- Effective cap derivation documented: `LEAST(COALESCE(override_cap ?? row.concurrency_override, concurrency_budget), concurrency_budget * 2)` — `budget × 2` is the hard server-side ceiling.
- **Rewrote T3 case (e)**: 50 concurrent reservations against `cap=5` MUST yield exactly 5 successes, 45 `at_capacity`, AND `SELECT COUNT(*) FROM session_runs WHERE ended_at IS NULL` MUST equal 5. Test must use a real `pg.Pool` so connections aren't serialized.
- Updated `must_haves` to assert atomicity.

## M1 — Plan 002 depends_on 001

**File:** `04-PLAN-002-schema-and-migration.md`

- `depends_on: []` → `depends_on: [04-PLAN-001-budget-reporting]`
- `wave: 1` → `wave: 2` (002 now strictly after 001 so they don't fight over `hub/src/ws/supervisor-protocol.ts` and `supervisor-registry.ts`).
- **Side effect:** every downstream plan's wave bumped by 1 in `PHASE-INDEX.md`. New wave structure: W1=001, W2=002+005+007, W3=003, W4=006+008+009, W5=004+010, W6=011.

## M2 — Per-child cgroup deferral noted in Plan 005

**File:** `04-PLAN-005-supervisor-dockerfile.md`

- Added to `risks:` (first bullet): *"Per-child cgroup hard limits (ARCH-REVIEW Risk #2) intentionally deferred — supervisor relies on hub-side concurrency gate (Plan 003) + hub-wide cost cap (Plan 009) only. Revisit if Plan 004 RSS measurement shows runaway children."*

## M3 — ARCHITECTURE-REVIEW §3 callout

**File:** `ARCHITECTURE-REVIEW.md` §3 "User override"

- Appended a blockquote `PLANNING DECISION (2026-05-25)` immediately after the original "never raises above computed budget" sentence: override ceiling is `budget × 2`, enforced as `cap = LEAST(COALESCE(override, budget), budget * 2)` in `reserveSessionSlot` (Plan 003 T1). Note that the orchestrator brief overrides this section's more conservative stance. Cross-refs PHASE-INDEX decision log.

## M4 — `cost_cap_warning` wired to UI

**File:** `04-PLAN-010-web-budget-ui.md`

- T1 hook return extended: `+ warningLevel: 'none' | '50' | '80'`, set on incoming `cost_cap_warning` WS events from Plan 009 T3, reset at UTC midnight.
- T4 (CostBudgetHud): added explicit subscribe-and-render — non-dismissable red banner above the supervisor card at `'80'`, amber toast at `'50'`. Banner persists until `warningLevel === 'none'`.
- T4 acceptance criterion now requires that injecting a `cost_cap_warning` in dev tools surfaces the banner/toast.

## M5 — Plan 008 step (c) made explicit

**File:** `04-PLAN-008-self-heal-routing.md`

- Rewrote T2 action with the explicit HTTP route signature (`POST /api/sessions/heal` body `{ repo_url, branch, prompt, model?, requester?, exclude_supervisor_ids? }` → `{ session_id, supervisor_id?, target_kind, url }` 202 / 503 / 400).
- Made step (c) explicit: *"the slot AND the `session_runs` row were already inserted atomically by `reserveSessionSlot` inside `pickSessionTarget` (Plan 003 T1, X2 fix). Use the returned `session_run_id` directly. No additional INSERT here — that would double-count."*
- Step (d) shows the explicit local-agent INSERT SQL with `source='self_heal'`, `supervisor_id=NULL`.

## M6 — Claude CLI version pinned

**Files:** `04-PLAN-005-supervisor-dockerfile.md`, `04-PLAN-006-coolify-deploy.md`

- Looked up actual current version: `npm view @anthropic-ai/claude-code version` → **`2.1.150`** (2026-05-25).
- Plan 005 T1: Dockerfile installs via `RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}` with `ARG CLAUDE_CLI_VERSION=2.1.150`.
- Plan 005 T4: CI workflow now uses `--build-arg CLAUDE_CLI_VERSION=2.1.150`.
- Plan 006 T2: new Versions doc section requires recording the same value (`2.1.150`) in `docs/coolify-supervisor.md` plus the bump procedure (lookup, update ARG, update doc, rebuild, redeploy).
- Doc-section count in Plan 006 T2 acceptance: 7 → 9.

## M7 — Non-github bare-clone path scheme documented

**Files:** `04-PLAN-006-coolify-deploy.md`, `04-PLAN-007-worktree-per-session.md`

- Plan 007 T1 path scheme spelled out:
  - github.com → `/workspace/.bare/github.com/<owner>/<repo>.git` (example: `/workspace/.bare/github.com/finedesignz/remo-code.git`)
  - other parseable URL hosts → `/workspace/.bare/<host>/<owner>/<repo>.git`
  - non-parseable URLs → `/workspace/.bare/_hash/<sha1(repoUrl)>.git` (opaque but stable)
  - local-path imports (`file://`, bare fs paths) → **OUT OF SCOPE for v1**; `createWorktree` rejects with `unsupported_repo_url`.
- Plan 006 T2: new Repo-storage doc section documents the same scheme for operators.

---

## Wave & dependency consistency re-check

`PHASE-INDEX.md` wave graph + per-row wave column rewritten to:

| Plan | Old wave | New wave |
|---|---|---|
| 001 | 1 | 1 |
| 002 | 1 | 2 |
| 003 | 2 | 3 |
| 005 | 2 | 2 |
| 007 | 2 | 2 |
| 006 | 3 | 4 |
| 008 | 3 | 4 |
| 009 | 3 | 4 |
| 004 | 4 | 5 |
| 010 | 4 | 5 |
| 011 | 4 | 6 |

No two same-wave plans share `files_modified` (re-verified).

## Override ceiling sweep

`grep -rni '≤ budget\|<= budget\|never raises above\|cannot exceed budget'` over `.planning/phases/04-coolify-dev-supervisor/`:

- Only matches: `ARCHITECTURE-REVIEW.md §3` original sentence (immediately followed by the M3 resolution callout) and `PLAN-CHECK.md` (immutable audit). No leftover anti-text in any plan file.

## Files changed

1. `04-PLAN-002-schema-and-migration.md` — wave + depends_on + `close_reason` column added to schema task
2. `04-PLAN-003-hub-concurrency-gate.md` — T1 rewrite, T3 case (e) rewrite, new T4 + T5, files_modified extended
3. `04-PLAN-005-supervisor-dockerfile.md` — CLI version pinned to `2.1.150`, cgroup-deferral risk added
4. `04-PLAN-006-coolify-deploy.md` — Versions + Repo-storage doc sections added
5. `04-PLAN-007-worktree-per-session.md` — explicit non-github path scheme + local-path rejection
6. `04-PLAN-008-self-heal-routing.md` — T2 action rewritten with explicit signature + SQL
7. `04-PLAN-010-web-budget-ui.md` — `warningLevel` in hook + banner/toast subscriber
8. `ARCHITECTURE-REVIEW.md` — §3 PLANNING DECISION callout
9. `PHASE-INDEX.md` — wave column + wave graph rewritten
10. `REVISION-NOTES.md` — this file (new)

## New task count

Plan 003 grew from 3 tasks (T1–T3) to **5 tasks** (T1–T5). All other plans retained their existing task count; their changes are within-task edits.

## Confirmation

- [x] X1 addressed (Plan 003 T4 + T5)
- [x] X2 addressed (Plan 003 T1 rewrite + T3 case (e) rewrite)
- [x] M1 addressed (Plan 002 depends_on + wave + downstream wave shift)
- [x] M2 addressed (Plan 005 risks)
- [x] M3 addressed (ARCH-REVIEW §3 callout)
- [x] M4 addressed (Plan 010 hook + banner)
- [x] M5 addressed (Plan 008 T2 explicit signature + SQL)
- [x] M6 addressed (Plan 005 + Plan 006 both pin `2.1.150`)
- [x] M7 addressed (Plan 007 path scheme + Plan 006 doc section)

## Remaining open question (not in plan-check)

- **`close_reason` column placement**: Plan 003 T4 needs a `close_reason TEXT` column on `session_runs`. Folded into Plan 002 T1 schema additions (`ALTER TABLE session_runs ADD COLUMN IF NOT EXISTS close_reason TEXT`). Plan 003 T4 also includes a fallback `ALTER` at boot in case Plan 002 ships without it. Acceptable redundancy; the executor for Plan 003 should confirm Plan 002 shipped the column and delete the fallback if so.
