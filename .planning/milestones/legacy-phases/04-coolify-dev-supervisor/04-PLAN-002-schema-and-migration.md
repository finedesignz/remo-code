---
plan_id: 04-PLAN-002-schema-and-migration
wave: 1
depends_on: []
files_modified:
  - hub/src/db/schema.sql
  - hub/src/ws/supervisor-registry.ts
  - hub/src/api/supervisors.ts
  - hub/test/supervisor-resources.test.ts
autonomous: true
requirements: [REQ-SCHEMA-01, REQ-HUB-PERSIST-01]
---

# Plan 04-002 — Schema additions for budget + preferred supervisor + persistence handler

Add the columns the hub needs to remember each supervisor's reported budget, an admin/user-controlled override, a per-user daily cost cap, and a user-level preferred supervisor for self-heal routing (Plan 008 consumes the last one). Wire the `host_resources` WS handler from Plan 001 to actually UPDATE the supervisor row.

<tasks>

<task id="T1">
<action>Append to `hub/src/db/schema.sql` (idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` style — match the existing pattern at line 59 / 179). New columns on `supervisors`: `cpu_cores INTEGER`, `total_mem_mb INTEGER`, `free_mem_mb INTEGER`, `concurrency_budget INTEGER NOT NULL DEFAULT 1`, `concurrency_override INTEGER` (nullable; when set, hub uses `min(concurrency_override, concurrency_budget * 2)` per ARCHITECTURE-REVIEW §3), `budget_source TEXT` (one of `'cgroup_v2'|'cgroup_v1'|'host_fallback'`), `budget_updated_at TIMESTAMPTZ`. New columns on `users`: `preferred_supervisor_id TEXT REFERENCES supervisors(id) ON DELETE SET NULL`, `daily_cost_cap_cents INTEGER NOT NULL DEFAULT 2000` (default $20 per ARCHITECTURE-REVIEW §7). Add index `CREATE INDEX IF NOT EXISTS idx_users_preferred_supervisor ON users(preferred_supervisor_id) WHERE preferred_supervisor_id IS NOT NULL`.</action>
<read_first>
- hub/src/db/schema.sql (entire file — match the IF NOT EXISTS pattern at line 59 + 179; verify `supervisors` definition at line 90)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §2, §3, §6, §7
</read_first>
<acceptance_criteria>
- Re-running `schema.sql` is a no-op on a DB that already has the columns (verified by booting hub twice)
- `\d supervisors` shows all 7 new columns with the documented types + defaults
- `\d users` shows `preferred_supervisor_id` FK to `supervisors(id)` with `ON DELETE SET NULL` and `daily_cost_cap_cents` defaulting to 2000
- The partial index on `users(preferred_supervisor_id)` exists and skips NULL rows
</acceptance_criteria>
</task>

<task id="T2">
<action>In `hub/src/ws/supervisor-registry.ts` (or wherever supervisor WS messages are dispatched — confirm via grep), add a handler for the `host_resources` message stubbed in Plan 001. The handler validates with the Zod schema from `supervisor-protocol.ts`, then runs a single UPDATE: `UPDATE supervisors SET cpu_cores=$1, total_mem_mb=$2, free_mem_mb=$3, concurrency_budget=$4, budget_source=$5, budget_updated_at=now() WHERE id=$6`. Use the supervisor's authenticated `id` from the WS connection context — do NOT trust any ID in the payload. Also broadcast a `supervisor_resources_updated` WS event (extend `hub/src/ws/protocol.ts`) to the user's connected clients so the web UI re-renders without polling.</action>
<read_first>
- hub/src/ws/supervisor-registry.ts (existing dispatch table; identify where messages route)
- hub/src/ws/protocol.ts (client-bound message union; add the broadcast variant)
- .planning/codebase/CONVENTIONS.md (Database Access — `WHERE user_id = $1` discipline)
</read_first>
<acceptance_criteria>
- Replay a `host_resources` payload via integration test and observe the supervisor row gets updated with the right values and `budget_updated_at` is fresh
- Supervisor cannot UPDATE another supervisor's row (the WHERE clause uses the auth'd ID, not payload)
- A subscribed web client receives `supervisor_resources_updated` within 200ms of the supervisor message
</acceptance_criteria>
</task>

<task id="T3">
<action>Add two endpoints to `hub/src/api/supervisors.ts` (behind existing JWT auth, `userId` from context). `PATCH /api/supervisors/:id/override` with Zod-validated body `{ concurrency_override: number | null }` — sets/clears the override on a supervisor the user owns. Hub MUST clamp the value to `<= concurrency_budget * 2` and `>= 1`; reject anything else with 400. `PATCH /api/users/me/preferred-supervisor` with body `{ supervisor_id: string | null }` — sets/clears the user's `preferred_supervisor_id`; verifies the chosen supervisor is owned by the user (404 otherwise — don't leak existence).</action>
<read_first>
- hub/src/api/supervisors.ts (existing GET/list patterns)
- hub/src/api/sessions.ts (Zod body validation + 4xx error shape `{ error: string }`)
</read_first>
<acceptance_criteria>
- `override = budget * 3` returns 400 with `{ error: 'override_exceeds_ceiling', max: budget * 2 }`
- `override = null` clears the column (hub will then use raw `concurrency_budget`)
- Cross-user PATCH attempts return 404
- Both endpoints return the updated row JSON on success
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `hub/test/supervisor-resources.test.ts` (Bun test, env-gated on `REMO_E2E_DB_URL` per existing pattern). Cases: persistence of a valid `host_resources` payload; override clamp (request `budget * 3` returns 400, request `budget * 2` succeeds, request `null` clears); preferred-supervisor set + ownership filter (user A cannot set their preferred to user B's supervisor); schema re-run is idempotent.</action>
<read_first>
- hub/test/scheduled-tasks.e2e.test.ts (env-gated skip pattern, DB fixture pattern)
- hub/test/scheduler.test.ts (assertion style)
</read_first>
<acceptance_criteria>
- `bun test hub/test/supervisor-resources.test.ts` green with `REMO_E2E_DB_URL` set; skips cleanly without it
- Every assertion uses `expect(...).toBe/toEqual(...)` style
- No test leaves rows behind (fixture cleanup in afterAll)
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `supervisors` has `cpu_cores`, `total_mem_mb`, `free_mem_mb`, `concurrency_budget`, `concurrency_override`, `budget_source`, `budget_updated_at`
- `users` has `preferred_supervisor_id` (FK, ON DELETE SET NULL) and `daily_cost_cap_cents` (default 2000)
- `host_resources` WS message persists to the auth'd supervisor row + broadcasts `supervisor_resources_updated`
- Override is hard-clamped to `[1, budget * 2]` server-side
- Preferred-supervisor PATCH refuses cross-user assignment (404, no existence leak)

rollback_plan:
- Drop columns via reverse migration; the WS handler tolerates a NULL budget (treats as 1). UI fallback is to hide the chip when `budget_updated_at IS NULL`.

risks:
- Adding NOT NULL to `concurrency_budget` with DEFAULT 1 means every existing supervisor row gets `1` until it next reports. Acceptable — first `host_resources` message corrects it within seconds of supervisor restart.
