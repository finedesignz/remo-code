---
phase: 25-gsd-command-execution-seam
status: passed
score: PASS (1 carried integration item, non-blocking)
verified_by: main-thread orchestrator (subagent verifier rate-limited x2 — server transient)
---

# Phase 25 — gsd-command-execution-seam · VERIFICATION

**Verdict: PASS** · commit `4ce9480` · verified inline (subagent verifier hit transient server rate-limit twice; main-thread did the gate to avoid retry-storm)
**Tests:** `orchestrator-command-prompts.test.ts` + `orchestrator-waves.test.ts` = 34 pass / 0 fail (134 expects)

## Per-requirement
| Req | Item | Status | Evidence |
|---|---|---|---|
| R-ADO (cmd registry) | row→gsd skill map + finish→PR→reviewer envelope | PASS | `command-prompts.ts` maps default rows to skills; non-propose prompts embed `gh pr create` (per-command branch) + dispatch-reviewer + `<<UNIT>>` report + "NEVER merge to main"; micro-prompt wraps free text; ship/milestone/tag PROPOSE_ONLY → compose returns null |
| R-ADO (execute seam) | reuse dispatch + non-bypassable cost cap | PASS | `inject.ts` uses shared `dispatch()` with `gates: [thresholdGate, dailyCostCapGate]`, `getChannel`/`insertMessage`/`broadcastToSubscribers`; typed refusal on cost-cap; not forked |
| Safety | hub ships TEXT ONLY | PASS | grep: only `gh pr`/`merge` occurrences are inside prompt STRINGS + doc comments; no `child_process`/`spawn`/`exec`/`fetch`/real git in `inject.ts`/`command-prompts.ts` — the agent does PR+reviewer in-turn; hub createPrForUnit/dispatchReviewer are no-ops returning null |
| Safety | flag-OFF dormancy | PASS | `registerCycleRunnerIfEnabled` sole `setCycleRunner` caller, `REMO_ORCHESTRATOR_ENABLED` default OFF; test + boot log confirm not registered |

## Empty-command-set ruling
`controller.ts:410` calls `runWaves({ decision: SAFE_FALLBACK, runLogBlocks: [] }, ...)` — empty command set, so even flag-ON injects NOTHING until the controller→wave wiring lands. **Ruling: ACCEPTABLE DEFERRAL, not a Phase-25 gap.** Phase-25 scope = the execution SEAM (row→prompt→dispatch+cost-cap), which is complete + tested. The end-to-end wiring (parse the agent's decision command set + resolve session→user→task→stage and feed `runWaves`) is integration work with no dedicated phase in the SPEC.

## CARRIED PRE-ENABLEMENT GATE (must clear before `REMO_ORCHESTRATOR_ENABLED=1` ever in prod)
1. Wire the controller→wave command set (replace `runLogBlocks: []` with the parsed decision + session/user/task/stage resolution). Owner: final integration (Phase 32 or a dedicated enablement step).
2. Run the deferred DB e2e (queue + run-log + inject) against a real Postgres (`REMO_E2E_DB_URL` / CI).

## Invariants
No drive-by; reuses dispatch/buildContent + gates (no fork); additive-only `WaveUnit.microPrompt`; no inline schema backfill.
