---
plan_id: 04-PLAN-008-self-heal-routing
wave: 3
depends_on: [04-PLAN-002-schema-and-migration, 04-PLAN-003-hub-concurrency-gate]
files_modified:
  - hub/src/api/sessions.ts
  - hub/src/sessions/routing.ts
  - hub/test/self-heal-routing.test.ts
  - docs/self-heal-integration.md
autonomous: true
requirements: [REQ-HEAL-01, REQ-HEAL-02]
---

# Plan 04-008 — `POST /api/sessions/heal` + supervisor-selection logic

Per ARCHITECTURE-REVIEW §6: self-heal becomes a thin HTTP client. It posts `{repo, branch, prompt}` to the hub; the hub picks a target supervisor using a deterministic resolution order (preferred → first-online-with-capacity → local-agent → 503). Self-heal no longer needs to know where Claude runs. The external claude-code-self-heal service (port 9114) is its consumer; this plan ships the hub endpoint + routing logic, NOT changes to that external service.

<tasks>

<task id="T1">
<action>Create `hub/src/sessions/routing.ts` exporting `async pickSessionTarget(userId, opts?: { excludeSupervisorIds?: string[] }): Promise<{ kind: 'supervisor'; supervisor_id: string; running: number; cap: number } | { kind: 'local_agent'; agent_session_id: string } | { kind: 'none'; reason: string }>`. Resolution order (matching ARCHITECTURE-REVIEW §6):
  1. If user's `preferred_supervisor_id` IS NOT NULL AND that supervisor is online (recent `last_seen_at`, e.g. within 90s) AND `reserveSessionSlot` returns ok → return `kind: 'supervisor'` (DO NOT release the reservation — caller owns it; the function reserves the slot atomically as part of selection so two heal calls can't both win the last slot).
  2. Else iterate all of the user's online supervisors ordered by `last_seen_at ASC` (oldest connection first, deterministic) and try `reserveSessionSlot` on each; return the first success.
  3. Else if a local agent is connected (existing agent registry check), return `kind: 'local_agent'`.
  4. Else return `kind: 'none', reason: 'no_target_available'`.
Use `excludeSupervisorIds` to support retries from the caller. The function is the SINGLE source of truth for routing — scheduler dispatcher (Plan 003 caller) and the new `/api/sessions/heal` route both use it.</action>
<read_first>
- hub/src/sessions/budget.ts (from Plan 003 — the reservation primitive)
- hub/src/ws/registry.ts + hub/src/ws/supervisor-registry.ts (how online state is tracked today)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §6
</read_first>
<acceptance_criteria>
- Preferred supervisor online + has capacity → always wins
- Preferred supervisor offline → falls through to step 2 without error
- All supervisors at capacity AND local agent connected → returns `local_agent`
- Nothing available → returns `kind: 'none'` (NOT a throw)
- The slot reservation is held on success — caller must release on failure / session end
- Deterministic ordering in step 2 (by `last_seen_at ASC`) — same DB state always picks the same supervisor
</acceptance_criteria>
</task>

<task id="T2">
<action>Add `POST /api/sessions/heal` to `hub/src/api/sessions.ts`. Behind JWT auth. Zod-validated body: `{ repo: string, branch: string, prompt: string, model?: string, exclude_supervisor_ids?: string[] }`. Flow: (a) call `pickSessionTarget(userId, { excludeSupervisorIds })`; (b) if `kind === 'none'` return 503 `{ error: 'no_target_available' }`; (c) if `kind === 'supervisor'`, dispatch a `create_child_session` WS message to that supervisor with `{ session_id: <new uuid>, repo, branch, initial_prompt: prompt, model }` and INSERT a `session_runs` row binding the slot reservation; (d) if `kind === 'local_agent'`, dispatch the equivalent to the local agent registry (existing path); (e) return 202 `{ session_id, target_kind, supervisor_id?, url: '/s/' + session_id }`. On supervisor dispatch failure (e.g. WS write throws), call `releaseSessionSlot` and recurse via `excludeSupervisorIds` (at most 3 hops total, then 503).</action>
<read_first>
- hub/src/api/sessions.ts (existing session-creation pattern + auth shape)
- hub/src/ws/supervisor-registry.ts (how to dispatch a message to a specific supervisor)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md "Happy Path" sequence
</read_first>
<acceptance_criteria>
- Returns 202 with `session_id` + `target_kind` on success
- Returns 503 `{ error: 'no_target_available' }` when nothing's online
- Body validation rejects missing `repo`/`branch`/`prompt` with 400
- The `session_runs` row exists with `supervisor_id` set and `ended_at IS NULL` immediately after the 202
- Retry-with-exclude works: simulate WS dispatch failure for supervisor X → endpoint excludes X and tries the next; verify in test
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `hub/test/self-heal-routing.test.ts` (Bun test, env-gated on `REMO_E2E_DB_URL`). Cases: preferred supervisor wins; preferred offline → falls through; all supervisors at-cap + local agent → returns local; nothing available → 503; retry with `exclude_supervisor_ids` skips the named supervisor; race two `POST /heal` calls when only 1 slot remains → exactly one 202 + one 503 (proves the atomic reservation inside `pickSessionTarget`).</action>
<read_first>
- hub/test/supervisor-budget.test.ts (from Plan 003 — race-test pattern)
- hub/test/scheduled-tasks.e2e.test.ts (DB fixture + skip-on-no-DB pattern)
</read_first>
<acceptance_criteria>
- `bun test hub/test/self-heal-routing.test.ts` green with `REMO_E2E_DB_URL` set
- Race case asserts exactly 1 succeeds and 1 fails (no double-spend of the last slot)
- Test cleans up `session_runs` rows in afterAll
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `docs/self-heal-integration.md`. Documents the contract for the external `claude-code-self-heal` service (port 9114 per global CLAUDE.md): how to call `POST https://app.remo-code.com/api/sessions/heal`, required JWT, body shape, response shape, retry semantics, the `exclude_supervisor_ids` parameter, and the planned cut-over (self-heal continues to fall back to local during the proving period per ARCH-REVIEW "Do NOT" list). Cross-reference `docs/coolify-supervisor.md` for the supervisor-side setup.</action>
<read_first>
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §6 + "Do NOT" item about not migrating self-heal away from local until two weeks of stability
- docs/coolify-supervisor.md (from Plan 006 — link target)
</read_first>
<acceptance_criteria>
- Doc shows the curl example + JSON shapes
- Documents the local-fallback rule explicitly (don't migrate away until 2 weeks stable)
- Lists every error code returned (400, 401, 503) with cause
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `pickSessionTarget` is the single source of routing truth used by `/api/sessions/heal` and the scheduler dispatcher (Plan 003)
- Resolution order matches ARCH-REVIEW exactly: preferred → first-online-with-capacity → local-agent → 503
- The slot reservation is atomic with the selection so two concurrent heal calls can't double-spend
- External self-heal service has a stable, documented HTTP contract to call
- Local-agent fallback remains intact during the proving period

rollback_plan:
- Remove the `/api/sessions/heal` route; external self-heal service continues calling its old local path. No DB cleanup needed.

risks:
- The external `claude-code-self-heal` service must be updated separately to call the new endpoint — that change is OUT OF SCOPE for this phase, only documented here. Coordinate with the user before flipping the cut-over.
- "Online" detection via `last_seen_at < 90s` may have edge cases on flapping connections; conservative threshold acceptable for v1.
