# Phase 04 - Plan Check (Pre-Execution Verification)

**Date:** 2026-05-25
**Checker:** gsd-plan-checker (goal-backward, adversarial stance)
**Phase dir:** `.planning/phases/04-coolify-dev-supervisor/`
**Plans verified:** 11 (04-PLAN-001 through 04-PLAN-011)

---

## Overall verdict

**PASS-WITH-REVISIONS** - Plans cover every clause of the phase goal with traceable file-level tasks and a coherent wave graph. Two MAJOR issues and seven MINOR issues must be fixed before YOLO execution; none invalidate the architecture.

---

## 1. Goal-clause coverage

| # | Goal clause (paraphrased) | Plans | Verdict | Notes |
|---|---|---|---|---|
| G1 | Lean dev-only supervisor on Coolify with Claude Code CLI + git | 005 + 006 + 007 | COVERED | Non-root, no exposed ports, secrets via Coolify env. ARCH-REVIEW sections 1/4/8 honored. |
| G2 | Hosts self-heal sessions off the local desktop | 008 | COVERED | Local-agent fallback retained per ARCH-REVIEW Do-NOT-migrate-away-from-local-for-2-weeks rule. |
| G3 | Server reports CPU/RAM/concurrency budget to hub | 001 + 002 | COVERED | host_resources sent on connect + every 60s + on reconnect; persistence broadcasts supervisor_resources_updated. Source pill surfaces cgroup_v2 / cgroup_v1 / host_fallback. |
| G4a | UI auto-caps parallel sessions to budget | 003 + 010 | COVERED | Hub authoritative (reserveSessionSlot atomic SELECT FOR UPDATE wired into REST + scheduler + self-heal); UI decorative per ARCH-REVIEW section 3. |
| G4b | With user override | 002 + 003 + 010 | COVERED | PATCH /api/supervisors/:id/override clamps server-side to [1, budget*2]; cap = LEAST(COALESCE(override, budget), budget*2); slider mirrors. |
| G5 | Self-heal errors/tasks routed to remote supervisor instead of local | 008 | COVERED | pickSessionTarget resolution: preferred -> first-online-with-capacity -> local -> 503. |

No orphan clauses. All 5 goal clauses (G1-G5) map to >=1 plan with concrete tasks.

---

## 2. Wave-dependency sanity

- Wave 1: 001 (no deps), 002 (no deps)
- Wave 2: 003 -> 002; 005 (no deps); 007 (no deps)
- Wave 3: 006 -> 005, 001, 002; 008 -> 002, 003; 009 -> 002, 003
- Wave 4: 004 -> 006, 007; 010 -> 002, 003, 009; 011 -> 003, 006, 007, 008, 009, 010

No cycle, no future reference, dependency wave-number is always less than dependent wave-number. PASS.

**MINOR M1:** Plan 001 introduces host_resources schema in hub/src/ws/supervisor-protocol.ts. Plan 002 T2 adds the persistence handler that imports the schema from Plan 001. Plan 002 declares depends_on: []. Both plans edit nearby code in hub/src/ws/supervisor-protocol.ts and supervisor-registry.ts. Wave-1 parallel execution may collide on the same file regions.

---

## 3. Acceptance-criteria executability

Every task has acceptance_criteria with at least one runnable check (bun test, grep, docker build, psql backslash-d, curl). Checkpoint tasks (004 T2, 006 T3, 010 T6, 011 T6) correctly use type=checkpoint:human-verify with explicit resume-signals. PASS.

---

## 4. Risk-coverage / deferral documentation

| Required deferral | Where documented | Status |
|---|---|---|
| Per-child cgroup hard limits (ARCH risk #2) | PHASE-INDEX Out-of-scope; ARCH-REVIEW Risk Register #2; NOT mentioned in Plan 005 or 007 risks | MINOR M2 |
| External claude-code-self-heal cut-over deferred 2 weeks | Plan 008 risks + T4 doc body | COVERED |
| 800 MB heuristic is a guess until Plan 004 measures | Plan 001 risks; Plan 004 description; MB_PER_SESSION exported as named const | COVERED |
| Anthropic API key billing separate from MAX subscription | ARCH-REVIEW section 4 + Plan 006 risks + T2 doc | COVERED |
| Drain-before-deploy | Plan 006 T2 section 6 + Plan 011 T6 step 7 | COVERED |
| Multi-user OUT OF SCOPE | PHASE-INDEX Out of scope | COVERED |
| Subscription auth (~/.claude) mount NOT used | ARCH-REVIEW section 4 + Plan 005 entrypoint validates ANTHROPIC_API_KEY only | COVERED |

---

## 5. Critical-contradiction sweep - override ceiling

ARCH-REVIEW section 3 originally reads override-never-raises-above-computed-budget (interpretation: <= budget). PHASE-INDEX and Plans 002/003/010 instead use <= budget x 2. Planner flagged and resolved (x 2 wins).

Cross-plan consistency of x 2:
- Plan 002 T1: min(concurrency_override, concurrency_budget * 2) - OK
- Plan 002 T3: PATCH clamps to <= concurrency_budget * 2, returns 400 with max=budget*2 - OK
- Plan 003 T1: cap = LEAST(COALESCE(concurrency_override, concurrency_budget), concurrency_budget * 2) - OK
- Plan 010 T3: Slider max = concurrency_budget * 2 - OK

No leftover <= budget references in plans. PASS.

**MINOR M3:** ARCH-REVIEW section 3 still reads the original safety-rail rule verbatim. The x 2 resolution lives only in PHASE-INDEX. Fix: append a callout in ARCH-REVIEW noting the resolution.

---

## 6. Empirical-measurement guardrail

Plan 006 sets initial Coolify limits at 4 vCPU / 8 GB BEFORE Plan 004 measures. Plan 004 declares deps [006, 007] so measurement runs on the provisioned container.

Correct direction: Plan 004 measures the live container Plan 006 provisions, then T3 updates MB_PER_SESSION. Coolify sizing itself is provisional. Plan 006 T1 risks acknowledges 8 GB may be wrong 2x in either direction. detectHostResources (Plan 001) is cgroup-aware so the concurrency budget auto-tracks whatever Coolify allocates regardless of the 8 GB initial guess. PASS.

---

## 7. Schema discipline

- Plan 002 T1: ALTER TABLE ... ADD COLUMN IF NOT EXISTS style. New users.preferred_supervisor_id is NULL by default. New concurrency_budget adds NOT NULL DEFAULT 1; existing rows get 1 and are corrected within seconds on next host_resources push (Plan 002 risks line 88 acknowledges).
- Plan 009 T1: CREATE TABLE IF NOT EXISTS daily_cost_usage. New users.model_pricing_cents_per_mtok JSONB is nullable.
- No DROP, no TRUNCATE, no destructive DDL anywhere.

PASS.

---

## 8. Out-of-scope hygiene

| Forbidden touch | Audited | Violation? |
|---|---|---|
| Auth/billing (Titanium migration) | Grepped titanium/supabase/bcrypt/password/JWT across 11 plans. Only Plan 008 references existing JWT auth for /api/sessions/heal; no auth changes. | No |
| Phase 03 multichat-grid-view files | Plan 010 modifies SettingsPage.tsx + creates new components in web/src/components/; no multichat-grid edits. | No |

PASS.

---

## 9. Goal-backward sufficiency - gap audit

End-state walk after all 11 plans execute:

1. Coolify resource remo-supervisor runs the GHCR image, connects as role=supervisor.
2. Supervisor sends host_resources -> hub UPDATEs supervisor row + broadcasts supervisor_resources_updated.
3. Web UI renders SupervisorCard with chips, slider, cost HUD.
4. User PATCHes concurrency_override; hub clamps to [1, budget x 2].
5. Self-heal POSTs /api/sessions/heal; pickSessionTarget picks + reserves; create_child_session WS dispatch; child agent spawns in worktree on /workspace/wt/SESSION_ID.
6. Branch-collision check refuses second session on same (repo, branch).
7. Cost cap blocks new sessions once spend >= daily_cost_cap_cents; 50%/80% warnings broadcast.
8. Plan 004 measurement updates MB_PER_SESSION with a measured value.
9. Phase04 e2e test exercises the surface; docs cross-link.

### MAJOR X1 - Slot leak on supervisor crash / WS disconnect

Plan 003 releaseSessionSlot is a no-op; the gate counts open session_runs via WHERE ended_at IS NULL. If a supervisor crashes mid-session (Coolify deploy, OOM, manual restart), child processes die but nothing writes ended_at. Those rows pin slots forever.

Plan 003 risks line 87 names this risk (works correctly only if every session run reliably sets ended_at ... Add a periodic reaper later if needed) but does NOT plan the reaper for this phase.

Impact: A single supervisor restart leaves N stuck session_runs rows, blocking all future reserves on that supervisor until manual DB cleanup. User hits this in week one.

Fix request - REQUIRED. Either:
- (a) Hub-side reaper that marks session_runs.ended_at for runs bound to a supervisor offline > 90s (mirrors the online threshold in Plan 008 pickSessionTarget); OR
- (b) On supervisor WS disconnect, the supervisor-registry close handler runs UPDATE session_runs SET ended_at=now(), close_reason=supervisor_disconnected WHERE supervisor_id=$1 AND ended_at IS NULL, then broadcasts supervisor_capacity_changed. PREFERRED - simpler, instant.

Plan 011 e2e step 5 (end one session) does NOT exercise this case.

### MAJOR X2 - reserveSessionSlot is not actually atomic with row creation

Plan 003 T1 explicitly says: the actual row insert into session_runs is the caller responsibility - this function just gates. That is the bug.

Sequence inside reserveSessionSlot: BEGIN; SELECT ... FOR UPDATE; SELECT COUNT(*) FROM session_runs WHERE supervisor_id=$1 AND ended_at IS NULL; COMMIT. The COMMIT releases the row lock. The caller then INSERTs session_runs separately.

Race: two parallel callers at running=0, cap=1. Both enter gate. Caller A wins FOR UPDATE, COUNT returns 0, COMMITs ok. Caller B then acquires lock, COUNT still returns 0 (no row inserted yet by A), COMMITs ok. Both proceed to insert. Final state: running=2 with cap=1.

Plan 008 T1 (the function reserves the slot atomically as part of selection) trusts a property the implementation does NOT provide.

Plan 003 T3 race test case (e) (5 parallel reserves with cap=3) will appear to pass because the test inserts session_runs immediately on each ok inside the JS event loop, hiding the race. It does not exercise the actual gap window.

Fix request - REQUIRED. Either:
- (a) Move INSERT INTO session_runs inside reserveSessionSlot so it happens inside the same FOR UPDATE tx. New signature: reserveSessionSlot(userId, supervisorId, sessionRun). Caller still owns ended_at lifecycle.
- (b) Switch the count to a denormalized supervisors.in_use INT counter incremented inside the FOR UPDATE tx (decremented on disconnect-close from X1 fix).

Option (a) is closer to the existing plan shape.

### MINOR M4 - cost_cap_warning event subscribed but never surfaced

Plan 009 T3 broadcasts cost_cap_warning on 50%/80% crossings. Plan 010 T1 lists it as a subscribed WS event but the hook return shape does NOT surface it. The cost HUD threshold colors come from costToday.pct re-computed client-side - fine for color, but the toast/banner the event was designed to drive is unwired.

Fix: Add warningLevel: none | 50 | 80 to the hook return; render an inline toast/banner on receive.

### MINOR M5 - Plan 008 T2 step (c) session_runs INSERT path

Step (c) says INSERT a session_runs row binding the slot reservation without specifying it MUST be inside the picker tx. Once X2 is fixed, fold the INSERT into the reservation tx. Current wording invites the executor to insert AFTER WS dispatch, perpetuating X2.

### MINOR M6 - Claude CLI pinned version not recorded

Plan 005 T1: bun pm view at build time, pin as ARG default. The exact pinned value is NOT recorded in frontmatter or any doc. T1 acceptance criterion (docker run --entrypoint claude img --version prints the pinned version) needs that pin to exist. A fresh executor must look it up.

Fix: Plan 005 T1 subtask: Run bun pm view, record value in Dockerfile ARG CLAUDE_CLI_VERSION default AND in docs/coolify-supervisor.md (Plan 006 T2) Versions section.

### MINOR M7 - Non-github bare-clone path scheme undocumented for users

Plan 007 T1: github.com paths only for v1; fall back to a hash for non-github URLs. Bare-clone path scheme for non-github URLs is opaque to operators. Add user-facing note in docs/coolify-supervisor.md: non-github URLs are stored at /workspace/.bare/HASH.git - github URLs use human-readable paths.

---

## 10. Issue summary

| ID | Severity | Plan(s) | Summary |
|----|---|---|---|
| X1 | MAJOR | 003 | No slot release on supervisor crash/disconnect - stuck session_runs block all future reserves. |
| X2 | MAJOR | 003, 008 | reserveSessionSlot commits FOR UPDATE tx before caller INSERTs - N concurrent picks at running less than cap can all win. |
| M1 | MINOR | 002 | depends_on: [] should include 001; wave-1 parallel may collide on supervisor-protocol.ts. |
| M2 | MINOR | 005 | Per-child cgroup deferral (ARCH risk #2) not in Plan 005 risks where an executor would expect it. |
| M3 | MINOR | ARCH-REVIEW.md | Verbatim section 3 still says override <= budget; planning resolved to x 2. Add callout. |
| M4 | MINOR | 010 | cost_cap_warning WS event subscribed but never surfaced. Add warningLevel + banner. |
| M5 | MINOR | 008 | Step-c INSERT under-specified; once X2 fixed, fold into reservation tx. |
| M6 | MINOR | 005, 006 | Claude CLI pinned version not recorded anywhere a fresh executor can find. |
| M7 | MINOR | 006, 007 | Non-github bare-clone hashed path scheme not documented for users. |

---

## 11. Specific edits requested

1. 04-PLAN-003 T1: Change reserveSessionSlot to accept sessionRun and INSERT the session_runs row INSIDE the same FOR UPDATE tx. Update caller-responsibility comment. Update T3 race case (e) to assert exactly 3 session_runs rows exist after the race. (Fix X2)
2. 04-PLAN-003 add Task T4: On supervisor WS disconnect (hub-side close handler in supervisor-registry.ts), close all open session_runs for that supervisor and broadcast supervisor_capacity_changed. Add matching test. (Fix X1)
3. 04-PLAN-002 frontmatter: Add depends_on: [04-PLAN-001-budget-reporting] (moves to wave 2) OR explicit ordering note. (Fix M1)
4. 04-PLAN-005 risks: Append: Per-child cgroup hard limits (ARCH risk #2) deferred - supervisor relies on hub-side concurrency gate + cost cap only. (Fix M2). In T1, record pinned CLAUDE_CLI_VERSION literal at planning time. (Fix M6)
5. ARCHITECTURE-REVIEW.md section 3: Append PLANNING DECISION (2026-05-25) callout: override ceiling is budget x 2, not <= budget. (Fix M3)
6. 04-PLAN-010 T1 + T4: Extend useSupervisorBudget return with warningLevel; add banner/toast for cost_cap_warning. (Fix M4)
7. 04-PLAN-008 T2 step (c): After X2 applied, simplify to: pass session_id to reserveSessionSlot which inserts the session_runs row atomically. (Fix M5)
8. 04-PLAN-006 T2 doc spec: Add Versions subsection (pinned Claude CLI) + Repo-storage subsection (non-github URL hashing). (Fix M6 + M7)

---

## 12. Could a fresh agent execute these in order without asking the user?

- With X1, X2 unfixed: No. Both are silent correctness bugs that the unit tests as written will pass; production users hit them within days. YOLO execution would ship broken code.
- With X1, X2, M1 fixed: Yes. M2-M7 are clarity/docs polish; foldable into the same revision pass.
- Checkpoint plans (004 T2, 006 T3, 010 T6, 011 T6) have explicit resume-signal strings - autonomous runner pauses correctly.

---

Verdict: PASS-WITH-REVISIONS. Fix X1, X2, M1 before YOLO execution; M2-M7 fold into the same revision pass.
