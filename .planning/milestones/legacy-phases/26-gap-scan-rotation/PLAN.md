# Phase 26 — gap-scan-rotation · PLAN

Goal: the rotating gap-scan command (locked decision D7). Fixed dimension wheel; each
`gap-scan` tick picks the least-recently-run dimension(s) from `routine_run_log` and maps
it to a specialist agent; the chosen dimension is recorded so the next tick advances.

Reqs: R-ADO-17 (wheel + LRU), R-ADO-18 (dimension → specialist agent).

## Assumptions (state up front)
- The run-log write path ALREADY threads `gap_dimension`: `wave-runner.runUnit` reads
  `ExecuteResult.gapDimension` and passes it to `appendRunLog({ gap_dimension })`
  (Phase 23/24). So integration = populate `ExecuteResult.gapDimension` for gap-scan only.
- `recentRunLog(sessionId, n)` returns entries newest-first (DESC). LRU is computed from
  the most-recent index each dimension appears at.
- Pure rotation + prompt composition only. No hub-side gh/git. Behind
  `REMO_ORCHESTRATOR_ENABLED` (default OFF) — the live seam is the only caller, and it is
  only registered when the flag is on.

## Deliverables (smallest diff)
1. NEW `hub/src/orchestrator/gap-rotation.ts` (PURE):
   - `GAP_DIMENSIONS` — frozen 8-tuple in wheel order:
     `security, performance, accessibility, test-coverage, dependency-hygiene,
      error-handling, docs-drift, type-safety`.
   - `DIMENSION_AGENTS: Record<dimension, agentType>` — every dimension → specialist.
   - `nextGapDimensions(recent, count=1)` — pure LRU selection over the wheel, reading prior
     `gap_dimension` values from the run log (newest-first). Empty log → wheel head(s).
     Deterministic tie-break by wheel order. Never returns > 8 / > available.
2. EDIT `hub/src/orchestrator/command-prompts.ts`:
   - `ComposeInput.gapDimension?` (optional). `ComposedPrompt.gapDimension` (echo back).
   - When the resolved command is gap-scan AND a dimension is supplied, embed a
     "run a <dimension> gap analysis using the <Specialist> subagent" instruction +
     "record gap_dimension: <dimension>" in the `<<UNIT>>`. Rest of envelope unchanged.
3. EDIT `hub/src/orchestrator/wave-runner.ts` `makeLiveSeams().executeCommand`:
   - For a gap-scan unit, read `recentRunLog(ctx.sessionId)`, pick the next dimension via
     `nextGapDimensions(...)`, compose with it, and return `gapDimension` in `ExecuteResult`
     (runUnit already persists it). Non-gap commands unchanged.
4. Tests (mirror hub/test):
   - `hub/test/orchestrator-gap-rotation.test.ts` — LRU correctness (empty→head; after
     security used, security is last to repeat; full 8-cycle before repeat; count>1; tie-break),
     agent-map completeness (all 8 mapped), defanged inputs.
   - extend `orchestrator-command-prompts.test.ts` — gap-scan prompt includes the chosen
     dimension + specialist + `gap_dimension:` in the UNIT; gapDimension echoed.
   - extend the live-seam test — gap-scan executeCommand returns a gapDimension (mocked
     recentRunLog) and rotates off prior log.

## Verify
- `bun test hub/test/orchestrator-gap-rotation.test.ts hub/test/orchestrator-command-prompts.test.ts`
- `JWT_SECRET=test_secret_at_least_32_chars_long_xx bun run check-baseline`

## Karpathy
Smallest diff; pure + unit-testable rotation; reuse the existing run-log + gapDimension seam
(no fork); exactly the 8 SPEC dimensions, no speculative ones.
