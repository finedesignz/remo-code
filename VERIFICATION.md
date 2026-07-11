# VERIFICATION — PR #341 (`fix/sched-qc`)

**Verifier:** independent QC agent (did not write the code). Goal-backward, refute-by-default.
**Commit verified:** `37ff7e4` (`git diff origin/main...HEAD`)
**Date:** 2026-07-11

---

## Goal 1 — `log_check` uuid resolution + `skipped` finalize — **PASS (with 1 warning)**

| Claim | Status | Evidence (code, not PR text) |
|---|---|---|
| (a) resolve uuid from `coolify_app_repo` via session `repo_key` | ✅ PASS | `hub/src/scheduler/senders/coolify.ts:23-49` `resolveAppUuid()` → `getSession(sessionId,userId)` → `session.repo_key` → `getCoolifyAppByRepoKey(repoKey,userId)`. Both DAL fns exist (`hub/src/db/dal.ts:1855`, user-scoped). `sessions.repo_key` exists (`schema.sql:347`). Session id falls back to `target_id` when `target_kind==='session'`. Non-throwing (try/catch → null). |
| payload uuid still wins | ✅ PASS | `fromPayload` short-circuit before the lookup. Test asserts fetch URL uses payload uuid. |
| (b) unresolvable → `skipped` / `no_application_uuid` (not `failed`) | ✅ PASS | `coolify.ts:61`. `skipped` is a legal `scheduled_task_runs.status` (`schema.sql:417,922`). |
| `coolify_unconfigured` remains `failed` | ✅ PASS | `coolify.ts:56` untouched; test `missing COOLIFY_TOKEN is still a FAILURE` asserts it. |
| Nothing else depended on old `failed`/`no_application_uuid` | ✅ PASS | Repo-wide grep for `no_application_uuid`: only coolify.ts, the new test, and docs. No consumer keyed on the old status. |
| No `on:'failure'` post-run chain regression | ✅ PASS (no regression) — ⚠️ **but the code comment is wrong** | `hub/src/scheduler/post-run/dispatcher.ts:366-367`: `case 'failure': return status==='failed' \|\| status==='skipped' \|\| status==='cancelled'`. **`skipped` ALSO matches `on:'failure'`.** So flipping `failed→skipped` does NOT stop failure chains, contrary to the comments in `coolify.ts:58-59` and the test name (“no failure chains”). Behavior is unchanged vs. `failed` → no regression, but the stated benefit is not delivered. |

**Tests:** `hub/test/scheduler-log-check-uuid.test.ts` — **4 pass / 0 fail**. Assertions are substantive (checks the fetched Coolify URL contains the resolved uuid; checks status+error pairs), not tautologies.

---

## Goal 2 — stale `pending` run reaper — **PASS (with 1 warning)**

| Claim | Status | Evidence |
|---|---|---|
| Runs are actually inserted `pending` (reaper has real prey) | ✅ PASS | `dispatcher.ts:207,256,335` all `status:'pending'`. |
| Sweep finalizes `pending` > `REMO_RUN_MAX_MS` (default 6h) as `failed`/`run_timeout` | ✅ PASS | `hub/src/scheduler/run-reaper.ts` — `RUN_MAX_MS` default `21_600_000`, `reapStaleRuns()` → `finalizeRun(id,'failed','run_timeout',{only_if_pending:true})`. Loader selects `WHERE status='pending'`, age from `COALESCE(started_at, scheduled_for)`. Per-run try/catch; loader failure is fail-open. |
| Knobs `REMO_RUN_REAPER_INTERVAL_MS` / `REMO_RUN_REAPER_DISABLED` | ✅ PASS | `run-reaper.ts` — interval default 300_000 w/ positive-int parse; `envFlagOn(1\|true\|yes\|on)` disables (early return, no timer). Timer `unref()`ed; `startRunReaperSweep` idempotent. |
| Registered at boot **and** stopped on shutdown | ✅ PASS | `hub/src/index.ts:58` import; `:689` `startRunReaperSweep()` inside the post-migration `.then()`; `:708` `stopRunReaperSweep()` in `gracefulShutdown` (SIGTERM/SIGINT). |
| `only_if_pending` truly makes `finalizeRun` idempotent under race (SQL) | ✅ PASS | `scheduled-tasks-dal.ts:451-455`: `... WHERE id = ${runId} AND status = 'pending' RETURNING *`. Single conditional UPDATE = atomic claim; loser gets `rows[0] === undefined`. `dispatcher.ts:581-586`: on `only_if_pending && !updated` → delete in-flight ctx, **return before** `broadcastScheduledRun` and before `onRunFinalized` → no duplicate broadcast, no duplicate post-run fan-out. |
| Does not double-finalize a run TEAB owns | ⚠️ **PARTIAL** | The guard only protects the direction *reaper loses*. `senders/teab.ts:220` `finalizeTeabPoll` calls `finalizeRun(...)` **without** `only_if_pending`, so if the **reaper wins** the race the TEAB poller's later terminal write **overwrites** the reaped row and **re-fires the post-run chain** (double email/telegram/webhook). Narrow: `REMO_TEAB_MAX_RUN_MS` and `REMO_RUN_MAX_MS` both default 6h, so both fire in the same window; and an operator who raises `REMO_TEAB_MAX_RUN_MS` above `REMO_RUN_MAX_MS` gets **every long TEAB run killed at 6h by the reaper** and then clobbered back. This env coupling is not documented. |

**Tests:** `hub/test/scheduler-run-reaper.test.ts` — **5 pass / 0 fail**. Real assertions (arg-level: `('old','failed','run_timeout',{only_if_pending:true})`; fresh run untouched; one throwing run doesn't abort the pass; loader throw is fail-open).
**Coverage gap (minor):** no test exercises the dispatcher-side lost-claim path (`updated === null` → no broadcast / no post-run) or the guarded SQL itself — the reaper tests mock `finalizeRun`, so idempotency is asserted only at the call-site contract. The SQL + early-return are plainly correct on inspection, but the seam is untested.

---

## Regression / suite status

- `hub/test/scheduler.test.ts` + `hub/test/mount-order.test.ts`: **65 pass / 0 fail**.
- `bun run check-baseline`: `fail=16` (> `fail_max=0`). **Investigated — NOT caused by this PR:**
  - 11 × `term-relay-auth` failures = local env only (`JWT_SECRET must be at least 32 characters`; no `hub/.env` in this worktree). With `JWT_SECRET` set → **0 fail**.
  - 5 × `orchestrator-macro-cycle` 5s timeouts = **reproduced identically on a clean `origin/main` worktree** → pre-existing, unrelated.
  - ⚠️ Confirm Woodpecker `qc.yaml` is green before merge (it sets the env this local run lacked).
- Docs updated in-commit (`CLAUDE.md`, `docs/scheduled-tasks.md`) and match the code.

---

## Ship verdict — **SHIP (no blockers)**

Both goals are achieved in code, not just in prose. Two non-blocking follow-ups:

1. **(correctness of claim, not of behavior)** `on:'failure'` post-run actions fire on `skipped` too (`post-run/dispatcher.ts:366`). Either fix the comments in `coolify.ts`/the test name, or (if the intent was real) stop `no_application_uuid` from firing failure chains — the current change does not achieve that.
2. **(race hardening)** Pass `only_if_pending: true` from `finalizeTeabPoll` (`senders/teab.ts:220`) so a reaper-won race can't be clobbered + double-fan-out; and document that `REMO_TEAB_MAX_RUN_MS` must be ≤ `REMO_RUN_MAX_MS`.

_Verified: 2026-07-11 — independent QC agent_
