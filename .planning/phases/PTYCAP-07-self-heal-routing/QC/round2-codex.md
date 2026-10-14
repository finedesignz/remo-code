codex
## Round-1 findings

1. **FIXED — Coolify live-session bypass.** Unified mode bypasses legacy suppression and always calls `dispatchTriage`; flag-OFF retains suppression. Evidence: [coolify-webhook.ts:425](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:425), [coolify-webhook.ts:441](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:441).

2. **FIXED — Own lifetime reservation blocked post-spawn dispatch.** At the cap, the gate now accepts the same active `(counter_key, token)` reservation while rejecting other or released tokens. Evidence: [automation-controls.ts:295](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:295).

3. **FIXED — Scheduled-task double notification on ordinary refused/failed paths.** `notifyOnceDetailed` separates ownership from delivery, `routeHeal` returns `notifyClaimed`, and the scheduler suppresses its default email when ownership was claimed. Evidence: [route.ts:163](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:163), [scheduled-task.ts:127](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:127), [dispatcher.ts:812](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:812). A new exceptional double-notification path remains below.

4. **FIXED — Error-capture synchronous duplicate notification.** The unified sink disables the independent legacy notifier, leaving immediate route failures to `routeHeal`. Evidence: [error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46), [dispatcher.ts:103](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:103). This creates a new deferred-failure gap below.

5. **FIXED — `only_if_active` suppressed genuine failures.** Only the reaper’s `run_timeout` marker is excluded; successful conditional terminal transitions now enter healing. Evidence: [scheduled-task.ts:85](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:85), [dispatcher.ts:780](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:780).

6. **FIXED — Sweep could not reconstruct error-capture events.** Minimal recovery context is persisted, and the sweep restores both it and the bound session. Evidence: [heal-events-dal.ts:188](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:188), [sweep.ts:61](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:61).

7. **FIXED — Crash between reservation and outcome persistence.** `autospawn_starting` is written before gates/reservation/launch and included in stale recovery. Evidence: [route.ts:308](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:308), [heal-events-dal.ts:286](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:286).

8. **FIXED — Non-atomic repo/task ceilings.** The per-user transaction advisory lock now covers task/repository counts through insertion. Evidence: [heal-events-dal.ts:155](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:155), [heal-events-dal.ts:162](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:162), [heal-events-dal.ts:173](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:173).

## New defects

1. **MAJOR — Permission-safe heal spawn is bypassed for orchestrator sessions.**  
   [governed-launch.ts:177](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/governed-launch.ts:177), [telegram/launch.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/telegram/launch.ts:136), [auto-launch.ts:275](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/orchestrator/auto-launch.ts:275), [auto-launch.ts:302](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/orchestrator/auto-launch.ts:302)

   `governedLaunch` passes `skipPermissions:false`, but `launchSessionForUser`’s orchestrator branch does not forward it. `launchOrchestrator` reloads the persisted setting and can therefore send `dangerously_skip_permissions:true` for an untrusted heal-triggered spawn.

   **Fix:** add and forward `skipPermissions?: false` through `launchOrchestrator`, and force false before its `session.start`. Test an offline orchestrator session whose stored setting is true.

2. **MAJOR — Production reservation release failures are swallowed, defeating sweep retry and permanently leaking slots.**  
   [automation-controls.ts:439](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:439), [route.ts:244](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:244), [route.ts:258](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:258), [sweep.ts:113](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:113)

   The sweep assumes `release()` throws so the row remains retryable, but the real `releaseInject` catches every SQL error and resolves successfully. Route expiry also catches release errors and then writes a terminal outcome. A failed UPDATE can therefore leave an active lifetime reservation while removing the event from every future sweep.

   **Fix:** provide a strict release operation that throws or returns confirmed success. Persist a retryable `release_pending` state and do not replace recoverable launch outcomes until release is confirmed.

3. **MAJOR — Sweep closes the heal event after source terminalization fails, leaving the source run pending.**  
   [sweep.ts:102](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:102), [sweep.ts:115](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:115), [heal-events-dal.ts:294](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:294)

   Any `makeSink` or `finalizeTerminal` failure is recorded locally, but the code still changes the outcome to `failed:spawn_timeout`. That row is no longer selected, so a transient error can leave the error-capture or Coolify metadata run pending until the unrelated long-duration reaper.

   **Fix:** separate reservation reconciliation from source terminalization. Keep a retryable source-terminalization state until the sink succeeds; releasing the reservation must not discard that retry obligation.

4. **MAJOR — Deferred error-capture failures can now produce zero owner notifications.**  
   [route.ts:481](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:481), [error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46), [dispatcher.ts:143](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:143)

   `queued` is immediately persisted as `dispatched_live`, so `routeHeal` returns without notification ownership. If the promoted request later fails to send, `markFailed` runs asynchronously—but its notifier is disabled. The original duplicate is gone by dropping both notification paths for this case.

   **Fix:** make deferred sink failures call the shared heal-event notification claim, keyed by `eventId`. Do not restore the independent legacy throttle.

5. **MAJOR — A failed scheduled-task notification claim can still cause two emails.**  
   [route.ts:367](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:367), [route.ts:377](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:377), [scheduled-task.ts:127](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:127)

   When the launch-time ownership claim throws, the error is logged and ignored. The returned launch outcome makes the scheduler send its default failure email. If the parked heal subsequently expires after the database recovers, expiry can claim the still-unclaimed event and send a second email.

   **Fix:** make ownership persistence mandatory before returning a launched/parked scheduled-task outcome, or permanently suppress heal expiry notifications for scheduled-task events whose default notifier was selected.

6. **MINOR — The one-follow-up recovery handles at most 100 stranded rows.**  
   [heal-events-dal.ts:293](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:293), [sweep.ts:88](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:88), [sweep.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:136)

   Each pass is limited to 50 rows and only one follow-up is armed. In a multi-user restart with more than 100 stranded launches, the remainder are not revisited until another restart.

   **Fix:** page until the eligible set is drained, or re-arm bounded follow-ups while a full batch is returned.

Flag-OFF behavior remains preserved in the reviewed diff. No recursion regression or spawn-before-gates path was found. `git diff --check` passed; no files were modified and tests were not invoked in this read-only seat.

## FINAL VERDICT: CONTENT-BLOCK

The orchestrator permission bypass and non-retryable reservation/source-run recovery paths are release-blocking. The notification ownership fixes also remain incomplete for deferred and claim-failure paths.


182,874
## Round-1 findings

1. **FIXED — Coolify live-session bypass.** Unified mode bypasses legacy suppression and always calls `dispatchTriage`; flag-OFF retains suppression. Evidence: [coolify-webhook.ts:425](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:425), [coolify-webhook.ts:441](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/api/coolify-webhook.ts:441).

2. **FIXED — Own lifetime reservation blocked post-spawn dispatch.** At the cap, the gate now accepts the same active `(counter_key, token)` reservation while rejecting other or released tokens. Evidence: [automation-controls.ts:295](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:295).

3. **FIXED — Scheduled-task double notification on ordinary refused/failed paths.** `notifyOnceDetailed` separates ownership from delivery, `routeHeal` returns `notifyClaimed`, and the scheduler suppresses its default email when ownership was claimed. Evidence: [route.ts:163](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:163), [scheduled-task.ts:127](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:127), [dispatcher.ts:812](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:812). A new exceptional double-notification path remains below.

4. **FIXED — Error-capture synchronous duplicate notification.** The unified sink disables the independent legacy notifier, leaving immediate route failures to `routeHeal`. Evidence: [error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46), [dispatcher.ts:103](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:103). This creates a new deferred-failure gap below.

5. **FIXED — `only_if_active` suppressed genuine failures.** Only the reaper’s `run_timeout` marker is excluded; successful conditional terminal transitions now enter healing. Evidence: [scheduled-task.ts:85](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:85), [dispatcher.ts:780](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:780).

6. **FIXED — Sweep could not reconstruct error-capture events.** Minimal recovery context is persisted, and the sweep restores both it and the bound session. Evidence: [heal-events-dal.ts:188](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:188), [sweep.ts:61](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:61).

7. **FIXED — Crash between reservation and outcome persistence.** `autospawn_starting` is written before gates/reservation/launch and included in stale recovery. Evidence: [route.ts:308](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:308), [heal-events-dal.ts:286](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:286).

8. **FIXED — Non-atomic repo/task ceilings.** The per-user transaction advisory lock now covers task/repository counts through insertion. Evidence: [heal-events-dal.ts:155](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:155), [heal-events-dal.ts:162](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:162), [heal-events-dal.ts:173](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:173).

## New defects

1. **MAJOR — Permission-safe heal spawn is bypassed for orchestrator sessions.**  
   [governed-launch.ts:177](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/governed-launch.ts:177), [telegram/launch.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/telegram/launch.ts:136), [auto-launch.ts:275](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/orchestrator/auto-launch.ts:275), [auto-launch.ts:302](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/orchestrator/auto-launch.ts:302)

   `governedLaunch` passes `skipPermissions:false`, but `launchSessionForUser`’s orchestrator branch does not forward it. `launchOrchestrator` reloads the persisted setting and can therefore send `dangerously_skip_permissions:true` for an untrusted heal-triggered spawn.

   **Fix:** add and forward `skipPermissions?: false` through `launchOrchestrator`, and force false before its `session.start`. Test an offline orchestrator session whose stored setting is true.

2. **MAJOR — Production reservation release failures are swallowed, defeating sweep retry and permanently leaking slots.**  
   [automation-controls.ts:439](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/dispatch/automation-controls.ts:439), [route.ts:244](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:244), [route.ts:258](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:258), [sweep.ts:113](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:113)

   The sweep assumes `release()` throws so the row remains retryable, but the real `releaseInject` catches every SQL error and resolves successfully. Route expiry also catches release errors and then writes a terminal outcome. A failed UPDATE can therefore leave an active lifetime reservation while removing the event from every future sweep.

   **Fix:** provide a strict release operation that throws or returns confirmed success. Persist a retryable `release_pending` state and do not replace recoverable launch outcomes until release is confirmed.

3. **MAJOR — Sweep closes the heal event after source terminalization fails, leaving the source run pending.**  
   [sweep.ts:102](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:102), [sweep.ts:115](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:115), [heal-events-dal.ts:294](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:294)

   Any `makeSink` or `finalizeTerminal` failure is recorded locally, but the code still changes the outcome to `failed:spawn_timeout`. That row is no longer selected, so a transient error can leave the error-capture or Coolify metadata run pending until the unrelated long-duration reaper.

   **Fix:** separate reservation reconciliation from source terminalization. Keep a retryable source-terminalization state until the sink succeeds; releasing the reservation must not discard that retry obligation.

4. **MAJOR — Deferred error-capture failures can now produce zero owner notifications.**  
   [route.ts:481](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:481), [error-capture.ts:46](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sinks/error-capture.ts:46), [dispatcher.ts:143](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/error-capture/dispatcher.ts:143)

   `queued` is immediately persisted as `dispatched_live`, so `routeHeal` returns without notification ownership. If the promoted request later fails to send, `markFailed` runs asynchronously—but its notifier is disabled. The original duplicate is gone by dropping both notification paths for this case.

   **Fix:** make deferred sink failures call the shared heal-event notification claim, keyed by `eventId`. Do not restore the independent legacy throttle.

5. **MAJOR — A failed scheduled-task notification claim can still cause two emails.**  
   [route.ts:367](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:367), [route.ts:377](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/route.ts:377), [scheduled-task.ts:127](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sources/scheduled-task.ts:127)

   When the launch-time ownership claim throws, the error is logged and ignored. The returned launch outcome makes the scheduler send its default failure email. If the parked heal subsequently expires after the database recovers, expiry can claim the still-unclaimed event and send a second email.

   **Fix:** make ownership persistence mandatory before returning a launched/parked scheduled-task outcome, or permanently suppress heal expiry notifications for scheduled-task events whose default notifier was selected.

6. **MINOR — The one-follow-up recovery handles at most 100 stranded rows.**  
   [heal-events-dal.ts:293](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:293), [sweep.ts:88](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:88), [sweep.ts:136](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:136)

   Each pass is limited to 50 rows and only one follow-up is armed. In a multi-user restart with more than 100 stranded launches, the remainder are not revisited until another restart.

   **Fix:** page until the eligible set is drained, or re-arm bounded follow-ups while a full batch is returned.

Flag-OFF behavior remains preserved in the reviewed diff. No recursion regression or spawn-before-gates path was found. `git diff --check` passed; no files were modified and tests were not invoked in this read-only seat.

## FINAL VERDICT: CONTENT-BLOCK

The orchestrator permission bypass and non-retryable reservation/source-run recovery paths are release-blocking. The notification ownership fixes also remain incomplete for deferred and claim-failure paths.


