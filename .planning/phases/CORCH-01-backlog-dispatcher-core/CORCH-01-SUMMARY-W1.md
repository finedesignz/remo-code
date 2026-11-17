# CORCH-01 Wave 1 progress (Tasks 1-4 of 7)

Branch `phase-corch-01-backlog-dispatcher`, not pushed. Tasks 5, 6, 7 NOT started (stop point per brief).
Baselines (RESEARCH.md): typecheck N0 = 253 `error TS`; check-baseline OK before changes.

## Task 1 (tracer) - d241c44
Files: CORCH-01-RESEARCH.md, hub/src/db/schema.sql, hub/src/corch/{flag,keys,store,dispatcher}.ts, hub/src/index.ts, hub/test/corch-boot-assert.test.ts, hub/test/e2e/corch-dispatcher.e2e.test.ts.
Tests (real Postgres 55432/remo_ci): corch-boot-assert 10 pass / 0 fail; corch-dispatcher.e2e 3 pass / 0 fail (tracer workspace refusal, flag off, concurrent claim race at cap 1 with idempotent double end); schema-double-apply.e2e 0 fail. schema-lint exit 0; migration-verify exit 0 on a fresh DB (`corch_mv`) and again on second apply; destructive-DDL grep = 0.
Deviations: none.

## Task 2 - f1a5fcc
Files: hub/src/corch/{routes,store,dispatcher}.ts, hub/src/index.ts, hub/src/auth/scopes.ts, hub/src/auth/ext-api-key-middleware.ts, hub/src/api/ext.ts, hub/src/api/_openapi.ts, hub/test/{corch-routes,mount-order,api-keys-scopes}.test.ts.
Tests: corch-routes 13 pass; mount-order 24 pass (each run per-file); api-keys-scopes 32 pass. 0 fail.
Deviations:
1. [Rule 3] Edited `hub/src/auth/ext-api-key-middleware.ts` (not in plan files_modified). The ext:work scope gate is path-based inside this middleware, handlers never see key scopes, so the explicit `ext:corch` gate must live there (one added block, same pattern as ext:work). Scope-fence file list therefore has one extra path.
2. routes.ts exports `createCorchRoutes(deps)` / `createExtCorchRoutes(deps)` (store + evaluate trigger injected; default real) in addition to `corchRoutes`/`extCorchRoutes`. Reason: `mock.module` leaks across files in one bun process and broke mount-order when corch-routes ran first. The scope-gate cases (403, zero writes) are therefore pinned in api-keys-scopes.test.ts through the real middleware; corch-routes.test.ts covers the handlers.
3. "api key Bearer on GET /api/corch/projects gets 403" is pinned structurally: every corch cookie path is not on the settings allowlist (`matchSettingsRoute` null), which is exactly why authMiddleware answers 403. No full-app DB-backed request test.
4. Ext body identifies the project by `repo_ident` (plan did not specify); canonicalised like the cookie route.
5. `_openapi.ts` corch block typed without `as const` so it adds 0 typecheck errors.

## Task 3 - 1448493
Files: hub/src/corch/{gates,quota-provider,prompt,store,dispatcher}.ts, hub/test/{corch-gates,corch-prompt,token-cap-coverage,kill-switch-coverage,counter-key-assignment-guard}.test.ts.
Tests: corch-gates 15 (then 28 after Task 4), corch-prompt 3, token-cap-coverage 7, kill-switch-coverage 10, counter-key-assignment-guard 9; 0 fail.
Deviations:
1. kill-switch-coverage pins `lists` length 14; adding corch/dispatcher.ts makes it 15. Updated the pin (and its title) - the only existing assertion edited, necessary and strictly a count for a new legitimate member.
2. Budget refusal reason is the plain `project_budget` (no numeric suffix).

## Task 4 - 38a4eea
Files: hub/src/corch/{dispatcher,store}.ts, hub/test/{corch-gates,launch-callers-guard,launch-machine-guard,session-start-senders-guard,reserve-caller-guard}.test.ts.
Tests: corch-gates 28 pass (13 new dispatcher cases); launch-callers 12, launch-machine 8, session-start-senders 13, reserve-caller 7, heal-single-seam 26, pty-door-guard 22, orchestrator-macro-path-guard 5; 0 fail. `bun run orchestrator:e2e` (all e2e files, REMO_E2E_DB_URL set): 71 pass / 0 fail / 0 skipped across 14 files. Typecheck: 253 total (= N0), 0 errors in src/corch, test/corch, test/e2e/corch.
Deviations:
1. `CorchDeps.launchCommand` carries AUTOSPAWN_LAUNCH_COMMAND (it lives in a DB DAL; LD-2 forbids the top-level import). realCorchDeps imports it dynamically.
2. LD-4 "only place counterKey is written is buildCorchRequest": dispatcher.ts has ONE more line, `lifetime = { counterKey: buildCorchKey(item.id), token }`, spread into reserve and release (ReserveArgs/ReleaseArgs require that property name). Guard test asserts every assignment line in corch/dispatcher.ts uses `buildCorchKey(`.
3. `onSupervisorClosed` NOT exported yet: its behaviour is the LD-13 reclaim that belongs to the Task 5 reconciler. `onSupervisorHello`, `onKillSwitchReleased`, `evaluateUserNow` are exported and return before any DB access when the flag is OFF.
4. governedLaunch `failed` records fixed end_reason `launch_failed` (the raw `autospawn_launch_threw: <msg>` text is only logged, so no untrusted text reaches a stored reason or a notification, LD-14).
5. No-attempt refusals do not re-trigger `evaluateUser` (would ping-pong on an item that refuses again); only real run ends re-trigger. Inside the claiming loop (`inline`) nothing re-enters.
6. Dispatch throwing after a successful launch ends the run as `dispatch_failed` (attempt consumed, no release, per LD-10 list).

## Open items / notes for later tasks
- `bun run check-baseline` now reports DRIFT: skip=296 > skip_max=295 (actual pass=3608 skip=296 fail=0). Cause: new e2e file skips without REMO_E2E_DB_URL. Expected; Task 7 re-measures `tools/regression-baseline.json`. Not touched here.
- DoD #6 lists `api-keys-scopes` and `mount-order` in one `bun test` command: that fails on origin/main too (api-keys-scopes mocks db/dal.ts and leaks; verified by running the origin/main copies together). Each passes alone and check-baseline isolates per file. 7d ticket filed: AAF annotation 34245069-4c8b-4d73-9f16-996e267cbb81 (repo remo-code). Run those two files separately for DoD #6.
- Combined `bun test` of corch unit tests plus the corch e2e in ONE process makes the e2e hit 5432 (config loaded before DATABASE_URL is set). Same pattern as the existing tokencap e2e; DoD #7/#8 run e2e files in their own invocation and pass.
- schema-lint 0, destructive-DDL grep 0, diff in hub/src/{orchestrator,heal,dispatch,sessions,telegram} and supervisor = 0 lines.
- Real Workspace / PrLookup / QuotaProvider are the fail-closed defaults, so in prod nothing can launch (flag OFF anyway).
