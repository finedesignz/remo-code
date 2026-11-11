# PTYCAP-07 QC fixes

## Round 1 fixes (A)

All four findings were verified in code and were real (none refuted). Each fix has a commit and a test run in its own process.

| Finding | Commit | Test | Result |
|---|---|---|---|
| codex #1 CRITICAL: Coolify failure with a live session bypassed routeHeal and left the run pending | f2ba619 | hub/test/heal-coolify-webhook-live-session.test.ts (HTTP-level; flag ON routes through routeHeal, flag OFF keeps legacy suppression); hub/test/coolify-webhook.test.ts unchanged and green | pass |
| codex #2: pre-launch lifetime reservation blocked its own post-spawn dispatch at the cap | e5eda18 | hub/test/automation-controls-core.test.ts (own active token passes at the cap; other token and released token still blocked) | pass |
| codex #3 + codex #4 + lens-correctness MAJOR 1: exactly one owner notification per heal event | aa8ec72 | hub/test/heal-notify.test.ts (notifyOnceDetailed claimed vs sent), heal-route-autospawn.test.ts (single owner across launch/expiry; ownership on refused/failed), heal-source-scheduled-task.test.ts (ownership table, finalizeRun suppression per outcome; the L212-213 test that enshrined the double email is replaced), heal-sinks-error-feedback.test.ts (unified sink sends no legacy notice; legacy store unchanged) | pass |
| codex #5: only_if_active suppressed genuine scheduled-task failures | 0cf6deb | hub/test/heal-source-scheduled-task.test.ts (genuine failure under only_if_active heals; run_timeout reaper finalize still excluded) | pass |

### Design notes

- Ownership = the heal_events notification_claimed_at conditional-UPDATE claim, not send success. Every refused / failed / no_routable_session outcome now carries `notifyClaimed`; the scheduler default failure email is suppressed whenever it is true, even if the one heal send failed.
- Non-claimed outcomes (dispatched_live, autospawn_launched/parked, deduped, early refusals with no ledger row) leave the scheduler default email as the single notification.
- scheduled_task launched/parked: routeHeal takes the claim (no send) on behalf of the scheduler default email, so a later spawn_timeout / grace_expired / boot-sweep notice loses the claim and cannot be a second notification.
- Error-capture: `buildErrorCaptureRunStore` gained `notify?: boolean` (default true = legacy flag-OFF unchanged); the unified sink passes `false`, making routeHeal the sole notifier.
- Lifetime gate: only at the cap, an unreleased (counter key, token) row passes, mirroring reserveInject idempotency. Other callers are unaffected (their token has no reservation before the gate runs).
- Reaper exclusion for heal is the `run_timeout` error (the reaper's sole marker); no change to reaper args (flag-OFF run-reaper tests stay exact).

### Guards re-run (each in its own process): green

heal-flag-off, heal-single-seam, token-cap-coverage, counter-key-assignment-guard, all heal-*.test.ts, self-heal-routing, error-capture-*, scheduler-run-reaper, stale-run-reaper, teab-poll, pty-preflight, governed-pty-gate, kill-switch-coverage, automation-tracer, scheduler-counter-keys, coolify-webhook.

### Not in part A

codex #6, #7, #8 and lens-correctness MAJOR 2 / MINORs, and lens-adversary findings are out of this part's scope.

## Round 1 fixes (B)

All five findings plus the PTY-gate MINOR were verified in code and were real (none refuted). Each test file was run in its own process.

| Finding | Commit | Test | Result |
|---|---|---|---|
| lens-adversary MAJOR: heal autospawn inherited the session dangerously_skip_permissions | d04bb6e | launch-run-leak.test.ts (frame false when session row true; default unchanged), governed-launch.test.ts (heal passes skipPermissions:false, legacy leaves it unset), heal-route-autospawn / heal-source-* launch assertions | pass |
| lens-adversary MINOR: no PTY gate in the heal gate list | 828b83c | heal-route-live.test.ts (pty-interactive at dispatch => automation_blocked_on_pty:self-heal, zero sends), token-cap-coverage.test.ts (7 gates, locked order) | pass |
| codex #7: crash between reservation and outcome strands the lifetime slot | d549c97 | heal-route-autospawn.test.ts (autospawn_starting persisted before gates/reserve/launch; write failure => nothing reserved or spawned), heal-events-dal.test.ts (stale list selects it) | pass |
| codex #8: per-repo and per-task ceilings non-atomic | d549c97 | heal-events-dal.test.ts (stateful fake with advisory-lock serialization: 8 concurrent distinct-key claims admit exactly the repo ceiling, 6 admit exactly the task ceiling), heal-route-guards.test.ts | pass |
| codex #6: sweep cannot rebuild error-capture events, leaks reservations | c36bed2 | heal-sweep.test.ts (error_capture rebuilt from recovery_ctx + session id; sink failure still releases and closes the row; release failure retries) | pass |
| lens-correctness MAJOR 2 (SC4): quick-restart rows never swept | c36bed2 | heal-sweep.test.ts (row stranded 20s before boot is missed at boot, swept by the single follow-up at 2x timeout + 1s; follow-up does not re-arm; flag OFF arms nothing) | pass |

### Design notes

- Skip-permissions: new skipPermissions?: false on launchSessionForUser; only governedLaunch's heal policy (preLaunch governor present) passes it. The call stays on one line with machine: true (launch-callers-guard regex).
- Atomicity needs no new lock: the claim already takes the per-user advisory lock before counting; the repo/task counts and the INSERT now sit under it. At the repo ceiling the row is inserted pre-refused (refused:repo_rate_bound, repoRateBound: true) so owner notification and sink terminalization are unchanged; at the task ceiling the claim is refused task_day_cap. HealDeps.countRepoDispatches and countRepoDispatchesLastHour were removed (dead). The source's early task pre-check stays as a cheap fast path; the claim is the authority.
- Sweep: recovery_ctx jsonb (additive, nullable, error_id/project_id only). The boot sweep keeps the 2x-timeout staleness guard (an age-0 boot sweep would race an old container's live timers during a rolling deploy) and instead arms one follow-up; every row stranded at or before boot is older than the guard by then.
- Not covered locally: the new DAL ceilings are proven against a stateful in-memory fake that models advisory-lock serialization, not a real Postgres (none available here); the DB-gated e2e suite (heal-events.e2e.test.ts) was not extended in this round.
- Guards green (own process): heal-flag-off, heal-single-seam, token-cap-coverage, counter-key-assignment-guard, kill-switch-coverage, reserve-caller-guard, launch-callers-guard, session-start-senders-guard, heal-schema, heal-types, heal-notify, heal-sinks-*, heal-source-*, heal-route-*.

## Round 2 fixes

All five new MAJORs were verified in code and were real (none refuted). Every new test was run against the pre-fix source and failed there, then passed with the fix. Each test file ran in its own process.

| Finding | Commit | Test | Result |
|---|---|---|---|
| codex NEW 1: orchestrator sessions bypassed the heal skip-permissions=false | e9b0cac | orchestrator-autolaunch-halt.test.ts (stored setting true + skipPermissions:false => frame false; default unchanged), launch-machine-guard.test.ts (forwarded to launchOrchestrator) | pass |
| codex NEW 2: release failures swallowed (slot leak, event hidden from the sweep) | b592a24 | automation-controls-core.test.ts (releaseInjectStrict rejects on DB failure, legacy releaseInject still swallows), heal-route-autospawn.test.ts (deadline / launch-refused / dispatch-throw with a failing release keep a recoverable outcome, no terminal write, no notice) | pass |
| codex NEW 3: sweep closed the event after source terminalization failed | b592a24 | heal-sweep.test.ts (sink failure: slot still released, row NOT closed; release failure: source still terminalized, row NOT closed; retry closes it once both confirmed) | pass |
| codex NEW 4: deferred error-capture failures produced zero notifications | fc17190 | heal-sinks-error-feedback.test.ts (deferred send failure and deferred skip each notify once via the per-event claim; later routeHeal notice loses the claim; no event id sends nothing) | pass |
| codex NEW 5: failed launch-time claim could yield two scheduled-task emails | b592a24 | heal-route-autospawn.test.ts (claim throws at launch, DB recovers: deadline and refused replay send NO heal email), heal-sweep.test.ts (scheduled_task row closed claim-only) | pass |
| sonnet MINOR 3: release() idempotent for rows that never reserved | b592a24 | automation-controls-core.test.ts (releaseInjectStrict on a never-reserved token resolves, no row touched) | pass |

### Design notes

- Release is split: `releaseInjectStrict` (throws) backs `REAL_AUTOSPAWN.release`; `releaseInject` (never throws) is unchanged for the pipeline / sessions / pty-preflight callers. A failed heal release returns `{failed, heal_release_pending}` and writes no terminal outcome; the row stays autospawn_starting/launched/parked and the boot sweep retries.
- Sweep: the source-run terminalization and the reservation release are independent obligations, both always attempted. The row is closed (failed:spawn_timeout + notice) only when both are confirmed; otherwise the same outcome is re-stamped (fresh updated_at, so a permanently failing row moves to the back of the 50-row batch instead of starving it).
- Scheduled-task ownership is deterministic: once the launch outcome is returned the scheduler default email is the sole owner, so every later heal finalizer (deadline, replay, sweep) is claim-only and never sends. A failed launch-time claim therefore cannot produce a second email. Residual: a hub crash in the few-ms window between the launched outcome and the scheduler email yields no email for that event.
- Not done: round2 codex MINOR 6 (the 100-row follow-up bound) and sonnet MINOR 1 (real-Postgres e2e for the ceilings) were out of the requested scope. Commits for fixes 2, 3, 5 and MINOR 3 are one commit because they share route.ts / sweep.ts hunks.
- Guards green (own process): heal-flag-off, heal-single-seam, token-cap-coverage, counter-key-assignment-guard, kill-switch-coverage, reserve-caller-guard, launch-callers-guard, governed-launch, heal-route-live, heal-route-guards, heal-source-scheduled-task, heal-notify, heal-types, heal-sinks-*.

## Type hygiene

`bunx tsc --noEmit -p hub/tsconfig.json`, errors in files changed by this phase (`git diff --name-only ec2237e..HEAD -- hub/`):

- Before fixes (HEAD): 19 pre-existing (same 19 at ec2237e, untouched) + 45 phase-introduced (heal/resolve, route, sinks/error-capture, sinks/shared, types x2, heal-* tests).
- After fixes: 19 (all pre-existing, identical to ec2237e). Phase-introduced: 0.
- Changes are type-only (interface return widening void -> unknown, `as` casts). Tests for touched sources pass per-file; check-baseline OK (fail=0).
