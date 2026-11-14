---
phase: CORCH-01-backlog-dispatcher-core
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/CORCH-01-backlog-dispatcher-core/CORCH-01-RESEARCH.md
  - hub/src/db/schema.sql
  - hub/src/corch/flag.ts
  - hub/src/corch/keys.ts
  - hub/src/corch/store.ts
  - hub/src/corch/gates.ts
  - hub/src/corch/quota-provider.ts
  - hub/src/corch/prompt.ts
  - hub/src/corch/dispatcher.ts
  - hub/src/corch/reconciler.ts
  - hub/src/corch/routes.ts
  - hub/src/index.ts
  - hub/src/auth/scopes.ts
  - hub/src/api/ext.ts
  - hub/src/api/_openapi.ts
  - hub/src/ws/agent.ts
  - hub/src/api/automation.ts
  - hub/test/corch-boot-assert.test.ts
  - hub/test/corch-flag-off.test.ts
  - hub/test/corch-gates.test.ts
  - hub/test/corch-prompt.test.ts
  - hub/test/corch-routes.test.ts
  - hub/test/corch-no-polling-guard.test.ts
  - hub/test/e2e/corch-dispatcher.e2e.test.ts
  - hub/test/counter-key-assignment-guard.test.ts
  - hub/test/token-cap-coverage.test.ts
  - hub/test/kill-switch-coverage.test.ts
  - hub/test/launch-callers-guard.test.ts
  - hub/test/launch-machine-guard.test.ts
  - hub/test/session-start-senders-guard.test.ts
  - hub/test/reserve-caller-guard.test.ts
  - hub/test/mount-order.test.ts
  - hub/test/api-keys-scopes.test.ts
  - tools/regression-baseline.json
  - docs/corch.md
  - docs/openapi.json
  - docs/api.md
  - CLAUDE.md
autonomous: true
requirements:
  - CORCH-R1.1
  - CORCH-R1.2
  - CORCH-R1.3
  - CORCH-R1.4
  - CORCH-R1.5
  - CORCH-R1.6
  - CORCH-R1.7
  - CORCH-R1.8
  - CORCH-R1.9
  - CORCH-R1.10
  - CORCH-R1.11
  - CORCH-R1.12
  - CORCH-R1.13
  - CORCH-R3.1
  - CORCH-R3.2
  - CORCH-R3.3
  - CORCH-R3.4
  - CORCH-R3.5
  - CORCH-R3.6
  - CORCH-R3.7

estimate:
  tokens: 420000
  raw_tokens: 420000
  tasks: 7
  confidence: low

must_haves:
  truths:
    - "With REMO_CORCH_ENABLED unset the CORCH routes only store and list rows; no dispatcher evaluation, no reconciler interval, no not_before timer, no launch, no send (CORCH-R1.2)"
    - "The hub refuses to boot when REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED are both truthy and boots in the other three combinations (CORCH-R1.3)"
    - "An enrolled github:// project plus a queued work item is claimed by exactly one evaluation under a concurrent race at cap 1, and never twice per item or per project (CORCH-R1.7, R3.1, R3.2)"
    - "With the CORCH-01 default QuotaProvider and Workspace, no item can ever launch: it stays queued with attempts unchanged and wait_reason quota_no_snapshot or workspace_unavailable (CORCH-R1.13, R1.11)"
    - "Every CORCH launch goes through governedLaunch HEAL policy and every CORCH prompt turn through dispatch() with the exact 8-gate list, kill switch first, lifetime counter last, counter key corch:<work_item_id> (CORCH-R1.9, R1.10, R1.11)"
    - "Death, launch failure or run end without a PR requeues with attempts+1 and backoff 60s*5^(attempts-1); the third failure blocks the item and notifies the owner exactly once; refusals never consume an attempt (CORCH-R3.4, R3.5)"
    - "A live run is reclaimed only on positive knowledge (supervisor socket close seen by this process, or fresh inventory lacking the session past REMO_CORCH_LEASE_MS); no fresh inventory marks it stalled once with one notification, and a hub restart never double-launches (CORCH-R3.3, R3.7)"
  artifacts:
    - path: hub/src/db/schema.sql
      provides: "corch_projects, corch_work_items, corch_runs, users.corch_max_concurrent_runs (additive DDL)"
    - path: hub/src/corch/dispatcher.ts
      provides: "createCorchDispatcher, buildCorchPipelineDeps (the single CORCH gates literal), buildCorchRequest (the single counterKey attach site), triggers"
    - path: hub/src/corch/reconciler.ts
      provides: "the only setInterval in hub/src/corch/, positive-knowledge reclaim, stalled-once"
    - path: hub/src/corch/routes.ts
      provides: "cookie /api/corch/projects + /api/corch/work-items, ext POST /api/ext/corch/work-items handler"
    - path: hub/test/e2e/corch-dispatcher.e2e.test.ts
      provides: "real-Postgres proof of criterion 5"
    - path: docs/corch.md
      provides: "subsystem doc"
  key_links:
    - from: hub/src/corch/dispatcher.ts
      to: hub/src/dispatch/governed-launch.ts
      via: "governedLaunch(args with preLaunch governor, {...REAL_AUTOSPAWN, isRepoAutospawnAllowed: CORCH enrollment})"
    - from: hub/src/corch/dispatcher.ts
      to: hub/src/dispatch/pipeline.ts
      via: "dispatch(buildCorchRequest(...), buildCorchPipelineDeps(...)) with replay/onParkExpire/onFinalize"
    - from: hub/src/ws/agent.ts
      to: hub/src/corch/dispatcher.ts
      via: "lazy-import hooks after registerSupervisor (:913) and unregisterSupervisor (:1409), only when corchEnabled()"
    - from: hub/src/api/automation.ts
      to: hub/src/corch/dispatcher.ts
      via: "resumeDeferredWork kill-switch release trigger (lazy import)"
    - from: hub/src/index.ts
      to: hub/src/corch/flag.ts
      via: "assertCorchConfig() directly after assertTokenCapConfig()"
---

<objective>
Build the CORCH backlog and dispatcher core in the remo-code hub: additive queue tables, cookie enrollment and
enqueue routes plus an explicit-scope external enqueue route, the 8-gate CORCH chain, a claim transaction with a
per-user advisory lock and partial unique indexes, launch only through `governedLaunch` (HEAL policy), the prompt
turn only through shared `dispatch()`, bounded requeue with backoff, positive-knowledge reclaim, one reconciler
interval plus one `not_before` timer, and boot mutual exclusion with the old orchestrator. The flag defaults OFF
and the CORCH-01 default QuotaProvider and Workspace both refuse, so this phase can never launch a session in prod.

Purpose: CORCH-02 (quota), CORCH-04 (gsd-console), CORCH-08 (AAF), CORCH-09 (supervisor worktrees + PR lookup) and
CORCH-11 (UI) all plug into these seams. Getting idempotency, gate order and fail-closed defaults right here is what
makes every later phase safe.

Output: `hub/src/corch/` (9 modules), schema DDL, 7 new test files, guard additions, `docs/corch.md`, CLAUDE.md env
entries, regenerated API docs, `CORCH-01-RESEARCH.md`.

Executor model: sonnet. Apply superskills:karpathy-guidelines throughout: smallest diff, no drive-by refactors, no
premature abstraction, every claim proven by a command below.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
Locked spec (read once, do not edit):
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\CORCH-ROADMAP.md section "### CORCH-01" (lines 48-185, incl. milestone invariants)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\CORCH-REQUIREMENTS.md (R1.1-R1.13, R3.1-R3.7, lines 45-105 and 166-195)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\phases\CORCH-00-research\PANEL-VERDICT.md (F1: new hub/src/corch/ queue, reuse primitives only; never extend runMacroCycle or routine_queue)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\phases\CORCH-00-research\RESEARCH-remo.md (code anchors)

Worktree: C:\Users\artic\GitHub\remo-code-phase-corch-01-backlog-dispatcher (branch phase-corch-01-backlog-dispatcher, based on origin/main).
Project rules: that worktree's CLAUDE.md (schema.sql re-runs every boot; idempotent additive DDL only; backfills only as hub/scripts one-shots).

Code anchors verified on origin/main by the planner (file:line):
- hub/src/dispatch/governed-launch.ts:96 governedLaunch; :40 PreLaunchGovernor {checkGates, reserve, release}; :49 GovernedLaunchArgs {userId, sessionId, repoIdent, tz, armed, preflight?, ledger {repoKey, command, rationale}, preLaunch?}; :70 GovernedLaunchDeps; result kinds launched / in_flight / refused / failed; refusal strings disabled, not_allowlisted, supervisor_offline, over_token_cap, launch_cap, ledger_unavailable, autospawn_launch_<reason>; failed string autospawn_launch_threw: <msg>
- hub/src/dispatch/pipeline.ts:36 DispatchRequest; :56 DispatchGate; :62 RunStore {open?, markSkipped, markDispatched?, onFinalize, markFailed, shouldFinalize?}; :84 DispatchOutcome; :92 PipelineDeps {gates, store, replay, isOnline, ensureOnline?, send, graceKey?, onParkExpire?, finalizeTimeoutMs?, hookMaxMs?}; :266 runGates; :279 dispatch; :576 releaseClosedRunByToken
- hub/src/heal/route.ts:17-18 imports REAL_AUTOSPAWN and AUTOSPAWN_LAUNCH_COMMAND (from ../db/orchestrator-rows-dal.ts); :138-150 buildPipelineDeps (actor HEAL_ACTOR, isOnline via deps.isChannelOnline, send via sink); :356-404 autospawn sequence (setOutcome starting, governedLaunch with ledger command :367, reserve with actor :378)
- hub/src/heal/autospawn-deps.ts:22 tzForUser; :33 REAL_AUTOSPAWN (GovernedLaunchDeps + tzForUser, checkGates, reserve, release, timers; launchSessionForUser via lazy import of ../telegram/launch.ts)
- hub/src/dispatch/automation-controls.ts:171 haltBeforeMachineSend; :181 automationKillSwitchGate; :328 automationLifetimeCounterGate; :365 ReserveArgs.actor optional; :376 reserveInject; schema.sql:1661 ledger actor TEXT NOT NULL DEFAULT '' (no CHECK, so actor 'corch' needs no allowlist)
- hub/src/dispatch/gates.ts:107 thresholdGate (NOT used); :122 dailyCostCapGate; :214 assertTokenCapConfig; :240 getTokenCapStatus; :267 dailyTokenCapGate; :325 sessionInjectRateGate
- hub/src/db/token-usage-dal.ts:230 getTodayTokenTotal (copy its tz-day boundary)
- hub/src/auth/scopes.ts:38 SCOPE_EXT_LAUNCH pattern; :57-67 ALL_SCOPES; :89 hasExplicitScope
- hub/src/index.ts:72 import assertTokenCapConfig; :238-240 /api/ext/* rate limit + extApiKeyMiddleware + app.route('/api/ext', ext); :297-313 /api/* auth catch-all (skips /api/ext/); :323 license gate; :340 csrfGuard
- hub/src/ws/agent.ts:913 registerSupervisor (hello); :1226 setSupervisorSessionInventory (inventory frame); :1409 unregisterSupervisor (socket close)
- hub/src/ws/supervisor-registry.ts:111/114 setUserInventory/getUserInventory; :282 isSupervisorOnline; :286 listOnlineSupervisorIdsForUser; :408 setSupervisorSessionInventory; :485 inventoried-supervisors accessor
- hub/src/api/automation.ts:53 resumeDeferredWork (called at :145 on release)
- hub/src/orchestrator/notify.ts:122 NotifyInput; :160 fanOutNotify
- package.json scripts: docs:sync, check-baseline (tools/check-baseline.ts), migration-verify, schema-lint, orchestrator:e2e (bun test hub/test/e2e/*.e2e.test.ts); hub/package.json typecheck = tsc --noEmit -p tsconfig.json
</context>

<definition_of_done>
Every command below must be run by the executor and its real output pasted into the SUMMARY. A skipped test is not a
pass. `<E2E_URL>` is a disposable Postgres matching the image `.woodpecker/qc.yaml` uses for its orchestrator e2e
service (read that file; start it locally with the same image tag). If no local Postgres can be started, that is a
BLOCKER for local proof: report it, never claim e2e green from a skipped run, and the qc.yaml e2e step on the PR
becomes the proof.

1. `bun run schema-lint` exits 0.
2. `bun run migration-verify` exits 0.
3. `REMO_E2E_DB_URL=<E2E_URL> bun test hub/test/e2e/schema-double-apply.e2e.test.ts` passes, 0 skipped.
4. No destructive DDL added: `git diff origin/main -- hub/src/db/schema.sql | grep "^+" | grep -ciE "\bdrop\b|\btruncate\b|alter column .* type"` prints 0 (do not write those words in new schema comments).
5. `bun test hub/test/corch-boot-assert.test.ts hub/test/corch-flag-off.test.ts hub/test/corch-gates.test.ts hub/test/corch-prompt.test.ts hub/test/corch-routes.test.ts hub/test/corch-no-polling-guard.test.ts` all pass.
6. Guards: `bun test hub/test/counter-key-assignment-guard.test.ts hub/test/token-cap-coverage.test.ts hub/test/kill-switch-coverage.test.ts hub/test/launch-callers-guard.test.ts hub/test/launch-machine-guard.test.ts hub/test/session-start-senders-guard.test.ts hub/test/reserve-caller-guard.test.ts hub/test/mount-order.test.ts hub/test/api-keys-scopes.test.ts hub/test/heal-single-seam.test.ts hub/test/pty-door-guard.test.ts hub/test/orchestrator-macro-path-guard.test.ts` all pass.
7. `REMO_E2E_DB_URL=<E2E_URL> bun test hub/test/e2e/corch-dispatcher.e2e.test.ts` passes, 0 skipped.
8. `REMO_E2E_DB_URL=<E2E_URL> bun run orchestrator:e2e` passes (no pre-existing e2e regressed).
9. `bun run check-baseline` exits 0 after the baseline re-measure in Task 7.
10. `bun run docs:sync` then `git diff --exit-code -- docs/openapi.json docs/api.md` exits 0 (regenerated docs are committed; a second sync produces no diff).
11. Typecheck delta: `cd hub && bun run typecheck 2>&1 | grep -c "error TS"` is less than or equal to the baseline N0 recorded in CORCH-01-RESEARCH.md before any change, AND `cd hub && bun run typecheck 2>&1 | grep -E "src/corch/|test/corch|test/e2e/corch" | grep -c "error TS"` prints 0.
12. Scope fence: `git diff --name-only origin/main...HEAD` lists only paths in this plan's files_modified; `git diff origin/main -- hub/src/orchestrator hub/src/heal hub/src/dispatch hub/src/sessions hub/src/telegram supervisor .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md | wc -l` prints 0; `git diff origin/main -- hub/src/api/automation.ts | grep -c "^-[^-]"` prints 0 (additions only).
</definition_of_done>

<ptycap_p4_race_check>
Question: the PTYCAP-04 ledger says "QC BLOCKED, 2 open HIGH races" (.planning/STATE.md:8 and :95). Are they real on origin/main, and does CORCH-01 depend on them?

Finding (verified in code by the planner): both races are FIXED on origin/main; the STATE.md text is stale.
- Race (a) orphan reopen: hub/src/orchestrator/orphan-resume.ts:309 takes `pg_advisory_xact_lock(hashtext('orchestrator:' || userId))`; regression test hub/test/orphan-resume-halt.test.ts.
- Race (b) once-task re-arm: hub/src/scheduler/senders/supervisor.ts:70, teab.ts:125 and work.ts:84 gate on `ctx.onceClaimed === true`.
- Fix commit 0d13b21 merged in PR #506 (ab69c42); the follow-up /:id/launch orchestrator guard fixed in PR #509 (8d8b704).

Independence: CORCH-01 does not depend on either path regardless. CORCH idempotency is enforced by its own DB
structure, not by the PTYCAP ledger: partial unique index `corch_runs(work_item_id) WHERE ended_at IS NULL` (one
live run per item), partial unique index `corch_runs(project_id) WHERE ended_at IS NULL` (one live run per project),
a per-user `pg_advisory_xact_lock(hashtext('corch:user:' || userId))` inside the claim transaction (cap check is
atomic), and the unique `(user_id, source, source_ref)` on work items (idempotent enqueue). CORCH never touches
orphan-resume, once-tasks, or routine_queue. The ledger reservation it does use (`reserveInject` via
REAL_AUTOSPAWN.reserve) is idempotent on `(counter_key, token)` under its own advisory lock.

Actions: record this in CORCH-01-RESEARCH.md only. Do NOT edit .planning/STATE.md (PTYCAP owns it). No 7d ticket:
the races are not real on main.
</ptycap_p4_race_check>

<do_not_touch>
The executor must not modify any of these. A needed change here is a BLOCKER to report, not a judgment call.
- hub/src/orchestrator/** (macro path: runMacroCycle, controller, inject.ts, queue.ts, routine_queue, orchestrator_rows, merge-command, wave-runner, notify.ts, orphan-resume.ts). Importing `fanOutNotify` from notify.ts is allowed; editing is not.
- thresholdGate and hub/src/usage/threshold.ts; CORCH does not use thresholdGate (A6).
- Bodies of hub/src/dispatch/{governed-launch,governed-pty,automation-controls,gates,pty-preflight,pipeline,untrusted}.ts.
- hub/src/heal/** (import REAL_AUTOSPAWN only), hub/src/sessions/**, hub/src/telegram/**, supervisor/**.
- PTYCAP tables and their DDL (automation_inject_ledger, kill-switch tables, heal_events, token_cap_alarms); orchestrator_autospawn_allowlist (CORCH never reads or writes it).
- .planning/ROADMAP.md, .planning/STATE.md, .planning/REQUIREMENTS.md (PTYCAP-owned).
- Guard tests: only allowlist entries and new `describe` blocks for corch; never loosen or delete an existing assertion.
- Prod: no Coolify env change, no flag flip; REMO_CORCH_ENABLED stays unset/OFF everywhere; no deploy.
- Sanctioned exceptions (the locked spec requires them; additive only): hub/src/api/automation.ts gets ONE added try-block inside resumeDeferredWork (Task 5); hub/src/ws/agent.ts gets TWO added hook lines (Task 5); hub/src/api/ext.ts gets ONE route registration (Task 2); hub/src/index.ts gets the assert call, one route mount and one boot start call.
</do_not_touch>

<locked_design>
Decisions the executor applies verbatim (the planner resolved every open fork; cite these IDs in commits):

- LD-1 Launch deps: CORCH reuses `REAL_AUTOSPAWN` from hub/src/heal/autospawn-deps.ts, spread with ONE override: `isRepoAutospawnAllowed` = CORCH enrollment check (`corch_projects` row for user + repo_ident with enabled = true). Consequence: no file under hub/src/corch/ ever contains the token `launchSessionForUser`, the call `reserveInject(`, or a `session.start` literal. Reserve/release/checkGates/tzForUser come from REAL_AUTOSPAWN exactly as heal/route.ts uses them. CORCH launches count against the shared autospawn daily launch cap (AUTOSPAWN_LAUNCH_COMMAND rows); document it.
- LD-2 Import discipline: hub/src/corch/dispatcher.ts, gates.ts, quota-provider.ts, prompt.ts, keys.ts and flag.ts have NO top-level value import of the DB client, store.ts, heal/*, ws/*, telegram/* or orchestrator/*. Real deps are assembled in an async `realCorchDeps()` using dynamic `await import(...)`, so unit tests import these modules with zero DB. store.ts, reconciler-real wiring and routes.ts may import the DB client.
- LD-3 Identity strings: counter key `corch:<work_item_id>` from `buildCorchKey(workItemId)` (keys.ts, the only builder); dispatch token `corch-run:<corch_runs.id>` from `buildCorchRunToken(runId)` with inverse `runIdFromToken(token)` returning null for any other shape; actor `CORCH_ACTOR = 'corch'`; branch `corch/<work_item_id>`; claim lock key string `corch:user:<userId>`.
- LD-4 Counter-key guard safety: the ONLY place a property named `counterKey` is written under hub/src/corch/ is `buildCorchRequest` in dispatcher.ts, and its value is a `buildCorchKey(` call. store.ts passes the key as a positional SQL parameter named `runKey` into column `counter_key`; never an object property named `counterKey`.
- LD-5 Gate list literal (exactly one `gates: [` in hub/src/corch/, in `buildCorchPipelineDeps` in dispatcher.ts), order binding: `automationKillSwitchGate, dailyCostCapGate, dailyTokenCapGate, corchProjectBudgetGate(deps.store), corchConcurrencyGate(deps.store), corchQuotaGate(deps.quota, deps.store), sessionInjectRateGate, automationLifetimeCounterGate`. Gate names: `corch_project_budget`, `corch_concurrency`, `corch_quota`. governedLaunch `preLaunch.checkGates` = `() => deps.launch.checkGates(req, pdeps.gates)` (same list object, heal pattern).
- LD-6 Order of one evaluation: flag check, claim txn, Workspace.resolve, attach session to run, build request + prompt, governedLaunch (HEAL), then on `launched` dispatch(). Workspace runs before governedLaunch because the gate list and launch need a sessionId.
- LD-7 Refusal map (no attempt consumed; run ended with end_reason; item back to `queued`): `wait_reason` = full refusal string; `end_reason` = the refusal string except any `automation_halted:<scope>` normalizes to `automation_halted` (R3.5). `not_before`: next local midnight in the user tz for `project_budget`, the cost-cap reason, the token-cap reason, `over_token_cap`, `launch_cap`; `now() + 60 minutes` for the inject-rate reason; `now() + corchLeaseMs()` for any `autospawn_launch_` prefix; NULL (event-driven) for everything else (`automation_halted*`, `corch_concurrency`, `quota_*`, `lifetime_inject_exhausted*`, `workspace_unavailable`, `supervisor_offline`, `disabled`, `not_allowlisted`, `in_flight`, `ledger_unavailable`, unknown). The exact cost-cap, token-cap and inject-rate strings are the literals returned by dailyCostCapGate (gates.ts:122), dailyTokenCapGate (:267) and sessionInjectRateGate (:325); read them once, match by prefix, pin them in corch-gates.test.ts.
- LD-8 Failure map (attempt consumed, R3.4): governedLaunch `failed`, dispatch outcome `failed` or RunStore.markFailed (end_reason `dispatch_failed`), `dropped_busy`, onParkExpire (end_reason `spawn_timeout`), reclaim (`supervisor_closed` or `session_absent`), run end with PrLookup `none` (`no_pr`) or `unavailable` (`pr_lookup_unavailable`). New attempts = attempts + 1; if new attempts >= max_attempts then status `blocked`, wait_reason = end_reason, one notification; else status `queued`, `not_before = now() + 60s * 5^(newAttempts - 1)` (1 => 60s, 2 => 300s).
- LD-9 Idempotent transitions: every end-of-run transition is `store.endRunAndRequeue(runId, {endReason, consumeAttempt, waitReason, notBefore})` or `store.endRunMarkPrOpen(runId, prUrl)`, each one transaction whose first statement is `UPDATE corch_runs ... WHERE id = $runId AND ended_at IS NULL RETURNING work_item_id`; zero rows => return `{changed: false}` and touch nothing. Side effects (reservation release, notification, triggers) run only when `changed` is true. Both RunStore callbacks AND the returned DispatchOutcome call these, so double delivery is harmless.
- LD-10 Reservation release: only on a no-attempt refusal that happens AFTER governedLaunch returned `launched` (dispatch-time skip) and on onParkExpire and dropped_busy, and only when the transition `changed`. governedLaunch already releases its own refusals/failures. Release = `deps.launch.release(...)` with the same arguments heal/route.ts passes; a throw is logged with the run id and left (no retry, no fallback).
- LD-11 Defaults (fail closed): `DEFAULT_QUOTA_PROVIDER.snapshotFor()` returns `{ok:false, reason:'quota_no_snapshot'}`; `DEFAULT_WORKSPACE.resolve()` returns `{ok:false, reason:'workspace_unavailable'}`; `DEFAULT_PR_LOOKUP.lookup()` returns `{kind:'unavailable'}`. QuotaProvider lives in quota-provider.ts; Workspace and PrLookup interfaces and defaults live in dispatcher.ts. No account selection: the quota gate ignores account_slot/supervisor_id on success in this phase.
- LD-12 Triggers: enqueue (both routes), PATCH project enabled false->true, run end, kill-switch release, supervisor hello, supervisor close, and one `setTimeout` re-armed to the earliest future `not_before` of queued items. The reconciler pass does NOT call evaluate except after it reclaims a run (that is a run end). Each trigger is a no-op when `corchEnabled()` is false, checked before any DB access.
- LD-13 Positive knowledge (R3.3): per live run, supervisor known = `run.supervisor_id`, else the union of the user's fresh inventories. Fresh = the same freshness predicate hub/src/ws/dead-session-reaper.ts uses (import its helper if exported, else apply its default max age of 60000 ms to the registry's per-supervisor inventory timestamp). Listed => heartbeat (and `stalled` back to `running`). Fresh and not listed and `now - heartbeat_at > corchLeaseMs()` => reclaim `session_absent`. Not fresh and `now - heartbeat_at > corchLeaseMs()` => transition to `stalled` (UPDATE ... WHERE status <> 'stalled' RETURNING) and notify only if a row changed. Socket close observed by this process (ws/agent.ts:1409 hook) => reclaim `supervisor_closed` for live runs with that supervisor_id. Runs with `session_id IS NULL`, not in this process's in-flight set and started more than corchLeaseMs() ago => `claim_orphaned`, no attempt (launch requires a session id, so none happened).
- LD-14 Notifications carry no untrusted text: ids, repo_ident, attempts, end_reason only. Real impl wraps `fanOutNotify` (orchestrator/notify.ts:160) mirroring the revanote stall-alert call site (find it with `grep -rn "fanOutNotify(" hub/src/revanote`).
- LD-15 Routes: cookie routes mount with `app.route('/api/corch', corchRoutes)` placed after the csrfGuard line (index.ts:340) alongside the other authed routers; API-key rejection comes from the existing authMiddleware (an api key on a non-settings /api/* path gets 403), no corch-local auth code. The ext route registers inside the existing ext router in hub/src/api/ext.ts (one `ext.route('/corch', extCorchRoutes)` line) so it inherits the /api/ext/* rate limit and extApiKeyMiddleware unchanged.
</locked_design>

<tasks>

<task type="tracer">
  <name>Task 1 (Wave A, tracer): schema -> store -> dispatcher -> governed refusal, end to end on real Postgres, flag + boot assert</name>
  <read_first>
    hub/src/heal/route.ts lines 118-160 and 340-447 (sequence to mirror); hub/src/heal/autospawn-deps.ts (whole, 80 lines);
    hub/src/db/schema.sql: the heal_events CREATE TABLE (id default + user_id FK style) and the token_usage table near :1384 (session_id type);
    sessions table DDL (id type); hub/test/e2e/orchestrator-tokencap.e2e.test.ts (DB bootstrap pattern for e2e);
    hub/src/index.ts lines 60-80 and the assertTokenCapConfig() call site; tools/schema-sql-lint.ts header (rules).
  </read_first>
  <files>
    .planning/phases/CORCH-01-backlog-dispatcher-core/CORCH-01-RESEARCH.md, hub/src/db/schema.sql, hub/src/corch/flag.ts,
    hub/src/corch/keys.ts, hub/src/corch/store.ts, hub/src/corch/dispatcher.ts, hub/src/index.ts,
    hub/test/corch-boot-assert.test.ts, hub/test/e2e/corch-dispatcher.e2e.test.ts
  </files>
  <behavior>
    Write these tests FIRST and watch them fail:
    - corch-boot-assert.test.ts: corchEnabled() is true only for trimmed case-insensitive 1|true|yes|on and is read at call time (set env, call, change env, call again); corchLeaseMs() and corchReconcileIntervalMs() return 120000 / 60000 for unset, 0, negative, NaN and garbage; assertCorchConfig() throws (message names both REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED) only when both are truthy and returns for the other three combinations (4 cases, CORCH-R1.3); a source pin reads hub/src/index.ts and asserts an `assertCorchConfig()` call appears within 5 lines after the `assertTokenCapConfig()` call.
    - corch-dispatcher.e2e.test.ts (real Postgres, skip only when REMO_E2E_DB_URL is unset, using the orchestrator-tokencap e2e bootstrap): case "tracer: default workspace refuses": insert a user, a corch_projects row (github://acme/app, enabled), enqueue one item via store.enqueueWorkItem; a second enqueue with the same (source, source_ref) returns created=false and the same id (CORCH-R1.5); with REMO_CORCH_ENABLED=1, createCorchDispatcher({store: real, workspace: DEFAULT_WORKSPACE, launch: spy object whose every function records and throws}) then evaluateUser(userId): item status queued, attempts 0, wait_reason workspace_unavailable, exactly one corch_runs row with ended_at set and end_reason workspace_unavailable, no live run, zero launch-spy calls. Case "flag off": with the env unset evaluateUser returns {kind:'disabled'} and the corch_runs count is unchanged.
  </behavior>
  <action>
    A. Before touching code, measure baselines in the worktree and write CORCH-01-RESEARCH.md: run `cd hub && bun run typecheck 2>&1 | grep -c "error TS"` (record as N0) and `bun run check-baseline` (record exit code and summary line). The research file answers the five roadmap research items with these findings: (1) PTYCAP-04 races are fixed, copy the ptycap_p4_race_check section of this plan; (2) launch sequencing mirrors heal/route.ts:356-404 with token corch-run:<runId> constant across reserve and dispatch, reserve with enforceRate true via REAL_AUTOSPAWN.reserve, strict release on refusal/park-expire (LD-1, LD-10); (3) run-end signal is RunStore.onFinalize (pipeline.ts:68, driven by the next assistant_message), death signals are ws/agent.ts:1409 socket close and :1226 inventory frames, pipeline.ts:576 releaseClosedRunByToken disarms a reclaimed run's hook; (4) no guard pins thresholdGate on machine lists, it is omitted per A6; (5) the measured N0 and check-baseline result, plus the shared autospawn daily-launch-cap note from LD-1.
    B. Append to hub/src/db/schema.sql under a header comment "CORCH-01 central orchestrator queue (additive; re-runs every boot)": CREATE TABLE IF NOT EXISTS corch_projects (id UUID PK default as heal_events uses, user_id with the same type and FK style as heal_events.user_id, repo_ident TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, daily_token_budget BIGINT NOT NULL DEFAULT 2000000 CHECK (daily_token_budget > 0), enabled BOOLEAN NOT NULL DEFAULT true, accept_external BOOLEAN NOT NULL DEFAULT false, created_at and updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (user_id, repo_ident)); CREATE TABLE IF NOT EXISTS corch_work_items (id UUID PK, user_id FK, project_id UUID NOT NULL REFERENCES corch_projects(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK in ('manual','gsd_console','aaf','memlog'), source_ref TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued' CHECK in ('queued','running','pr_open','done','blocked','cancelled'), wait_reason TEXT NULL, not_before TIMESTAMPTZ NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0), branch TEXT NOT NULL, pr_url TEXT NULL, created_at, updated_at, UNIQUE (user_id, source, source_ref)); CREATE INDEX IF NOT EXISTS idx_corch_work_items_status_not_before ON corch_work_items(status, not_before); CREATE TABLE IF NOT EXISTS corch_runs (id UUID PK, work_item_id UUID NOT NULL REFERENCES corch_work_items(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES corch_projects(id) ON DELETE CASCADE, user_id FK, account_slot TEXT NULL, supervisor_id TEXT NULL, session_id with the sessions.id type NULL and no FK, worktree_path TEXT NULL, counter_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'launching' CHECK in ('launching','running','stalled','ended'), end_reason TEXT NULL, heartbeat_at, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ NULL); CREATE UNIQUE INDEX IF NOT EXISTS idx_corch_runs_live_item ON corch_runs(work_item_id) WHERE ended_at IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS idx_corch_runs_live_project ON corch_runs(project_id) WHERE ended_at IS NULL; ALTER TABLE users ADD COLUMN IF NOT EXISTS corch_max_concurrent_runs INTEGER NOT NULL DEFAULT 1; then a DO block adding CONSTRAINT users_corch_max_concurrent_runs_positive CHECK (corch_max_concurrent_runs > 0) with EXCEPTION WHEN duplicate_object THEN NULL (per CORCH-R1.1). No backfill. Run schema-lint and migration-verify now.
    C. hub/src/corch/flag.ts: `corchEnabled()`, `corchLeaseMs()`, `corchReconcileIntervalMs()` per the tests, a private truthy parser, and `assertCorchConfig()` reading REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED through that same parser (do not import orchestrator code). In hub/src/index.ts import it and call `assertCorchConfig()` on the line directly after the existing `assertTokenCapConfig()` call (CORCH-R1.3).
    D. hub/src/corch/keys.ts: buildCorchKey, buildCorchRunToken, runIdFromToken, CORCH_ACTOR, corchBranch (LD-3). Pure, no imports.
    E. hub/src/corch/store.ts (imports the DB client the same way heal does): `enqueueWorkItem({userId, projectId, source, sourceRef, title, body, priority})` generating id with crypto.randomUUID() and branch corch/<id>, INSERT ... ON CONFLICT (user_id, source, source_ref) DO NOTHING RETURNING, else SELECT the existing row, returning `{item, created}`; `claimNext(userId, excludeIds)` as one `sql.begin` transaction: `SELECT pg_advisory_xact_lock(hashtext($key))` with key corch:user:<userId>, count live runs (ended_at IS NULL) for the user, read users.corch_max_concurrent_runs, return null at or over cap; select ONE candidate per CORCH-R1.6 (status queued, not_before NULL or <= now(), project enabled and same user, NOT EXISTS live run on the project, NOT EXISTS pr_open item on the project, id not in excludeIds, ORDER BY project.priority DESC, item.priority DESC, item.created_at ASC, item.id ASC, LIMIT 1); insert the corch_runs row (status launching, counter_key from the runKey parameter = buildCorchKey(item.id), per LD-4); update the item to status running, wait_reason NULL, updated_at now(); return {run, item, project}; a unique violation (code 23505) returns null (lost race); `attachSession(runId, sessionId, worktreePath)`; `endRunAndRequeue` and `endRunMarkPrOpen` per LD-8/LD-9 (backoff computed in SQL as now() + make_interval(secs => 60 * power(5, newAttempts - 1)) and next local midnight as (date_trunc('day', now() AT TIME ZONE tz) + interval '1 day') AT TIME ZONE tz); `isEnrolledEnabled(userId, repoIdent)`. Export a `CorchStore` interface type listing every method so fakes can implement it.
    F. hub/src/corch/dispatcher.ts minimal slice: export types Workspace, PrLookup, CorchDeps, DEFAULT_WORKSPACE, DEFAULT_PR_LOOKUP (LD-11), and `createCorchDispatcher(deps)` returning `evaluateUser(userId)`: if !corchEnabled() return {kind:'disabled'} before any deps call; loop at most 10 times: claimNext(userId, excluded) (stop on null), add the item id to excluded and to an in-process in-flight set, call deps.workspace.resolve({userId, item, project, runId}), on refusal apply LD-7 via endRunAndRequeue (consumeAttempt false), remove from in-flight and continue. Leave the launched branch as the Task 4 expansion point, but it must already compile: on workspace success in this task, end the run with end_reason `launch_not_wired` and consumeAttempt false (Task 4 replaces this line; it is never reachable in prod because DEFAULT_WORKSPACE refuses). Obey LD-2 imports.
    Commit: `feat(corch-01): tracer - corch schema, store claim txn, fail-closed dispatcher, boot mutual exclusion`.
  </action>
  <verify>
    <automated>bun run schema-lint && bun run migration-verify && bun test hub/test/corch-boot-assert.test.ts && REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test hub/test/e2e/corch-dispatcher.e2e.test.ts hub/test/e2e/schema-double-apply.e2e.test.ts</automated>
  </verify>
  <done>Both tracer e2e cases pass on real Postgres (0 skipped), the boot-assert test passes for all 4 combinations, schema-lint and migration-verify exit 0, RESEARCH.md holds N0 and the five answers.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2 (Wave B): enrollment + enqueue routes, ext:corch explicit scope, mount-order and api-keys-scopes pins</name>
  <read_first>
    hub/src/auth/scopes.ts lines 1-95; hub/src/api/ext.ts (router construction and how existing handlers read the caller's api key and user);
    the ext:work scope gate (find it with `grep -rn "SCOPE_EXT_WORK" hub/src`) to copy its exact scope-read;
    hub/test/mount-order.test.ts lines 100-200; hub/test/api-keys-scopes.test.ts (app-request pattern);
    the nearest existing Hono route unit test that stubs the DB (find with `grep -rln "mock.module(" hub/test | head`), to copy its mocking style;
    the canonical repo_ident helper used by heal keys (`grep -rn "canonical" hub/src/heal/*.ts | head`).
  </read_first>
  <files>hub/src/corch/routes.ts, hub/src/index.ts, hub/src/auth/scopes.ts, hub/src/api/ext.ts, hub/src/api/_openapi.ts, hub/test/corch-routes.test.ts, hub/test/mount-order.test.ts, hub/test/api-keys-scopes.test.ts</files>
  <behavior>
    Tests first (corch-routes.test.ts with the store module stubbed; dispatcher trigger stubbed and counted):
    - POST /api/corch/projects with repo_ident `GitHub://Acme/App` stores `github://acme/app` (lowercased canonical), defaults priority 0, daily_token_budget 2000000, enabled true, accept_external false, returns 201 {project, created:true}; repeat returns 200 {created:false}; `path://C:/x` => 400 `path_ident_not_supported`; any other shape => 400; daily_token_budget 0 => 400 (CORCH-R1.4).
    - GET /api/corch/projects lists only the caller's rows ordered priority DESC, created_at ASC.
    - PATCH /api/corch/projects/:id updates only priority, daily_token_budget (>0), enabled, accept_external; another user's id => 404; enabled false->true calls the evaluate trigger once when the flag is ON and zero times when OFF.
    - POST /api/corch/work-items (cookie) with {project_id, title, body?, priority?, source_ref?} creates source `manual` (source_ref defaults to `manual:<uuid>`), returns 201/200 with created flag, ignores a body `counter_key`, `status`, `branch`, `attempts` (stored row has server values), another user's project => 404; trigger called once when flag ON, zero when OFF.
    - GET /api/corch/work-items?status=queued lists the caller's items (limit 200, created_at DESC).
    - POST /api/ext/corch/work-items: key without explicit `ext:corch` (NULL scopes, `ext:read`, `ext:work`) => 403 and the store write spy is never called; with `ext:corch` and source in aaf|memlog|manual, source_ref required (1-200 chars): project not enrolled, disabled, or accept_external false => 403 `project_not_accepting` with zero writes; accepted => enqueue with the key's user (CORCH-R1.5).
    - Title 1-500 chars, body up to 20000 chars, else 400.
    - mount-order.test.ts additions: unauth GET /api/corch/projects => 401 (authMiddleware ran); unauth POST /api/ext/corch/work-items => 401 (api-key middleware ran, not 404, not a CSRF rejection).
    - api-keys-scopes.test.ts additions: `ext:corch` is in ALL_SCOPES and accepted by normalizeScopes; hasExplicitScope(null, 'ext:corch') is false; an api key Bearer on GET /api/corch/projects gets 403.
  </behavior>
  <action>
    Add `SCOPE_EXT_CORCH = 'ext:corch'` to hub/src/auth/scopes.ts with a doc comment "EXPLICIT-only: enqueue CORCH work items via POST /api/ext/corch/work-items" and append it to ALL_SCOPES (nothing else in that file changes). Create hub/src/corch/routes.ts exporting `corchRoutes` (cookie router: the four handlers above, zod-validated with unknown keys stripped, every query scoped by the authenticated user id read the same way neighbouring routers read it) and `extCorchRoutes` (one POST /work-items handler using the exact ext:work scope-read pattern but with SCOPE_EXT_CORCH and hasExplicitScope). Enrollment validation: canonicalize with the heal canonicalizer if one exists, else lowercase + trim; then require the regex `^github://[a-z0-9._-]+/[a-z0-9._-]+$`. Triggers: after a successful create (or enabled false->true) call `if (corchEnabled()) void triggerEvaluate(userId)` where triggerEvaluate lazily imports the dispatcher singleton (getCorch) and logs any error with the user id; never await it in the response path (per LD-12, CORCH-R1.2). Mount per LD-15: in hub/src/index.ts add `app.route('/api/corch', corchRoutes)` after the csrfGuard line with the other authed routers; in hub/src/api/ext.ts add one `ext.route('/corch', extCorchRoutes)` registration. Register the six operations in hub/src/api/_openapi.ts following the shape of the existing /api/ext/work entries (tags corch). Do not run docs:sync yet (Task 7).
    Commit: `feat(corch-01): enrollment + idempotent enqueue routes, ext:corch explicit scope`.
  </action>
  <verify>
    <automated>bun test hub/test/corch-routes.test.ts hub/test/mount-order.test.ts hub/test/api-keys-scopes.test.ts</automated>
  </verify>
  <done>All route cases pass; api keys get 403 on cookie routes; ext enqueue refuses non-explicit keys and non-accepting projects with zero writes; mount-order and api-keys-scopes pins green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3 (Wave B): CORCH gate trio, QuotaProvider, server prompt template, gate-list wiring and coverage guards</name>
  <read_first>
    hub/src/dispatch/gates.ts lines 107-130, 260-350 (DispatchGate check shape and the three refusal literals for LD-7);
    hub/src/dispatch/untrusted.ts (fenceUntrusted signature and the fence markers, SCOPE_CONTRACT at :41);
    hub/src/db/token-usage-dal.ts lines 225-252 (tz-day boundary and the four bucket column names);
    hub/test/token-cap-coverage.test.ts lines 75-130; hub/test/kill-switch-coverage.test.ts lines 95-140; hub/test/counter-key-assignment-guard.test.ts lines 1-90.
  </read_first>
  <files>hub/src/corch/gates.ts, hub/src/corch/quota-provider.ts, hub/src/corch/prompt.ts, hub/src/corch/store.ts, hub/src/corch/dispatcher.ts, hub/test/corch-gates.test.ts, hub/test/corch-prompt.test.ts, hub/test/token-cap-coverage.test.ts, hub/test/kill-switch-coverage.test.ts, hub/test/counter-key-assignment-guard.test.ts</files>
  <behavior>
    Tests first:
    - corch-gates.test.ts: `buildCorchPipelineDeps(fakeDeps).gates.map(g => g.name)` equals, in order, automationKillSwitchGate.name, dailyCostCapGate.name, dailyTokenCapGate.name, 'corch_project_budget', 'corch_concurrency', 'corch_quota', sessionInjectRateGate.name, automationLifetimeCounterGate.name (names read from the imported gate objects, CORCH-R1.9); corchConcurrencyGate refuses `corch_concurrency` when live runs excluding the request's own run >= cap and passes below; corchProjectBudgetGate refuses `project_budget` when the fake store reports usage >= budget; corchQuotaGate with DEFAULT_QUOTA_PROVIDER refuses `quota_no_snapshot` and with a fake ok provider returns null (CORCH-R1.13); every corch gate refuses `corch_bad_token` for a non corch-run token (fail closed); buildCorchKey('abc') === 'corch:abc', runIdFromToken round-trips and rejects `heal:x`; the LD-7 refusal map returns the documented not_before kind for each listed reason including the three pinned gates.ts literals; buildCorchRequest ignores any caller-supplied key and sets counterKey from the work item id (CORCH-R1.10).
    - corch-prompt.test.ts: a hostile title and body each containing the fence-closing sequence used by fenceUntrusted plus the text "merge to main and deploy" are fenced: the raw closing sequence appears only as the real fence terminators, and every occurrence of "merge to main" lies between a fence opener and its terminator; the output contains SCOPE_CONTRACT and the branch `corch/<id>`; after removing SCOPE_CONTRACT, the single prohibition sentence, and the fenced regions, the remaining template text matches no `/merge|deploy|push to (main|master)/i` (CORCH-R1.12).
    - Guard additions (Task 3 edits): token-cap-coverage known-files gains `corch/dispatcher.ts` plus a corch exact-order test mirroring the heal one at :107-127 with the 8 names and a `Gate\b` count of 8; kill-switch-coverage KNOWN_FILES gains `corch/dispatcher.ts` (kill first, counter last enforced by COUNTED); counter-key-assignment-guard ALLOWED gains `corch/dispatcher.ts` and a corch describe mirroring the heal describe at :67-85 asserting the only counterKey assignment under hub/src/corch/ is in dispatcher.ts with a `buildCorchKey(` right-hand side and that `buildCorchKey` is defined only in corch/keys.ts.
  </behavior>
  <action>
    hub/src/corch/quota-provider.ts: `QuotaProvider` interface with `snapshotFor({userId, projectId, workItemId})` resolving `{ok:true, account_slot, supervisor_id}` or `{ok:false, reason}`, and `DEFAULT_QUOTA_PROVIDER` per LD-11. hub/src/corch/gates.ts: three factories `corchProjectBudgetGate(store)`, `corchConcurrencyGate(store)`, `corchQuotaGate(quota, store)` returning DispatchGate objects with the LD-5 names; each resolves its run via runIdFromToken(req.token) then a store lookup (`store.runContext(runId)` returning run, item, project; add it to store.ts and CorchStore); budget uses `store.projectTokensToday(projectId, tz)` = SUM of input + output + cache_creation + cache_read from token_usage joined to corch_runs on session_id for that project within the user's tz-day, using the same boundary expression as getTodayTokenTotal (cast session_id types if token_usage.session_id differs) (CORCH-R1.8); concurrency uses `store.liveRunsForUser(userId, excludeRunId)` and the user cap. No top-level DB import (LD-2). hub/src/corch/prompt.ts: `buildCorchPrompt({item, project, worktreePath})` returns a server-owned template: a header line naming the CORCH work item id and repo_ident, SCOPE_CONTRACT, the instruction to work only in the given worktree on branch corch/<id> as one GSD phase, push that branch and open a pull request, the single prohibition sentence "Never merge any pull request, never push to the default branch, never deploy.", then title, body, source and source_ref each passed ONLY through fenceUntrusted (CORCH-R1.12). In dispatcher.ts add `buildCorchPipelineDeps(deps, ctx)` holding the single gates literal of LD-5 (other PipelineDeps fields are filled in Task 4; for now store, isOnline, send, replay may be the Task 4 stubs typed correctly) and `buildCorchRequest({userId, sessionId, runId, workItemId, prompt})` per LD-3/LD-4 copying heal's buildRequest field set (actor CORCH_ACTOR if DispatchRequest carries an actor). Export the LD-7 mapper as `refusalSchedule(reason)` returning `{endReason, waitReason, notBefore: 'midnight' | 'plus_60m' | 'plus_lease' | null}`. Apply the three guard edits exactly as in behavior.
    Commit: `feat(corch-01): corch gate trio, fail-closed quota provider, fenced prompt, gate-list guards`.
  </action>
  <verify>
    <automated>bun test hub/test/corch-gates.test.ts hub/test/corch-prompt.test.ts hub/test/token-cap-coverage.test.ts hub/test/kill-switch-coverage.test.ts hub/test/counter-key-assignment-guard.test.ts</automated>
  </verify>
  <done>Exact gate order pinned by name and by guard scan; quota default refuses; prompt fence test passes; the three coverage guards are green with corch entries.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4 (Wave C): governed launch + dispatch turn + run end + bounded requeue/blocked + not_before timer, launch guards</name>
  <read_first>
    hub/src/heal/route.ts lines 118-160 (real isOnline/send wiring) and 356-447 (governor closures, replay, onParkExpire, release arguments);
    hub/src/dispatch/pipeline.ts lines 279-480 (when markSkipped/markFailed/markDispatched fire, parked_offline and replay semantics);
    hub/test/launch-callers-guard.test.ts lines 1-40 and 90-120; hub/test/launch-machine-guard.test.ts (structure only);
    hub/test/session-start-senders-guard.test.ts (FILES map); hub/test/reserve-caller-guard.test.ts lines 50-70.
  </read_first>
  <files>hub/src/corch/dispatcher.ts, hub/src/corch/store.ts, hub/test/corch-gates.test.ts, hub/test/launch-callers-guard.test.ts, hub/test/launch-machine-guard.test.ts, hub/test/session-start-senders-guard.test.ts, hub/test/reserve-caller-guard.test.ts</files>
  <behavior>
    Tests first (unit, fake deps, added to corch-gates.test.ts under describe "dispatcher"):
    - governedLaunch receives armed = corchEnabled(), repoIdent = project.repo_ident, ledger.command = AUTOSPAWN_LAUNCH_COMMAND, a preLaunch governor, and launch deps whose isRepoAutospawnAllowed is the CORCH enrollment check (not the orchestrator allowlist) (CORCH-R1.11).
    - refused `quota_no_snapshot` => endRunAndRequeue with consumeAttempt false, waitReason quota_no_snapshot, notBefore null; refused `automation_halted:global` => endReason automation_halted; failed => consumeAttempt true (CORCH-R3.4/R3.5).
    - launched then dispatch outcome skipped `automation_halted:user` => run ended automation_halted, no attempt, reservation released once (CORCH-R3.5); outcome dispatched => markRunRunning; parked_offline then onParkExpire => spawn_timeout with attempt and one release; dropped_busy => attempt.
    - onFinalize with PrLookup open => endRunMarkPrOpen(url); none => no_pr with attempt; unavailable (default) => pr_lookup_unavailable with attempt; then evaluateUser re-triggered once.
    - Third consumed attempt => blocked and notify called exactly once even when the same transition is delivered twice (callback and returned outcome).
    - armNotBeforeTimer sets exactly one setTimeout for the earliest future not_before (clamped to 2147483647 ms), clears the previous one, and sets none when there is no future not_before.
    - Guard additions: launch-callers-guard gains a corch describe mirroring the heal one at :94-116 (no `launchSessionForUser` token in any hub/src/corch file; dispatcher.ts imports governedLaunch); launch-machine-guard gains one corch case asserting dispatcher.ts launches only via governedLaunch with a preLaunch governor (source scan for `governedLaunch(` and `preLaunch`); session-start-senders-guard gains "no session.start literal under hub/src/corch/"; reserve-caller-guard gains "no reserveInject( call under hub/src/corch/" with its ALLOWED set unchanged.
  </behavior>
  <action>
    Replace the Task 1 `launch_not_wired` line with the real path, mirroring heal/route.ts:356-404: attach session (store.attachSession), build prompt and request (token buildCorchRunToken(runId), counterKey buildCorchKey(item.id)), build pdeps via buildCorchPipelineDeps, then governedLaunch with `{userId, sessionId, repoIdent: project.repo_ident, tz: await deps.launch.tzForUser(userId), armed: corchEnabled(), ledger: {repoKey: project.repo_ident, command: AUTOSPAWN_LAUNCH_COMMAND, rationale: () => 'corch work_item=<id> run=<runId>'}, preLaunch: {checkGates, reserve (enforceRate true, actor CORCH_ACTOR, same token and key), release}}` and `deps.launch` (LD-1). Map results per LD-7/LD-8: refused and in_flight => refusal path; failed => failure path; launched => store.markRunLaunched(corchRunId, result.supervisorId) (the corch_runs id, NOT the launch result's own runId, which is the supervisor launch id and is only written into the ledger rationale) then `deps.dispatch(req, pdeps)` and `applyOutcome(runId, outcome)`. Complete buildCorchPipelineDeps: store = a RunStore whose open returns null, markDispatched => markRunRunning, markSkipped => refusal path with release (LD-10), markFailed => failure `dispatch_failed`, onFinalize => handleRunEnd; isOnline/send/graceKey/finalizeTimeoutMs taken from the same real functions heal's buildPipelineDeps uses (injected through CorchDeps.pipeline so tests fake them); replay = re-run deps.dispatch with the same req and pdeps then applyOutcome; onParkExpire = failure `spawn_timeout` with release. handleRunEnd(runId) calls deps.prLookup.lookup({userId, repoIdent, branch, workItemId}) and applies open/none/unavailable per LD-8. All transitions go through LD-9 store methods; notify (LD-14) only when changed and blocked; after any end-of-run call evaluateUser(userId) and armNotBeforeTimer() (LD-12). armNotBeforeTimer uses deps.timers.setTimeout/clearTimeout and store.earliestFutureNotBefore(); its callback calls evaluateAll() (store.usersWithDueItems() then evaluateUser each) and re-arms. Add `realCorchDeps()` (async, dynamic imports per LD-2: store.ts, REAL_AUTOSPAWN spread with the enrollment override, AUTOSPAWN_LAUNCH_COMMAND, pipeline dispatch and releaseClosedRunByToken, the heal real isOnline/send functions, fanOutNotify wrapper, global timers, DEFAULT_* providers) and a memoized `getCorch()` singleton; export trigger functions onSupervisorHello(userId), onSupervisorClosed(supervisorId), onKillSwitchReleased(scope, userId) that return immediately when !corchEnabled() and otherwise delegate to the singleton (closed => reclaim per LD-13 then evaluate). Apply the four guard edits.
    Commit: `feat(corch-01): governed launch + dispatch turn, bounded requeue, not_before timer, launch guards`.
  </action>
  <verify>
    <automated>bun test hub/test/corch-gates.test.ts hub/test/launch-callers-guard.test.ts hub/test/launch-machine-guard.test.ts hub/test/session-start-senders-guard.test.ts hub/test/reserve-caller-guard.test.ts hub/test/heal-single-seam.test.ts</automated>
  </verify>
  <done>Dispatcher unit cases pass with fakes; corch contains no launchSessionForUser token, no reserveInject call, no session.start literal; all four launch guards and heal-single-seam green.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5 (Wave C): reconciler, positive-knowledge reclaim, triggers (hello/close/kill-switch release/boot), no-polling guard, flag-off proof</name>
  <read_first>
    hub/src/ws/dead-session-reaper.ts (freshness predicate and how it reads per-supervisor inventory); hub/src/ws/supervisor-registry.ts lines 400-500;
    hub/src/ws/agent.ts lines 905-920 and 1400-1415; hub/src/api/automation.ts lines 40-70 and 140-150; hub/src/index.ts the line that calls startHookReaper.
  </read_first>
  <files>hub/src/corch/reconciler.ts, hub/src/corch/dispatcher.ts, hub/src/corch/store.ts, hub/src/ws/agent.ts, hub/src/api/automation.ts, hub/src/index.ts, hub/test/corch-no-polling-guard.test.ts, hub/test/corch-flag-off.test.ts</files>
  <behavior>
    Tests first:
    - corch-no-polling-guard.test.ts: walk hub/src/corch/*.ts, strip comments (same stripComments as heal-single-seam), assert the token `setInterval(` appears exactly once in total and only in reconciler.ts (CORCH-R3.6).
    - corch-flag-off.test.ts: with REMO_CORCH_ENABLED unset and a CorchDeps where every store method, launch function, dispatch, notify, inventory function and all four timer functions are spies, call evaluateUser, evaluateAll, armNotBeforeTimer, the dispatcher-level hello/closed/released handlers, and startCorchReconciler(deps); assert zero calls on every spy; also import the exported trigger functions onSupervisorHello/onSupervisorClosed/onKillSwitchReleased and assert they resolve without constructing the singleton (spy on getCorch) (CORCH-R1.2).
    - Reconciler unit cases (in corch-gates.test.ts describe "reconciler", fake inventory dep returning per-supervisor `{fresh: boolean, sessionIds: Set}`): listed => heartbeat; fresh-not-listed beyond lease => reclaim session_absent with attempt; fresh-not-listed within lease => nothing; not fresh beyond lease => stalled once and one notify across two passes; stalled then listed => back to running; session_id NULL, not in-flight, older than lease => claim_orphaned without attempt; in-flight runs skipped; at most 100 runs read per pass; an overlapping pass is skipped (CORCH-R3.3).
  </behavior>
  <action>
    hub/src/corch/reconciler.ts: `startCorchReconciler(deps)` returns immediately when !corchEnabled(); otherwise one `setInterval` at corchReconcileIntervalMs() calling `reconcilePass(deps)` guarded by a passRunning flag; `reconcilePass` reads `store.liveRunsOldestHeartbeat(100)` and applies LD-13, collecting heartbeat ids into one `store.touchHeartbeat(runIds)` (sets heartbeat_at now() and status running where status was stalled), using `store.markStalled(runId)` returning changed, and reclaim via endRunAndRequeue plus `deps.pipeline.releaseByToken(token, endReason)`; after any reclaim run the run-end follow-ups (notify if blocked, evaluateUser, armNotBeforeTimer). Inventory is a CorchDeps.inventory dependency; its real implementation (in realCorchDeps) reads the registry with the dead-session-reaper freshness rule. Export `startCorch()` that, when enabled, awaits getCorch(), starts the reconciler and arms the not_before timer once. Hooks (sanctioned exceptions, additive only): in hub/src/ws/agent.ts directly after the registerSupervisor call add `if (corchEnabled()) void import('../corch/dispatcher.ts').then(m => m.onSupervisorHello(userId)).catch(err => console.warn(...))`, and directly after unregisterSupervisor the same shape calling onSupervisorClosed(ws.data.supervisorId); import corchEnabled from ../corch/flag.ts. In hub/src/api/automation.ts inside resumeDeferredWork, after the existing try/catch, add one separate try block that dynamically imports ../corch/dispatcher.ts and awaits onKillSwitchReleased(scope, userId), catching and logging with the same `[automation-api]` prefix; change nothing else. In hub/src/index.ts call `startCorch()` (fire and forget with a logged catch) next to the existing startHookReaper boot call.
    Commit: `feat(corch-01): positive-knowledge reconciler + event triggers, no-polling guard, flag-off proof`.
  </action>
  <verify>
    <automated>bun test hub/test/corch-no-polling-guard.test.ts hub/test/corch-flag-off.test.ts hub/test/corch-gates.test.ts hub/test/mount-order.test.ts hub/test/kill-switch-coverage.test.ts</automated>
  </verify>
  <done>Exactly one setInterval in hub/src/corch (reconciler.ts); flag OFF produces zero store, launch, send, notify and timer calls; reconciler cases pass; hooks are additive one-liners.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6 (Wave D): full real-Postgres e2e for success criterion 5 and the selection order</name>
  <read_first>hub/test/e2e/corch-dispatcher.e2e.test.ts (Task 1 bootstrap); the kill-switch engage function and the lifetime-cap env reader in automation-controls.ts (names only, via grep); how hub/test/e2e/orchestrator-tokencap.e2e.test.ts sets the token cap and inserts token_usage rows.</read_first>
  <files>hub/test/e2e/corch-dispatcher.e2e.test.ts</files>
  <behavior>
    Each case uses the real store and real REAL_AUTOSPAWN gate/reserve/release/tz functions against Postgres, with only these fakes: launchSessionForUser (records, returns ok with a fixed supervisorId), supervisorOnlineForUser (true), Workspace (inserts a real sessions row for the user and returns it, except where the default is under test), QuotaProvider (ok, except where the default is under test), PrLookup, dispatch (records and returns a chosen outcome; tests invoke the captured RunStore callbacks), notify (records), inventory, timers.
    - R1.6 order: three projects with priorities 2/1/0 and items with mixed priority and created_at; repeated claim-and-end-as-refused (exclude list) yields the exact documented order.
    - R1.7 race: cap 1, two eligible items in two projects, Promise.all of two evaluateUser calls => exactly one live corch_runs row and one launch call.
    - R3.1/R3.2: a direct concurrent insert of two live runs for one item yields one 23505; cap 2 with two queued items in ONE project => one live run; a project with a pr_open item gets no claim.
    - R3.4: launched run then onSupervisorClosed(supervisorId) => ended supervisor_closed, attempts 1, not_before about now+60s (tolerance 10s); set not_before into the past, relaunch, close => attempts 2, about now+300s; third => status blocked and exactly one notify; delivering the third transition again changes nothing.
    - R3.5 one case per refusal, each asserting status queued, attempts 0, no live run, run end_reason as LD-7: kill switch engaged (automation_halted, not_before NULL); daily token cap exceeded via env cap and a token_usage row (midnight); cost cap exceeded the way the existing cost-cap e2e does it (midnight); project budget 100 with a cache_read-only token_usage row of 1000 on a prior ended corch run's session (project_budget, midnight, CORCH-R1.8); concurrency gate refusal; quota default (quota_no_snapshot, CORCH-R1.13); inject-rate via routine_run_log rows at the configured per-hour max (plus 60m); lifetime cap via REMO_AUTOMATION_LIFETIME_INJECT_CAP=1 and one unreleased ledger row for the item key (lifetime_inject_exhausted); default workspace (workspace_unavailable); and halt after the claim (dispatch outcome skipped automation_halted:global => end_reason automation_halted, no attempt, reservation released).
    - R3.3/R3.7 restart: a live run with a session and no inventory; a NEW dispatcher instance (simulated restart) evaluating all users launches nothing; a reconcile pass with no fresh inventory and heartbeat older than the lease marks it stalled with one notify, a second pass adds no notify; a fresh inventory lacking the session then reclaims it session_absent with attempt 1.
    - End-to-end success: fake PrLookup open on finalize => item pr_open with pr_url and the run ended.
  </behavior>
  <action>
    Extend the Task 1 e2e file with the cases above (one `describe` per requirement id, each test isolated by its own user). Use setup helpers local to this file only. Restore every env var each test sets. Do not add production code in this task; if a case fails because of a production defect, fix it in the owning hub/src/corch module within this task's commit and note it in the SUMMARY.
    Commit: `test(corch-01): real-Postgres dispatcher e2e for criterion 5`.
  </action>
  <verify>
    <automated>REMO_E2E_DB_URL=$REMO_E2E_DB_URL bun test hub/test/e2e/corch-dispatcher.e2e.test.ts</automated>
  </verify>
  <done>Every listed case passes against real Postgres with 0 skipped tests.</done>
</task>

<task type="auto">
  <name>Task 7 (Wave D): docs, CLAUDE.md env entries, docs:sync, baseline re-measure, full Definition of Done</name>
  <read_first>tools/check-baseline.ts header (its documented update mode); CLAUDE.md "Environment Variables" bullets for REMO_HEAL_UNIFIED (format to mirror) and the Docs map table; docs/self-heal-routing.md headings (structure to mirror).</read_first>
  <files>docs/corch.md, CLAUDE.md, docs/openapi.json, docs/api.md, tools/regression-baseline.json</files>
  <action>
    Write docs/corch.md: purpose; flags and env (REMO_CORCH_ENABLED default OFF, REMO_CORCH_LEASE_MS 120000, REMO_CORCH_RECONCILE_INTERVAL_MS 60000, boot mutual exclusion with REMO_ORCHESTRATOR_ENABLED); tables; routes and the explicit `ext:corch` scope; state machine with LD-7/LD-8 tables; the 8-gate chain and why thresholdGate is absent; counter key and token; positive-knowledge reclaim; triggers and the single interval; fail-closed defaults (quota, workspace, PR lookup) and the phase that replaces each (02, 09, 09); shared autospawn daily launch cap; "this phase cannot launch in prod". CLAUDE.md: one Environment Variables bullet for the three CORCH env vars in the REMO_HEAL_UNIFIED style, one Docs map row for docs/corch.md, and add `ext:corch` (EXPLICIT-only) to the API-keys scopes invariant sentence; no other CLAUDE.md edits. Run `bun run docs:sync`, commit the regenerated docs/openapi.json and docs/api.md, run it again and confirm `git diff --exit-code -- docs/openapi.json docs/api.md`. Re-measure the regression baseline with the update mode documented in tools/check-baseline.ts; the diff of tools/regression-baseline.json may only add entries for the new corch test files and may not lower any existing entry. Then run every Definition of Done command in order and paste the outputs into the SUMMARY.
    Commit: `docs(corch-01): corch subsystem doc, env entries, api docs, baseline`.
  </action>
  <verify>
    <automated>bun run docs:sync && git diff --exit-code -- docs/openapi.json docs/api.md && bun run check-baseline</automated>
  </verify>
  <done>docs/corch.md exists, CLAUDE.md carries the three env vars and the docs map row, docs:sync is clean, check-baseline exits 0, and all 12 Definition of Done items have pasted evidence.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser (cookie) -> /api/corch/* | owner enrolls repos and enqueues manual items |
| external agent (api key) -> /api/ext/corch/work-items | AAF/memlog producers enqueue untrusted title/body |
| work-item text -> agent prompt | untrusted text reaches an agent with file-write powers |
| hub -> supervisor (launch + user_message) | machine-triggered spend on the owner's subscription |
| supervisor inventory/close -> reconciler | liveness signals decide reclaim |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-CORCH01-01 | Spoofing | /api/corch/* cookie routes | high | mitigate | Mounted after the /api/* authMiddleware; an api key gets 403 there; route + mount-order tests (Task 2) |
| T-CORCH01-02 | Elevation of privilege | POST /api/ext/corch/work-items | high | mitigate | `ext:corch` checked with hasExplicitScope (NULL/legacy and other ext scopes refused); project must be enrolled, enabled and accept_external, else 403 before any write (Task 2) |
| T-CORCH01-03 | Tampering | counter key / status / branch from request input | high | mitigate | zod strips unknown keys; counter key only from buildCorchKey in buildCorchRequest; counter-key guard pins it (LD-3, LD-4, Task 3) |
| T-CORCH01-04 | Tampering / Elevation | prompt injection via title/body/source_ref | high | mitigate | server-owned template, every item string inside fenceUntrusted, SCOPE_CONTRACT, propose-only PR wording, launch forces skipPermissions false via governedLaunch HEAL policy; hostile fence test (Task 3) |
| T-CORCH01-05 | Denial of service (spend) | dispatcher | critical | mitigate | flag OFF by default; enrollment table empty by default; default QuotaProvider and Workspace refuse; 8-gate chain with kill switch first and cost + token caps; lifetime counter per item; inject-rate gate; shared autospawn daily launch cap; max 3 attempts with backoff then blocked |
| T-CORCH01-06 | Tampering | concurrent claims / restart | high | mitigate | per-user advisory lock in the claim txn plus partial unique indexes per item and per project; idempotent end-of-run transitions; restart e2e (Task 6) |
| T-CORCH01-07 | Denial of service | false reclaim of a live run | medium | mitigate | reclaim only on socket close seen by this process or fresh inventory lacking the session past the lease; unknown => stalled once + one notification (LD-13) |
| T-CORCH01-08 | Information disclosure | cross-user rows | high | mitigate | every query filters by the authenticated user id; PATCH/:id and project_id lookups return 404 for other users; ext enqueue resolves the project by the key's own user |
| T-CORCH01-09 | Repudiation | who launched what | low | mitigate | corch_runs rows (counter_key, session_id, supervisor_id, end_reason), routine_run_log autospawn ledger row written before launch, automation_inject_ledger reservation with actor corch |
| T-CORCH01-10 | Information disclosure | owner notifications | low | mitigate | notifications carry ids, repo_ident, attempts and end_reason only, never item text (LD-14) |
| T-CORCH01-11 | Elevation of privilege | boot with two dispatchers | medium | mitigate | assertCorchConfig refuses boot when REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED are both truthy (Task 1) |
| T-CORCH01-SC | Tampering | package installs | low | accept | this phase installs no npm/pip/cargo package; no legitimacy checkpoint needed |
</threat_model>

<verification>
Run the 12 Definition of Done commands in order after Task 7 and paste outputs. Then confirm the source audit:
- GOAL (ROADMAP CORCH-01: queue tables, enqueue/enroll API, gate chain, claim/heartbeat/reclaim, requeue, flag OFF + boot mutual exclusion, fail-closed quota provider): Tasks 1-6.
- REQ: R1.1 T1; R1.2 T1/T2/T5; R1.3 T1; R1.4 T2; R1.5 T1/T2; R1.6 T1/T6; R1.7 T1/T6; R1.8 T3/T6; R1.9 T3; R1.10 T3; R1.11 T1/T4; R1.12 T3; R1.13 T3/T6; R3.1 T1/T6; R3.2 T1/T6; R3.3 T5/T6; R3.4 T4/T6; R3.5 T4/T6; R3.6 T4/T5; R3.7 T5/T6.
- RESEARCH items 1-5: Task 1 step A.
- Out of scope and absent from this plan: quota snapshots and account choice (02), gsd-console (04), AAF receiver (08), real Workspace/PR lookup/memlog claim (09), UI/Telegram (11), any change to thresholdGate, runMacroCycle, routine_queue or orchestrator rows, any automated ext:corch producer.
</verification>

<success_criteria>
1. schema-lint, migration-verify and schema-double-apply e2e exit 0; no destructive DDL in the schema diff.
2. corch-flag-off.test.ts proves zero launch/send/timer calls with the flag OFF; corch-boot-assert.test.ts proves the four boot combinations.
3. Route tests prove enrollment, idempotent enqueue, explicit ext:corch and 403-before-write.
4. All twelve guard files green, with the corch exact-order test (8 gates, kill first, lifetime last).
5. corch-dispatcher.e2e.test.ts green on real Postgres: race at cap 1, per-item and per-project uniqueness, death requeue with backoff, third failure blocked with one notification, one case per refusal with attempts unchanged, restart without double launch, default provider leaves wait_reason quota_no_snapshot.
6. Prompt fence test green; docs/corch.md exists; docs:sync leaves no diff; check-baseline exits 0; typecheck error count <= N0 with zero errors in corch files.
</success_criteria>

<output>
Create `.planning/phases/CORCH-01-backlog-dispatcher-core/CORCH-01-01-SUMMARY.md` when done, with the pasted Definition of Done outputs, the measured N0, every commit hash, and any BLOCKER hit (exact error, rule 7d ticket id).
Do not open the PR; the orchestrator runs /qc and opens it.
</output>
