# OBSRV-01 — Run-Log Read DAL + API

**Milestone:** OBSRV (Observability)
**Branch:** `OBSRV-01-run-log-read-api`
**Requirements:** RUNLOG-01, RUNLOG-02

## Goal

Expose a read-only, user-scoped, paginated `GET /api/orchestrator/run-log` endpoint
over the existing `routine_run_log` table. Zero change to the write/dispatch path.

## Files

| File | Change |
|---|---|
| `hub/src/db/orchestrator-rows-dal.ts` | +`listRunLogForUser` — user-scoped paginated query via sessions JOIN |
| `hub/src/orchestrator/run-log.ts` | +`listRunLog` thin wrapper export |
| `hub/src/api/orchestrator.ts` | +`GET /run-log` route handler |
| `hub/src/api/_openapi.ts` | +spec-only `registerPath` for the new route |
| `hub/test/orchestrator-run-log-api.test.ts` | 8 new tests (new file) |
| `docs/openapi.json` + `docs/api.md` | regenerated |
| `tools/regression-baseline.json` | updated counts + tolerances |

## Constraints

- READ-ONLY. Zero dispatch-path changes.
- All DB queries scoped by `user_id` through `sessions` JOIN.
- Additive only — no DROP/ALTER.
- Smallest diff, matching Bun + Hono + Zod style.

## Security Invariant

`routine_run_log` has no direct `user_id` column. The query joins through
`sessions.user_id` to enforce user ownership on every read.
