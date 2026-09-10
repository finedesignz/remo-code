# OEE-02 — Scripted Bound-Session Sink — SUMMARY

**Branch:** `feat/orchestrator-e2e-proveout` · **Status:** built.

## What was built

A deterministic, fake bound-session injection target (`createScriptedSink`) that
CAPTURES every prompt the orchestrator injects and REPLAYS caller-supplied canned
agent replies containing `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>` sentinel blocks — with
NO live `claude` subprocess, no network, no clock.

## Injection seam used (NO new prod seam added)

The orchestrator macro path ALREADY exposes a clean dependency-injection seam:
`runMacroCycle(input, deps?: MacroCycleDeps)` (`hub/src/orchestrator/macro-cycle.ts`),
whose `deps` default to the real adapters but can be overridden. The sink IS a
`MacroCycleDeps`:

- `inject`                  → captures the `InjectInput` (prompt+token), returns a
                              caller-chosen `InjectOutcome` (default `dispatched`).
- `getLatestAssistantReply` → FIFO-replays the next canned reply, so the cycle's
                              RECONCILE step parses REAL sentinels via the real
                              `sentinels.ts` (`parseSentinels`).
- `appendRunLog`            → captures in-memory AND (when a harness `sql` is passed)
                              writes through to the REAL `routine_run_log` table.
- `fanOut`                  → captures notify fan-outs (no real outbound side effects).
- `isRunLive`               → caller-controlled per-session lock state.

Because this is the orchestrator's OWN existing seam, **nothing in `hub/src/**` is
monkeypatched or modified** — there is no production-runtime change, inert or
otherwise. (The lower `injectOrchestratorPrompt(input, deps)` seam over `dispatch`
is left untouched so OEE-06 can prove the real `dailyCostCapGate` end-to-end; the
sink never bypasses the cost cap.)

## Files

- `hub/test/e2e/orchestrator-harness.ts` — `createScriptedSink`, `ScriptedSink`,
  `SinkOptions`, capture types.
- `hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts` — round-trips one scripted
  prompt+reply: pulls the canned reply, asserts `<<STATE>>`/`<<NOTIFY>>` parse via the
  real `sentinels.ts`, captures an inject, and (with a DB) write-throughs a run-log row.

## How to run

Same as OEE-01 (`bun test hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts`).

## Constraints honored

- Deterministic; no `claude` subprocess.
- Cost cap NOT weakened — the sink replaces the inject ADAPTER (above `dispatch`); a
  phase proving the cap uses the real `injectOrchestratorPrompt` instead.
- No human-PTY path involved; this is strictly the programmatic orchestrator path.

## How later phases build on it

- **OEE-05** drives the full `runMacroCycle(input, sink.deps)` per tick: queue replies
  with `sink.pushReply(...)`, run the cycle, then assert on `sink.captured`
  (prompts injected), `sink.notifies` (stage-gated fan-out), and `sink.runLog` /
  the real `routine_run_log` (STATE reconciliation, halt-on-gate behavior).
- **OEE-07** asserts `sink.notifies` against the `notify.ts` stage matrix with no real
  channels firing.
- Pass `injectOutcome: { kind: 'refused_cost_cap', ... }` to simulate a capped turn
  for cycle-level assertions (OEE-06 still proves the REAL gate separately).
