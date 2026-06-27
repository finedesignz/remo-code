# Phase 25 — gsd-command-execution-seam — PLAN

## Goal (locked decision D6)
Replace the inert P24 `executeCommand` stub with the REAL execution seam: the hub composes a
templated prompt per due command and INJECTS it into the bound session agent via the EXISTING
`hub/src/dispatch/` pipeline (the same path the scheduler's `sendAgentTask` uses). The agent —
which holds the gsd skills — runs the skill, spawns its own Task subagents, opens a PR on a
per-command branch, dispatches a reviewer subagent, and reports the PR url + verdict back in a
parseable form. The hub injects TEXT ONLY: it never shells `gh`/git/merge.

## Assumptions (state before coding)
- A `WaveUnit` carries `{command, propose, priority}` but NOT the row's `micro_prompt`. To template
  a micro-prompt row I extend `WaveUnit` with an optional `microPrompt?: string|null` (additive,
  defaulted; planner stays deterministic). Custom command rows whose `command` is unknown are treated
  as micro-prompt rows when `microPrompt` is set.
- The dispatch pipeline keys by `sessionId`; the cost cap is enforced by `dailyCostCapGate` which the
  scheduler composes as `gates: [thresholdGate, dailyCostCapGate]`. The orchestrator MUST reuse the
  same gate array so the cap is non-bypassable (IR-1).
- `MAX_CHAIN_DEPTH = 5` lives in `hub/src/scheduler/dispatcher.ts`. Orchestrator injection is a single
  user_message turn (depth 0); chain-depth is respected because we do NOT spawn chained post-run
  dispatches from the hub — the agent's own subagent spawning happens inside its turn and is bounded
  by the agent runtime, not a hub chain. We document this and assert the gate list includes the cap.
- The gsd work + PR + reviewer happen ASYNC inside the agent turn. `executeCommand` returns once the
  prompt is DISPATCHED (or refused). pr_url/verdict are NOT known synchronously → the P24 run-log row
  captures `outcome=dispatched|refused_cost_cap|no_session`, pr_url/verdict = null (reconciled later
  when the agent's reply/run-log surfaces; reconciliation is a later phase / the controller re-reads
  the run log each tick).

## Design — who does what (async finish→PR→reviewer boundary)
- **Hub** (`executeCommand`): compose templated prompt → inject via `dispatch()` with
  `[thresholdGate, dailyCostCapGate]` → return typed result. NO gh/git.
- **Agent** (inside its turn, per the embedded prompt): runs gsd skill, completes work, `gh pr create`
  on `auto-dev/<command>/<short>` branch, dispatches reviewer subagent, reports
  `<<UNIT command:.. pr_url:.. reviewer_verdict:.. UNIT>>` back in its reply.
- **createPrForUnit / dispatchReviewer seams**: become hub-side NO-OPS that return null. Rationale
  (documented in code): the agent owns PR + reviewer per the embedded prompt; the hub cannot and must
  not open a PR. The run-log row's pr_url/verdict stay null at dispatch time and are reconciled when
  the controller re-reads the agent's reported run-log block on a later tick (already parsed by
  `parseControllerDecisions` RUNLOG blocks in controller.ts). This keeps the hub prompt-only.

## Files
1. NEW `hub/src/orchestrator/command-prompts.ts` — registry: command → templated prompt (envelope:
   run gsd skill → finish → `gh pr create` per-command branch → dispatch reviewer → report
   `<<UNIT ...>>`). Default rows: gsd-plan-phase, gsd-execute-phase, gsd-audit-fix, gap-scan,
   gsd-code-review, gsd-verify-work, gsd-complete-milestone, gsd-ship + micro-prompt template.
   Note: ship/complete-milestone/tag are PROPOSE (Phase 28) → registry only exposes NON-propose
   templates + micro-prompt; propose rows never call executeCommand.
2. EDIT `hub/src/orchestrator/wave-runner.ts` — add `microPrompt?` carry on WaveUnit usage via ctx;
   add real-seam factory `makeLiveSeams(deps)` whose `executeCommand` injects the prompt through a
   pluggable `injectPrompt` adapter (mockable in tests); `createPrForUnit`/`dispatchReviewer` no-op.
   Keep `STUB_SEAMS` as the test/default export.
3. EDIT `hub/src/orchestrator/waves.ts` — add optional `microPrompt` to `WaveUnit` (additive).
4. EDIT `hub/src/orchestrator/controller.ts` — wire `makeLiveSeams` into `makeCycleRunner`'s
   `runWaves` call (live call site only); keep `runWaves`/`runWavePlan` defaulting to STUB_SEAMS.
   The live inject adapter calls a new `hub/src/orchestrator/inject.ts` that reuses the dispatch
   pipeline with the cost-cap gate.
5. NEW `hub/src/orchestrator/inject.ts` — `injectOrchestratorPrompt({userId, sessionId, command,
   prompt})`: builds the same dispatch `deps` shape as `sendAgentTask` (gates [threshold, costCap],
   send over agent socket via getChannel + insertMessage + broadcast), returns
   `{kind:'dispatched'|'refused_cost_cap'|'no_session'|'queued'|'failed'}`. Reuses `dispatch()`.

## Flag safety
All live wiring sits behind `registerCycleRunnerIfEnabled()` (REMO_ORCHESTRATOR_ENABLED, default OFF).
Flag OFF ⇒ no cycle runner ⇒ `makeCycleRunner`/`makeLiveSeams` never invoked ⇒ nothing injected. Even
ON, every inject flows through `dailyCostCapGate`. No hub-side gh/git ever.

## Tests (`hub/test/orchestrator-command-prompts.test.ts` + extend waves test)
- registry returns correct gsd skill invocation per default row + envelope (finish/PR/reviewer/UNIT).
- micro-prompt wrapping (custom text wrapped in same envelope).
- ship/complete-milestone/tag NOT in executable registry (propose-only).
- executeCommand (live seam) calls inject adapter with composed prompt for the session; assert
  injected content + that gate list contains dailyCostCapGate.
- cost-cap refusal path → outcome 'refused_cost_cap', send never called.
- flag-OFF dormancy (registerCycleRunnerIfEnabled false).
- DB-touching inject e2e env-gated (skip if no Postgres).

## Karpathy
Smallest diff: reuse dispatch pipeline verbatim (mirror sendAgentTask's deps), no new queue/grace,
no fork. Additive WaveUnit field. No speculative reconciliation engine (documented as later-phase).
