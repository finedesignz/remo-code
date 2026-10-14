# design-fork gate 1 -- PTYCAP-03-governed-automation-guard

- timestamp: 2026-10-07T22:51:14Z
- panel-id: design-fork
- trigger: gsd-discuss-phase 3 (unattended): resolution of the Phase 3 design forks F1-F8 (door scope, SC-1 vs the Phase 4 dependency, flag form, naming, actor spoof surface, exemptions, fold-ins). Brief: GATES/design-fork-1.brief.md
- unattended-signal: orchestrator-declared unattended run (batch-1 brief); GSD_UNATTENDED env not set; .planning/config.json workflow.unattended absent
- claim-row-state: claimed-by-this-session (memlog_claims remo-code: session 68abe0eb-6dcc-4c2b-9022-789c48725b98, worktree remo-code-gsd, status IDLE at check time)

## Seats
- claude: REPORTED (general-purpose subagent, sonnet; 47 tool calls; read the code itself)
- codex:  REPORTED (codex exec --sandbox read-only; preflight CODEX_OK)
- agy:    REPORTED (read-only evaluator in a disposable repo copy, --mode plan; preflight AGY_OK; copy torn down after the run)

## Grounding consulted
- design-preferences.md: claude seat NO (UI N/A, stated); codex seat skimmed; agy seat read.
- architecture-preferences.md: claude seat keyword-grepped only (no flag or kill-switch convention found); codex skimmed; agy read.
- global CLAUDE.md rules: codex read 7a, 7c, 11, 12, 22c; agy read the same; claude seat used the rules from session context (7a/7c/11/12/19a/22c).

## Raw seat evidence

### claude seat (verbatim)

CLAUDE SEAT (Backend Architect + Contrarian + Precedent Auditor) | design-fork-1 | PTYCAP Phase 3 | read-only, nothing executed
Worktree C:\Users\artic\GitHub\remo-code-gsd, branch phase-ptycap-03-governed-automation-guard. Paths below are relative to it.

F1 VERDICT: A+ (A plus three additive test-only pins); reject B and C | CONFIDENCE: high
 The real door is the supervisor frame router plus the hub term.* emitters, not the three gates. The supervisor types into the PTY only on term.input / term.attach_file (session-bridge.ts:396-441). user_message goes to ensureRunner(), a stream-json ClaudeRunner (:444-465, :497-504). The hub has exactly two term.* emitters: the client.ts relay forward() (:228-237) and pty-inject.ts:34-48. The term-protocol.ts:84-100 direction sets only fence frames inbound to the hub, so a hub->agent producer has no runtime fence and a static guard is the only one. B (bracketed-paste producer) needs TUI idle/permission-dialog handling and an e2e proof, which is Phase 5. C leaves a future producer unfenced.
 Strictly better is A plus three pins:
  (1) A supervisor canary: the user_message / permission_response branches never reference ptyRunner or pty.write. This is the true structural door and it is untested today (grep of supervisor/test finds no file mentioning user_message).
  (2) Module-allowlist caller pins for `actor:'automation'`, `actor:'human'`, injectPtyKeystroke( and dispatchToSession( (precedent: human-interactive-flag-guard.test.ts:13-17).
  (3) A scanner self-check that the scan FINDS the 2 known emitters (pattern: token-cap-coverage.test.ts:77-94), so it cannot pass vacuously.
 CONTEXT must say the 3 call-site gates are NOT the door.
 EVIDENCE: session-bridge.ts:396-465,497-504; term-protocol.ts:84-100; client.ts:228-237; pty-inject.ts:34-48; ROADMAP.md:97-98; orchestrator/inject.ts:181.

F2 VERDICT: A, with two amendments | CONFIDENCE: high
 B is the stopgap rule 7a bans. A real lifetime counter needs a durable non-cascading store plus a task identity that DispatchRequest lacks (pipeline.ts:36-48; research 03-RESEARCH.md:173-176), and an env kill switch is what Phase 4 must rip out. C weakens a locked SC. A is right. Slots are exported fail-closed `governor_not_implemented:<name>`, so flag ON in Phase 3 admits nothing and an accidental flip is inert.
 Amend: (a) DI must be a test-only setter (`_setGovernorsForTests`, precedent pty-preflight.ts:49-52), never an optional public parameter, because a public `governors` argument is itself a bypass handle. (b) Order: flag, kill_switch, token_cap, inject_rate, lifetime. Cheapest and most authoritative first; first block wins, so the operator sees the meaningful reason. Use a closed union of governor names.
 EVIDENCE: pipeline.ts:36-48; pty-preflight.ts:49-52,170-184; ROADMAP.md:101,109; 03-RESEARCH.md:242.

F3 VERDICT: A | CONFIDENCE: high
 The existing gates fail open on purpose when disabled, so "carried" must mean ENABLED. sessionInjectRateGate returns ok when cap<=0 or non-finite, and maxInjectsPerHour passes 0 and negatives through. The token cap returns over:false / cap:0 when explicitly disabled. This needs two tiny gates.ts exports: reuse the already-exported maxInjectsPerHour()>0, and add isDailyTokenCapEnforced() (isTokenCapExplicitlyDisabled is private). Do NOT extend "enabled" to the cost cap: ROADMAP says dollars are advisory and the owner may run it at 0. Evaluate at call time.
 EVIDENCE: gates.ts:284-289, 301-312 (fail-open at 305), 173-177, 194-197, 230-238 (235); ROADMAP.md:26.

F4 VERDICT: A | CONFIDENCE: high
 This matches the call-time env precedent (isOrchestratorEnabled uses 1|true|yes|on; the token-cap disable flag is parsed the same way). config.ts parseBool is strict "true"/"1" and read once at boot (ptyInteractive); that is worse for tests and has no upside, since a prod flip means a redeploy either way. A DB per-user setting (C) duplicates Phase 4's kill switch.
 Requirements: ONE reader function, with the env name pinned to one module like the humanInteractive guard. A garbage value reads as OFF. The flag is checked at the top of the automation branch before any DB gate (a true no-op). Add a differential test: with the flag unset, the new gate equals the old humanOnlyPtyGate over the full (actor x runnerType) matrix, including reason strings. Prod env stays untouched (live-cutover class, owner-only).
 EVIDENCE: controller.ts:67-70; gates.ts:173-177,487-500; config.ts:13-16,132.

F5 VERDICT: A (hard rename, no alias) | CONFIDENCE: high
 An alias gives two gates with one purpose. The old one is unconditional deny and the new one is conditional admit, so a "deprecated" alias invites the wrong semantics (rule 7a). The surface is bounded: 8 src files, 6 tests, 6 docs. A repo-wide grep of the symbol family shows 155 hits in 45 files, most of them historical .planning. SESSION-ASK-API-SPEC.md uses the drifted name `governedAutomationGate`. Keep humanOnlyRejectsActor and AUTOMATION_ACTORS pure and unchanged (the client.ts:217 tautology still uses them). The rename MUST carry eligibility rule M2 below, or it regresses the external-actor trust posture.
 EVIDENCE: gates.ts:458-500; ask/dispatch.ts:131-143; work/dispatch.ts:293-306; telegram/dispatch.ts:168-176; 03-RESEARCH.md:244.

F6 VERDICT: A, strengthened | CONFIDENCE: high (med on the value of test (i))
 Actor sources verified. The relay hard-codes 'human' (client.ts:286). The ask/work resolvers return compile-time constants (ask/dispatch.ts:140, work/dispatch.ts:302). DispatchRequest has no actor or source field (pipeline.ts:36-48). Test (i) is therefore near-vacuous at runtime; replace it with a static pin that those resolvers return the constants and that nothing under dispatch/ or the gates reads req.source or req.actor.
 The existing spoof test (term-relay-human-guard.test.ts:110-118) proves only the /ws/AGENT direction allowlist. Add a /ws/client test: term.input carrying extra {source:'scheduler', actor:'orchestrator-background'} is still treated as human and the keys are stripped. term-protocol.ts has no passthrough/strict (grep), so this is inferred, not executed.
 Missed attack surface:
  (1) telegram/dispatch.ts:77-79,161 `source ?? "human"` is a fail-OPEN default, and the only caller omits it (telegram-webhook.ts:390-397). Make `source` required at compile time and pin dispatchToSession callers (webhook :390 plus its own replay at dispatch.ts:183).
  (2) checkPtyTurnPreflight takes a caller-asserted actor enum. Passing 'human' sets humanInteractive:true, which skips the programmatic-credit halt and inject-rate (pty-preflight.ts:171-177; gates.ts:140). Pin `actor:'human'` to ws/client.ts.
  (3) Cookie => human is credential identity, not typing. A script holding the owner cookie rides the human chain (residual, out of scope).
 EVIDENCE: above, plus ext-api-key-middleware.ts:25,32,79.

F7 VERDICT: A | CONFIDENCE: med-high
 Telegram answers are one-shot and approver-authorized, and stale, superseded or expired taps return null (takePendingPrompt), so a tap cannot start a new turn. The doc already records the exemption. term.attach_file types a path with no Enter and is never classified as a submit. Record both as allowlist entries with a one-line justification each, and pin injectPtyKeystroke's single caller (telegram-webhook.ts:556). Side note, inferred: the web relay would refuse a permission-answer Enter over cap (ENTER is the submit class), while Telegram would not. That is an inconsistency to document, not a hole, since it spends nothing new. B would wedge a mid-turn permission prompt for a capped user.
 EVIDENCE: telegram-webhook.ts:525-529,556; pty-inject.ts:14-19; client.ts:183,279-281; pty-preflight.ts:135; docs/usage-cost.md:455-461.

F8 VERDICT: A | CONFIDENCE: high
 The fix is one line (human-interactive-flag-guard.test.ts:37, `split('\n')` to `/\r?\n/`). The root cause is the test's LF assumption, not the checkout: .gitattributes pins only .githooks and core.autocrlf=true. The MINOR-2 doc sentence sits in the exact section Phase 3 rewrites, and Phase 3 may touch this guard test anyway. One PR per batch (global rule 19a). Also fix usage-cost.md:462-465: Telegram text goes via user_message, not the PTY. Keep the R-PTY-24 supersession strings, which docs-supersession.test.ts:27-59 reads.
 EVIDENCE: human-interactive-flag-guard.test.ts:35-39; 02-VERIFICATION.md MINOR-1/2; .gitattributes; usage-cost.md:373-377,462-465.

REFUTATION (strongest case against the whole package): it is governance for a door that does not exist.
 The three renamed gates key on runner_type, a column no prod session holds ('pty-interactive' is never set; client.ts:268-270, ask/dispatch.ts:140 defaults to stream-json). Those dispatchers send user_message, which the supervisor never types into the PTY. So the swap changes no runtime behavior in any flag state, before or after Phase 4.
 Flag ON admits nothing in Phase 3 and, after Phase 4, still admits nothing through those call sites. SC-1 is demonstrable only under test DI. The real controls are a grep test plus a preflight seam with zero production automation callers: code that rots while a reviewer reads "governedAutomationPtyGate wired" as "PTY governed".
 Worse, if the rename is "any non-human actor + governors", it WEAKENS today's unconditional deny for external-ask/external-work (untrusted email -> agent) once Phase 4 fills the slots.
 My answer: the package is still right (serial phases, safe by default, no cheaper literal route to SC-1) PROVIDED it takes M1, M2, the F1 pins, and a VERIFICATION that says plainly SC-1 is met structurally with the admit path proven only under test DI.

MISSED FORKS
 M1 Chain composition (critical trap). pty-preflight.ts:41-43 derives the human chain as automation-minus-inject-rate. Appending flag/kill/lifetime to the scanned literal at :34 silently puts fail-closed stubs in the HUMAN chain, so every web Enter is refused with `governor_not_implemented`. Test :123-125 re-derives the same filter and stays green; only the :108-113 name list fails, and it would be "fixed" wrongly.
  Options: (a) append to the literal [outage]; (b) keep the :34 literal and the Phase 2 pins untouched, define an automation-only GOVERNED list, and run [...PTY_AUTOMATION_TURN_GATES, ...GOVERNED] only in runChain's automation branch; (c) build a second literal. PICK (b).
  Do not key a governors list `gates: [` unless it carries both caps (token-cap-coverage.test.ts:50,96-101). A list built in a variable is invisible to the scan (03-RESEARCH.md:150).
 M2 Eligible-actor rule. Admit only actors in AUTOMATION_ACTORS (gates.ts:458-464). external-ask, external-work and unknown strings are denied EVEN with the flag ON and every governor DI-passing, with a test.
  Why: ask/dispatch.ts:59-73 filters ask targets to stream-json, non-orchestrator rows, so ext automation is designed never to target a PTY. Per project CLAUDE.md invariant 3, the work-session containment (deploy-credential scrub) rides the stream-json runner; I did not read the PTY env path. Trim the set per phase later (07-SPEC may want error-capture).
 M3 Block-reason contract. Keep the prefix `automation_blocked_on_pty:<actor>` and append `:<governor_reason>`. telegram/dispatch.ts:218-227 matches startsWith; otherwise a governed block shows the user "cost_capped, resumes UTC midnight". The OFF path stays byte-identical. Update the _openapi.ts reason lists and run docs:sync (03-RESEARCH.md:275).
 M4 Inject-rate is nominal for non-orchestrator producers. countSessionInjectsSince counts only routine_run_log rows with INJECT_OUTCOMES (orchestrator-rows-dal.ts:539-559), written by the orchestrator after inject returns (research :159). PICK: Phase 3 pins the orchestrator as the only permitted `actor:'automation'` caller (F1 caller pin) and records "an admit must be counted" as a Phase 4/5 entry criterion. The durable ledger is Phase 4's.
 M5 SC-1 wording. Do not edit ROADMAP SC-1. Put a Phase-3 scope note in CONTEXT, add a "replaces the fail-closed slots" line under Phase 4, and score SC-1 in VERIFICATION as structurally met.
 M6 Baseline trap. Research :255 gives skip=259 against skip_max=260. Prefer DB-free unit tests (the gate tests mock leaf modules); do not add skipped e2e tests.

RISKS (top 3)
 1. Dead-key rot / bypass. The call-site gates are inert, so the door is two pins. A future producer that calls channel.ws.send directly or builds the frame type dynamically, or a supervisor change routing user_message into the PTY (which flips all 9 dispatch adapters at once), bypasses every hub-side control. Mitigation: F1 pins plus the supervisor canary.
 2. Fail-open / spoof. External actors admitted by "any non-human" (M2); the `source ?? "human"` default; the caller-asserted actor enum on checkPtyTurnPreflight; a public DI parameter.
 3. Self-inflicted outage or silent disable. M1 human-chain leakage (total web-submit refusal), or a governors list that fails the coverage CI. A flag typo reads OFF, which is safe.

UNABLE-TO-VERIFY
 - Nothing executed (read-only): no bun test. The zod key-stripping on TermFrame is inferred from grep; the schema at term-protocol.ts:24-79 was not read in full.
 - The 07/08/09-SPEC expectations (fact 6) come from 03-RESEARCH.md section 8; the specs themselves were not read.
 - Not checked: prod values (inject cap, token cap, REMO_PTY_INTERACTIVE on hub and supervisors, daily_cost_cap_usd).
 - Not read: gates.ts 1-95 and 314-410; client.ts outside 170-370 (the send_message path); keystroke-map.ts; turn-lock.ts; pty_host.rs; macro-cycle.ts (row-write timing taken from research); whether the Telegram pending store clears on terminal-side resolution (the webhook comment says resolved => null).
 - The Read loop-guard (threshold 6, shared across parallel seats) blocked ws/client.ts once and session-bridge.ts once. It cleared on retry, and I used Grep for the remainder. This is an expected gate, so no AgentAutofix ticket was filed.

GROUNDING (actually read)
 Prefs: architecture-preferences.md by keyword grep only (no flag or kill-switch convention found); design-preferences.md NOT read (UI N/A). Rules 7a/7c/11/12/19a/22c came from session context.
 Planning: ROADMAP.md 10-31 and 90-119; 03-RESEARCH.md in full; 02-VERIFICATION.md in full; the brief.
 Code: gates.ts 96-319 and 410-520; pty-preflight.ts in full; pipeline.ts 1-120; ws/client.ts 170-370; pty-inject.ts in full; telegram/dispatch.ts 55-235; ask/dispatch.ts 50-150; work/dispatch.ts 270-330; session-bridge.ts 376-471 plus a grep of 497-519; telegram-webhook.ts 386-399 and 515-565; orchestrator-rows-dal.ts 536-562; term-protocol.ts 78-100.
 Tests and docs: human-interactive-flag-guard.test.ts in full; term-relay-human-guard.test.ts 96-127; token-cap-coverage.test.ts 36-102; pty-preflight.test.ts via grep (96-125); docs/usage-cost.md 368-381 and 452-469; ChatLayout.tsx 150-183; controller.ts and config.ts flag precedents by grep.

### codex seat (verbatim, from codex exec -o)

OVERALL VERDICT: Approve with required hardening around the raw PTY sink, actor inference, and counter accounting.

F1 VERDICT: A+, option A plus raw-sink call-site pinning | CONFIDENCE: high  
No automation producer currently emits PTY input, so B crosses into Phase 5 and violates the serial plan. C would preserve a gate keyed on a production-dead field.  
The guard test should pin both authorized writer modules and every caller of the raw Telegram injector, not merely scan for literal `term.input` strings.  
EVIDENCE: supervisor/src/runners/session-bridge.ts:398-465; hub/src/ws/client.ts:228-232; hub/src/telegram/transcript/pty-inject.ts:34-46; hub/src/ask/dispatch.ts:171-180; hub/src/work/dispatch.ts:331-347; hub/src/telegram/dispatch.ts:150-158.

F2 VERDICT: A+, option A with a non-bypassable production chain | CONFIDENCE: med  
Real fail-closed lifetime and kill-switch DispatchGate slots reconcile the otherwise impossible Phase 3/4 dependency without weakening SC-1.  
Production callers must not be able to inject alternate governors. Use module mocks or a private test builder to prove admission; do not expose an always-pass dependency parameter on the production factory.  
EVIDENCE: .planning/ROADMAP.md:101-113; hub/src/dispatch/pipeline.ts:50-54,210-225; hub/src/dispatch/pty-preflight.ts:170-207.

F3 VERDICT: A | CONFIDENCE: high  
A disabled governor is not a carried governor. The token gate returns OK when explicitly disabled, and the inject-rate gate returns OK for a non-positive cap, so the governed chain must reject those states explicitly.  
Configuration alone is insufficient: the rate ceiling must count the admitted PTY writes, which the current orchestrator-only ledger does not generally do.  
EVIDENCE: hub/src/dispatch/gates.ts:173-196,230-266,284-310; .planning/phases/PTYCAP-03-governed-automation-guard/03-RESEARCH.md:156-159,287-288.

F4 VERDICT: A | CONFIDENCE: high  
Call-time evaluation matches existing safety-flag practice and supports deterministic flag tests. Default OFF must invoke no new governors and preserve the exact existing rejection reason.  
Flag ON still admits nothing in Phase 3 production because the two Phase 4 slots fail closed.  
EVIDENCE: .planning/ROADMAP.md:101-104; hub/src/dispatch/gates.ts:487-497; hub/src/orchestrator/controller.ts:56-69.

F5 VERDICT: A | CONFIDENCE: high  
The roadmap requires the gate to become `governedAutomationPtyGate`. An alias would let stale call sites survive and weaken tests intended to prove complete migration.  
Keeping `humanOnlyRejectsActor` is safe because it remains the pure legacy decision used by the human relay; the new gate owns flag-governed automation admission.  
EVIDENCE: .planning/ROADMAP.md:101; hub/src/dispatch/gates.ts:458-499; hub/src/ask/dispatch.ts:131-143; hub/src/work/dispatch.ts:293-306; hub/src/telegram/dispatch.ts:161-176.

F6 VERDICT: A+, option A plus removal of implicit-human inference | CONFIDENCE: high  
Keep `DispatchRequest` actor-free and resolve actors from authenticated server context. Ext ask/work already use fixed constants, so payload `source` or `actor` fields cannot alter their gate actor.  
Harden Telegram by making the source required and setting literal `human` at the authenticated webhook boundary. Also reject or separately classify legacy-JWT `/ws/client` terminal writes; that connection is currently treated as human despite not being cookie-authenticated.  
EVIDENCE: hub/src/dispatch/pipeline.ts:36-48; hub/src/auth/ext-api-key-middleware.ts:77-80; hub/src/ask/dispatch.ts:135-141; hub/src/work/dispatch.ts:297-303; hub/src/telegram/dispatch.ts:161-170; hub/src/api/telegram-webhook.ts:390-397; hub/src/ws/client.ts:369-397; hub/test/term-relay-human-guard.test.ts:110-117.

F7 VERDICT: A+, option A with provenance enforcement | CONFIDENCE: high  
Do not quota-gate a consumed, user-authorized response to an existing pending prompt. `term.attach_file` is also non-submitting, and its emitted path is stripped of control characters.  
However, `injectPtyKeystroke` is an exported arbitrary-byte sink. Pin its sole production caller or make the raw sink private so future automation cannot reuse the exemption.  
EVIDENCE: hub/src/api/telegram-webhook.ts:521-556; hub/src/telegram/transcript/pty-inject.ts:34-46; hub/src/ws/client.ts:275-295; supervisor/src/runners/session-bridge.ts:40-49,95-103.

F8 VERDICT: A | CONFIDENCE: high  
Both changes are directly in the Phase 3 trust-boundary area, tiny, and already verified Phase 2 follow-ups. Separating them would preserve a known false-red test and materially incorrect documentation during this phase.  
EVIDENCE: .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md:70-72; hub/test/human-interactive-flag-guard.test.ts:35-38; docs/usage-cost.md:373-376,413-416.

REFUTATION: The strongest argument against the package is that it can pass while implementing no usable governed automation. There is no automation PTY producer, the two production governor slots reject unconditionally, and the three renamed dispatch gates still inspect a `runner_type` value known to be dead for the real PTY. Dependency-injected admission tests could therefore validate an imaginary path while the production path remains unexercised and rots until Phase 5. Evidence: hub/src/ws/client.ts:262-270; supervisor/src/runners/session-bridge.ts:398-465; .planning/ROADMAP.md:101-113.

MISSED FORKS:

1. PTY identity and enforcement point. Options: frame/sink identity, repaired runtime capability state, or existing `sessions.runner_type`. Pick frame/sink identity. The byte door is authoritative; `runner_type` is not.

2. Counter consumption semantics. Options: atomic pre-send reserve with an idempotency token, post-send logging, or observational counting. Pick atomic pre-send reserve. A separate count-then-send operation is raceable and crashes undercount.

3. Chain execution count. Options: governors run once immediately before PTY submit, run in both dispatch and preflight, or dispatch only. Pick once at the PTY submit door; dispatch-level policy checks must be non-consuming.

4. Human authentication. Options: only `session_cookie` can produce human PTY input, or legacy JWT also counts as human. Pick cookie-only; otherwise bearer automation can enter through `/ws/client`.

5. Exemption authority. Options: private/capability-scoped prompt-response sink with a pinned caller, or exported arbitrary-byte injector. Pick the private scoped sink.

6. Governor failure behavior. Options: thrown/timeout checks return a typed denial, propagate as an exception, or pass. Pick typed fail-closed denial, matching PTY preflight behavior.

RISKS:

1. Bypass: future automation calls the already-allowlisted exported `injectPtyKeystroke`, evading a module-only door guard.

2. Fail-open or inert governor: disabled caps pass, or PTY injections never create rows in the ledger being counted. Concurrent checks can also exceed the ceiling without atomic reservation.

3. Spoof and dead-code rot: Telegram currently defaults an omitted source to human, legacy JWT clients are treated as human, and tests could exercise injected gates while the real PTY continues to ignore `runner_type`.

UNABLE-TO-VERIFY:

- I did not run tests because this evaluator seat was explicitly read-only and test execution could create caches or other filesystem state.
- I could not verify current production values for `ALLOW_LEGACY_LOGIN`, token-cap disablement, inject-rate configuration, or PTY flags.
- No Phase 3 implementation exists yet, so exact door-guard coverage and production-chain visibility cannot be verified.

GROUNDING:

- Skimmed `~/.claude/architecture-preferences.md`.
- Skimmed `~/.claude/design-preferences.md`; UI guidance is not applicable here.
- Read `~/.claude/CLAUDE.md` rules 7a, 7c, 11, 12, and 22c.
- Read `.planning/ROADMAP.md:14-28,95-115`.
- Read `03-RESEARCH.md` sections 1, 2, 3, 4, 8, and DESIGN SEAMS.
- Read `02-VERIFICATION.md`, including MINOR-1, MINOR-2, and MINOR-3.
- Read the requested functions in `hub/src/dispatch/gates.ts`.
- Read all of `hub/src/dispatch/pty-preflight.ts`.
- Read `DispatchRequest`, `DispatchGate`, and gate execution in `hub/src/dispatch/pipeline.ts`.
- Read the `term.input` relay and authentication branches in `hub/src/ws/client.ts`.
- Read all of `hub/src/telegram/transcript/pty-inject.ts`.
- Read `hub/src/ask/dispatch.ts`, `hub/src/work/dispatch.ts`, and `hub/src/telegram/dispatch.ts`.
- Read `supervisor/src/runners/session-bridge.ts:380-470`, plus attachment sanitization at lines 35-103.
- Also read the relevant spoof, cap-coverage, preflight, Telegram, no-API-key, and documentation guard tests.

### agy seat (verbatim)

# Review Verdict: PTYCAP Phase 3 Design Fork (Gate Panel Seat)

F1 VERDICT: A | CONFIDENCE: high | Bounds Phase 3 to governance primitives and static door guards; building producers before Phase 4 governors violate serial phase dependencies and Karpathy minimal diff. | EVIDENCE: .planning/ROADMAP.md:95-116, supervisor/src/runners/session-bridge.ts:398-441, hub/src/ws/client.ts:215-223, hub/src/telegram/transcript/pty-inject.ts:34-48

F2 VERDICT: A | CONFIDENCE: high | Exported fail-closed stub gates (governor_not_implemented) strictly satisfy SC-1 without deferring or half-building Phase 4 lifetime/kill-switch features. | EVIDENCE: .planning/ROADMAP.md:101-105, hub/src/dispatch/pty-preflight.ts:33-43, hub/src/dispatch/pipeline.ts:51-54

F3 VERDICT: A | CONFIDENCE: high | Governed automation requires active ceilings; treating disabled caps (<=0 or disabled env) as unconfigured blocks ungoverned PTY spend while keeping standard fail-open intact. | EVIDENCE: hub/src/dispatch/gates.ts:173-177,284-289,304-305, .planning/ROADMAP.md:101-103

F4 VERDICT: A | CONFIDENCE: high | Call-time env check (REMO_GOVERNED_AUTOMATION_PTY) matching isOrchestratorEnabled pattern ensures zero-cache flag evaluation and byte-identical refusal reasons when OFF. | EVIDENCE: hub/src/dispatch/gates.ts:470-499, hub/src/orchestrator/controller.ts:67-70, hub/test/human-only-guard.test.ts:72-76

F5 VERDICT: A | CONFIDENCE: high | Hard rename removes dead identifiers across internal call sites without legacy aliases (rule 7a), while keeping pure predicates unchanged for flag-off evaluation. | EVIDENCE: hub/src/ask/dispatch.ts:135, hub/src/work/dispatch.ts:297, hub/src/telegram/dispatch.ts:168, hub/src/dispatch/gates.ts:470-499

F6 VERDICT: A | CONFIDENCE: high | DispatchRequest remains actor-free and server-inferred via caller closures; negative tests ensure client-supplied source fields cannot spoof human status. | EVIDENCE: hub/src/dispatch/pipeline.ts:36-48, hub/src/telegram/dispatch.ts:161-171, hub/src/api/telegram-webhook.ts:390-397, hub/test/term-relay-human-guard.test.ts:110-118

F7 VERDICT: A | CONFIDENCE: high | Pinning Telegram permission keystrokes and attach_file as test-pinned explicit exemptions avoids wedging interactive prompts while preventing unreviewed PTY writers. | EVIDENCE: hub/src/telegram/transcript/pty-inject.ts:14-19,34-48, supervisor/src/runners/session-bridge.ts:411-441, hub/src/ws/client.ts:238-241, .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md:72

F8 VERDICT: A | CONFIDENCE: high | Folding MINOR-1 (CRLF split in human-interactive-flag-guard.test.ts) and MINOR-2 (usage-cost.md clarification) into this PR avoids PR churn and fixes Windows test suite false reds. | EVIDENCE: .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md:68-73, hub/test/human-interactive-flag-guard.test.ts:38, docs/usage-cost.md:370-377

REFUTATION: The recommended package constructs an entirely unflippable door in Phase 3: because the lifetime counter and kill switch fail closed by design, enabling the feature flag in production still rejects 100% of automation turns until Phase 4 lands. Furthermore, testing the admit path purely through dependency injection mocks risks designing governor interfaces that diverge from Phase 4/5 real-world runtime requirements.

MISSED FORKS:
- MF-1 Module placement of governor chain: Option A (new module hub/src/dispatch/governed-pty.ts) vs Option B (inline inside gates.ts). Pick: Option A to keep gates.ts focused and prevent circular imports.
- MF-2 Telegram source inference: Option A (strictly enforce server-tagged enum for input.source in telegram/dispatch.ts) vs Option B (allow input.source ?? "human"). Pick: Option A to prevent internal callers from passing unverified "human" source.
- MF-3 Stream-json bypass on governed gate: Option A (return ok:true immediately if runner_type !== 'pty-interactive') vs Option B (require full governor chain on all runner types). Pick: Option A to preserve stream-json dispatch pipeline semantics.

RISKS:
1. Mock-only admit path rot: Because production slots fail closed until Phase 4, the passing path exists only in unit tests using DI, allowing subtle interface drift before Phase 4 implementation.
2. Door-guard bypass via new WS frame types: Future frame types that write to PTY without matching term.input or term.attach_file could bypass preflight if the door-guard test only inspects existing frame names.
3. Fail-open leakage in shared gates: If the governor wrapper around sessionInjectRateGate or dailyTokenCapGate fails to strictly validate positive configured limits, misconfigured environments could allow ungoverned execution.

UNABLE-TO-VERIFY:
- Production Coolify environment values for token caps and orchestrator flags (external infrastructure, out of scope for local codebase review).
- Full live PostgreSQL end-to-end suite (requires REMO_E2E_DB_URL, skipped in unit environment).

GROUNDING:
Read in full:
- ~/.claude/architecture-preferences.md
- ~/.claude/design-preferences.md
- ~/.claude/CLAUDE.md (rules 7a, 7c, 11, 12, 22c)
- .planning/ROADMAP.md (lines 14-28, 95-115)
- .planning/phases/PTYCAP-03-governed-automation-guard/03-RESEARCH.md (sections 1, 2, 3, 4, 8, DESIGN SEAMS)
- .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md (MINOR-1, MINOR-2, MINOR-3)
- hub/src/dispatch/gates.ts
- hub/src/dispatch/pty-preflight.ts
- hub/src/dispatch/pipeline.ts
- hub/src/ws/client.ts
- hub/src/telegram/transcript/pty-inject.ts
- hub/src/ask/dispatch.ts
- hub/src/work/dispatch.ts
- hub/src/telegram/dispatch.ts
- supervisor/src/runners/session-bridge.ts (lines 380-470)

## Correlated-error check
The three seats read the same brief, which marked my recommendation (R) on every fork, so the unanimous A on F1-F8 is partly
anchoring and is NOT counted as three independent confirmations. What IS independent: each seat cited different file:line
reads, and each surfaced findings the brief did not contain (claude: M1 human-chain leakage trap, M2 eligible-actor rule,
the fail-open `source ?? "human"` default; codex: raw-sink pinning, counter reserve-before-send, chain-execution-count;
agy: governor module placement, stream-json bypass). Those additions are the evidence of independent reading. All three
independently converged on the same strongest refutation (governance for a door that does not exist yet), which is a real
property of the roadmap ordering, not an artifact of the brief.

## UNABLE-TO-VERIFY
- Production Coolify env (REMO_ORCHESTRATOR_DAILY_TOKEN_CAP, inject cap, REMO_PTY_INTERACTIVE, ALLOW_LEGACY_LOGIN) -- out of scope, read-only gate, no prod access.
- Nothing was executed by any seat (read-only); zod key-stripping on TermFrame is inferred, to be proven by the new /ws/client test.
- Live-Postgres e2e behavior -- not applicable to the DB-free Phase 3 design.

## Evidence weighting notes
No seat was LOW-CONFIDENCE: all three cite file:line they read. The claude seat produced the most evidence (47 tool calls) and its
missed forks M1/M2 are adopted as binding. One codex missed-fork (MF-4, "only session_cookie may produce human PTY input") is
REJECTED by the orchestrator: legacy-JWT is the prod login path (CLAUDE.md "Prod login = legacy bcrypt"; /ws/client JWT branch,
hub/src/ws/client.ts:384-397), so re-classifying it would lock the owner out of the web terminal. Recorded as a residual
(credential identity, not typing) in CONTEXT.

## Decision
VERDICT: PASS
All eight forks resolve to the recommended option A, amended as follows (binding on the planner; full list in 03-CONTEXT.md D-01..D-17):
- F1 A+: governance primitives only (flag, renamed gate, automation-only governed chain, eligible-actor rule); NO new byte-producer (Phase 5).
  Door pins added: hub term.* emitter allowlist with scanner self-check, supervisor canary (user_message/permission_response never reach the PTY),
  module-allowlist caller pins for actor:'automation', actor:'human', injectPtyKeystroke( and dispatchToSession(. CONTEXT states the three call-site gates are NOT the door.
- F2 A: new module hub/src/dispatch/governed-pty.ts; closed union of governors, order kill_switch, token_cap, inject_rate, lifetime_counter (flag first);
  kill_switch and lifetime_counter are exported DispatchGates that FAIL CLOSED (governor_not_implemented:<name>) until Phase 4; DI only through a test-only setter
  (no public parameter); ROADMAP SC-1 text untouched, scored "structurally met".
- F3 A: a governor counts as carried only when ENABLED (inject cap > 0; token cap not explicitly disabled -> new isDailyTokenCapEnforced()); cost cap excluded (advisory).
- F4 A: env REMO_GOVERNED_AUTOMATION_PTY, call-time, one reader, garbage = OFF, checked first; differential test proves OFF == legacy gate over the full (actor x runnerType) matrix.
- F5 A: hard rename, gate name 'governed_automation_pty', no alias; humanOnlyRejectsActor/AUTOMATION_ACTORS unchanged.
- F6 A strengthened: closure-resolved actor; static pins; /ws/client extra-key strip test; Telegram `source` made required (no `?? "human"` default); pin actor:'human' to ws/client.ts.
- F7 A: Telegram permission-answer keystrokes and term.attach_file are explicit pinned exemptions; injectPtyKeystroke single caller pinned.
- F8 A: CRLF-safe split + usage-cost.md corrections folded into the Phase 3 PR.
- Missed forks adopted: M1 (automation-only governed list run inside runChain's automation branch; the human chain never sees governors), M2 (only AUTOMATION_ACTORS eligible;
  external-ask/external-work/unknown always denied), M3 (reason prefix automation_blocked_on_pty:<actor> kept, governor reason appended), M4 (orchestrator is the only permitted
  actor:'automation' caller; "an admit must be counted" is a Phase 4/5 entry criterion), M5, M6 (no new skipped tests), codex MF-3/MF-6 (governors are non-consuming checks;
  typed fail-closed denial), agy MF-1 (module placement) / MF-3 (non-PTY runner_type => ok).
The panel's strongest dissent (governance for a door that does not exist yet; admit path provable only under test DI) is accepted as a property of the serial roadmap
and is carried into VERIFICATION as an explicit statement, not hidden.
