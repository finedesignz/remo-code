---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 05
subsystem: hub-api
tags: [kill-switch, lifetime-reset, openapi, boot-assertions, token-cap-alarm, email, event-driven]

requires:
  - phase: PTYCAP-04-02
    provides: automation-controls.ts (engage/release/state/reset, alarmPct, boot assertions), token_cap_alarms table
provides:
  - /api/automation kill-switch (GET, engage, release) and lifetime reset routes with tenancy + step-up rules
  - OpenAPI registration + regenerated docs/openapi.json and docs/api.md (idempotent, drift-clean)
  - boot wiring: env assertion before Bun.serve, table assertion first after runMigrations (static pin test)
  - daily-token-ceiling alarm (60 percent default): token-usage listener slot, durable claim with delivered flag, trailing-edge coalescing
affects: [PTYCAP-04-06, PTYCAP-04-07 (release-time resume hooks the release handler), PTYCAP-04-08 (docs)]

plan_head_before: b62d8a4005867fd0a051d7bbdc4a139afe9909d1
actuals:
  tokens: 15600
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Handler-level admin check (exact requireAdmin 403 body) so user and session scope stay open to every authenticated user"
    - "Listener registry in the DAL (single slot, fire-and-forget, no new SQL) instead of a statement inside recordTokenUsage"
    - "Alarm claim = INSERT ... ON CONFLICT DO NOTHING, then an atomic bounded-retry UPDATE restricted to delivered=false"

key-files:
  created:
    - hub/src/api/automation.ts
    - hub/src/observability/token-cap-alarm.ts
    - hub/test/automation-api.test.ts
    - hub/test/automation-boot-order.test.ts
    - hub/test/token-usage-listener.test.ts
    - hub/test/token-cap-alarm.test.ts
  modified:
    - hub/src/index.ts
    - hub/src/api/_openapi.ts
    - hub/src/db/token-usage-dal.ts
    - docs/openapi.json
    - docs/api.md
    - hub/test/mount-order.test.ts
    - hub/test/e2e/automation-controls-checks.ts
    - hub/test/counter-key-assignment-guard.test.ts

key-decisions:
  - "Engage has no step-up (mirrors orchestrator /stop); release and reset use requireRecentAuth (15 min), applied per path in index.ts"
  - "Email fan-out channels inapp and telegram run only after the email was delivered, so retries cannot spam; undelivered claims retry (5 attempts, 300 s cooldown) on later usage events only"
  - "Alarm module reads the cap through getTokenCapStatus (cap 0 = explicitly disabled = silent), never through the env directly"

requirements-completed: [SC-2, SC-3]

coverage:
  - id: D1
    description: "Kill-switch and reset routes: tenancy table (global admin, user = caller, session ownership 404), idempotent engage, reset 404/400, no session.stop / supervisor registry"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/automation-api.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Mount order + step-up placement + OpenAPI + docs regenerated with no drift; boot assertions ordered (env before serve, tables after migrations)"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/mount-order.test.ts, hub/test/automation-boot-order.test.ts"
        status: pass
      - kind: other
        ref: "bun run docs:sync twice, identical diff"
        status: pass
    human_judgment: false
  - id: D3
    description: "60 percent alarm: event-driven listener, durable claim, delivered only on sendEmail true, bounded retries, trailing-edge coalescing, cap-disabled silent, ASCII mail"
    requirement: "SC-3"
    verification:
      - kind: unit
        ref: "hub/test/token-usage-listener.test.ts, hub/test/token-cap-alarm.test.ts"
        status: pass
      - kind: unit
        ref: "usage-event-handler, token-usage-runner-type, pty-usage-midflight-visibility (untouched, green; midflight cases are pre-existing DB-gated skips)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Concurrent claimTokenCapAlarm against real Postgres (one winner, one row, cooldown, delivered blocks) inside the existing e2e body"
    requirement: "SC-3"
    verification:
      - kind: e2e
        ref: "hub/test/e2e/automation-controls-checks.ts section 12 via orchestrator-tokencap.e2e.test.ts (Woodpecker only)"
        status: pending-ci
    human_judgment: false

duration: 75min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 05: Owner-facing surfaces - kill-switch routes, reset, OpenAPI, 60% alarm

**The owner can halt automation (global/user/session) and reset a lifetime counter through authenticated API calls, the contract is in OpenAPI, the boot refuses a bad cap or missing tables in the right order, and an email goes out once per local day when tokens cross 60 percent of the daily ceiling, driven by usage events with a delivered-tracked durable claim.**

## Accomplishments

- `hub/src/api/automation.ts`: GET `/kill-switch`, POST `/kill-switch/engage`, POST `/kill-switch/release`, POST `/lifetime/reset`. Global scope requires the admin role (exact `{error:'forbidden', reason:'admin_required'}` body, checked in the handler). User scope is always the caller (a body `user_id` is never read). Session scope checks `sessions.user_id` and `deleted_at IS NULL` (404 otherwise). Engage writes a row only: no `session.stop`, no supervisor-registry import (static pin test). One audit log line per mutation.
- `index.ts`: route mounted after the `/api/*` catch-alls; `requireRecentAuth` on `/kill-switch/release` and `/lifetime/reset` only (engage deliberately none); `userMutationLimit` on `/api/automation/*`. Env assertion sits right after `assertTokenCapConfig` (before `Bun.serve`); table assertion is the first `.then` after `runMigrations()` with its own FATAL + exit(1) catch; `registerTokenCapAlarm()` follows it.
- OpenAPI spec-only block for the four operations (400/401/403/404 and `re_auth_required` shapes); `bun run docs:sync` ran twice with an identical diff (+1203 lines in `docs/openapi.json` and `docs/api.md`, nothing unrelated).
- Alarm: `setTokenUsageListener` (fire-and-forget, sync throw and rejected promise swallowed, no new SQL; the three existing DAL tests are untouched and green). `token-cap-alarm.ts` coalesces per user on a trailing edge (5 s quiet, 30 s max wait, injectable timers, `unref`'d, no `setInterval`), reads `getTokenCapStatus`, claims atomically (`ON CONFLICT (user_id, local_date)`, date from `now() AT TIME ZONE <user tz>`), emails `users.email` via `sendEmail` (independent of `notify_channels`), flips `delivered` only on `true`, then best-effort `fanOutNotify` limited to inapp and telegram.

## Verification

| Gate | Result |
|---|---|
| `automation-api.test.ts` | 16 pass |
| `mount-order.test.ts` | 22 pass |
| `automation-boot-order.test.ts` | 6 pass |
| `token-usage-listener.test.ts` | 5 pass |
| `token-cap-alarm.test.ts` | 24 pass |
| `usage-event-handler` / `token-usage-runner-type` | 5 / 7 pass |
| `pty-usage-midflight-visibility` | 6 skip (pre-existing DB-gated), 0 fail |
| `counter-key-assignment-guard.test.ts` | 3 pass |
| `bun run docs:sync` (x2) | OK, no further diff |
| `bun run check-baseline` | pass=2579 skip=259 fail=0 (baseline pass=2379) |
| `tsc --noEmit` (hub) | 427 errors, equal to baseline |
| `schema-lint` | not run (schema.sql untouched) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] counterKey assignment pin failed on the reset route**
- **Found during:** check-baseline (first run fail=2, second fail=1, the stable failure was `counter-key-assignment-guard.test.ts`)
- **Issue:** `api/automation.ts` passes `counterKey:` to `resetLifetimeCounter`, which the 04-03 trust-boundary pin flags as an unreviewed assignment site.
- **Fix:** reviewed and allowlisted `api/automation.ts` in the pin with the reason (a key the caller already owns ledger rows for, enforced in `resetLifetimeCounter`; never a `DispatchRequest`). The other transient failure in run 1 did not reproduce in runs 2-3 (not isolated; the final run is fail=0).
- **Files modified:** hub/test/counter-key-assignment-guard.test.ts
- **Commit:** 05db067

**2. [Rule 1 - Bug] tsc baseline regressions in new code (445 vs 427)**
- **Issue:** untyped `c.get` in the new router/test (as in `orchestrator.ts`), four `registerPath` overload errors matching the existing blocks, and a block-scoped `claims` redeclaration in the e2e helper (a real SyntaxError at runtime in CI).
- **Fix:** `Hono<{ Variables }>` router, `Hono<any>` in the test, a loosely typed `register` helper in the new OpenAPI block only, renamed to `alarmClaims`.
- **Commit:** b3ddd67 (typing), e1737b3 (e2e rename was done before its commit)

### Scope notes

- `resetLifetimeCounter` returns `{ok:true}` with no epoch, so the reset route answers `{ok:true, counter_key}` (the plan text said `{epoch...}`).
- The 80 percent LIFETIME-cap warning page (panel F-5a) is owned by plan 04-02, not this plan; this plan's alarm is the daily-token-ceiling email (D-13).
- The e2e claim check (section 12) deletes the test user's alarm row for today's UTC date at start, then cleans up by claimed id. It could not run locally (no Postgres); Woodpecker proves it. Zero new tests, zero new skips (259).
- The no-email user path records the claim attempt and sends nothing; in-app and telegram fan-out happen only after a delivered email, so a user whose mail never delivers gets no extra channel (logged only).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: T-04-21..T-04-26 mitigated (admin check in handler, caller-bound scopes, ownership 404, step-up on release/reset, row-only engage with source pin, in-memory coalescing, delivered-flag claim, counts-only email).

## Self-Check: PASSED

Files verified present (routes, alarm module, four new test files); commits e824552, d97add5, b3ddd67, e1737b3, 05db067 exist.
