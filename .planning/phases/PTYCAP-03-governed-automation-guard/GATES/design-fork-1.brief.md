# design-fork gate 1 brief -- PTYCAP Phase 3 (Governed-Automation Guard)

You are a READ-ONLY evaluator seat on a design-fork gate panel (refute-first). Do NOT edit, write,
commit, push, install or change any state. Read, judge, return a verdict. ASCII punctuation only.
All paths below are relative to the repo root you were given (the remo-code checkout).

## 0. Ground first (mandatory; say in your answer which of these you actually read)
- ~/.claude/architecture-preferences.md and ~/.claude/design-preferences.md (skim; UI is N/A here)
- ~/.claude/CLAUDE.md rules 7a (no workarounds), 7c (no fallbacks), 11 (smallest diff), 12, 22c (no LLM API keys)
- .planning/ROADMAP.md lines 14-28 (hard invariants) and 95-115 (Phase 3 + Phase 4)
- .planning/phases/PTYCAP-03-governed-automation-guard/03-RESEARCH.md sections 1, 2, 3, 4, 8 and DESIGN SEAMS
- .planning/phases/PTYCAP-02-pty-preflight-gate/02-VERIFICATION.md (MINOR-1/2/3)
- Code you must read yourself before claiming anything: hub/src/dispatch/gates.ts (humanOnlyRejectsActor,
  humanOnlyPtyGate, sessionInjectRateGate, dailyTokenCapGate), hub/src/dispatch/pty-preflight.ts,
  hub/src/dispatch/pipeline.ts (DispatchRequest, DispatchGate), hub/src/ws/client.ts (term.input relay),
  hub/src/telegram/transcript/pty-inject.ts, hub/src/{ask,work,telegram}/dispatch.ts,
  supervisor/src/runners/session-bridge.ts lines 380-470.
A seat that only restates this brief without reading the code is LOW-CONFIDENCE and will not outvote an evidenced seat.

## 1. The decision
Phase 3 goal: "Automation may drive the PTY, but only under governance." Success criteria (ROADMAP):
 SC-1 humanOnlyPtyGate becomes governedAutomationPtyGate: a non-human actor is admitted ONLY when carrying
      token cap + inject-rate ceiling + lifetime counter + kill switch.
 SC-2 Actor remains server-inferred; a spoofed `source` cannot impersonate a human (negative test).
 SC-3 Flag-gated, default OFF; a TRUE no-op when off.
 SC-4 The no-API-key and argv-allowlist guard tests still pass unchanged.
Hard invariants: no provider API key on the PTY path; actor server-inferred never client-asserted; every
dispatch path inside the gate chain (hub/test/token-cap-coverage.test.ts); caps in tokens; additive idempotent
DDL only; new flags DEFAULT OFF and a true no-op when off. Phases are strictly serial: the lifetime inject
counter and the kill switch are BUILT IN PHASE 4, which depends on Phase 3.

## 2. Verified facts (already checked by two independent agents; re-verify what you rely on)
1. Today NO automation producer emits term.input / term.attach_file to a PTY. The supervisor routes hub
   `user_message` frames to the stream-json runner and only `term.*` frames to the PTY
   (supervisor/src/runners/session-bridge.ts ~398-465). The only hub->agent term.input writers are the web
   relay (cookie human, preflighted on prompt submit) and Telegram permission-answer keystrokes
   (injectPtyKeystroke, no preflight, human-initiated, documented exempt).
2. humanOnlyPtyGate (gates.ts ~487) sits in 3 gate lists (ask/dispatch.ts, work/dispatch.ts, telegram/dispatch.ts)
   and is keyed on sessions.runner_type == 'pty-interactive', which is DEAD as a key in prod (client.ts ~268-270;
   every prod session is runner_type 'stream-json'; PTY is a supervisor runtime fact, not a DB fact).
3. Phase 2 built checkPtyTurnPreflight({userId, sessionId, actor:'automation'|'human'}) with chain
   [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]; human = same minus inject-rate.
   actor 'automation' has NO production caller (tests only).
4. DispatchRequest has no actor field; the actor reaches a gate only through a resolver closure the caller builds
   from server context (cookie => human; /api/ext route => external-ask/external-work).
5. sessionInjectRateGate counts routine_run_log rows (orchestrator-only writers) and FAILS OPEN when its cap env
   is <= 0; the token cap can be explicitly disabled (REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED=1).
6. Specs for Phases 7/8/9 treat spawn ceilings as FAIL CLOSED and consume Phase 4's lifetime counter and kill
   switch as PREDICATES callable from the autospawn pre-launch chain and as gates.
7. telegram/dispatch.ts ~161 defaults `source = input.source ?? "human"`; its only production caller omits source.

## 3. Forks. For each: give VERDICT (pick an option or propose a strictly better one), 2-4 lines of reasoning,
##    and EVIDENCE (file:line you personally read). My recommendation is marked (R); try to REFUTE it first.

F1 Door scope.
  A (R) Governance primitives only: the flag, governedAutomationPtyGate replacing humanOnlyPtyGate at the 3
        call sites, the PTY automation chain in pty-preflight extended with the flag precondition and the two
        governor slots, plus a static "door guard" test pinning the ONLY modules allowed to emit hub->agent
        term.* frames (web relay, telegram pty-inject) so a future producer cannot bypass governance.
        NO new byte-producer (typing a prompt into a TUI is Phase 5's first-unattended-run proof).
  B     A plus build the automation term.input producer (bracketed paste + submit) and wire the orchestrator now.
  C     Rename the gate only; no seam, no guard test.
F2 SC-1 vs the Phase 4 dependency (lifetime counter + kill switch do not exist yet).
  A (R) Four named governors in a fixed ordered chain (token cap, inject-rate, lifetime counter, kill switch) in a
        new module. The lifetime and kill-switch slots are real exported DispatchGates whose Phase-3 bodies FAIL
        CLOSED (`governor_not_implemented:<name>`); Phase 4 replaces the bodies. Tests use dependency injection to
        pass governors and prove the admit path, and prove the production slots block.
  B     Implement a minimal functional lifetime counter + env kill switch inside Phase 3.
  C     Amend ROADMAP SC-1 to defer the two governors (weakens a locked success criterion).
F3 Ceilings must be ENABLED to count as "carried".
  A (R) The governed chain treats a disabled ceiling (inject-rate cap <= 0, token cap explicitly disabled) as NOT
        carried and blocks `governor_unconfigured:<name>` even though the underlying gates fail open.
  B     Reuse the existing gates as-is (they fail open when disabled).
F4 Flag form.
  A (R) env var REMO_GOVERNED_AUTOMATION_PTY (truthy 1|true|yes|on), read at CALL time, default OFF. OFF => no
        automation turn is admitted to a PTY and the 3 existing call sites behave byte-identically (same reason
        string `automation_blocked_on_pty:<actor>`). Flipping it in prod is an owner-only cutover; this phase does
        not touch prod env.
  B     typed config.ts value read once at boot.   C  DB per-user setting.
F5 Naming / compatibility.
  A (R) Hard rename to governedAutomationPtyGate (gate name 'governed_automation_pty'); update the 3 call sites and
        tests; NO alias; keep the pure predicates humanOnlyRejectsActor / AUTOMATION_ACTORS unchanged.
  B     Keep humanOnlyPtyGate as a deprecated alias.
F6 Actor inference + spoof tests.
  A (R) Actor stays closure-resolved from server context and DispatchRequest stays actor-free. New negative
        tests: (i) an ext ask/work request carrying `source:'human'`/actor-like fields still gates as the external
        actor; (ii) the governed gate ignores any `source` property on the request object; (iii) the existing
        term.input spoof test stays green. List any attack surface I missed (esp. telegram/dispatch.ts ~161).
F7 Explicit exemptions.
  A (R) Record Telegram permission-answer keystrokes and term.attach_file as explicit, test-pinned
        human-initiated exemptions (door-guard allowlist with a justification each) instead of routing them
        through preflight (routing a permission answer through a quota check could wedge a session).
  B     Route the Telegram keystrokes through the human preflight chain.
F8 Fold-ins from the Phase 2 verification MINORs.
  A (R) In this phase's PR: make hub/test/human-interactive-flag-guard.test.ts CRLF-safe (split on /\r?\n/) and
        correct docs/usage-cost.md (it credits humanOnlyPtyGate for the wrong mechanism).
  B     Separate PR.

## 4. Required output (<= 120 lines)
For each fork F1..F8:  `Fn VERDICT: <option> | CONFIDENCE: high|med|low | <reasoning> | EVIDENCE: <file:line...>`
Then:
 REFUTATION: the strongest argument AGAINST my recommended package as a whole.
 MISSED FORKS: any decision a planner would otherwise have to guess (name it, give options, give your pick).
 RISKS: top 3 ways this design ships a hole (bypass, fail-open, spoof, dead code that rots).
 UNABLE-TO-VERIFY: anything you could not check, with the reason.
 GROUNDING: which of the section-0 files you actually read.
