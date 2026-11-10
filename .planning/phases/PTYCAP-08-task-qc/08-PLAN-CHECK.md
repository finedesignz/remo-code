# PTYCAP Phase 8 - Plan Check (2026-10-13)

VERDICT: PASS (0 BLOCKER, 3 WARN)

## Verified
- Wave/deps: W1 = 01,02 (disjoint files); W2 = 03,04,05 (03 deps 01+02, 04 deps 01+02, 05 deps 01; no same-wave file overlap; shared files engine.ts, digest.ts, senders/task-qc.ts, api/scheduled-tasks.ts are only touched across waves, each later plan depends on the earlier); W3 = 06,07,08 (disjoint; 06 touches engine.ts/coolify.ts, 07 digest.ts/sender, 08 seed/index/registry/catchup); W4 = 09; W5 = 10. No cycles.
- Verdict.md amendments F1-A1..A6, F2-B1..B7: all mapped task -> proving test in 08-VALIDATION.md (lines 99-121); verify commands are concrete `bun test <file>`.
- ROADMAP SC1-5: SC1 detectors (02/06), SC2 allowlist + unlisted-kind guard (04: applyFix throws unlisted_fix_kind with zero SQL), SC3 never-disable + in-flight (04 never-disables grep guard, in-flight FOR UPDATE re-check), SC4 digest (07), SC5 flag OFF true no-op + report-only (06/08/09).
- Spot-checks: schema.sql scheduled_tasks.session_id DROP NOT NULL (line 277) and scheduled_task_runs.session_id nullable (line 450) => null-session run path valid (F2-B2); CHECK re-apply block at schema.sql:205 exists; fireTask (dispatcher.ts:235), registry.loadAll (registry.ts:49, index.ts:751), run-reaper task_type, scheduler/senders dir all exist. Nothing in plans touches prod or non-additive schema.
- Planner deviation (recompute_next_run_at -> proposal): ACCEPTABLE. 08-CONTEXT risk 2 explicitly allowed it; next_fire_at mirrors the live registry so a DB-only rewrite masks an unarmed job; allowlist is three input-column kinds. 08-04 hostile-kind test includes it; 08-10 records the decision in SPEC/CONTEXT.

## Issues
1. WARN: 08-CONTEXT still lists recompute_next_run_at as an allowlisted fix (lines ~47,53,148) until 08-10 Task 1 rewrites it; executors must read 08-04/08-10 as authoritative. 08-10 handles it.
2. WARN: 08-08 depends only on 08-03 (flags from 08-01 transitively); fine, but do not reorder.
3. WARN: 08-09 edits orchestrator-tokencap.e2e.test.ts (existing file); keep the change to the CHECK-list/enum assertion only.

No BLOCKERs; no plan edits needed.
