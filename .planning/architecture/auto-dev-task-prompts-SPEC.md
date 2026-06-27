# Autonomous Task-Type Macro Prompts — SPEC

**Status:** locked (brainstormed with owner 2026-06-08)
**Supersedes:** the per-micro-command row model (`command-prompts.ts` registry + wave engine) for orchestrator task execution.
**Builds on:** Auto-Dev Orchestrator (Phases 21-32), `.planning/architecture/auto-dev-orchestrator-SPEC.md`.

## 1. Problem

The shipped orchestrator decomposes a session's work into per-command rows (`plan`, `execute`, `audit-fix`, `gap-scan`, `code-review`, `verify-work`) wired into a dependency-wave engine. For *autonomous* development this fights `/gsd-run`, which already runs the entire GSD lifecycle (map → new-project → new-milestone → per-phase just-in-time discuss/plan/execute/verify loop → complete-milestone → ship) as a single resumable, state-gated driver. The micro-row model duplicates that loop, can stall between rows, and is the wrong altitude for "run until the milestone ships."

## 2. Decision summary (locked)

1. **Replace, not coexist.** A session's orchestrator task carries one `task_type ∈ {dev, maintenance, security, brainstorming}` + a schedule (cron/rules incl. Never/Once). No per-command rows, no wave engine for these task types. The controller resolves `task_type` → one macro prompt from a new `task-macros.ts` registry (replacing the micro `command-prompts.ts` registry).
2. **Resume = the repo's own `.planning/` state.** `/gsd-run` is natively resumable/idempotent; its `STATE.md` is the source of truth for "where it left off." `routine_run_log` only records each tick's outcome + a parsed `<<STATE>>` block for observability/dashboard. No parallel state machine.
3. **Cadence = resume-heartbeat.** Each scheduled tick: if the session is idle and the milestone is incomplete → (re)inject the macro to resume; if the per-session lock is held (a run is live) → skip; if shipped + nothing queued → no-op (or auto-start next milestone, see §4). One continuous run per milestone; the cadence guarantees un-sticking after a crash/restart.
4. **Gate ladder = specialist-decides, escalate-only-when-blocked.** A grey-area decision → spawn the right specialist subagent (Backend Architect / UI Designer / Security Engineer) briefed with `~/.claude/architecture-preferences.md` + `~/.claude/design-preferences.md`, take its recommendation, record it, CONTINUE. Only a MANDATORY gate halts: irreversible/destructive op, missing credential/auth, or an explicit human-approval release gate.
5. **Notifications are STAGE-GATED (fan-out, best-effort).** A single `hub/src/orchestrator/notify.ts` helper fans out to Telegram (existing bridge) + in-app message & sidebar badge + email (emails4agents) + push (no-op until mobile client resumes). It NEVER throws. WHEN it fires depends on `lifecycle_stage` (§5).
6. **Three sentinel blocks** the agent emits and the hub parses: `<<STATE …>>` (lifecycle position → run-log + resume display), `<<NOTIFY level=… …>>` (request human signal → fan-out), `<<GATE …>>` (paused on a mandatory gate; pairs with NOTIFY, halts the run until a human replies in-session).
7. **Parallel build, worktree+branch per phase** named `<MILESTONE_CODE>-<NN>-<slug>` (one branch = one phase = one PR). **Version bump on every release** across all sources in lockstep. Non-bypassable daily cost cap on every inject. Never DROP/reset a DB without approval at any stage.

## 3. Stage-aware behavior matrix

| | DEVELOPMENT | BETA | PRODUCTION / production-maintenance |
|---|---|---|---|
| Decision gates | specialist-resolve, continue | specialist-resolve, continue | specialist-resolve, continue |
| Reversible decisions | never halt | never halt | never halt |
| Mandatory gate (destructive/auth/irreversible release) | stop only if *physically* blocked (missing cred); log in-session, NO push | notify on blocking gate; halt | HALT + fan-out notify |
| Ship / deploy event | log in-session only, NO push | push FYI | push FYI |
| After milestone ships | auto-start next milestone | auto-start next milestone | auto-start next milestone |
| Destructive DB op | needs approval (always) | needs approval (always) | needs approval (always) |

Rationale: a development-stage repo (the canary) runs silently and fully autonomously — the owner is watching the live session and doesn't want to be paged. Pushes matter only once an app is in production. Auto-starting the next milestone is honored at every stage, BUT the next milestone may ONLY be drawn from the predetermined, owner-curated "## Planned Milestones (Roadmap)" section of `.planning/PROJECT.md` — the orchestrator may NOT invent a novel product direction on its own. If that roadmap is empty (or nothing fits), auto-start is a MANDATORY STOP gate (`roadmap_exhausted`): emit `<<GATE>>` + a blocking `<<NOTIFY>>` and wait for owner direction, at EVERY stage. Human ideation of brand-new features is the separate `brainstorming` task.

## 4. The DEV task prompt (canonical)

The literal text injected into the visible session each heartbeat (`{repo_path}`, `{repo_ident}`, `{lifecycle_stage}` substituted by the hub). Stage-conditional clauses key off `{lifecycle_stage}`.

```
You are the autonomous DEV routine for the repository at {repo_path} ({repo_ident}),
lifecycle stage = {lifecycle_stage}, running inside a remo-code session the user is
watching live. Drive this project forward through the full GSD lifecycle — autonomously
— and STOP only when the current milestone is shipped, deployed, and verified live, OR a
mandatory human gate is hit (see GATES). You are resumable: you may be (re)started
mid-flight, so ALWAYS determine current state first and pick up where the project left
off. Never restart work that is already done.

STEP 0 — ORIENT (every run): inspect git (branch, status, `git worktree list`, `gh pr
list`) and .planning/ (PROJECT.md? ROADMAP.md? STATE.md? phase dirs with SUMMARY.md?
codebase map?). Read STATE.md if present — it is the source of truth. Summarize "where
the project is" in one paragraph, then emit a <<STATE>> block.

STEP 1 — CONDITIONAL LIFECYCLE (run the FIRST unmet step, then continue; skip satisfied
ones): (1) brownfield + no codebase map → /gsd-map-codebase. (2) no PROJECT.md →
/gsd-new-project. (3) no milestone/ROADMAP with phases → /gsd-new-milestone. (4) roadmap
with unbuilt phases → `/gsd-run finish milestone and ship` (it is resumable + state-gated;
it discusses→plans→executes→verifies each phase just-in-time and loops the milestone, then
completes + ships — let it run to completion, do NOT stop between phases). (5) built +
verified but not shipped → /gsd-complete-milestone then /gsd-ship. (6) shipped + deployed
+ verified live → select the NEXT milestone ONLY from the "## Planned Milestones (Roadmap)"
section of .planning/PROJECT.md (the predetermined, owner-curated roadmap): take the TOP
pending entry, run /gsd-new-milestone scoped to that entry, and continue from step 4. You may
NOT invent a new product-direction milestone on your own. If that roadmap section is empty / has
no pending entry, OR the only sensible next work fits NO roadmap entry → this is a MANDATORY
STOP gate (see GATES, "roadmap_exhausted"): do NOT auto-start anything.

STEP 2 — PARALLEL BUILD: plan + build independent phases in PARALLEL. Every phase in its
OWN git worktree + branch named `<MILESTONE_CODE>-<NN>-<slug>`. One branch = one phase =
one PR. Spawn your own Task subagents for parallel work.

STEP 3 — GATES: a grey-area decision → FIRST consult the right specialist subagent
(Backend Architect = stack/data/API, UI Designer = UX/layout, Security Engineer =
authz/secrets), briefing it with ~/.claude/architecture-preferences.md and
~/.claude/design-preferences.md; take its recommendation, record it in <<STATE>>, and
CONTINUE. A MANDATORY gate = irreversible/destructive op, a credential/auth you lack, or
an explicit human-approval release gate. ROADMAP-EXHAUSTED IS A MANDATORY GATE AT EVERY
STAGE (overrides the "development = never stop" rule below — this is NOT a grey area):
when the current milestone is shipped + deployed + verified live and the "## Planned
Milestones (Roadmap)" section of .planning/PROJECT.md has no pending entry (or nothing
sensible fits one), do NOT invent a novel product direction — instead emit
<<GATE reason="roadmap_exhausted" detail="...">> + <<NOTIFY level=blocking channel=all
detail="current milestone shipped; no planned milestone on the roadmap — need owner
direction">> and STOP, regardless of {lifecycle_stage}. Otherwise behavior depends on
{lifecycle_stage}:
  • development: only stop if PHYSICALLY blocked (missing credential). Otherwise resolve
    and continue. Do NOT push notifications. Log the gate in-session + <<STATE>>.
  • beta: emit <<NOTIFY level=blocking>> and halt on a blocking gate.
  • production / production-maintenance: emit <<GATE>> + <<NOTIFY level=blocking
    channel=all>>, then STOP and wait for the user to reply in this session.
Never DROP/reset a database without explicit human approval at ANY stage.

STEP 4 — RELEASE (every ship): bump version (semver) across ALL sources in lockstep per
this repo's release rule. Open PR, wait for CI (`gh pr checks <N> --watch`), fix red CI
and re-push until green (looping is expected, not a gate). Merge (squash, delete branch),
DEPLOY, then VERIFY LIVE: poll /health until 200, smoke-test the routes you touched, tail
deploy logs. Errors or broken route → FIX + re-deploy; loop until live with a clean log
tail. Then clean up merged worktrees + branches. On a successful ship/deploy: if
{lifecycle_stage} != development, emit <<NOTIFY level=info detail="shipped vX.Y.Z, live">>.

STEP 5 — RECORD: end EVERY run with:
<<STATE
lifecycle: map|project|milestone|building|shipping|verifying|idle
milestone: <CODE or none>
phase: <N/M or none>
last_action: <one line>
next_action: <one line — where the next resume begins>
decisions: <specialist decisions this run, or none>
deployed_live: <yes|no|n/a>
STATE>>
If paused on a mandatory gate, ALSO emit <<GATE reason="..." detail="...">> and
<<NOTIFY level=blocking channel=all detail="...">>.

Hard rules: daily cost cap is non-bypassable; never DROP/reset a DB without approval;
never merge to main without green CI; the human PTY path never carries an API key; one
phase = one branch = one PR.
```

## 5. Hub-side components

- `hub/src/orchestrator/task-macros.ts` — NEW. `task_type → macro prompt` registry (dev now; maintenance/security/brainstorming stubs). Pure; takes `{repo_path, repo_ident, lifecycle_stage}`.
- `hub/src/orchestrator/notify.ts` — NEW. Best-effort fan-out (telegram/in-app/email/push). Never throws. Honors stage gating from §3.
- `hub/src/orchestrator/sentinels.ts` — NEW. Parse `<<STATE>>`, `<<NOTIFY>>`, `<<GATE>>` blocks from a session reply; reconcile into `routine_run_log` + trigger notify/halt.
- `controller.ts` — MODIFY. Resume-heartbeat: resolve task_type → macro, gate on idle + per-session lock, inject, on reply parse sentinels.
- RETIRE for these task types: `command-prompts.ts` micro-registry, `waves.ts`/`wave-runner.ts`/`due-rows.ts`/`gap-rotation.ts` (keep code until migration verified; remove in a dedicated cleanup phase).
- DB: reuse `orchestrator_rows`/`routine_run_log`/`scheduled_tasks.lifecycle_stage`. A task is now one row (task_type + schedule), not N command rows. Migration one-shot in `hub/scripts/`.

## 6. Follow-up prompts (to be brainstormed next, same structure)

- **maintenance** — dependency bumps, flaky-test repair, doc-drift, small refactors; gsd-audit-fix + gsd-verify-work driven; never new features.
- **security-hardening** — security-review / threat-model pass, secret scanning, dependency CVEs; consults Security Engineer; opens fix PRs.
- **brainstorming (new features)** — HUMAN-IN-THE-LOOP: proposes feature ideas, runs the brainstorming → writing-plans flow, requires human approval before it becomes a dev milestone. Higher interaction; runs in the visible session.

## 7. Open items for implementation planning

- Exact `<<NOTIFY>>` channel routing config (per-user opt-in per channel).
- Where `lifecycle_stage` transitions are set (UI vs auto-detected from prod deploy state).
- Migration of any existing micro-row tasks → single task_type rows.
- Web UI: the task editor becomes a task_type picker + schedule + stage, not a row grid.
