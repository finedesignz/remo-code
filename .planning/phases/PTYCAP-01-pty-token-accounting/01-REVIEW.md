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
findings:
  critical: 1
  warning: 3
  info: 0
  total: 4
status: issues_found
---

# Phase PTYCAP-01: Code Review Report

**Reviewed:** 2026-07-28
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

Reviewed the PTYCAP Phase 1 PTY-interactive token-accounting path: schema (`token_usage.runner_type`
+ CHECK constraint), the DAL split (`recordTokenUsage`/`getTodayTokenTotalByRunner`), the WS
protocol addition (`AgentUsageEvent.runner_type`), the hub's `usage_event` handler, the new
supervisor-side `PtyUsageEmitter`/`tailJsonl` capture path, and the CI wiring. The core design is
sound and matches the four documented Phase-1 decisions in `docs/usage-cost.md` (unsplit daily
rollup, unwired `transcript_path`, claude-only gate, `cost_source:'estimated'` always). The
specific security surfaces called out for verification — the `runner_type` zod field-name contract
(confirmed exact match across `agent-protocol.ts` / `types.ts` / `pty-usage-emitter.ts`, and a
round-trip test proves zod would catch a rename-typo regression), and the hub-side-filesystem-read
guard (`no-hub-side-transcript-fs.test.ts` is non-vacuous and correctly scoped) — both check out.

One real gap: the path-traversal/symlink-escape negative test for the new PTY tailer
(`pty-usage-path-containment.test.ts`) is never actually executed by any CI gate, despite the
qc.yaml comment explicitly stating a belt-and-suspenders step was added *because* `check-baseline`
misses `supervisor/test/**`. That step only runs the sibling `pty-usage-tail.test.ts`. This is
exactly the kind of "test exists, but nothing runs it" gap the adversarial stance is meant to
surface — the containment guard could regress silently. Additionally, a subtle async race
(inherited, ported verbatim from the hub's transcript tailer) in `tailJsonl`'s `fromStart:false`
path could replay a resumed transcript's historical turns as new PTY usage under an unlucky
timing window.

## Critical Issues

### CR-01: The PTY usage-tailer's path-traversal/symlink-escape negative test never runs in CI

**File:** `.woodpecker/qc.yaml:44-46`
**Issue:** `check-baseline` walks `hub/test` only, so `supervisor/test/**` is invisible to it. The
qc.yaml comment on line 45 (`# check-baseline covers hub/test only, so this SC-1 proof needs its
own step here.`) acknowledges this gap and adds exactly one explicit step:

```yaml
- bun run check-baseline
# check-baseline covers hub/test only, so this SC-1 proof needs its own step here.
- bun test supervisor/test/pty-usage-tail.test.ts
- bun run migration-verify
```

but `supervisor/test/pty-usage-path-containment.test.ts` — the ASVS V4 negative test this phase
added specifically to prove the emitter refuses a relative/traversal/NUL-byte `projectDir` and a
located transcript whose real path escapes the projects base (per `docs/usage-cost.md`'s own
"Tests (PTYCAP Phase 1)" list and the file's own header comment) — is not listed anywhere: not in
`check-baseline`, not in this explicit qc.yaml step, and `tools/regression-baseline.json`'s own
narrative claims "supervisor/test/pty-usage-path-containment.test.ts, 6 passing" as evidence of
coverage, which is misleading — those 6 tests only pass when someone runs them manually/locally.
Confirmed via repo-wide grep: no `.yaml`/`.yml`/`package.json` script anywhere references
`pty-usage-path-containment`.

Net effect: a future regression to `PtyUsageEmitter.start()`'s reuse of `resolveSessionDir` /
`realPathContained` (e.g. someone "simplifies" the containment check, or a refactor accidentally
drops the `realPathContained(pinnedPath, projectsBase())` guard in `pinAndTail`) would break the
security-relevant refusal behavior, and CI (`.woodpecker/qc.yaml`) would report green.

**Fix:**
```yaml
      - bun run check-baseline
      # check-baseline covers hub/test only, so these SC-1/ASVS-V4 proofs need their own step here.
      - bun test supervisor/test/pty-usage-tail.test.ts supervisor/test/pty-usage-path-containment.test.ts
      - bun run migration-verify
```
Also correct the `tools/regression-baseline.json` narrative note (`_skip_note_ptycap`) so it no
longer implies this file is CI-gated when it currently is not.

## Warnings

### WR-01: Async race in the ported `tailJsonl` can replay a resumed transcript's history as new PTY usage

**File:** `supervisor/src/usage/pty-transcript-tail.ts:90-114`
**Issue:** When `fromStart === false` (the mode `PtyUsageEmitter` always uses — see
`pty-usage-emitter.ts:230`), the initial offset is set **asynchronously**:

```ts
if (opts?.fromStart === false) {
  void stat(path).then((s) => { offset = s.size })
  ...
}
...
watcher = watch(path, () => { void pump() })
...
pollTimer = setInterval(() => { void pump() }, POLL_INTERVAL_MS)
```

`watcher`/`pollTimer` are armed synchronously immediately after, while `offset` is still its
initialized value of `0` until the `stat()` promise resolves. `PtyUsageEmitter.pinAndTail()` is
only invoked once `resolveTranscriptPath()` has located a file whose `mtimeMs` is within
`LOCATE_MTIME_SLACK_MS` (2s) of "now" — i.e. a file the CLI touched *very recently*. For a brand
new transcript this race is harmless (offset=0 is the correct start point either way). But for a
**resumed** session reusing an existing transcript with substantial prior turns (the codebase's
own "Session resume by matching `project_dir`" behavior, and Claude Code CLI append-to-same-file
resume), the CLI's own append is what makes the file's mtime recent enough to be discovered in the
first place — meaning a fresh write is landing on the file right as `pinAndTail`/`tailJsonl` starts.
If `fs.watch`'s change notification fires before the `stat()` promise in the `then()` callback
resolves, `pump()` will read from `offset=0` and treat **every historical turn already in the
file** as a brand-new record, emitting mis-attributed `usage_event`s for token spend that may be
hours/days old (the uuid dedupe set only protects against a duplicate `pump()` within *this*
emitter instance's lifetime — it does nothing to prevent the first pump from over-reading).

The emitter's own test suite (`pty-usage-tail.test.ts` / `pty-usage-path-containment.test.ts`)
never exercises this because every test's `writeFileSync(..., {flag:'a'})` append happens only
after an explicit `await wait(200)`, which reliably gives the `stat()` promise time to resolve
first — the tests are not adversarial to this specific timing window.

**Fix:** Make the initial offset assignment synchronous-before-watch, e.g. resolve it before
arming the watcher/poll timer:
```ts
async function initOffset(): Promise<void> {
  if (opts?.fromStart === false) {
    try { offset = (await stat(path)).size } catch { /* file not present yet */ }
  } else {
    await pump()
  }
}
void initOffset().then(() => {
  watcher = watch(path, () => { void pump() })
  pollTimer = setInterval(() => { void pump() }, POLL_INTERVAL_MS)
})
```
Since this file is documented as a verbatim port of `hub/src/telegram/transcript/tail.ts`, port the
fix to both copies per the file's own header comment ("port any future fix there over here too").

### WR-02: `docs/usage-cost.md` misattributes the `runner_type` default to zod, not the handler

**File:** `docs/usage-cost.md:271` / `hub/src/ws/agent-protocol.ts:194-201`
**Issue:** The doc states: *"An older supervisor build that predates this phase omits the field
entirely; zod defaults it to `'stream-json'` so old and new supervisors both record correctly."*
But `AgentUsageEvent.runner_type` is declared as `z.enum(['stream-json',
'pty-interactive']).optional()` — there is no `.default('stream-json')`. After
`AgentUsageEvent.parse(...)`, an omitted field yields `undefined`, not `'stream-json'` (proven by
`hub/test/token-usage-runner-type.test.ts`'s own test: `expect(parsed.runner_type).toBeUndefined()`
immediately following a comment that says the opposite of what the schema actually does). The
actual default is applied downstream, in the handler: `runnerType: msg.runner_type ??
'stream-json'` (`hub/src/ws/agent.ts:791`). Behavior is correct end-to-end, but the doc will
mislead a future maintainer who inspects the zod schema expecting to see the default there and,
finding `undefined`, may "fix" it by adding a redundant/conflicting `.default()` or miss that the
real fallback lives in the WS handler.
**Fix:** Reword the doc sentence to: *"...omits the field entirely; the hub's `usage_event` handler
falls back to `'stream-json'` (`msg.runner_type ?? 'stream-json'`) so old and new supervisors both
record correctly — the zod field itself stays `undefined` when absent (see
`token-usage-runner-type.test.ts`)."*

### WR-03: New PTY-tailer tests are timing-dependent real-timer tests (flakiness risk under CI load)

**File:** `supervisor/test/pty-usage-tail.test.ts`, `supervisor/test/pty-usage-path-containment.test.ts`
**Issue:** Both files assert emission counts after fixed real-timer waits (`await wait(200/700/1300)`)
layered on top of `fs.watch` + a 500ms poll fallback + a 1000ms locate-poll — e.g.
`await wait(1300) // allow the locate poll to find the file, then attempt containment`. Under a
loaded CI runner (the shared Woodpecker `linux/amd64` label, alongside a real Postgres service in
the same job), these margins can be tight enough to occasionally miss a write/notify cycle,
producing an intermittent false failure (or, worse, a false pass if a race like WR-01 shifts
timing just enough to dodge detection). This mirrors a pre-existing pattern already used by
`hub/test/transcript-adapter-claude.test.ts`-style tests, so it isn't a new anti-pattern introduced
by this phase, but this phase adds ~23 more such cases, increasing the surface for CI flakiness.
**Fix:** Not blocking; consider a follow-up that replaces fixed waits with a poll-until-condition
helper (`await waitUntil(() => captured.length === 1, { timeoutMs: 2000 })`) so the tests pass as
soon as the condition is true and only fail after a real timeout, rather than gambling on a fixed
sleep being "enough."

---

_Reviewed: 2026-07-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
