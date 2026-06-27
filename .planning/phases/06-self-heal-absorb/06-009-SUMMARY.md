---
phase: 06-self-heal-absorb
plan: 009
status: paused-at-checkpoint
tasks_completed: 1
tasks_total: 2
---

# Plan 06-009: Retire `coolify-ai-monitor` — Summary (in-progress)

## One-liner
Authored the migration runbook for retiring the legacy `coolify-ai-monitor` Coolify app; paused at the human-verify checkpoint that requires stopping the live app.

## Completed Tasks

| Task | Name                                          | Commit  | Files                                  |
| ---- | --------------------------------------------- | ------- | -------------------------------------- |
| 1    | Write coolify-webhook-migration runbook       | 5412243 | docs/coolify-webhook-migration.md      |

## Paused Task

**Task 2 (checkpoint:human-verify):** Confirm 7-day soak complete and stop `coolify-ai-monitor`. This is a destructive action against a live Coolify app and requires the user to perform it manually per the executor mandate.

## Runbook contents (docs/coolify-webhook-migration.md)
1. Why retire — Phase 06 absorbed G2/G3/G4/G5/G6.
2. Pre-cutover checklist — secret rotated, signed curl returns 202.
3. Cutover — Coolify webhook URL → `https://app.remo-code.com/api/coolify/webhook/<user_id>` with `X-Coolify-Signature` + `X-Coolify-Timestamp`.
4. Soak — 7 days, `|A - B| / max(A, B) < 0.10`.
5. Retire — stop (not delete) in Coolify UI; 30-day rollback window.
6. Port-map cleanup — deferred to plan 010.

## Deviations from Plan
None — runbook authored exactly as specified.

## Self-Check: PASSED
- `docs/coolify-webhook-migration.md` exists.
- Contains `X-Coolify-Signature` and `soak`.
- Commit `5412243` present on `feat/phase-06-self-heal-absorb`.

## Next
User performs Task 2 manually (7-day soak validation + stop Coolify app). On confirmation, advance to plan 010 (tests + docs cleanup, which also removes port 3032 from the global port map).
