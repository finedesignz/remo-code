# CORCH-01 Research

Measured in this worktree before any code change (branch phase-corch-01-backlog-dispatcher, based on origin/main).

## Baselines

- N0 (typecheck): `cd hub && bun run typecheck 2>&1 | grep -c "error TS"` = **253** (pre-existing; CORCH adds zero in src/corch, test/corch, test/e2e/corch).
- `bun run check-baseline`: exit 0. `baseline: pass=3503 skip=291 fail=0 total=3794`, `actual: pass=3538 skip=291 fail=0 total=3829`, "OK - within tolerance".

## 1. PTYCAP-04 "2 open HIGH races" (STATE.md:8, :95)

Both races are FIXED on origin/main; the STATE.md text is stale.

- Race (a) orphan reopen: `hub/src/orchestrator/orphan-resume.ts:309` takes `pg_advisory_xact_lock(hashtext('orchestrator:' || userId))`; regression test `hub/test/orphan-resume-halt.test.ts`.
- Race (b) once-task re-arm: `hub/src/scheduler/senders/supervisor.ts:70`, `teab.ts:125`, `work.ts:84` gate on `ctx.onceClaimed === true`.
- Fix commit 0d13b21 merged in PR #506 (ab69c42); follow-up `/:id/launch` orchestrator guard in PR #509 (8d8b704).

Independence: CORCH-01 does not depend on either path. CORCH idempotency is its own DB structure: partial unique index `corch_runs(work_item_id) WHERE ended_at IS NULL`, partial unique index `corch_runs(project_id) WHERE ended_at IS NULL`, a per-user `pg_advisory_xact_lock(hashtext('corch:user:' || userId))` inside the claim transaction, and unique `(user_id, source, source_ref)` on work items. CORCH never touches orphan-resume, once-tasks or routine_queue. The ledger reservation it uses (`reserveInject` via `REAL_AUTOSPAWN.reserve`) is idempotent on `(counter_key, token)`. STATE.md is PTYCAP-owned and not edited here. No 7d ticket: the races are not real on main.

## 2. Launch sequencing

Mirrors `hub/src/heal/route.ts:356-404`: token `corch-run:<runId>` is constant across reserve and dispatch; reserve via `REAL_AUTOSPAWN.reserve` with `enforceRate: true`, actor `corch`; strict release on refusal / park-expire (LD-1, LD-10). `governedLaunch` is the only launch caller (LD-1: no `launchSessionForUser`, no `reserveInject(` token in `hub/src/corch/`).

## 3. Run-end and death signals

- Run end: `RunStore.onFinalize` (`dispatch/pipeline.ts:68`), driven by the next `assistant_message` on the session.
- Death: `ws/agent.ts:1409` supervisor socket close (`unregisterSupervisor`) and `ws/agent.ts:1226` inventory frames (`setSupervisorSessionInventory`).
- `pipeline.ts:576 releaseClosedRunByToken` disarms the finalize hook of a reclaimed run.

## 4. thresholdGate

No guard pins `thresholdGate` on machine gate lists; CORCH omits it (A6). The 8-gate CORCH list (LD-5) does not include it.

## 5. Shared autospawn daily launch cap

CORCH launches go through `governedLaunch` with `ledger.command = AUTOSPAWN_LAUNCH_COMMAND`, so they COUNT against the shared autospawn daily launch cap (`REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES`, default 20) together with orchestrator and heal launches (LD-1). Documented in docs/corch.md (Task 7).
