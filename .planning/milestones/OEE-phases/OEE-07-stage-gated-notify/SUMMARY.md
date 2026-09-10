# OEE-07 — stage-gated notify fan-out (e2e) — SUMMARY

**File:** `hub/test/e2e/orchestrator-notify.e2e.test.ts` (REMO_E2E_DB_URL-gated).

**Proves the notify.ts stage matrix off reconciled sentinels, with NO real outbound** (real `shouldNotify` + `fanOutNotify` invoked with captured `NotifyDeps` spies; real telegram/email/ws modules never reached):
- development ship/info: SILENT (no page; any in-app fan-out carries only `['inapp']`); telegram=0, email=0.
- production-maintenance blocking gate: real `runMacroCycle` HALTS (`injected===false`), exactly 1 gate fan-out across all 4 channels; real `fanOutNotify` routes telegram+inapp+email, text contains `(BLOCKING)`.
- GATE-vs-blocking-NOTIFY dedup: exactly ONE `gate` fan-out when both present (blocking NOTIFY suppressed).
- development gate: 0 fan-outs (`shouldNotify('gate','development').fire===false`).

**Seam added:** none — existing `MacroCycleDeps` (harness sink) + `NotifyDeps` on real `fanOutNotify`. No `hub/src`/`schema.sql` change.

**Verify:** `bun test ...orchestrator-notify.e2e.test.ts` → 1 pass / 7 skip / 0 fail (no DB). Runs green vs real PG in the qc gate.
