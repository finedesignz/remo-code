---
phase: 32-legacy-task-migration-and-docs
status: passed
score: 7/7 must-haves verified (automated); real-Postgres e2e = enablement gate
milestone_verdict: PASS (flag-OFF) — auto-dev-orchestrator Phases 21-32
ship_flag_off: READY
verified_by: independent gsd-verifier (integration gate)
---

# Phase 32 — controller→wave wiring + migration + docs · VERIFICATION

**Verdict: PASS** · commits `252a132`, `17a739f`, `6b685eb` · **Milestone: PASS (flag-OFF) · Ship-flag-OFF: READY**

## Observable truths (7/7)
| # | Truth | Status |
|---|-------|--------|
| 1 | Controller drives waves end-to-end from DUE rows, reuses Phases 23-27 (no fork) | ✓ |
| 2 | `executeCommand` inject flows through `dailyCostCapGate` (non-bypassable) | ✓ |
| 3 | Migration: one-shot, not in schema.sql, idempotent, `--dry-run`, `import.meta.main`-guarded, disables-not-deletes legacy | ✓ |
| 4 | Docs: `docs/auto-dev-orchestrator.md` + Docs-map row + all envs documented | ✓ |
| 5 | Flag-OFF dormancy ABSOLUTE — no escape path | ✓ |
| 6 | Hub never shells gh/git/merge in orchestrator/* (agent does it in-turn) | ✓ |
| 7 | schema.sql idempotent-only; no Phase-32 inline backfill | ✓ |

## Critical safety (whole-branch)
- **Flag-OFF dormancy absolute, grep-confirmed:** `setCycleRunner` + `startDueOrchestratorTick` called ONLY in `registerCycleRunnerIfEnabled()` (early-returns when flag unset). `enqueueCycle` only in `scanAndEnqueueDueCycles` (flag-gated tick). `drainOnce`→`[]` when no runner. Every inject/merge/verify/wave driver reachable only via `makeCycleRunner`. No other call site anywhere in hub/src. Unset flag ⇒ nothing registers/enqueues/injects/merges/redeploys.
- **Hub text-only:** no `gh`/`git`/`execSync`/`spawn`/`child_process` in the orchestrator dispatch path; merges are prompt text to the agent.
- **Cost-cap non-bypassable:** all 3 inject paths → `injectOrchestratorPrompt` → `[thresholdGate, dailyCostCapGate]`.

## QC
`check-baseline` pass=1488 / fail=0 (baseline 1320) · `build:web` clean · cycle-wiring + migration tests 18/0 · no-indigo pass.

## ENABLEMENT GATE (before `REMO_ORCHESTRATOR_ENABLED=1` in prod — does NOT block flag-OFF ship)
1. **Real-Postgres e2e soak** (queue atomic claim / SKIP LOCKED / per-session lock / idempotency / approvals / run-log / migration live SQL) — never run (no PG on build host; all DB paths dep-injected/mocked). **Primary blocker.** Run in CI with a Postgres service.
2. Confirm `REMO_VERIFY_APP_UUID/BASE_URL/ROUTES` + `COOLIFY_TOKEN` in prod.
3. Monitored canary (one repo, development stage) before fleet-wide.
