---
phase: PTYCAP-03-governed-automation-guard
verified: 2026-10-13
status: passed
score: 4/4 success criteria, 4/4 plans' must_have truths verified
verdict: SHIP-WITH-NOTES
---

# Phase 3 (PTYCAP): Governed-Automation Guard - Verification

Branch `phase-ptycap-03-governed-automation-guard` (PR #505, not pushed/merged by verifier).
Independent goal-backward check; SUMMARY claims were not trusted. Every result below is from a
test run or grep executed in this session in `C:\Users\artic\GitHub\remo-code-gsd`.

## Success criteria

| SC | Verdict | Evidence |
|----|---------|----------|
| SC-1 `humanOnlyPtyGate` -> `governedAutomationPtyGate`; non-human admitted only with token cap + inject-rate ceiling + lifetime counter + kill switch | PASS (structurally) | `hub/src/dispatch/governed-pty.ts`: `governedAutomationPtyGate` (name `governed_automation_pty`), `GOVERNOR_ORDER = kill_switch, token_cap, inject_rate, lifetime_counter`, first block wins, thrown governor -> `governor_error:<name>` denial. Only `AUTOMATION_ACTORS` members eligible. kill_switch + lifetime_counter are fail-closed `governor_not_implemented:*` slots, so nothing is admitted in Phase 3 production (matches D-02 and the Phase-4 hand-off in ROADMAP). `grep humanOnlyPtyGate\|governedAutomationGate\|human_only_pty hub/src` = 0 hits (hard rename, no alias). Composed at `ask/dispatch.ts:137`, `work/dispatch.ts:298`, `telegram/dispatch.ts:172`. Preflight: `pty-preflight.ts:178-198` flag-first, then spend chain, then `activeGovernors()`. `governed-pty-gate.test.ts` 28 pass, `pty-preflight.test.ts` 46 pass. |
| SC-2 Actor server-inferred; spoofed `source` cannot impersonate human (negative test) | PASS | `ws-client-pty-preflight.test.ts` (24 pass) includes `term.input carrying source:scheduler + actor:orchestrator-background is preflighted as human and forwarded without the extra keys`. `term-relay-human-guard.test.ts` 3 pass (agent-socket spoof, unchanged). `telegram/dispatch.ts:82` `source` is required (compile time) and a missing source at runtime is refused on a PTY session (`telegram-dispatch.test.ts` 6 pass, `telegram-human-only-guard.test.ts` 6 pass); sole production caller passes literal `"human"` at `api/telegram-webhook.ts:399`. `pty-door-guard.test.ts` (22 pass) pins `DispatchRequest` has no source/actor member and nothing under `hub/src/dispatch` reads one. |
| SC-3 Flag-gated, default OFF, true no-op when off | PASS | `REMO_GOVERNED_AUTOMATION_PTY` read at call time, only `1\|true\|yes\|on` enables; literal appears only in `governed-pty.ts` (grep + door pin). `governed-pty-gate.test.ts` OFF==legacy differential matrix (decision + reason, resolver called once, zero governors). `pty-preflight.test.ts`: flag OFF returns `automation_blocked_on_pty:automation` before any DB gate (throwing threshold gate does not change the result). Non-PTY runner short-circuits before the flag. |
| SC-4 No-API-key + argv-allowlist guard tests pass unchanged | PASS | `git diff --name-only origin/main...HEAD -- supervisor/` = empty (0 files). Ran individually: `no-api-key-no-streamjson-pty` 5 pass, `no-apikey-fallback-guard` 7 pass, `default-backend-selector` 22 pass, `codex-fallback-no-apikey` 3 pass, `no-legacy-agent-spawn` 1 pass; all 0 fail. |

Hard invariants: no API key on PTY path (SC-4, intact); actor server-inferred (SC-2); no spend outside gate chain
(`token-cap-coverage.test.ts` 3 pass, `token-cap-gate-fires.test.ts` 8 pass; no `gates: [` literal in `governed-pty.ts`;
human chain contains no governor, tested in `pty-preflight.test.ts`).

## Plan must_have truths

| Plan | Verdict | Evidence |
|------|---------|----------|
| 03-01 (8 truths: OFF==legacy, ineligible actors denied even ON, production list blocks at kill_switch, fixed order, unconfigured rules, non-PTY ok / throw -> deny, old name gone, single-param + test-only DI) | PASS | Code read of `governed-pty.ts` matches each truth line by line (single `resolve` param; DI only via `_setGovernorsForTests`/`_resetGovernorsForTests`; `token_cap` uses `isDailyTokenCapEnforced`, `inject_rate` blocks non-finite/<=0). `governed-pty-gate.test.ts` 28/0. `human-only-guard`, `ext-ask-gates`, `ext-work-containment` 8/12/18 pass. Prohibitions (alias, public param, `gates: [`) all hold by grep. |
| 03-02 (7 truths: OFF block before DB gates, ON runs spend chain then governors, production list -> kill_switch block, throw/timeout typed errors, human chain governor-free, scanned literal unchanged, CRLF-safe flag guard) | PASS | `pty-preflight.ts:35,178-198`; `humanInteractive` line at 186 pinned by `human-interactive-flag-guard.test.ts` 2 pass; `pty-preflight.test.ts` 46/0; `token-cap-coverage` green. |
| 03-03 (8 truths: Telegram source required, ws/client strips client keys, agent spoof test unchanged, two-emitter allowlist with self-check, supervisor canary, caller pins, flag/DI pins, two exemptions pinned) | PASS | `pty-door-guard.test.ts` 22/0 (tests: emitter allowlist + non-vacuous self-check, `user_message`/`permission_response` branches reference no PTY write, actor/preflight/inject/dispatchToSession caller pins, flag/DI pins). `ws-client-pty-preflight` 24/0. No file under `supervisor/` edited. |
| 03-04 (9 truths: docs section, Phase-2 claim corrected, supersession test, CLAUDE.md flag, old name gone from docs, OpenAPI, ROADMAP Phase-4 hand-off, baseline, supervisor guards) | PASS | `docs/usage-cost.md:498` "PTYCAP Phase 3" section; `CLAUDE.md:280,401,462` flag documented default OFF, "formerly" note only. `docs-supersession.test.ts` 4 pass. `bun run docs:sync` -> no git diff (no drift). ROADMAP diff: only the Phase-4 "Hand-off from Phase 3" line added; SC text of Phases 3/4 unchanged. `bun run check-baseline` (repo root): `pass=2379 skip=259 fail=0`, "OK - within tolerance" (skip <= 260). No production value of the flag set/documented. |

## Other checks

- `mount-order.test.ts` 21 pass (unchanged invariant).
- Branch contains no `supervisor/` change (no supervisor MSI required).

## Notes (non-blocking)

1. Bookkeeping stale: `.planning/ROADMAP.md` line 33 still shows Phase 3 as `[ ]` and the progress table says `In Progress (2/4 plans)`, although all 4 plans are executed. Update at phase close-out (the plan prohibited editing SC text only, not status).
2. `.planning/architecture/SESSION-ASK-API-SPEC.md` lines 224 and 321 still name `humanOnlyPtyGate` as present-tense history (lines 232/295 are rename arrows). Outside the plan's docs/CLAUDE.md scope; cosmetic.
3. SC-1 is met structurally by design: with the flag ON, Phase 3 production admits nothing because `kill_switch` and `lifetime_counter` are fail-closed placeholders. Real admission is Phase 4 (hand-off recorded in ROADMAP). Verified that this is explicit and tested, not hidden.
4. Honest scope (documented in `governed-pty.ts` header and usage-cost.md): the ask/work/telegram gate call sites are not the PTY door (they send `user_message` to the stream-json runner); the door is the preflight plus the structural pins. Verified consistent with the pins.

## Ship verdict: SHIP-WITH-NOTES
