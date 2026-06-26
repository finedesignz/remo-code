# OEE-09 — legacy-wave rollback parity (e2e) — SUMMARY

**File:** `hub/test/e2e/orchestrator-legacy-wave-parity.e2e.test.ts` (REMO_E2E_DB_URL-gated).

**Smoke-proves the `REMO_ORCHESTRATOR_LEGACY_WAVES=1` rollback lever vs real PG.** `controller.ts:useMacroPath()` reads the flag at call time; `makeCycleRunner()` branches on it.
- Selector flip: `useMacroPath()` true when unset, false when `=1`.
- With `=1`: real `makeCycleRunner(undefined, STUB_SEAMS)` against real PG (seeded user/session/task + one due `plan` row) writes one `routine_run_log` row `outcome='skipped_phase25_stub'` — a marker ONLY the legacy wave engine writes, proving the rollback engine executed end-to-end.
- Contrast (flag unset): same runner routes through `runMacroCycle`, no `skipped_phase25_stub` row — proving the toggle genuinely switches engines.

**Seam added:** none — existing `makeCycleRunner` + exported `STUB_SEAMS`. Per-test env set/reset; `REMO_ORCHESTRATOR_ENABLED` never flipped. No `hub/src`/`schema.sql` change.

**Verify:** `bun test ...orchestrator-legacy-wave-parity.e2e.test.ts` → 1 pass / 5 skip / 0 fail (no DB). Runs green vs real PG in the qc gate.
