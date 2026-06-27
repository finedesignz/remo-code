---
plan_id: 04-PLAN-011-tests-and-docs
wave: 4
depends_on: [04-PLAN-003-hub-concurrency-gate, 04-PLAN-006-coolify-deploy, 04-PLAN-007-worktree-per-session, 04-PLAN-008-self-heal-routing, 04-PLAN-009-cost-cap-hub-wide, 04-PLAN-010-web-budget-ui]
files_modified:
  - hub/test/phase04-e2e.test.ts
  - docs/coolify-supervisor.md
  - docs/self-heal-integration.md
  - docs/scheduled-tasks.md
  - CLAUDE.md
  - README.md
autonomous: false
---

# Plan 04-011 — End-to-end integration test + final documentation

Capstone plan. Wires the unit tests from each prior plan into a single e2e flow, finalizes the user-facing docs (README + CLAUDE.md per global rule #14), updates `docs/scheduled-tasks.md` to reflect the lifted cost cap, and runs a manual smoke against the live Coolify supervisor.

<tasks>

<task id="T1">
<action>Create `hub/test/phase04-e2e.test.ts` (Bun test, env-gated on `REMO_E2E_DB_URL`). One end-to-end flow:
  (1) Seed a user + a supervisor row with `concurrency_budget=2, daily_cost_cap_cents=100`;
  (2) Simulate the supervisor sending `host_resources` → assert persistence;
  (3) `POST /api/sessions/heal` twice → both succeed, third returns `at_capacity`;
  (4) Simulate a Claude `result` event with usage that puts spend over 100 cents → next reserve returns `daily_cost_cap_reached`;
  (5) End one session (set `ended_at = now()`) → reserve succeeds again only IF still under cost cap (so this case asserts the cost cap takes precedence over capacity);
  (6) Set `concurrency_override = 4` via PATCH → reserve allows two more (proves override raises the cap);
  (7) Set `preferred_supervisor_id` → next heal routes to the preferred one even with other supervisors online.
This is the single "did Phase 04 actually do what it promised" test.</action>
<read_first>
- All prior phase 04 test files (Plans 001, 002, 003, 007, 008, 009) — this is the integration of their pieces
- hub/test/scheduled-tasks.e2e.test.ts (DB fixture + skip-on-no-DB pattern)
</read_first>
<acceptance_criteria>
- `bun test hub/test/phase04-e2e.test.ts` green with `REMO_E2E_DB_URL` set
- All 7 steps assert observable state transitions
- Test cleans up rows in afterAll (no leaked supervisors / session_runs / cost_usage rows)
- Failure messages on each step name which behavior broke ("step 4: expected daily_cost_cap_reached, got <reason>")
</acceptance_criteria>
</task>

<task id="T2">
<action>Update `docs/coolify-supervisor.md` (from Plan 006). Add sections that were dependent on later plans being complete: link to `docs/self-heal-integration.md` (Plan 008), document the live `MB_PER_SESSION` value chosen by Plan 004 measurement, add a "Common errors and what they mean" appendix (`at_capacity`, `daily_cost_cap_reached`, `branch_in_use`, `supervisor_not_found`, `no_target_available`). Add a "Tested via" note pointing at `hub/test/phase04-e2e.test.ts`.</action>
<read_first>
- docs/coolify-supervisor.md (current state from Plan 006)
- docs/budget-measurement.md (from Plan 004)
- All error reasons defined in Plans 003, 007, 008, 009 (grep for the literal strings)
</read_first>
<acceptance_criteria>
- All 5 error reasons listed with cause + recovery action
- Link to self-heal doc resolves
- The chosen `MB_PER_SESSION` value is documented with the measurement date
</acceptance_criteria>
</task>

<task id="T3">
<action>Update `docs/scheduled-tasks.md` (existing doc per project CLAUDE.md). Reflect that the per-user daily cost cap is now hub-wide (Plan 009), not scheduler-local. Add a "Cost cap interaction" subsection: the scheduler's own per-task cap remains as a narrower secondary check; both gates fire; the hub-wide cap is the broader gate that also covers interactive + self-heal. Update the env-vars section if anything changed.</action>
<read_first>
- docs/scheduled-tasks.md (entire — match its existing structure)
- hub/src/scheduler/dispatcher.ts (post-Plan-009 state)
</read_first>
<acceptance_criteria>
- Doc reflects the lifted cap with a clear "as of Phase 04" note
- Scheduler-local cap is documented as a secondary gate, not the primary
- No stale references to the scheduler being the only place cost is tracked
</acceptance_criteria>
</task>

<task id="T4">
<action>Update `CLAUDE.md` (project root, per global rule #14). Add a new section after "Scheduled Tasks": "Coolify Dev Supervisor" — what it is (one-supervisor-many-children model), where the code lives (`supervisor/src/`, `supervisor/Dockerfile`), env vars required (`ANTHROPIC_API_KEY`, `REMO_API_KEY`, `GITHUB_TOKEN`, plus the standard `REMO_HUB_URL`), key files (resources.ts, worktree-manager.ts, sessions/budget.ts, sessions/cost-cap.ts, sessions/routing.ts), test commands, link to `docs/coolify-supervisor.md`. Mention the contract for adding a new heal call (POST /api/sessions/heal) and the cost-cap behavior. Mirror the style of the existing "Scheduled Tasks" section.</action>
<read_first>
- CLAUDE.md (entire — match the section style + the level of detail in "Scheduled Tasks")
</read_first>
<acceptance_criteria>
- New section is positioned after "Scheduled Tasks"
- All key files are listed with paths
- The contract for self-heal POST is documented with the body shape
- README and CLAUDE.md cross-reference each other where appropriate
</acceptance_criteria>
</task>

<task id="T5">
<action>Update `README.md`. Add a short "Coolify Dev Supervisor" section under the existing architecture overview — one paragraph explaining the optional remote supervisor model + how to enable it (link to `docs/coolify-supervisor.md`). Update the architecture diagram / packages list if a "Now also runs on Coolify" footnote helps. Keep the README terse; depth lives in the docs/.</action>
<read_first>
- README.md (entire — current architecture section)
</read_first>
<acceptance_criteria>
- New section is one to two paragraphs, links to docs/coolify-supervisor.md
- No duplication of detail that already lives in the docs
- Existing local-agent flow remains the documented default; remote supervisor is positioned as optional
</acceptance_criteria>
</task>

<task id="T6" type="checkpoint:human-verify">
<what-built>All Phase 04 tests green; docs published; live Coolify supervisor in use.</what-built>
<how-to-verify>
1. `bun test` (full suite) — expect green
2. `bun test hub/test/phase04-e2e.test.ts` with `REMO_E2E_DB_URL` set — expect green
3. Render `docs/coolify-supervisor.md` + `docs/self-heal-integration.md` + `docs/budget-measurement.md` in a markdown viewer — no broken links, no TODO markers
4. Live: `POST /api/sessions/heal` triggers a Coolify-side session; web UI shows budget + cost updating
5. Force at-capacity: spawn `cap` parallel heals → (cap+1)th returns 429 `at_capacity`
6. Force at-cost: set `daily_cost_cap_cents = 1`, try to spawn → 429 `daily_cost_cap_reached`
7. Drain-before-deploy procedure works (test by manually pushing a no-op image rev to Coolify and following the doc)
</how-to-verify>
<resume-signal>Confirm all 7 verification steps pass, or list what failed. On full pass: I'll move Phase 04 status to Done in ROADMAP and close.</resume-signal>
</task>

</tasks>

must_haves:
- A single e2e test exists that exercises the full Phase 04 surface (host_resources → reserve → cost cap → release → override → preferred routing)
- Full test suite is green
- All four user-facing docs (coolify-supervisor, self-heal-integration, budget-measurement, scheduled-tasks) are coherent and cross-linked
- CLAUDE.md + README.md updated per global rule #14
- Live Coolify supervisor verified to obey both capacity and cost gates

rollback_plan:
- Docs are append-only; test failures unblock by reverting the specific code plan, not this plan. This plan is the gate, not new code surface.

risks:
- The e2e test is the longest in the suite — runtime budget may exceed existing CI test timeouts. Bun's test runner has no built-in slow-test isolation; add a separate `bun test hub/test/phase04-e2e.test.ts` step in CI if needed.
- Doc drift across 6 files is real; the cross-linking + the single e2e test as the "ground truth" mitigates.
