# Phase 25 — gsd-command-execution-seam · SUMMARY

**Status:** Complete (PASS, 1 carried integration item) · commit `4ce9480` on `feat/auto-dev-orchestrator`

The execution seam: each command row → a templated prompt injected into the bound session via the EXISTING dispatch pipeline (cost-cap-gated); the agent runs the gsd skill + does PR + reviewer in-turn. Hub ships text only.

## Delivered
- `hub/src/orchestrator/command-prompts.ts` — registry mapping rows → gsd skills (plan/execute/audit-fix/gap-scan→gsd-review/code-review/verify-work) + the finish→`gh pr create`(per-command branch)→dispatch-reviewer→report-`<<UNIT>>` envelope + "NEVER merge to main"; micro-prompt rows wrap free text; ship/complete-milestone/tag = PROPOSE_ONLY (compose→null, Phase-28 route).
- `hub/src/orchestrator/inject.ts` — `executeCommand` adapter: composes the prompt + injects via shared `dispatch()` with `[thresholdGate, dailyCostCapGate]` (non-bypassable), reusing `getChannel`/`insertMessage`/`broadcast`. Typed result: dispatched / refused_cost_cap / no_session.
- `wave-runner.ts` `makeLiveSeams()`; `waves.ts` additive `WaveUnit.microPrompt`; `controller.ts` live `makeCycleRunner` wires live seams (still behind flag).

## Async boundary
Hub injects only; gsd work + PR + reviewer run async inside the agent turn. Hub-side createPrForUnit/dispatchReviewer are no-ops returning null (hub must not open PRs); pr_url/verdict reconciled later from the agent's reported run-log block.

## Safety
`REMO_ORCHESTRATOR_ENABLED` default OFF; hub never shells gh/git/merge (text only); cost cap always in the gate list.

## Verification
34 pass / 0 fail. Verified main-thread (subagent verifier hit transient server rate-limit). Carried pre-enablement gate: (1) controller→wave command-set wiring; (2) real-Postgres DB e2e.
