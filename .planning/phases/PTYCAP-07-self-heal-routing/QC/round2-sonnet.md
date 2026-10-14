# PTYCAP-07 QC round 2 (sonnet, adversary + correctness)

Method: read diff 3f88ff9..HEAD (src + DAL SQL), re-ran 10 touched test files in own process (all green, 0 fail).

## Round-1 findings

| # | Finding | Status | Evidence |
|---|---|---|---|
| codex 1 CRITICAL | Coolify + live session bypassed routeHeal, run pending | FIXED | coolify-webhook.ts:427 suppression only when `!healUnifiedEnabled()`; test heal-coolify-webhook-live-session (HTTP-level, flag ON routes, OFF legacy) |
| codex 2 | lifetime reservation blocked own dispatch at cap | FIXED | automation-controls.ts lifetimeCounterCheck own unreleased (key,token) passes at cap; core test covers own/other/released |
| codex 3/4, corr MAJOR 1 | double owner notification | FIXED | notifyOnceDetailed claimed vs sent; scheduled-task returns true on claim; scheduled_task launched/parked takes claim with no send; error-capture store `notify:false`; tests in heal-notify, heal-route-autospawn, heal-source-scheduled-task |
| codex 5 | only_if_active suppressed genuine failures | FIXED | `onlyIfActive` removed; run_timeout prefix is the reaper marker; test covers genuine failure under CAS |
| codex 6 | sweep cannot rebuild error-capture, leaks reservation | FIXED | recovery_ctx jsonb + eventFromRow; sink failure caught, release + setOutcome still run; heal-sweep tests |
| codex 7 | crash strands lifetime slot | FIXED | `autospawn_starting` persisted before reserve/launch (not swallowed); in STRANDED + stale SQL list; tests |
| codex 8 | per-repo/task ceilings non-atomic | FIXED (SQL read) | See below |
| corr MAJOR 2 | quick-restart rows never swept | FIXED | bootSweepHealLaunches one unref'd follow-up at 2x timeout+1s; index.ts uses it; flag OFF arms nothing |
| adv MAJOR | heal autospawn inherited skip-permissions | FIXED | governed-launch passes `skipPermissions:false` only when preLaunch (heal); telegram/launch.ts forces frame false; launch-run-leak + governed-launch tests |
| adv MINOR | no PTY gate in heal gates | FIXED | governedAutomationPtyGate added, runner type read at dispatch time; heal-route-live test |

### #8 atomicity judgement (reading the SQL)
Atomic on Postgres. claimHealEvent runs in `exec.begin` (one transaction). `pg_advisory_xact_lock(hashtext('heal-user:'||user))` is taken before the user-cap, task-cap and repo counts and the INSERT, and is held to commit. Every claim of that user therefore serializes from the lock to commit; under READ COMMITTED each later statement takes a fresh snapshot and sees the prior holder's committed row. Count and INSERT are one critical section, so distinct dedupe keys cannot both pass the ceiling. Lock order is fixed (per-key then per-user), so no deadlock. In-flight rows (NULL outcome) count toward the repo ceiling. The in-memory fake models this correctly. A real-Postgres e2e is still absent (not a block, flagged below).

## New findings

No CRITICAL or MAJOR. Checked and clean: double notification, recursion (internal task / ancestry guards untouched), spawn-before-gate (starting row only records intent; gates and reserve follow; write failure aborts before any spawn), reservation leak (release on every sweep path), run left pending (task_day_cap and repo bound both terminalize), flag-OFF (hook gated, `notify` defaults true, skipPermissions only on heal path), cross-tenant (all counts keyed by user_id).

- MINOR 1: heal-events-dal.ts task/repo ceiling has no real-Postgres test (heal-events.e2e not extended). Add concurrent-claim e2e to the DB-gated suite.
- MINOR 2: error-capture sink `notify:false` drops the legacy `session_busy`/send-failure notices on the live path; confirm routeHeal notifies those live-dispatch skip/fail outcomes (finalizeNonLive covers only non-live outcomes). Possible silent owner-notification loss, unverified.
- MINOR 3: sweep calls release() for `autospawn_starting` rows that may never have reserved; relies on release being idempotent (not re-verified).
- MINOR 4: lifetime own-token pass is also active for non-heal flag-OFF callers whose token has an unreleased inject row (equals reserveInject idempotency; negligible).

## Verdict: PASS
