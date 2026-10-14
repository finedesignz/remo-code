# Phase 7 (PTYCAP-07 Unified Self-Heal Routing) - Verification

Verified: 2026-10-13 | Branch phase-ptycap-07-self-heal-routing @ 58dc644 (PR #512 draft) | Verifier: independent, goal-backward
Method: source read + each named test file run as its own `bun test <file>` process. SUMMARY claims not used as evidence.
Env note: the worktree had no node_modules (first run: `Cannot find package 'zod'` on 18 files = environment, not code). `bun install --frozen-lockfile` was run, then every file re-run; results below are post-install. No source edited.

## Ship verdict: SHIP-WITH-OPEN-ITEMS

All 5 SCs hold at unit/guard level with the flag matrix proven. The Postgres-backed proofs (SC2 concurrency, SC4 incident replay) are CI-pending (PARTIAL). One QC-open MAJOR (notification outbox) is real in code and reachable only with `REMO_HEAL_UNIFIED` ON (default OFF). Do not arm the flag until the MAJOR is closed and the Woodpecker e2e is green.

## Test runs (each file own process)

| File | Result |
|---|---|
| heal-single-seam | 26 pass |
| token-cap-coverage | 5 pass |
| counter-key-assignment-guard | 6 pass |
| heal-flag-off | 133 pass |
| heal-route-live / -no-target / -guards / -autospawn | 11 / 8 / 14 / 32 pass |
| heal-source-coolify / -scheduled-task / -error-feedback | 15 / 42 / 41 pass |
| heal-sinks-coolify-scheduled / -error-feedback | 12 / 15 pass |
| heal-coolify-webhook-live-session | 2 pass |
| heal-resolve / -events-dal / -notify / -sweep / -config / -types / -schema / -repo-ident / -counter-key / -internal-task | 16 / 26 / 15 / 19 / 36 / 16 / 6 / 12 / 6 / 8 pass |
| scheduler-counter-keys, sessions-heal-halt | 8, 11 pass |
| e2e/heal-incident-replay.e2e, e2e/heal-events.e2e | 0 pass, 10 skip each (REMO_E2E_DB_URL unset) = CI-pending |
| self-heal-routing (pre-existing supervisor picker, not Phase 7) | 1 pass, 9 skip (DB-gated) |

Zero failures. CI wiring for the skipped e2e: package.json `orchestrator:e2e` = `bun test hub/test/e2e/*.e2e.test.ts`, run in .woodpecker/qc.yaml:56 against postgres:16 (not executed here).

## Success criteria

| SC | Verdict | Evidence |
|---|---|---|
| SC1 one `routeHeal()` seam + guard | PASS | `routeHeal` hub/src/heal/route.ts:429. Callers: api/coolify-webhook.ts:161, error-capture/dispatcher.ts:216, feedback/dispatcher.ts:141, heal/sources/scheduled-task.ts:114 (scheduler hook scheduler/dispatcher.ts:830-845). Guard hub/test/heal-single-seam.test.ts (pinned legacy tokens per source area, exactly one `gates` literal under heal, key assigned only in route.ts, REMO_HEAL env read only in config/flag; has positive-control and self-check tests) 26 pass. |
| SC2 routing table + exactly one notification | PARTIAL | Live: route.ts:503-535 dispatch, heal-route-live 11 pass. Allowlisted autospawn: route.ts:~381 -> governed launch, heal-route-autospawn 32 pass. Not routable: route.ts:496 -> `finalizeNonLive` (persist, terminalize, then notifyOnce); heal-route-no-target.test.ts:101 "terminal within 5s, zero dispatches, exactly one notification attempt" pass. Notification is claim-based (`notification_claimed_at IS NULL RETURNING`, heal-events-dal) = exactly one SEND ATTEMPT. PARTIAL only because the atomic-claim / 8-way concurrency proofs (heal-events.e2e, incident-replay "concurrency") are Postgres-only and skipped locally. Plus the open MAJOR below (crash-window can yield zero notifications). |
| SC3 rides hub/src/dispatch chain | PASS | route.ts:14 imports `dispatch`/`PipelineDeps` from dispatch/pipeline.ts; single `buildPipelineDeps` gate list route.ts:127-ff = killSwitch, threshold, costCap, tokenCap, PTY gate, sessionInjectRate, lifetimeCounter. token-cap-coverage.test.ts:92 lists heal/route.ts and :106-109 asserts heal gate list discovered/ordered; 5 pass. |
| SC4 no heal run pending to 6h reaper | PARTIAL | Every routeHeal exit terminalizes: invalid event (route.ts:432-441), provenance refuse, claim dup/cap (route.ts:~468), none-target, repo_rate_bound, throw (D-06 catch). Boot sweep terminalizes stranded autospawn launches (index.ts:819-823, heal/sweep.ts, 19 pass) so the reaper is never the backstop. Unit incident fixtures (padded ids 8a6e0534 / fa377e27 / task 0e16bf38) in heal-source-coolify.test.ts pass. The Postgres incident replay (heal-incident-replay.e2e.test.ts V1:222 "<5s terminal, nothing pending", V2, concurrency, autospawn ledger) is SKIPPED locally = CI-pending. Reaper-finalized runs are excluded from re-heal (scheduled-task.ts:87 run_timeout). |
| SC5 flag OFF = exact legacy | PASS | healUnifiedEnabled() gates every entry: coolify-webhook.ts:144/427, error-capture/dispatcher.ts:179, feedback/dispatcher.ts:120, scheduler/dispatcher.ts:837, sweep.ts:84/153, index.ts:819, route.ts:444. Legacy bodies preserved between `heal-legacy-path` markers. heal-flag-off.test.ts 133 pass across flag-OFF matrix: legacy traces unchanged, routeHeal never invoked, static-import hygiene (no static import of heal/route or sinks). Note: characterization is mock-trace level, not a live-DB diff. |

## Panel amendments (GATES/verdict.md)

| Amendment | Verdict | Evidence |
|---|---|---|
| F-1 governed pre-launch adapter, heal has own flag | PASS | dispatch/governed-launch.ts (used by orchestrator/inject.ts and heal/autospawn-deps.ts). Heal flag `healUnifiedEnabled`; `healAutospawnArmed()` = heal flag AND `REMO_ORCHESTRATOR_AUTOSPAWN` (config.ts:52-54), independent of `REMO_ORCHESTRATOR_ENABLED`. |
| F-1 gates + atomic lifetime reservation BEFORE session.start; reuse on replay; release on failure | PASS (unit) / PARTIAL (e2e) | governed-launch.ts:143-180 (reserve, ledger, then launch; `releaseIfReserved` on refusal/throw/failed launch). heal-route-autospawn 32 pass; Postgres autospawn-ledger e2e skipped. |
| F-1 autospawn-launch ledger row fail-closed | PASS | governed-launch.ts:164-167 ledger failure -> `refused: ledger_unavailable` + release; legacy best-effort kept only at :191-196 for orchestrator. |
| F-1 launch primitive closes reserved run on every non-launch exit | PASS (code) | telegram/launch.ts:104, 239 `closeReservedRun('send_failed')` (+59 lines vs main). Dedicated test not individually re-run/identified. |
| F-1 error-capture/feedback stop using ensureOnline when flag ON; spawn-on-error only legacy/Revanote | PASS | `ensureOnline` appears only at error-capture/dispatcher.ts:261 and feedback/dispatcher.ts:178, both inside `heal-legacy-path` blocks (219-329, 144-224); the `...ViaHeal` paths go to routeHeal. |
| F-1 correct caller inventory | PASS (not independently audited) | Doc claim only; spot-check consistent with code. |
| F-2 bound_session_id via getSession(id,userId); reject missing/deleted/rootless/foreign/PTY/mismatch, no repo fallback | PASS | heal/resolve.ts:57-63 (bound_session_unavailable, rootless, pty_ineligible, no_repo_identity, repo_mismatch); heal-resolve 16 pass. |
| F-2 offline bound session autospawns only if allowlisted | PASS | governed-launch.ts:104 allowlist fail-closed (empty => not_allowlisted). |
| F-2 bound_session_id only on legit sources (discriminated union) | PASS | heal/types.ts:69 `discriminatedUnion`; coolify variant `.strict()` rejects it (types.ts:37); heal-types 16 pass. |
| F-3 heal_events atomic claim (xact advisory lock + unique backstop) | PASS (unit) / PARTIAL (concurrency) | db/heal-events-dal.ts:134,155 `pg_advisory_xact_lock`; schema.sql:1688 unique (user_id, source, dedupe_key, window_bucket). 8-way concurrency proof is e2e-skipped locally. |
| F-3 columns trigger_run_id, dispatch_run_id, outcome, updated_at, notification_claimed_at; conditional-UPDATE notification claim | PASS | schema.sql:1669-1681; heal-events-dal.ts:14; heal-schema 6, heal-events-dal 26, heal-notify 15 pass. |
| F-3 retention >= 24h; per-user hourly claim cap; Coolify table untouched OFF | PASS | config.ts:43 `Math.max(24, ...)`, dal prune floor MIN_RETENTION_HOURS, dal:116-160 user cap; flag-OFF suite passes. |
| F-4 key from canonical repo_ident only, null refused, one builder, POST /heal unchanged | PASS | heal/counter-key.ts `buildHealKey` throws `HealKeyError` on non-canonical; heal-counter-key 6, heal-repo-ident 12 pass. |
| F-4 heal/route.ts in counter-key-assignment guard | PASS | counter-key-assignment-guard.test.ts:22, :67-78; 6 pass. |
| F-4 per-repo hourly rate bound, exhaustion in outcome | PASS (unit) | route.ts claim `maxPerRepoHour` + `repo_rate_bound` outcome (route.ts~485); heal-route-no-target:154. |
| F-5 fire only on real failed non-internal repo-bound transition; exclude reaper runs | PASS | scheduled-task.ts:8,87 (run_timeout excluded), internal via flag or name; heal-source-scheduled-task 42 pass. |
| F-5 hook between terminal UPDATE and notification; exactly one notifier (suppress duplicate email) | PASS (steady state) | scheduler/dispatcher.ts:~820-845 `healOwnsNotification` -> `suppressDefaultFailureEmail`. Crash-window gap = open MAJOR. |
| F-5 durable provenance + recursion guard before claim, fail closed; child heal run cannot create heal event | PASS | route.ts:446-466 `isHealDerived` before `deps.claim`, throw -> `heal_guard_error`; provenance via triggered_by_run_id / heal_events (`isHealGenerated`, two-hop proof is e2e-skipped locally -> PARTIAL for chain depth), heal/internal-task.ts. |
| F-5 per-task daily ceiling | PASS | `healMaxPerTaskDay` default 3, atomic in claim (dal:163-170). |

## Open items

1. MAJOR (QC/VERDICT.md, round3-codex #1), CONFIRMED in code: no notification outbox exists (heal/notify.ts:9 states "no outbox"; repo has no outbox table/columns). A hub crash after the heal claim and before the scheduler default email (scheduler/dispatcher.ts ~812) leaves a scheduled-task heal event with zero owner notifications; the sweep is claim-only for scheduled tasks. Fix: persist the pending-email obligation on the heal event and have the sweep deliver once. Impact: only with REMO_HEAL_UNIFIED ON. Violates SC2 "exactly one notification" in that crash window.
2. CI-pending: heal-events.e2e (10) and heal-incident-replay.e2e (10) skip locally; SC2 concurrency and SC4 incident replay are not proven until Woodpecker `bun run orchestrator:e2e` passes on postgres:16. Check that run before marking SC2/SC4 PASS.
3. agy seat was MISSING in QC (Claude + Codex only); cross-family panel incomplete.
4. Pre-existing tsc errors (19) remain, per QC record; not introduced by this phase.
5. Flag-OFF equivalence is mock-trace characterization, not a live-DB diff; acceptable but note.
6. Launch-primitive run-leak fix (telegram/launch.ts) verified by code read only; no dedicated test file individually identified in this pass.

## Repair round (post-BLOCKED)

Open MAJOR (round3-codex #1) implemented as a durable owner-email outbox, commit 84787dd:
- heal_events gains owner_email JSONB, owner_email_claimed_at, owner_email_delivered_at (idempotent additive DDL, no backfill, partial index for pending rows).
- claimHealEvent writes the obligation in the SAME transaction as the claim (scheduled_task, only when the default failure email applies: dispatcher computes it via defaultFailureEmailApplies).
- Scheduler (healFailedRunHook) sends it through heal/owner-email.ts and marks delivered; default post-run email suppressed only when an obligation exists. Lease CAS (5 min) on claimed_at; delivered_at is the terminal flag. A heal outcome for such an event appends its reason to the obligation and never sends a second ownerless email.
- Heal sweep (boot + follow-up) redelivers every undelivered obligation once. REMO_HEAL_UNIFIED OFF: nothing new runs (hook returns before, sweep returns before); hub/test/heal-flag-off.test.ts unchanged, 133 pass.

Evidence: hub/test/heal-owner-email-outbox.test.ts 13 pass (crash between claim and send -> sweep sends exactly 1, second sweep 0; normal path exactly 1, sweep 0 after; scheduler/sweep race -> 1; failed send retried -> 1; mid-send crash honours lease; SQL pins). All hub/test/heal-*.test.ts and self-heal-routing individually 0 fail. check-baseline OK (pass 3284, skip 280, fail 0). tsc: no errors in touched files.

Codex read-only re-QC (QC/round4-codex.md): CONTENT-BLOCK, two NEW MAJORs, recorded NOT fixed per instruction:
1. Failed sends are retried only by the boot sweep and the single follow-up (50 rows per pass), and pruneHealEvents (heal-events-dal.ts ~114) can delete an undelivered obligation row -> permanent loss for a send failure after the follow-up sweep. Fix direction: exclude owner_email_delivered_at IS NULL obligations from prune; add a bounded periodic outbox sweep (event driven retry on send failure) or exponential-backoff re-attempt.
2. If hasObligation probe throws, deliverOwnerEmailForRun returns false -> legacy default email also sent, and the persisted obligation is later swept -> duplicate email. Fix direction: on probe error treat as obligation present (fail toward suppression) or decide from the claim result already in hand.

Ship verdict: still BLOCKED (draft PR #512 stays draft) until these two are fixed and re-QC'd.
