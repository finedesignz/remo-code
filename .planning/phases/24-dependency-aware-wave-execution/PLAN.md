# Phase 24 — dependency-aware-wave-execution — PLAN

## Goal
Build the WAVE ORCHESTRATION LOGIC + the per-unit finish→PR→reviewer protocol for the
auto-dev orchestrator. Pure, deterministic, unit-tested. Wire `controller.runWaves` to the
real planner + runner, but keep prod dormant behind `REMO_ORCHESTRATOR_ENABLED` (default OFF)
and behind stubbed seams (execute / PR / reviewer / propose) that Phases 25/28/29 fill.

## Assumptions
- Phase 24 owns ONLY wave planning + the per-unit lifecycle protocol. The mechanism that
  injects a templated prompt into the bound session to run a gsd skill is **Phase 25** — kept
  as a clearly-marked `executeCommand(row, ctx)` seam returning a typed placeholder.
- `createPrForUnit` (Phase-25 mechanics → shells `gh pr create` later), `dispatchReviewer`
  (Phase-28-adjacent reviewer dispatch), `proposeToChat` (Phase-28 surfaceProposal) are all
  STUBS now. No real `gh`/merge/network side effects, ever, from tests.
- merge-to-main is Phase 29 (off-hours) — EXCLUDED from the wave planner entirely.
- Reuse: `appendRunLog`/`writeRunLogFromBlocks` (P23), `CyclePriority` (P22 — deploy-fix>build),
  `parsePositiveInt`-style caps. Mirror the queue's release-on-throw isolation discipline.

## Dependency map (static, among gsd commands)
- `plan` → `execute` → `ship`  (linear chain)
- `audit-fix`, `gap-scan`, `code-review` — independent (no deps) → collapse into wave 0
- `merge-to-main` — EXCLUDED (Phase 29 off-hours)
- `ship`, `complete-milestone`, `tag` — PROPOSE-not-execute (Phase 28 tier); still placed in
  the wave topology (ship depends on execute) but routed to `proposeToChat`, not executed.

## Deliverables
1. `hub/src/orchestrator/waves.ts` — PURE wave planner.
   - `COMMAND_DEPS: Record<string,string[]>` static dep map.
   - `PROPOSE_COMMANDS: Set<string>` (ship/complete-milestone/tag).
   - `commandPriority(command)` → CyclePriority (deploy-fix-class > build) for intra-wave order.
   - `planWaves(commands: string[]): WavePlan` — topological grouping (Kahn-style by dep depth);
     independent collapse into earliest wave; dependents follow; intra-wave sorted by priority
     DESC then stable input order. Deterministic. Caps: MAX_WAVES, MAX_UNITS_PER_WAVE.
   - `WavePlan = { waves: WaveUnit[][] }`, `WaveUnit = { command, propose:boolean, priority }`.
2. `hub/src/orchestrator/wave-runner.ts` — execute a WavePlan.
   - Seams (all injectable for tests, default stubs for prod-dormant):
     `executeCommand(unit, ctx)` (Phase-25), `createPrForUnit(unit, ctx)` (Phase-25 mechanics),
     `dispatchReviewer(prUrl, ctx)` (reviewer), `proposeToChat(unit, ctx)` (Phase-28).
   - Per-unit lifecycle (non-propose): execute → createPr → dispatchReviewer → appendRunLog
     (command, outcome, pr_url, reviewer_verdict). Propose units: proposeToChat → appendRunLog
     (outcome=`proposed`, no PR/exec). Off-hours `merge-to-main` never reaches here.
   - Waves sequential (`for`); units within a wave parallel (`Promise.allSettled`).
   - Per-unit isolation: a throw is caught, logged as outcome=`failed`, does NOT wedge the wave
     (mirror queue release-on-throw). Unit failure does NOT abort later waves either (logged).
   - `runWavePlan(plan, ctx, deps?)` returns a summary `{ units, succeeded, failed, proposed }`.
3. Wire `controller.runWaves(parsed)`:
   - derive due command list from parsed runLogBlocks' decision? No — runWaves takes the
     ParsedController; build the command list from the decision's intent. Simpler + faithful to
     the seam signature: runWaves(parsed) plans over the commands present in parsed.runLogBlocks
     (the controller already emitted one block per command it intends), and runs them. Keep it a
     thin adapter: `planWaves(blocks.map(b=>b.command))` → `runWavePlan` with prod-default stubs.
   - Still gated: only `makeCycleRunner` (flag ON) ever calls it on a live tick.
4. Tests `hub/test/orchestrator-waves.test.ts` (always-on, no DB) + extend run-log assertions
   with in-memory seam spies (no DB needed for lifecycle-order test):
   - planner: independent collapse (wave 0), plan→execute→ship sequence (3 waves), mixed,
     priority intra-wave ordering, merge-to-main excluded, dedupe.
   - runner: lifecycle calls finish→PR→reviewer→run-log in order (spy ordering); propose units
     route to proposeToChat not execute/PR; unit-failure isolation (one throws, others still
     run + logged failed); waves run sequentially.
   - flag-OFF dormancy: `registerCycleRunnerIfEnabled()` returns false, queue runner unset.

## Success criteria (verifiable)
- `bun test hub/test/orchestrator-waves.test.ts` green.
- `bun run check-baseline` (JWT_SECRET set) not regressed.
- No `gh`/network/merge calls in tests (seams stubbed). Flag OFF + stubs ⇒ zero prod behavior.

## Karpathy
Smallest diff. Reuse CyclePriority, run-log, schedule helpers. No speculative scope (no Phase
25 prompt injection, no real PR/merge). No defensive code for impossible states.
