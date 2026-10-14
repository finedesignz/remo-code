# Phase 4: Lifetime Inject Counter + Kill Switch - Research (planner facts)

**Researched:** 2026-10-13
**Tree read:** worktree `C:\Users\artic\GitHub\remo-code-gsd`, branch `phase-ptycap-03-governed-automation-guard` (tip moved 9e7d93e -> 5676b12 while I read; another agent is committing tests, so TEST line numbers may shift, `src/` line numbers are stable). Line numbers below are THIS tree, not `main` (03-RESEARCH numbers were taken on main and are off by 5-20 lines in gates.ts).
**One question:** what exact file:line facts does a planner need to implement D-01..D-19?
**Provenance:** every `(file:line)` was opened with Read or a line-scoped Bash `sed` this session unless marked `(grep only)`. Discrete values (reason strings, env names, enums) are quoted verbatim. `[ASSUMED]` = training knowledge, not run (there is NO local Postgres here: no psql/pg_isready/docker, `REMO_E2E_DB_URL` unset).
**Read-only:** nothing in the repo was edited. Only this file was written.

---------------------------------------------------------------------------------------------------
## 0. TOP SURPRISES / RISKS vs 04-CONTEXT (read first)
---------------------------------------------------------------------------------------------------

S1. **D-16 boot assertion location is wrong for the table-existence half.** `assertTokenCapConfig()` runs SYNCHRONOUSLY at index.ts:569-574, BEFORE `Bun.serve` (index.ts:586) and BEFORE `runMigrations()` (index.ts:706). A "tables exist" check placed next to it would `process.exit(1)` on the FIRST deploy (tables not created yet). Split `assertAutomationControls()` into (a) a sync env half beside index.ts:569 and (b) an async table-existence half as the FIRST `.then` after `runMigrations()` (index.ts:706-707). The server is already listening when (b) runs; gates fail closed on DB error in that window (acceptable, state it).

S2. **`cloud/send.ts` is the HUMAN web path, not an automation path.** `sendToCloudSession` is called only from `ws/client.ts:720-721` (a human typing in a cloud session, after `send_ack` at :691-699). D-05/D-08 list "cloud send" among kill-switch lists. Adding the gate there would block a human during a halt AND break `hub/test/cloud-send.test.ts:70` (`expect(defaultCloudSendDeps.gates.map((g) => g.name)).toEqual(['daily_cost_cap', 'daily_token_cap'])`). Put `cloud/send.ts` on the HUMAN allowlist of the new coverage test. (Telegram `dispatch.ts:180` is also human: sole caller passes `source: "human"` at telegram-webhook.ts:399.)

S3. **Two spawn sites run BEFORE `dispatch()`, so gate lists cannot cover them:** `inject.ts:350-355` (`deps.launchSessionForUser` inside `maybeAutospawnOffline`) and `scheduler/senders/agent.ts:300-325` -> `:237`. Also `ask/dispatch.ts:153` and `work/dispatch.ts:313` spawn inside `ensureOnline` (that one runs AFTER the gate list, so it is covered except for the race window). `launchSessionForUser` (telegram/launch.ts:82) is shared with human Telegram `/doctor` (`doctor.ts:249`) and `commands.ts:184`, so a blanket check inside it would block humans: add an explicit machine-origin option and pass it from the 4 machine callers.

S4. **orphan-resume D-09(b) "defers without finalizing; release resumes it" is not true as specified.** (i) The loop ENDS the orphan row (`exit_reason='reboot'`) at orphan-resume.ts:167 BEFORE spawning, so a defer must `continue` BEFORE :167 (after the user_stopped/restart-cap checks at :143-163). (ii) The only triggers are supervisor.hello (agent.ts:949-985 grep only) and browser auth (rate-limited once per user per 60s, orphan-resume.ts:260-283); engage/release do not trigger a sweep, and the 24h stale sweep (:112-120) finalizes un-resumed orphans as `'stale'`. So "release resumes it" only happens if the release route calls `resumeOrphanSessionsForUser`/the supervisor sweep, or the orphan is younger than 24h at the next reconnect. (iii) Non-orchestrator orphans (:197-241) cannot be told apart as human vs machine; deferring ALL of them halts human session recovery. Recommend: defer only `o.is_orchestrator` orphans (the one machine-driven kind, :174-195) unless the panel says otherwise; add a release-time resume call.

S5. **"Atomic" reserve is not atomic under READ COMMITTED as written.** `INSERT ... SELECT ... WHERE count < cap ON CONFLICT (counter_key, token) DO NOTHING` has no row to lock; two concurrent reserves for one `counter_key` can both read count = cap-1 and both insert [ASSUMED: Postgres semantics, not run: no local DB]. Repo precedent for the fix: per-key `pg_advisory_xact_lock` inside `sql.begin` (auto-launch.ts:153-155, verbatim `await tx\`SELECT pg_advisory_xact_lock(hashtext(${'orchestrator:' + args.userId})::bigint)\``). Use `hashtext('lifetime:' || counter_key)`.

S6. **`dispatch()` reserve-skip MUST release the queue slot.** At the reserve point (between pipeline.ts:289 and :300) `claim === 'dispatched'` already holds the in-flight slot (queue.enqueue at :238). A skipped return without `void releaseAndPromote(req.sessionId)` (see the offline-park precedent at :283) strands the slot and every later dispatch to that session returns `session_busy`.

S7. **DB-backed proof only exists in CI.** No PGlite anywhere (`grep -rli pglite hub/test hub/package.json package.json tools` = empty). E2E tests are `hub/test/e2e/*.e2e.test.ts` gated by `REMO_E2E_DB_URL` (`describe.skip` when unset) and run only in Woodpecker (`.woodpecker/qc.yaml:56` `bun run orchestrator:e2e`, real `postgres:16`). Skipped tests COUNT toward `skip_max`: baseline `"skip": 259`, `skip_max` 260 (regression-baseline.json:6 + D-19), i.e. headroom of ONE. A new e2e file with N tests adds N local skips. Either write the real-Postgres reserve/race proof as ONE e2e test or raise `skip_max` with a dated `_skip_note_ptycap_phase4` (the file's established pattern). D-19 "no new skipped tests" cannot be met with an e2e file unless it is a single test and `skip_max` is bumped by 1.

S8. **qc.yaml DOES run supervisor tests** (D-15 PR-body claim is wrong): `.woodpecker/qc.yaml:52` `bun test supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts`. The G-1 fixture belongs in `supervisor/test/pty-usage-tail.test.ts` and is CI-gated. Other supervisor tests are not. Also: supervisor version files are 4 (see D-15), and `supervisor/package.json:3` is `0.14.5` (stale, not in the drift test) - do not touch it.

S9. **Recurring cron tasks hit the lifetime cap.** D-05 puts scheduler agent + triage under `task:<id>` x 1000 lifetime. A task firing every 15 min = 96/day -> exhausted in ~10.4 days, then PERMANENTLY blocked (until reset) with a one-time page. And `__internal_triage` (db/dal.ts:1615 `INTERNAL_TRIAGE_TASK_NAME = '__internal_triage'`) is ONE row that all Coolify webhook triage events share (scheduler/dispatcher.ts:271-312), so its single key burns 1000 across ALL events. Needs a panel decision before build: exempt triage, or per-class cap, or reset on a cadence. [Arithmetic only; prod task frequencies unknown.]

S10. **Orchestrator key split.** `injectOrchestratorPrompt` has 4 callers: macro-cycle.ts:225 (has `input.taskId`, macro-cycle.ts:43), merge-command.ts:228, verify-tail.ts:321 (+ factory seams :183/:267), wave-runner.ts:150. Only macro-cycle knows `taskId`; the other three would key `session:<id>` while macro keys `task:<id>` -> two independent 1000 budgets on one orchestrator session. One orchestrator task per session is verified (controller.ts:685-688 `WHERE task_type = 'orchestrator' ...`). Derive the key INSIDE inject.ts so no caller can omit it (see D-01).

S11. **9 existing test files `mock.module` `dispatch/gates.ts`** (dispatcher-disabled-guard, error-capture-dispatch, once-tasks, orchestrator-metrics, revanote-dispatch, scheduler-bounds-autodisable, scheduler-dispatch, teab-e2e, teab-sender). Importing `isAutomationHalted`/the gate from `gates.ts` would add a missing export; importing it from a new module would hit the REAL `sql` and fail closed. Existing mocks use `sql: async () => [{ tz, cap, bound }]` for ANY query (token-cap-gate-fires.test.ts:~22), so a kill-switch SELECT could see a truthy row. Design `isAutomationHalted` to require an explicit `engaged === true` column in the row and treat only that as engaged on the success path (errors still fail closed); and budget a Wave-0 "run check-baseline, fix the mocks" task.

S12. **Telegram `TelegramDispatchSource` is a union** (`"human" | "scheduler" | "orchestrator-background" | "auto-dev" | "error-capture"`, telegram/dispatch.ts:68) but only `"human"` is ever passed today. The list at :180 is effectively human; if a future caller passes an automation source it would need a source-aware kill gate. Pin it in the exemption set with that reason.

S13. **once-task burn.** `fire()` claims a one-time task (`claimOnceTask`, dispatcher.ts:116, flips `enabled=false`) BEFORE `fireTask`. A halt check only inside `fireTask` consumes the one-shot (client-email work) and it never fires after release. Put a halt pre-check in `fire()` ahead of the claim for `schedule_kind === 'once'` (defer, do not claim), in addition to the `fireTask` check.

S14. **The 60% alarm hook can break 3 existing DAL tests.** `usage-event-handler.test.ts`, `token-usage-runner-type.test.ts`, `pty-usage-midflight-visibility.test.ts` call the real `recordTokenUsage` against a fake `sql` that emulates exactly the two ledger statements (usage-event-handler.test.ts:16-60, token-usage-runner-type.test.ts:37-66). Extra alarm SELECTs would hit that fake. Prefer a listener registry (`setTokenUsageListener(fn)` set once from index.ts) over a hard-wired dynamic import inside `recordTokenUsage`: tests never register a listener, so they are untouched, and it is still event-driven (rule 23).

S15. **TS baseline is 427 errors** (`cd hub; bunx tsc --noEmit -p tsconfig.json | grep -c "error TS"` = 427 on this branch, run this session). CI treats typecheck as informational (`.woodpecker/qc.yaml` pr-gate step: `bunx tsc --noEmit -p hub/tsconfig.json || echo 'typecheck informational ...'`). The usable gate is "no NEW errors in files you touched / count <= 427".

---------------------------------------------------------------------------------------------------
## 1. PER-DECISION FACTS AND PLAN IMPLICATIONS
---------------------------------------------------------------------------------------------------

### D-01 - ledger table + `DispatchRequest.counterKey`

FACTS
- `DispatchRequest` = pipeline.ts:36-48; precedent server-set optional field, verbatim: `humanInteractive?: true` at :47 with doc :44-46 "Set ONLY by the PTY preflight ... Never populated from client input." (pipeline.ts:44-47)
- `DispatchGate` = `{ name: string; check(req: DispatchRequest): Promise<{ ok: true } | { ok: false; reason: string }> }` (pipeline.ts:51-54). Return shape must NOT change (D-12).
- Static-pin precedent to copy: `hub/test/human-interactive-flag-guard.test.ts:1-45` walks `hub/src`, `ALLOWED = new Set(['dispatch/pipeline.ts','dispatch/gates.ts','dispatch/pty-preflight.ts'])`, asserts `offenders` equals `[]`, plus a line-level assertion on the single setter (test:1-45).
- Existing schema precedent for "no FK, plain TEXT ids, audit trail": `work_runs` - `user_id TEXT NOT NULL,` / `session_id TEXT NOT NULL,` (schema.sql:1535-1536, table :1533-1564, indexes :1571-1573). `users.id` is `UUID` (schema.sql:6), `sessions.id` is `TEXT` (:16), `sessions.user_id` is `UUID NOT NULL REFERENCES users(id)` (:17), `scheduled_tasks.id` is `TEXT` (:157). So SQL joins from a TEXT `user_id` to `sessions.user_id`/`users.id` need `::text` casts on the UUID side.
- Every `injectOrchestratorPrompt` caller: macro-cycle.ts:225 (`d.inject({ userId, sessionId, token, prompt: macro.prompt, autospawn })`), merge-command.ts:228-233, verify-tail.ts:321-326, wave-runner.ts:150-153. `InjectInput` = inject.ts:81-90 (`userId, sessionId, token, prompt, autospawn?`); both `DispatchRequest` constructions are `{ userId, sessionId, token, prompt }` at inject.ts:270 and :405.
- Scheduler: agent `req` = agent.ts:405 `{ userId: ctx.userId, sessionId, token: ctx.runId, prompt: sentContent }`; triage `req` = triage.ts:162 `{ userId: ctx.userId, sessionId, token: ctx.runId, prompt }`. `task.id` is in scope in both senders (agent.ts:264 `sendAgentTask(task, ctx)`; triage sender takes `task`).
- Ledger-ordering hazard: two rows inserted in one transaction share `now()`; "latest reset marker" by `created_at` can tie.

PLAN IMPLICATION
- DDL (schema.sql tail, after :1598), all `CREATE TABLE IF NOT EXISTS` / `CREATE ... INDEX IF NOT EXISTS`, no data statements. Suggested `automation_inject_ledger(seq BIGSERIAL, id TEXT PK DEFAULT gen_random_uuid()::text, user_id TEXT NOT NULL, session_id TEXT, counter_key TEXT NOT NULL, actor TEXT NOT NULL, token TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'inject' CHECK (kind IN ('inject','reset')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), released_at TIMESTAMPTZ)`, `CREATE UNIQUE INDEX IF NOT EXISTS ... ON automation_inject_ledger(counter_key, token)`, index `(counter_key, seq DESC)`. Use `seq` (not `created_at`) to order "rows after latest marker". A `kind` column avoids overloading `actor` for markers (planner discretion, D-01 lists no kind column).
- `pipeline.ts`: add `counterKey?: string` to `DispatchRequest` after :47 with a doc comment mirroring :44-46.
- Derive the key in ONE place: add `taskId?: string` to `InjectInput` (inject.ts:81-90) and set `counterKey: input.taskId ? \`task:${input.taskId}\` : \`session:${input.sessionId}\`` at BOTH req constructions (inject.ts:270, :405). Thread `taskId: input.taskId` at macro-cycle.ts:225. For merge-command/verify-tail/wave-runner (S10): either pass the same orchestrator task id (they have `ctx.sessionId` only; resolve via the 1:1 orchestrator task) or key ALL orchestrator injects `session:<sessionId>` and document it. Recommend the latter for one budget (panel/planner call; D-01 text says `task:<id>` where known).
- Scheduler: `counterKey: \`task:${task.id}\`` at agent.ts:405 and triage.ts:162. See S9 for the triage/cron caveat.
- New static-pin test `hub/test/counter-key-assignment-guard.test.ts` modeled on human-interactive-flag-guard.test.ts: allowed files = pipeline.ts (type + reader), the counter module, inject.ts, scheduler/senders/agent.ts, scheduler/senders/triage.ts, pty producer file (Phase 5).
- A gate that REQUIRES a key (counter gate in the 4 D-05 lists) must fail closed when `req.counterKey` is undefined (reason e.g. `lifetime_counter_key_missing`), so a forgotten key is a visible block not a silent no-op (the CONTEXT R2 "silent no-op" risk).

### D-02 - non-consuming gate + atomic idempotent reserve in `dispatch()`

FACTS (pipeline.ts, exact)
- Gate stage: `const blocked = await runGates(req, deps.gates)` at :225; `runGates` :210-216 (first block wins).
- Queue claim :238 `queue.enqueue(req.sessionId, req.token)`; `'dropped'` :239-246; `'queued'` :247-256 (stashes `{req, deps}` in `waiterCtx` :252-254).
- Online/park decision :263-289: `deps.isOnline(req)`, optional `deps.ensureOnline` :264-277, park = `void releaseAndPromote(req.sessionId)` :283 then `getGraceBuffer().register(key, () => deps.replay(req), {...})` :284-287 -> `{ kind: 'parked_offline' }` :288.
- `store.open` :300 (`const openedId = (await deps.store?.open?.(req)) ?? req.token`); `activeBySession.set` :305; `markDispatched` :307; `deps.send(req)` :308; catch :309-319 (`activeBySession.delete`, `store.markFailed`, `void releaseAndPromote`, returns `{ kind: 'failed', reason: msg }`).
- Promotion re-enters `dispatch(waiter.req, waiter.deps)` at :495 (releaseAndPromote :483-501), so the unique `(counter_key, token)` makes the second reserve a no-op.
- `PipelineDeps` = :87-153 (no DB import in pipeline.ts: imports are only `./grace.ts` and `./session-queue.ts`, :33-34).
- Stores' `markSkipped(token, reason)` map `reason` onto run rows (agent.ts:336-340 `reason.startsWith('quota_threshold_reached') ? 'skipped_quota' : 'skipped'`); free-text reasons are tolerated by scheduler stores.

PLAN IMPLICATION
- Insert between pipeline.ts:289 and :290 (before `store.open` at :300):
  ```
  if (req.counterKey) {
    const { reserveInject } = await import('./automation-controls.ts')   // late import: pipeline.ts keeps a DB-free module graph
    const r = await reserveInject(req)                                    // halt re-check + advisory-locked count<cap insert; DB error => { ok:false }
    if (!r.ok) {
      void releaseAndPromote(req.sessionId)                               // S6: free the slot we hold
      if (deps.store) { try { await deps.store.markSkipped(req.token, r.reason) } catch {} }
      return { kind: 'skipped', reason: r.reason }
    }
  }
  ```
  Put the D-09(c) final `isAutomationHalted` re-check inside `reserveInject` (same step, before `store.open`), so a halt after the gate stage cannot reach `send`. (Optional hardening: fold `AND NOT EXISTS (engaged kill row)` into the reserve SQL.)
- In the `catch` at :309-319 add a best-effort `await releaseInject(req)` that stamps `released_at` (append-only compensation, never DELETE) when `req.counterKey` is set.
- `reserveInject` SQL shape: `sql.begin(tx => { advisory lock; SELECT count of kind='inject' AND released_at IS NULL AND seq > (latest reset seq for key); IF count >= cap -> return blocked; INSERT ... ON CONFLICT (counter_key, token) DO NOTHING; })`. On conflict (token already reserved) return `{ ok: true }` (idempotent re-entry from promotion/replay).
- Tests: `hub/test/dispatch-pipeline.test.ts` (existing, uses `passGate`/`blockGate`, no counterKey) must stay green untouched: the reserve only runs when `req.counterKey` is set. New cases there or in a new `hub/test/dispatch-reserve.test.ts` with the controls module mocked at the leaf: reserve-block returns `skipped` AND frees the slot (assert a following `dispatch()` for the same session is `dispatched`, not `dropped_busy`); `send` throw -> `released_at` stamped; promoted waiter reserve is idempotent.

### D-03 - grace replay must re-enter `dispatch()`

FACTS
- The direct-send replay: inject.ts:395-401, verbatim `replay: async () => { try { await send({ userId, sessionId, token, prompt }) } catch (err: any) { console.warn(...) } }`; `send` = `buildSend(prompt, token, deps)` inject.ts:388 (defined :168-189; throws `agent_socket_missing` :171).
- Online-path replay is `async () => {}` (inject.ts:266) - fine, "unexpected".
- Other replays (all re-enter their own dispatcher, verified): feedback/dispatcher.ts:136-138 `dispatchFeedback(sub)`; ask/dispatch.ts:166-169 `dispatchAsk(input)`; error-capture/dispatcher.ts:176-178 `dispatchPendingError(errorId)`; work/dispatch.ts:326-328 `dispatchWork(input)`; telegram/dispatch.ts:186-188 `dispatchToSession(input)`; revanote/dispatcher.ts:336-338 `dispatchPendingAnnotation(ann.id)`; scheduler agent.ts:381-383 `sendAgentTask(task, ctx)`. Triage: replay finalizes failed (triage.ts:147). (all grep-then-read of the replay lines)
- Grace TTL `DEFAULT_TTL_MS = 10 * 60 * 1000` (dispatch/grace.ts:24).
- PTY door: `runChain` builds `token: \`pty-preflight:${input.sessionId}\`` (pty-preflight.ts:184) - constant per session; governors loop :192-200, no consumption.

PLAN IMPLICATION
- Rewrite inject.ts:395-401 so replay re-enters `deps.dispatch(req, deployDeps)` (self-reference: declare `deployDeps` with `let`/function hoisting, mirroring how `sendAgentTask` closes over `ctx`). Keep errors swallowed + logged. Because the reserve is after the park decision, a parked request has NOT counted; the replay's re-entry counts it exactly once.
- A guard test pins "no `replay:` body calls the raw `send(`": scan inject.ts for `replay:` blocks (self-check the scanner finds both occurrences, per token-cap-coverage style).
- Phase 4 ships `reserveInject` as an EXPORT (signature `reserveInject(req: { userId; sessionId; token; counterKey; actor? }): Promise<{ok:true}|{ok:false;reason:string}>`) for the Phase 5 PTY producer. Add a caller pin test (Phase 3 D-12 style, see pty-door-guard.test.ts:115-156 "privileged caller pins") asserting `reserveInject(` is called only from pipeline.ts (+ the Phase 5 producer file once it exists). The constant token at pty-preflight.ts:184 must NOT be used for a reserve (second turn would be a no-op): note it in the doc.

### D-04 - cap env, boot refusal, reset, notification classes

FACTS
- Exact template: `assertTokenCapConfig` gates.ts:213-231; parse gates.ts:189-194 (`{ ok, cap }`, unset/blank -> default, `Number.isFinite(n) && n > 0`); explicit-disable var `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED` (gates.ts:173-177); boot call + exit: index.ts:569-574 verbatim `try { assertTokenCapConfig() } catch (err: any) { console.error(\`[startup] FATAL: ${err?.message ?? err}\`); process.exit(1) }`.
- Step-up helper: `requireRecentAuth(maxAgeSeconds = 900)` reauth.ts:37; 401 body `{ error: 're_auth_required', max_age_seconds }` (:44), cookie age from `auth_sessions.created_at` (:42); legacy-JWT path keyed on `iat` (:52-75); it also `c.set('userId' | 'userEmail' | 'userRole')` (:46-48, :67-69).
- Reset audit: need actor identity; handlers read `c.get('userId') as string` (api/orchestrator.ts:47, :132).
- Macro-cycle benign list (verbatim, macro-cycle.ts:290-293): `const benignAutospawnRefusal = outcome.kind === 'refused' && ['not_allowlisted', 'supervisor_offline', 'launch_cap', 'over_token_cap'].includes(reason as string) || (typeof reason === 'string' && reason.startsWith('autospawn_launch_'))`; the page is `emitFailure` at :295 (defined :312-327; `shouldNotify('failure', ...)` always fires, notify.ts:111-116). `mapDispatchOutcome` turns a `skipped` into `{ kind: 'refused', reason }` (inject.ts:287-294, and :419-426 on the autospawn path).
- `fanOutNotify` needs `sessionId: string` and `event: NotifyEvent` (notify.ts:122-130).

PLAN IMPLICATION
- Add to `automation-controls.ts`: `lifetimeInjectCap()` (call-time env `REMO_AUTOMATION_LIFETIME_INJECT_CAP`, default 1000; invalid -> default) and `assertAutomationControlsEnv()` throwing like gates.ts:223-230. Call beside index.ts:569 (S1).
- Macro-cycle: extend the benign test so `reason.startsWith('automation_halted:')` is benign (add next to :293). `lifetime_inject_exhausted:` stays a page but must be deduped once per (counter_key, reset epoch) via a durable claim - the current `emitFailure` would page EVERY tick. Implement the claim in the controls module (a small `automation_exhaustion_pages(counter_key, epoch_seq) UNIQUE` table, or a column on the ledger marker) and call it from the exhausted-reason branch of macro-cycle before `emitFailure`.
- Reset route: `POST /api/automation/lifetime/reset {counter_key}`: cookie auth (the `/api/*` catch-all at index.ts:320-339 already applies `authMiddleware`; CSRF guard index.ts:366 bypassed for Bearer, csrf.ts:95-141), `requireRecentAuth()` mounted like index.ts:416-421, user-scoped: `WHERE user_id = $caller` on the key's existing rows (reject a key the caller has no rows for), append `kind='reset'` row. Never UPDATE/DELETE history.

### D-05 - coverage matrix

FACTS - every `gates: [` literal in `hub/src` (grep this session; ALL lines opened or grep-listed):
| file:line | contents | class |
|---|---|---|
| orchestrator/inject.ts:262 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` | automation, COUNT + KILL |
| orchestrator/inject.ts:390 | same (autospawn path) | automation, COUNT + KILL |
| scheduler/senders/agent.ts:367 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate]` | automation (also human "Run Now"), COUNT + KILL |
| scheduler/senders/triage.ts:142 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate]` | automation, COUNT + KILL (see S9) |
| error-capture/dispatcher.ts:167 (grep only) | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` | automation, KILL only |
| feedback/dispatcher.ts:130 (grep only) | same 4 | automation, KILL only |
| revanote/dispatcher.ts:317 (grep only) | `[..4.., revanoteBudgetGate(userId, tz)]` | automation, KILL only |
| ask/dispatch.ts:133-145 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, governedAutomationPtyGate(async (req) => {...}), askRateGate(apiKeyId)]` | automation, KILL only |
| work/dispatch.ts:294-307 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, governedAutomationPtyGate(...), workRateGate(userId), workRepoAllowlistGate(userId, repoIdent)]` | automation, KILL only |
| telegram/dispatch.ts:180 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, guard]` | HUMAN (source "human" only caller) |
| cloud/send.ts:31 | `[dailyCostCapGate, dailyTokenCapGate]` | HUMAN (ws/client.ts:720) - NOT a kill target (S2) |
| dispatch/pty-preflight.ts:38 | `[thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]` (shared array object; automation = all, human = all minus `sessionInjectRateGate`, :42-47) | MIXED; kill/counter via governor slots in the automation branch only |
- Spawn-on-error (`dispatch/spawn-on-error.ts:156-`, `session.start` at :236) is `ensureOnline` for error-capture/feedback/revanote; runs after the gate list, so the KILL gate in those lists covers it.
- Scanner to extend: token-cap-coverage.test.ts (102 lines, read in full): `gateLists()` :44-70 bracket-balanced scan with `unparsed` hard-fail (:73-75); known-dispatcher list :79-91 (does NOT include ask/work/cloud); final rule :96-101 (`includes('dailyTokenCapGate')` and `includes('dailyCostCapGate')` - plain substring).
- Existing tests that pin list contents: cloud-send.test.ts:70; ext-ask-gates.test.ts:30-36 (source slice from `'gates: ['` to `'store,'`, names `thresholdGate, dailyCostCapGate, dailyTokenCapGate, governedAutomationPtyGate, askRateGate`); pty-preflight.test.ts:137-155 and :381 (name lists of `PTY_AUTOMATION_TURN_GATES`/`PTY_HUMAN_TURN_GATES`); orchestrator-autospawn-inject.test.ts:54/:176 and orchestrator-command-prompts.test.ts:167-190 (record gate NAMES via `deps.gates.map(g => g.name)`; `toContain` so additive).

PLAN IMPLICATION
- Counter gate (`automationLifetimeCounterGate`, name `lifetime_counter`) in: inject.ts:262 and :390, agent.ts:367, triage.ts:142 (AFTER the spend gates, since D-05 says reserve consumes later; position it last or after `sessionInjectRateGate`). Kill gate (`automationKillSwitchGate`, name `automation_kill_switch`) FIRST in every automation row above, so a halted run does not pay for a DB read of spend. For `governedAutomationPtyGate(...)` rows (ask/work) kill goes before `thresholdGate`.
- New coverage test `hub/test/kill-switch-coverage.test.ts` copying `walk`/`gateLists` from token-cap-coverage.test.ts:24-70 (import-free duplication is the repo style) with: (a) `unparsed` is `[]`; (b) `HUMAN = new Set(['telegram/dispatch.ts','cloud/send.ts'])` and `pty-preflight.ts` handled by a separate pin (its list is a variable consumed via `PTY_AUTOMATION_TURN_GATES`, invisible to a `gates: [` scan of the runChain loop) - assert pty-preflight.ts references the controls governor in the automation branch and NOT in `PTY_HUMAN_TURN_GATES`; (c) EVERY other list `includes('automationKillSwitchGate')` and the kill gate is the FIRST element (parse the first token after `[`); (d) the exemption set for the counter gate lists the 7 kill-only dispatchers with one-line reasons; (e) known-dispatcher self-check so a broken scanner fails.
- Do NOT add the kill gate into `ptyPreflightDispatchConfig.gates` (pty-preflight.ts:37-39): `PTY_HUMAN_TURN_GATES` is derived by filtering that array (:45-47), so anything added reaches humans (this trap is documented in GATES/design-fork-1.md:77).

### D-06 - kill-switch table, fresh read, env break-glass, tenancy, routes

FACTS
- Admin check: `requireAdmin()` reads `c.get('userRole')` only (`require-admin.ts:9-17`, verbatim 403 body `{ error: 'forbidden', reason: 'admin_required' }`). Role comes from the session/JWT context (no DB lookup). Admin mount precedent index.ts:445-450: `app.use('/api/admin/*', requireAdmin())` then `requireRecentAuth()` for mutating methods then `userMutationLimit`, then `app.route('/api/admin', adminRouter)`.
- `isMutating`/`userMutationLimit` index.ts:393-402 (10/min/user). Step-up mount precedent for non-admin routes: index.ts:416-427 (`app.use('/api/users/me/prompts', ...)`). `/api/orchestrator` /start and /stop deliberately NOT step-up: orchestratorStepUp only on PUT (index.ts:435-440), rationale comment :428-434.
- Router file model: `api/orchestrator.ts` - `export const orchestrator = new Hono()` :26; handlers read `c.get('userId') as string` :47; `/stop` at :131-149.
- Route mount point: `app.route('/api/orchestrator', orchestratorApi)` index.ts:484 (all authed routes mount in :457-498 AFTER the `/api/*` auth+rate+license+CSRF catch-alls at :320-366).
- Env-flag parse idiom: governed-pty.ts:47-50 (`raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'` after trim+lowercase), call-time, never cached.
- Per-session scope IDOR check target: `sessions.user_id UUID` (schema.sql:17).
- Partial unique index style: `CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_cloud_unique ON sessions(user_id, cloud_session_id) WHERE cloud_session_id IS NOT NULL AND deleted_at IS NULL;` (schema.sql:1581-1583). CHECK widening re-apply idiom for later changes: `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ... AND pg_get_constraintdef(oid) NOT LIKE '%''cloud''%') THEN ALTER TABLE ... DROP CONSTRAINT ...; ADD CONSTRAINT ... END IF; END $$;` (schema.sql:1587-1598). For NEW tables, put the CHECK inline in `CREATE TABLE IF NOT EXISTS` (no re-apply needed).
- Schema lint (tools/schema-sql-lint.ts): `BANNED = ["UPDATE", "INSERT", "DELETE", "TRUNCATE", "DROP"]` (:35), regex `\b(...)\b` case-insensitive over comment-stripped statement code (:170, `i` flag), only masking `ON DELETE|UPDATE CASCADE|RESTRICT|NO ACTION|SET NULL|SET DEFAULT` and `DROP CONSTRAINT|COLUMN|DEFAULT|EXPRESSION|IDENTITY|NOT NULL` (:164-168); escape pragma `-- schema-lint: allow <reason>` above one statement (:37, :193). Consequence: a CHECK literal like `'delete'` or a column default string `'update'` WOULD trip it; `updated_at`/`released_at` do not (`\bUPDATE\b` needs a word boundary). Do not use those words as enum values.
- Migrator: `runMigrations` splits and runs each statement with errors only logged (`console.error(\`[migrate] failed: ...\`)`, migrate.ts:176-183); `splitSqlStatements` exported (used by the e2e harness and schema-double-apply e2e).

PLAN IMPLICATION
- DDL `automation_kill_switch(id TEXT PK, scope TEXT NOT NULL CHECK (scope IN ('global','user','session')), user_id TEXT, session_id TEXT, engaged BOOLEAN NOT NULL DEFAULT true, reason TEXT, engaged_by TEXT NOT NULL, engaged_at TIMESTAMPTZ NOT NULL DEFAULT now(), released_by TEXT, released_at TIMESTAMPTZ)`; partial unique indexes so at most one ENGAGED row per target: `... ON automation_kill_switch((1)) WHERE scope='global' AND engaged` (or `ON (scope) WHERE scope='global' AND engaged`), `... ON automation_kill_switch(user_id) WHERE scope='user' AND engaged`, `... ON automation_kill_switch(session_id) WHERE scope='session' AND engaged`. Release = flip `engaged=false` + stamp `released_by/at` (an UPDATE in app code, fine; schema.sql stays DDL-only).
- `isAutomationHalted({userId, sessionId?}): Promise<{halted:true; scope} | {halted:false}>`: env check FIRST (call-time `REMO_AUTOMATION_KILL_SWITCH` -> `{halted:true, scope:'env'}` without touching the DB), then ONE query `SELECT scope FROM automation_kill_switch WHERE engaged = true AND (scope='global' OR (scope='user' AND user_id = $1) OR (scope='session' AND session_id = $2)) LIMIT 1`; any throw -> halted (scope `'error'`, reason `automation_halted:error`). Require `engaged === true` explicitly in the returned row (S11).
- `automationKillSwitchGate: DispatchGate = { name: 'automation_kill_switch', check(req) { ... reason: \`automation_halted:${scope}\` } }` exported from `automation-controls.ts`. Reason string verbatim from CONTEXT: `automation_halted:<scope>`.
- Routes file `hub/src/api/automation.ts` (new `new Hono()`), mounted `app.route('/api/automation', automationApi)` next to index.ts:484. Mount-time middleware (copy index.ts:416-427 shape): `app.use('/api/automation/kill-switch/release', async (c,next) => isMutating(c) ? requireRecentAuth()(c,next) : next())`, `/api/automation/lifetime/reset` same, plus `userMutationLimit` on `/api/automation/*`. Engage = no step-up (precedent index.ts:428-440). Global scope inside the handler: `if (scope === 'global' && c.get('userRole') !== 'admin') return c.json({ error: 'forbidden', reason: 'admin_required' }, 403)` (reuse the exact 403 body; do not apply `requireAdmin()` to the whole prefix). Session scope: `SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL` else 404/403 (IDOR).
- OpenAPI: spec-only `reg.registerPath` block in `_openapi.ts` modeled on the repo-groups block (`_openapi.ts:263-316`: local `Err = z.object({ error: z.string() })`, `json()` helper, `reg = openapi.openAPIRegistry`, `base = { tags: [...], security: [{ bearerAuth: [] }] }`); the plain-Hono router serves traffic (:260-262 comment: NO double mount). Then `bun run docs:sync` (package.json:14: `cd hub && bun run docs:openapi && cd .. && npx --yes widdershins@4.0.1 ... -o docs/api.md`) and commit `docs/openapi.json` + `docs/api.md`; `.woodpecker/docs-drift.yaml:26-29` fails the PR on `git diff --quiet -- docs/openapi.json docs/api.md`.
- `hub/test/mount-order.test.ts` boots the real app; add one case: unauth `GET /api/automation/kill-switch` -> 401 (like :148-162).

### D-07 - no blanket `session.stop` on engage
FACTS: `POST /api/orchestrator/stop` sends `session.stop` with `reason: 'user_stop'` (api/orchestrator.ts:131-149); `NON_RESUMABLE_EXIT_REASONS = ['user_stopped','user_disconnect','replaced']` (orphan-resume.ts:37-41); `user_stopped` is "sacred" (orphan-resume.ts:13-17).
PLAN IMPLICATION: engage handler writes the row only; no `sendToSupervisor`. Test: engage route source contains no `session.stop` (cheap static pin) and a behavior test that engage does not call the registry.

### D-08 / D-10 - kill gate in every non-human list; no queue purge
FACTS: see D-05 table. Promotion re-runs the whole list (pipeline.ts:495 -> `dispatch()` -> :225). Queued waiters are held in `waiterCtx` (pipeline.ts:190). PTY automation branch: `runChain` loops `PTY_AUTOMATION_TURN_GATES` (pty-preflight.ts:188-191) then `activeGovernors()` (:192-200) with NO try/catch by design (throws are caught by `checkPtyTurnPreflight` -> `pty_preflight_error`, :219-228).
PLAN IMPLICATION: no pipeline queue code change for D-10. Add a pipeline-level test: engage between enqueue and promotion -> the promoted waiter returns `skipped` with `automation_halted:*` (use the leaf-mocked controls module and a gate whose state flips).

### D-09 - entry-point predicates, final check, `session.start` pin

FACTS
- Scheduler: `fire()` dispatcher.ts:97-154 (disabled guard :99; once-claim :114-129 with `claimOnceTask` :116 then `fireTask(task, { chainDepth: 0, skipCronUpdate: true, isManual: true })` :127); `runNow` :156-201 (disabled guard :173 `if (!task.enabled && !opts.isManual)`); `fireTask` :210-... pre-gate block: threshold :220-244 (NOTE: the skipped branch ends with a bare `return` at :243, while the function is declared `Promise<{ runIds: string[] }>`), cost cap :246-266 (this block returns `{ runIds }` after `insertRunV2({... status: 'skipped', error: 'daily_cost_cap'})` :248-257, `broadcastScheduledRun` :258-261, `void onRunFinalized(task, run.id, 'skipped', 'daily_cost_cap')` :262, `if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)` :263, `runIds.push(run.id)` :264). Then task_type branches: triage :271-312, teab :320-362, work :372-415, default `resolveTargets` :417.
- Orchestrator tick: `scanAndEnqueueDueCycles` controller.ts:680-728 (task SQL :685-688 selects `id, session_id, timezone` - NO `user_id`); `makeCycleRunner` :598-646: cadence stamp `markRowsFired` :618-624 BEFORE `runMacroCycle` :632.
- Machine auto-launch: `maybeAutoLaunchOrchestrator` auto-launch.ts:326-363 (debounce stamp :333-338, `launchOrchestrator` call :348-353). `launchOrchestrator` :114-297, `session.start` send :264-281 inside it (shared with human `POST /api/orchestrator/start`, whose handler imports `launchOrchestrator` at api/orchestrator.ts:23; and with `launchSessionForUser`'s orchestrator branch telegram/launch.ts:101-123, and orphan-resume :174-195).
- `launchSessionForUser` callers (grep this session): ask/dispatch.ts:153, work/dispatch.ts:313, orchestrator/inject.ts:352, scheduler/senders/agent.ts:237, telegram/doctor.ts:249, plus telegram/commands.ts:184 via injected `launchImpl`.
- Every `'session.start'` sender in hub/src (grep, non-test): dispatch/spawn-on-error.ts:236; api/sessions.ts:439 and :671; api/supervisors.ts:226; telegram/launch.ts:172; orchestrator/auto-launch.ts:265; orchestrator/orphan-resume.ts:227; telegram-webhook.ts:1061 is a comment (grep only). `ws/supervisor-protocol.ts:359` is the type.
- BSA autospawn pre-launch chain: inject.ts:314-348 (flag/allowlist/supervisor/token/launch-cap checks) then `deps.launchSessionForUser` :352.

PLAN IMPLICATION
- (a) `fireTask`: insert immediately BEFORE the threshold block (dispatcher.ts:219) a `isAutomationHalted({ userId, sessionId: <task.session_id if present> })`; on halt copy the cost-cap block :246-266 exactly (`insertRunV2` status `'skipped'`, `error: \`automation_halted:${scope}\``, broadcast, `onRunFinalized`, `updateFireTimestamps` unless skipCronUpdate, return `{ runIds }`). Fail closed on throw. NOT keyed on `isManual` (once tasks pass `isManual:true`, :127). Run Now (`runNow` -> `fireTask`) is covered. Do NOT replicate the bare `return` at :243.
- (a') `fire()`: before `claimOnceTask` (:114-117) add the halt pre-check for `schedule_kind === 'once'` and return WITHOUT claiming (S13).
- (b) controller.ts: add `user_id` to the SELECT at :686 and skip the task in the loop at :695 when halted; also guard the top of the cycle runner (:599) so queue entries enqueued before engage do nothing and do not stamp cadence at :618. `maybeAutoLaunchOrchestrator`: check halted BEFORE the debounce stamp (:333) so a halted attempt does not latch the 5s debounce, and return `{ launched: false, reason: 'automation_halted' }`. `orphan-resume`: per S4. BSA chain: add a kill/halt miss as an AND-chain miss inside `maybeAutospawnOffline` between :340 and :346 returning `{ kind: 'refused', reason: 'automation_halted:<scope>' }`, so macro-cycle treats it as benign via the prefix rule (D-04).
- (c) FINAL pre-send/pre-spawn: inside `reserveInject` (before send); before `deps.launchSessionForUser` in inject.ts:352 and agent.ts:237 (`maybeLaunchOfflineSession`, return `{ skip: 'automation_halted:<scope>' }`, a `LaunchAttempt` object form already exists agent.ts:249/253); inside `launchOrchestrator` only when called with a new `machine: true` arg (auto-launch.ts:114-119 args object) passed by `maybeAutoLaunchOrchestrator`, `launchSessionForUser(... machine)` and orphan-resume; ask/work `ensureOnline` closures get the check before their `launchSessionForUser` (ask/dispatch.ts:153, work/dispatch.ts:313).
- (d) Enumerating pin `hub/test/session-start-senders-guard.test.ts`: scan hub/src (non-test) for the literal `'session.start'` / `"session.start"` in `type:` position; expected set with explicit class: MACHINE = spawn-on-error.ts (covered by lists), auto-launch.ts (arg `machine`), orphan-resume.ts (orchestrator-only defer); HUMAN = api/sessions.ts (x2), api/supervisors.ts, telegram/launch.ts (called with machine flag by machine callers). New sender fails the test until classified. Self-check that the scanner finds >= 7 occurrences.

### D-11 - governor slot replacement

FACTS (governed-pty.ts, read in full)
- Imports `AUTOMATION_ACTORS, humanOnlyRejectsActor, isDailyTokenCapEnforced, maxInjectsPerHour` from `./gates.ts` and types from `./pipeline.ts` (:37-38). `GovernorName = 'kill_switch' | 'token_cap' | 'inject_rate' | 'lifetime_counter'` (:52); `GOVERNOR_ORDER` (:55-60); `GovernorGate extends DispatchGate { name: GovernorName }` (:62-64).
- `killSwitchGovernor` body (:67-72), verbatim: `return { ok: false, reason: 'governor_not_implemented:kill_switch' }`. `lifetimeCounterGovernor` (:94-99): `return { ok: false, reason: 'governor_not_implemented:lifetime_counter' }`. `tokenCapGovernor` (:75-81) blocks `'governor_unconfigured:token_cap'` when `!isDailyTokenCapEnforced()`; `injectRateGovernor` (:84-91) `'governor_unconfigured:inject_rate'`.
- `PRODUCTION_GOVERNORS` :101-106; `activeGovernors()` :111-113; test setters `_setGovernorsForTests` :116-118, `_resetGovernorsForTests` :121-123.
- Gate form: `governedAutomationPtyGate(resolveActorAndRunnerType)` :142-164 - governor throw -> `automationBlockedReason(actor, \`governor_error:${governor.name}\`)` (:157); block -> `automationBlockedReason(actor, result.reason)` (:159); `automationBlockedReason` :131-135 builds `automation_blocked_on_pty:${actor}[:${governorReason}]`.
- gates.ts exports used by the module: `isDailyTokenCapEnforced` gates.ts:184-186, `maxInjectsPerHour` (03-RESEARCH lists gates.ts:284 on main).
- Tests that pin the removed reason (must be rewritten): governed-pty-gate.test.ts:153 (`'automation_blocked_on_pty:scheduler:governor_not_implemented:kill_switch'`), :201 (`PRODUCTION_GOVERNORS.map((g) => g.name)`), :273, :277-284 (`'the production kill_switch and lifetime_counter bodies always block with governor_not_implemented'`), :323 (`expect(sched().name).toBe('governed_automation_pty')`); pty-preflight.test.ts:306 (`'automation_blocked_on_pty:automation:governor_not_implemented:kill_switch'`); telegram-human-only-guard.test.ts:121 (`"automation_blocked_on_pty:scheduler:governor_not_implemented:kill_switch"`). Docs: docs/usage-cost.md:545 and :548 (Governors table rows 1 and 4) and surrounding "Honest scope"/"Residuals" prose (usage-cost.md:606-630).

PLAN IMPLICATION
- New neutral `hub/src/dispatch/automation-controls.ts` exports: `isAutomationHalted`, `automationKillSwitchGate`, `automationLifetimeCounterGate`, `reserveInject`, `releaseInject`, `lifetimeInjectCap`, `assertAutomationControlsEnv`, `assertAutomationControlsTables`, reset/engage/release DAL functions. It must import only `db/postgres.ts` and TYPES from pipeline.ts (avoid a cycle with gates.ts and governed-pty.ts).
- governed-pty.ts: `killSwitchGovernor` becomes `{ name: 'kill_switch', check: (req) => automationKillSwitchGate.check(req) }` and `lifetimeCounterGovernor` delegates to `automationLifetimeCounterGate.check`. Identity test per D-11: `expect(killSwitchGovernor.check).toBe(...)` is impossible if wrapped, so make the delegate a direct reference: `export const killSwitchGovernor: GovernorGate = Object.assign(Object.create(null), automationKillSwitchGate, { name: 'kill_switch' as const })` OR assert behavior-equal via `const a = await killSwitchGovernor.check(req); const b = await automationKillSwitchGate.check(req); expect(a).toEqual(b)` plus a source pin that governed-pty.ts references `automationKillSwitchGate`. Keep `GOVERNOR_ORDER`, `PRODUCTION_GOVERNORS` shape and the setter names unchanged.
- The governor `check(req)` for PTY automation gets a `req` built at pty-preflight.ts:181-187 that has no `counterKey`; the counter slot must either require one (add `counterKey` to that req from a Phase 5 supplier) or fail closed with `lifetime_counter_key_missing` today. This keeps flag-ON PTY automation blocked until Phase 5 supplies a key - consistent with D-03.
- Remove the stale header comment governed-pty.ts:19-27 ("always block with `governor_not_implemented:<name>`").

### D-12 - no `DispatchGate` signature change
FACTS: gate return = `{ ok: true } | { ok: false; reason: string }` (pipeline.ts:53); consumers derive cause from reason prefixes (inject.ts:289-291, :421-424).
PLAN IMPLICATION: keep reasons stable and prefix-parseable: `automation_halted:<scope>`, `lifetime_inject_exhausted:<n>>=<cap>` (note `>` + `>=` in one string, same style as `over_daily_token_cap:${tokens}>=${cap}` gates.ts:272). Add `counterKey` to the request only. No change to 09-SPEC consumers.

### D-13 - 60% alarm at token ingest

FACTS
- `recordTokenUsage` = token-usage-dal.ts:35-74 (ledger INSERT :39-52, daily upsert :53-72, `return rows[0]!` :73); the file imports only `sql` (:11). Callers: ws/agent.ts:822-835 (inside `if (msg.type === 'usage_event')`, try/catch :793-838) and cloud/ingest.ts:82-93 (try/catch, `runnerType: 'cloud'`). No other callers.
- Cap status: `getTokenCapStatus(userId, timezone)` gates.ts:239-247 returns `{ over, tokens, cap }`, `cap` 0 only when explicitly disabled (:244). `getTodayTokenTotal` token-usage-dal.ts:209-221 (4 buckets, tz-day boundary `date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`, :218; tz defaulted `timezone || 'UTC'` :210). Private tz helper `userTimezone` gates.ts:72-77 is NOT exported; but `getUserById(id)` (db/dal.ts:1017-1018) already returns `email`, `role`, `timezone`, `notify_channels`.
- `sendEmail({to, subject, html, text}): Promise<boolean>` email.ts:13-38; returns false (never throws) on missing env (:17-20) or non-2xx (:28-32), 10s timeout (:26).
- `fanOutNotify(input: NotifyInput, deps?)` notify.ts:160-238 (never throws; channels `'telegram' | 'inapp' | 'email' | 'push'` :36; `applyChannelPrefs` mutes only on explicit false :49-55). Existing 80% alert: observability/cap-alert.ts (03-RESEARCH sec. 5; unchanged by this phase).
- `notifications_sent` (schema.sql:731-742): `kind TEXT NOT NULL CHECK (kind IN (...7 values...))`, CHECK dropped/re-added every boot (:740-742); no uniqueness. D-13 already rejects extending it.
- Existing DAL tests with a 2-statement fake sql: see S14.

PLAN IMPLICATION
- DDL `token_cap_alarms(id TEXT PK, user_id TEXT NOT NULL, local_date DATE NOT NULL, pct INTEGER NOT NULL, tokens BIGINT, cap BIGINT, delivered BOOLEAN NOT NULL DEFAULT false, attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` + `CREATE UNIQUE INDEX IF NOT EXISTS ... ON token_cap_alarms(user_id, local_date)`.
- Hook: add `setTokenUsageListener(fn)` in token-usage-dal.ts (module-level `let`), invoked AFTER the daily upsert (after :72) as `try { void listener?.(u) } catch {}`; register once in index.ts boot with a function that does the trailing-edge per-user timer coalescing (in-memory `Map<userId, Timeout>`, D-13), then evaluates: `getUserById` (tz + email), `getTokenCapStatus(userId, tz)`; `cap > 0 && tokens >= cap * pct / 100`; claim = `INSERT ... ON CONFLICT (user_id, local_date) DO NOTHING RETURNING id`; on conflict, retry branch = atomic `UPDATE ... SET attempts = attempts + 1, last_attempt_at = now() WHERE user_id = $1 AND local_date = $2 AND delivered = false AND attempts < $max AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(...)) RETURNING id`; send via `sendEmail` to `users.email`, set `delivered = true` ONLY on a `true` return; then best-effort `fanOutNotify` with `channels: ['inapp','telegram']` (needs a `sessionId` string: pass the event session's id when known else `''`; verify `broadcastToUser` tolerates it in the test). `local_date` = the user's tz date: compute in SQL (`(now() AT TIME ZONE $tz)::date`).
- Env `REMO_TOKEN_CAP_ALARM_PCT` default 60; garbage -> 60; clamp to (0,100]; never off.
- Tests (DB-free): inject fakes for `sendEmail`, status, claim functions via a `deps` param (notify.ts `NotifyDeps` is the in-repo pattern, notify.ts:132-138); cases: below threshold no claim; crossing claims once; email false -> `delivered` stays false and retry later; second crossing same day no second email; explicit cap-disabled (cap 0) no alarm; trailing-edge: N rapid events -> exactly one evaluation after the quiet period (use fake timers or an injectable scheduler).
- Real-Postgres claim uniqueness belongs in the single e2e test (S7).

### D-14 - cap default 50M -> 20M (LAST commit)

FACTS (all opened/grepped this session; this tree)
- Source: `const DEFAULT_DAILY_TOKEN_CAP = 50_000_000` gates.ts:163; stale comment gates.ts:151-162 (says "A non-positive / non-finite value DISABLES the token ceiling (fail-open ...)" at :160-161, now false: see :196-206 and :213-231); other "50M" mentions gates.ts:156 ("Default 50_000_000 (50M) tokens/day") and :199 ("falls back to the 50M default").
- Comments: observability/orchestrator-metrics.ts:71 `/** Configured daily token ceiling (REMO_ORCHESTRATOR_DAILY_TOKEN_CAP, default 50M). */`.
- Tests asserting the SHIPPED default: token-cap-gate-fires.test.ts:35 (`const DEFAULT_CAP = 50_000_000`), :48 (`'ships a 50M default ceiling'`), :5 (comment); orchestrator-token-cap.test.ts:56 (`'allows when today tokens are under the (default 50M) cap'`), :63 (`state.tokens = 50_000_000`), :66 (`'over_daily_token_cap:50000000>=50000000'`), :87 (`.cap).toBe(50_000_000)`); orchestrator-inject-rate-gate.test.ts:54 (title), :60 (`'over_daily_token_cap:2830214000>=50000000'`); e2e/orchestrator-tokencap.e2e.test.ts:40 (`const CAP = 50_000_000 // the shipped default, asserted below`), :115 and :149 (comments/values).
- Tests using 50_000_000 only as an INJECTED param (no change required): orchestrator-cap-alert.test.ts:54-158, orchestrator-metrics.test.ts:251-273 (incl. :263 `remo_orchestrator_daily_token_cap 50000000` which renders the injected value), orchestrator-autospawn-inject.test.ts:41; web/test/term-refusal.test.ts:14 (fixture string).
- Docs: CLAUDE.md:265-266 (`default **50_000_000** = 50M tokens/day; non-positive/non-finite => disabled/fail-open` - also stale vs fail-closed), :424 (`default 50M tokens/day`), :433 (`falls back to the 50M default`); docs/auto-dev-orchestrator.md:212 (table row `| \`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP\` | \`50_000_000\` (50M) | ... Non-positive/non-finite => disabled (fail-open). |`); docs/orchestrator-autospawn-runbook.md:67 (`Conservative defaults ship in code: token cap **50M tokens/day**`), :71 (`# default 50_000_000`); .planning/codebase/INTEGRATIONS.md:117 and ARCHITECTURE.md:201 (informational maps); .planning/ROADMAP.md:115; 07-SPEC.md:185 and 09-SPEC (future specs, leave).
- Not found: .woodpecker/, tools/, Dockerfile, web/src, supervisor/src, mcp/ (03-RESEARCH grep; re-confirmed absent from this session's repo-wide grep output).

PLAN IMPLICATION: one commit, LAST: change :163 to `20_000_000`, rewrite the comment block :151-162 truthfully (fail-closed, 20M, prod override), update the 4 test files' literals/reason strings (`over_daily_token_cap:20000000>=20000000`, `2830214000>=20000000`), the e2e `CAP`, the metrics comment, and the doc lines above; add a prominent CLAUDE.md paragraph (applies only where `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` is unset; human PTY usage counts and `pty-preflight` checks it on Enter; prod env check is an owner action). Do not change prod env. Verify with `grep -rn "50_000_000\|50M\|50000000" hub/src hub/test CLAUDE.md docs` leaving only the injected-param and fixture cases.

### D-15 - G-1 fix (FIRST commit) + supervisor version bump

FACTS
- Emitter: `SEEN_UUID_CAP = 5000` supervisor/src/usage/pty-usage-emitter.ts:33; state `seen: Set<string>`, `seenOrder: string[]` :235-236; `extractUsage` :51-64 (returns the four buckets + model; does NOT read `message.id`); `onRecord` :328-367: zero-bucket skip :332-339, dedupe on `record.uuid` ONLY :340-349 (`if (this.seen.has(uuid)) return` then add + FIFO eviction), emit `usage_event` with `runner_type: 'pty-interactive'` :350-362; frame type `PtyUsageEventFrame` :192-204; tail from file start `fromStart: true` :381 (so replays are expected and dedupe matters).
- Existing tests always omit `message.id` and give `uuid` (supervisor/test/pty-usage-tail.test.ts:268, :324, :347, :368: e.g. `{ type: 'assistant', uuid: 'u-dup', message: { usage: {...} } }`), so the fallback path must keep passing unchanged; "appending the SAME record (same uuid) twice emits once" is at :359-368.
- CI runs this file: `.woodpecker/qc.yaml:52`. Local: `cd supervisor; bun test test/pty-usage-tail.test.ts test/pty-usage-path-containment.test.ts`.
- Version files (all read): `supervisor/tauri/src-tauri/tauri.conf.json:4` `"version": "0.15.0"` (authoritative; `supervisor/src/version.ts` imports it), `supervisor/tauri/src-tauri/Cargo.toml:3` `version = "0.15.0"`, `supervisor/tauri/ui/package.json:4` `"version": "0.15.0"`, plus the `Cargo.lock` package entry. Drift test: `supervisor/test/version-drift.test.ts` checks (1) runtime VERSION == tauri.conf, (2) Cargo.toml, (3) ui/package.json (test:17-19 header, :50-58). The prior bump PR #471 (`2c0fef6`) changed exactly: Cargo.lock (201-line churn), Cargo.toml, tauri.conf.json, ui/package.json. `supervisor/package.json:3` = `0.14.5` is not part of the drift test.

PLAN IMPLICATION
- Change `onRecord`: key = `record.message?.id` (string) else `record.uuid`; keep per-key `max` of each of the 4 buckets in a `Map<string, {in,out,cc,cr}>` (bounded by `SEEN_UUID_CAP` with the same FIFO eviction); emit ONLY positive deltas per bucket vs the stored maximum (clamp negatives to 0); skip the emit when all four deltas are 0; update stored maxima to `max(old, new)`. The emitted frame carries the delta values in the same four fields (frame shape unchanged).
- New tests in `supervisor/test/pty-usage-tail.test.ts` (CI-gated): three records one `message.id` (increasing usage) -> frames sum to the final record's usage, not 3x; out-of-order (later record has smaller bucket) -> clamp, no negative frame; same id different uuid after eviction boundary is acceptable; absent `message.id` keeps the old uuid behavior (existing tests untouched).
- Bump to 0.15.1 (patch) in the 4 files (tauri.conf.json, Cargo.toml, ui/package.json, Cargo.lock package entry only - do NOT regenerate the whole lockfile; if cargo is unavailable, edit only that entry's version line). Run `bun test supervisor/test/version-drift.test.ts`. PR body: hub deploys on merge but hosts need the signed MSI (`release-supervisor.yml` on a `supervisor-v*.*.*` tag); until then the effective PTY ceiling is ~2.5x lower than real (D-15 states ~10.9M of 20M... treat as the owner-facing statement, not verified here).

### D-16 - boot assertions
FACTS: S1. `runMigrations()` chain index.ts:706-710+ (`.then(() => setOfflineStaleAgentSessions())` etc.); migrate swallows per-statement DDL failure (migrate.ts:176-183). Existing sync boot guard index.ts:569-574.
PLAN IMPLICATION: `assertAutomationControlsEnv()` beside index.ts:569-574 (same try/catch/exit shape); `assertAutomationControlsTables()` (async: `SELECT to_regclass('automation_inject_ledger')` x3 tables, any null -> throw) as the first `.then` after `runMigrations()` with its own `catch -> console.error('[startup] FATAL: ...'); process.exit(1)`. Unit tests: env half pure (copy token-cap-gate-fires.test.ts:100-105 style); table half with a fake `sql` returning null/oid.

### D-17 - emergency path (no UI)
FACTS: break-glass API = cookie session or legacy Bearer JWT; CSRF is bypassed for Bearer (csrf.ts:95-141); `/api/*` is gated by `requireActiveLicense({ readOnlyOk: true })` (index.ts:348-360) - a mutation requires an ACTIVE license (an EXPIRED-grace owner cannot engage via API; env break-glass is the only path then); release needs session age <= 900s (reauth.ts:37-44, :63-66).
PLAN IMPLICATION: document the three paths in CLAUDE.md/docs (API engage; env `REMO_AUTOMATION_KILL_SWITCH=1` + redeploy; re-login before release). Add a GOV follow-up note to ROADMAP deferred items. Engage should work under an expired license? Not required; state the limitation.

### D-18 - top-level only
FACTS: one `dispatch()` call = one reserve (design). `dispatch()` is invoked once per request except promotion/replay re-entry which share the token.
PLAN IMPLICATION: documentation + a test that two `dispatch()` calls with the SAME token produce one ledger row; nothing else.

### D-19 - invariants
FACTS: schema lint rules above (D-06). `skip` 259 / `skip_max` 260 (S7). `bun run check-baseline` runs each hub test file in its own process (tools/check-baseline.ts + regression-baseline.json `_comment`; hub/bunfig.toml preload `./test/_setup.ts` restores mocks after each file, _setup.ts:1-30).
PLAN IMPLICATION: new DDL after schema.sql:1598 only; no hub/scripts needed (no backfill: new tables start empty; counters start at 0 for all keys, which is acceptable and should be stated). All new env flags: `REMO_AUTOMATION_KILL_SWITCH` (default off), `REMO_AUTOMATION_LIFETIME_INJECT_CAP` (default 1000, fail-closed boot), `REMO_TOKEN_CAP_ALARM_PCT` (default 60).

---------------------------------------------------------------------------------------------------
## 2. INVENTORIES
---------------------------------------------------------------------------------------------------

### 2.1 Files a planner will touch (src)
hub/src/dispatch/pipeline.ts (type + reserve + release), dispatch/automation-controls.ts (NEW), dispatch/governed-pty.ts (slot bodies), dispatch/gates.ts (comment + 20M const + keep exports), orchestrator/inject.ts, orchestrator/macro-cycle.ts, orchestrator/controller.ts, orchestrator/auto-launch.ts, orchestrator/orphan-resume.ts, scheduler/dispatcher.ts, scheduler/senders/agent.ts, scheduler/senders/triage.ts, error-capture/dispatcher.ts, feedback/dispatcher.ts, revanote/dispatcher.ts, ask/dispatch.ts, work/dispatch.ts, telegram/launch.ts (machine flag), db/token-usage-dal.ts (listener), api/automation.ts (NEW), api/_openapi.ts, index.ts, db/schema.sql, observability/orchestrator-metrics.ts (comment), supervisor/src/usage/pty-usage-emitter.ts + 4 version files. NOT touched: cloud/send.ts, telegram/dispatch.ts, pty-preflight.ts `ptyPreflightDispatchConfig.gates`.

### 2.2 Existing tests that WILL need edits (known)
- governed-pty-gate.test.ts:153, :201, :273, :277-284, :323 (`governor_not_implemented` / slot bodies)
- pty-preflight.test.ts:306 (+ :137-155, :381 only if the arrays change - they must not)
- telegram-human-only-guard.test.ts:121
- token-cap-gate-fires.test.ts, orchestrator-token-cap.test.ts, orchestrator-inject-rate-gate.test.ts, e2e/orchestrator-tokencap.e2e.test.ts (20M)
- Possibly (check-baseline will tell): the 9 files mocking `dispatch/gates.ts` (S11), usage-event-handler / token-usage-runner-type / pty-usage-midflight-visibility (S14), orchestrator-autospawn-inject.test.ts (InjectDeps/launch seam), orchestrator-command-prompts.test.ts, ext-ask-gates.test.ts (additive), once-tasks.test.ts (fire() once path), dispatcher-disabled-guard.test.ts, scheduler-dispatch.test.ts.
- Docs: docs/usage-cost.md (Governors table :536-556 and Phase 3 sections up to :630; add a "PTYCAP Phase 4" section), CLAUDE.md (env section near :265-275, :424-440, docs-map row near :401), docs/auto-dev-orchestrator.md:212, docs/orchestrator-autospawn-runbook.md:67/:71, docs/api.md + docs/openapi.json (docs:sync).

### 2.3 `session.start` senders (D-09d seed)
spawn-on-error.ts:236 (post-gate, covered), auto-launch.ts:265 (shared; add `machine` arg), orphan-resume.ts:227 (plain) + :177 (orchestrator via launchOrchestrator), telegram/launch.ts:172 (shared; add `machine` arg), api/sessions.ts:439 and :671 (human; grep only), api/supervisors.ts:226 (human; grep only).

---------------------------------------------------------------------------------------------------
## 3. VALIDATION ARCHITECTURE
---------------------------------------------------------------------------------------------------

Repo gate (per task commit: the touched test files only; per wave: both):
- `bun run check-baseline` (repo root; per-file process isolation; floors: pass_min 1850, skip_max 260, fail_max 0)
- `cd hub; bunx tsc --noEmit -p tsconfig.json` -> compare `grep -c "error TS"` to the 427 baseline (S15); zero NEW errors in touched files
- `bun run schema-lint` (tools/schema-sql-lint.ts; exit 0 required)
- `bun run docs:sync` then `git diff --stat -- docs/openapi.json docs/api.md` committed (docs-drift)
- `bun test supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts supervisor/test/version-drift.test.ts` (qc.yaml:52 plus the drift test, which CI does not run)

Per-decision commands (ONE bun process per file; run from `hub/` unless noted):
| Decision | New/changed test file | Command | DB? |
|---|---|---|---|
| D-01 key pin + derivation | hub/test/counter-key-assignment-guard.test.ts (NEW), hub/test/orchestrator-inject-counterkey.test.ts (NEW: macro-cycle passes taskId; fallback `session:`) | `bun test test/counter-key-assignment-guard.test.ts` | no |
| D-02 reserve | hub/test/dispatch-reserve.test.ts (NEW, leaf-mocked controls), hub/test/dispatch-pipeline.test.ts (unchanged, must stay green) | `bun test test/dispatch-reserve.test.ts` ; `bun test test/dispatch-pipeline.test.ts` | no |
| D-02 atomicity/race | hub/test/e2e/automation-reserve.e2e.test.ts (NEW, ONE test, 20 concurrent reserves of cap 5 -> exactly 5 rows; idempotent token; reset marker; released_at excluded) | from repo root `REMO_E2E_DB_URL=postgres://... REMO_E2E_ALLOW_NONLOCAL=1 bun test hub/test/e2e/automation-reserve.e2e.test.ts` (CI only; skipped locally) | YES (CI) |
| D-03 replay re-entry | hub/test/orchestrator-autospawn-inject.test.ts (extend: replay calls dispatch, reserve called once) | `bun test test/orchestrator-autospawn-inject.test.ts` | no |
| D-04 cap/boot/reset/notify | hub/test/automation-controls-config.test.ts (NEW), hub/test/orchestrator-macro-cycle*.test.ts (extend: `automation_halted:` benign, exhausted pages once) | `bun test test/automation-controls-config.test.ts` | no |
| D-05/D-08 coverage | hub/test/kill-switch-coverage.test.ts (NEW) + token-cap-coverage.test.ts (unchanged) | `bun test test/kill-switch-coverage.test.ts test/token-cap-coverage.test.ts` (separate processes) | no |
| D-06 routes/tenancy | hub/test/automation-api.test.ts (NEW, mocked DAL: global requires admin, user scope, session IDOR, release needs recent auth, engage does not), hub/test/mount-order.test.ts (+401 case), openapi registration test if one exists | `bun test test/automation-api.test.ts` | no |
| D-07 no stop | in automation-api.test.ts + a source pin | same | no |
| D-09 entry points | hub/test/scheduler-halt.test.ts (NEW: fireTask blocked incl. isManual, once task not claimed, Run Now blocked), hub/test/orchestrator-tick-halt.test.ts (NEW: scan skips, cycle runner no cadence stamp), hub/test/orphan-resume-halt.test.ts (NEW: orchestrator orphan deferred, row not ended), hub/test/session-start-senders-guard.test.ts (NEW) | one process each | no |
| D-10 queue | pipeline test: halt flips between enqueue and promotion | in dispatch-reserve.test.ts | no |
| D-11 slots | governed-pty-gate.test.ts (rewritten), pty-preflight.test.ts:306, telegram-human-only-guard.test.ts:121 | `bun test test/governed-pty-gate.test.ts` etc. | no |
| D-13 alarm | hub/test/token-cap-alarm.test.ts (NEW, injected deps) | `bun test test/token-cap-alarm.test.ts` | no (claim uniqueness in the e2e above) |
| D-14 cap | the 4 updated cap files + `grep -rn "50_000_000\|50M\|50000000" hub/src hub/test CLAUDE.md docs` review | `bun test test/token-cap-gate-fires.test.ts` ; `bun test test/orchestrator-token-cap.test.ts` ; `bun test test/orchestrator-inject-rate-gate.test.ts` | no (e2e in CI) |
| D-15 G-1 | supervisor/test/pty-usage-tail.test.ts (extend) + version-drift | from `supervisor/`: `bun test test/pty-usage-tail.test.ts test/version-drift.test.ts` | no |
| D-16 boot | in automation-controls-config.test.ts | same | no |
| schema | schema-lint + hub/test/e2e/schema-double-apply.e2e.test.ts (CI) | `bun run schema-lint` | CI |

Sampling: per task commit = the new/changed test files of that task + `bun run schema-lint` if schema.sql changed; per wave = full `bun run check-baseline` + tsc count; phase gate = check-baseline green, tsc count <= 427, schema-lint, docs:sync clean diff, supervisor tests, then `/gsd-verify-work`.

Wave 0 gaps: (1) `automation-controls.ts` skeleton exporting the final names so wiring tasks can import before DB logic; (2) a mock helper convention for the new module in tests (leaf mock `mock.module('../src/dispatch/automation-controls.ts', ...)` + cache-busted imports `?t=${Date.now()}`, the pty-preflight.test.ts:35-68 pattern); (3) decide skip_max handling for the single e2e test (S7); (4) run `bun run check-baseline` once after wiring the gates to enumerate the mock-breakage list (S11, S14).

---------------------------------------------------------------------------------------------------
## 4. ENVIRONMENT AVAILABILITY
---------------------------------------------------------------------------------------------------
| Dependency | Needed by | Available | Note |
|---|---|---|---|
| bun | all tests | yes, 1.3.14 | verified `bun --version` |
| Postgres (psql/pg_isready/docker) | e2e reserve/race, schema double-apply | NO | `REMO_E2E_DB_URL` unset; DB-backed proof is CI-only (Woodpecker postgres:16). Local confidence for reserve SQL = mocked-SQL text tests only. |
| cargo | Cargo.lock bump | not checked | edit the single lock entry by hand if absent |
| npx (widdershins) | docs:sync | not checked | network needed; docs-drift CI enforces |

---------------------------------------------------------------------------------------------------
## 5. ASSUMPTIONS / NOT VERIFIED
---------------------------------------------------------------------------------------------------
- A1 [ASSUMED] Postgres READ COMMITTED lets two concurrent `INSERT ... SELECT WHERE count < cap` both pass (S5); advisory-lock fix is the recommended mitigation. Verify with the CI e2e.
- A2 [ASSUMED] Bun test counts each test inside `describe.skip` as skipped in junit (consistent with regression-baseline.json `_comment` "+9 skips here, all DB-gated"); not re-measured.
- A3 [ASSUMED] human classification of api/sessions.ts:439/:671 and api/supervisors.ts:226 (web start/launch). Only grep lines and a comment (sessions.ts:~635) were seen; planner/executor should open them when writing the pin test.
- A4 (grep only) error-capture/dispatcher.ts:167, feedback/dispatcher.ts:130, revanote/dispatcher.ts:317 list contents were read from grep output, not opened; ws/agent.ts:949/:984 callers of orphan-resume/auto-launch likewise.
- A5 Prod frequency of recurring scheduled tasks and the `__internal_triage` event volume are unknown (S9 arithmetic only).
- A6 The effective "~10.9M real tokens" PTY statement in D-15 was not independently recomputed.
- A7 `gates.ts` import of `getTodayTokenTotal` from the DAL (the cycle D-13 mentions) was inferred from the call at gates.ts:245; the import statement itself was not viewed.

---------------------------------------------------------------------------------------------------
## 6. SUGGESTED PLAN SHAPE (non-binding)
---------------------------------------------------------------------------------------------------
Commit order honoring D-15 first / D-14 last: (1) G-1 + version bump; (2) DDL + `automation-controls.ts` + boot asserts + schema-lint; (3) pipeline `counterKey` + reserve/release + replay re-entry + pins; (4) kill-switch gates into lists + coverage test + governor slots + rewritten Phase 3 tests; (5) entry-point/spawn guards (scheduler, controller tick, auto-launch, orphan-resume, launch `machine` arg) + `session.start` pin; (6) routes + OpenAPI + docs:sync + mount-order; (7) alarm table + listener + tests; (8) e2e test (single) + baseline note; (9) docs; (10) 50M -> 20M LAST.
