---
phase: CORCH-02-quota-ingest
plan: 01
type: execute
wave: 1
depends_on: []            # CORCH-01 is already stacked on this branch; record its tip as BASE in Task 1
files_modified:
  - .planning/phases/CORCH-02-quota-ingest/CORCH-02-RESEARCH.md
  - hub/src/db/schema.sql
  - hub/src/auth/scopes.ts
  - hub/src/api/quota.ts
  - hub/src/index.ts
  - hub/src/csrf.ts
  - hub/src/corch/quota-store.ts
  - hub/src/corch/quota-eligibility.ts
  - hub/src/corch/quota-provider.ts
  - hub/src/corch/quota-death.ts
  - hub/src/corch/gates.ts
  - hub/src/corch/dispatcher.ts
  - hub/src/corch/store.ts
  - hub/src/corch/flag.ts
  - hub/src/ws/supervisor-protocol.ts
  - hub/src/ws/supervisor-registry.ts
  - hub/src/ws/agent.ts
  - hub/src/api/_openapi.ts
  - hub/test/corch-quota-ingest.test.ts
  - hub/test/corch-quota-eligibility.test.ts
  - hub/test/corch-quota-selection.test.ts
  - hub/test/corch-quota-wait.test.ts
  - hub/test/corch-quota-death.test.ts
  - hub/test/corch-boot-assert.test.ts
  - hub/test/corch-flag-off.test.ts
  - hub/test/api-keys-scopes.test.ts
  - hub/test/mount-order.test.ts
  - hub/test/csrf.test.ts
  - hub/test/e2e/corch-quota.e2e.test.ts
  - tools/regression-baseline.json
  - docs/corch.md
  - docs/openapi.json
  - docs/api.md
  - CLAUDE.md
autonomous: true
requirements: [CORCH-R2.1, CORCH-R2.2, CORCH-R2.3, CORCH-R2.4, CORCH-R2.5, CORCH-R2.6, CORCH-R2.7]

estimate:
  tokens: 230000
  raw_tokens: 230000
  tasks: 8
  confidence: low          # no calibration samples for CORCH phases

must_haves:
  truths:
    - "POST /api/quota/snapshot accepts a CUG usage-snapshot v1 body only from a Bearer api key whose scopes EXPLICITLY include quota:publish; a NULL/legacy key, any other scope set, or a cookie gets 401/403 (CORCH-R2.1, SC1)"
    - "A body carrying email, label or any unknown key at either level returns 400 and writes no row; the body is never logged (CORCH-R2.1, SC2)"
    - "corch_quota_accounts holds exactly one row per (user_id, account_id), upserted per POST, keyed by the key owner's user_id, never by anything in the body (CORCH-R2.1)"
    - "GET /api/quota/snapshot returns per-account eligibility for the key owner only, from a Bearer key with EXPLICIT quota:read; a quota:publish-only key gets 403 (CORCH-R2.2)"
    - "A quota:publish or quota:read key reaches no other route: /api/ext/*, /api/cloud-hook/*, /ws/agent and every cookie route refuse it (SC1)"
    - "Eligibility fails closed: row received > 600s ago, fetched_at null or > 900s old, source != live, CUG blocked, enabled=false, hub blocked_until in the future, null 7d, or max(5h,7d) >= REMO_CORCH_QUOTA_CEILING_PCT (default 55) each make the account ineligible with a quota:<reason> (CORCH-R2.3, SC3)"
    - "five_h_pct null is unknown, never 0: eligible only when 7d is known and below the ceiling, and only while the account has 0 other live CORCH runs (CORCH-R2.4, SC3)"
    - "With REMO_CORCH_ENABLED on, the real quota provider replaces DEFAULT_QUOTA_PROVIDER; per dispatch it picks the eligible account with the lowest max(5h,7d), tie-break account_id, among accounts with an online supervisor advertising that account_slot and a free slot, and records account_slot on corch_runs; a supervisor.hello without account_slot is never a target (CORCH-R2.7, SC4)"
    - "No eligible account => the item goes back to queued with wait_reason quota:<reason>, attempts unchanged, not_before = earliest time an account can become eligible or NULL when only an event can change it (CORCH-R2.6)"
    - "A run whose session ends on the CLI usage-limit/rate-limit signal marks its account blocked_until the reset, requeues the item with wait_reason quota:death and no attempt consumed, and skips the PR lookup (CORCH-R2.5, SC5)"
    - "Each successful snapshot POST triggers exactly one evaluateUserNow(userId); a 4xx triggers none; flag OFF => none (SC5)"
    - "No timer or poll is added: corch-no-polling-guard stays green unchanged; nothing in hub/src/corch or hub/src/api/quota.ts imports hub/src/usage/** or the threshold gate (CORCH-R2.3 CUG only)"
  artifacts:
    - path: hub/src/db/schema.sql
      provides: "CREATE TABLE IF NOT EXISTS corch_quota_accounts, appended after the corch block (after line 1833)"
    - path: hub/src/api/quota.ts
      provides: "createQuotaRoutes(deps) + default export; POST and GET /snapshot; route-local Bearer explicit-scope auth"
    - path: hub/src/corch/quota-store.ts
      provides: "upsertSnapshot, accountsFor, liveRunsByAccount, claimAccountSlot, markDeath"
    - path: hub/src/corch/quota-eligibility.ts
      provides: "evaluateAccounts(rows, opts) pure, no DB import; one function used by GET and the provider"
    - path: hub/src/corch/quota-provider.ts
      provides: "createQuotaProvider(deps); DEFAULT_QUOTA_PROVIDER unchanged for flag-OFF and tests"
    - path: hub/src/corch/quota-death.ts
      provides: "classifyQuotaDeath(text) pure, anchored on the researched CLI signal"
    - path: hub/test/e2e/corch-quota.e2e.test.ts
      provides: "real-Postgres proof of ingest, upsert, read, isolation, selection, death, clear"
  key_links:
    - from: hub/src/index.ts
      to: hub/src/api/quota.ts
      via: "app.route('/api/quota', ...) registered before the app.use('/api/*') auth catch-all, skipped in the catch-all, the license gate and the CSRF allowlist"
    - from: hub/src/api/quota.ts
      to: hub/src/corch/dispatcher.ts
      via: "successful POST -> deps.evaluate(userId) -> evaluateUserNow(userId) exactly once, flag-gated"
    - from: hub/src/corch/dispatcher.ts
      to: hub/src/corch/quota-provider.ts
      via: "realCorchDeps.quota = createQuotaProvider(...) replacing DEFAULT_QUOTA_PROVIDER (dispatcher.ts ~:726)"
    - from: hub/src/corch/gates.ts
      to: hub/src/corch/quota-provider.ts
      via: "corchQuotaGate passes runId + run.account_slot; provider records account_slot via claimAccountSlot"
    - from: hub/src/ws/agent.ts
      to: hub/src/ws/supervisor-registry.ts
      via: "hello handler (agent.ts:914) passes msg.account_slot and msg.max_concurrent into registerSupervisor"
    - from: hub/src/corch/dispatcher.ts
      to: hub/src/corch/quota-death.ts
      via: "onFinalize content / markFailed error -> classifyQuotaDeath before the PR lookup in handleRunEnd"
---

<objective>
Deliver CORCH-02 per PANEL-VERDICT F3: the hub ingests the CUG usage snapshot over an explicit-scope api-key route,
stores the latest reading per account slot in Postgres, serves per-account eligibility to explicit quota:read keys,
and, with REMO_CORCH_ENABLED on, replaces the CORCH-01 default quota provider with a real one that fails closed,
picks the account with the most headroom per dispatch, records account_slot on the run, waits (no attempt consumed)
when nothing is eligible, and blocks an account after a quota death until its reset.

Purpose: CORCH-01 refuses every dispatch with quota_no_snapshot. This phase makes CORCH dispatch possible on real
subscription headroom without ever launching on unknown or stale quota.

Output: one table, two scopes, one route file, four corch modules (store, eligibility, provider, death), additive
hello field and registry accessor, dispatcher wiring, unit + guard + real-Postgres e2e tests, docs, baseline note.

Not in this phase (CORCH-ROADMAP "Not in this phase"): the CUG publisher (CORCH-03), the AAF reader (CORCH-07), the
supervisor SENDING account_slot and any supervisor targeting (CORCH-09), any change to the threshold gate or the
oauth-poll usage store.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
Planning inputs (read by the planner; executor reads only what a task's read_first names):
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\CORCH-ROADMAP.md lines 185-210 (CORCH-02 section, SC1-SC5)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\CORCH-REQUIREMENTS.md lines 121-148 (CORCH-R2.1..R2.7)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\phases\CORCH-00-research\PANEL-VERDICT.md (F3 quota; F4 one Linux supervisor container per account slot advertising account_slot)
- C:\Users\artic\GitHub\remo-code-corch-planning\.planning\milestones\phases\CORCH-00-research\RESEARCH-cug-gsdconsole.md (CUG usage-snapshot v1 shape; live data shows five_h_pct null on every live entry; CUG treats unknown as eligible, the hub must not)
- .planning/phases/CORCH-01-backlog-dispatcher-core/CORCH-01-PLAN.md (format, DoD pattern, LD-1..LD-12)

Code anchors (verified at planning time on this worktree):
- hub/src/corch/quota-provider.ts: QuotaSnapshot = {ok:true, account_slot, supervisor_id} | {ok:false, reason}; QuotaProvider.snapshotFor({userId, projectId, workItemId}); DEFAULT_QUOTA_PROVIDER refuses quota_no_snapshot.
- hub/src/corch/gates.ts:56-67 corchQuotaGate: contextFor(store, req) gives ctx.run (incl. account_slot, user_id, id), ctx.project, ctx.item; success currently ignores account/supervisor.
- hub/src/corch/dispatcher.ts: CorchDeps.quota :115; refusalSchedule + toNotBefore :186-221 (MIDNIGHT_PREFIXES, inject-rate plus_60m, autospawn_launch_ plus_lease); refuseRun :303-314 -> store.endRunAndRequeue(runId, {endReason, consumeAttempt:false, waitReason, notBefore}); endFailure :324; handleRunEnd :345 (PR lookup then no_pr / pr_lookup_unavailable); RunStore markFailed/onFinalize :393-394 (both currently drop the text argument); realCorchDeps `quota: DEFAULT_QUOTA_PROVIDER` ~:726 (real deps are reached by dynamic import, LD-2); triggers evaluateUserNow / onSupervisorHello / onSupervisorClosed / onKillSwitchReleased after ~:780, each a no-op before any DB access when the flag is OFF.
- hub/src/corch/store.ts: NotBefore type :74 = null | {midnightTz} | {plusSeconds}; endRunAndRequeue CASE :306-316; earliestFutureNotBefore :151/:390 (the existing single scheduler consumes any future not_before); LiveRun.account_slot :51.
- hub/src/corch/flag.ts: corchEnabled, corchLeaseMs, corchReconcileIntervalMs, assertCorchConfig (refuses CORCH + ORCHESTRATOR both on).
- hub/src/db/schema.sql:1766-1833 corch tables; corch_work_items.wait_reason TEXT NULL (:1793); corch_runs.end_reason TEXT NULL (:1818); corch_runs.account_slot TEXT NULL already exists.
- hub/src/api/cloud-hook.ts:4-53: the Bearer explicit-scope pattern to copy (regex `^(remokey_|remo_)[A-Za-z0-9_-]+$`, hashToken, verifyApiKeyFull, hasExplicitScope, 401 {error:'unauthorized'}, 403 {error:'insufficient_scope', required}).
- hub/src/index.ts: header comment :120 lists cloud-hook; cloud-hook mount :283-284 (rateLimit windowMs 60_000 max 120 keyFn authorization slice 0..24); auth catch-all :300-316 (skip `/api/cloud-hook/` :306); license gate skip list :325-334 (`/api/cloud-hook/` :332); assertCorchConfig import :73.
- hub/src/csrf.ts:28-36 CSRF_PATH_ALLOWLIST (cloud-hook regex :33).
- hub/src/auth/scopes.ts: SCOPE_* :20-61, ALL_SCOPES :63, hasScope :84 (NULL-permissive), hasExplicitScope :96, normalizeScopes :101.
- hub/src/auth/ext-api-key-middleware.ts: all /api/ext/* need ext:read via hasScope, so a quota-only key cannot use /api/ext (that is why quota gets its own mount).
- hub/src/ws/supervisor-protocol.ts:5-17 SupervisorHello z.object (max_concurrent optional int positive).
- hub/src/ws/supervisor-registry.ts: registerSupervisor :205, unregisterSupervisor :250, isSupervisorOnline :282, listOnlineSupervisorIdsForUser :286.
- hub/src/ws/agent.ts:914 registerSupervisor({ws, supervisorId, userId, apiKeyId, roots, hostname}); :915 corch hello hook; :1411-1412 unregister + close hook.
- hub/src/dispatch/pipeline.ts:68-69 RunStore.onFinalize(token, content) / markFailed(token, error); callers :476, :571, :618.
- Planning grep: zero matches for usage-limit / rate-limit end text anywhere in hub/src or supervisor/src. The quota-death signal is an open research item resolved in Task 1, not assumed.
- Tests present: hub/test/{api-keys-scopes, mount-order, csrf, corch-boot-assert, corch-flag-off, corch-gates, corch-prompt, corch-routes, corch-no-polling-guard, kill-switch-coverage, token-cap-coverage, counter-key-assignment-guard, launch-callers-guard}.test.ts; hub/test/e2e/{corch-dispatcher, schema-double-apply}.e2e.test.ts. api-keys-scopes.test.ts:238-281 "ext:corch is an EXPLICIT-only scope" is the pattern to copy; mount-order.test.ts:106/:115 public-before-catch-all list (incl. /api/cloud-hook/reply) and :230 CSRF-skip describe.
- Baseline: `bun run check-baseline` (tools/check-baseline.ts, per-file isolation). tools/regression-baseline.json today: actual pass=3643 skip=323 fail=0 total=3966; tolerance pass_min 1850, skip_max 323, fail_max 0; precedent key `_skip_note_corch_01`.
- Scripts: root package.json docs:sync, check-baseline, migration-verify, schema-lint, orchestrator:e2e; hub typecheck = `tsc --noEmit -p tsconfig.json`.
</context>

<definition_of_done>
All commands run from the worktree root C:\Users\artic\GitHub\remo-code-phase-corch-02-quota-ingest unless stated.
E2E_URL = a disposable Postgres (image from .woodpecker/qc.yaml, postgres:16) on a free local port with a throwaway
password generated in-shell. If no disposable Postgres can be started, record BLOCKER in the SUMMARY and let CI
qc.yaml be the proof; never claim green from skipped tests. BASE = the sha recorded in CORCH-02-RESEARCH.md.

1. `bun run schema-lint` exits 0.
2. `bun run migration-verify` exits 0.
3. `REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/schema-double-apply.e2e.test.ts` passes with 0 skipped.
4. No destructive DDL: `git diff $BASE -- hub/src/db/schema.sql | grep "^+" | grep -ciE "\bdrop\b|\btruncate\b|alter column .* type"` prints 0.
5. Unit files, each its own process, all pass: `bun test hub/test/corch-quota-ingest.test.ts`, `bun test hub/test/corch-quota-eligibility.test.ts`, `bun test hub/test/corch-quota-selection.test.ts`, `bun test hub/test/corch-quota-wait.test.ts`, `bun test hub/test/corch-quota-death.test.ts`, `bun test hub/test/corch-boot-assert.test.ts`, `bun test hub/test/corch-flag-off.test.ts`, `bun test hub/test/csrf.test.ts`, plus the untouched CORCH-01 files `bun test hub/test/corch-gates.test.ts`, `bun test hub/test/corch-prompt.test.ts`, `bun test hub/test/corch-routes.test.ts`.
6. Guards, each its own process, all pass: `bun test hub/test/kill-switch-coverage.test.ts`, `bun test hub/test/token-cap-coverage.test.ts`, `bun test hub/test/counter-key-assignment-guard.test.ts`, `bun test hub/test/launch-callers-guard.test.ts`, `bun test hub/test/corch-no-polling-guard.test.ts`, `bun test hub/test/api-keys-scopes.test.ts`, `bun test hub/test/mount-order.test.ts`.
7. Corch e2e with 0 skipped: `REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/corch-quota.e2e.test.ts` and `REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/corch-dispatcher.e2e.test.ts`.
8. `bun run orchestrator:e2e` passes (flag OFF path untouched).
9. `bun run check-baseline` exits 0 with tools/regression-baseline.json updated per Task 8.
10. `bun run docs:sync && git diff --exit-code -- docs/openapi.json docs/api.md` exits 0 (docs regenerated and committed).
11. Typecheck delta: `cd hub && bun run typecheck 2>&1 | grep -c "error TS"` <= N0 (recorded in Task 1), and `cd hub && bun run typecheck 2>&1 | grep -E "src/(corch/|api/quota|ws/supervisor-|ws/agent\.ts)" | grep -c "error TS"` prints 0.
12. Scope fence: `git diff --name-only $BASE...HEAD` lists only paths in files_modified; `git diff $BASE -- hub/src/usage hub/src/dispatch hub/src/orchestrator hub/src/heal supervisor hub/src/ws/agent-protocol.ts .planning/ROADMAP.md .planning/STATE.md .planning/REQUIREMENTS.md | wc -l` prints 0.
</definition_of_done>

<do_not_touch>
- thresholdGate and everything under hub/src/usage/** (the oauth-poll usage store); the usage_report frame in hub/src/ws/agent-protocol.ts:150-170 is display-only and is never read by CORCH (CORCH-R2.3: CUG only).
- hub/src/dispatch/** bodies (pipeline.ts RunStore contract is consumed, not changed), hub/src/orchestrator/**, hub/src/heal/**, supervisor/** (the supervisor sending account_slot is CORCH-09).
- hub/src/sessions/budget.ts slot accounting: "free slot" for an account is computed from live corch_runs, not from reserveSessionSlot.
- .planning/ROADMAP.md, .planning/STATE.md, .planning/REQUIREMENTS.md (PTYCAP-owned).
- Production env and flags: REMO_CORCH_ENABLED stays OFF everywhere; no Coolify env change; no prod deploy from this phase.
- DEFAULT_QUOTA_PROVIDER behavior and its quota_no_snapshot reason (CORCH-01 tests pin it).
</do_not_touch>

<locked_design>
LD-Q1 (mount, R2.1/R2.2): `app.use('/api/quota/*', rateLimit({windowMs: 60_000, max: 120, keyFn: authorization slice 0..24}))` + `app.route('/api/quota', quotaRoutes)` placed directly after the cloud-hook mount (index.ts :283-284), i.e. before the auth catch-all. `/api/quota/` is added to the catch-all skip list (:306), the license-gate skip list (:332) and the CSRF allowlist (csrf.ts :33). Auth is route-local, copied from cloud-hook.ts:40-53. Cookies never authenticate these routes.

LD-Q2 (scopes, R2.1/R2.2): new SCOPE_QUOTA_PUBLISH = 'quota:publish' and SCOPE_QUOTA_READ = 'quota:read' in scopes.ts, added to ALL_SCOPES (so existing key minting accepts them), checked ONLY with hasExplicitScope. POST needs quota:publish, GET needs quota:read; neither implies the other. hasScope is never used for them.

LD-Q3 (payload, R2.1): strict Zod at both levels (`.strict()`): top level {schema: literal 1, publisher: literal 'cug', generated_at: ISO datetime with offset, poll_interval_secs: int 1..86400, accounts: array 0..32}; account {account_id: /^[A-Za-z0-9_-]{1,64}$/, slot: string or int (max 64 chars), five_h_pct and seven_d_pct: finite 0..1000 or null, resets_5h, resets_7d, fetched_at: ISO datetime or null, source: string 1..32, enabled, blocked, current: boolean}. email, label and any unknown key => 400 {error:'invalid_snapshot'} with no issue values echoed and nothing logged except user id + error code. Bodies over 64 KiB => 413 before parse (hono built-in body-limit middleware, no new package). `current` is validated and not stored.

LD-Q4 (table, R2.1): corch_quota_accounts(user_id same type as corch_projects.user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id TEXT NOT NULL, slot TEXT NULL, five_h_pct NUMERIC NULL, seven_d_pct NUMERIC NULL, resets_5h TIMESTAMPTZ NULL, resets_7d TIMESTAMPTZ NULL, fetched_at TIMESTAMPTZ NULL, source TEXT NOT NULL, enabled BOOLEAN NOT NULL, cug_blocked BOOLEAN NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(), blocked_until TIMESTAMPTZ NULL, blocked_at TIMESTAMPTZ NULL, PRIMARY KEY (user_id, account_id)). CREATE TABLE IF NOT EXISTS, appended after schema.sql:1833. No extra index (PK covers every query). No email column exists, ever.

LD-Q5 (upsert, R2.1): one transaction per POST; INSERT ... ON CONFLICT (user_id, account_id) DO UPDATE every CUG field and received_at = now(). Hub-owned blocked_until / blocked_at are preserved, except a NULL-until block (blocked_at set, blocked_until NULL) clears when the incoming fetched_at > blocked_at. A time-bounded block is never cleared by a snapshot. Rows for accounts absent from later POSTs are kept and age out via LD-Q6 (fail closed). user_id always comes from the verified key.

LD-Q6 (eligibility, R2.3/R2.4): hub/src/corch/quota-eligibility.ts exports evaluateAccounts(rows, {now, ceilingPct, busyByAccount}) -> per row {account_id, eligible, reason, not_before}. Pure, no DB import, first failing rule wins, in this order:
  1. no rows at all -> the caller reports quota:no_snapshot
  2. now - received_at > 600 s -> quota:snapshot_stale (per row, so a stale latest POST makes every account stale)
  3. fetched_at null, or now - fetched_at > 900 s, or fetched_at more than 60 s in the future -> quota:account_stale
  4. source !== 'live' -> quota:source_not_live
  5. cug_blocked -> quota:cug_blocked
  6. enabled false -> quota:cug_disabled
  7. blocked_until > now, or blocked_at set with blocked_until NULL -> quota:blocked (not_before = blocked_until or NULL)
  8. seven_d_pct null -> quota:seven_d_unknown
  9. max of the known pcts >= ceilingPct -> quota:over_ceiling (not_before = reset of the window(s) at or over the ceiling, the later one if both; NULL if that reset is null or past)
  10. five_h_pct null and busyByAccount[account_id] >= 1 -> quota:five_h_unknown_busy
  The same function feeds GET (R2.2) and the provider; there is exactly one copy of the rules.

LD-Q7 (ceiling): REMO_CORCH_QUOTA_CEILING_PCT, default 55 when unset. corchQuotaCeilingPct() in flag.ts returns the number or throws on non-numeric, <= 0 or > 100 (no silent default on a bad value). assertCorchConfig calls it only when corchEnabled(), so a bad value refuses boot with CORCH on; with CORCH off, GET answers 500 {error:'quota_ceiling_invalid'}.

LD-Q8 (selection, R2.7): createQuotaProvider(deps) where deps = {accountsFor(userId), liveRunsByAccount(userId, excludeRunId), onlineSlotSupervisors(userId), claimAccountSlot(runId, userId, accountId, capacity), now(), ceilingPct()}. snapshotFor gains optional runId and accountSlot args (additive). Capacity of an account = the largest max_concurrent (default 1) among online supervisors whose hello advertised account_slot === account_id; five_h null caps capacity at 1. Candidate = eligible per LD-Q6 AND capacity > busy. If the run already has an account_slot, only that account is considered (a run is never moved across accounts). Pick lowest max(5h ?? 7d, 7d), tie-break account_id ascending. claimAccountSlot is one conditional UPDATE (sets corch_runs.account_slot only when it is NULL, the run is live, and the account's other live runs < capacity); 0 rows => refuse quota:slot_taken. Success returns {ok:true, account_slot, supervisor_id:null}. No supervisor targeting (CORCH-09). No candidate => if every account shares one reason use it, if accounts are eligible but none has an online slot supervisor with a free slot use quota:no_slot_supervisor, else quota:no_eligible_account; no rows => quota:no_snapshot.

LD-Q9 (wait, R2.6): refusalSchedule maps the `quota:` prefix to kind 'quota'. refuseRun resolves it with deps.quota.earliestEligibleAt?.(userId): the minimum future not_before across ineligible accounts when EVERY ineligible account carries one, else NULL (an event - snapshot POST, supervisor hello/close, run end - must re-evaluate). NotBefore gains variant {at: string} (ISO); store.ts CASE gets one branch for it. wait_reason = the refusal reason (already quota:<reason>); consumeAttempt false. earliestEligibleAt is optional on QuotaProvider; missing => NULL (DEFAULT unchanged).

LD-Q10 (quota death, R2.5): classifyQuotaDeath(text) -> {resetAt: Date | null} | null, pure, anchored on the exact CLI signal established in Task 1 (whole trimmed text must match, max 500 chars; a long assistant message that merely mentions a usage limit is NOT a death). Applied to the onFinalize content and the markFailed error. On a match, before the PR lookup: if run.account_slot is set, deps.quota.markDeath?.({userId, accountId, resetAt}) sets blocked_at = now() and blocked_until = resetAt from the signal, else the earliest future of the row's resets_5h / resets_7d, else NULL (cleared only per LD-Q5). Then endRunAndRequeue {endReason:'quota_death', consumeAttempt:false, waitReason:'quota:death', notBefore: blocked_until ? {at} : null}. account_slot NULL => same requeue, no account block.

LD-Q11 (trigger, event-driven): createQuotaRoutes deps.evaluate(userId) is called exactly once after a successful POST commit. Default wiring: when corchEnabled(), dynamic import of ../corch/dispatcher.ts then evaluateUserNow(userId), errors logged as one warn line without body data (mirrors agent.ts:915); when the flag is OFF it returns without importing. No timer, no poll, no retry loop anywhere in this phase.

LD-Q12 (hello, R2.7): SupervisorHello gains optional account_slot (same regex as account_id). The registry stores accountSlot (null when absent) and maxConcurrent (hello max_concurrent, default 1) and exposes listOnlineSlotSupervisorsForUser(userId) -> [{supervisorId, accountSlot, maxConcurrent}] containing only entries with a non-null accountSlot. agent.ts:914 passes the two fields through; no other agent.ts change.

LD-Q13 (import discipline, LD-2 carry-over): quota-eligibility.ts, quota-provider.ts and quota-death.ts import no DB module at top level. realCorchDeps reaches quota-store.ts by the same dynamic import it uses for the store. hub/src/api/quota.ts imports quota-store.ts statically (it is outside the LD-2 file set, like cloud-hook).
</locked_design>

<tasks>

<task type="tracer">
  <name>Task 1: Tracer - research record, then publish -> store -> read on real Postgres (one path)</name>
  <files>.planning/phases/CORCH-02-quota-ingest/CORCH-02-RESEARCH.md, hub/src/db/schema.sql, hub/src/auth/scopes.ts, hub/src/corch/quota-store.ts, hub/src/corch/quota-eligibility.ts, hub/src/api/quota.ts, hub/src/index.ts, hub/src/csrf.ts, hub/test/e2e/corch-quota.e2e.test.ts</files>
  <read_first>hub/src/api/cloud-hook.ts, hub/src/corch/store.ts (db client import and transaction style only), hub/test/e2e/corch-dispatcher.e2e.test.ts (env gating, schema apply, user + key fixtures), hub/src/dispatch/pipeline.ts lines 400-630 (what text reaches onFinalize / markFailed)</read_first>
  <action>
  Step A, research before code (write .planning/phases/CORCH-02-quota-ingest/CORCH-02-RESEARCH.md, plain sections, no secrets):
  (1) BASE = output of git rev-parse HEAD before any edit. (2) N0 = cd hub, bun run typecheck, count of "error TS" lines. (3) Q1 quota-death signal: trace pipeline.ts :571 (markFailed reason) and :618 (onFinalize content) back to the ws frames in hub/src/ws/agent.ts that produce them, and establish from a primary source (Claude Code CLI docs/changelog URL, or a file:line in the CLI output the supervisor relays) the exact end text the CLI emits on a subscription usage limit and on an API 429 rate limit, and how the reset time is encoded. Record: channel (content or error), anchored pattern(s), reset encoding, and two verbatim sample strings for tests. Planning grep found no such handling in hub/src or supervisor/src today. If no hub-visible channel carries the signal, write "Q1: NO HUB-VISIBLE SIGNAL", file the 7d ticket (autofix-report remo-code with the trace), escalate per 7c-LOOP, mark R2.5 BLOCKED in the research file, and continue Tasks 1-5, 7 (minus death cases) and 8; never invent a signal. (4) Q2: confirm wait_reason (schema.sql:1793) and end_reason (:1818) carry no CHECK constraint, so quota_death and quota:<reason> need no constraint change.
  Step B, the thin path (per LD-Q1..LD-Q6, LD-Q13):
  - schema.sql: append the corch_quota_accounts table exactly per LD-Q4 after line 1833, idempotent, additive only, comment line naming CORCH-02 and "latest reading per account slot; no email column". Keep comments free of destructive-DDL keywords (DoD 4 greps them).
  - scopes.ts: add the two constants and append them to ALL_SCOPES (LD-Q2).
  - quota-store.ts: upsertSnapshot(userId, snapshot) in one transaction per LD-Q5; accountsFor(userId) returning every column; liveRunsByAccount(userId, excludeRunId) counting corch_runs with ended_at NULL grouped by account_slot. Same db client and tagged-SQL style as store.ts.
  - quota-eligibility.ts: evaluateAccounts with rules 2 and 4 of LD-Q6 only in this task (Task 3 completes the ordered table in the same function; signature is final now).
  - api/quota.ts: createQuotaRoutes(deps) with deps {verifyKey, store, ceilingPct, evaluate, now} and a default export built from real deps (evaluate is a no-op stub in this task; Task 5 wires it). Route-local auth copied from cloud-hook.ts:40-53 with SCOPE_QUOTA_PUBLISH for POST /snapshot and SCOPE_QUOTA_READ for GET /snapshot. POST: Zod schema per LD-Q3, upsert, 200 {ok:true, accepted:n}. GET: accountsFor + evaluateAccounts, 200 {ceiling_pct, accounts:[{account_id, slot, eligible, reason, not_before, five_h_pct, seven_d_pct, resets_5h, resets_7d, fetched_at, source, received_at, blocked_until}]}; no rows => accounts [].
  - index.ts: mount per LD-Q1 directly after :284; add `/api/quota/` to the skip lists at :306 and :332; add the route to the header comment near :120. csrf.ts: add the /^\/api\/quota\// entry beside :33 with a short comment (api-key authed, quota:publish / quota:read).
  - e2e tracer (hub/test/e2e/corch-quota.e2e.test.ts, gated on REMO_E2E_DB_URL exactly like corch-dispatcher.e2e): apply schema, create a user and two keys via the DAL (scopes ['quota:publish'] and ['quota:read']), POST one live account through app.request against the real app, assert 200 and one row, GET with the read key and assert that account appears with eligible true when its pcts are under 55.
  </action>
  <verify>
    <automated>bun run schema-lint && bun run migration-verify && REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/corch-quota.e2e.test.ts</automated>
  </verify>
  <done>CORCH-02-RESEARCH.md records BASE, N0, Q1 (signal or BLOCKED), Q2. A real POST with a quota:publish key stores one row in corch_quota_accounts on real Postgres and a real GET with a quota:read key returns it; schema-lint and migration-verify exit 0.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Ingest auth, strictness and isolation pins (SC1, SC2; R2.1, R2.2)</name>
  <files>hub/test/corch-quota-ingest.test.ts, hub/test/api-keys-scopes.test.ts, hub/test/mount-order.test.ts, hub/test/csrf.test.ts, hub/src/api/quota.ts</files>
  <read_first>hub/test/api-keys-scopes.test.ts lines 238-300, hub/test/mount-order.test.ts lines 95-130 and 225-260, hub/test/csrf.test.ts (allowlist case shape)</read_first>
  <behavior>
    - corch-quota-ingest (createQuotaRoutes with fake verifyKey/store/evaluate): no header, malformed Bearer, unknown key => 401; NULL-scope legacy key => 403 on POST and GET; key with every other scope but no quota:* => 403; quota:read key POST => 403 {required:'quota:publish'}; quota:publish key GET => 403 {required:'quota:read'}.
    - Valid v1 body with 2 accounts => 200 {ok:true, accepted:2}; store.upsertSnapshot called once with the key owner's user id (a user_id field in the body is itself an unknown key => 400).
    - email at account level, email at top level, label at account level, an unknown key at each level, schema 2, publisher 'other', 33 accounts, five_h_pct -1, account_id with a dot or 65 chars => 400 {error:'invalid_snapshot'}, store never called.
    - A body over 64 KiB => 413, store never called.
    - A 400 with email "probe-x@example.invalid" and account_id "probe_acct_9": captured console output contains neither string.
    - GET returns only the fake rows for the key owner and never an email or label field.
    - api-keys-scopes: new describe "quota:publish and quota:read are EXPLICIT-only scopes" copying the ext:corch pattern: hasExplicitScope true only when listed; hasScope stays NULL-permissive for others; a ['quota:publish'] key and a ['quota:read'] key are refused by /api/ext/*, /api/cloud-hook/reply, /ws/agent and a representative cookie route, and each is refused by the other quota method.
    - mount-order: '/api/quota/snapshot' joins the public-before-catch-all list; unauthenticated POST and GET return the route's 401 JSON, not 404 and not a CSRF 403; :230 CSRF-skip describe covers POST /api/quota/snapshot without Origin.
    - csrf: /api/quota/snapshot is allowlisted; /api/quotas/x (near-miss) is not.
  </behavior>
  <action>Write the tests first and run them red, then make only the route changes they demand in hub/src/api/quota.ts (LD-Q1, LD-Q2, LD-Q3). Error responses never echo Zod issue values; the only log line on a 4xx is user id (when known) plus the error code. Do not loosen any existing api-keys-scopes or mount-order assertion.</action>
  <verify>
    <automated>bun test hub/test/corch-quota-ingest.test.ts && bun test hub/test/api-keys-scopes.test.ts && bun test hub/test/mount-order.test.ts && bun test hub/test/csrf.test.ts</automated>
  </verify>
  <done>All four files pass as separate processes; every behavior above has a named test; no existing assertion was weakened.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Full eligibility table + ceiling env + CUG-only guard (SC3; R2.3, R2.4)</name>
  <files>hub/src/corch/quota-eligibility.ts, hub/src/corch/flag.ts, hub/test/corch-quota-eligibility.test.ts, hub/test/corch-boot-assert.test.ts</files>
  <read_first>hub/test/corch-boot-assert.test.ts</read_first>
  <behavior>
    - Table-driven, fixed now: received_at 599 s eligible / 601 s quota:snapshot_stale; fetched_at 899 s eligible / 901 s quota:account_stale / null quota:account_stale / 61 s in the future quota:account_stale; source scope_blind and fetch_failed => quota:source_not_live; cug_blocked => quota:cug_blocked; enabled false => quota:cug_disabled; blocked_until in the future => quota:blocked with not_before = blocked_until; blocked_until past => eligible; blocked_at set + blocked_until NULL => quota:blocked, not_before NULL; seven_d NULL => quota:seven_d_unknown; 7d 55 with ceiling 55 => quota:over_ceiling not_before resets_7d; 5h 60 and 7d 60 => not_before = later reset; 5h 54.9 7d 54.9 => eligible; 5h NULL 7d 20 busy 0 => eligible; 5h NULL 7d 20 busy 1 => quota:five_h_unknown_busy; 5h 10 7d 20 busy 3 => eligible (busy cap only for null 5h); rule order: a row both stale and over ceiling reports quota:snapshot_stale.
    - Every row of the table carries the reason string exactly; R2.3/R2.4 IDs appear in the describe names.
    - CUG-only guard: parse every import specifier in hub/src/corch/**/*.ts and hub/src/api/quota.ts; none resolves into hub/src/usage/ and none binds the threshold-gate export (match import statements only, so comments cannot trip it).
    - Boot assert: CORCH on + ceiling unset => ok (55); '70' => ok; 'abc', '0', '-5', '101' => assertCorchConfig throws naming REMO_CORCH_QUOTA_CEILING_PCT; CORCH off + 'abc' => assertCorchConfig does not throw.
  </behavior>
  <action>Tests first (red), then complete evaluateAccounts with the full ordered rule list of LD-Q6 in the existing function and add corchQuotaCeilingPct() plus the CORCH-on-only check inside assertCorchConfig per LD-Q7. The GET handler from Task 1 already calls evaluateAccounts; wire its ceilingPct dep to corchQuotaCeilingPct and return 500 {error:'quota_ceiling_invalid'} when it throws.</action>
  <verify>
    <automated>bun test hub/test/corch-quota-eligibility.test.ts && bun test hub/test/corch-boot-assert.test.ts && bun test hub/test/corch-quota-ingest.test.ts</automated>
  </verify>
  <done>Every LD-Q6 rule and boundary is a passing table row; ceiling env validated at boot only with CORCH on; the CUG-only import guard passes.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 4: Hello account_slot, registry accessor, real provider selection and recording (SC4; R2.7)</name>
  <files>hub/src/ws/supervisor-protocol.ts, hub/src/ws/supervisor-registry.ts, hub/src/ws/agent.ts, hub/src/corch/quota-provider.ts, hub/src/corch/quota-store.ts, hub/src/corch/gates.ts, hub/test/corch-quota-selection.test.ts</files>
  <read_first>hub/src/ws/supervisor-registry.ts lines 190-300, hub/test/corch-gates.test.ts (fake store / fake quota shapes)</read_first>
  <behavior>
    - SupervisorHello parses without account_slot (absent), with 'acct_a', and rejects 'a.b', '' and a 65-char value.
    - Registry: two online supervisors, one with accountSlot 'acct_a' maxConcurrent 2, one without => listOnlineSlotSupervisorsForUser returns only the first; after unregister it returns none.
    - Selection with fakes: accounts a (max 30), b (max 10), c (max 10) all eligible with slot supervisors => picks b (lowest, tie-break account_id over c); b has no online supervisor => picks c; b's supervisor full (busy 2, maxConcurrent 2) => picks c; only a supervisor without account_slot online => quota:no_slot_supervisor; null-5h account with busy 1 and maxConcurrent 3 => skipped; run already carrying account_slot 'a' => only a is considered, and a ineligible => refuse with a's reason (never moved).
    - Success returns {ok:true, account_slot, supervisor_id:null} and calls claimAccountSlot once with the chosen capacity; claimAccountSlot false => quota:slot_taken.
    - No rows => quota:no_snapshot; all accounts over ceiling => quota:over_ceiling; mixed reasons => quota:no_eligible_account.
    - earliestEligibleAt: two accounts over ceiling with resets T1 < T2 => T1; one over ceiling + one stale => NULL.
    - corchQuotaGate passes runId and ctx.run.account_slot to snapshotFor; existing corch-gates tests still pass unchanged.
  </behavior>
  <action>Tests first. Then per LD-Q12: optional account_slot on SupervisorHello; registry entry fields accountSlot and maxConcurrent set in registerSupervisor; new listOnlineSlotSupervisorsForUser; agent.ts:914 passes msg.account_slot and msg.max_concurrent only. Per LD-Q8: createQuotaProvider(deps) in quota-provider.ts (DEFAULT_QUOTA_PROVIDER left as is; QuotaProvider gains optional earliestEligibleAt and markDeath members, and snapshotFor args gain optional runId and accountSlot); claimAccountSlot in quota-store.ts as the single conditional UPDATE described in LD-Q8; gates.ts passes the two extra args and keeps its refusal behavior. Add no timers (corch-no-polling-guard must stay unchanged).</action>
  <verify>
    <automated>bun test hub/test/corch-quota-selection.test.ts && bun test hub/test/corch-gates.test.ts && bun test hub/test/corch-no-polling-guard.test.ts</automated>
  </verify>
  <done>SC4 proven: lowest max(5h,7d) wins with account_id tie-break, only online slot supervisors with a free slot qualify, a hello without account_slot is never a target, and the chosen account_slot is recorded on the run.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 5: Dispatcher wiring - real provider behind the flag, quota wait with not_before, POST triggers one evaluation (SC5 spy; R2.6)</name>
  <files>hub/src/corch/dispatcher.ts, hub/src/corch/store.ts, hub/src/api/quota.ts, hub/test/corch-quota-wait.test.ts, hub/test/corch-quota-ingest.test.ts, hub/test/corch-flag-off.test.ts</files>
  <read_first>hub/src/corch/dispatcher.ts lines 180-320 and 700-800, hub/test/corch-flag-off.test.ts</read_first>
  <behavior>
    - refusalSchedule: 'quota:over_ceiling' and every quota: reason => kind 'quota'; existing midnight / plus_60m / plus_lease mappings and 'quota_no_snapshot' unchanged (assert each existing case still maps as before).
    - refuseRun on a quota refusal with fake deps.quota.earliestEligibleAt returning T => endRunAndRequeue called with {consumeAttempt:false, waitReason:'quota:over_ceiling', notBefore:{at:T ISO}}; returning NULL => notBefore null; provider without earliestEligibleAt => null.
    - store NotBefore {at} branch: covered for real in Task 7 e2e (not_before equals the given instant).
    - Ingest spy: one successful POST => deps.evaluate called exactly once with the key owner's user id; three POSTs => three calls; 400, 401, 403, 413 => zero calls.
    - Default evaluate wiring with REMO_CORCH_ENABLED unset: a successful POST stores the row and does not import the dispatcher module (corch-flag-off adds this case beside its existing no-DB-access cases).
  </behavior>
  <action>Tests first. Per LD-Q9: add {at} to NotBefore and one CASE branch in endRunAndRequeue (store.ts :306-316); add the quota: prefix to refusalSchedule; refuseRun resolves the quota kind via deps.quota.earliestEligibleAt?.(userId). Per the F3 provider swap: in realCorchDeps replace DEFAULT_QUOTA_PROVIDER with createQuotaProvider whose deps come from quota-store.ts (dynamic import, LD-Q13), the registry accessor, Date, and corchQuotaCeilingPct. Per LD-Q11: replace the Task 1 evaluate stub in api/quota.ts with the flag-gated dynamic-import call to evaluateUserNow, invoked once after the upsert commits. No timer, no retry.</action>
  <verify>
    <automated>bun test hub/test/corch-quota-wait.test.ts && bun test hub/test/corch-quota-ingest.test.ts && bun test hub/test/corch-flag-off.test.ts && bun test hub/test/corch-no-polling-guard.test.ts && bun test hub/test/corch-routes.test.ts</automated>
  </verify>
  <done>With the flag on the dispatcher uses the real provider; a quota refusal requeues with quota:<reason>, no attempt, and the earliest-eligible not_before or NULL; every successful POST triggers exactly one evaluation and none when the flag is off.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 6: Quota death blocks the account until reset and requeues without an attempt (SC5; R2.5)</name>
  <precondition>CORCH-02-RESEARCH.md Q1 names a hub-visible channel, anchored pattern and reset encoding; if it reads "NO HUB-VISIBLE SIGNAL" this task is BLOCKED (already ticketed in Task 1) and is skipped.</precondition>
  <files>hub/src/corch/quota-death.ts, hub/src/corch/dispatcher.ts, hub/src/corch/quota-store.ts, hub/src/corch/quota-provider.ts, hub/test/corch-quota-death.test.ts</files>
  <read_first>.planning/phases/CORCH-02-quota-ingest/CORCH-02-RESEARCH.md (Q1 only)</read_first>
  <behavior>
    - classifyQuotaDeath: each verbatim sample from Q1 => match with the encoded reset parsed to a Date (or null when the signal carries none); the same sample embedded in a 2,000-char assistant message => null; empty string and an ordinary 'no PR opened' message => null.
    - handleRunEnd with finalize content = a death sample and run.account_slot 'acct_a': deps.quota.markDeath called once with {userId, accountId:'acct_a', resetAt}; endRunAndRequeue called with {endReason:'quota_death', consumeAttempt:false, waitReason:'quota:death', notBefore:{at: blocked_until}}; the PR lookup fake is never called.
    - markFailed with error = a death sample => same as above; markFailed with any other error => existing dispatch_failed path unchanged.
    - run.account_slot NULL => no markDeath call, requeue with no attempt, notBefore null.
    - quota-store markDeath (unit with fake sql or covered in Task 7 e2e): resetAt given => blocked_until = resetAt; resetAt null => earliest future of resets_5h / resets_7d; none future => blocked_until NULL and blocked_at now.
  </behavior>
  <action>Tests first using the Q1 samples verbatim. Implement classifyQuotaDeath per LD-Q10 in the new pure module. In dispatcher.ts change the RunStore wiring at :393-394 so onFinalize and markFailed hand their text to the death check before the existing paths, and in handleRunEnd run the check before the PR lookup. Add markDeath to quota-store.ts (single UPDATE per LD-Q10) and expose it through createQuotaProvider. Never log the content or error text beyond the classification result.</action>
  <verify>
    <automated>bun test hub/test/corch-quota-death.test.ts && bun test hub/test/corch-quota-wait.test.ts && bun test hub/test/corch-gates.test.ts</automated>
  </verify>
  <done>A quota death sets blocked_until (or the NULL-until block), requeues with quota:death and no attempt consumed, skips the PR lookup; non-death endings behave exactly as in CORCH-01.</done>
</task>

<task type="auto">
  <name>Task 7: Real-Postgres e2e - full matrix (R2.1-R2.7 on a real DB)</name>
  <files>hub/test/e2e/corch-quota.e2e.test.ts</files>
  <read_first>none beyond Task 1 (same file)</read_first>
  <action>Extend the tracer e2e (same REMO_E2E_DB_URL gating, DATABASE_URL pointed at the same DB) with: schema applied twice then table present; repeated POST keeps one row per account and advances received_at; POST with email, with label, with an unknown key => 400 and row count unchanged; user B's quota:read key sees none of user A's rows; GET with a publish key => 403; a corch project / work item / run fixture as in corch-dispatcher.e2e, then createQuotaProvider with the real quota-store and a fake onlineSlotSupervisors => picks the lowest account and corch_runs.account_slot is set; a second claim beyond capacity on a null-5h account => quota:slot_taken; a quota refusal through endRunAndRequeue with {at} => item queued, wait_reason quota:<reason>, attempts unchanged, not_before equals the instant; (when Q1 is not BLOCKED) a death through the dispatcher RunStore path => blocked_until set, item queued with quota:death, attempts unchanged; a NULL-until block cleared by a snapshot whose fetched_at is after blocked_at, and a time-bounded block NOT cleared by one. Then run the existing schema-double-apply and corch-dispatcher e2e files and orchestrator:e2e unchanged.</action>
  <verify>
    <automated>REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/corch-quota.e2e.test.ts && REMO_E2E_DB_URL=$E2E_URL bun test hub/test/e2e/schema-double-apply.e2e.test.ts && REMO_E2E_DB_URL=$E2E_URL DATABASE_URL=$E2E_URL bun test hub/test/e2e/corch-dispatcher.e2e.test.ts && bun run orchestrator:e2e</automated>
  </verify>
  <done>Every listed case passes against a real Postgres with 0 skipped; existing e2e suites unchanged and green.</done>
</task>

<task type="auto">
  <name>Task 8: Docs, OpenAPI, baseline, Definition of Done</name>
  <files>docs/corch.md, CLAUDE.md, hub/src/api/_openapi.ts, docs/openapi.json, docs/api.md, tools/regression-baseline.json</files>
  <read_first>docs/corch.md headings only (Flags and environment, Tables, Routes, Fail-closed defaults, Tests), tools/regression-baseline.json</read_first>
  <action>
  docs/corch.md: add REMO_CORCH_QUOTA_CEILING_PCT (default 55, validated at boot with CORCH on) to "Flags and environment"; corch_quota_accounts to "Tables" (no email column, upsert and block-clear rules); POST/GET /api/quota/snapshot with scopes, status codes and the 64 KiB / 32-account caps to "Routes"; a new "Quota eligibility (CORCH-02)" section listing the LD-Q6 rule order and reasons, selection (LD-Q8), wait (LD-Q9), quota death (LD-Q10), and "no supervisor targeting until CORCH-09"; quota fail-closed rows in "Fail-closed defaults"; the new test files in "Tests".
  CLAUDE.md (worktree): env bullet for REMO_CORCH_QUOTA_CEILING_PCT next to REMO_CORCH_ENABLED; add quota:publish and quota:read to the "API keys are scoped" invariant line as explicit-only; extend the "Central orchestrator (CORCH)" docs-map row to mention quota ingest.
  OpenAPI: describe both routes in the source that docs:openapi reads (hub/src/api/_openapi.ts, the same place CORCH-01 documented its routes), then bun run docs:sync and commit docs/openapi.json and docs/api.md.
  Baseline: run bun test hub/test/e2e/corch-quota.e2e.test.ts WITHOUT REMO_E2E_DB_URL and count its skipped tests S. In tools/regression-baseline.json add _skip_note_corch_02 (one sentence: S REMO_E2E_DB_URL-gated tests in corch-quota.e2e, real-DB proof in CI qc.yaml), raise tolerance.skip_max by exactly S, then run bun run check-baseline and copy its measured actual block in. pass_min and fail_max unchanged.
  Then run every Definition of Done command 1-12 and record outputs in the SUMMARY.
  </action>
  <verify>
    <automated>bun run docs:sync && git diff --exit-code -- docs/openapi.json docs/api.md && bun run check-baseline</automated>
  </verify>
  <done>Docs and CLAUDE.md describe the shipped behavior; OpenAPI regenerated with zero drift; check-baseline exits 0 with skip_max raised by exactly S under _skip_note_corch_02; DoD 1-12 all green and recorded.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CUG publisher -> POST /api/quota/snapshot | untrusted JSON over HTTPS with a Bearer api key |
| AAF / reader -> GET /api/quota/snapshot | Bearer api key reads quota state |
| supervisor -> hub hello | supervisor-asserted account_slot over the authenticated /ws/agent socket |
| CLI session end text -> dispatcher | session output classified as quota death |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-CORCH02-01 | Spoofing | api/quota.ts auth | high | mitigate | hasExplicitScope only (LD-Q2); legacy NULL-scope keys and cookies refused; api-keys-scopes describe pins it (Task 2) |
| T-CORCH02-02 | Elevation of privilege | quota:* keys on other routes | high | mitigate | quota scopes grant nothing elsewhere; tests prove /api/ext, /api/cloud-hook, /ws/agent and cookie routes refuse quota-only keys (Task 2) |
| T-CORCH02-03 | Information disclosure | payload email / label | high | mitigate | strict Zod rejects email and label at both levels with 400 and no row; no email column exists; error bodies echo no values; log-capture test (Task 2) |
| T-CORCH02-04 | Information disclosure | cross-user rows | high | mitigate | user_id taken from the verified key only; body user_id is an unknown key => 400; e2e proves user B cannot read user A (Task 7) |
| T-CORCH02-05 | Tampering | stale or fabricated readings fail open | high | mitigate | LD-Q6 fail-closed order on hub-clock received_at, fetched_at skew bound, source live only, null 7d refused, null 5h capped at 1 live run; table-driven tests (Task 3) |
| T-CORCH02-06 | Denial of service | oversized or flooding POSTs | medium | mitigate | 64 KiB body limit (413), 32-account cap, rateLimit 120/min per key prefix (LD-Q1); each POST triggers exactly one evaluation, no fan-out (Task 5) |
| T-CORCH02-07 | Tampering | supervisor-asserted account_slot | medium | accept | slot only steers selection bookkeeping within the authenticated owner's own supervisors; no targeting until CORCH-09; regex-bounded |
| T-CORCH02-08 | Tampering | false-positive quota death from assistant text | medium | mitigate | anchored whole-text match with length cap (LD-Q10); embedded-phrase test returns null (Task 6); worst case is a requeue with no attempt consumed |
| T-CORCH02-09 | Repudiation | quota decisions | low | mitigate | wait_reason quota:<reason> and end_reason quota_death persisted on the item/run; account_slot recorded on corch_runs |
| T-CORCH02-10 | Information disclosure | logs | medium | mitigate | no body, content, error text or key material logged; only user id + error code / classification (Tasks 2, 6) |
| T-CORCH02-SC | Tampering | package installs | low | accept | no new npm/pip/cargo packages; hono body-limit and zod are already dependencies |
</threat_model>

<source_coverage_audit>
| Source | Item | Covered by |
|--------|------|-----------|
| GOAL | hub ingests CUG quota and dispatches only on known headroom | Tasks 1-7 |
| REQ | CORCH-R2.1 publish endpoint, explicit quota:publish, strict body, email/label rejected | Tasks 1, 2, 7 |
| REQ | CORCH-R2.2 read endpoint, explicit quota:read, per-account eligibility | Tasks 1, 2, 3, 7 |
| REQ | CORCH-R2.3 fail-closed eligibility, CUG only | Task 3 (+ import guard), Task 5 provider swap |
| REQ | CORCH-R2.4 null 5h = unknown, 1-run cap | Tasks 3, 4 |
| REQ | CORCH-R2.5 quota death blocks the account | Task 6, Task 7 (Q1-gated) |
| REQ | CORCH-R2.6 no eligible account = wait, not consumed | Tasks 5, 7 |
| REQ | CORCH-R2.7 hello account_slot + per-dispatch choice recorded | Tasks 4, 7 |
| ROADMAP | SC1 schema checks + explicit-only + no other route | Tasks 1, 2, DoD 1-4 |
| ROADMAP | SC2 strict schema 400 no row | Task 2, Task 7 |
| ROADMAP | SC3 table-driven eligibility | Task 3 |
| ROADMAP | SC4 selection | Task 4 |
| ROADMAP | SC5 quota death + POST spy | Tasks 5, 6 |
| RESEARCH | F3: 600s / 900s / source live / ceiling / null 5h / most headroom / account_slot recorded | LD-Q6, LD-Q8 |
| RESEARCH | CUG v1 payload shape; CUG treats unknown as eligible, hub must not | LD-Q3, LD-Q6 rules 8 and 10 |
| BRIEF | guards each own process; real-PG e2e; docs; baseline; DoD; no polling; no secrets | DoD 6, Task 7, Task 8, LD-Q11, T-CORCH02-10 |
Excluded (other phases): CUG publisher (CORCH-03, R2.8/R2.9), AAF reader (CORCH-07, R2.10), supervisor sending account_slot and targeting (CORCH-09).
</source_coverage_audit>

<verification>
- Guards, each its own process: `bun test hub/test/kill-switch-coverage.test.ts`; `bun test hub/test/token-cap-coverage.test.ts`; `bun test hub/test/counter-key-assignment-guard.test.ts`; `bun test hub/test/launch-callers-guard.test.ts`; `bun test hub/test/corch-no-polling-guard.test.ts`; `bun test hub/test/api-keys-scopes.test.ts`; `bun test hub/test/mount-order.test.ts`.
- New unit files, each its own process (DoD 5).
- Real-Postgres e2e with 0 skipped (DoD 3, 7) plus orchestrator:e2e (DoD 8).
- No timers added: `git diff $BASE -- hub/src | grep "^+" | grep -cE "setInterval\(|setTimeout\("` prints 0.
- CUG-only: the Task 3 import guard passes; `git diff $BASE -- hub/src/usage | wc -l` prints 0.
- check-baseline, docs:sync zero drift, typecheck delta, scope fence (DoD 9-12).
</verification>

<success_criteria>
- SC1-SC5 of the CORCH-02 roadmap section each map to a named passing test (Tasks 2-6) and to the real-DB e2e (Task 7).
- REMO_CORCH_ENABLED remains OFF in every environment; with it OFF, POST still stores and nothing dispatches.
- DoD commands 1-12 green and recorded in the SUMMARY, or a specific BLOCKER recorded (disposable Postgres unavailable, or Q1 no hub-visible signal) with its ticket id.
</success_criteria>

<output>
Create `.planning/phases/CORCH-02-quota-ingest/CORCH-02-SUMMARY.md` when done (BASE, N0, Q1 outcome, DoD outputs, baseline S, any BLOCKER with ticket id).
</output>
