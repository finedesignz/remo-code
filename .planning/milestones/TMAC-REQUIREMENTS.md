<!-- updated: 2026-06-08 -->
# Milestone TMAC — Autonomous Task-Type Macro Prompts — REQUIREMENTS

**Source of truth:** `.planning/architecture/auto-dev-task-prompts-SPEC.md` (locked 2026-06-08).
**Builds on:** Auto-Dev Orchestrator (Phases 21–32).
**Milestone CODE:** `TMAC` (phase dirs/labels prefixed `TMAC-NN-slug`, collision-safe per global rule).

## Goal

Replace the orchestrator's per-micro-command-row execution model with ONE autonomous
macro prompt per `task_type ∈ {dev, maintenance, security, brainstorming}` (complete DEV
prompt first; the other three are stubs). Add resume-heartbeat controller behavior, the
specialist-decides gate ladder, the stage-aware notification matrix, three sentinel blocks
(`<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>`), and a best-effort fan-out notify helper.

## Requirements (REQ-IDs)

- **R-TMAC-01 (sentinels):** Parse `<<STATE …>>`, `<<NOTIFY level=… …>>`, `<<GATE …>>` blocks
  from a session reply. Pure, no DB/network/clock. Malformed/missing → safe empty result
  (never throws). Mirrors `command-prompts`/`controller` parse style.
- **R-TMAC-02 (task-macros):** `task_type → macro prompt` registry. Pure; takes
  `{repo_path, repo_ident, lifecycle_stage}` and substitutes them. DEV prompt = the
  canonical §4 text verbatim (stage-conditional clauses keyed off `lifecycle_stage`).
  maintenance/security/brainstorming = documented stubs.
- **R-TMAC-03 (notify):** Best-effort fan-out helper (telegram / in-app message + sidebar
  badge / email via emails4agents / push no-op). NEVER throws. Honors the §3 stage matrix:
  development = no push on ship/gate (log only); beta = push FYI + notify on blocking gate;
  production/-maintenance = HALT + fan-out on blocking gate.
- **R-TMAC-04 (controller resume-heartbeat):** Each tick: resolve `task_type` → macro;
  skip if per-session cycle lock held (a run is live); inject the macro (cost-capped, via
  existing `injectOrchestratorPrompt`) when idle + incomplete; on the agent reply parse
  sentinels → reconcile into `routine_run_log` + trigger notify/halt. No parallel state
  machine — the repo's own `.planning/STATE.md` is the resume source of truth.
- **R-TMAC-05 (data + UI):** A task is ONE row (`task_type` + schedule), not N command rows.
  Idempotent DDL only in `schema.sql`; any backfill in a one-shot `hub/scripts/*.ts`. Web
  task editor becomes a `task_type` picker + schedule + lifecycle stage (not a row grid).
  Accent = blue only.
- **R-TMAC-06 (retire micro-row path):** For these task types, retire the
  `command-prompts.ts` micro-registry + `waves.ts`/`wave-runner.ts`/`due-rows.ts`/
  `gap-rotation.ts` usage. Keep the code until migration is verified; gate the new path so
  prod stays safe. Docs + `/openapi.json` synced (`bun run docs:sync`).

## Non-negotiable invariants (carried)

- Daily cost cap non-bypassable: every inject through `dailyCostCapGate`.
- `schema.sql` re-runs every boot → idempotent DDL only; backfills in `hub/scripts/`.
- Hub injects TEXT ONLY; never shells gh/git/merge; no API key on the human PTY path.
- `hub/test/mount-order.test.ts`, `web/test/no-indigo.test.ts` stay green.
- `bun run check-baseline` green before PR.
- One phase = one logical commit set; whole milestone = one PR `feat/orchestrator-task-macros` → main.
- Never DROP/reset a DB without approval.

## Out of scope (this milestone)

- Full maintenance/security/brainstorming prompt bodies (stubs only; §6 follow-up).
- Per-user per-channel notify opt-in config (§7 open item — minimal env/default routing now).
- Auto-detected lifecycle_stage transitions (§7 open item — keep manual stage field).
- Enabling the live orchestrator path in prod (`REMO_ORCHESTRATOR_ENABLED` stays operator-controlled).
