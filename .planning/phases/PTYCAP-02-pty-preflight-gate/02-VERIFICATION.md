---
phase: PTYCAP-02-pty-preflight-gate
verified: 2026-10-07
status: passed
score: 3/3 success criteria verified (0 BLOCKER, 0 MAJOR, 3 MINOR gaps)
verifier: independent goal-backward verification (not derived from 02-01-SUMMARY.md)
merged_as: PR #493 (commit 10dcc44)
---

# PTYCAP Phase 2 - PTY Pre-Flight Gate - Verification

**Goal:** "No programmatic turn reaches the PTY without passing the full gate chain."

Worktree: C:\Users\artic\GitHub\remo-code-gsd (branch phase-ptycap-03-governed-automation-guard).
`hub/src/dispatch/pty-preflight.ts` and `hub/src/ws/client.ts` are byte-identical (index) to the
merge commit 10dcc44 (`git diff 10dcc44 HEAD` empty for both).

## Success criteria

| SC | Criterion | Verdict | Evidence |
|----|-----------|---------|----------|
| SC-1 | A programmatic write to the PTY passes [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate] or does not happen | PASS | `hub/src/dispatch/pty-preflight.ts:35-37` `ptyPreflightDispatchConfig.gates = [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]` (exact ROADMAP order); `PTY_AUTOMATION_TURN_GATES` is the same array object (line ~40). `runChain` (line ~155) iterates it first-block-wins; fail-closed on throw (`pty_preflight_error`) and 5s timeout (`pty_preflight_timeout`) in `checkPtyTurnPreflight`. Test `pty-preflight.test.ts` "SC-1: automation chain is EXACTLY the ROADMAP order", "non-human over inject-rate IS blocked", "first block wins", fail-closed tests: all pass. Structural half ("or it does not happen"): no hub path emits a PTY write for a non-human actor today (see audit below), so the chain is a built+proven seam, enforced vacuously-true until Phase 3 opens a door. |
| SC-2 | token-cap-coverage.test.ts extended to cover the PTY path | PASS | `hub/test/token-cap-coverage.test.ts:87-90` adds `'dispatch/pty-preflight.ts'` to the known-dispatchers list; the scan (bracket-balanced `gates: [` finder) parses the literal in pty-preflight.ts and the "EVERY gates[] list carries dailyTokenCapGate AND dailyCostCapGate" test passes. `pty-preflight.test.ts` "SC-2: scanned literal IS the array that runs" proves it is not decorative. |
| SC-3 | Human turns unaffected: never gated by an inject-rate ceiling | PASS | `PTY_HUMAN_TURN_GATES = automation.filter(g => g !== sessionInjectRateGate)` (pty-preflight.ts ~43); `runChain` selects it when `actor==='human'` and sets `humanInteractive: true`, read only at `gates.ts:139-140` (programmatic-credit halt exemption; cost/token caps still apply). `client.ts:279-295` calls `checkPtyTurnPreflight({actor:'human'})` (hard-coded, server-inferred from authenticated cookie connection) only when `classifyPtyInput(...).submit`. Tests: "SC-3 (the absolute): human NEVER blocked by inject-rate ceiling", "human over cost/token/threshold IS blocked", "halt exemption never exempts from daily cost cap" pass. Trust boundary pinned by `human-interactive-flag-guard.test.ts` (see MINOR-1). |

## Implementation claims (checked in code, not SUMMARY)

- Wiring in `hub/src/ws/client.ts` `term.input` relay: lines 262-295. Submit classification (`classifyPtyInput`, pty-preflight.ts ~95-150): CR/LF, U+0085/U+2028/U+2029, C1 CSI/SS3, any ESC sequence not on `SAFE_ESCAPES`, OSC/DCS/SOS/PM/APC introducers, `ESC E`, invalid base64/UTF-8 -> submit (fail closed). Plain typing, Ctrl-C, Esc, arrows, Alt+printable -> not gated. Split escapes carried per session in `ptyEscTail` (client.ts:235). VERIFIED.
- Refusal path sends `send_refused` on the term channel (client.ts:288-293); write-chain ordering and single-writer re-check after the await (client.ts:296-327). VERIFIED.
- `docs/usage-cost.md` section "PTYCAP Phase 2" present (line 346) with tests list (line 470); matches code (see MINOR-2 for one over-claim).
- Hard invariants: no provider API key on PTY path - supervisor guard tests pass (below); caps are in tokens (`dailyTokenCapGate`, 4 buckets, unchanged); PR #493 touches no `schema.sql` / migration file (`git show --name-only` has no sql/schema/migrat paths) - additive DDL invariant trivially held.

## Tests run (one file at a time, this worktree)

| File | Result |
|------|--------|
| hub/test/pty-preflight.test.ts | 33 pass / 0 fail |
| hub/test/ws-client-pty-preflight.test.ts | 22 pass / 0 fail |
| hub/test/token-cap-coverage.test.ts | 3 pass / 0 fail |
| hub/test/human-interactive-flag-guard.test.ts | 1 pass / 1 FAIL (CRLF checkout artifact, MINOR-1) |
| web/test/term-refusal.test.ts | 4 pass / 0 fail |
| supervisor/test/no-api-key-no-streamjson-pty.test.ts | 5 pass / 0 fail |
| supervisor/test/no-apikey-fallback-guard.test.ts | 7 pass / 0 fail |
| supervisor/test/default-backend-selector.test.ts | 22 pass / 0 fail |

Not run: the full check-baseline suite (out of scope for a single-question verification).

## Audit: can any NON-human actor reach a PTY without pty-preflight?

Method: grep of every hub emitter of `term.*` frames and every supervisor consumer.

- Supervisor: the only inputs that write the PTY are `term.input` and `term.attach_file`
  (`supervisor/src/runners/session-bridge.ts:398-441`, flag `REMO_PTY_INTERACTIVE=1`). `user_message`
  (what orchestrator inject, scheduler senders, error-capture, feedback, revanote, ext ask/work, and
  Telegram free-text all emit via the dispatch pipeline) goes to `ensureRunner()` = the stream-json
  `ClaudeRunner` (session-bridge.ts:444-465), never the PTY.
- Hub emitters of `term.input`: exactly two. (1) `ws/client.ts` relay - authenticated `/ws/client`
  cookie connection, actor hard-coded human, preflighted on every submit. (2)
  `telegram/transcript/pty-inject.ts:34` `injectPtyKeystroke`, called only from
  `api/telegram-webhook.ts:556` for a human's Telegram permission-button tap; NOT preflighted (see
  MINOR-3). `term.attach_file` is relayed by client.ts only, types a path with no Enter, and is
  deliberately unchecked (tested). `/ws/agent` rejects inbound `term.input` (ws/agent.ts ~221).
- Conclusion: the claim "no admission path yet exists for a non-human actor to reach a PTY" is TRUE in
  effect, but for a different reason than the doc states (MINOR-2).

## Gaps

| ID | Severity | Gap | Evidence | Proposed minimal fix |
|----|----------|-----|----------|----------------------|
| MINOR-1 | MINOR | `human-interactive-flag-guard.test.ts` second test fails on a Windows checkout with `core.autocrlf=true` (worktree CRLF; index is LF). The test splits source on `'\n'`, so the matched line carries a trailing `\r`. Passes on Linux CI, so it is not a CI/prod defect; local `bun test` on Windows reports a false red. | `git ls-files --eol`: `i/lf w/crlf`; assertion diff shows only the trailing CR. | Split on `/\r?\n/` in that test (one-line change). |
| MINOR-2 | MINOR | Doc/ROADMAP over-claim of mechanism: `docs/usage-cost.md` (~line 370) says `humanOnlyPtyGate`/`humanOnlyRejectsActor` "reject every automation source before a write ever reaches a pty-interactive session". Those gates key on `sessions.runner_type`, which defaults to `stream-json` and which client.ts:268-270 itself calls dead in prod. The real reason automation cannot reach the PTY is structural (supervisor routes `user_message` to the stream-json runner; PTY takes only `term.*`). Phase 3 must not rely on the runner_type gate as the door. | pty-preflight consumers: client.ts:216-217; session-bridge.ts:444. | Reword the doc sentence to name the structural reason and flag the runner_type caveat for Phase 3. |
| MINOR-3 | MINOR | Telegram permission-answer keystrokes (`injectPtyKeystroke`) write `term.input` to the PTY - often digit/y/n plus Enter - with no pty-preflight. It is human-initiated and documented as exempt ("answering a prompt is not a new turn"), and lies on a path the Phase 2 scope did not name, but it is a hub-side PTY write that bypasses the new chokepoint. Phase 3's governed-automation guard should account for it. | pty-inject.ts:34-45; telegram-webhook.ts:556. | No change required for Phase 2; record as an explicit exemption in the Phase 3 plan (or route through `checkPtyTurnPreflight(actor:'human')` if answering a permission prompt after the cap should be refused). |

No BLOCKER or MAJOR gaps. Phase goal is achieved: the full gate chain exists in the exact ROADMAP order, is single-sourced with the coverage scan, fails closed, is wired on the only human PTY write path that can submit a prompt, and no programmatic path to the PTY exists to bypass it.
