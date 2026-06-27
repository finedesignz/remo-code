# Phase 04 — coolify-dev-supervisor — Plan Index

**Goal:** Run a lean dev-only remo-code supervisor on a Coolify server (with Claude Code CLI + git) to host self-heal sessions off the local desktop. Server reports CPU/RAM/concurrency budget to hub; hub enforces concurrency + per-user daily cost cap; UI displays budget with override slider. Self-heal errors/tasks routed to this remote supervisor by preference.

**Shape recap (resolved by RESEARCH.md + ARCHITECTURE-REVIEW.md):**
One supervisor container per Coolify resource. Supervisor spawns N child `claude-agent` processes (the existing `ProcessManager`). Each child gets a git worktree on a shared persistent volume. Hub is authoritative on concurrency and cost — UI is decorative.

## Plans

| Plan | Wave | Title | Autonomous | Depends on |
|---|---|---|---|---|
| `04-PLAN-001-budget-reporting` | 1 | Supervisor cgroup detection + `host_resources` WS message | yes | — |
| `04-PLAN-002-schema-and-migration` | 1 | `supervisors` budget columns + `users.preferred_supervisor_id` + persistence handler | yes | — |
| `04-PLAN-003-hub-concurrency-gate` | 2 | `reserveSessionSlot` / `releaseSessionSlot`, wired into all session-creation paths | yes | 002 |
| `04-PLAN-005-supervisor-dockerfile` | 2 | Multi-stage `supervisor/Dockerfile`, non-root, GHCR CI workflow | yes | — |
| `04-PLAN-007-worktree-per-session` | 2 | Shared bare clones + `git worktree add` per session, branch-collision detection | yes | — |
| `04-PLAN-006-coolify-deploy` | 3 | Provision Coolify resource: volumes, env, no exposed ports, healthcheck | no (checkpoint) | 005, 001, 002 |
| `04-PLAN-008-self-heal-routing` | 3 | `POST /api/sessions/heal` + `pickSessionTarget` resolution order | yes | 002, 003 |
| `04-PLAN-009-cost-cap-hub-wide` | 3 | Lift scheduler daily cost cap to hub-wide per-user gate | yes | 002, 003 |
| `04-PLAN-004-empirical-budget-measurement` | 4 | Measure per-session RSS on Coolify, tune `MB_PER_SESSION` | no (checkpoint) | 006, 007 |
| `04-PLAN-010-web-budget-ui` | 4 | Supervisor card, override slider, cost HUD, settings sections | no (checkpoint) | 002, 003, 009 |
| `04-PLAN-011-tests-and-docs` | 4 | End-to-end test + docs (coolify-supervisor.md, README, CLAUDE.md) | no (checkpoint) | 003, 006, 007, 008, 009, 010 |

## Wave dependency graph

```
Wave 1 (parallel, no deps):
  001 budget-reporting          002 schema-and-migration

Wave 2 (after wave 1):
  003 hub-concurrency-gate  ← 002
  005 supervisor-dockerfile (independent)
  007 worktree-per-session  (independent)

Wave 3 (after wave 2):
  006 coolify-deploy        ← 005, 001, 002
  008 self-heal-routing     ← 002, 003
  009 cost-cap-hub-wide     ← 002, 003

Wave 4 (after wave 3):
  004 empirical-budget-measurement ← 006, 007
  010 web-budget-ui                ← 002, 003, 009
  011 tests-and-docs               ← 003, 006, 007, 008, 009, 010
```

## Goal-backward check

The ROADMAP goal is achieved when **all** of the following are observable on production:
1. A Coolify-hosted supervisor connects to `app.remo-code.com`, reports CPU/RAM/budget → **Plans 001 + 002 + 005 + 006**.
2. The hub refuses session creation past the supervisor's budget; user can override up to `2×` budget → **Plans 002 + 003**.
3. Per-session worktrees prevent cross-session repo collisions → **Plan 007**.
4. Self-heal calls `POST /api/sessions/heal` and the hub routes to the preferred supervisor → **Plan 008**.
5. A per-user daily cost cap prevents runaway spend across all session types → **Plan 009**.
6. The web UI shows the budget chip, override slider, and today's cost → **Plan 010**.
7. The `MB_PER_SESSION` constant is empirically measured, not guessed → **Plan 004**.
8. Tests + docs codify the contract → **Plan 011**.

Union of the 11 plans covers all 8 goal axes. No identified gaps.

## Out of scope

- Auth/billing changes — Titanium Licensing migration tracked separately (global rule #16).
- Migrating the external `claude-code-self-heal` service to call the new endpoint — documented contract only (Plan 008 doc); flip-over scheduled separately per ARCH-REVIEW "Do NOT" rule.
- Multi-user supervisor sharing — single-user model only (ARCH-REVIEW §8 "Multi-user").
- Per-child cgroup limits inside the supervisor container — listed as Risk #2 in ARCH-REVIEW; revisit if measurement (Plan 004) shows runaway child RAM.

## Source-coverage audit

- **GOAL** (ROADMAP Phase 04): covered by Plans 001, 002, 005, 006, 003, 010, 008, 009.
- **RESEARCH** (RESEARCH.md): Pitfall #1 (cgroup paths) → Plan 001. Pitfall #2 (RSS guess) → Plan 004. Pitfall #3 (repo collision) → Plan 007. Pitfall #4 (self-heal routing) → Plans 002 + 008. Pitfall #5 (cost cap) → Plan 009.
- **ARCH-REVIEW**: §1 path (A) shape → Plans 005 + 006. §2 budget reporting → Plan 001. §3 hub-authoritative → Plan 003. §4 API-key auth → Plan 005 + 006. §5 worktrees → Plan 007. §6 self-heal routing → Plan 008. §7 cost cap → Plan 009. §8 missing-from-mental-model (security, observability, drain-before-deploy, recovery) → Plans 005, 006, 011 docs.
- **CONTEXT**: no `04-CONTEXT.md` exists in the phase dir, so no discuss-phase locked decisions to honor; planning derives from ROADMAP + RESEARCH + ARCHITECTURE-REVIEW directly.

No source items are unplanned.
