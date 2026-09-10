---
plan_id: 04-PLAN-003-hub-concurrency-gate
wave: 2
depends_on: [04-PLAN-002-schema-and-migration]
files_modified:
  - hub/src/sessions/budget.ts
  - hub/src/api/sessions.ts
  - hub/src/scheduler/dispatcher.ts
  - hub/src/ws/supervisor-registry.ts
  - hub/test/supervisor-budget.test.ts
autonomous: true
requirements: [REQ-HUB-01, REQ-HUB-02]
---

# Plan 04-003 — Hub-authoritative concurrency gate

Per ARCHITECTURE-REVIEW §3, the hub — not the web UI, not the supervisor — is the source of truth for how many parallel sessions a supervisor may run. This plan ships `reserveSessionSlot` / `releaseSessionSlot`, wires them into every session-creation path (REST, scheduler dispatcher, future self-heal in Plan 008), and broadcasts capacity changes so the UI updates without polling.

<tasks>

<task id="T1">
<action>Create `hub/src/sessions/budget.ts` with exports: `async reserveSessionSlot(userId, supervisorId): Promise<{ ok: true; running: number; cap: number } | { ok: false; reason: 'at_capacity' | 'supervisor_not_found'; running?: number; cap?: number }>` and `async releaseSessionSlot(userId, supervisorId): Promise<void>`. `reserveSessionSlot` runs inside a transaction: `BEGIN; SELECT concurrency_budget, concurrency_override FROM supervisors WHERE id=$1 AND user_id=$2 FOR UPDATE;` — compute `cap = LEAST(COALESCE(concurrency_override, concurrency_budget), concurrency_budget * 2)`; `SELECT COUNT(*) FROM session_runs WHERE supervisor_id=$1 AND ended_at IS NULL` for `running`; if `running >= cap`, ROLLBACK + return `{ ok: false, reason: 'at_capacity', running, cap }`; else COMMIT (the actual row insert into `session_runs` is the caller's responsibility — this function just gates). `releaseSessionSlot` is a no-op for now (the gate counts open `session_runs`); kept as an explicit function so future migrations can switch to a dedicated counter without re-touching every caller.</action>
<read_first>
- hub/src/db/dal.ts (transaction style — `db.begin(async (sql) => ...)` or equivalent)
- hub/src/db/schema.sql (session_runs definition at line 106, supervisors at line 90)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §3 (atomic SELECT FOR UPDATE rationale)
</read_first>
<acceptance_criteria>
- Concurrent calls from two connections targeting the same supervisor at cap result in exactly one `ok: true` and one `ok: false` (verified by integration test with 2 connection pool clients)
- `cap` correctly applies the `* 2` ceiling to override values
- Returns `{ ok: false, reason: 'supervisor_not_found' }` for unknown or cross-user supervisor IDs
- No row insert into `session_runs` from inside `reserveSessionSlot` (caller's job)
</acceptance_criteria>
</task>

<task id="T2">
<action>Wire `reserveSessionSlot` into every existing session-creation path:
  (a) `hub/src/api/sessions.ts` — wherever `POST /api/sessions` (or the supervisor-bound equivalent) creates a `session_run`. Call `reserveSessionSlot` first; on `ok: false` return 429 `{ error: reason, running, cap }`.
  (b) `hub/src/scheduler/dispatcher.ts` — before dispatching a scheduled task to a supervisor target. On at-capacity, skip the run with a `skipped` row reason `'at_capacity'` (match existing skip patterns in the dispatcher).
  (c) `hub/src/ws/supervisor-registry.ts` — on `session_started` WS message (or wherever the supervisor announces a new run inbound), assert via a soft check that the slot was reserved; if not, log a warning (the gate should already have caught it; this is belt-and-suspenders).
After session ends (via the existing `session_runs.ended_at` update or `session_status: 'closed'` path), call `releaseSessionSlot(userId, supervisorId)` and broadcast a `supervisor_capacity_changed` WS event to subscribed clients with `{ supervisor_id, running, cap }`.</action>
<read_first>
- hub/src/api/sessions.ts (entire file — find every session creation site)
- hub/src/scheduler/dispatcher.ts (cost-cap pattern — mirror its "skip with reason" shape)
- hub/src/ws/supervisor-registry.ts (existing supervisor message routing)
- hub/src/ws/protocol.ts (where to add the broadcast variant)
</read_first>
<acceptance_criteria>
- `POST /api/sessions` with a supervisor at cap returns 429 with `{ error: 'at_capacity', running, cap }`
- Scheduler dispatcher logs/records a skipped run when at-capacity instead of dispatching anyway
- `supervisor_capacity_changed` fires on both reserve (running ↑) and release (running ↓), within 200ms
- `grep -n "reserveSessionSlot\|releaseSessionSlot" hub/src` finds every session creation/teardown site
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `hub/test/supervisor-budget.test.ts` (Bun test, env-gated on `REMO_E2E_DB_URL`). Cases:
  (a) reserve N times where N = cap succeeds; (N+1)th returns `at_capacity` with correct counts;
  (b) override = budget + 1 raises cap accordingly;
  (c) override = budget * 3 is clamped at server (this is enforced by Plan 002's PATCH endpoint — verify via API call);
  (d) ending a session_run (set `ended_at = now()`) makes the next reserve succeed;
  (e) concurrent reserve race: spawn 5 parallel reserves with cap=3 → exactly 3 succeed, 2 return at_capacity (proves the FOR UPDATE lock works);
  (f) cross-user reserve returns `supervisor_not_found`.</action>
<read_first>
- hub/test/scheduled-tasks.e2e.test.ts (DB fixture pattern, env gating)
- hub/src/sessions/budget.ts (the unit under test)
</read_first>
<acceptance_criteria>
- `bun test hub/test/supervisor-budget.test.ts` green with `REMO_E2E_DB_URL` set
- Race case (e) uses `Promise.all` of 5 reserves and asserts exact counts
- No test leaves session_runs behind (cleanup in afterAll)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `reserveSessionSlot` is atomic (`SELECT ... FOR UPDATE` in a tx), returns precise `{running, cap}`, refuses cross-user supervisors
- Every session-creation path in the hub calls `reserveSessionSlot` before dispatch; UI cap is decorative (Plan 010)
- Capacity changes broadcast as `supervisor_capacity_changed` so the UI re-renders without polling
- Cap is `LEAST(COALESCE(override, budget), budget * 2)` — the ceiling is enforced server-side

rollback_plan:
- Revert the wiring in callers; `budget.ts` is dead code but harmless. Plan 002 schema additions stay (no-op without callers).

risks:
- Counting via `SELECT COUNT(*) FROM session_runs WHERE ended_at IS NULL` works correctly only if every session run reliably sets `ended_at`. Audit existing close paths — if any leak, sessions appear stuck "running" and block new reservations. Add a periodic reaper later if needed.
- Scheduler dispatcher skip semantics must match existing "skipped" patterns or run-history reports break. Mirror exactly.
