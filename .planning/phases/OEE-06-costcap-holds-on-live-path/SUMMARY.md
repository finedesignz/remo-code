# OEE-06 — cost-cap holds on the live inject path (e2e) — SUMMARY

**File:** `hub/test/e2e/orchestrator-costcap.e2e.test.ts` (REMO_E2E_DB_URL-gated).

**Proves the non-bypassable cost cap on the REAL path** (not the sink's inject override): drives the real `injectOrchestratorPrompt(input, deps)` with `deps.dispatch` = the real pipeline `dispatch` (real gate list `[thresholdGate, dailyCostCapGate]`) and a fake online channel (records ws.send, no network).
- OVER cap (cap=$5, seeded `token_usage` today=$7.50 via h.sql): `outcome.kind==='refused_cost_cap'`, reason starts `over_daily_cost_cap:`, `sent.length===0`, no `messages` row — send skipped.
- UNDER cap control (cap=$100, same seeded $7.50): `outcome.kind==='dispatched'`, one `user_message` sent, `messages` +1. Leaving seeded rows proves spend-vs-cap (not spend-vs-zero).

**Seam added:** none — uses inject.ts's existing `InjectDeps` test seam. No test-only cap bypass, no `hub/src`/`schema.sql` change, flag untouched.

**Verify:** `bun test ...orchestrator-costcap.e2e.test.ts` → 0 pass / 4 skip / 0 fail (no DB). Runs green vs real PG in the qc gate.
