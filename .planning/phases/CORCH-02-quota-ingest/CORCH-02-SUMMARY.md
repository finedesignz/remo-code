---
phase: CORCH-02-quota-ingest
plan: 01
subsystem: corch
tags: [quota, cug, eligibility, dispatcher, postgres]
status: complete
requires: [CORCH-01]
provides:
  - POST/GET /api/quota/snapshot (explicit quota:publish / quota:read)
  - corch_quota_accounts table
  - fail-closed eligibility, real quota provider, quota wait, quota death
tech-stack:
  added: []
  patterns: [route-local Bearer explicit-scope auth, pure eligibility function, injected provider deps (no DB import)]
key-files:
  created:
    - hub/src/api/quota.ts
    - hub/src/corch/quota-store.ts
    - hub/src/corch/quota-eligibility.ts
    - hub/src/corch/quota-provider.ts (rewritten, DEFAULT unchanged)
    - hub/src/corch/quota-death.ts
    - hub/test/corch-quota-{ingest,eligibility,selection,wait,death}.test.ts
    - hub/test/e2e/corch-quota.e2e.test.ts
  modified:
    - hub/src/db/schema.sql, hub/src/auth/scopes.ts, hub/src/index.ts, hub/src/csrf.ts
    - hub/src/corch/{dispatcher,store,gates,flag}.ts
    - hub/src/ws/{supervisor-protocol,supervisor-registry,agent}.ts
    - hub/src/api/_openapi.ts, docs/{corch.md,openapi.json,api.md}, CLAUDE.md, tools/regression-baseline.json
decisions:
  - "Q1: a hub-visible channel exists (onFinalize content); modern CLI reset time is a human string and is NOT parsed; the named window (5h|7d) selects the fallback reset"
  - "markDeath returns the resulting blocked_until (Date|null) so the requeue not_before is exact"
  - "earliestEligibleAt returns Date|null; a throw degrades to NULL (event-driven)"
metrics:
  completed: 2026-11-13
  tasks: 8
  commits: 8
  tokens: 33600
plan_head_before: 0f12261e0157edb75b87372638720fe7f625d1c5
actuals:
  tokens: 33600
  tasks: 8
  commits: 8
---

# Phase CORCH-02 Plan 01: Quota Ingest Summary

CUG usage-snapshot ingest over explicit-scope Bearer keys into `corch_quota_accounts`, one pure fail-closed eligibility function used by both the read route and a real dispatcher quota provider (most-headroom pick, `account_slot` recorded, quota wait with exact `not_before`, quota death blocks the account), all behind `REMO_CORCH_ENABLED` (default OFF, untouched in every environment). No push was made.

BASE = `0f12261e0157edb75b87372638720fe7f625d1c5`. N0 = 253 typecheck errors. Branch `phase-corch-02-quota-ingest`.

## Commits (one per task)

| Task | Commit | Tests added / run |
|---|---|---|
| 1 tracer: research record, publish -> store -> read on real PG | `9490f80` | e2e tracer (1) on real Postgres; schema-lint, migration-verify green |
| 2 ingest auth, strictness, isolation pins | `0cb7ac0` | corch-quota-ingest 27, api-keys-scopes +5 (37), mount-order +3 +1 list (29), csrf +1 (30) |
| 3 full eligibility table, ceiling env, CUG-only guard | `9d33f87` | corch-quota-eligibility 37, corch-boot-assert +5 (15), ingest +1 (28) |
| 4 hello account_slot, registry accessor, provider selection | `7ed9b94` | corch-quota-selection 22; corch-gates 58 unchanged |
| 5 dispatcher wiring, quota wait, POST trigger | `1446301` | corch-quota-wait 14, corch-flag-off +1 (5) |
| 6 quota death | `b4ec8dd` | corch-quota-death 15 |
| 7 real-Postgres e2e matrix | `6bdc425` | corch-quota.e2e 11 pass, 0 skip on real PG |
| 8 docs, OpenAPI, CLAUDE.md, baseline | `6298141` | check-baseline OK; docs:sync zero drift |

## Q1 outcome (quota-death signal)

Hub-visible signal EXISTS: the runner relays the CLI's synthetic limit message as assistant text, which reaches
`onFinalize(content)`. Evidence is CLI 2.1.325 binary strings (`You've hit your session limit`, `· resets ${...}`,
legacy `usage limit reached|<epoch>`), recorded in `CORCH-02-RESEARCH.md`. Task 6 was NOT blocked; no autofix ticket
was needed. Caveats recorded there: composed strings are assembled from template fragments (no live limit event was
captured), the modern reset is a locale string and is deliberately not parsed.

## Definition of Done results (fresh Postgres DBs on 127.0.0.1:55432, CI-equivalent env)

| # | Result |
|---|---|
| 1 schema-lint | exit 0 (`OK, 5 allowed`) |
| 2 migration-verify | exit 0, errors=0 |
| 3 schema-double-apply e2e | 9 pass, 0 fail, 0 skip |
| 4 destructive DDL grep | 0 |
| 5 unit files (each own process) | ingest 28, eligibility 37, selection 22, wait 14, death 15, boot-assert 15, flag-off 5, csrf 30, gates 58, prompt 3, routes 13: all pass, 0 fail |
| 6 guards (each own process) | kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, corch-no-polling-guard 2, api-keys-scopes 37, mount-order 29: all pass |
| 7 corch e2e | corch-quota 11 pass / 0 skip; corch-dispatcher 28 pass / 0 skip |
| 8 orchestrator:e2e | 107 pass, 0 fail, 15 files |
| 9 check-baseline | exit 0. Baseline 3643/323/0/3966 -> actual 3779 pass / 336 skip / 0 fail / 4115 total; S = 13 (corch-quota.e2e without DB: 0 pass 13 skip), skip_max 323 -> 336 under `_skip_note_corch_02`; pass_min, fail_max unchanged |
| 10 docs:sync drift | `git diff --exit-code -- docs/openapi.json docs/api.md` exit 0 (819 additions, 0 deletions) |
| 11 typecheck | 253 total = N0 (no increase). Second clause prints 4, not 0: all 4 are pre-existing `hub/src/ws/agent.ts` errors at lines 493/887/891/1246 present on BASE (counted in N0 before any ws change); none in corch/quota/supervisor files |
| 12 scope fence | changed paths are all in files_modified (plus the phase's own `.planning/phases/CORCH-02-quota-ingest/` artifacts); fence diff lines 0; timers added 0; `hub/src/usage` diff 0 |

## Deviations from Plan

1. **[Rule 2 - correctness] quota death names the window.** `classifyQuotaDeath` returns `{resetAt, window}` (window `5h|7d` from the CLI label) and `markDeath` takes an optional `window`. Without it a weekly-limit death would unblock at the earliest (5h) reset and the run would die again in a no-attempt loop. LD-Q10's "earliest future reset" remains the fallback when no window is named.
2. **[Plan detail] `markDeath` returns `Date | null`** (the resulting `blocked_until`), needed so the death requeue can carry `notBefore {at}`; `earliestEligibleAt` returns `Date | null`.
3. **[Rule 2] `earliestEligibleAt` and `markDeath` failures are caught and logged without content;** the item still requeues (event-driven NULL not_before) rather than being lost.
4. **RED phases:** Task 2 tests passed on first run because the tracer already delivered the production route; Task 4 tests were written first but their red run was not separately recorded before the implementation. Tasks 3, 5 and 6 were run red first where behavior was new (Task 3: 20 red; Task 6: 2 test bugs fixed in the tests only).
5. **DoD 11 second clause** prints 4 (pre-existing `agent.ts` errors on BASE), not 0; total count is unchanged at N0.
6. `CORCH-02-PLAN.md` was untracked at start and is committed with Task 1.
7. `bun install --frozen-lockfile` was run (no new packages). `bun run docs:sync` uses the repo's own `npx widdershins@4.0.1` script.

## Known limitations (flagged, not fixed)

- **Whole-text death anchor (LD-Q10):** the supervisor relays the whole turn's text, so a run that wrote prose and then hit the limit does not match and follows the CORCH-01 `no_pr` path (attempt consumed). Fail-safe direction; a future phase could anchor on the final line.
- **Modern reset time is not parsed;** the window's reset from the CUG reading (or a NULL-until block cleared by a newer snapshot) is used. Composed sample strings were not captured from a live limit event.
- `claimAccountSlot` is one conditional UPDATE without an advisory lock; per-user claims are already serialized by the CORCH claim lock and the default per-user cap is 1.
- Supervisors do not yet SEND `account_slot` (CORCH-09), so with the flag ON no account has an online slot supervisor and dispatch refuses `quota:no_slot_supervisor` until then. By design: no supervisor targeting in this phase.

## Auth gates / blockers

None. No BLOCKED items, no autofix tickets filed (no genuine defect hit).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (new route `/api/quota/*` is T-CORCH02-01..06).

## Self-Check: PASSED

All 8 commit hashes exist on `phase-corch-02-quota-ingest`; created files exist; working tree clean after the Task 8 commit.

## QC round 1 fixes

Source: `QC-CODEX.md` (CONTENT BLOCK, 6 findings) and `QC-CLAUDE.md` (CONTENT BLOCK, 1 HIGH, 2 MED, 4 LOW). Locked fix spec F1-F7 from the orchestrator. Tests first (red), then fix, one commit per item.

| Item | Finding | Commit | Test |
|---|---|---|---|
| F1 | Both seats HIGH: run text could block an account indefinitely. CUG is the single quota source: `markDeath` blocks `min(candidate reset, now + 5h or 7d)`; a live reading with `fetched_at > blocked_at` clears `blocked_until` and `blocked_at`. `blocked_at` is the death_at record (no new column). | `9c450ac` | `corch-quota.e2e` F1 x3 (far-future epoch clamps; older / non-live reading does not clear, newer live clears; death at low usage cleared by next reading, GET eligible again) |
| F2 | Codex #5: a later death shortened an existing block. `GREATEST(existing, new)`. | `2a3e396` | `corch-quota.e2e` F2 (both orders) |
| F3 | Codex #4: failed `runContext`/`markDeath` allowed immediate redispatch. Requeue with `not_before = now + 5h`, log without content. | `781c455` | `corch-quota-death` F3 x2 (throwing markDeath, throwing runContext) |
| F4 | Both seats: claim write-skew race. `claimAccountSlot` runs in one tx behind `pg_advisory_xact_lock(hashtext(user:account))`. | `2bce816` | `corch-quota.e2e` F4: claim blocks behind the held lock (deterministic, red before fix); 5 concurrent claims, capacity 1, exactly one wins |
| F5 | Codex HIGH #2: account not bound to launch. Selection carries `supervisor_id`; new `QuotaProvider.supervisorFor`; `governedLaunch` opt-in `resolveTarget` -> `launchSessionForUser` opt-in `targetSupervisorId` (corch only); no binding -> `quota:supervisor_unbound` (no attempt, no reservation). | `4f98be1`, `8bdb9ac` (e2e fixture) | `corch-quota-binding` (6: A->A's supervisor, B->B's, no match / no account / lookup throws -> refusal, seam provider untargeted, governedLaunch opt-in), `corch-quota-selection` F5, `launch-machine-guard` x3 (target overrides hostname pick; foreign target refused; no target unchanged) |
| F6 | Codex MED #6: GET eligibility ignored busy counts. Route store dep `liveRunsByAccount`. | `e5e0eed` | `corch-quota-ingest` F6 |
| F7 | Claude LOW #6: replayed older reading overwrote a newer one. Upsert `WHERE fetched_at IS NULL OR EXCLUDED.fetched_at IS NULL OR EXCLUDED.fetched_at >= stored`. | `9a4c442` | `corch-quota.e2e` F7 (older ignored incl. `received_at`; equal and newer applied) |

Docs: `docs/corch.md` updated for F1-F7 semantics (committed with this section).

### Deviations

- F5: `resolveTarget` runs inside the HEAL pre-launch block, after the gates (the quota gate records the run's account) and before the reservation and ledger row, so a refusal reserves nothing. A quota provider without `supervisorFor` (the CORCH-01 seam fakes and `DEFAULT_QUOTA_PROVIDER`, which already refuses at the gate) launches untargeted; the real `createQuotaProvider` always defines it. The target is resolved from the run's recorded `account_slot` at launch time, not carried through the gate result (the gate list returns only a refusal reason).
- F1: no new `death_at` column (additive DDL avoided): `blocked_at` already records the death instant. Existing e2e tests that pinned the old semantics (NULL-until block; time-bounded block not cleared by a newer snapshot) were rewritten to the new rules.
- One commit (`4f98be1`) was made with a failing e2e fixture (the chained command did not stop on the failing test); `8bdb9ac` fixes the fixture immediately after. The product code was correct.

### Follow-ups left (Claude LOW, as instructed)

- LOW 4: clear relies on publisher-supplied `fetched_at` (skewed/replayed value greater than `blocked_at` clears a block); consider received_at ordering or monotonic `generated_at`.
- LOW 5: unbounded `corch_quota_accounts` row growth per user (free-form `account_id`, never pruned).
- LOW 7: POST/GET `/api/quota/snapshot` and the DDL are live with the flag OFF (data stored, nothing dispatched); rate-limit key uses the first 24 chars of Authorization.

### Final checks (fresh DBs on 127.0.0.1:55432, CI-equivalent env, each file in its own bun process)

All corch unit files (boot-assert 15, flag-off 5, gates 58, no-polling-guard 2, prompt 3, quota-binding 6, quota-death 16, quota-eligibility 37, quota-ingest 29, quota-selection 23, quota-wait 14, routes 13), guards (kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, launch-machine-guard 11, api-keys-scopes 37, mount-order 29) and e2e (corch-quota 17, corch-dispatcher 28) pass with 0 fail. `check-baseline` (CI env, fresh DB) OK: pass=4043 skip=0 fail=0. Typecheck 253 errors (limit 253; no new). `schema-lint` OK (5 allowed, none new). `docs:sync` not run: no route or OpenAPI shape changed.

## QC round 2 fixes

Source: `QC-CODEX-R2.md` (CONTENT BLOCK, 3 MED + 1 LOW). Locked fix spec G1-G3 from the orchestrator. Tests first (red), then fix, one commit per item.

| Item | Finding | Commit | Test |
|---|---|---|---|
| G1 | MED #1: a recorded quota death copied the death deadline into the item's `not_before`, so a healthy live snapshot released the account but not the item. Now: block recorded (`markDeath` returned a `blocked_until`) -> item `not_before = now + 600s`; the account block alone governs quota. `markDeath` throwing OR returning null/undefined (block not recorded) keeps the fail-closed `now + 5h` hold (closes the null-result gap). `CorchDeps.now` is an injectable clock. | `0ea4702` | `corch-quota-death` (600s with injected clock, far deadline not copied, null and undefined results -> 5h, F3 cases on the injected clock); `corch-quota.e2e` death -> clearing live snapshot -> `claimNext` null inside the backoff, item reclaimable once the backoff passes |
| G2 | MED #2: a future-dated stored reading rejected every genuine later reading (the store ignores older `fetched_at`), including block clearing. `POST /api/quota/snapshot` now returns 400 `invalid_snapshot`, no write, no evaluation, when any account `fetched_at` or the top-level `generated_at` is more than 120 s ahead of server time. | `150c17b` | `corch-quota-ingest` (future reading rejected and not stored, a normal reading after it applied; boundary +120s accepted / +121s rejected; `generated_at`); `corch-quota.e2e` (2099 reading 400, stored row unchanged, genuine live reading after a death still clears the block) |
| G3 | MED #3: supervisor binding was checked once. `resolveTarget` now re-reads the target supervisor's CURRENT advertised `account_slot` from the registry (new `QuotaProvider.supervisorAccountSlot`, null when not connected) and requires it to equal the run's recorded `account_slot`, else `quota:supervisor_unbound` (no attempt, nothing reserved). A provider that has `supervisorFor` but cannot re-read, or a throwing re-read, fails closed. | `7b73b1c` | `corch-quota-binding` (reconnect advertising another account -> refused; not connected -> refused; re-read throws / missing -> refused; matching -> launches targeted), `corch-quota-selection` (`supervisorAccountSlot` reads at call time) |
| LOW 4 | Clear provenance (`source: live`, `fetched_at > blocked_at`) is publisher-controlled. | none | Accepted, no code change: only a holder of a `quota:publish` key can forge a clear, and it can only affect that key owner's own user. Assistant text alone cannot publish a clear. |

Docs: `docs/corch.md` updated (G1 backoff vs hold, G2 120 s future bound, G3 launch-time re-read).

### Deviations

- G3: the re-read happens at `resolveTarget` time as specified. It is a point-in-time check: a supervisor that reconnects under another account AFTER `resolveTarget` and before the send (across the reservation and ledger awaits) is not re-checked. Closing that window needs a check inside `launchSessionForUser` right before the frame is sent; not done (outside the locked spec).
- G1: when the run holds no account, or the quota provider has no `markDeath` (CORCH-01 seam), `not_before` stays null as before (nothing was attempted, so nothing failed to record).
- Commit trailer: the system attribution reminder (Claude Sonnet 5.5) was used rather than the `Claude Opus 5.5` text in the task brief.

### Final checks (fresh DBs on 127.0.0.1:55432, CI-equivalent env, each file in its own bun process)

All corch unit files (boot-assert 15, flag-off 5, gates 58, no-polling-guard 2, prompt 3, quota-binding 10, quota-death 18, quota-eligibility 37, quota-ingest 32, quota-selection 24, quota-wait 14, routes 13), guards (kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, launch-machine-guard 11, api-keys-scopes 37, mount-order 29) and e2e (corch-quota 18, corch-dispatcher 28) pass with 0 fail. `check-baseline` (CI env, fresh DB) OK: pass=4054 skip=0 fail=0. Typecheck (`bunx tsc --noEmit -p hub/tsconfig.json`) 253 errors (limit 253; none in touched files). `schema-lint` OK (5 allowed, none new). `docs:openapi` regenerated with no diff to `docs/openapi.json` (route shape unchanged), so `docs:sync` produced no change.

## QC round 3 fixes

Source: `QC-CODEX-R3.md` (CONTENT BLOCK, 2 MED + 2 LOW) and `VERIFICATION.md`. Tests first (red), then fix, one commit per item.

| Item | Finding | Commit | Test |
|---|---|---|---|
| H1 | MED #1: a quota refusal at dispatch copied `earliestEligibleAt` into the item's `not_before`, restoring the long hold after the death backoff. Now `not_before = min(earliestEligibleAt, now + 600s)` (NULL when `earliestEligibleAt` is NULL); account state alone governs eligibility. | `baf9252` | `corch-quota-wait` (far reset capped at now+600s with injected clock, near reset kept); `corch-quota.e2e` death -> still over ceiling -> backoff expires -> quota refusal -> healthy reading before reset -> item claimable after at most 600s, not at the reset |
| H2 | MED #2: a row already poisoned with a far-future `fetched_at` kept rejecting genuine readings. The upsert treats a stored `fetched_at` more than 120 s ahead of server time as invalid and overwrites it. | `aa1d004` | `corch-quota.e2e`: a 2099 row inserted directly, a normal live reading POSTed -> applied, block cleared |
| H3 | Verifier note: `skip_max` did not match the real DB-less skip count. Measured `bun run check-baseline` with no DB env: pass=3802 skip=345 fail=0 total=4147; `skip_max` 336 -> 345, corch-02 skip note updated. Passes DB-less and with the CI env. | `7f98e48` | `bun run check-baseline` both configurations |
| H4 | Doc: accepted residuals recorded (below) and in `docs/corch.md`. | this commit | n/a |

Also fixed: the F2 commit hash typo in `VERIFICATION.md` (`2a3e396`, not `2a38e0b`).

### Accepted residuals

- Supervisor rebinding between `resolveTarget` and the send (QC R3 #3, LOW): the binding is re-read at launch resolution but not across the later reservation and ledger awaits. One fixed account token per supervisor container (F4) preserves the binding across ordinary reconnects. Documented operational constraint, not an enforced invariant.
- Publisher-declared source trust (QC R3 #4, LOW): `source: live` and `fetched_at > blocked_at` are publisher-supplied clear provenance. Requires an explicit `quota:publish` key and affects only the key owner's own user.

### Deviations

- Scope fence: QC F5 edited `launch.ts` and `governed-launch.ts` (outside the original CORCH-02 file scope). The change is additive and opt-in (`targetSupervisorId` / `resolveTarget` apply to the corch launch only; other callers are unchanged).
- H1/H2 e2e tests live in the existing `corch-quota.e2e.test.ts`; the H2 test was committed with the H2 fix so each commit is green.
- Commit trailer: the harness attribution (Claude Sonnet 5.5) was used.

### Final checks (fresh DB on 127.0.0.1:55432, CI-equivalent env, each file in its own bun process)

All corch unit files (boot-assert 15, flag-off 5, gates 58, no-polling-guard 2, prompt 3, quota-binding 10, quota-death 18, quota-eligibility 37, quota-ingest 32, quota-selection 24, quota-wait 15, routes 13), guards (kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, launch-machine-guard 11, api-keys-scopes 37, mount-order 29) and e2e (corch-quota 20, corch-dispatcher 28) pass with 0 fail. `check-baseline` OK in both configurations: CI env fresh DB pass=4057 skip=0 fail=0; DB-less (no DB env) pass=3802 skip=345 fail=0 total=4147. Typecheck 253 errors (limit 253). `schema-lint` OK.
