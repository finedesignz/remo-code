---
phase: CORCH-01-backlog-dispatcher-core
plan: 01
subsystem: hub central orchestrator (hub/src/corch)
tags: [corch, dispatcher, backlog, governed-launch, reconciler, flag-off]
status: complete
branch: phase-corch-01-backlog-dispatcher
plan_head_before: dd93719
commits: 7
requirements: [CORCH-R1.1, CORCH-R1.2, CORCH-R1.3, CORCH-R1.4, CORCH-R1.5, CORCH-R1.6, CORCH-R1.7, CORCH-R1.8, CORCH-R1.9, CORCH-R1.10, CORCH-R1.11, CORCH-R1.12, CORCH-R1.13, CORCH-R3.1, CORCH-R3.2, CORCH-R3.3, CORCH-R3.4, CORCH-R3.5, CORCH-R3.6, CORCH-R3.7]
actuals:
  tasks: 7
  commits: 7
---

# Phase CORCH-01 Plan 01: Backlog and dispatcher core Summary

Additive corch queue tables, cookie + explicit-scope enqueue routes, the exact 8-gate chain, a per-user advisory-lock claim
transaction, launch only through `governedLaunch` (HEAL), prompt turn only through shared `dispatch()`, bounded requeue
with backoff and a blocked state, positive-knowledge reclaim, one reconciler interval plus one `not_before` timer, and boot
mutual exclusion with the old orchestrator. Flag defaults OFF and the default QuotaProvider, Workspace and PrLookup all
refuse, so this phase cannot launch a session in production. Branch NOT pushed; no PR opened.

Baselines: typecheck N0 = 253 `error TS` (measured before any change, RESEARCH.md); final 253 with 0 errors in corch files.

## Tasks

| Task | Commit | Files | Tests |
|---|---|---|---|
| 1 tracer: schema, store claim txn, fail-closed dispatcher, boot assert | d241c44 | CORCH-01-RESEARCH.md, hub/src/db/schema.sql, hub/src/corch/{flag,keys,store,dispatcher}.ts, hub/src/index.ts, hub/test/corch-boot-assert.test.ts, hub/test/e2e/corch-dispatcher.e2e.test.ts | corch-boot-assert 10 pass; tracer e2e 3 pass on real Postgres; schema-double-apply 0 fail; schema-lint + migration-verify exit 0 |
| 2 enrollment + enqueue routes, ext:corch scope | f1a5fcc | hub/src/corch/{routes,store,dispatcher}.ts, hub/src/index.ts, hub/src/auth/{scopes,ext-api-key-middleware}.ts, hub/src/api/{ext,_openapi}.ts, hub/test/{corch-routes,mount-order,api-keys-scopes}.test.ts | corch-routes 12 (W1 note said 13; re-counted at the end), mount-order 24, api-keys-scopes 32; 0 fail |
| 3 gate trio, QuotaProvider, fenced prompt, gate-list guards | 1448493 | hub/src/corch/{gates,quota-provider,prompt,store,dispatcher}.ts, hub/test/{corch-gates,corch-prompt,token-cap-coverage,kill-switch-coverage,counter-key-assignment-guard}.test.ts | corch-gates 15, corch-prompt 3, token-cap-coverage 7, kill-switch-coverage 10, counter-key-assignment-guard 9; 0 fail |
| 4 governed launch + dispatch turn, requeue, not_before timer, launch guards | 38a4eea | hub/src/corch/{dispatcher,store}.ts, hub/test/{corch-gates,launch-callers-guard,launch-machine-guard,session-start-senders-guard,reserve-caller-guard}.test.ts | corch-gates 28; launch guards 12/8/13/7; heal-single-seam 26; pty-door-guard 22; orchestrator:e2e 71 pass |
| 5 reconciler, reclaim, triggers, no-polling guard, flag-off proof | 6818960 | hub/src/corch/{reconciler,dispatcher,store}.ts, hub/src/ws/agent.ts, hub/src/api/automation.ts, hub/src/index.ts, hub/test/{corch-no-polling-guard,corch-flag-off,corch-gates}.test.ts | corch-no-polling-guard 2, corch-flag-off 4, corch-gates 40 (12 new reconciler cases); kill-switch-coverage 10; mount-order 24; 0 fail |
| 6 real-Postgres e2e for criterion 5 | a76ec72 | hub/test/e2e/corch-dispatcher.e2e.test.ts | 21 pass / 0 fail / 0 skipped (run twice) |
| 7 docs, CLAUDE.md, docs:sync, baseline | 87ee8ec | docs/corch.md, CLAUDE.md, docs/openapi.json, docs/api.md, tools/regression-baseline.json | docs:sync idempotent; check-baseline exit 0 |

Task 5 notes: `reconciler.ts` holds the only `setInterval(` under hub/src/corch (guard-pinned). Hooks are additive: two
one-line hooks in `ws/agent.ts` (hello after `registerSupervisor`, close after `unregisterSupervisor`), one try block in
`resumeDeferredWork` (0 removed lines in automation.ts), one `startCorch()` boot call in `index.ts`.

Task 6 notes: no production defect surfaced; no production file changed in that commit.

## Definition of Done (run after Task 7, real output)

Environment: `REMO_E2E_DB_URL=postgres://remo@127.0.0.1:55432/remo_ci` (local Postgres, trust auth). Run from the worktree root.

| # | Command | Exit | Counts | Result |
|---|---|---|---|---|
| 1 | `bun run schema-lint` | 0 | "OK - no un-pragma'd mutating statements (5 allowed)" | PASS |
| 2 | `DATABASE_URL=postgres://remo@127.0.0.1:55432/corch_mv_final bun run migration-verify` (fresh DB, run twice) | 0 / 0 | errors=0 notices=4, then errors=0 notices=293 | PASS |
| 3 | `REMO_E2E_DB_URL=... bun test hub/test/e2e/schema-double-apply.e2e.test.ts` | 0 | 9 pass, 0 fail, 0 skip | PASS |
| 4 | `git diff origin/main -- hub/src/db/schema.sql \| grep "^+" \| grep -ciE "\bdrop\b\|\btruncate\b\|alter column .* type"` | n/a | prints 0 | PASS |
| 5 | `bun test` the 6 corch unit files (boot-assert, flag-off, gates, prompt, routes, no-polling-guard) | 0 | 71 pass, 0 fail | PASS |
| 6 | guards, see below | see below | see below | PASS (run as separate processes, see deviation W2-9) |
| 7 | `REMO_E2E_DB_URL=... bun test hub/test/e2e/corch-dispatcher.e2e.test.ts` | 0 | 21 pass, 0 fail, 0 skip | PASS |
| 8 | `REMO_E2E_DB_URL=... bun run orchestrator:e2e` | 0 | 89 pass, 0 fail across 14 files | PASS |
| 9 | `bun run check-baseline` (bare: REMO_E2E_DB_URL and DATABASE_URL unset) | 0 | baseline pass=3626 skip=316 fail=0 total=3942; actual identical; "OK - within tolerance" | PASS |
| 10 | `bun run docs:sync` then `git diff --exit-code -- docs/openapi.json docs/api.md` | 0 / 0 | no diff on the second sync | PASS |
| 11 | `cd hub && bun run typecheck` | 1 (pre-existing errors) | total `error TS` = 253 (N0 = 253); `grep -E "src/corch/\|test/corch\|test/e2e/corch" \| grep -c "error TS"` = 0 | PASS |
| 12 | scope fence | n/a | see below | PASS with one noted extra path |

Item 6 detail (the plan lists 12 files in one command; run as below):

- One process, 10 guard files (counter-key-assignment-guard, token-cap-coverage, kill-switch-coverage, launch-callers-guard, launch-machine-guard, session-start-senders-guard, reserve-caller-guard, heal-single-seam, pty-door-guard, orchestrator-macro-path-guard): exit 1, 114 pass / 1 fail / 1 error. The failure is a load error in orchestrator-macro-path-guard: `SyntaxError: Export named 'getUserClaudeThresholds' not found in module hub/src/db/dal.ts`. Cause: launch-machine-guard calls process-global `mock.module` on `db/supervisor-dal.ts` and `dispatch/automation-controls.ts` (its own header says it needs its own process). Proven pre-existing and unrelated to this diff: `launch-machine-guard` + `orchestrator-macro-path-guard` alone fail the same way; the same 9 files WITHOUT launch-machine-guard pass together (111 pass, 0 fail); neither mock block is touched by this phase.
- Each of the 10 files in its own process: counter-key-assignment-guard 9, token-cap-coverage 7, kill-switch-coverage 10, launch-callers-guard 12, launch-machine-guard 8, session-start-senders-guard 13, reserve-caller-guard 7, heal-single-seam 26, pty-door-guard 22, orchestrator-macro-path-guard 5: all 0 fail.
- `bun test hub/test/api-keys-scopes.test.ts`: exit 0, 32 pass, 0 fail. `bun test hub/test/mount-order.test.ts`: exit 0, 24 pass, 0 fail (separate processes, pre-existing leak, ticket 34245069).

Item 12 detail: `git diff --name-only origin/main...HEAD` = 39 paths; every planned `files_modified` path is changed and one extra path is changed: `hub/src/auth/ext-api-key-middleware.ts` (W1 deviation 1, Rule 3). `git diff origin/main -- hub/src/orchestrator hub/src/heal hub/src/dispatch hub/src/sessions hub/src/telegram supervisor .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md | wc -l` = 0. `git diff origin/main -- hub/src/api/automation.ts | grep -c "^-[^-]"` = 0.

### Baseline re-measure (tools/regression-baseline.json)

Procedure: `tools/check-baseline.ts` has no automatic update mode; the documented procedure (its DRIFT message and the file's own notes) is to run the per-file-isolated `bun run check-baseline` on a bare checkout (the FLOOR configuration, no REMO_E2E_DB_URL, no DATABASE_URL) and edit `tools/regression-baseline.json` in the same PR with a `_skip_note_*` that names every moved number.

| | before (origin/main dd93719) | after |
|---|---|---|
| pass | 3503 | 3626 (+123) |
| skip | 291 | 316 (+25) |
| fail | 0 | 0 |
| total | 3794 | 3942 |
| tolerance.skip_max | 295 | 316 |
| tolerance.pass_min | 1850 | 1850 (unchanged, not lowered) |
| tolerance.fail_max | 0 | 0 |

Why: the first run on this branch reported `DRIFT skip=316 > skip_max=295`. Measured the corch e2e file alone without a DB: 0 pass, 25 skip, 0 fail, and 316 - 25 = 291 = the prior skip count, so every added skip is that one REMO_E2E_DB_URL-gated file (same explicit-reason gating as every other e2e skip; it RUNS in CI on postgres:16 and ran locally here, 21 pass / 0 skip). The +123 passes are the new DB-free corch tests and the new corch cases in the guard files. skip_max was raised to exactly the measured 316 (no extra headroom); no failure was hidden and no ceiling was raised for a real failure. The diff to the JSON is `captured_at`, `pass`, `skip`, `total`, `skip_max` and one new `_skip_note_corch_01` (7 insertions, 6 deletions, all in those lines).

## Deviations from Plan

### Wave 1 (Tasks 1-4, from CORCH-01-SUMMARY-W1.md)

1. [Rule 3] Edited `hub/src/auth/ext-api-key-middleware.ts` (not in `files_modified`): the ext scope gate is path-based inside this middleware, handlers never see key scopes, so the explicit `ext:corch` gate must live there (one added block, same pattern as `ext:work`). The scope-fence list therefore has one extra path. Commit f1a5fcc.
2. `routes.ts` also exports `createCorchRoutes(deps)` / `createExtCorchRoutes(deps)` (store and evaluate trigger injected). Reason: `mock.module` leaks across files in one bun process and broke mount-order when corch-routes ran first. The scope-gate cases (403, zero writes) are pinned in api-keys-scopes.test.ts through the real middleware; corch-routes.test.ts covers the handlers.
3. "api key Bearer on GET /api/corch/projects gets 403" is pinned structurally: every corch cookie path is not on the settings allowlist (`matchSettingsRoute` null), which is exactly why authMiddleware answers 403. No full-app DB-backed request test.
4. The ext body identifies the project by `repo_ident` (plan did not specify); canonicalised like the cookie route.
5. `_openapi.ts` corch block is typed without `as const` so it adds 0 typecheck errors.
6. kill-switch-coverage pinned `lists` length 14; adding `corch/dispatcher.ts` makes it 15. The pin (and its title) was updated: the only existing assertion edited, strictly a count for a new legitimate member.
7. Budget refusal reason is the plain `project_budget` (no numeric suffix).
8. `CorchDeps.launchCommand` carries `AUTOSPAWN_LAUNCH_COMMAND` (it lives in a DB DAL; LD-2 forbids the top-level import); `realCorchDeps` imports it dynamically.
9. LD-4 "only place `counterKey` is written is `buildCorchRequest`": `dispatcher.ts` has one more line, `lifetime = { counterKey: buildCorchKey(item.id), token }`, spread into reserve and release (`ReserveArgs`/`ReleaseArgs` require that property name). The guard asserts every assignment line in corch/dispatcher.ts uses `buildCorchKey(`.
10. `governedLaunch` `failed` records the fixed `end_reason` `launch_failed`; the raw `autospawn_launch_threw: <msg>` is only logged, so no untrusted text reaches a stored reason or notification (LD-14).
11. No-attempt refusals do not re-trigger `evaluateUser` (would ping-pong on an item that refuses again); only real run ends re-trigger. Nothing re-enters from inside the claiming loop.
12. Dispatch throwing after a successful launch ends the run as `dispatch_failed` (attempt consumed, no release, LD-10 list).
13. `onSupervisorClosed` was deferred from Task 4 to Task 5 (LD-13 reclaim belongs to the reconciler task).

### Wave 2 (Tasks 5-7)

1. `startCorchReconciler(deps, dispatcher)` takes the dispatcher handle as a second argument (plan: `startCorchReconciler(deps)`). The reconciler needs the handle for `inFlight`, `reclaimRun` and `stallRun`; the OFF path returns before touching either argument.
2. The reconciler interval is a direct global `setInterval(` in `reconciler.ts`, not routed through `deps.timers`. The no-polling guard requires exactly one `setInterval(` token under hub/src/corch, so `CorchTimers` stays `setTimeout`/`clearTimeout` (the not_before timer) and the flag-off test proves "no interval" by spying `globalThis.setInterval` instead of a fake dep. The guard test also pins that `setTimeout(` appears only in dispatcher.ts.
3. `corchSingletonConstructed()` is exported from dispatcher.ts. The flag-off test needs to prove the triggers do not construct the singleton; an ES-module internal call to `getCorch` cannot be spied, so a boolean accessor is the minimal observable.
4. The dispatcher handle gains `deps`, `reclaimRun`, `stallRun` and `onSupervisorClosed`; the module-level `onSupervisorClosed` delegates to it. `onSupervisorClosed` returns without reclaiming when `deps.inventory.isOnline(supervisorId)` is true: `unregisterSupervisor` ignores a stale close from a socket a reconnect already replaced, and reclaiming then would kill a live run. (Plan said only "close => reclaim"; this is the positive-knowledge reading of LD-13.)
5. `CorchStore` gained four methods beyond the plan's list: `liveRunsOldestHeartbeat`, `liveRunsForSupervisor`, `touchHeartbeat`, `markStalled` (plus a `LiveRun` type carrying `repo_ident` and `item_attempts` for the stalled notification). `CorchDeps` gained `inventory` and `pipeline.releaseByToken`.
6. Reclaim ends the run first, then disarms the pipeline hook with `releaseClosedRunByToken` (without `markFailed`, so the hook cannot end the run a second way). The lifetime reservation is NOT released on reclaim (the turn was sent; LD-10 lists no reclaim release).
7. e2e adaptations (Task 6): the engaged-kill-switch case uses user scope (a global engage would halt other e2e files sharing the DB); the daily-token-cap case accepts `over_token_cap` or `over_daily_token_cap:` as the end reason (governedLaunch pre-checks the cap and refuses `over_token_cap` before the gate list runs; both map to next-midnight); the concurrency refusal is produced by inserting another live run from inside `Workspace.resolve` (after the claim, before the gate), since a pre-claim live run would be refused at claim time; the restart case disables other test users' projects before `evaluateAll` (it is global by design).
8. Baseline: `tools/regression-baseline.json` holds aggregate numbers, not per-file entries, so the "add entries for the new corch test files" instruction became: raise `pass`, `skip`, `total`, `skip_max` to the measured values and add `_skip_note_corch_01`. See the re-measure table; `pass_min` and every existing note untouched.
9. DoD #6 as written (one `bun test` process for the 12 files) cannot go green on origin/main either: the pre-existing mock-leak above. Ran as the separate processes shown. 7d ticket filed: AAF annotation 1381858d-d389-4f1c-8082-99c83372dfb2 (repo remo-code, launch-machine-guard + orchestrator-macro-path-guard). The earlier api-keys-scopes + mount-order leak stays ticket 34245069.
10. Summary file name is `CORCH-01-SUMMARY.md` (per the executor brief; the plan's output section says `CORCH-01-01-SUMMARY.md`). `CORCH-01-PLAN.md`, `CORCH-01-SUMMARY-W1.md` and this file are left UNCOMMITTED: they are not in the plan's `files_modified`, so committing them would break DoD #12's path fence. `.planning/STATE.md`, ROADMAP.md and REQUIREMENTS.md were not touched (PTYCAP-owned; plan do_not_touch), so no STATE/ROADMAP/requirements bookkeeping was run.
11. A repo edit-counter hook blocked the 7th edit of dispatcher.ts in one batch; the edit was re-applied once after the counter reset (no looping, no content change).

## Known Stubs

None that block the goal. The three provider seams are intentional fail-closed defaults (documented in docs/corch.md): `DEFAULT_QUOTA_PROVIDER` (replaced by CORCH-02), `DEFAULT_WORKSPACE` and `DEFAULT_PR_LOOKUP` (replaced by CORCH-09).

## Threat Flags

None beyond the plan's threat model. New trust-boundary surface is exactly the six routes and two WS hooks the plan names; the ext route requires the EXPLICIT `ext:corch` scope and an enrolled, enabled, accept_external project, with 403 before any write.

## BLOCKED items

None. Open items for the orchestrator: (a) pre-existing test-isolation leaks tracked by AAF 34245069 and 1381858d; (b) `/qc` and the PR are the orchestrator's step; branch is not pushed.

## Self-Check: PASSED

- 7 commits on `origin/main..HEAD` (`git rev-list --count`): d241c44, f1a5fcc, 1448493, 38a4eea, 6818960, a76ec72, 87ee8ec.
- Created files exist: hub/src/corch/reconciler.ts, hub/test/corch-flag-off.test.ts, hub/test/corch-no-polling-guard.test.ts, docs/corch.md.
- Every DoD item has a recorded command and exit code above; the working tree has only the two planning files plus this summary untracked.

## QC round 1 fixes

Source: QC-CODEX.md (CONTENT BLOCK: 2 HIGH, 4 MED) and QC-CLAUDE.md (MED 1, MED 2, LOW 3). Method: regression tests
written first (commit 31480f2, 24 red / 42 green at that point), then the smallest fix per group. Fix commits are
per finding group; Claude MED 1 and MED 2 share one commit because both live in the same `evaluateUser` catch.
All 9 findings were real defects confirmed by a failing test; none was declined. The Postgres e2e coverage is
commit 5c7cbd7 (6 cases, 27 pass with a DB).

| Finding | Real? | Test(s) | Fix commit |
|---|---|---|---|
| Codex 1 HIGH: reclaimed/ended run can still send (grace callback, queued waiter) | real | unit `C1: an ended run never sends` (3: gates refuse `corch_run_not_live`, parked replay dropped, `markDispatched` throws); e2e `C1: a reclaimed run can no longer send` | 6eefb9e |
| Codex 2 HIGH: null `supervisor_id` treats another supervisor's inventory as absence | real | unit `without a supervisor id another supervisor inventory is never proof of absence` + `...LISTS the session is positive proof of life` (replaces the old union test that encoded the defect) | 45f6f32 |
| Codex 3 MED: concurrent `not_before` rearm loses the only timer | real | unit `C3: an older, slower query that returns null cannot cancel the timer a newer query armed` | 0330b64 |
| Codex 4 MED: stalled runs starve the reconciler beyond the first 100 | real (store.ts ORDER BY heartbeat_at; `markStalled` never moves the heartbeat) | unit `C4: 150 stalled-forever runs`; e2e `C4: liveRunsPage walks live runs in stable id order` | 209e5c6 |
| Codex 5 MED: `session_busy` drop bypasses attempts/backoff | real (pipeline.ts:298 calls `markSkipped(token,'session_busy')` before returning `dropped_busy`) | unit `C5: the real pipeline order...`; e2e `C5: ... ONE attempt with a 60s backoff` | 4aa8caf |
| Codex 6 MED: boot does not evaluate already-due backlog | real | unit `C6: startCorchWith evaluates due users once` + flag-OFF case; e2e `C6: boot evaluates backlog whose not_before already passed` | f064f6c |
| Claude MED 1: a throw in launch/`markRunLaunched` leaves the run live | real | unit `Claude MED 1` (2: throwing `checkGates`, throwing `markRunLaunched`); e2e `MED 1` | ce361f6 |
| Claude MED 2: workspace/orphan failures loop forever without escalation | real | unit `Claude MED 2` (2) + changed orphan test; e2e `MED 2` (third attempt blocks, one notification) | ce361f6 |
| Claude LOW 3: non-UUID project id on PATCH returns 500 | real | routes `PATCH ... non-UUID id` | 48dde42 |

Design decisions, stated so the owner can overrule them:

- C1 is enforced at three points rather than one: the gate list (covers a promoted queued waiter, which re-runs
  the full gate list), the parked replay closure, and `markDispatched` (the conditional `UPDATE ... ended_at IS NULL`
  immediately before the send, so a reclaim racing the gates still stops the send). Plan LD-13's "else the union of
  the user's fresh inventories" was the defect in Codex 2; the union can now only prove a run alive, never gone.
  A run with no `supervisor_id` that is not listed anywhere therefore stalls (one owner notification) rather than
  being reclaimed; it is released when its session appears in a fresh inventory or an operator ends it.
- C4: the store method was renamed `liveRunsOldestHeartbeat(limit)` -> `liveRunsPage(afterId, limit)` and ordered by
  `id`. Oldest-heartbeat ordering cannot be paged without fabricating liveness for stalled runs.
- Claude MED 2: `claim_orphaned` now consumes an attempt (plan LD-13 said none). A hub restart inside the
  claim-to-attach window therefore burns one attempt of three; that was accepted over an unbounded loop. A Workspace
  that RETURNS `{ok:false}` (the CORCH-01 fail-closed default `workspace_unavailable`) is still a no-attempt,
  event-driven refusal (LD-7/LD-11) so a default install does not block every item.
- Not changed (out of the requested set): Claude LOW 4 (cross-project `enqueueWorkItem` conflict), LOW 5
  (supervisor_closed reconnect, spec-sanctioned, CORCH-09), LOW 6 (skip count note), LOW 7 (enqueue cap).

### Re-run results (REMO_E2E_DB_URL=postgres://remo@127.0.0.1:55432/remo_ci, per-file isolation)

| Check | Result |
|---|---|
| Six corch unit files (boot-assert 10, flag-off 4, gates 53, no-polling-guard 2, prompt 3, routes 13) | 85 pass, 0 fail |
| corch e2e (`hub/test/e2e/corch-dispatcher.e2e.test.ts`) | 27 pass, 0 fail (21 before + 6 new) |
| `bun run orchestrator:e2e` | 95 pass, 0 fail, 14 files |
| Guard files, each its own process: kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, session-start-senders-guard 13, launch-machine-guard 8, reserve-caller-guard 7, mount-order 24, api-keys-scopes 32, heal-single-seam 26, pty-door-guard 22, orchestrator-macro-path-guard 5, corch-no-polling-guard 2 | all 0 fail; no guard weakened, none edited |
| `bun run check-baseline` | OK: pass=3640 skip=322 fail=0 total=3962. Measured skip delta +6 = exactly the 6 new DB-gated e2e cases; `skip_max` 316 -> 322 with a note (commit 9aea1be) |
| `bun run docs:sync` + `git diff --exit-code -- docs/openapi.json docs/api.md` | clean (no route/schema change) |
| `bun run typecheck` (hub) | 253 errors (limit 253), 0 in corch files |

Hard limits held: flags default OFF (flag-OFF proof `corch-flag-off` still 4 pass); no DDL change; no edits under
`hub/src/orchestrator/**` or PTYCAP code; no guard test weakened; no push.

## QC round 2 fix

Source: QC-CODEX-R2.md (CONTENT BLOCK, one residual HIGH: Codex 1, reclaim vs send). After `markRunRunning` succeeded the
pipeline still awaits `finalHaltCheck`, and the sender awaits the channel lookup and the message insert, so a concurrent
`reclaimRun` could end the run and the send still went out.

- **Test first** (`hub/test/e2e/corch-dispatcher.e2e.test.ts`, "QC round 2 fixes on real Postgres" ->
  `R2-1: a reclaim landing after markRunRunning stops the send (zero ws sends, zero message rows); without one the real
  send goes out`): the REAL `dispatch()` (queue, 8 gates, preSendGuard, finalHaltCheck), the REAL production send wiring
  (`realCorchDeps().pipeline.send`, real `messages` insert) and a fake agent socket in the real ws registry; the only
  injected piece is a deferred that pauses the run right after `markRunRunning` succeeds. A control run proves the harness
  really sends (1 ws send, 1 message row). **Red on ad5c461:** `expect(raced.sent.length).toBe(0)` received 1. **Green** with the fix.
- **Fix** (`hub/src/corch/dispatcher.ts` only; no shared dispatch/heal file touched): a per-run in-memory cancellation token
  (`sendable` set owned by the dispatcher, exposed to the send seam as a `SendGuard`). `reclaimRun`, `refuseRun`
  (all refusals), `endFailure` and `handleRunEnd` drop the run synchronously BEFORE their first await. The new
  `PipelineSeams.send(req, guard)` seam is implemented by `corchSend` -> `sendUserMessage` with `guardSendDeps`: the guard is
  asserted immediately before `insertMessage` and immediately before `ws.send` (no await between check and write), plus at
  the top of the pipeline `send`. A cancelled send throws `corch_run_not_live`; the pipeline's own failure path then
  releases the reservation and its `markFailed` is a no-op on the already ended run (attempts counted once, asserted).
  Tokens exist only while a run is live (added when its pipeline is built, removed on every end path), so the set is
  bounded by the runs this process owns.
- Residual, stated: a message row inserted before the cancel stays (history, not a send); only the ws write and any later
  insert are stopped. A run ended by something outside this process's corch paths (an operator UPDATE) leaves one
  string in the set until the process restarts.
- Extra DB-free unit cases (`corch-gates` "QC round 2 - R2-1", 3): cancel during channel lookup stops insert and write;
  cancel during insert stops the write; `reclaimRun` flips the token before its first await and it stays gone.

| Check | Result |
|---|---|
| Six corch unit files (boot-assert 10, flag-off 4, gates 56, no-polling-guard 2, prompt 3, routes 13) | 88 pass, 0 fail |
| corch e2e | 28 pass, 0 fail (27 + R2-1) |
| `bun run orchestrator:e2e` (REMO_E2E_DB_URL=postgres://remo@127.0.0.1:55432/remo_ci) | 96 pass, 0 fail, 14 files |
| 13 guard files, each its own process (kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, session-start-senders-guard 13, launch-machine-guard 8, reserve-caller-guard 7, mount-order 24, api-keys-scopes 32, heal-single-seam 26, pty-door-guard 22, orchestrator-macro-path-guard 5, corch-no-polling-guard 2) | all 0 fail; none edited |
| `bun run check-baseline` | OK: pass=3643 skip=323 fail=0 total=3966; `skip_max` 322 -> 323 = exactly the one new DB-gated e2e case (note in the baseline file) |
| `bun run docs:sync` + `git diff --exit-code -- docs/openapi.json docs/api.md` | clean |
| `bun run typecheck` (hub) | 253 errors (limit 253), 0 in corch files |

Commits: fix 325fcf1, e2e test f748708, baseline + docs + summary in the follow-up commit. Hard limits held: flags OFF, no DDL,
no edits under `hub/src/orchestrator/**`, no guard weakened, no push.

## 7c panel fix

Source: QC-CODEX-R3.md (CONTENT BLOCK at 317408d: HIGH hook-ownership corruption, MED await between insert guard and
insert) and the locked FIX SPEC in PANEL-7C.md (Claude + Codex + agy, verdict SOLVED).

- **Tests first** (commit 3760266, red on HEAD 317408d, for the stated reasons):
  - `hub/test/dispatch-release-closed-run.test.ts` "7c panel: a send that fails after its hook was released never touches
    the successor": A paused in send, B queued, `releaseClosedRunByToken(A)` promotes B, A's send then rejects. Red:
    `expect(failed).toEqual([])` received `[{token:'a', error:'corch_run_not_live'}]` (the old catch deleted the session's
    current hook and released the slot B held). Green: B hook still armed, in-flight == B, a third dispatch queues behind B,
    `onSessionReply` finalizes B and promotes C.
  - `hub/test/corch-gates.test.ts` "7c panel: corchSend resolves the DAL BEFORE the insert guard": injected deferred DAL
    loader, cancel during the load, resolve. Red: `resolveDal` null (the DAL load was not the first await; the real
    `insertMessage` awaited its own import after the guard). Green: rejects `corch_run_not_live`, 0 inserts, 0 ws sends.
    Plus a live-run control (1 insert, 1 frame).
- **Fix** (commit 1d22b84): `hub/src/dispatch/pipeline.ts` `dispatch()` step 5 hoists the hook into a local, and in the send
  `catch` and the finalHaltCheck-refusal branch only the owner (`activeBySession.get(sessionId) === hook`) deletes the hook,
  marks failed/skipped and calls `releaseAndPromote`; `releaseInject` stays token-scoped. `hub/src/corch/dispatcher.ts`
  `corchSend` resolves the DAL (optional injectable `loadDal`, `base` now `Partial<SendDeps>`) before `guardSendDeps`, so
  the guard is followed by a synchronous call into the resolved `insertMessage`. `heal/sinks/shared.ts` and
  `REAL_SEND_DEPS` untouched. For non-corch callers behaviour is identical except the racy corner where the hook was
  already released while the send awaited (the old code double-released a slot, a latent bug now fixed); no flag.
- **Spec item 4 confirmed, no change needed:** an `endFailure('dispatch_failed')` for an already-ended run is a no-op:
  `store.endRunAndRequeue` is `UPDATE corch_runs ... WHERE ended_at IS NULL` and returns `{changed:false}`, and
  `endFailure` returns on `!r.changed`. With the ownership check the non-owner path no longer calls `markFailed` anyway.

| Check | Result |
|---|---|
| Six corch unit files (boot-assert 10, flag-off 4, gates 58, no-polling-guard 2, prompt 3, routes 13) | 90 pass, 0 fail |
| corch e2e (REMO_E2E_DB_URL=postgres://remo@127.0.0.1:55432/remo_ci) | 28 pass, 0 fail |
| `bun run orchestrator:e2e` (same DB) | 96 pass, 0 fail, 14 files |
| dispatch/pipeline tests, each own process (final-halt 13, pipeline 37, queue-depth 9, release-closed-run 9, reserve 9, untrusted 11, dispatcher-disabled-guard 3, error-capture 1, revanote-batch 41, revanote 17, scheduler 11, telegram 6) | all 0 fail |
| 13 guard files, each own process (kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, session-start-senders-guard 13, launch-machine-guard 8, reserve-caller-guard 7, mount-order 24, api-keys-scopes 32, heal-single-seam 26, pty-door-guard 22, orchestrator-macro-path-guard 5, corch-no-polling-guard 2) | all 0 fail; none edited |
| `bun run check-baseline` (floor config, no DB) | OK: pass=3646 skip=323 fail=0 total=3969; `skip_max` unchanged at 323 because the new tests are DB-free (new DB-gated count = 0); the informational `pass`/`total` fields in the baseline file were not edited |
| `bun run docs:sync` | clean (no diff in docs/openapi.json, docs/api.md) |
| `bun run typecheck` (hub) | 253 errors (limit 253), 0 in corch/dispatch files |

Note: `check-baseline` run with REMO_E2E_DB_URL exported shows 28 failures in DB-gated files under per-file isolation; the
baseline gate is defined for the floor (no-DB) configuration, which is green. Not investigated further (outside this fix).

Hard limits held: no DDL change; no edits under `hub/src/orchestrator/**` or `heal/sinks/shared.ts`; no test weakened; no
push; flags OFF.
