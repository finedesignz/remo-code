---
phase: PTYCAP-01-pty-token-accounting
reviewed: 2026-07-28T00:00:00Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - .woodpecker/qc.yaml
  - docs/usage-cost.md
  - hub/src/db/schema.sql
  - hub/src/db/token-usage-dal.ts
  - hub/src/ws/agent-protocol.ts
  - hub/src/ws/agent.ts
  - hub/test/e2e/schema-double-apply.e2e.test.ts
  - hub/test/no-hub-side-transcript-fs.test.ts
  - hub/test/pty-usage-midflight-visibility.test.ts
  - hub/test/token-usage-runner-type.test.ts
  - hub/test/usage-event-handler.test.ts
  - supervisor/src/runners/session-bridge.ts
  - supervisor/src/runners/types.ts
  - supervisor/src/usage/pty-transcript-tail.ts
  - supervisor/src/usage/pty-usage-emitter.ts
  - supervisor/test/pty-usage-path-containment.test.ts
  - supervisor/test/pty-usage-tail.test.ts
  - tools/regression-baseline.json
  - hub/src/telegram/transcript/tail.ts
findings:
  critical: 0
  warning: 1
  info: 1
  total: 2
status: issues_found
---

# Phase PTYCAP-01: Code Review Report (Iteration 2 — Fix Re-Review)

**Reviewed:** 2026-07-28
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found (prior CRITICAL and 2 of 3 prior WARNINGs confirmed genuinely fixed; 1
new low-severity WARNING + 1 INFO found on this pass; prior WR-03 remains open by design)

## Summary

This is iteration 2 — a fix-verification pass over PTYCAP Phase 1 (PTY-interactive token
accounting, `runner_type` split). Rather than trusting the fix report, each claimed fix was
independently re-derived against the current tree, and the git history was checked to confirm
no unrelated changes rode along (`git log d809964..HEAD` shows exactly the three claimed fix
commits: `7ed137f`, `bf84802`, `ad4b463`).

- **CR-01 (prior CRITICAL — `pty-usage-path-containment.test.ts` never ran in CI): CONFIRMED FIXED.**
  `.woodpecker/qc.yaml` line 46 now runs
  `bun test supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts`.
  Ran it directly against this tree: **23 pass / 0 fail** (17 + 6, matching
  `tools/regression-baseline.json`'s `_skip_note_ptycap` narrative, which was also corrected in
  the same commit to stop implying CI coverage it didn't have). The ASVS V4
  path-traversal/symlink-escape negative test is now genuinely exercised by CI, not just present
  in the repo.

- **WR-01 (prior — async offset-init race in `tailJsonl`): CONFIRMED FIXED, correctly, in both
  files.** Diffed commit `bf84802` and read both resulting files in full:
  `supervisor/src/usage/pty-transcript-tail.ts` and `hub/src/telegram/transcript/tail.ts` are
  character-for-character equivalent apart from the file-header comment and one `export` keyword
  (see IN-01 below) — the port genuinely happened to both copies as the commit message claims. The
  fix correctly wraps the initial replay in an `initOffset()` async function and defers arming
  `fs.watch` + the poll timer until it resolves (`void initOffset().then(() => { ...arm... })`),
  closing the exact race described in the commit message: a `fromStart:false` resumed transcript
  whose recent mtime is caused by the CLI's own in-flight append could previously have a `fs.watch`
  notification fire `pump()` while `offset` was still `0`, replaying the file's entire history as
  new usage.

  Checked specifically for regressions the fix could plausibly introduce, per this review's brief:
  - **No new unhandled-rejection / deadlock risk.** `void initOffset().then(...)` has no
    `.catch()`, but this is *unchanged* from the pre-fix code, which did `void pump()` with the
    same absence of a catch (confirmed via `git show bf84802`) — `pump()`'s only internal
    try/catch covers the `stat()` failure; a thrown `fsOpen`/`read`/`close` error was already an
    unhandled rejection before this fix and still is after it. Not a regression introduced by
    WR-01, and no lock/mutex was added that could deadlock — `close()` correctly checks `closed`
    inside the deferred `.then()` before arming, so calling `close()` before `initOffset()`
    resolves cannot leak a watcher/timer.
  - **No behavior change for the `fromStart:true`/default path** beyond the intended fix: the
    watcher/poll timer now wait for the initial `pump()` replay to finish before arming
    (previously they armed synchronously alongside a fire-and-forget `pump()`). This is a strict
    correctness improvement, not a regression — a same-tick `fs.watch` notification during the old
    initial read could only ever hit `pump()`'s pre-existing `reading` guard and return early, so
    no double-read was possible under the old code either; the new code just removes the race
    window entirely rather than changing observable behavior.
  - Ran `hub/test/transcript-adapter-claude.test.ts` + `hub/test/transcript-adapter-codex.test.ts`
    (the two hub-side callers of the ported `tail.ts`) as a regression check on the hub copy: 16
    pass / 0 fail.

- **WR-02 (prior — docs misattributed the `runner_type` default to zod): CONFIRMED FIXED.**
  `docs/usage-cost.md` now reads "the hub's `usage_event` handler falls back to `'stream-json'`
  (`msg.runner_type ?? 'stream-json'`) ... the zod field itself stays `undefined` when absent" —
  verified this is exactly what `hub/src/ws/agent.ts:791` does
  (`runnerType: msg.runner_type ?? 'stream-json'`), and that
  `hub/src/ws/agent-protocol.ts`'s `AgentUsageEvent.runner_type` is a bare
  `z.enum([...]).optional()` with no `.default(...)`, so the fallback genuinely lives in the
  handler, not zod, matching the corrected doc wording and the existing
  `token-usage-runner-type.test.ts` assertion (`expect(parsed.runner_type).toBeUndefined()`).

- **WR-03 (prior — real-timer test flakiness): left open, as the prior review explicitly marked
  it non-blocking.** No new instance of this pattern was introduced elsewhere in this file set on
  this pass. Both affected test files (`supervisor/test/pty-usage-tail.test.ts`,
  `supervisor/test/pty-usage-path-containment.test.ts`) still pass reliably in this run (23/23),
  so it is not re-raised as a fresh finding — noted here only for traceability.

Beyond re-verifying the three fixes, this pass did a full standard-depth read of every file
currently in scope (not just the diff), including `schema.sql`'s `token_usage`/`token_usage_daily`
DDL and CHECK constraint (matches the DAL and the doc exactly), the full `AgentUsageEvent`/
`AgentInbound` zod contract, `hub/src/ws/agent.ts`'s complete `usage_event` handler (including the
SDK-vs-estimated cost branch, and confirming that PTY-tagged frames actually reach that handler —
`SessionBridge` authenticates each session on its own `role:'agent'` socket, distinct from the
multiplexed `role:'supervisor'` socket used by `SupervisorClient`/`supervisor.hello`, so a
`usage_event` from a PTY session is never mis-routed into `handleSupervisorMessage`, which has no
case for it and would silently drop it), `PtyUsageEmitter`'s locate/pin/dedupe lifecycle
(`session-bridge.ts`, `pty-usage-emitter.ts`), and the full DAL/e2e/unit test suite. No new
BLOCKER/CRITICAL findings. One new low-severity WARNING and one INFO item follow.

## Warnings

### WR-04: `no-hub-side-transcript-fs.test.ts`'s guard regex is narrower than its stated goal

**File:** `hub/test/no-hub-side-transcript-fs.test.ts:75` (`const HOMEDIR_IDENTIFIER = /\bhomedir\b/`)
**Issue:** The canary's own docstring says it "fails any FUTURE `hub/src/**` module that calls
Node's home-directory resolver," but the regex only matches the literal word `homedir`. It
correctly catches `os.homedir()` (contains that word), but a future hub-side module that derives a
home-directory path via `process.env.HOME` or `process.env.USERPROFILE` directly — rather than
`os.homedir()` — would silently pass this guard while reproducing exactly the Pitfall-1 failure
mode the test exists to prevent (works in local dev against a real `$HOME`, silently does nothing
in the Coolify container where those env vars aren't the CLI's real home). This isn't hypothetical:
`process.env.HOME`/`process.env.USERPROFILE` are precisely the two variables this same phase's own
supervisor-side tests use to redirect home-directory resolution
(`supervisor/test/pty-usage-tail.test.ts`'s `makeHome()`), so the pattern is already live in this
codebase — just not yet attempted on the hub side.
**Fix:** Broaden the pattern to also catch the common escape hatches, e.g.:
```ts
const HOMEDIR_IDENTIFIER = /\bhomedir\b|process\.env\.(HOME|USERPROFILE)\b/
```
Not a blocker for this phase (no hub-side module currently does this — the two-test structural
proof is otherwise sound and non-vacuous), but worth tightening before the allowlist is ever asked
to grow, since a bypass here reproduces the exact production failure mode the guard was built for.

## Info

### IN-01: `POLL_INTERVAL_MS` export inconsistency between the ported file and its declared source of truth

**File:** `supervisor/src/usage/pty-transcript-tail.ts:22` vs `hub/src/telegram/transcript/tail.ts:16`
**Issue:** The supervisor copy exports `POLL_INTERVAL_MS` (`export const POLL_INTERVAL_MS = 500`)
while the hub original keeps it module-private (`const POLL_INTERVAL_MS = 500`). The supervisor
file's own header comment claims this is a "VERBATIM PORT... The ONLY difference is the module
home," but this `export` is a second, small divergence. Harmless — grepped the supervisor package
and nothing imports the export — but worth flagging since the header comment's "verbatim" claim
isn't quite exact, and a future side-by-side diff against the hub original would flag this line as
a spurious difference.
**Fix:** Either drop the `export` to match the hub original exactly, or, if the export is
intentional (e.g. as a future test seam), update the header comment to note the one deliberate
divergence rather than claiming byte-parity.

---

_Reviewed: 2026-07-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
