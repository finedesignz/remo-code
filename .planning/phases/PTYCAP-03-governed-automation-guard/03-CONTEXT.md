# Phase 3: Governed-Automation Guard - Context

**Gathered:** 2026-10-07
**Status:** Ready for planning
**Decision record:** `GATES/design-fork-1.md` (3-seat panel: claude + codex + agy, VERDICT PASS, amendments adopted below). Grey areas were
answered by that panel, not by a human (unattended batch run).

<domain>
## Phase Boundary

Phase 3 delivers the **governance primitives** that decide whether a NON-HUMAN actor may drive an interactive PTY, behind a flag that is
**default OFF and a true no-op when off**. It replaces `humanOnlyPtyGate` with `governedAutomationPtyGate`, defines the four required
governors (kill switch, token cap, inject-rate ceiling, lifetime counter), extends the automation PTY preflight chain, and pins the real
"door" (the hub `term.*` emitters and the supervisor frame router) with structural tests.

**In scope:** flag + reader; `governedAutomationPtyGate` (hard rename at the 3 call sites); eligible-actor rule; governors module with
two fail-closed placeholder slots; automation-only extension of the PTY preflight chain; door pins (emitter allowlist, supervisor canary,
caller pins); spoof/negative tests; explicit exemptions; Phase-2 MINOR fold-ins (CRLF test fix, docs corrections); docs/OpenAPI.

**Out of scope (explicitly):**
- Any automation `term.input` / `term.attach_file` byte-producer (typing a prompt into a TUI) -> Phase 5 (first unattended PTY proof).
- The real lifetime counter, its durable ledger, and the real kill switch -> Phase 4 (this phase ships fail-closed slots for them).
- Kill-switch UI -> Milestone GOV. Any prod env change / flag flip -> owner-only live cutover (not done by this run).
- Re-classifying legacy-JWT `/ws/client` connections (they stay `human`: legacy login is the prod login path).

**Honest scope statement (carry into VERIFICATION):** the three call-site gates are NOT the door. Every automation dispatch adapter sends
`user_message`, which the supervisor routes to the stream-json runner, never the PTY (supervisor/src/runners/session-bridge.ts ~398-465); the
only hub-to-PTY writers are the web relay and Telegram permission keystrokes. SC-1 is therefore met STRUCTURALLY: the admit path is proven
under test dependency-injection, production slots fail closed, and the door is pinned by tests. ROADMAP SC-1 text is NOT edited.

</domain>

<decisions>
## Implementation Decisions

### Door scope and structural pins
- **D-01 (F1 A+):** Governance primitives only; build NO byte-producer. Add three additive pins, all DB-free hub unit tests (they run in `check-baseline`):
  (a) an allowlist of hub modules that may emit hub->agent `term.*` frames (today exactly `ws/client.ts` relay and `telegram/transcript/pty-inject.ts`) with a
  scanner self-check that the scan FINDS both (cannot pass vacuously, pattern: token-cap-coverage.test.ts:77-94);
  (b) a supervisor canary (static read of `supervisor/src/runners/session-bridge.ts`) that the `user_message` and `permission_response` branches never reference
  the PTY runner or `pty.write`;
  (c) module-allowlist caller pins for `actor: 'automation'` (only the future orchestrator module), `actor: 'human'` preflight calls (only `ws/client.ts`),
  `injectPtyKeystroke(` (only `api/telegram-webhook.ts`) and `dispatchToSession(` (webhook + its own replay).
  Precedent: `hub/test/human-interactive-flag-guard.test.ts` ALLOWED-set pattern. **Reversibility:** reversible - tests only.
- **D-16:** `injectPtyKeystroke` is pinned (single production caller), not made private.

### Governors (SC-1)
- **D-02 (F2 A):** New module `hub/src/dispatch/governed-pty.ts`. Closed union `GovernorName = 'kill_switch' | 'token_cap' | 'inject_rate' | 'lifetime_counter'`, fixed order
  kill_switch, token_cap, inject_rate, lifetime_counter (the flag check precedes all; first block wins, cheapest/most authoritative first). `kill_switch` and
  `lifetime_counter` are real exported `DispatchGate`s whose Phase-3 bodies **FAIL CLOSED**: block reason `governor_not_implemented:<name>`. Phase 4 replaces the bodies
  (add a "replaces the fail-closed slots" line under Phase 4 in ROADMAP; leave SC-1 text alone). Dependency injection ONLY through a test-only setter
  (`_setGovernorsForTests` / reset, precedent `pty-preflight.ts` `_setPtyPreflightTimeoutForTests`); NO optional public `governors` parameter (a public param is a bypass handle).
  With the flag ON in Phase 3 production nothing is admitted - by design. **Reversibility:** costly - Phases 7/8/9 import these gate names.
- **D-03 (F3 A):** A governor is "carried" only when ENABLED. The governed chain blocks `governor_unconfigured:<name>` when the inject-rate ceiling is <= 0 / non-finite
  (reuse exported `maxInjectsPerHour()`) or the token cap is explicitly disabled (add tiny export `isDailyTokenCapEnforced()` in gates.ts; `isTokenCapExplicitlyDisabled`
  is private). The cost cap is NOT part of the enabled rule (dollars are advisory). Evaluate at call time. The "over the limit" evaluation stays with the existing gates.
- **D-14 (Codex MF-3/MF-6):** Governors in this phase are NON-CONSUMING checks. A thrown/timed-out governor yields a typed fail-closed denial (reuse runChain's existing
  `pty_preflight_error` / `pty_preflight_timeout` behaviour). Atomic reserve-before-send consumption is Phase 4's design (note in 04 context).
- **D-12 (M4):** `sessionInjectRateGate` counts only orchestrator `routine_run_log` rows, so an admitted non-orchestrator turn would be uncounted. Phase 3 pins the
  orchestrator as the ONLY permitted `actor: 'automation'` caller (D-01c) and records "an admitted automation PTY turn must be counted before this chain is trusted" as a
  Phase 4/5 entry criterion (the durable ledger is Phase 4's).

### Flag, naming, eligibility
- **D-04 (F4 A):** Flag `REMO_GOVERNED_AUTOMATION_PTY`, env var, read at CALL time, truthy only for `1|true|yes|on` (case-insensitive), any other/garbage value = OFF. ONE reader
  function `governedAutomationEnabled()` in `governed-pty.ts`; a guard test pins the env-var name to that module. Checked FIRST in the automation branch, before any DB gate.
  OFF => no automation turn admitted to a PTY and the 3 call sites behave byte-identically to today: a **differential test** keeps a frozen copy of the legacy decision as an
  oracle and proves new==legacy over the full (actor x runnerType) matrix including the reason strings. **Reversibility:** costly - published env contract once documented.
- **D-05 (F5 A):** Hard rename `humanOnlyPtyGate` -> `governedAutomationPtyGate` (gate `name` = `'governed_automation_pty'`); NO alias. Update the 3 call sites (`ask/dispatch.ts`,
  `work/dispatch.ts`, `telegram/dispatch.ts`), their tests, and docs (incl. the drifted name `governedAutomationGate` in `.planning/architecture/SESSION-ASK-API-SPEC.md` and
  `docs/session-ask.md`). `humanOnlyRejectsActor` and `AUTOMATION_ACTORS` stay unchanged (the web relay still uses the predicate).
- **D-06 (M2, critical):** Eligible-actor rule: only actors in `AUTOMATION_ACTORS` (`scheduler`, `orchestrator-background`, `auto-dev`, `error-capture`, `agent`) can ever be admitted.
  `external-ask`, `external-work` and unknown strings are denied EVEN with the flag ON and every governor passing (test). Without this the rename would WEAKEN today's
  unconditional deny for untrusted-email-driven actors once Phase 4 fills the slots.
- **D-17:** For a non-PTY `runner_type` the gate returns ok immediately (unchanged semantics, agy MF-3).

### Chain composition (critical trap)
- **D-07 (M1, critical):** `pty-preflight.ts` derives the human chain as "automation minus inject-rate" (L41-43). Do NOT append governors to the scanned literal at L34
  (it would put fail-closed stubs into the HUMAN chain and refuse every web Enter). Keep the L34 literal and all Phase-2 pins untouched; define an automation-only governed list
  and run `[...PTY_AUTOMATION_TURN_GATES, ...governed]` only in `runChain`'s automation branch. Add an explicit test that the human chain contains no governor gate. Never write a
  governors list as a `gates: [` literal lacking both caps (token-cap-coverage.test.ts); a list built in a variable is invisible to that scan.
- **D-08 (M3):** Reason contract: keep the prefix `automation_blocked_on_pty:<actor>`; a governed block appends `:<governor_reason>`; the OFF path is byte-identical. The Telegram
  mapper matches by prefix (telegram/dispatch.ts ~218-227). Update the `_openapi.ts` reason lists, run `bun run docs:sync`, and check `web/src/lib/termRefusal.ts` mapping.

### Actor inference and spoofing (SC-2)
- **D-09 (F6 A+):** Actor stays closure-resolved from server context; `DispatchRequest` stays actor-free. Tests: (i) static pin that the ask/work resolvers return the compile-time
  constants and that nothing under `hub/src/dispatch/` (or the gates) reads `req.source` / `req.actor`; (ii) a `/ws/client` test that a `term.input` frame carrying extra
  `{source:'scheduler', actor:'orchestrator-background'}` is still treated as `human` and the keys are stripped (zod strip is inferred, so PROVE it); (iii) keep the existing
  agent-socket spoof test (`term-relay-human-guard.test.ts:110-118`); (iv) make `source` a REQUIRED compile-time parameter of Telegram `dispatchToSession` and pass the literal
  `'human'` at the authenticated webhook boundary (removes the fail-open `input.source ?? "human"` default at telegram/dispatch.ts ~161).
- **D-15:** Codex MF-4 (cookie-only human) is REJECTED: legacy-JWT `/ws/client` is the prod login path and stays `human`. Residual (document): cookie/JWT => human is credential identity,
  not typing; any future bearer-automation lane must use `/ws/agent` or an ext key, never `/ws/client`.

### Exemptions and fold-ins
- **D-10 (F7 A):** Telegram permission-answer keystrokes (`injectPtyKeystroke`, one-shot, approver-authorized via `takePendingPrompt`) and `term.attach_file` (types a path, never
  Enter) are explicit, test-pinned human-initiated exemptions with a one-line justification each - NOT routed through preflight (a quota check must not wedge a mid-turn permission prompt).
  Document the (non-hole) inconsistency that the web relay would refuse a permission-answer Enter over cap while Telegram would not.
- **D-11 (F8 A):** Fold into this PR: make `hub/test/human-interactive-flag-guard.test.ts` CRLF-safe (`split(/\r?\n/)`); correct `docs/usage-cost.md` (L373-377 wrong mechanism - the real
  reason is that `user_message` goes to the stream-json runner; L462-465 Telegram text goes via `user_message`, not the PTY). Keep the R-PTY-24 supersession strings that
  `hub/test/docs-supersession.test.ts` reads.
- **D-13 (M6):** No new skipped tests: baseline is skip=259 vs `skip_max=260`. Use DB-free unit tests (mock leaf modules like `pty-preflight.test.ts`); no new e2e that skips locally.

### Claude's Discretion
Test file names; exact helper signatures; task ordering; whether the governed list lives next to or inside `runChain`; wording of block reasons beyond the contract in D-08.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase text and invariants
- `.planning/ROADMAP.md` lines 14-28 (hard invariants), 95-115 (Phase 3 and 4)
- `.planning/phases/PTYCAP-03-governed-automation-guard/GATES/design-fork-1.md` - the binding panel record (read the DECISION section)
- `.planning/phases/PTYCAP-03-governed-automation-guard/03-RESEARCH.md` - file:line facts (sections 1, 2, 3, 4, 8, 9, 10, DESIGN SEAMS)
- `.planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md` - MINOR-1/2/3 inputs; `02-01-SUMMARY.md`
- `.planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md`, `PTYCAP-08-task-qc/08-SPEC.md`, `PTYCAP-09-cap-hit-qc-trigger/09-SPEC.md` - later consumers of the governor names/semantics

### Code
- `hub/src/dispatch/gates.ts` (L458-500 actors + gate; L163-310 caps and inject-rate), `hub/src/dispatch/pty-preflight.ts`, `hub/src/dispatch/pipeline.ts` (L36-54)
- `hub/src/ws/client.ts` (term.input relay ~L174-358), `hub/src/telegram/transcript/pty-inject.ts`, `hub/src/api/telegram-webhook.ts` (~L386-399, 515-565)
- `hub/src/{ask,work,telegram}/dispatch.ts`, `supervisor/src/runners/session-bridge.ts` (L380-470)

### Tests and docs
- `hub/test/{human-only-guard,term-relay-human-guard,telegram-human-only-guard,ext-ask-gates,ext-work-containment,pty-preflight,ws-client-pty-preflight,token-cap-coverage,human-interactive-flag-guard,automation-routing-guard}.test.ts`
- `supervisor/test/{no-api-key-no-streamjson-pty,no-apikey-fallback-guard,default-backend-selector,pty-spawn-interception,no-legacy-agent-spawn}.test.ts` (must stay green UNCHANGED, SC-4)
- `docs/usage-cost.md` (PTYCAP Phase 2 section), `CLAUDE.md` (env section + docs map), `hub/src/api/_openapi.ts` + `bun run docs:sync`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `checkPtyTurnPreflight({userId, sessionId, actor})` and `runChain` (fail-closed, 5s timeout) - the seam the future producer will call.
- `humanOnlyRejectsActor`, `AUTOMATION_ACTORS`, gate factories bound to an identity (`askRateGate`, `workRateGate`), `maxInjectsPerHour()`, `getTokenCapStatus()`.
- Test pattern: leaf-module mocks + `?t=${Date.now()}` cache-busting imports (`pty-preflight.test.ts:35-68`).

### Established Patterns
- Call-time `process.env` flags with `1|true|yes|on` (controller.ts `isOrchestratorEnabled`); `_set...ForTests` setters for DI; ALLOWED-set structural guard tests.
- Spawn ceilings fail CLOSED (07/09 specs); spend caps fail closed too in current code (gates.ts L194-222) although two specs still say fail-open (stale - fix in docs touched).

### Integration Points
- 3 call sites swap the gate; `pty-preflight.ts` `runChain` gains the automation-only governed list; `gates.ts` gains `isDailyTokenCapEnforced()`; Telegram `dispatchToSession` gains a required `source`.

</code_context>

<specifics>
## Specific Ideas

No UI. Block reasons must stay greppable: `automation_blocked_on_pty:<actor>[:<governor_reason>]`, `governor_not_implemented:<name>`, `governor_unconfigured:<name>`.

</specifics>

<deferred>
## Deferred Ideas

- Automation `term.input` producer + orchestrator wiring -> Phase 5. Real lifetime counter / kill switch / reserve-before-send atomic consumption / 60% alarm / cap 50M->20M -> Phase 4.
- Kill-switch UI -> Milestone GOV. Repairing the dead `runner_type` key (runtime PTY capability state) -> candidate for Milestone DEBT.
- Cookie/JWT-as-human residual (credential identity) - documented, not fixed.
- P1 verification gap G-1 (PTY usage double count by `message.id`) -> fixed in the Phase 4 PR (token accuracy matters before lowering the ceiling).

</deferred>

---

*Phase: 3-governed-automation-guard*
*Context gathered: 2026-10-07*
