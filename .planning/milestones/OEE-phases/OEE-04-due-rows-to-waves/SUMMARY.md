# OEE-04 — due-rows → controller → dependency-aware waves (e2e) — SUMMARY

**File:** `hub/test/e2e/orchestrator-due-waves.e2e.test.ts` (REMO_E2E_DB_URL-gated; skips clean in CI without a disposable PG).

**Proves (real code, real PG, default STUB_SEAMS — no live claude/network/merge):**
1. plan→execute→ship dependency ordering: 3 chain rows seeded out of order with fire-now rules; real `computeDueRowsForTask` returns all due; real `planWaves` sequences `[[plan],[execute],[ship]]`; `runWavesFromDueRows` runs e2e and writes one `routine_run_log` row per command.
2. merge-to-main `active_window` gating: row with window 02:00–04:00 UTC is NOT due at 12:00 UTC, IS due at 03:00 UTC (clock-only change); even when due, `planWaves` EXCLUDES it (in `plan.dropped`, absent from all waves).
3. due-scan → real queue: `scanAndEnqueueDueCycles(NOW)` enqueues the window-active session into the real `routine_queue` (pending row asserted).

**Seam added:** none — uses existing orchestrator entrypoints (`computeDueRowsForTask`, `planWaves`, `runWavesFromDueRows`, `scanAndEnqueueDueCycles`). No `hub/src`/`schema.sql` change, no cost-cap bypass, `REMO_ORCHESTRATOR_ENABLED` untouched.

**Verify:** `bun test hub/test/e2e/orchestrator-due-waves.e2e.test.ts` → 1 pass / 5 skip / 0 fail (no DB). Runs green vs real PG in the Woodpecker qc gate.
