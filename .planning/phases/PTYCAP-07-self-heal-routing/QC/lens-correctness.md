# PTYCAP-07 QC - correctness + test-honesty lens

Range reviewed: ec2237e..HEAD (hub/, supervisor/, tools/). Static review plus reading of the source; DB-gated e2e not run locally.

VERDICT: CONTENT-BLOCK (2 MAJOR, 0 CRITICAL, 3 MINOR)

## 1. MAJOR - SC2 violated: refused/failed heal outcomes notify twice for scheduled-task failures

- Evidence:
  - hub/src/heal/route.ts `finalizeNonLive` (~L118-132) calls `notifyOnce` for EVERY non-live outcome (refused, failed, no_routable_session) but returns `notified` only on `no_routable_session`.
  - hub/src/heal/sources/scheduled-task.ts L121: `return 'notified' in outcome && outcome.notified === true;` so refused/failed always return false.
  - hub/src/scheduler/dispatcher.ts (`healFailedRunHook` -> `suppressDefaultFailureEmail` only when true) therefore does not suppress hub/src/scheduler/post-run/dispatcher.ts default failure email.
  - Result: refused:repo_rate_bound, refused:<gate reason>, failed:heal_route_error, failed:grace_expired / spawn_timeout each send the "[heal] ..." email AND the normal task-failure email.
  - hub/test/heal-source-scheduled-task.test.ts L212-213 enshrines it: `{kind:'refused'} -> false`, `{kind:'failed'} -> false`. The test asserts the defect rather than the SC. 07-08 SUMMARY "Residual" admits it and defers to 07-10/11, which did not fix it.
  - Also: autospawn_parked outcome returns false at call time (default email sent), then a later spawn_timeout/grace_expired expiry (route.ts `expire`) or the boot sweep sends a second heal email for the same failure.
- Fix: carry `notified: boolean` on every HealOutcome that passes through `finalizeNonLive` (types.ts + route.ts), return it from `healFailedScheduledRun`, and fix the test to expect true when the heal notice was sent. For the deferred autospawn expiry, decide a single owner: either suppress the default email for autospawn_parked/launched (heal owns it) or do not heal-notify on expiry for scheduled_task source.

## 2. MAJOR - boot sweep cannot reach rows stranded by the restart it runs after (SC4: heal runs can sit pending until 6h reaper)

- Evidence: hub/src/heal/sweep.ts `list(2 * healSpawnTimeoutMs())` with default spawn timeout 25s (config.ts L28) = rows older than 50s only. A row stranded by a restart has `updated_at` <= 25s before the crash plus downtime; with a typical Coolify restart under ~30s of downtime it is younger than 50s at boot. The sweep runs ONCE (hub/src/index.ts, no interval), so such a row is never swept (until a later boot), and the error_capture/coolify metadata run it owns stays pending to the 6h reaper. At boot there are no live process-local timers, so every autospawn_launched/autospawn_parked row is stranded by definition; the 2x age guard protects nothing.
- Fix: at boot sweep every row with outcome IN ('autospawn_launched','autospawn_parked') (age 0, still bounded by LIMIT 50 and looped until empty), or add a one-shot delayed re-sweep; add a unit test with a row aged 30s.

## 3. MINOR - false-positive provenance suppression via ancestry

- hub/src/db/heal-events-dal.ts `isHealGenerated` treats any ancestor run that is a `trigger_run_id` of a prior heal event as heal-generated. A chained task B (triggered_by_run_id = failed run A that was healed) that fails on its own is refused `heal_provenance` and gets no heal. Over-suppression only (safe direction), but it is silent. Narrow to dispatch_run_id/metadata_run_id ancestry, or document.

## 4. MINOR - heal ledger row survives a failed launch and still counts against the launch cap

- hub/src/dispatch/governed-launch.ts HEAL policy appends the autospawn-launch run-log row before the launch; on launch failure only the reservation is released, the row stays, so `countAutospawnLaunchesToday` over-counts failed launches (cap exhausts early). Conservative; document or write the row outcome as failed and exclude it from the count.

## 5. MINOR - SC2 exactly-once rests on tests that were not executed

- The concurrent claim, notification-claim, and incident-replay proofs are 21 REMO_E2E_DB_URL-gated skips (baseline note, `skip_max` 260 -> 280 with zero headroom). Local green says nothing about claimHealEvent/claimHealNotification races; they run only in Woodpecker. Not a defect in code read here (advisory lock + unique index + conditional UPDATE look correct), but flag to confirm CI ran them un-skipped. Baseline floors: pass_min and fail_max not lowered; skip_max raise is documented.

## Checked and found OK

- schema.sql additions are idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), no inline backfill, no FK on run ids.
- Flag-OFF: orchestrator/inject.ts governedLaunch legacy order (allowlist, supervisor, token cap, launch cap, counter key, grace dedupe, launch, best-effort ledger) matches the removed inline code; liveness moved verbatim. Scheduler hook is inert unless status failed AND flag ON; conditional spreads keep args identical. One flag-OFF-visible change: telegram/launch.ts now ends the reserved supervisor run on send_failed/internal_error (leak fix, unconditional); intentional but not strictly "exactly current behaviour".
- Recursion: scheduled-task sink is ledger-only and internal tasks (flag OR name prefix) are excluded; provenance probe fails closed before claim.
- Claim race: tx advisory locks in fixed order, trigger_run duplicate check, real-time window, unique-index backstop.
- Minor edge (not filed): in route.ts autospawnHeal a deadline `expire` firing while `deps.dispatch` is still in flight can be followed by `afterDispatch` delivering the turn after the event was finalized failed; window is the dispatch latency only.
