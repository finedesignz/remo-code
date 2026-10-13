# Phase 4: Planner Forks (for panel confirm / overturn)

**Written:** 2026-10-13 by the planner. **Binding record:** 04-CONTEXT.md D-01..D-19 (locked). **Evidence base:** 04-RESEARCH.md (file:line facts, tree `remo-code-gsd`) plus this session's reads of the Phase 4 worktree (`remo-code-ptycap04`, stacked on the Phase 3 branch).

The 04-RESEARCH "top surprises" S1..S15 forced choices that 04-CONTEXT does not settle, or settles with text that the evidence contradicts. Each fork below states the options, the planner's pick **(R)**, the evidence, and what overturning it would change. Plans were written to the pick so a panel can confirm or overturn without re-planning from scratch. Hard invariants applied to every pick: fail closed, default-OFF flags are true no-ops, additive idempotent DDL in schema.sql with backfills only in hub/scripts/, event-driven never polling, no LLM API keys, smallest diff.

| Fork | Topic | Amends a lock? | R | Overturn risk | Plan |
|---|---|---|---|---|---|
| F-1 | Boot assertion split (S1) | refines D-16 | env half sync, table half after migrations | low | 04-02 T3 |
| F-2 | Human vs machine surfaces; machine option on launch primitives (S2, S3) | amends D-05/D-08 text ("cloud send") | cloud send + Telegram are HUMAN; `machine` option inside the two launch primitives | medium | 04-06, 04-07 |
| F-3 | Reserve atomicity, slot release, final halt check (S5, S6) | refines D-02/D-09c | advisory lock + releaseAndPromote + machine detected from the gate list | low | 04-02 T1 |
| F-4 | Orphan-resume defer, release-time resume, one-time claim (S4, S13) | refines D-09b | orchestrator orphans only, before the reboot UPDATE; supervisor-scoped resume on release; halt check before claimOnceTask | medium | 04-06 T3, 04-07 |
| F-5a | Recurring cron vs LIFETIME cap (S9) | none (reads D-04 literally) | literal lifetime, owner reset | **HIGH** | 04-03 |
| F-5b | `__internal_triage` shared budget (S9) | none (reads D-05 literally) | count it under the per-user triage task key | **HIGH** | 04-03 T2 |
| F-5c | Orchestrator two budgets (S10) | refines D-01 | `task:<id>` everywhere via a resolver | medium | 04-02 T1, 04-03 T1 |
| F-6 | Who consumes at the PTY door; does the rate governor count (Phase 3 QC adversary) | amends D-03 | the DOOR reserves (producer supplies key + per-turn token); rate governor counts | **HIGH** | 04-04 |
| F-7 | Alarm hook shape (S14) | refines D-13 | listener registry set at boot | low | 04-05 T3 |
| F-8 | Skip accounting for the e2e proof (S7) | refines D-19 | ONE e2e test, use the single skip of headroom, no skip_max bump | low | 04-08 T1 |
| F-9 | Where the exhaustion page lives | refines D-04 | controls module, durable ledger page-row, macro-cycle treats the class as benign | medium | 04-02 T2, 04-03 T1 |

---

## F-1 Boot assertion split (research S1)
**Options:** (A) single synchronous `assertAutomationControls()` beside `assertTokenCapConfig` (index.ts:569-574). (B) split: sync env half there, async table-existence half as the first step after `runMigrations()` (index.ts:706-707).
**R = B.** Evidence: index.ts:569-574 runs BEFORE `Bun.serve` (:586) and BEFORE `runMigrations()` (:706), so option A's `to_regclass` check would `process.exit(1)` on the first deploy (tables not created yet); migrate.ts:176-183 swallows per-statement DDL failures, which is the failure the table half exists to surface. Residual: the server already listens during the table half; every gate fails closed on a DB error in that window (stated in the code comment). Pinned by `automation-boot-order.test.ts`.
**If overturned to A:** first deploy of a fresh DB exits 1. Not viable.

## F-2 Human vs machine surfaces (research S2, S3)
**Options:** (A) follow D-05/D-08 text literally: kill gate in "cloud send" too. (B) classify `cloud/send.ts` and `telegram/dispatch.ts` HUMAN (no kill gate); add a `machine` option to `launchSessionForUser` and `launchOrchestrator` that performs the halt check inside, pass it from the four machine callers only, pin every caller and every `session.start` sender.
**R = B.** Evidence: `sendToCloudSession` has one caller, `ws/client.ts:720-721` (a human typing in a cloud session, after `send_ack` :691-699); `cloud-send.test.ts:70` pins the list to `['daily_cost_cap','daily_token_cap']`; Telegram's list at `telegram/dispatch.ts:180` is human (sole caller passes `source: "human"`, telegram-webhook.ts:399, pinned by Phase 3 pty-door-guard). `launchSessionForUser` (telegram/launch.ts:82) is shared with human `/doctor` (doctor.ts:249) and commands.ts:184, so a blanket check inside it blocks humans. Pre-dispatch spawns (`inject.ts:350-355`, `scheduler/senders/agent.ts:237`) run before any gate list, so only a primitive-level check covers them.
**Caveat for the panel:** the 04-RESEARCH A3 assumption that api/sessions.ts (x2) and api/supervisors.ts are human web actions was not opened by the researcher; plan 04-07 Task 2 opens each before pinning and stops if one is machine-driven.
**If overturned to A:** a halt would lock humans out of cloud chat and break cloud-send.test.ts.

## F-3 Reserve atomicity, slot release, final halt check (research S5, S6, D-09c)
**Options for atomicity:** (A) `INSERT ... SELECT ... WHERE count < cap ON CONFLICT DO NOTHING` as written in D-02. (B) same, inside `sql.begin` after `pg_advisory_xact_lock(hashtext('lifetime:' || counter_key))`.
**R = B.** Evidence: under READ COMMITTED two concurrent reserves can both read count = cap-1 and both insert (no row to lock) [ASSUMED Postgres semantics; proven only by the CI e2e, 04-08 T1]; repo precedent `auto-launch.ts:153-155` uses exactly this lock idiom. Idempotency handled inside the lock: an existing unreleased `(counter_key, token)` row returns ok; a released one is re-reserved under the same count check.
**Slot release:** `dispatch()` holds the in-flight slot at the reserve point (queue.enqueue pipeline.ts:238; park path releases at :283). A reserve-skip MUST `releaseAndPromote` or every later dispatch to that session is `session_busy`. Tracer test asserts it.
**Final halt check (D-09c) for key-less adapters:** error-capture/feedback/revanote/ask/work have no counterKey (D-05), so a check living only inside `reserveInject` would skip them. R: the pipeline treats a request as machine when `deps.gates` contains the gate named `automation_kill_switch` (the coverage test already forces that gate into every non-human list), and runs the halt re-check in `preSendGuard` for it even without a key.

## F-4 Orphan-resume, release-time resume, one-time claim (research S4, S13)
**Findings:** the orphan loop ENDS the row (`exit_reason='reboot'`, orphan-resume.ts ~:167) before relaunch, so "defer without finalizing" must `continue` before that UPDATE; triggers are supervisor.hello and browser auth (rate-limited 60s/user, :260-283), not engage/release; the 24h stale sweep finalizes un-resumed orphans; non-orchestrator orphans cannot be classified human vs machine.
**R:** defer ONLY orchestrator orphans (the one machine-driven kind), after the user_stopped and restart-cap guards, before the UPDATE, into a new `skipped_halted` bucket; non-orchestrator orphans are never deferred. The release route (user/global scope) calls the supervisor-scoped `resumeOrphansForSupervisor` per online supervisor of the releasing user (the user-scoped function is rate-limited and could no-op). Global release resumes only the releasing admin's supervisors; other users' deferred orchestrator orphans resume on their next hello/auth (documented residual). No polling.
**One-time tasks:** `fire()` claims (`claimOnceTask`, dispatcher.ts:116, flips `enabled=false`) BEFORE `fireTask`; a check only in `fireTask` would burn client-email work. R: halt pre-check in `fire()` for `schedule_kind==='once'` that returns without claiming; `once-due-sweep.ts` (re-fires overdue once tasks through the atomic claim) picks it up after release (executor verifies; residual documented if not).

## F-5 Counter-key semantics (research S9, S10): the fork that changes what "lifetime per-task" means
**D-01/D-04/D-05 as locked:** key `task:<scheduled_tasks.id>` where the dispatcher knows its task else `session:<id>`; lifetime cap 1000 per key; counted forever; owner reset appends a marker; applies to orchestrator inject, scheduler agent, triage.

### F-5a Recurring cron tasks vs a LIFETIME cap
Arithmetic: 1000 / (96 per day at 15 minutes) = about 10.4 days; hourly = 41 days; daily = 2.7 years.
**Options:** (A) literal lifetime, no auto-reset (D-04). (B) exempt scheduler cron tasks from the counter. (C) windowed/rolling reset (a "per 30 days" budget).
**R = A.** Evidence: the SC-1 text itself, "4/hr forever is still 35,000/year" (ROADMAP Phase 4), describes exactly a 15 minute (4/hr) cron; (B) contradicts D-05 and removes the very bound SC-1 asks for; (C) is a different feature (a rate, which `sessionInjectRateGate` and the daily token cap already are) and defeats "lifetime". Mitigation for the silent-brick risk: exhaustion pages the owner once per (key, reset epoch) from the controls module (F-9), the run row shows `skipped` with the greppable reason, and reset is one authenticated call. **Panel question:** is "a 15 minute cron needs an owner reset every ~10 days" acceptable product behavior? If not, the honest alternative is (B) with an explicit per-task opt-out, which is a product decision, not a technical one.

### F-5b `__internal_triage` shared budget
`ensureInternalTriageTask(userId)` (db/dal.ts:1615-1640) is ONE row per USER (not global) and every Coolify webhook triage for that user runs under it, so triage counts one lifetime budget per user.
**Options:** (A) count it as locked (D-05 names "scheduler agent + triage"). (B) treat triage like error-capture: kill switch only (it is an event stream). (C) key per Coolify application (`triage:<application_uuid>`), a new key namespace.
**R = A.** Evidence: D-05 explicitly lists triage in the counted set; the triage list has no inject-rate gate (triage.ts:142: threshold, cost, token only), so the lifetime counter is its only count-based bound against a webhook flood; exhaustion is loud (F-9) and resettable. **Most likely overturn:** the D-05 rationale for exempting error-capture ("event streams have no task; a per-session cap would brick a busy repo's self-heal") applies equally to webhook triage. If the panel picks (B), the change is two lines in 04-03 Task 2 (drop the counter gate and key for triage) and the exemption map in 04-06's coverage test.

### F-5c Orchestrator two budgets
Callers of `injectOrchestratorPrompt`: macro-cycle.ts:225 (knows `input.taskId`, macro-cycle.ts:43), merge-command.ts:228, verify-tail.ts:321 (+seams :183/:267), wave-runner.ts:150; the latter three know only `sessionId`, all three are live (imported by controller.ts:31-33). One orchestrator task per session is verified (controller.ts:685-688).
**Options:** (A) thread `taskId` from macro-cycle only; others key `session:<id>` -> two independent 1000 budgets per orchestrator. (B) key every orchestrator inject `session:<id>` (one budget; contradicts D-01's explicit `task:<id>` for the orchestrator). (C) key `task:<orchestrator task id>` for ALL callers: macro-cycle passes taskId, the others resolve the 1:1 task through `resolveOrchestratorCounterKey` (one indexed SELECT on scheduled_tasks by user and session); no row gives `session:<id>` (D-01's else branch), a DB error fails closed.
**R = C.** One budget AND D-01 honored literally. Cost: a per-inject lookup for the three rare non-macro callers and an optional `InjectDeps.resolveCounterKey` seam (existing tests that call the real inject with partial deps need a one-line override; found by check-baseline). **Overturn to B** is simpler (no resolver, no DB read) and equivalent in effect; choose it if the panel prefers smallest diff over D-01 literalness.

## F-6 PTY door: who consumes; does the inject-rate governor count (Phase 3 QC adversary finding)
**Finding (adversary seat):** `injectRateGovernor` checks config only; the Telegram gate list has no `sessionInjectRateGate`; once the governors are real, an admitted automation PTY turn must be COUNTED (ledger + rate) before the flag can admit anything.
**D-03 as locked:** the PTY door does not use `dispatch()`; "the Phase 5 producer must mint a per-turn token and call the same reserve". That leaves the flag-ON admit path uncounted until Phase 5 remembers.
**Options:** (A) as locked: producer calls `reserveInject`; door only checks. (B) the door (`runChain` automation branch) consumes: after the spend gates and governors pass it calls `reserveInject` itself, requiring a server-supplied `counterKey` and per-turn `turnToken` (missing -> refuse). Phase 5 supplies the two fields. (C) B plus make `injectRateGovernor` count real injects.
**R = C.** Evidence: pty-preflight.ts:174-202 is the only sanctioned door and already runs governors in the automation branch with no try/catch (throw -> `pty_preflight_error`, hang -> `pty_preflight_timeout`); `sessionInjectRateGate` counts only `routine_run_log` (orchestrator) rows (gates.ts:310-321 via `countSessionInjectsSince`), so non-orchestrator admitted turns would never be rate-counted; the governors run for ask/work/Telegram lists too (governedAutomationPtyGate) where no inject-rate gate exists. The rate governor now takes the larger of the run-log count and the ledger count (set union bound; a sum would double count orchestrator injects). The constant token `pty-preflight:<sessionId>` (pty-preflight.ts:184) must never be the reserve token (the second turn would be a no-op). Caller pins: `reserveInject(` only in the controls module and the door; `counterKey`/`turnToken` supplied to `checkPtyTurnPreflight` only from `hub/src/orchestrator/`. Residual (documented): the 5s preflight timeout can fire after the reserve inserted (refused but counted; over-count is the safe direction).
**If overturned to A:** 04-04 Task 2 shrinks to a caller pin and Phase 5 owns the reserve; the adversary entry criterion stays open until then.

## F-7 Alarm hook shape (research S14)
**Options:** (A) D-13 as written: late dynamic import inside `recordTokenUsage`, fire-and-forget. (B) listener registry (`setTokenUsageListener`) registered once at boot.
**R = B.** Evidence: three DAL tests (`usage-event-handler`, `token-usage-runner-type`, `pty-usage-midflight-visibility`) call the real `recordTokenUsage` against a fake `sql` that emulates exactly the two ledger statements (usage-event-handler.test.ts:16-60, token-usage-runner-type.test.ts:37-66); any extra statement or import side effect in that function hits the fake. A registry leaves them untouched and is still event-driven (rule 23), still after the ledger commit, still fire-and-forget. D-13's other properties (trailing-edge coalescing with a max wait, durable claim with `delivered`, email independent of `notify_channels`, inapp+telegram fan-out only) are unchanged.

## F-8 Skip accounting for the e2e proof (research S7)
D-19 says "no new skipped tests (259 vs skip_max 260)", but all DB-backed proof is `describe.skip` without `REMO_E2E_DB_URL`, and every test inside counts as a skip. **Options:** (A) one new e2e file with exactly ONE `test()` (skip 259 -> 260 = skip_max, headroom used up, no bump). (B) raise `skip_max` with a dated note. (C) early-return inside the test when no DB (vacuous local pass).
**R = A.** (B) erodes the ratchet; (C) launders a skip into a pass, which the baseline file explicitly forbids ("a skip added for any other reason is a failure in disguise"). The single test is sectioned (reserve race, idempotency, release, reset, page claim, kill-switch unique indexes, alarm claim, real inject path). Consequence stated in the baseline note: zero skip headroom remains for the next phase.

## F-9 Where the exhaustion page lives (D-04 placement)
D-04: `lifetime_inject_exhausted` pages ONCE per (counter_key, reset epoch) via a durable claim; `automation_halted:*` is benign in macro-cycle (~:283-296).
**Options:** (A) macro-cycle emits the page. (B) the controls module pages at the moment a counter gate or reserve blocks, claiming once per epoch; macro-cycle treats both classes as benign.
**R = B.** Evidence: scheduler agent and triage have no macro-cycle, so (A) leaves them silent (T-04-14, F-5a/b would be invisible); the claim reuses the ledger itself (a `kind='page'` row with token `page:<epoch seq>` and the existing `UNIQUE(counter_key, token)`), so there is no fourth table and D-16's three-table assertion stays exact. Page delivery is claim-then-send via `fanOutNotify` on all four channels (never throws); a lost page is possible and accepted (the block itself is loud on every run row).

---

## Not forks (recorded so they are not re-litigated)
- **Plan count 8 vs target 4-6.** Seven independent concerns (G-1, tracer+core, counting expansion, PTY door, owner surfaces, kill-switch coverage, spawn-site guards) plus the D-15-first / D-14-last chain ends. Merging them violates the 2-3 tasks per plan and 50 percent context rules (04-06 and 04-07 alone touch 13-15 files). The only mergeable pair, 04-06 + 04-07, would form a 6-task plan.
- **No read endpoint for lifetime counts.** D-04 lists only the reset route; the page and run-row reasons carry the counter_key. Add a GET only if the panel wants visibility without a page.
- **Kill-switch UI/Telegram trigger, active-run cancellation, per-user aggregate ceiling:** deferred by D-07/CONTEXT (recorded in ROADMAP by 04-08).
- **Tracer placement:** 04-01 (G-1) is the D-15 first commit and touches no hub layer; the phase tracer leads the hub plans as 04-02 Task 1.
- **Skills/commit trailer:** per the dispatching instruction the planning commit carries `Co-Authored-By: Claude Opus 5.5`.
