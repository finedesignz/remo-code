# 02-01-SUMMARY — PTY pre-flight gate

## Status: Done (all 3 success criteria met)

## What was built

**`hub/src/dispatch/pty-preflight.ts`** (new) — the single-source-of-truth PTY
pre-flight gate chain:

- `PTY_AUTOMATION_TURN_GATES` = `[thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]`
  — SC-1's exact order.
- `PTY_HUMAN_TURN_GATES` = `PTY_AUTOMATION_TURN_GATES.slice(0, -1)` — the same
  spend ceilings, minus the inject-rate ceiling (SC-3). A strict prefix, never
  a hand-duplicated array, so the two chains cannot silently drift apart.
- `ptyPreflightDispatchConfig.gates` — the automation chain re-written with the
  gate identifiers inline, so `hub/test/token-cap-coverage.test.ts`'s
  text-based `gates: [ ... ]` scan discovers this file automatically (SC-2).
- `checkPtyTurnPreflight({ userId, sessionId, actor })` — runs the human chain
  for `actor === 'human'`, the full automation chain otherwise; first-block-
  wins (matches `dispatch()`'s own IR-2 semantics).

**`hub/src/ws/client.ts`** (modified) — the `term.input`/`term.attach_file`
write-turn branch now calls `checkPtyTurnPreflight({ actor: 'human', userId, sessionId })`
immediately after the existing human-only guard, but ONLY when
`turn-lock.holder(sessionId) === null` (this write would start a fresh turn —
not on every keystroke of an already-held turn). A failing check drops the
frame (never forwarded, never acquires the turn lock) and sends
`{ type: 'send_refused', session_id, reason }` back to the sender.

**`hub/test/token-cap-coverage.test.ts`** (modified) — the "known dispatchers"
list now names `dispatch/pty-preflight.ts` explicitly (SC-2).

**`hub/test/term-relay-auth.test.ts` / `hub/test/term-relay-human-guard.test.ts`**
(modified) — stub `checkPtyTurnPreflight` to `{ ok: true }` so these
pre-existing tests' own concerns (per-session authz / the human-only guard)
don't newly require a live Postgres connection now that every pty-interactive
`term.input` turn calls into the new module.

**`docs/usage-cost.md`** (modified) — new "PTYCAP Phase 2" section documenting
the gate chain, the call site, and what was deliberately deferred.

**`.planning/ROADMAP.md`** (modified) — Phase 2 checkbox + progress table
marked Done, with a status note pointing here.

**`tools/regression-baseline.json`** (modified) — re-measured and updated; see
"Test evidence" below.

## Why the scope reads narrower than "gate the PTY path" sounds

Before writing any code, I audited every existing write route into a PTY
session (`ws/client.ts` term.input, Telegram keystroke injection, Telegram
plain-text dispatch, ask/work dispatch). Finding: `humanOnlyPtyGate` /
`humanOnlyRejectsActor` (built in Phase 1's prerequisite work) already reject
EVERY automation actor before a write reaches a pty-interactive session — as
of this phase starting, no automation write to a PTY was possible at all, by
construction. So "a programmatic write passes the full chain or it does not
happen" was ALREADY true in the strongest sense (it never happens) for every
existing caller.

That reframed the real work into two concrete pieces, both delivered:

1. **Build the reusable chain now, proven correct by test, so Phase 3 has a
   tested seam** rather than inventing gate wiring at the same moment it
   relaxes the human-only invariant — the ROADMAP explicitly forbids
   parallelizing Phase 3 ahead of Phase 2 for exactly this reason.
2. **Close the one REAL, present-day gap**: `docs/usage-cost.md`'s own Phase 1
   section says outright that "gating the interactive PTY path against the
   daily cost/token caps is milestone PTYCAP's Phase 2, not this phase." The
   web xterm `term.input` relay had NEVER been checked against
   `dailyCostCapGate`/`dailyTokenCapGate`/`thresholdGate` — only a license
   check + the human-only guard + the turn lock sat in front of it. That gap
   is now closed for human turns too (SC-3 exempts only the inject-rate
   ceiling, not the spend caps).

## What was deliberately deferred (and why)

- **`hub/src/ws/client.ts`'s `send_message` handler (the stream-json
  `ChatSurface` manual-chat path) is still not gated by `dailyCostCapGate`/
  `dailyTokenCapGate`** — only the Claude usage threshold gate runs there.
  This is a **pre-existing gap that predates PTYCAP** and is outside PTYCAP's
  scope (the milestone exists specifically because the orchestrator is going
  to drive the *interactive PTY*, not `ChatSurface`). Documented in
  `docs/usage-cost.md` rather than silently left unmentioned; not fixed here
  to keep this PR's blast radius to the PTY path the milestone actually names.
- **Telegram's permission/question-response keystroke injection
  (`injectPtyKeystroke`) is not preflight-checked.** It answers an EXISTING
  pending prompt raised by an already in-flight (already-gated) turn;
  `turn-lock.ts`'s own documented invariant treats a response as exempt from
  turn acquisition because it completes the holder's turn rather than
  starting a new one. Gating it would be gating the wrong event — it spends
  nothing new.
- **Phase 3 (`governedAutomationPtyGate`) is not built here.** This phase only
  proves the chain that a future governed-automation admission will be
  required to pass; no admission path was added.

None of these are silent — each is called out here and in `docs/usage-cost.md`.

## Test evidence

New tests, both fully passing, zero DB dependency:

- `hub/test/pty-preflight.test.ts` — 13 tests / 21 assertions. Covers: chain
  shape/order (SC-1), the human chain never containing `sessionInjectRateGate`
  and being a strict prefix of the automation chain (SC-3), every gate's
  individual block/allow behavior for both actor classes, and first-block-wins
  ordering (a human/automation actor with BOTH the threshold gate and a later
  gate failing gets the threshold's reason, proving order is enforced, not
  just membership).
- `hub/test/ws-client-pty-preflight.test.ts` — 6 tests / 13 assertions. Covers:
  a fresh turn is checked with `actor:'human'` and the connection's own
  `userId`/`sessionId` (never a frame-supplied value); a passing check
  forwards unchanged; a failing check drops the frame, sends `send_refused`
  with the gate's reason, and never grants the turn lock; the check runs
  EXACTLY ONCE per turn (a second keystroke from the same holder does not
  re-invoke it, and both keystrokes still forward); after the turn completes
  (`release`), the next turn is checked again; a non-pty-interactive session
  is never checked at all.

Full-suite regression evidence (`bun run check-baseline`, bare checkout, no
`REMO_E2E_DB_URL`, no `DATABASE_URL` — the floor configuration):

```
BEFORE (this branch, before this phase's commits): pass=2157 skip=259 fail=0 total=2416
AFTER  (with this phase's changes):                pass=2176 skip=259 fail=0 total=2435
```

+19 passes (exactly the two new test files' counts), **zero new skips**, zero
failures. `tools/regression-baseline.json` re-measured and updated in the same
commit per its own documented convention (see its new
`_skip_note_ptycap_phase2` entry, which also names the +98 pass / +4 skip of
pre-existing undocumented drift found between the last recorded snapshot and
this branch's starting point — none of it attributable to this phase, called
out for an honest accounting rather than silently absorbed).

Other checks run clean:

- `bun run schema-lint` — OK (this phase touches no `schema.sql`).
- `bunx tsc --noEmit -p hub/tsconfig.json` — 427 errors, all pre-existing
  (TypeScript 5.9→7.0.2 baseline drift, unrelated to this phase); zero errors
  in any file this phase touched or added.
- No route changed, so `bun run docs:sync` is a no-op for this phase.
- Re-ran the two updated pre-existing guard tests
  (`term-relay-auth.test.ts`, `term-relay-human-guard.test.ts`) plus
  `token-cap-coverage.test.ts` and `token-cap-gate-fires.test.ts` individually
  — all green.

## Files touched

- `hub/src/dispatch/pty-preflight.ts` (new)
- `hub/src/ws/client.ts`
- `hub/test/pty-preflight.test.ts` (new)
- `hub/test/ws-client-pty-preflight.test.ts` (new)
- `hub/test/token-cap-coverage.test.ts`
- `hub/test/term-relay-auth.test.ts`
- `hub/test/term-relay-human-guard.test.ts`
- `docs/usage-cost.md`
- `.planning/ROADMAP.md`
- `tools/regression-baseline.json`
- `.planning/phases/PTYCAP-02-pty-preflight-gate/02-01-PLAN.md` (new)
- `.planning/phases/PTYCAP-02-pty-preflight-gate/02-01-SUMMARY.md` (new, this file)
