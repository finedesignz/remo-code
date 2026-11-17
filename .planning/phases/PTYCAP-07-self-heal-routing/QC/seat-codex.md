codex
1. **CRITICAL — Coolify failures bypass unified routing when a live session exists and leave the run pending.**  
   [coolify-webhook.ts:391](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:391), [coolify-webhook.ts:417](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:417)

   Evidence: failed deployments are inserted as `pending`, but the existing active-session suppression branch exits without calling `dispatchTriage()` or terminalizing the row. With `REMO_HEAL_UNIFIED=ON`, this defeats live-session-first routing and strands the metadata run until another cleanup mechanism intervenes. The incident-replay test calls `dispatchTriage()` directly, bypassing the webhook branch it claims to cover: [heal-incident-replay.e2e.test.ts:222](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/e2e/heal-incident-replay.e2e.test.ts:222).

   Fix: when unified healing is enabled, send every failed deployment through `dispatchTriage()`/`routeHeal()` and let routing select the live session. Retain active-session suppression only in the flag-off legacy branch. Add an HTTP-level test with a live repo session and assert the metadata run becomes terminal.

2. **MAJOR — A successful pre-launch reservation can block its own post-spawn dispatch at the lifetime-cap boundary.**  
   [route.ts:286](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:286), [route.ts:338](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:338), [automation-controls.ts:289](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:289)

   Evidence: with `cap - 1` reservations, pre-launch gates pass and `reserveInject()` creates the cap-th reservation. After spawning, `dispatch()` reruns `automationLifetimeCounterGate`, which sees `n >= cap` and refuses before the token-idempotent reservation path can run. A session is therefore spawned but never receives the heal prompt. The autospawn tests substitute a fake `deps.dispatch`, so they never exercise this interaction: [heal-route-autospawn.test.ts:357](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-route-autospawn.test.ts:357).

   Fix: make the lifetime gate recognize an existing active reservation for the same token, or introduce an explicitly pre-reserved dispatch mode that reruns every other gate while reusing the reservation idempotently.

3. **MAJOR — Scheduled-task failures can produce two owner notifications.**  
   [route.ts:144](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:144), [scheduled-task.ts:75](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:75), [dispatcher.ts:812](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:812)

   Evidence: `finalizeNonLive()` claims and attempts a heal notification for every refused/failed outcome, but exposes `notified` only for `no_routable_session`. Consequently, refused or failed heals return `false` from `healFailedScheduledRun()`, and the scheduler also sends its default failure email. Even for `no_routable_session`, a failed heal send returns `notified:false` after consuming the claim, causing another default-email attempt.

   Fix: return notification ownership separately from delivery success—e.g. `{ claimed, sent }`—for every terminal outcome. Suppress the scheduler notification whenever the heal path won ownership, regardless of send result.

4. **MAJOR — Error-capture keeps its legacy notifier inside the unified path, causing duplicate notifications.**  
   [error-capture/dispatcher.ts:96](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:96), [error-capture/dispatcher.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:136), [heal/sinks/error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46)

   Evidence: unified routing reuses `buildErrorCaptureRunStore()`, whose `session_busy` and send-failure paths call `notifyThrottled()`. The route then calls its own `notifyOnce()` for the same refused/failed outcome. These use independent claims, so both can send. The sink test explicitly preserves the legacy notification but never runs the route notifier: [heal-sinks-error-feedback.test.ts:131](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-sinks-error-feedback.test.ts:131).

   Fix: build the unified error-capture sink with notifications disabled, leaving `routeHeal()` as the sole notification owner.

5. **MAJOR — `only_if_active` suppresses genuine scheduled-task failures, not merely reaper-finalized runs.**  
   [scheduled-task.ts:80](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:80), [dispatcher.ts:771](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:771)

   Evidence: after `updateRunStatus()` successfully claims the terminal transition, the hook still passes `only_if_active` to the source, which rejects every such failure. `only_if_active` is a CAS mechanism, not a reaper marker. Real task failures use it—for example missing work payload/site and dispatch failure at [work.ts:35](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/senders/work.ts:35), and TEAB terminal results at [teab.ts:235](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/senders/teab.ts:235). The test incorrectly equates all conditional finalizations with “reaper/TEAB”: [heal-source-scheduled-task.test.ts:328](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-source-scheduled-task.test.ts:328).

   Fix: pass an explicit reaper/origin marker. Invoke healing after any successful real failed transition; exclude only `run_timeout` or an explicit reaper origin.

6. **MAJOR — Boot recovery cannot reconstruct error-capture events and therefore leaks their reservations.**  
   [sweep.ts:47](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:47), [sweep.ts:87](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:87), [error-capture.ts:32](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:32)

   Evidence: the sweep reconstructs every event with `ctx: {}` and no `bound_session_id`. The error-capture sink requires both the binding and `error_id`/`project_id`, so sink construction throws before the reservation-release call. The row is retried on every boot while its error run and lifetime reservation remain stranded. `heal_events` stores none of this source context: [schema.sql:1669](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/schema.sql:1669). Sweep tests use only synthetic Coolify rows and a permissive fake sink: [heal-sweep.test.ts:25](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-sweep.test.ts:25).

   Fix: persist the minimal validated source context needed for recovery, reconstruct the bound event correctly, and release the reservation in a `finally` block even if source terminalization fails.

7. **MAJOR — A process crash between reservation and outcome persistence permanently strands the lifetime slot.**  
   [governed-launch.ts:150](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/governed-launch.ts:150), [route.ts:336](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:336), [heal-events-dal.ts:241](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:241)

   Evidence: `governedLaunch()` reserves, writes its launch ledger, and starts the session before `route.ts` records `autospawn_launched`. A crash in that window leaves the heal event with a null outcome. The boot sweep selects only `autospawn_launched` and `autospawn_parked`, while unreleased lifetime rows have no time-based expiry.

   Fix: persist a recoverable `autospawn_starting` state before reservation/launch, include it in boot reconciliation, and reconcile its reservation token regardless of whether the actual launch completed.

8. **MAJOR — Per-repository and per-task rate ceilings are non-atomic and can be exceeded concurrently.**  
   [route.ts:421](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:421), [scheduled-task.ts:102](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:102), [heal-events-dal.ts:210](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:210)

   Evidence: both limits are implemented as separate `SELECT count(*)` checks. Distinct dedupe keys acquire distinct claim locks, and no repository/task lock spans the count through dispatch-state persistence. Multiple requests can all observe `cap - 1` and proceed. Existing tests exercise sequential mocked counts, not concurrent claims.

   Fix: reserve repository-hour and task-day capacity atomically under advisory locks or dedicated counter rows in the claim transaction. Add concurrent database tests using distinct dedupe keys.

Focused Bun tests could not start in the read-only sandbox because workspace access returned `EPERM`; the findings above are based on production-path and test-path inspection.

## FINAL VERDICT: CONTENT-BLOCK

The live Coolify source bypass and pending-run defect blocks the primary acceptance path. The reservation, notification-ownership, recovery, and concurrency defects are also release-blocking safety failures.


318,294
1. **CRITICAL — Coolify failures bypass unified routing when a live session exists and leave the run pending.**  
   [coolify-webhook.ts:391](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:391), [coolify-webhook.ts:417](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:417)

   Evidence: failed deployments are inserted as `pending`, but the existing active-session suppression branch exits without calling `dispatchTriage()` or terminalizing the row. With `REMO_HEAL_UNIFIED=ON`, this defeats live-session-first routing and strands the metadata run until another cleanup mechanism intervenes. The incident-replay test calls `dispatchTriage()` directly, bypassing the webhook branch it claims to cover: [heal-incident-replay.e2e.test.ts:222](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/e2e/heal-incident-replay.e2e.test.ts:222).

   Fix: when unified healing is enabled, send every failed deployment through `dispatchTriage()`/`routeHeal()` and let routing select the live session. Retain active-session suppression only in the flag-off legacy branch. Add an HTTP-level test with a live repo session and assert the metadata run becomes terminal.

2. **MAJOR — A successful pre-launch reservation can block its own post-spawn dispatch at the lifetime-cap boundary.**  
   [route.ts:286](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:286), [route.ts:338](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:338), [automation-controls.ts:289](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:289)

   Evidence: with `cap - 1` reservations, pre-launch gates pass and `reserveInject()` creates the cap-th reservation. After spawning, `dispatch()` reruns `automationLifetimeCounterGate`, which sees `n >= cap` and refuses before the token-idempotent reservation path can run. A session is therefore spawned but never receives the heal prompt. The autospawn tests substitute a fake `deps.dispatch`, so they never exercise this interaction: [heal-route-autospawn.test.ts:357](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-route-autospawn.test.ts:357).

   Fix: make the lifetime gate recognize an existing active reservation for the same token, or introduce an explicitly pre-reserved dispatch mode that reruns every other gate while reusing the reservation idempotently.

3. **MAJOR — Scheduled-task failures can produce two owner notifications.**  
   [route.ts:144](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:144), [scheduled-task.ts:75](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:75), [dispatcher.ts:812](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:812)

   Evidence: `finalizeNonLive()` claims and attempts a heal notification for every refused/failed outcome, but exposes `notified` only for `no_routable_session`. Consequently, refused or failed heals return `false` from `healFailedScheduledRun()`, and the scheduler also sends its default failure email. Even for `no_routable_session`, a failed heal send returns `notified:false` after consuming the claim, causing another default-email attempt.

   Fix: return notification ownership separately from delivery success—e.g. `{ claimed, sent }`—for every terminal outcome. Suppress the scheduler notification whenever the heal path won ownership, regardless of send result.

4. **MAJOR — Error-capture keeps its legacy notifier inside the unified path, causing duplicate notifications.**  
   [error-capture/dispatcher.ts:96](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:96), [error-capture/dispatcher.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:136), [heal/sinks/error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46)

   Evidence: unified routing reuses `buildErrorCaptureRunStore()`, whose `session_busy` and send-failure paths call `notifyThrottled()`. The route then calls its own `notifyOnce()` for the same refused/failed outcome. These use independent claims, so both can send. The sink test explicitly preserves the legacy notification but never runs the route notifier: [heal-sinks-error-feedback.test.ts:131](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-sinks-error-feedback.test.ts:131).

   Fix: build the unified error-capture sink with notifications disabled, leaving `routeHeal()` as the sole notification owner.

5. **MAJOR — `only_if_active` suppresses genuine scheduled-task failures, not merely reaper-finalized runs.**  
   [scheduled-task.ts:80](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:80), [dispatcher.ts:771](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:771)

   Evidence: after `updateRunStatus()` successfully claims the terminal transition, the hook still passes `only_if_active` to the source, which rejects every such failure. `only_if_active` is a CAS mechanism, not a reaper marker. Real task failures use it—for example missing work payload/site and dispatch failure at [work.ts:35](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/senders/work.ts:35), and TEAB terminal results at [teab.ts:235](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/senders/teab.ts:235). The test incorrectly equates all conditional finalizations with “reaper/TEAB”: [heal-source-scheduled-task.test.ts:328](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-source-scheduled-task.test.ts:328).

   Fix: pass an explicit reaper/origin marker. Invoke healing after any successful real failed transition; exclude only `run_timeout` or an explicit reaper origin.

6. **MAJOR — Boot recovery cannot reconstruct error-capture events and therefore leaks their reservations.**  
   [sweep.ts:47](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:47), [sweep.ts:87](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:87), [error-capture.ts:32](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:32)

   Evidence: the sweep reconstructs every event with `ctx: {}` and no `bound_session_id`. The error-capture sink requires both the binding and `error_id`/`project_id`, so sink construction throws before the reservation-release call. The row is retried on every boot while its error run and lifetime reservation remain stranded. `heal_events` stores none of this source context: [schema.sql:1669](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/schema.sql:1669). Sweep tests use only synthetic Coolify rows and a permissive fake sink: [heal-sweep.test.ts:25](C:/Users/artic/GitHub/remo-code-ptycap07/hub/test/heal-sweep.test.ts:25).

   Fix: persist the minimal validated source context needed for recovery, reconstruct the bound event correctly, and release the reservation in a `finally` block even if source terminalization fails.

7. **MAJOR — A process crash between reservation and outcome persistence permanently strands the lifetime slot.**  
   [governed-launch.ts:150](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/governed-launch.ts:150), [route.ts:336](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:336), [heal-events-dal.ts:241](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:241)

   Evidence: `governedLaunch()` reserves, writes its launch ledger, and starts the session before `route.ts` records `autospawn_launched`. A crash in that window leaves the heal event with a null outcome. The boot sweep selects only `autospawn_launched` and `autospawn_parked`, while unreleased lifetime rows have no time-based expiry.

   Fix: persist a recoverable `autospawn_starting` state before reservation/launch, include it in boot reconciliation, and reconcile its reservation token regardless of whether the actual launch completed.

8. **MAJOR — Per-repository and per-task rate ceilings are non-atomic and can be exceeded concurrently.**  
   [route.ts:421](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:421), [scheduled-task.ts:102](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:102), [heal-events-dal.ts:210](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:210)

   Evidence: both limits are implemented as separate `SELECT count(*)` checks. Distinct dedupe keys acquire distinct claim locks, and no repository/task lock spans the count through dispatch-state persistence. Multiple requests can all observe `cap - 1` and proceed. Existing tests exercise sequential mocked counts, not concurrent claims.

   Fix: reserve repository-hour and task-day capacity atomically under advisory locks or dedicated counter rows in the claim transaction. Add concurrent database tests using distinct dedupe keys.

Focused Bun tests could not start in the read-only sandbox because workspace access returned `EPERM`; the findings above are based on production-path and test-path inspection.

## FINAL VERDICT: CONTENT-BLOCK

The live Coolify source bypass and pending-run defect blocks the primary acceptance path. The reservation, notification-ownership, recovery, and concurrency defects are also release-blocking safety failures.


