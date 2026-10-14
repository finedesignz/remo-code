# PTYCAP-04 planner-fork panel -- locked verdicts (2026-10-13)

Seats: Claude (sonnet, read-only), Codex (`codex exec --sandbox read-only`). Plan-check: gsd-plan-checker (sonnet), 04-PLAN-CHECK.md.
Orchestrator synthesis: an evidenced overturn wins over an unevidenced confirm; ties go to the locked 04-CONTEXT decision.

| Fork | Claude | Codex | LOCKED |
|---|---|---|---|
| F-1 boot split | CONFIRM | CONFIRM | CONFIRM (R) |
| F-2 human/machine split | CONFIRM | OVERTURN: /api/sessions/heal (hub/src/api/sessions.ts:375-389, 438-450) is an external self-heal service emitting session.start outside the guarded launch primitives | R + classify /api/sessions/heal as MACHINE: kill-switch halt check + lifetime key before its session.start; add it to the enumerating session.start sender pin |
| F-3 reserve | CONFIRM | OVERTURN: preSendGuard runs before store.open/markDispatched awaits (pipeline.ts:300-308, 483-497), so it is not D-09c's immediate final check | R (advisory lock in sql.begin + releaseAndPromote on skip) + SEPARATE the final halt check: it runs immediately before deps.send, after store.open/markDispatched; a halt there releases the reservation and the queue slot |
| F-4 orphan/once | CONFIRM | OVERTURN: release resumes only admin supervisors; halt between claim and send burns a once task (dispatcher.ts:97-127) | Event-driven resume for EVERY released scope (global, user, session -> resume the deferred work in that scope); a halt detected after claimOnceTask re-arms the once task (restores its claim) instead of finalizing it. Do not change the existing once-due sweep cadence (out of scope) |
| F-5a literal lifetime cap | CONFIRM + 80% warning page | CANNOT-CONCLUDE (is indefinite recurrence promised?) | RESOLVED from ROADMAP SC-1 text itself ("4/hr forever is still 35,000/year"): indefinite recurrence without reauthorization is exactly what SC-1 forbids. Literal cap (A), default 1000, env-raisable, owner reset; ADD a one-shot warning page at 80% of the cap per counter key and reset epoch (same ledger page-row mechanism as F-9). Documented prominently in docs + PR body. Not an owner question. |
| F-5b triage key | OVERTURN -> `triage:<application_uuid>` | OVERTURN -> C (per application_uuid; mandatory field, triage.ts:48-53, coolify-webhook.ts:108-114) | Per-application key `triage:<application_uuid>` |
| F-5c orchestrator key | OVERTURN -> session:<id> | CONFIRM (one orchestrator task per session, indexed lookup schema.sql:288-294) | CONFIRM (R) `task:<id>` via resolver (matches locked D-01) |
| F-6 door/rate | CONFIRM | OVERTURN: max(run-log, ledger) undercounts mixed sources; read-then-reserve races | One ATOMIC reservation inside the advisory lock that checks BOTH lifetime count and trailing-60-min rate count, where the rate count is the de-duplicated set union of the session's routine_run_log inject rows and ledger reserve rows (not max). counterKey + turnToken required at the door; door owns consumption |
| F-7 alarm listener | CONFIRM | CONFIRM | CONFIRM (R) |
| F-8 e2e skip | CONFIRM (uses last skip slot) | OVERTURN: D-19 says no new skips | ZERO new skipped tests: extend an existing DB-gated e2e test body (hub/test/e2e/) instead of adding a new skipped test(); skip count stays 259 |
| F-9 page rows | CONFIRM | CONFIRM | CONFIRM (R); count queries must filter to reserve rows only |

## Plan-check MAJOR (real-Postgres proof) -- locked fix
No local Docker/Postgres on this host. The DB-backed e2e assertions (reserve under advisory lock, kill-switch partial unique
indexes, ON CONFLICT claims, count-after-reset, casts) move into the wave-2 plan (04-02) by extending an existing e2e test
body (F-8). After 04-02 lands, the orchestrator pushes the branch and opens the Phase-4 PR as a DRAFT (base = Phase-3
branch) so Woodpecker qc (postgres:16 service, REMO_E2E_DB_URL) proves the SQL early. The result is read once at phase end (no polling).

## Plan-check MINORs -- locked fixes
- 04-05: admin helper path is hub/src/auth/require-admin.ts.
- 04-08:T3: "cap change is the last CODE commit" (summary/STATE/verification commits may follow); replace the tautological git log -1 check with a check that no hub/src or supervisor/src commit follows the cap commit.
- Plans 03-07: list the leaf-mock test files they repair in files_modified; wave-3 plans execute sequentially in one worktree.
- 04-02:T1: split into smaller tasks (schema; controls module; pipeline wiring; tracer test).
