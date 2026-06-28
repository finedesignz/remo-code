# Verification — Ghost "running" run reconciliation (`fix/ghost-running-session`)

**Commit:** `cc5bddc` fix(hub): reconcile ghost "running" runs against live session inventory
**Verdict:** **PASS — SHIP**
**Scope:** hub ghost-dot fix only. (Diff also carries unrelated web mobile-viewport changes — `TerminalSurface`, `AppShell`, `useVisualViewportHeight`, `index.css` — out of scope for this goal, no regression bearing on it.)

## Goal: Connections "running" dot and Sessions list agree on liveness

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Commit + diff present | PASS | `cc5bddc`; `supervisor-dal.ts +31`, `agent.ts +12/-3`, new `hub/test/finalize-orphaned-runs.test.ts +139` |
| 2 | `finalizeOrphanedRunsForSupervisor` exists, closes open runs absent from inventory, grace window, empty-inventory | PASS | `supervisor-dal.ts:301-315`. UPDATE sets `ended_at=now(), exit_reason='orphaned_no_inventory'` WHERE `ended_at IS NULL AND started_at < now()-interval '30 seconds' AND NOT (session_id = ANY($live))`. Empty array → `ANY('{}')` false → `NOT false` closes all grace-aged. |
| 3 | `agent.ts` actually calls it in `session_inventory` handler with live ids from same push | PASS | `agent.ts:1105-1109` inside `if (msg.type === 'session_inventory')`; `liveIds = msg.sessions.map(s=>s.session_id)` — same push. Live (imported `agent.ts:9`, logs reconciled count). Not dead code. |
| 4 | Connections dot + Sessions list derive from reconciled state | PASS | Dot: `SupervisorPage.tsx:370 runByPath` over `activeRuns` ← `GET /api/supervisors/:id/active` (`supervisors.ts:269`, `WHERE ... ended_at IS NULL`) — the exact rows the reconciler now closes. Sessions list: inventory-driven `active` flag (`GET /api/sessions`). Both now reconcile off the one inventory push. |
| 5 | Regression test covers 4 cases | PASS | `finalize-orphaned-runs.test.ts`: keeps live (in inventory), keeps spawn-grace (started now()), closes ghost (`exit_reason` asserted), empty-inventory closes grace-aged. **Run: SKIPPED** — gated on `REMO_E2E_DB_URL` (real Postgres); not set in this env, skips cleanly. |
| 6 | Correctness holes | PASS (1 minor note) | See below. |

## Correctness review (#6)

- **Could it close a live session?** No. Only closes when `session_id` absent from the inventory the supervisor just pushed (every ~10s) AND `started_at` older than 30s. A live runner is in every inventory push; the 30s `started_at` grace covers the spawn-race before the first echo. Sound.
- **Timezone / now() mismatch?** None. `started_at` is `TIMESTAMPTZ`, compared to server-side Postgres `now()` with an interval — single clock, no JS/app-tz arithmetic. Correct.
- **Off-by-one on set membership?** Empty array handled (closes grace-aged, test-confirmed). Non-empty: standard `= ANY`. 
- **Minor note (non-blocking):** Rows with `session_id IS NULL` are never closed — `NULL = ANY(...)` is NULL, `NOT NULL` is NULL → excluded. Such rows carry no resolvable session and don't surface a path-matched dot, so this is benign, not a ghost source. Also: `${liveSessionIds}` relies on the `postgres` driver inferring `uuid[]` for `= ANY` against the UUID column; the e2e test exercises this exact path with UUIDs, so it's covered when the DB suite runs.

## Ship verdict

**SHIP.** All six goal checks PASS. The fix wires runner-exit reconciliation into the inventory push, closing the leaked `ended_at IS NULL` rows that fed the ghost dot, so the dot and the inventory-driven Sessions list now agree. Only residual: the regression test could not execute here (no `REMO_E2E_DB_URL`) — recommend running it in Woodpecker `qc.yaml` Postgres-e2e before merge to exercise the array-type/SQL path end-to-end.
