<!-- PTYCAP Phase 3+4 codebase research (read-only recon, 2026-10-07). Facts only; decisions live in 03-CONTEXT.md / 04-CONTEXT.md. Phase 4 reads this file too (sections 4-10). -->

# PTYCAP Phases 3+4 -- landscape (read-only recon)

Worktree: C:\Users\artic\GitHub\remo-code-gsd | branch `phase-ptycap-03-governed-automation-guard` | HEAD 008c276 | date 2026-10-07.
Facts only. `path:line` are relative to the worktree root. Quotes are ASCII-normalized (source has unicode arrows/dashes).
No repo file was modified. Test commands in section 9 were actually run (results recorded).

---------------------------------------------------------------------------------------------------
## 1. humanOnlyPtyGate -- definition, callers, tests, actor derivation, spoof surface, PTY write paths
---------------------------------------------------------------------------------------------------

### 1.1 Definition and exports (hub/src/dispatch/gates.ts)
- `gates.ts:458-464` `export const AUTOMATION_ACTORS: ReadonlySet<string> = new Set(['scheduler','orchestrator-background','auto-dev','error-capture','agent'])`. Referenced ONLY by tests; the decision below does not consult it.
- `gates.ts:470-473` `export function humanOnlyRejectsActor(actor: string, runnerType: string): boolean { if (runnerType !== 'pty-interactive') return false; return actor !== 'human' // any non-human actor (incl. all AUTOMATION_ACTORS) is rejected }` -- default-deny, so 'external-ask'/'external-work' are rejected without being listed.
- `gates.ts:487-500` `export function humanOnlyPtyGate(resolveActorAndRunnerType: (req: DispatchRequest) => Promise<{ actor: string; runnerType: string }>): DispatchGate`; `name: 'human_only_pty'`; blocks with `reason: automation_blocked_on_pty:${actor}`.
- `DispatchRequest` has NO actor/source field (`hub/src/dispatch/pipeline.ts:36-48`: userId, sessionId, token, prompt, images?, attachments?, humanInteractive?). The actor reaches the gate only through the resolver closure the caller builds.
- `pipeline.ts:44-47` `/** Set ONLY by the PTY preflight for a server-inferred human keystroke turn. ... Never populated from client input. */ humanInteractive?: true`.

### 1.2 Every caller
| Caller | file:line | actor passed | runnerType source |
|---|---|---|---|
| ext ask dispatch | hub/src/ask/dispatch.ts:135-141 (list L131-143) | `EXT_ACTOR` ('external-ask'), L140 | `SELECT runner_type FROM sessions WHERE id = ${req.sessionId}` L136-138 |
| ext work dispatch | hub/src/work/dispatch.ts:297-303 (list L293-306) | `EXT_WORK_ACTOR` ('external-work'), L302 | same SQL L298-300 |
| telegram inbound dispatch | hub/src/telegram/dispatch.ts:168-171 (`guard`, list L176) | `source = input.source ?? "human"` L161 | `getSessionRunnerType(input.sessionId, input.userId)` L170 |
| term.input relay | hub/src/ws/client.ts:215-223 uses `humanOnlyRejectsActor('human', runnerType)` (L217) | literal `'human'` -- tautology, can never reject ("Unreachable for a human actor by construction", L219) | `getSessionRunnerType` L216 |

NOT carrying `humanOnlyPtyGate` (no actor/runner check at all): orchestrator/inject.ts (L262, L390), scheduler/senders/agent.ts:367, scheduler/senders/triage.ts:142, error-capture/dispatcher.ts:167, feedback/dispatcher.ts:130, revanote/dispatcher.ts:317, cloud/send.ts:31, dispatch/pty-preflight.ts:34.

### 1.3 Tests of humanOnlyPtyGate / humanOnlyRejectsActor (all PASS locally, section 9)
- hub/test/human-only-guard.test.ts (8 tests): every AUTOMATION_ACTORS member rejected on 'pty-interactive' (L29-33); 'human' allowed (L35-37); L39-44 "a client-asserted 'human' string from an agent connection still fails -- actor is server-inferred"; stream-json unaffected (L46-51); gate name `human_only_pty` (L72-76).
- hub/test/term-relay-human-guard.test.ts (3 tests): L101-108 genuine human-connection term.input forwarded; **L110-118 spoof negative test**: `handleAgentMessage(agentSocket, {type:'term.input', ..., source:'human', ...})` => `expect(fwdAgent.length).toBe(0)`; L120-126 agent CAN emit term.data. Mocks pty-preflight to always pass (L37-41).
- hub/test/telegram-human-only-guard.test.ts (4): `automation_blocked` + reason contains `automation_blocked_on_pty` (L79-80).
- hub/test/automation-routing-guard.test.ts (15): data-driven over UNATTENDED_SOURCES (L24) + static check that supervisor runner sources scrub ANTHROPIC_API_KEY (L55-79).
- hub/test/ext-ask-gates.test.ts (11): gate-name list includes 'humanOnlyPtyGate' (L29), `humanOnlyRejectsActor(EXT_ACTOR,'pty-interactive')===true` (L60).
- hub/test/ext-work-containment.test.ts:240-245 asserts dispatchWork composes cost+token+humanOnlyPty+rate+allowlist.
- hub/test/programmatic-hard-halt.test.ts:108-109 (`humanOnlyRejectsActor` human false / scheduler true).
- hub/test/pty-preflight.test.ts:164 comment only.

### 1.4 How `actor` is determined server-side today
| Principal | Evidence | Resulting actor |
|---|---|---|
| /ws/client with opaque session cookie | client.ts:372-382 (`data.authMethod = 'session_cookie'`) | relay hard-codes `'human'` (client.ts:217, 286) |
| /ws/client with legacy JWT (`config.allowLegacyLogin`) | client.ts:384-397 (`data.authMethod = 'legacy_jwt'`) | ALSO 'human' -- authMethod is never consulted by the relay |
| /ws/client with api_key | not accepted: auth branch only handles cookie or `verifyJwt` | n/a |
| /ws/agent api_key (`agent` scope) | ws/agent.ts:308 `verifyApiKeyWithScope(keyHash,'agent')`; L235-236 `if (!isAgentToHubTermType(frame.type)) return` | cannot emit term.input at all (term-protocol.ts:96-98 AGENT_TO_HUB = {'term.data'}) |
| /api/ext api_key | auth/ext-api-key-middleware.ts:79 `c.set('actor', c.req.path.includes('/work') ? EXT_WORK_ACTOR : EXT_ACTOR)` (EXT_ACTOR L25, EXT_WORK_ACTOR L32) | route-inferred 'external-ask'/'external-work' (substring path match) |
| Telegram webhook | api/telegram-webhook.ts:390-397 calls `dispatchToSession({userId,sessionId,chatId,updateId,text,images})` with NO `source` | defaults to 'human' (dispatch.ts:161) |
| orchestrator / scheduler / error-capture / feedback / revanote / triage / cloud | no actor evaluated anywhere in their paths | none |
| REST (cookie vs bearer) | auth/middleware.ts:16-36 sets authMethod 'session_cookie' | 'legacy_jwt' | not used for any PTY decision |

### 1.5 Every place a client-supplied `source` / actor-like field is read (hub/src/ws, api, dispatch, orchestrator)
- hub/src/dispatch/*: NONE (DispatchRequest has no such field; no `.source`/`.actor` reads).
- hub/src/orchestrator/*: NONE.
- hub/src/ws/client.ts: `actor: 'human'` literal (L286); `source: 'web'` (L572) is a server-set audit tag in a log record, not read from the frame. `ClientInbound` (ws/protocol.ts) has no source/actor key. `TermFrame` schemas (ws/term-protocol.ts:24-79) are plain `z.object` (no `.strict()/.passthrough()`), so unknown keys like `source` are dropped by `safeParse` and the forwarded frame is `JSON.stringify(tf.data)` (client.ts:232). (Not executed; inferred from zod default strip semantics.)
- hub/src/ws/agent.ts:1315 `budgetSource: msg.source` -- agent-supplied (api_key authed) budget-origin enum in `host_resources`; not an actor.
- hub/src/ws/supervisor-protocol.ts:80 `source: z.string().max(120)` (commands_sync metadata) and :98 `source: z.enum(['cgroup_v2','cgroup_v1','host_fallback'])`; not actors.
- hub/src/api/ext.ts:364-369 `WorkBody.source = z.object({kind:z.literal('email'), from, subject?, message_id?})` -- client-supplied email provenance; used for a TRUST decision (`isKnownSender(site, body.source.from)` ext.ts:441 -- sender allowlist) but never for actor.
- hub/src/revanote/payload-schema.ts:34 `source: z.literal('revanote').optional().nullable()` -- payload tag, not an actor.
- hub/src/telegram/dispatch.ts:67,79,161 `TelegramDispatchSource` / `DispatchInput.source` -- in-process param; the only production call site (telegram-webhook.ts:390) omits it. A future caller that passes it would feed `humanOnlyPtyGate` directly.
- No header-based actor (`x-actor`/`x-source`) anywhere in hub/src (grep empty).

### 1.6 Every path by which a programmatic (non-human) caller can cause prompts/bytes to reach a PTY or PTY-backed session
KEY STRUCTURAL FACT: on a supervisor with `REMO_PTY_INTERACTIVE=1`, hub `user_message` frames go to the STREAM-JSON runner, not the PTY; the PTY takes only `term.*` frames.
- supervisor/src/runners/session-bridge.ts:31-33 `ptyInteractiveEnabled(){ return process.env.REMO_PTY_INTERACTIVE === '1' }`; :382-383 `if (ptyInteractiveEnabled()) this.ensurePtyRunner() else this.ensureRunner()`.
- :398-402 `term.input` => `pty?.write(Buffer.from(String(anyMsg.bytes ?? ''), 'base64').toString('binary'))`.
- :411-441 `term.attach_file` => writes file under repoPath then `pty?.write(abs + ' ')`.
- :444-465 `user_message` => `const runner = this.ensureRunner()` (ClaudeRunner, stream-json) `runner.sendMessage(prompt, msg.images)`.
- :518 `resolveHumanBackend({ isHuman: true }, ...)` hard-coded; supervisor/src/runners/backend-selector.ts:120 `if (ctx?.isHuman !== true) throw`. The supervisor never learns the hub-side actor; term.* frames carry only {type, session_id, bytes|filename,data_b64}.

| # | Path (producer) | Frame sent | Gated by pty-preflight? | Gated by humanOnlyPtyGate? | Other gating |
|---|---|---|---|---|---|
| P1 | Web xterm `term.input` -> ws/client.ts relay (L174-358) | term.input | YES, on submit only (L262-295, `actor:'human'` L286; `classifyPtyInput`) | tautology only (L217) | ownership (subscribed + canWriteTerminal L200-204), license (L206), single-writer + turn lock (L253-261, L296-326), per-writer chain bound 256 (L336-343) |
| P2 | Web `term.attach_file` (same relay) | term.attach_file | NO by design (hub/test/ws-client-pty-preflight.test.ts:135 "term.attach_file is never checked (it types a path, it does not submit)") | tautology only | same relay gates; `isWriteTurn` includes it (client.ts:183) |
| P3 | Telegram permission/question callback => `injectPtyKeystroke` (telegram/transcript/pty-inject.ts:34-48; call telegram-webhook.ts:556) | term.input (bytes from keystroke-map.ts, e.g. `ENTER='\r'` L27) | NO | NO | `takePendingPrompt(requestId, user.id)` (webhook L525) + linked Telegram user; documented exempt in docs/usage-cost.md:455-461; flagged MINOR-3 in .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md |
| P4 | `dispatch()` adapters -- all send `user_message`: orchestrator inject.ts:179-187; scheduler agent.ts:398; triage.ts:156; error-capture dispatcher.ts:188; feedback dispatcher.ts:147; revanote dispatcher.ts:360; ext ask ask/dispatch.ts:178; ext work work/dispatch.ts:340; telegram dispatch.ts:150 | user_message (=> stream-json runner, NOT PTY bytes) | NO (preflight only runs in client.ts) | only ask/work/telegram | their own gate lists (section 3) |
| P5 | Web `send_message` (ws/client.ts:777-786) | user_message | NO | NO | ONLY `checkUserThreshold` (L624-640); no cost/token cap (documented pre-existing gap, docs/usage-cost.md:448-454) |
| P6 | permission_response / question_response (client.ts:558-600, telegram-webhook.ts:590,649) | permission_response/question_response (=> stream-json runner `respondToPermission`) | NO | NO | MUTATING_WS_TYPES license gate (client.ts:462-463) |
| P7 | /ws/agent -> hub term.* | term.data only | n/a | n/a | direction allowlist agent.ts:235-236 |
| P8 | Spawn-without-prompt: orchestrator/orphan-resume.ts:226 (`session.start`), launchSessionForUser (telegram/launch.ts), scheduler senders/supervisor.ts:65, teab.ts | session.start / run_command | n/a (no prompt) | n/a | reserveSessionSlot concurrency, restart cap 10, 24h age cap (orphan-resume header) |
=> Today NO automation producer emits `term.input`/`term.attach_file`. `docs`/Phase 2 SUMMARY agree: ".planning/phases/PTYCAP-02-pty-preflight-gate/02-01-SUMMARY.md:67-73" "no automation write to a PTY was possible at all, by construction". The ONLY raw hub->agent term.input writers are P1 (cookie human) and P3 (Telegram answer keystrokes).

### 1.7 The runner_type column cannot be the door (must be known by Phase 3)
- `hub/src/ws/client.ts:268-270` "runner_type defaults to 'stream-json' and nothing in the web client sets it, while the supervisor writes every term.input to the PTY on its own env flag -- keying on it left the gate dead in prod."
- hub/src/db/schema.sql:646 `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json'`; hub/src/db/dal.ts:100-110 `getSessionRunnerType` defaults to 'stream-json'.
- hub/src/api/ext.ts:257-259 "a default prod install is PTY-interactive; the precondition is a stream-json session"; ask/dispatch.ts:65 `AND runner_type = 'stream-json'` (ask target filter).
- 02-VERIFICATION.md MINOR-2: "Phase 3 must not rely on the runner_type gate as the door."
- ROADMAP invariant L19-20: "The actor is server-inferred, never client-asserted (cookie => human, api_key => agent). A spoofed `source` field must never be able to impersonate a human turn."

---------------------------------------------------------------------------------------------------
## 2. hub/src/dispatch/pty-preflight.ts
---------------------------------------------------------------------------------------------------
- Exports: `ptyPreflightDispatchConfig` (L33-35, `gates: [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]`); `PTY_AUTOMATION_TURN_GATES` (L38, same array object); `PTY_HUMAN_TURN_GATES` (L41-43 `PTY_AUTOMATION_TURN_GATES.filter((g) => g !== sessionInjectRateGate)`); types `PtyPreflightActor = 'human' | 'automation'` (L45), `PtyPreflightResult` (L47), `PtyInputClass` (L95-101); `_setPtyPreflightTimeoutForTests`/`_reset...` (L51-52); `classifyPtyInput(bytesB64, pendingTail='')` (L117); `isPtySubmit` (L166); `checkPtyTurnPreflight({userId,sessionId,actor})` (L191-214).
- Chains: automation = threshold -> daily token cap -> daily cost cap -> per-session inject-rate (L34). Human = same MINUS inject-rate (L41-43) and `runChain` sets `humanInteractive:true` (L177) which exempts the programmatic-credit halt in `dailyCostCapGate` (gates.ts:140) -- never the cost/token caps.
- Header L18-20: "No path admits automation to a PTY yet (`humanOnlyPtyGate`); Phase 3 will call this seam."
- `runChain` L170-184: builds `DispatchRequest{userId,sessionId,token:'pty-preflight:'+sessionId,prompt:''}` and runs gates in order; first block wins. FAIL CLOSED: thrown gate => `{ok:false,reason:'pty_preflight_error'}` (L203-207); 5s timeout => `pty_preflight_timeout` (L49, L198).
- Only production caller: hub/src/ws/client.ts:283-287 `checkPtyTurnPreflight({ userId, sessionId: frame.session_id, actor: 'human' })`, gated by `inputClass?.submit` from `classifyPtyInput(frame.bytes, ptyEscTail.get(sid) ?? '')` (L279-282). On refusal: `ws.send({type:'send_refused', channel:'term', session_id, reason})` (L288-294). `actor:'automation'` has NO production caller (tests only).
- What a Phase-3 caller invokes: `checkPtyTurnPreflight({userId, sessionId, actor:'automation'})` (L191-195). Note the automation chain's sessionInjectRateGate counts `routine_run_log` rows (section 4) -- an admitted automation turn is not counted unless something writes such a row.
- Tests covering it: hub/test/pty-preflight.test.ts (33 tests; chain shape L96-126, human L128-160, automation L162-193, halt L195-219, fail-closed L221-234, classifier L236-343); hub/test/ws-client-pty-preflight.test.ts (22 tests; what is checked L120-167, refusal L169-192, Enter encodings L194-247, ordering L249-388, backpressure L390+; mocks db/dal.ts, ws/registry.ts, pty-preflight.ts; DATABASE_URL fake L15); hub/test/term-relay-human-guard.test.ts (mocks it to pass); hub/test/token-cap-coverage.test.ts (scans its `gates:[...]` literal, known-dispatcher list includes 'dispatch/pty-preflight.ts'); hub/test/human-interactive-flag-guard.test.ts (pins who may mention `humanInteractive`, see below).
- hub/test/human-interactive-flag-guard.test.ts: ALLOWED = {dispatch/pipeline.ts (type), dispatch/gates.ts (reader), dispatch/pty-preflight.ts (writer)} (L13-17); second test pins the EXACT line `"    ...(human ? { humanInteractive: true as const } : {}),"` (L38). **FAILS LOCALLY on Windows checkout** (core.autocrlf=true => trailing `\r` after `split('\n')`): 1 pass / 1 fail; passes on Linux CI. Already recorded as MINOR-1 in 02-VERIFICATION.md (proposed fix: split on `/\r?\n/`). Any Phase-3 edit near that line or any new file mentioning `humanInteractive` must update this test. (No AAF ticket filed: documented, in-scope for the Phase 3 branch to fold in.)
- The pty-preflight.ts file contains literal U+2028/U+2029 characters inside `LINE_TERMINATOR_CODEPOINTS` (L93) -- a harness "invisible-unicode" scan flagged it; benign by design.

---------------------------------------------------------------------------------------------------
## 3. hub/src/dispatch/gates.ts -- exports, gate lists, coverage test
---------------------------------------------------------------------------------------------------
Common types (hub/src/dispatch/pipeline.ts): `interface DispatchGate { name: string; check(req: DispatchRequest): Promise<{ok:true} | {ok:false; reason:string}> }` (L51-54). `DispatchRequest` L36-48. `runGates` L210-222 (array order, first block wins), called at L225 `runGates(req, deps.gates)`; promotion re-runs the list (header IR-2).

| Export | gates.ts line | Signature / ctx | Reads |
|---|---|---|---|
| getCostCapStatus | 53 | (userId, tz) => {over,spent,cap} | `users.daily_cost_cap_usd` (SQL L57-59, NOT NULL DEFAULT 10) + `getTodayTokenCostUsd` |
| isOverCostCap | 67 | boolean wrapper | -- |
| getProgrammaticHaltStatus | 91 | (userId) => {halt,bound,used_usd} | `users.programmatic_halt_usd` (NULL=OFF) + in-memory `getUsage(userId)?.usage.programmatic_credit` |
| thresholdGate | 107 | DispatchGate 'threshold' | `checkUserThreshold(req.userId)` (usage/threshold.ts); reason `quota_threshold_reached:...` |
| dailyCostCapGate | 122 | DispatchGate 'daily_cost_cap' | `users.timezone` + cost cap; reason `over_daily_cost_cap:$x>=$y`; then programmatic halt unless `req.humanInteractive` (L140); reason `programmatic_credit_halt:...` |
| assertTokenCapConfig | 204 | () => void (throws) | env `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP(_DISABLED)`; called from hub/src/index.ts:569-574 (exit 1) |
| getTokenCapStatus | 230 | (userId, tz) => {over,tokens,cap} | env cap (call-time) + `getTodayTokenTotal` (4 buckets) |
| isOverTokenCap | 241 | boolean wrapper | -- |
| dailyTokenCapGate | 257 | DispatchGate 'daily_token_cap' | tz SQL + token status; reason `over_daily_token_cap:${tokens}>=${cap}` |
| maxInjectsPerHour | 284 | () => number | env `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR`, default 4 (L282) |
| sessionInjectRateGate | 301 | DispatchGate 'session_inject_rate' | `countSessionInjectsSince(req.sessionId, 60)`; reason `over_session_inject_rate:${n}>=${cap}`; cap<=0/non-finite => disabled (fail-open) L305 |
| maxAsksPerHour / askRateGate | 326 / 338 | (apiKeyId|null) => gate 'ask_rate' | env `REMO_ASK_MAX_PER_HOUR` (10); dynamic import `db/ask-dal.countAsksForKeySince`; reason `over_ask_rate:` |
| maxWorkPerHour / workRateGate | 365 / 373 | (userId) => gate 'work_rate' | env `REMO_WORK_MAX_PER_HOUR` (4); `db/work-dal.countWorkRunsForUserSince`; `over_work_rate:` |
| workRepoAllowlistGate | 396 | (userId, repoIdent) => gate 'work_repo_allowlist' | `isRepoWorkAllowed`; FAILS CLOSED on DB error (`work_allowlist_check_failed:`) |
| autospawnDailyLaunchCap / isOverAutospawnDailyLaunchCap | 421 / 433 | pure predicate | env `REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES` (20) |
| AUTOMATION_ACTORS / humanOnlyRejectsActor / humanOnlyPtyGate | 458 / 470 / 487 | see 1.1 | -- |
| concurrencyGate | 510 | (supervisorId) => gate 'concurrency' | `reserveSessionSlot` (side effect: opens reservation) |
Gate factories bound to an identity are an existing pattern: `askRateGate(apiKeyId)`, `workRateGate(userId)`, `workRepoAllowlistGate(userId, repoIdent)`, `concurrencyGate(supervisorId)`, `revanoteBudgetGate(userId, tz)` (revanote/dispatcher.ts:113).

### 3.1 Every `gates: [...]` list in hub/src (token-cap-coverage scan target)
| file:line | list |
|---|---|
| hub/src/orchestrator/inject.ts:262 and :390 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` |
| hub/src/scheduler/senders/agent.ts:367 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate]` (NO inject-rate) |
| hub/src/scheduler/senders/triage.ts:142 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate]` (NO inject-rate) |
| hub/src/error-capture/dispatcher.ts:167 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` |
| hub/src/feedback/dispatcher.ts:130 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` |
| hub/src/revanote/dispatcher.ts:317 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, revanoteBudgetGate(userId, tz)]` |
| hub/src/telegram/dispatch.ts:176 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, guard]` (guard = humanOnlyPtyGate) |
| hub/src/ask/dispatch.ts:131-143 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, humanOnlyPtyGate(...), askRateGate(apiKeyId)]` |
| hub/src/work/dispatch.ts:293-306 | `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, humanOnlyPtyGate(...), workRateGate(userId), workRepoAllowlistGate(userId, repoIdent)]` |
| hub/src/cloud/send.ts:31 | `[dailyCostCapGate, dailyTokenCapGate]` (no threshold) |
| hub/src/dispatch/pty-preflight.ts:34 | `[thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]` |
Orchestrator inject comment (inject.ts:259-262): "Order: threshold -> cost-cap -> token-cap -> rate." pty-preflight order differs on purpose (token before cost, ROADMAP SC-1).

### 3.2 hub/test/token-cap-coverage.test.ts (102 lines) -- structure
- `walk(hub/src)` all `.ts` (L24-32); `gateLists()` (L44-70): for each `/gates:\s*\[/g` match, BRACKET-BALANCED scan (counts `[ ( {` / `] ) }`); unbalanced => pushed to `unparsed`.
- Test 1 (L73-75): `unparsed` must equal [] (an unparseable list hard-fails).
- Test 2 (L77-94): the set of files with a gates list must contain the known dispatchers: 'orchestrator/inject.ts','scheduler/senders/agent.ts','scheduler/senders/triage.ts','error-capture/dispatcher.ts','feedback/dispatcher.ts','revanote/dispatcher.ts','telegram/dispatch.ts','dispatch/pty-preflight.ts' (ask/dispatch.ts, work/dispatch.ts, cloud/send.ts are scanned generically but NOT in the known list).
- Test 3 (L96-101): EVERY list's source text must `includes('dailyTokenCapGate')` AND `includes('dailyCostCapGate')` (plain substring, so a comment inside the brackets would satisfy it).
- Registering a new dispatcher/gate: a literal `gates: [` containing both identifiers; new chain entries inside pty-preflight.ts:34 keep both caps; a gate list built in a variable and passed as `gates,` (no `gates: [` literal) is INVISIBLE to the scan; optionally add the file to the known list at L79-91.
- Related cap tests: token-cap-gate-fires.test.ts (8), orchestrator-token-cap.test.ts (9), orchestrator-inject-rate-gate.test.ts (8), orchestrator-cap-alert.test.ts (7), cost-cap-real-tokens.test.ts, token-cap-counts-cache.test.ts, ext-ask-gates.test.ts, ext-work-gates.test.ts, orchestrator-autospawn-gate.test.ts.

---------------------------------------------------------------------------------------------------
## 4. Counters / state
---------------------------------------------------------------------------------------------------
### 4.1 sessionInjectRateGate data source
- hub/src/db/orchestrator-rows-dal.ts:539-544 `INJECT_OUTCOMES = ['dispatched','queued','autospawn_launched','autospawn_parked']`; :546-559 `countSessionInjectsSince(sessionId, windowMinutes=60)`: `SELECT COUNT(*)::text FROM routine_run_log WHERE session_id = ${sessionId} AND outcome = ANY(...) AND created_at >= now() - make_interval(mins => ${minutes})`.
- `routine_run_log` (schema.sql:380-392): id, session_id (FK sessions ON DELETE CASCADE), repo_key, command, decision_rationale, outcome, gap_dimension, pr_url, reviewer_verdict, deploy_verify_result, created_at; index (session_id, created_at DESC) L393-394. NO task_id column. No pruning code found (grep DELETE FROM routine_run_log empty).
- WRITERS are orchestrator-only: orchestrator/macro-cycle.ts:267-273 (`command: macro:<type>`, `outcome: outcome.kind`, written AFTER inject returns), controller.ts:358, wave-runner.ts:246, merge-command.ts:124-236, verify-tail.ts:279-356, stale-lock-reaper.ts:125, inject.ts:367 (outcome 'launched', not counted). Consequence: for error-capture/feedback/revanote/pty-preflight, `sessionInjectRateGate` only ever sees ORCHESTRATOR rows for that session.

### 4.2 Existing per-task / per-session flags and counters (schema.sql)
- scheduled_tasks (L156-169): `id TEXT PK`, user_id, `session_id TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE`, `enabled BOOLEAN NOT NULL DEFAULT true` (L163), last_run_at, next_run_at; later ALTERs: task_type (L180; wide CHECK L207), target_kind/target_id (L230-232), payload, timezone, catchup_policy, max_concurrent (L238), last_fire_at/next_fire_at (L239-240), post_run_actions, email_summary (L272), lifecycle_stage (L299), macro_task_type (L312, 'dev'|'maintenance'|'security'|'brainstorming'), schedule_kind/run_at (L338-343). No lifetime/run-count column exists (grep run_count/fire_count/max_runs: only a comment at L348 "'Once' => max_runs=1 (enforced by the controller, not here)").
- orchestrator_rows (L351-362): task_id FK scheduled_tasks, command, `enabled`, schedule_rule JSONB, frequency_label, `last_fired_at` (L373 cadence stamp).
- scheduled_task_runs (L446-468): id, `task_id` FK scheduled_tasks ON DELETE CASCADE, user_id, session_id, status CHECK(running|success|failed|skipped|pending|in_flight|cancelled), started_at, ...; index (task_id, started_at DESC) L456. COUNT(*) per task_id is derivable for scheduler runs, but ORCHESTRATOR injects do not create these rows (inject.ts:244-247 "this store does NOT insert a scheduled_task_runs row").
- routine_queue (L400-419): session_id, status; unique running per session.
- users: `orchestrator_enabled` (L1027, DEFAULT flipped true L1037), `orchestrator_disabled_explicitly` (L1038), `daily_cost_cap_usd` (L489), `programmatic_halt_usd` (L497), `web_push_enabled` (L490), `auto_nudge_idle_sessions`/`notifications JSONB` (L1233-1234), `notify_channels JSONB` (L1401), `coolify_auto_triage_enabled` (L924), `timezone` (L518).
- sessions: status CHECK online|offline|thinking (L20), runner_type (L646), is_orchestrator (L1047), auto_nudge (L1381), dangerously_skip_permissions (L1392), superseded_by (L986), deleted_at (L70). NO paused/kill/disabled column on sessions.
- paused_repos (L505-513): (user_id, supervisor_id, repo_path) PK + paused_at + paused_reason; "supervisor MUST NOT auto-spawn or restart-on-crash an agent for any repo in this table" (L499-504); DAL supervisor-dal.ts:536-563 (`isRepoPaused`). Consulted by supervisor spawn logic, not by dispatch gates.
- error_projects: `daily_dispatch_cap INTEGER DEFAULT 50` (L674), `enabled` (L675). orchestrator_autospawn_allowlist (L616-621, default EMPTY).
- token_usage (L1331-1343; runner_type L1351), token_usage_daily (L1358-1368) -- no task_id; session_id nullable ON DELETE SET NULL.

### 4.3 What "task" means and how injects are attributed today
- Orchestrator "task" = ONE `scheduled_tasks` row with `task_type='orchestrator'` per session (controller.ts:687 `WHERE task_type = 'orchestrator' AND enabled = true AND session_id IS NOT NULL`; orchestrator-rows-dal.ts:159). `MacroCycleInput.taskId` exists (macro-cycle.ts:43), but `InjectInput` (inject.ts:81-90: userId, sessionId, token, prompt, autospawn?) and `DispatchRequest` carry NO taskId; token = `orch:<sessionId>:<command>:<ts>`.
- Scheduler task = `scheduled_tasks.id`; its dispatches create `scheduled_task_runs` rows (id = runId used as dispatch token, agent.ts:332 `open(){ return ctx.runId }`).
- Attribution today: orchestrator injects => (session_id, command) in routine_run_log; scheduler => scheduled_task_runs.task_id; other dispatchers => no durable record at all.
- FK cascade hazard for a lifetime counter: routine_run_log.session_id, scheduled_tasks.session_id and scheduled_task_runs.task_id are all ON DELETE CASCADE -- deleting/recreating a session or task resets any count derived from them; `sessions.superseded_by` (L986) shows session ids get replaced.
- Orchestrator tick respects `scheduled_tasks.enabled` (controller.ts:687) and scheduler `fire()` guards `if (!task || !task.enabled) return` (scheduler/dispatcher.ts:99); runNow guard L173 `if (!task.enabled && !opts.isManual)` (test: hub/test/dispatcher-disabled-guard.test.ts).

---------------------------------------------------------------------------------------------------
## 5. Owner notification today
---------------------------------------------------------------------------------------------------
- E4A sender: hub/src/lib/email.ts:13-38 `sendEmail({to,subject,html,text}): Promise<boolean>`; env E4A_API_KEY / E4A_BASE_URL (default https://api.emails4agents.com) / E4A_INBOX_ID; POST `/v1/messages/send` with `from_inbox_id: inboxId` (L25); returns false (never throws) when env missing (L17-20) or non-2xx; 10s timeout. Two more copies of the same call: scheduler/post-run/email.ts:44, error-capture/notify.ts:239 (`JSON.stringify({ from_inbox_id: inboxId, to, subject, text })`).
- Scheduled-task summary email: scheduler/post-run/dispatcher.ts:46-96 default-on `notify_email` action (`email_summary` column, scheduled-tasks-dal.ts:92; opt-out `email_summary === false` L87); sent via post-run/email.ts. Recent change: d2f3033 "stop emailing owner on every __internal_triage success (#496)".
- Orchestrator fan-out: hub/src/orchestrator/notify.ts -- `NotifyChannel = 'telegram'|'inapp'|'email'|'push'` (L36); `applyChannelPrefs` honours `users.notify_channels` (L49-55; only explicit false mutes); `fanOutNotify(input, deps?)` L160-238 never throws; email branch L217-230 (`to: user.email`, subject `[remo-code orchestrator] <event>`); `NotifyDeps` injectable (L133-138). Owner address = `users.email` via `getUserById`.
- Existing percent-of-cap alarm: hub/src/observability/cap-alert.ts -- `evaluateCapAlert` (L61-112): threshold default **80** via `REMO_ORCHESTRATOR_CAP_ALERT_PCT` (L28-33); fires `fan({event:'info', level:'warning', channels:['inapp','telegram']})` (L100-107) -- NO email; dedupe = in-memory `alertedToday` Set keyed `${userId}:token|cost:${utcDate}` (L16, L76, L89; resets on restart); evaluated ONLY inside orchestrator macro cycle (macro-cycle.ts:255-263, `tz` hard-coded 'UTC' L252/257) so it never runs for human PTY use or other dispatchers. Tests: hub/test/orchestrator-cap-alert.test.ts (7), uses literal 50_000_000 params.
- Cooldown/dedupe precedents: (a) orchestrator/stale-lock-reaper.ts:33-36 `REAP_NOTIFY_COOLDOWN_MS` from `REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS` (default 3_600_000 per CLAUDE.md), in-memory `lastNotifyAt` Map (L41), check L137, channels `['telegram','inapp','email','push']` (L146); (b) DB-backed: table `notifications_sent(id, kind CHECK IN ('dedupe_hit','rate_limit','daily_cap','dispatch_failed','session_offline','stack_not_detected','propose_roadmap'), dedupe_key, sent_at)` schema.sql:731-742 (CHECK is dropped/re-added every boot L740-742, so a new kind needs that list extended) + helper pattern error-capture/notify.ts:46-93 (select-within-TTL, record-BEFORE-send, then email) and orchestrator/propose.ts:104-127, scheduler/post-run/propose-notify.ts:70-91. `kind 'daily_cap'` already exists in the CHECK (used by error-capture projects, not the token ceiling).
- Other email call sites: revanote/notify-pr.ts:82, revanote/quiet-watch.ts:194 (`['telegram','inapp','email']`, disabled by `REMO_REVANOTE_QUIET_ALERT_DISABLED`), api/auth.ts:200 (magic link).
- No code anywhere emails at 60% of the token ceiling.

---------------------------------------------------------------------------------------------------
## 6. Token cap defaults -- every definition / doc / assertion of 50M
---------------------------------------------------------------------------------------------------
Source of truth: hub/src/dispatch/gates.ts:163 `const DEFAULT_DAILY_TOKEN_CAP = 50_000_000`; parse L180-185 (unset/blank => default; invalid => `{ok:false, cap: default}`); `configuredDailyTokenCap` L194-197 (explicit-disable => 0, else parsed cap); `assertTokenCapConfig` L204-222 (explicit-disable => warn; invalid => throw; called hub/src/index.ts:569-574 => `process.exit(1)`); `getTokenCapStatus` L230-238 (cap<=0 only when explicitly disabled); comment block L151-162 ("Owner sets the real prod number via REMO_ORCHESTRATOR_DAILY_TOKEN_CAP"). `getTodayTokenTotal` = hub/src/db/token-usage-dal.ts:209-221 (SUM of input+output+cache_creation+cache_read since local-tz midnight; no runner_type filter; sibling `getTodayTokenTotalByRunner` L231).
Places that state or assert the 50M default (all must move together if the default changes):
- Code comments: hub/src/dispatch/gates.ts:156-163,190; hub/src/observability/orchestrator-metrics.ts:71 ("default 50M").
- Tests asserting it: hub/test/token-cap-gate-fires.test.ts:35 (`DEFAULT_CAP = 50_000_000`), :48 ("ships a 50M default ceiling"), :104; hub/test/orchestrator-token-cap.test.ts:56,63-66 (reason string `over_daily_token_cap:50000000>=50000000`),87; hub/test/orchestrator-inject-rate-gate.test.ts:54,60 (`over_daily_token_cap:2830214000>=50000000`); hub/test/e2e/orchestrator-tokencap.e2e.test.ts:5,40 (`const CAP = 50_000_000 // the shipped default, asserted below`),115,149. Tests using 50_000_000 only as an injected param (independent of the default): orchestrator-cap-alert.test.ts:54-158, orchestrator-metrics.test.ts:251-273, orchestrator-autospawn-inject.test.ts:41; e2e orchestrator-autospawn.e2e.test.ts:196,280 set their own env.
- Docs: CLAUDE.md:265-266 ("default 50_000_000 = 50M tokens/day; non-positive/non-finite => disabled/fail-open" -- STALE vs gates.ts), CLAUDE.md:424 ("default 50M tokens/day"), :433 ("falls back to the 50M default"), :435 (`..._DISABLED=1`); docs/auto-dev-orchestrator.md:212 (table row, also says fail-open -- STALE); docs/orchestrator-autospawn-runbook.md:67 ("token cap 50M tokens/day"), :71 (`# default 50_000_000`); .planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md:185 ("50M (Phase 4 lowers to ~20M)"); .planning/ROADMAP.md:115.
- NOT found in: .woodpecker/, tools/, Dockerfile, web/src, supervisor/src, mcp/ (grep empty). Prod value unknown from the repo (may be overridden in Coolify env; not checked -- out of scope/read-only).
- web: no UI shows the token cap (grep getTokenCapStatus/token_cap in hub/src/api + web/src: only metrics gauge `remo_orchestrator_daily_token_cap` and web/src/lib/termRefusal.ts:10 refusal text).

---------------------------------------------------------------------------------------------------
## 7. Kill-switch precedents (what exists)
---------------------------------------------------------------------------------------------------
### 7.1 Env knobs (restart/redeploy to flip; read at call time, no cache)
- Orchestrator: `REMO_ORCHESTRATOR_ENABLED` -- `isOrchestratorEnabled()` controller.ts:67-70 (default '0'; 1|true|yes|on); gates `registerCycleRunnerIfEnabled()` L761-775; other real call sites: orchestrator/inject.ts:315 (`if (!deps.isOrchestratorEnabled() || !deps.isAutospawnEnabled()) return { kind: 'no_session' }`, the BSA autospawn pre-launch chain) and scheduler/dispatcher.ts:626 (reason `orchestrator_disabled`); inject.ts:209, merge-command.ts:31, propose.ts:32 are comment references only; `REMO_ORCHESTRATOR_AUTOSPAWN` -- `isAutospawnEnabled()` L56-59.
- `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED` (gates.ts:173-177, boot warns).
- Sweep/reaper off-switches (no-op escape hatches): REMO_GHOST_REAPER_DISABLED (ws/ghost-reaper.ts:200-205), REMO_DEAD_SESSION_REAPER_DISABLED, REMO_RUN_REAPER_DISABLED (scheduler/run-reaper.ts:155-159), REMO_SESSION_RUN_REAPER_DISABLED, REMO_ASK_REAPER_DISABLED, REMO_WORK_REAPER_DISABLED, REMO_ONCE_SWEEP_DISABLED, REMO_REVANOTE_QUIET_ALERT_DISABLED; boot wiring in hub/src/index.ts:729-776.
- Typed config object: hub/src/config.ts (`parseBool` L13; `ptyInteractive = process.env.REMO_PTY_INTERACTIVE === "1"` L132; exported L236); GET /api/client-config reads it (api/client-config.ts:21-22). Test: hub/test/config-env.test.ts.
- Supervisor-side: `REMO_PTY_INTERACTIVE` (session-bridge.ts:31-33), per-host.
### 7.2 DB-backed runtime flags (no hub-wide settings/flags table exists)
- Per-task: `scheduled_tasks.enabled`; per-row `orchestrator_rows.enabled`; per-user `users.orchestrator_enabled` + sentinel `orchestrator_disabled_explicitly` (db/orchestrator-dal.ts:7-45; "the machine-triggered auto-launch checks this so it never re-enables a user who opted out"); `users.coolify_auto_triage_enabled`; `error_projects.enabled`; paused_repos (4.2). Nothing is hub-wide-in-DB, nothing blocks `dispatch()` generically, and no gate reads any of these.
- Orchestrator stop: `POST /api/orchestrator/stop` (api/orchestrator.ts:131-149) sends `session.stop` to the user's online supervisors; `PUT /api/orchestrator` sets enabled (+ disabled_explicitly).
### 7.3 Auth patterns for owner-facing routes
- Cookie auth catch-all: auth/middleware.ts:16-36 (cookie wins, else legacy bearer). CLAUDE.md: `/api/api-keys` is cookie-only.
- Step-up: `requireRecentAuth(maxAgeSeconds = 900)` auth/reauth.ts:37 (401 `re_auth_required`); mounted index.ts:412-440 (prompts, profile, supervisor roots, orchestrator PUT); admin: `requireAdmin()` auth/require-admin.ts:9 (checks `c.get('userRole') === 'admin'`) + recent-auth on mutating methods (index.ts:445-450) -- only existing admin route: POST /api/admin/users/:id/revoke-sessions (api/admin.ts). Note comment index.ts:428-436: orchestrator /start and /stop are deliberately NOT step-up (a long-lived cookie must be able to launch/stop).
- Mutation rate limit: `userMutationLimit` (index.ts:405-449).
- mount-order is test-pinned: hub/test/mount-order.test.ts boots the real app.
### 7.4 Web settings surface (exists only)
web/src/pages/settings/{ConnectionsTab,CredentialsTab,UsageTab,ProfileTab}.tsx. UsageTab calls /api/usage/summary, /api/account/claude-thresholds, /api/profile; ProfileTab /api/users/me/profile (+ /api/profile); orchestrator enable/start/stop UI lives in web/src/components/SupervisorPage.tsx:1212-1239 (PUT /api/orchestrator, POST /api/orchestrator/start|stop). No kill-switch UI. 09-SPEC.md:254 says the kill-switch UI is "Milestone GOV".
### 7.5 Hot-path read patterns
- Gates read per call with fresh SQL each time (`userTimezone`, cap rows; gates.ts:72-77, 57-59) -- no cache; pty-preflight adds that latency to every Enter (5s fail-closed timeout).
- Caches that exist: per-connection license TTL (ws/client.ts:116-139, `config.titanium.licenseCacheTtlSeconds`); `/api/usage/summary` per-user Map TTL 60s (api/usage.ts:30-31); in-memory usage snapshot (usage/store.ts); env flags (call-time, free). In-memory locks assume single replica (dispatch/spawn-on-error.ts:40-43).

---------------------------------------------------------------------------------------------------
## 8. What Phase 7/8/9 SPECs assume from Phases 3/4 (quotes) + contradictions
---------------------------------------------------------------------------------------------------
- 07-SPEC.md:7-8 "PTYCAP Phases 1-4 are green. Phase 4 (lifetime inject counter + kill switch) is a hard precondition: this phase ARMS failure-triggered unattended spawning."
- 07-SPEC.md:41 gate chain `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, <Phase-4 lifetime + kill switch>]` -- "non-bypassable". (Order differs from pty-preflight's token-before-cost.)
- 07-SPEC.md:121-124 reuse the BSA pre-launch AND-chain "orchestrator-enabled AND autospawn-enabled AND allowlisted AND supervisor-online AND not over token cap AND not over the per-day launch cap AND (Phase 4) kill switch not thrown AND lifetime counter not exhausted" => Phase 4 must expose these as PREDICATES callable from inject.ts `maybeAutospawnOffline` (not only as DispatchGates).
- 07-SPEC.md:185 "`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` | 50M (Phase 4 lowers to ~20M) | non-positive => token ceiling disabled (fail-open)".
- 07-SPEC.md:251-258 "Phases 1-4 own the caps; Phase 7 consumes them." / "A heal turn must never write to a `pty-interactive` session while `governedAutomationPtyGate` is OFF."
- 08-SPEC.md:4-6 "Build starts only after PTYCAP Phase 4 (lifetime inject counter + kill switch) is green ... the Phase-4 counter + kill switch are the preconditions."; 08-SPEC.md:135-141 QC run goes through the shared pipeline with the standard chain (found by token-cap-coverage) PLUS `REMO_TASK_QC_TOKEN_CAP` (500K).
- 09-SPEC.md:4-7 "Build starts only after PTYCAP Phase 4 (lifetime inject counter + kill switch) and Phase 8".
- 09-SPEC.md:32-33 "A QC run triggered by a cap-hit is still subject to the Phase-4 kill switch and the lifetime inject counter -- a thrown kill switch means zero QC spawns, no exception."
- 09-SPEC.md:48-49 "Phase 4 adds the lifetime inject counter + kill switch + a 60%-of-ceiling alarm email. Phase 9 is what happens at 100%."
- 09-SPEC.md:57-72 every blocking gate in gates.ts "(cost cap, token cap, inject-rate, lifetime counter, programmatic halt) emits exactly one `CapHitEvent`" with `cap: 'daily_token' | 'daily_cost' | 'session_inject_rate' | 'lifetime_inject' | 'programmatic_halt'`, `cause.task_id`, `origin` (server-inferred); emit "best-effort and non-blocking: an emit failure NEVER un-blocks the gate" (L82-83).
- 09-SPEC.md:119-121 tests: token cap already exceeded => zero QC runs; "with the Phase-4 kill switch thrown, a cap-hit produces zero QC runs."
- 09-SPEC.md:140-147 escalation email via "the existing E4A sender (send field `from_inbox_id`, NOT `inbox_id`)", throttled to one email per (user, cap) per hour.
- 09-SPEC.md:164-173 env table; "the spend caps fail OPEN when misconfigured (a broken cap must not brick the app); the spawn ceilings here fail CLOSED".
- 09-SPEC.md:254 "The receipts/kill-switch UI is Milestone GOV."
Contradictions / drift to flag:
1. ROADMAP Phase 3 SC-1 (L101) requires a non-human actor to carry "token cap + inject-rate ceiling + lifetime counter + kill switch", but the lifetime counter and kill switch are BUILT in Phase 4, which "Depends on: Phase 3" (L109). Phase 3 can only define the slots/interfaces (fail-closed until Phase 4 fills them); full SC-1 is satisfiable only after Phase 4.
2. 07-SPEC:185 and 09-SPEC:172 say spend caps/ceiling "fail open" when misconfigured; code is FAIL CLOSED (gates.ts:194-197, :204-222, index.ts:569-574). CLAUDE.md:265-266 and docs/auto-dev-orchestrator.md:212 repeat the stale fail-open text while CLAUDE.md:433-435 states fail-closed.
3. Name drift: ROADMAP/07-SPEC use `governedAutomationPtyGate`; .planning/architecture/SESSION-ASK-API-SPEC.md:232,295 and docs/session-ask.md:155 say `governedAutomationGate`.
4. ROADMAP.md:31 shows Phase 1 unchecked "[ ]" but STATE.md:93 says "Phase 1, pty-token-accounting, shipped complete via #395" and docs/usage-cost.md:241 has the Phase 1 section.
5. 09-SPEC needs gate-level event emission and a `task_id` attribution; Phase 4's ROADMAP criteria mention neither (DispatchRequest has no task id).
6. 07-SPEC:41 chain order vs pty-preflight order (token before cost) -- cosmetic but should be one source.

---------------------------------------------------------------------------------------------------
## 9. Test infrastructure and exact commands
---------------------------------------------------------------------------------------------------
- Runner: Bun 1.3.14 (verified `bun --version`). hub/bunfig.toml `[test] preload = ["./test/_setup.ts"]` (sets JWT_SECRET/SESSION_SECRET defaults L22-23, `afterAll(mock.restore())` per file). Bun `mock.module` is process-global, so CI/`check-baseline` run each hub test file in its own process (tools/regression-baseline.json `_comment`).
- DB in unit tests: NO real database. Gate/dispatch tests mock leaf modules: pty-preflight.test.ts:35-68 mocks usage/threshold.ts, usage/store.ts, db/postgres.ts (`sql: async () => [{cap,tz,bound}]`), db/token-usage-dal.ts, db/orchestrator-rows-dal.ts, then imports the real gates through `?t=${Date.now()}` cache-busting URLs; ws-client tests mock db/dal.ts, ws/registry.ts and pty-preflight.ts with a fake `DATABASE_URL` (ws-client-pty-preflight.test.ts:15,28-68); human-only guard tests need no DB.
- Real Postgres only in e2e: hub/test/e2e/*.e2e.test.ts via harness hub/test/e2e/orchestrator-harness.ts (gate `REMO_E2E_DB_URL` => `maybeDescribe`, else `describe.skip`; applies schema.sql UNMODIFIED; synthetic user + cascade-delete teardown). CI (.woodpecker/qc.yaml:14-35) provides postgres:16 and sets DATABASE_URL + REMO_E2E_DB_URL + REMO_E2E_ALLOW_NONLOCAL=1. ROADMAP Phase 6 SC-1 is where PTY gate + governed guard + kill switch real-Postgres e2e is scheduled.
- Baseline: tools/regression-baseline.json pass=2273 skip=259 fail=0 total=2532, tolerance pass_min 1850, skip_max 260, fail_max 0 (check-baseline.ts exits 1 on drift). New skipped tests count against skip_max (e2e adds skips locally).
- CI gate sequence (.woodpecker/qc.yaml:36-56): `bunx tsc --noEmit -p hub/tsconfig.json || echo informational`, `bun run schema-lint` (tools/schema-sql-lint.ts hard-fails any un-pragma'd INSERT/UPDATE/DELETE/DROP/TRUNCATE in schema.sql; verified OK, 5 pragma-allowed), `bun run check-baseline`, `bun test supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts`, `bun run migration-verify`, a named list of orchestrator tests, `bun run orchestrator:e2e`. The supervisor argv/no-API-key guard tests are NOT in qc.yaml (grep of .woodpecker/.github: only the two pty-usage tests) -- run them manually. docs-drift.yaml runs `bun run docs:sync` and fails on diff. No scripts/preflight.ps1 exists in this worktree.
- Supervisor guards (argv allowlist-of-one + no API key):
  - supervisor/test/no-api-key-no-streamjson-pty.test.ts (5): static source canary over claude-pty-runner.ts, codex-pty-runner.ts, pty-host.mjs, claude-pty-bridge.ts, tauri/src-tauri/src/pty_host.rs; `FORBIDDEN_FLAGS = ['--input-format','--output-format','--print','stream-json']` (L47) after comment-stripping (L49-55); API key tokens only adjacent to a delete (L72); runners must pin `sanitizeSpawnEnv`/`delete env.<KEY>` (L102).
  - supervisor/test/pty-spawn-interception.test.ts (3, PRIMARY behavioral): intercepts the host spawn; Rust-bridge spawn frame `args.length === 0` (L83) and none of `-p --print --input-format --output-format stream-json` (L85-86); Node fallback argv has 1 entry matching `pty-host.mjs$` (L67-68).
  - supervisor/test/no-apikey-fallback-guard.test.ts (7): `sanitizeSpawnEnv`, PROVIDER_KEY_DENYLIST, credential patterns, per-backend spawn env clean.
  - supervisor/test/default-backend-selector.test.ts (22): `isHuman:false => throws` (L94-100), flag threading (L196-310).
  - supervisor/test/no-legacy-agent-spawn.test.ts (1).
- Commands actually run (worktree root = C:\Users\artic\GitHub\remo-code-gsd):
  - hub, one file per process: `cd hub; bun test test/<name>.test.ts`. Results this session: human-only-guard 8/0, term-relay-human-guard 3/0, token-cap-coverage 3/0, pty-preflight 33/0, ws-client-pty-preflight 22/0, ext-ask-gates 11/0, telegram-human-only-guard 4/0, automation-routing-guard 15/0, orchestrator-token-cap 9/0, token-cap-gate-fires 8/0, orchestrator-inject-rate-gate 8/0, orchestrator-cap-alert 7/0 (pass/fail); **human-interactive-flag-guard 1 pass / 1 FAIL (Windows CRLF, see section 2)**.
  - supervisor, from repo root: `bun test supervisor/test/<name>.test.ts`. Results: no-api-key-no-streamjson-pty 5/0, no-apikey-fallback-guard 7/0, default-backend-selector 22/0, no-legacy-agent-spawn 1/0, pty-spawn-interception 3/0.
  - `bun run schema-lint` => "OK -- no un-pragma'd mutating statements (5 allowed)".
  - Full gates to run before a push: `bun run check-baseline`, `bun run schema-lint`, `bun run migration-verify`, `bun run docs:sync` (if routes/OpenAPI change), plus the supervisor guard files above.

---------------------------------------------------------------------------------------------------
## 10. Docs that must change with behavior
---------------------------------------------------------------------------------------------------
- docs/usage-cost.md: "## PTYCAP Phase 2" (L346-480): L373-377 ("No admission path exists yet ... `humanOnlyPtyGate` / `humanOnlyRejectsActor` reject every automation source ... Phase 3's `governedAutomationPtyGate` is what will open that door") -- MINOR-2 says the stated mechanism is wrong (runner_type dead); L435-468 "What this does NOT do" ("Phase 3 admission ... is NOT built here"); L470+ Tests list; L113-123 Phase 18 "Routing invariant (R-PTY-19)" mentions `humanOnlyRejectsActor`. Add new "PTYCAP Phase 3" and "Phase 4" sections here (this file is the PTYCAP home; CLAUDE.md has no PTYCAP text at all).
- CLAUDE.md (worktree): L265-266 (50M + stale "fail-open"), L272-275 (inject-rate knob), L280-288 (`REMO_PTY_INTERACTIVE`), L418-440 (Cost cap non-bypassable / token cap FAILS CLOSED / 50M at L424,L433), L461+ ("No provider API key on the human PTY path -- EVER"), Docs-map rows (Usage cost ledger ~L392, PTY terminal surface ~L393, Session-Ask API L395) -- add new env flags/knobs + new default.
- docs/auto-dev-orchestrator.md:212 (cap row), :205 (autospawn refusals); docs/orchestrator-autospawn-runbook.md:67,71; docs/scheduled-tasks.md:402 (gate list text mentions `humanOnlyPtyGate`); docs/telegram-bridge.md:114 (human-only PTY guard paragraph); docs/session-ask.md:27,32,155; docs/remo-work.md:41,120,248.
- OpenAPI: any new REST route (kill-switch) must be added to hub/src/api/_openapi.ts and `bun run docs:sync` regenerates docs/openapi.json + docs/api.md; .woodpecker/docs-drift.yaml fails the PR on drift (paths hub/src/**, docs/openapi.json, docs/api.md). New refusal reason strings also appear in openapi descriptions (api/_openapi.ts:847,1057 list `over_daily_cost_cap, over_daily_token_cap, over_ask_rate, automation_blocked_on_pty:...`).
- Web: web/src/lib/termRefusal.ts maps `send_refused` reasons (over_daily_cost_cap, over_daily_token_cap, quota_threshold_reached, pty_preflight_timeout|error, term_backpressure, not_current_writer); fallback text `Prompt not sent (${reason})`.
- .planning: ROADMAP.md checkboxes (L31-34) and STATE.md; mount-order/ docs-supersession tests read docs/usage-cost.md and .planning (hub/test/docs-supersession.test.ts) -- keep the R-PTY-24 supersession text intact when editing usage-cost.md.

---------------------------------------------------------------------------------------------------
## DESIGN SEAMS (where a change would naturally attach; not decisions)
---------------------------------------------------------------------------------------------------
1. Chokepoint reality: the only hub->PTY byte writers are ws/client.ts relay (human) and telegram/transcript/pty-inject.ts. `governedAutomationPtyGate` has no producer to govern until a new automation `term.input` sender exists; all current dispatch adapters send `user_message` (stream-json). Phase 3's natural attach points: (a) swap the three `humanOnlyPtyGate(...)` call sites (ask/dispatch.ts:135, work/dispatch.ts:297, telegram/dispatch.ts:168) and keep `humanOnlyRejectsActor` semantics when the flag is OFF; (b) a new automation PTY inject adapter that calls `checkPtyTurnPreflight({actor:'automation'})` (pty-preflight.ts:191) before sending term.input; (c) client.ts:215-223 tautology can stay as the human relay chokepoint.
2. Do NOT key admission on `sessions.runner_type` (dead in prod, client.ts:268-270); key on frame type/producer.
3. Actor must stay closure-supplied from server context (cookie/api_key/route); `DispatchRequest` deliberately has no actor field. Existing negative tests to mirror: term-relay-human-guard.test.ts:110-118, human-only-guard.test.ts:39-44; add one for any new entry point; extend `human-interactive-flag-guard.test.ts` ALLOWED list if a new file mentions `humanInteractive` (and fix its CRLF split).
4. Flag default OFF as true no-op: follow call-time `process.env` reads (controller.ts:56-70) or `config.ts` parseBool (config.ts:13,132); OFF must leave gates.ts behavior byte-identical (existing tests assert it).
5. New gates register by appearing in a literal `gates: [` that still contains both caps (token-cap-coverage L96-101); if added to pty-preflight.ts:34 the human chain must keep excluding them (filter at L41-43; tests pty-preflight.test.ts:106,123 pin "human = automation minus inject-rate").
6. Lifetime counter needs a durable, non-cascading store and an identity: `DispatchRequest`/`InjectInput` carry no task id; `routine_run_log` is session-keyed, orchestrator-only, FK-cascade; `scheduled_task_runs` is task-keyed but not written by orchestrator injects. Gate-factory-by-identity precedent: askRateGate/workRateGate. Additive DDL only (schema-lint forbids seeding INSERT/UPDATE in schema.sql; backfills go to hub/scripts/).
7. Admitted automation turns must be RECORDED for sessionInjectRateGate/lifetime gates to work (sessionInjectRateGate reads only routine_run_log rows written after orchestrator injects).
8. Kill switch: no hub-wide DB flag exists. Precedents: env flags (restart), `scheduled_tasks.enabled`/`users.orchestrator_enabled` (per task/user), orchestrator `/stop`. Owner-facing routes follow cookie auth + `requireRecentAuth` (index.ts:412-450); per-session granularity has no column on `sessions`. A cheap hot-path read would follow the TTL-cache precedents (client.ts:116-139, usage.ts:30-31) with the single-replica assumption (spawn-on-error.ts:40-43). 07-SPEC wants it callable as a predicate from inject.ts (not only a DispatchGate); 09-SPEC wants it honored by QC spawns.
9. 60% alarm: existing cap-alert.ts is orchestrator-cycle-only, 80% default, inapp+telegram, in-memory dedupe. Event-driven attach point for "any dispatch/any PTY usage" is `recordTokenUsage` (db/token-usage-dal.ts:35, every usage_event) or `dailyTokenCapGate.check` (every dispatch + every PTY submit). Email via `fanOutNotify` channels incl. 'email' (notify.ts:217-230) honoring `users.notify_channels`, or `lib/email.ts sendEmail`; durable dedupe via `notifications_sent` (extend the kind CHECK at schema.sql:733,741).
10. Default 50M -> ~20M: single constant gates.ts:163 plus the test/doc list in section 6 (tests assert literal 50_000_000 and reason strings); prod env override unknown.
11. 09-SPEC CapHitEvent: each blocking gate (incl. new lifetime/kill gates) will need a non-blocking emit hook; reason-string conventions today are `over_daily_cost_cap`, `over_daily_token_cap`, `over_session_inject_rate`, `programmatic_credit_halt`, `automation_blocked_on_pty:<actor>` -- new ones (e.g. lifetime/kill) will surface in termRefusal.ts, _openapi.ts descriptions, and 09-SPEC `cap` discriminants (`lifetime_inject`).
12. Fail-direction: 09-SPEC:172-173 sets the rule "spawn ceilings fail CLOSED"; the lifetime counter/kill switch are spawn ceilings (unlike sessionInjectRateGate, which fails open at gates.ts:305).
13. Supervisor side needs no change for admission (it trusts hub term.* frames; isHuman hard-coded at session-bridge.ts:518); no-API-key/argv tests are independent of hub gate code and must stay untouched (ROADMAP Phase 3 SC-4).
14. P3 (Telegram permission keystrokes) and P2 (term.attach_file) are un-preflighted exemptions; Phase 3 plan must either record them as explicit exemptions or route them (02-VERIFICATION MINOR-3).

---------------------------------------------------------------------------------------------------
## Validation Architecture
---------------------------------------------------------------------------------------------------
- Framework: Bun test (bun 1.3.14). Hub unit tests are DB-free (leaf-module mocks, `?t=${Date.now()}` cache-busting imports); config `hub/bunfig.toml` preload `./test/_setup.ts`.
- Quick run (per touched file, one process per file because Bun `mock.module` is process-global): `cd hub; bun test test/<name>.test.ts`.
- Full suite: `bun run check-baseline` (every hub test file in its own process vs `tools/regression-baseline.json`: fail must be 0, skip <= 260). Also `bun run schema-lint` (any DDL), `bun run docs:sync` (any OpenAPI/route/reason-string change), `bun run migration-verify` (any schema.sql change).
- Supervisor guards (SC-4, must stay green UNCHANGED, not in qc.yaml): from repo root `bun test supervisor/test/no-api-key-no-streamjson-pty.test.ts`, `no-apikey-fallback-guard.test.ts`, `default-backend-selector.test.ts`, `pty-spawn-interception.test.ts`, `no-legacy-agent-spawn.test.ts`.
- Local-only caveat: `hub/test/human-interactive-flag-guard.test.ts` fails on a Windows CRLF checkout until its `split('\n')` becomes `split(/\r?\n/)` (Phase 3 fold-in).
- Phase 3 requirement -> test map: SC-1 governors/eligibility/order/enabled-ceiling/DI setter -> new `hub/test/governed-pty-gate.test.ts`; automation chain extension and "human chain has no governor" -> `hub/test/pty-preflight.test.ts`; SC-2 spoof/static pins -> `hub/test/term-relay-human-guard.test.ts` (+ new client-socket strip case) and new `hub/test/pty-door-guard.test.ts`; SC-3 OFF == legacy differential matrix -> `governed-pty-gate.test.ts`; SC-4 -> the supervisor guard files above (run, never edit).
- Wave 0: none. Bun is installed; every new test file is created inside the task that introduces its subject.
