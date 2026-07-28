---
phase: PTYCAP-01-pty-token-accounting
plan: 01
subsystem: usage-cost
tags: [pty, transcript-tail, usage-ledger, postgres, zod, websocket, supervisor]

requires: []
provides:
  - "supervisor/src/usage/pty-transcript-tail.ts — verbatim port of hub/src/telegram/transcript/tail.ts (byte-offset JSONL tailer, watch+poll fallback)"
  - "supervisor/src/usage/pty-usage-emitter.ts — PtyUsageEmitter (capture-once transcript locator, per-turn usage extraction, dedupe, lifecycle)"
  - "token_usage.runner_type column + token_usage_runner_type_check constraint + idx_token_usage_user_runner_type index (additive, idempotent)"
  - "AgentUsageEvent.runner_type (hub zod) and AgentToHub usage_event.runner_type (supervisor type) — additive WS contract field"
  - "recordTokenUsage({ runnerType }) threading in hub/src/db/token-usage-dal.ts and hub/src/ws/agent.ts"
  - "getTodayTokenTotalByRunner() — per-runner split read (observability only, does not feed the cap)"
affects: [ptycap-phase-2-pty-preflight-gate, usage-cost-docs]

tech-stack:
  added: []
  patterns:
    - "Capture-once mtime-anchored file locator (never re-resolved after first hit) to avoid a concurrent session's transcript stealing attribution"
    - "Emitter-level uuid dedupe set independent of the tailer's own byte offset, so a truncation/re-read never double-counts"

key-files:
  created:
    - supervisor/src/usage/pty-transcript-tail.ts
    - supervisor/src/usage/pty-usage-emitter.ts
    - supervisor/test/pty-usage-tail.test.ts
  modified:
    - hub/src/db/schema.sql
    - hub/src/db/token-usage-dal.ts
    - hub/src/ws/agent-protocol.ts
    - hub/src/ws/agent.ts
    - supervisor/src/runners/types.ts
    - supervisor/src/runners/session-bridge.ts

key-decisions:
  - "P1-D-A: lifecycle owner is session-bridge.ts ensurePtyRunner(), NOT claude-pty-bridge.ts (which is a pure raw-byte relay with no hub socket)."
  - "P1-D-B: capture-once, mtime-anchored transcript locator — pinned once per session, never re-resolved."
  - "P1-D-C: sessions.transcript_path / setSessionPtyIdentity() hub persistence NOT wired this phase (would need new WS surface no SC requires)."
  - "P1-D-D: token_usage_daily's PK is NOT extended with runner_type — the row-level ledger split is sufficient for every SC; the rollup stays a combined-bucket cache for the cost cap."
  - "P1-D-E: Phase 1 accounting is scoped to cli_kind='claude' only; a codex-backed session is a true no-op (Codex rollout-JSONL usage parity is unverified, named as a fast-follow)."
  - "P1-D-F: PTY-sourced usage_event always sets cost_source:'estimated' and cost_usd:0 — the transcript carries no per-record cost; the hub's existing estimateCostUsd() fallback computes it, same as the stream-json path already does when the SDK omits cost."
  - "Fixed inherited partial-work bug: agent-protocol.ts's new zod field was named `runner` instead of `runner_type` — zod silently strips unknown keys, so every PTY row would have landed mislabelled 'stream-json' with no error. Caught by re-running the plan's own grep acceptance criterion rather than trusting an earlier visual diff review."
  - "Disabled workflow.use_worktrees for this execute-phase run (.planning/config.json) — the resumed session had uncommitted partial edits from an interrupted prior run; worktree-isolated parallel executors would have forked from HEAD without that diff, risking duplicated/conflicting work on merge. All four plans in this phase run sequentially in this single worktree instead."

patterns-established:
  - "Additive, optional, safely-defaulted WS/schema field for a new runner_type value — mirrors the existing sessions.runner_type precedent exactly."

requirements-completed: [SC-1, SC-2, SC-3]

coverage:
  - id: D1
    description: "A live-appended assistant usage record in a still-open PTY transcript produces exactly one usage_event frame tagged runner_type:'pty-interactive', with the exact contracted key set and values (SC-1)."
    requirement: SC-1
    verification:
      - kind: unit
        ref: "supervisor/test/pty-usage-tail.test.ts#a live-appended assistant usage record emits exactly one tagged frame while the file is still open"
        status: pass
    human_judgment: false
  - id: D2
    description: "The zod AgentUsageEvent schema preserves runner_type (fixed from the inherited `runner` typo) so the tag survives the WS hop, and recordTokenUsage() persists it into token_usage.runner_type with a live CHECK constraint (SC-2)."
    requirement: SC-2
    verification:
      - kind: unit
        ref: "hub/test/usage-event-handler.test.ts"
        status: pass
      - kind: other
        ref: "grep -n runner_type hub/src/ws/agent-protocol.ts (source assertion from 01-01-PLAN.md acceptance criteria)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Malformed lines, duplicate uuids, and a truncation/re-read each produce zero extra ledger rows; a codex-backed session is a true no-op; the no-API-key/argv-allowlist-of-one guards stay green unchanged."
    verification:
      - kind: unit
        ref: "supervisor/test/pty-usage-tail.test.ts (17 tests, incl. truncation-dedupe + codex no-op)"
        status: pass
      - kind: unit
        ref: "supervisor/test/{no-api-key-no-streamjson-pty,no-apikey-fallback-guard,default-backend-selector,pty-reattach-persistence}.test.ts"
        status: pass
    human_judgment: false

duration: ~2h (resumed mid-execution after a prior session-limit cutoff)
completed: 2026-07-28
status: complete
---

# Phase 1, Plan 1: PTY Turn Tracer — Tokens Reach the Ledger, Tagged Interactive

**A live interactive PTY turn's token spend now reaches `token_usage` while the turn is still
running, tagged `runner_type='pty-interactive'` — previously it recorded zero rows, forever.**

## Performance

- **Started:** interrupted by a session limit mid-execution (prior run); resumed 2026-07-28.
- **Completed:** 2026-07-28
- **Tasks:** 1 of 1 completed (single tracer task, per plan frontmatter `task_count: 1`)
- **Files modified:** 9 (3 new, 6 modified)

## Accomplishments
- Ported `hub/src/telegram/transcript/tail.ts` verbatim into `supervisor/src/usage/pty-transcript-tail.ts`
  (byte-offset JSONL tailer with truncation-reset and watch+poll fallback — unchanged internals,
  only the module home moved).
- Built `PtyUsageEmitter` (`supervisor/src/usage/pty-usage-emitter.ts`): a capture-once transcript
  locator (`resolveTranscriptPath`), a tolerant usage extractor (`extractUsage`), a bounded uuid
  dedupe set, and a lifecycle (`start`/`stop`) that reuses `resolveSessionDir`/`realPathContained`
  from `supervisor/src/commands/session-read.ts` verbatim rather than re-deriving path-safety logic.
- Wired the emitter's lifecycle into `session-bridge.ts`'s `ensurePtyRunner()` — started right after
  the PTY itself, torn down at all three existing PTY teardown sites (`stop()`, the terminal-close
  branch, and the PTY's own `onExit`) — never stopped on a plain socket detach (the PTY and its
  transcript writes stay alive on the Rust host across a reattach).
- Threaded `runner_type` additively through the WS contract (`AgentToHub` on the supervisor,
  `AgentUsageEvent` zod on the hub) and the DAL (`recordTokenUsage`), landing in a new additive
  `token_usage.runner_type` column with a live two-value CHECK constraint and a supporting index.
- Found and fixed a real bug in the inherited partial work: the hub zod schema had the new field
  named `runner` instead of `runner_type` — since zod silently strips unknown keys, every PTY row
  would have been mislabelled `'stream-json'` with no error anywhere. This is exactly the failure
  mode the plan's own acceptance criteria warn about; it was caught by literally re-running the
  plan's `grep -n "runner_type" hub/src/ws/agent-protocol.ts` acceptance check rather than trusting
  an earlier visual diff scan.

## Task Commits

1. **Task 1: End-to-end "one PTY assistant turn's tokens reach the ledger, tagged interactive"** — `e3d3b8b` (feat)

**Plan metadata:** tracking commit follows this SUMMARY.md (docs: complete plan).

## Files Created/Modified
- `supervisor/src/usage/pty-transcript-tail.ts` — verbatim port of the JSONL tail primitive.
- `supervisor/src/usage/pty-usage-emitter.ts` — capture-once locator, usage extractor, dedupe, lifecycle.
- `supervisor/test/pty-usage-tail.test.ts` — 17 tests covering every `<behavior>` bullet plus direct unit coverage of `extractUsage`/`resolveTranscriptPath`.
- `supervisor/src/runners/types.ts` — additive `usage_event.runner_type` field.
- `supervisor/src/runners/session-bridge.ts` — `ptyUsage` field, start wiring in `ensurePtyRunner()`, teardown at all three PTY-kill sites.
- `hub/src/ws/agent-protocol.ts` — `AgentUsageEvent.runner_type` (fixed from inherited `runner` typo).
- `hub/src/ws/agent.ts` — `usage_event` handler threads `runnerType: msg.runner_type ?? 'stream-json'`.
- `hub/src/db/token-usage-dal.ts` — `TokenUsageInput.runnerType`, INSERT column threading.
- `hub/src/db/schema.sql` — `token_usage.runner_type` column + CHECK constraint + index (idempotent DDL, no backfill).

## Decisions Made
See `key-decisions` in the frontmatter above (P1-D-A through P1-D-F, inherited from `01-01-PLAN.md`'s
`<additional_context>`, plus the two decisions made during this resumed execution: the `runner_type`
naming fix, and disabling `workflow.use_worktrees` for this phase run).

## Deviations from Plan

### Auto-fixed Issues

**1. [Correctness] `AgentUsageEvent.runner_type` was named `runner` in inherited partial work**
- **Found during:** Task 1, while verifying the plan's own acceptance-criteria greps before
  committing (this session resumed after a prior interruption; `hub/src/db/schema.sql`,
  `hub/src/db/token-usage-dal.ts`, and `hub/src/ws/agent-protocol.ts` already carried partial edits).
- **Issue:** zod strips unknown object keys. With the field named `runner` instead of `runner_type`,
  `msg.runner_type` in the hub's `usage_event` handler would always read `undefined`, so
  `recordTokenUsage({ runnerType: msg.runner_type ?? 'stream-json' })` would ALWAYS write
  `'stream-json'` — every PTY-tagged row silently mislabelled, with no error, no test failure
  visible without deliberately checking (this is the exact failure class the plan's own comment
  warns about: "Without this the tag is stripped by zod and every PTY row is mislabelled").
- **Fix:** renamed the zod field to `runner_type` in `hub/src/ws/agent-protocol.ts`.
- **Files modified:** `hub/src/ws/agent-protocol.ts`.
- **Verification:** `grep -n "runner_type" hub/src/ws/agent-protocol.ts` now returns a line inside
  `AgentUsageEvent`; `hub/test/usage-event-handler.test.ts` still green (3/3); plan 01-02 (next)
  adds the direct zod round-trip proof this bug would have failed.
- **Committed in:** `e3d3b8b` (part of the single task commit — the corrected field never existed
  as a separate commit; this session's fix landed before the first commit of this plan).

---

**Total deviations:** 1 auto-fixed (correctness). **Impact on plan:** necessary for correctness —
without it SC-2's entire premise (buckets are separable) would be silently false in production.
No scope creep.

## Issues Encountered
- **Pre-existing environment gap (not fixed, out of scope):** `supervisor/test/pty-byte-relay.test.ts`
  and `supervisor/test/pty-orphan-teardown.test.ts` fail on this host because the native `node-pty`
  module is not installed (`Cannot find module 'node-pty'`) — confirmed present in `supervisor/package.json`
  but absent from `node_modules` in BOTH this worktree and the canonical `remo-code` checkout, and
  absent from `bun.lock`. Unrelated to this plan's diff (neither file nor anything it imports was
  touched). Not attempted to fix — installing/building a native module is outside this phase's scope
  and risks side effects across the many other active worktrees on this host.
- **Ambient env var caused two unrelated spurious failures during verification:** `REMO_PTY_INTERACTIVE=1`
  is set globally in this shell (a real dev-environment setting, not repo state). With it set,
  `supervisor/test/bridge-permission-returnpath.test.ts` fails because `auth_ok` routes through
  `ensurePtyRunner()` instead of `ensureRunner()` in that test's fake-WS harness, so the stream-json
  `runner` object it asserts against never gets constructed. Confirmed by running with
  `env -u REMO_PTY_INTERACTIVE` — passes 3/3. All verification in this plan was run with
  `REMO_PTY_INTERACTIVE` unset to get a true read.

## User Setup Required
None — no external service configuration required. (A native `node-pty` build is needed on this
host for the two unrelated PTY-relay/orphan-teardown tests above to pass, but that predates this
phase and is not part of its Definition of Done.)

## Next Phase Readiness
Plan 01-02 (SC-2 proof at the DAL/zod/DDL/Postgres-constraint level) and 01-03 (SC-3 mid-flight
visibility + the two security guard canaries) both depend on this plan's artifacts and are ready to
proceed. Plan 01-04 (CI wiring + baseline + docs) depends on all three.

---
*Phase: PTYCAP-01-pty-token-accounting*
*Completed: 2026-07-28*
