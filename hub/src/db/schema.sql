-- hub/src/db/schema.sql
-- Run this once against a fresh PostgreSQL database to initialize the schema.
-- All statements are idempotent — safe to re-run on existing databases.

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  project_dir  TEXT,
  status       TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'thinking')),
  token_hash   TEXT NOT NULL,
  last_activity TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_project ON sessions(user_id, project_dir);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  capabilities TEXT[] NOT NULL DEFAULT ARRAY['agent','supervisor']
);

-- NOTE: the legacy one-active-key-per-user unique index
-- (idx_api_keys_user_active) used to be created here, but it is unconditionally
-- DROPped + replaced by the per-(user, purpose) variant idx_api_keys_user_purpose_active
-- further down in this file. Creating it here was vestigial AND made re-applying
-- the whole schema (sql.unsafe(schema.sql)) fail once a user legitimately had
-- multiple active keys with distinct purposes — the CREATE would error on the
-- now-valid data. Defining only the final purpose-aware index keeps schema
-- application idempotent and order-independent.
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;

-- Per-user system prompt injected at the start of every new Claude session
ALTER TABLE users ADD COLUMN IF NOT EXISTS system_prompt TEXT;

-- Connected-agent host info (OS, arch, CPU, RAM, runtime versions). Set on the
-- session row when the agent authenticates. Surfaced in the Settings UI under
-- a "Connected Agent" card.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_info JSONB;

-- Soft-delete column for sessions. Set when user explicitly disconnects so a
-- stale agent process cannot resurrect the row via findOrCreateAgentSession.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Message lifecycle status. Assistant messages are inserted as 'streaming'
-- placeholders when a turn begins, incrementally appended via text_delta,
-- then flipped to 'complete' on the final assistant_message event. If the
-- hub restarts mid-stream, the orphaned-placeholder sweep on boot marks
-- the row 'interrupted' so the UI can render it distinctly.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'complete'
  CHECK (status IN ('streaming', 'complete', 'interrupted'));

-- Migration for existing rows (idempotent — only adds column if missing)
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT ARRAY['agent','supervisor'];
-- The supervisor-cap backfill that used to live here was a privilege-escalation
-- landmine: it re-ran on EVERY hub boot and would silently rewrite any key minted
-- WITHOUT the 'supervisor' cap (least-privilege / multi-tenant keys) to
-- ['agent','supervisor'] — escalating it AND stripping its extra caps. Moved to the
-- one-shot backfill hub/scripts/backfill-api-key-capabilities.ts (2026-07-12).
-- The column DEFAULT above already gives every NEW key ['agent','supervisor'].

-- ── Supervisor feature tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS github_installations (
  id            BIGINT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_login TEXT NOT NULL,
  account_type  TEXT NOT NULL,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_github_inst_user ON github_installations(user_id);

CREATE TABLE IF NOT EXISTS supervisors (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id      TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  hostname        TEXT NOT NULL,
  version         TEXT,
  os              TEXT,
  roots           TEXT[] NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'idle',
  current_run_id  TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supervisors_api_key ON supervisors(api_key_id);
CREATE INDEX IF NOT EXISTS idx_supervisors_user ON supervisors(user_id);

CREATE TABLE IF NOT EXISTS session_runs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  supervisor_id   TEXT REFERENCES supervisors(id) ON DELETE SET NULL,
  repo_path       TEXT NOT NULL,
  branch          TEXT,
  pulled          BOOLEAN NOT NULL DEFAULT false,
  initial_prompt  TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  exit_code       INTEGER,
  exit_reason     TEXT,
  restart_of      TEXT REFERENCES session_runs(id) ON DELETE SET NULL,
  restart_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON session_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_supervisor ON session_runs(supervisor_id);

CREATE TABLE IF NOT EXISTS supervisor_commands (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id TEXT NOT NULL REFERENCES supervisors(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('command','skill')),
  name          TEXT NOT NULL,
  description   TEXT,
  source        TEXT NOT NULL,
  path          TEXT NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supcmds_user ON supervisor_commands(user_id, kind, name);
CREATE INDEX IF NOT EXISTS idx_supcmds_supervisor ON supervisor_commands(supervisor_id);

-- ── Scheduled Tasks ───────────────────────────────────────────────────────────
-- NOTE: IDs are TEXT (uuid-as-text) for consistency with other tables in this
-- schema (sessions, supervisors, session_runs). The architect plan calls for
-- UUID PKs; we use TEXT to avoid breaking the existing FK graph. Semantically
-- equivalent — uuid generator still backs the default.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  on_complete     JSONB NOT NULL DEFAULT '{"type":"none"}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_enabled ON scheduled_tasks(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_session ON scheduled_tasks(session_id);

-- New columns for the architect-approved scheduled-tasks phase. Idempotent
-- ADD COLUMN IF NOT EXISTS keeps the legacy shape intact while we migrate the
-- DAL and dispatcher. session_id remains NOT NULL on legacy rows; new rows
-- created via the new API may target supervisors or fan-outs and set
-- session_id to a synthetic/placeholder value to satisfy the NOT NULL until
-- a follow-up migration drops that constraint.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'dev'
  CHECK (task_type IN ('prompt','skill','security_scan','log_check','continue_dev'));

-- ── Phase 11: structured task workflows ──────────────────────────────────────
-- Collapse user-pickable types to three (dev / security / log_check) and add
-- chained workflow step kinds (dev_plan/execute/ship, security_scan/triage/
-- fix_or_issue, log_pull/classify/triage). Internal kinds: triage (synthesized
-- by Coolify webhook). Data migration is idempotent: re-running the schema is
-- a no-op once the new constraint is in place because the UPDATE WHERE clause
-- only touches rows still on legacy values.
--
-- Step A — rewrite legacy user-pickable rows to the new triad. Prompt text is
-- preserved verbatim in payload.prompt (no payload changes here).
-- schema-lint: allow convergent — the CHECK constraint below forbids the legacy values, so WHERE matches 0 rows
UPDATE scheduled_tasks SET task_type = 'dev'
  WHERE task_type IN ('prompt', 'skill', 'continue_dev');
-- schema-lint: allow convergent — same CHECK constraint; 'security_scan' is unreachable once applied
UPDATE scheduled_tasks SET task_type = 'security'
  WHERE task_type = 'security_scan';
-- log_check and triage are unchanged.
--
-- Step B — swap the CHECK constraint. Postgres auto-named the constraint from
-- the inline CHECK on the original ADD COLUMN; the name is deterministic
-- ("<table>_<col>_check"). DROP IF EXISTS makes this safe on fresh DBs that
-- never had the legacy constraint and on prod DBs that do.
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_task_type_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_task_type_check
  CHECK (task_type IN (
    -- User-pickable workflow roots
    'dev', 'security', 'log_check', 'qc',
    -- Chained workflow steps (created by the workflow auto-explosion in W2)
    'dev_controller', 'dev_plan', 'dev_execute', 'dev_ship',
    'security_scan', 'security_triage', 'security_fix_or_issue',
    'log_pull', 'log_classify', 'log_triage',
    -- auto-dev P4: QC review → fix → verify (verify opens a PR, never merges)
    'qc_review', 'qc_fix', 'qc_verify',
    -- Phase 21 (auto-dev-orchestrator): the session-level orchestrator task.
    -- One per session (enforced by idx_scheduled_tasks_orchestrator_unique below).
    -- Locked decision 3: REPLACES the many-tasks-per-session model — the
    -- orchestrator task owns per-command rows in orchestrator_rows.
    'orchestrator',
    -- Milestone TEAB: Titanium Edge AutoBuilder run as a scheduled-task action.
    'teab',
    -- Internal: synthesized by Coolify webhook
    'triage'
  ));
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'session'
  CHECK (target_kind IN ('session','supervisor','all_agents','all_supervisors'));
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS cron_expr TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS catchup_policy TEXT NOT NULL DEFAULT 'skip'
  CHECK (catchup_policy IN ('skip','run_once'));
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS max_concurrent SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS last_fire_at TIMESTAMPTZ;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS next_fire_at TIMESTAMPTZ;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS post_run_actions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Auto-generated name parts. `name_prefix` is the server-computed, locked
-- portion (e.g. "Continue Dev on finedesignz/kh-hub every 4h"); `name_suffix`
-- is the user-authored free-form note. The legacy `name` column remains
-- authoritative and is kept in sync by the DAL (name = coalesce(prefix || ' — ' || suffix, prefix, name)).
-- Both columns are nullable so existing rows stay valid until next edit.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS name_prefix TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS name_suffix TEXT;

-- Simpler-cron picker (feat/simpler-cron-ui): structured rules array. Each
-- rule shape: { interval: int, unit: 'hours'|'days'|'weeks', start_at: ISO }.
-- Legacy `cron_expr`/`cron_expression` columns are still populated from
-- rule[0] on write for back-compat with the croner engine. Multiple rules
-- arm multiple cron registrations; fires from any rule route through the
-- same dispatcher.fire(task.id).
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS schedule_rules JSONB;

-- Milestone TEAB (additive, idempotent — no backfill). The target repo for a
-- `teab run --repo <X>` action and the most recent supervisor `teab_status`
-- poll result. NULL on every non-TEAB row. Canonical provisioning is the
-- one-shot hub/scripts/migrate-teab-task-columns.ts; these IF NOT EXISTS lines
-- keep a fresh-boot schema apply self-sufficient.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS teab_repo_ident TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS teab_last_status TEXT;

-- Default-on run-summary email (feat/scheduled-default-email-summary). Every
-- ROOT scheduled-task run (chainDepth===0) emails the task owner a summary
-- unless this flag is false OR the task already configures its own notify_email
-- post-run action. DEFAULT true so every existing + new task opts in; set false
-- to opt out. Synthesized in hub/src/scheduler/post-run/dispatcher.ts.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS email_summary BOOLEAN NOT NULL DEFAULT true;

-- W2/T8: drop legacy NOT NULL on session_id so fan-out tasks
-- (all_agents/all_supervisors) and supervisor-targeted tasks can omit it.
-- Idempotent — Postgres no-ops if the column is already nullable.
ALTER TABLE scheduled_tasks ALTER COLUMN session_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_fire
  ON scheduled_tasks(next_fire_at) WHERE enabled;

-- ── Phase 21: auto-dev-orchestrator data model (additive, idempotent) ────────
-- Foundational DDL ONLY — no behavior is wired here. Locked decisions 3, 4, 10
-- (see .planning/architecture/auto-dev-orchestrator-SPEC.md §2). schema.sql
-- re-runs in full every boot, so every statement below is idempotent. Any data
-- backfill belongs in a one-shot hub/scripts/ script, NEVER inline here.

-- D3: at most ONE orchestrator task per session. Partial unique index — only
-- constrains rows where task_type='orchestrator'; all other task types are
-- unaffected. A second insert for a session that already has an orchestrator
-- task fails at the DB layer (duplicate key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_orchestrator_unique
  ON scheduled_tasks(session_id)
  WHERE task_type = 'orchestrator';

-- D10: manual lifecycle stage with per-stage frequency presets. Default
-- 'development'. Constrained to the three stages. Named CHECK added guardedly
-- so re-runs are no-ops (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT NOT NULL DEFAULT 'development';
DO $$ BEGIN
  ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_lifecycle_stage_check
    CHECK (lifecycle_stage IN ('development','beta','production-maintenance'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Milestone TMAC (autonomous task-type macro prompts): an orchestrator task now
-- carries ONE macro task_type (dev|maintenance|security|brainstorming) that the
-- controller resolves to a single autonomous macro prompt (task-macros.ts),
-- REPLACING the per-orchestrator_rows micro-command model for that task. Default
-- 'dev' (the fully-specified routine). Distinct from scheduled_tasks.task_type
-- (which stays 'orchestrator' for the row). Idempotent: ADD COLUMN IF NOT EXISTS
-- + guarded named CHECK.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS macro_task_type TEXT NOT NULL DEFAULT 'dev';
DO $$ BEGIN
  ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_macro_task_type_check
    CHECK (macro_task_type IN ('dev','maintenance','security','brainstorming'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Milestone TMAC §7.2: tracks whether lifecycle_stage was set EXPLICITLY by the
-- user (vs. left at the default). When false, the controller treats the stored
-- stage as a default and may override it with an AUTO-DETECTED stage derived from
-- prod-deploy state (stage-detect.ts). When true, the user's choice ALWAYS wins —
-- auto-detect never flips an explicit stage. Additive, no backfill: existing rows
-- default to false (= "not explicitly set", eligible for auto-detect), which is
-- the conservative choice since the prior stage column also defaulted to
-- 'development'. Set true by the PATCH /api/orchestrator-tasks lifecycle_stage path.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS lifecycle_stage_explicit BOOLEAN NOT NULL DEFAULT false;

-- D1/D3: per-command rows owned by an orchestrator task. Each row is one
-- routine command with its own schedule_rule (reusing the ScheduleRule JSONB
-- shape: cron-equivalent interval/unit/start_at + active_window + bounds).
-- frequency_label='Never' ⇒ disabled; 'Once' ⇒ max_runs=1 (enforced by the
-- controller, not here). micro_prompt is optional free text appended to the
-- command's prompt. No behavior wired in Phase 21.
CREATE TABLE IF NOT EXISTS orchestrator_rows (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id         TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  command         TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  schedule_rule   JSONB,
  frequency_label TEXT,
  micro_prompt    TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_rows_task
  ON orchestrator_rows(task_id, sort_order);

-- fix/orchestrator-tick-reinject: CADENCE STATE. `schedule_rule` alone is an
-- ELIGIBILITY predicate (start_at / week-month parity / active_window) — it has no
-- notion of "has the interval elapsed since the last fire". Without a per-row
-- last-fire stamp, an `Every 4h` row was DUE on EVERY 60s due-scan tick, so the
-- orchestrator re-injected its macro prompt once a minute, forever (incident:
-- session 4090d376, ~60 turns/hour × 2 days, 2.83B cache-read tokens). This column
-- is that stamp; `isRowDue()` now requires interval-elapsed since it.
ALTER TABLE orchestrator_rows ADD COLUMN IF NOT EXISTS last_fired_at TIMESTAMPTZ;

-- D1/D4: append-only audit of every routine command the controller runs. The
-- controller reads the last N entries each tick to feed runtime context.
-- decision_rationale / outcome / gap_dimension capture the controller's
-- structured decision; pr_url / reviewer_verdict / deploy_verify_result capture
-- the downstream PR + QC + deploy-verify results.
CREATE TABLE IF NOT EXISTS routine_run_log (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  repo_key             TEXT,
  command              TEXT NOT NULL,
  decision_rationale   TEXT,
  outcome              TEXT,
  gap_dimension        TEXT,
  pr_url               TEXT,
  reviewer_verdict     TEXT,
  deploy_verify_result TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routine_run_log_session_created
  ON routine_run_log(session_id, created_at DESC);

-- D10: hub-wide routine queue + per-session single-cycle lock. The global
-- concurrency cap (Phase 22) reads pending/running rows; the partial unique
-- index guarantees at most one running cycle per session (a second due-tick is
-- coalesced, not stacked). status constrained to the queue lifecycle.
CREATE TABLE IF NOT EXISTS routine_queue (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending',
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ
);
DO $$ BEGIN
  ALTER TABLE routine_queue ADD CONSTRAINT routine_queue_status_check
    CHECK (status IN ('pending','running','done','failed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Per-session lock: at most one running cycle per session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_queue_session_running
  ON routine_queue(session_id)
  WHERE status = 'running';
-- FIFO + priority drain order for the global queue (Phase 22).
CREATE INDEX IF NOT EXISTS idx_routine_queue_pending
  ON routine_queue(priority DESC, enqueued_at)
  WHERE status = 'pending';

-- D5/D8 (Phase 29): HITL approval markers consumed by the off-hours merge-to-main
-- command. P28 proposes high-tier commands (ship / complete-milestone / tag /
-- production-merge) to chat; a human approval writes one row here keyed by the
-- proposal tuple (session_id, command, content_sha). The off-hours merge command
-- reads UNCONSUMED markers, merges the matching PASS PRs, and marks them consumed
-- so a re-fired window cannot double-merge (R-ADO-25 idempotency). content_sha is
-- the proposal content hash (Phase 29 keys it on sha256(pr_url)). Append-only +
-- consumed_at flip; no data backfill (schema.sql re-runs every boot).
CREATE TABLE IF NOT EXISTS orchestrator_approvals (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  command     TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One approval per proposal tuple (P28 HITL contract).
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_approvals_tuple
  ON orchestrator_approvals(session_id, command, content_sha);
-- Fast unconsumed lookup per session (the merge command's hot read).
CREATE INDEX IF NOT EXISTS idx_orchestrator_approvals_unconsumed
  ON orchestrator_approvals(session_id)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_id      TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed','skipped','pending','in_flight','cancelled')),
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task ON scheduled_task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_user ON scheduled_task_runs(user_id, started_at DESC);

-- New columns on runs for the new scheduler. Idempotent.
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS target_kind TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS target_id TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6);
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS output_snippet TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS triggered_by_run_id TEXT REFERENCES scheduled_task_runs(id) ON DELETE SET NULL;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Phase 11: full snapshot of the runtime-context block the agent sender
-- prepended to this run's stdin. Stored as JSON (project_type, deploy_target,
-- version info, global_rules_digest, design_preferences, _stale flag, etc.)
-- for audit + repro. NULL on historical rows and on runs predating Wave 2.
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS runtime_context_snapshot JSONB;

-- Belt-and-suspenders for the cron-fire regression: ensure started_at always
-- has a DB-side default so an accidentally-omitted JS value never trips the
-- NOT NULL constraint. Idempotent.
ALTER TABLE scheduled_task_runs ALTER COLUMN started_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task_scheduled
  ON scheduled_task_runs(task_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_user_scheduled
  ON scheduled_task_runs(user_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_chained
  ON scheduled_task_runs(triggered_by_run_id) WHERE triggered_by_run_id IS NOT NULL;

-- Per-user daily spend cap for the scheduler cost guard and web push toggle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_cost_cap_usd NUMERIC(10,4) NOT NULL DEFAULT 10.0000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS web_push_enabled BOOLEAN NOT NULL DEFAULT true;

-- Phase 18 (R-PTY-18): opt-in programmatic-credit hard-halt bound. NULL = OFF
-- (the default — no surprise hard-stop). When set, dispatch on the programmatic/
-- automation path is denied at dailyCostCapGate once the polled programmatic
-- credit used_usd >= this bound. Human interactive PTY turns never hit this gate
-- for this reason. Idempotent DDL; no backfill (schema.sql re-runs every boot).
ALTER TABLE users ADD COLUMN IF NOT EXISTS programmatic_halt_usd NUMERIC(10,4) NULL;

-- ── Paused repos (per-(user, supervisor, repo_path)) ──────────────────────────
-- Set when the user explicitly clicks "Disconnect" on a session whose
-- project_dir matches a supervisor-managed repo. The supervisor MUST NOT
-- auto-spawn or restart-on-crash an agent for any repo in this table.
-- Cleared only by an explicit "Start"/"Resume" action from the web UI.
-- Survives hub restarts and supervisor reconnects.
CREATE TABLE IF NOT EXISTS paused_repos (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  supervisor_id TEXT NOT NULL REFERENCES supervisors(id) ON DELETE CASCADE,
  repo_path     TEXT NOT NULL,
  paused_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_reason TEXT,
  PRIMARY KEY (user_id, supervisor_id, repo_path)
);
CREATE INDEX IF NOT EXISTS idx_paused_repos_supervisor ON paused_repos(supervisor_id);

-- Auto-migrate on hub startup: hub/src/db/migrate.ts runs this file on boot.

-- Per-user timezone for daily cost-cap window + UI display.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- ── Multichat grid view: chat tabs ───────────────────────────────────────────
-- User-named tabs grouping multiple sessions into a grid view. Cascade chain:
-- users → chat_tabs → chat_tab_sessions ← sessions. Deleting any of those rows
-- cleans up downstream membership automatically.

CREATE TABLE IF NOT EXISTS chat_tabs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  layout     TEXT NOT NULL DEFAULT 'auto-fit' CHECK (layout IN ('3x3','4x3','auto-fit')),
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_tabs_user_position ON chat_tabs(user_id, position);

CREATE TABLE IF NOT EXISTS chat_tab_sessions (
  tab_id     UUID NOT NULL REFERENCES chat_tabs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tab_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_tab_sessions_tab_position ON chat_tab_sessions(tab_id, position);
CREATE INDEX IF NOT EXISTS idx_chat_tab_sessions_session ON chat_tab_sessions(session_id);

-- Phase 13 — grid-view UI state persistence (active tab + focused cell).
-- One row per user. `active_tab_id` is a free TEXT (the virtual Default tab uses
-- the reserved literal '__default__'; user tabs use the chat_tabs UUID as text).
-- `active_session_id` is the focused cell. Both nullable; survives reload/device.
-- Not FK-constrained on purpose: the virtual Default id is not a chat_tabs row,
-- and a deleted tab/session simply leaves a stale pointer the client ignores.
CREATE TABLE IF NOT EXISTS user_grid_state (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  active_tab_id     TEXT,
  active_session_id TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Repo grouping (per-user, many-to-many) ───────────────────────────────────
-- User-defined groups for organizing repos in the Connections tab + sidebar.
-- A repo (identified by repo_ident below) may belong to 0..N groups, and a repo
-- in N groups renders under EACH of those groups. Cascade chain:
-- users → repo_groups → repo_group_members. Additive only — no backfill, safe
-- to re-run every boot.
--
-- repo_ident is "github://<owner>/<repo>" for GitHub-backed repos (host-agnostic,
-- matches hub/src/lib/repo-key.ts buildRepoKey) or "path://<abs-path>" for
-- local-only folders. NOT foreign-keyed: repos live transiently in scan output /
-- sessions / pending_local_repos, so a membership may reference a repo not
-- currently scanned; the client tolerates stale idents (cf. user_grid_state).
CREATE TABLE IF NOT EXISTS repo_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_repo_groups_user_order
  ON repo_groups(user_id, sort_order, name);

CREATE TABLE IF NOT EXISTS repo_group_members (
  group_id    UUID NOT NULL REFERENCES repo_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for cheap user-scoped reads
  repo_ident  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, repo_ident)
);
CREATE INDEX IF NOT EXISTS idx_repo_group_members_user_ident
  ON repo_group_members(user_id, repo_ident);   -- "which groups is this repo in?" per user
CREATE INDEX IF NOT EXISTS idx_repo_group_members_group
  ON repo_group_members(group_id);

-- Per-user collapse state for group sections (cross-device, like user_grid_state).
-- One row per user; collapsed_group_ids is a JSON array of group-id strings that
-- are currently collapsed. The reserved literal '__ungrouped__' represents the
-- implicit Ungrouped section. Absent group ids default to EXPANDED. Not
-- FK-constrained: a deleted group leaves a stale id the client ignores.
CREATE TABLE IF NOT EXISTS user_repo_group_state (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  collapsed_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── BSA-03: orchestrator build-session autospawn repo allowlist ──────────────
-- Per-user allowlist of repos the auto-dev orchestrator may AUTOSPAWN a build
-- session for. EMPTY by default ⇒ autospawn drives NOTHING (fail-closed). The
-- whole autospawn capability is also gated OFF by REMO_ORCHESTRATOR_AUTOSPAWN, so
-- this table is inert until both the flag is flipped AND a row is added.
--
-- repo_ident: "github://<owner>/<repo>" or "path://<abs-path>" — same host-
-- agnostic format as repo_group_members (hub/src/lib/repo-key.ts). NOT FK'd to a
-- repos table (repos live transiently in scan output / sessions), matching the
-- repo-grouping convention. Additive, idempotent, no backfill — safe every boot.
CREATE TABLE IF NOT EXISTS orchestrator_autospawn_allowlist (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_ident  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, repo_ident)
);

-- ── Phase 05: per-session CLI selection + rootless ambient sessions ──────────
-- cli_kind: which CLI the agent spawns for this session ('claude' | 'codex').
-- is_rootless: ambient sessions that have no project_dir; at most one per
--   (user_id, hostname, cli_kind) enforced by the partial unique index below.
-- hostname: populated for rootless rows so the partial unique index can scope
--   uniqueness per host. Project sessions leave it NULL.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_kind TEXT NOT NULL DEFAULT 'claude';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='sessions_cli_kind_check') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_cli_kind_check CHECK (cli_kind IN ('claude','codex')); END IF; END $$;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_rootless BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hostname TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_rootless_unique ON sessions(user_id, hostname, cli_kind) WHERE is_rootless = true AND deleted_at IS NULL;

-- ── Phase 16: per-session runner type + persisted PTY backend identity (H10) ─
-- runner_type: 'stream-json' (existing structured ChatSurface runner) or
--   'pty-interactive' (the Phase-16 raw-terminal PTY surface). Opt-in per
--   session; default 'stream-json' so every existing row is unchanged. Idempotent
--   ADD COLUMN — re-runs safely every boot. NO data backfill here (CLAUDE.md
--   invariant: schema.sql is idempotent DDL only; backfills go in hub/scripts/).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name='sessions_runner_type_check') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_runner_type_check CHECK (runner_type IN ('stream-json','pty-interactive')); END IF; END $$;
-- Backend PTY/tmux identity + transcript path/id captured at PTY spawn so a
-- reconnect/restart RE-BINDS the same backend (no dual-spawn / no mis-route —
-- H10). Nullable so non-PTY rows are unaffected; NO backfill.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pty_backend_id  TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS transcript_path TEXT;

-- ── Phase 05: per-user instruction blobs synced to agents via auth_ok.seed_files
-- create_if_absent semantics; agents never overwrite existing local files.
-- NEVER include API keys or auth tokens — codex_config_toml is secret-stripped on PUT.
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_global_md TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS codex_agents_md TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS codex_config_toml TEXT;

-- ── Nav reorg: avatar (stored as data URL, capped at 1MB server-side)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- ── Error capture (06-error-capture) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS error_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sentry_key      TEXT NOT NULL UNIQUE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  dedupe_window_seconds  INTEGER NOT NULL DEFAULT 60,
  rate_limit_per_hour    INTEGER NOT NULL DEFAULT 20,
  daily_dispatch_cap     INTEGER NOT NULL DEFAULT 50,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_projects_user ON error_projects(user_id, enabled);
CREATE INDEX IF NOT EXISTS idx_error_projects_sentry_key ON error_projects(sentry_key);
-- B2 (obs): hub self-capture rows have no session (dispatch is disabled).
-- Idempotent relax of NOT NULL — safe on re-run.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'error_projects' AND column_name = 'session_id' AND is_nullable = 'NO'
  ) THEN
    EXECUTE 'ALTER TABLE error_projects ALTER COLUMN session_id DROP NOT NULL';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES error_projects(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,
  error_type      TEXT NOT NULL,
  error_value     TEXT NOT NULL,
  stacktrace_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  release         TEXT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_status TEXT NOT NULL DEFAULT 'pending'
                  CHECK (dispatch_status IN ('pending','dispatched','skipped','failed','deduped','rate_limited','cap_exceeded')),
  dispatched_at   TIMESTAMPTZ NULL,
  skip_reason     TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_errors_project_received ON errors(project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint_dedupe ON errors(fingerprint, project_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_errors_pending ON errors(project_id) WHERE dispatch_status='pending';

CREATE TABLE IF NOT EXISTS error_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_id        UUID NOT NULL REFERENCES errors(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES error_projects(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_flight','success','failed','skipped','cancelled')),
  started_at      TIMESTAMPTZ NULL,
  finished_at     TIMESTAMPTZ NULL,
  output_snippet  TEXT NULL,
  error           TEXT NULL,
  cost_usd        NUMERIC(10,6) NULL,
  duration_ms     INTEGER NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_runs_project ON error_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_runs_error ON error_runs(error_id, created_at DESC);
-- Idempotent column adds for existing prod DBs that pre-date cost/duration tracking.
ALTER TABLE error_runs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10,6) NULL;
ALTER TABLE error_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER NULL;

CREATE TABLE IF NOT EXISTS notifications_sent (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('dedupe_hit','rate_limit','daily_cap','dispatch_failed','session_offline','stack_not_detected','propose_roadmap')),
  dedupe_key      TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_sent_lookup ON notifications_sent(kind, dedupe_key, sent_at DESC);
-- Idempotent CHECK relax for existing prod DBs to allow new kinds:
--   stack_not_detected (W5) · propose_roadmap (auto-dev P3 propose-to-chat).
ALTER TABLE notifications_sent DROP CONSTRAINT IF EXISTS notifications_sent_kind_check;
ALTER TABLE notifications_sent ADD CONSTRAINT notifications_sent_kind_check
  CHECK (kind IN ('dedupe_hit','rate_limit','daily_cap','dispatch_failed','session_offline','stack_not_detected','propose_roadmap'));

-- ── Phase 06 plan 007: GitHub-issue post-run idempotency ─────────────────────
-- Skips duplicate issue creation for the same (repo, app_uuid, deploy_uuid)
-- within a 24h window. Hash = sha256(`${repo}|${app_uuid}|${deploy_uuid}`).
CREATE TABLE IF NOT EXISTS github_issue_idempotency (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash           TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_number   INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_gh_idem_created ON github_issue_idempotency(created_at);

-- ── auto-dev P4: QC finding-hash idempotency ─────────────────────────────────
-- Loop-safety guard for the `qc` routine (review → fix → verify). After a
-- finding is fixed-and-verified (qc_verify green + PR opened), its hash is
-- recorded here. The qc_review post-run router SKIPS chaining a fix for any
-- finding whose hash was verified within the last 24h, so the routine can't
-- oscillate forever on a finding the agent can't actually resolve. Same shape
-- as github_issue_idempotency. Hash = sha256(`${repo}|${file}|${finding_type}|${top_line}`).
CREATE TABLE IF NOT EXISTS qc_finding_idempotency (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash        TEXT NOT NULL,
  repo        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_qc_finding_idem_created ON qc_finding_idempotency(created_at);

-- ── auto-dev P5: Coolify deploy-failure storm dedupe ─────────────────────────
-- The Coolify webhook path has no fingerprint dedupe (error-capture does), so a
-- crash-looping app emitting 50 `deployment.failed` events in a row would fire
-- 50 triage fix dispatches. This guard collapses a storm to ONE fix per
-- (user, application_uuid, fingerprint) within a short window. Fingerprint is a
-- coarse signal off the webhook payload (application_uuid + git_repository +
-- commit_sha + a time bucket) — see hub/src/scheduler/deploy-fingerprint.ts.
-- Same idempotent shape as github_issue_idempotency.
CREATE TABLE IF NOT EXISTS coolify_deploy_idempotency (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_uuid TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, application_uuid, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_coolify_deploy_idem_created ON coolify_deploy_idempotency(created_at);

-- ── feat/coolify-uuid-repo-map: application_uuid → repo_key cache ─────────────
-- Coolify's `deployment.failed` webhook carries only `application_uuid` (no
-- `git_repository`), so the repo-keyed deploy-failure router can't derive a
-- `repo_key` from the payload. This table caches the uuid→repo_key mapping
-- resolved lazily from the Coolify API (GET /api/v1/applications/{uuid}) so the
-- triage fix can land in the session bound to the failing repo. user-scoped.
-- Lazy-populated at runtime (NO inline backfill — idempotent DDL only); a stale
-- row (>24h) is re-resolved by the resolver. `git_full_url` is kept for audit.
CREATE TABLE IF NOT EXISTS coolify_app_repo (
  application_uuid TEXT NOT NULL,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_key         TEXT,
  git_full_url     TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (application_uuid, user_id)
);
CREATE INDEX IF NOT EXISTS idx_coolify_app_repo_user ON coolify_app_repo(user_id);

-- ── Phase 04 plan 002: supervisor budget + preferred-supervisor routing ──────
-- Columns the hub remembers for each supervisor's reported resource budget.
-- A supervisor is SUPPOSED to report its cgroup-derived `concurrency_budget`
-- periodically via the `host_resources` WS message (Plan 001) — but that report
-- is not yet implemented supervisor-side (budget_source stays NULL), so the
-- column DEFAULT is the effective per-supervisor concurrency cap for every host.
-- It was 1, which permanently starved user sessions because the always-on
-- orchestrator run consumes the single slot — and every MSI upgrade rotates the
-- api_key into a FRESH supervisors row that inherits this default. Default is
-- now 8 (orchestrator + ~7 concurrent work sessions on a dev host). Users can
-- still tune per-supervisor via `concurrency_override` (clamped to budget*2).
-- `budget_source` records which cgroup/host path produced the budget.
-- `budget_updated_at` lets the UI detect stale reports.
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS cpu_cores INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS total_mem_mb INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS free_mem_mb INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS concurrency_budget INTEGER NOT NULL DEFAULT 8;
-- Existing DBs created the column with DEFAULT 1; raise it idempotently so
-- post-MSI-upgrade rows (new api_key → new row) come up at 8, not 1.
ALTER TABLE supervisors ALTER COLUMN concurrency_budget SET DEFAULT 8;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS concurrency_override INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS budget_source TEXT
  CHECK (budget_source IS NULL OR budget_source IN ('cgroup_v2','cgroup_v1','host_fallback'));
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS budget_updated_at TIMESTAMPTZ;

-- Per-user preferred supervisor for self-heal routing (Plan 008 consumer).
-- NULL means "no preference — pick any online supervisor".
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_supervisor_id TEXT
  REFERENCES supervisors(id) ON DELETE SET NULL;

-- Per-user daily cost cap in cents (defaults to $20 per ARCHITECTURE-REVIEW §7).
-- Note: schema also has a separate legacy `daily_cost_cap_usd NUMERIC` column
-- used by the scheduler cost guard. This `_cents` column is Phase 04's
-- integer-cent form for the hub-wide cap added by Plan 009.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_cost_cap_cents INTEGER NOT NULL DEFAULT 2000;

CREATE INDEX IF NOT EXISTS idx_users_preferred_supervisor
  ON users(preferred_supervisor_id) WHERE preferred_supervisor_id IS NOT NULL;

-- ── Phase 07: Titanium auth cutover (additive only) ───────────────────────────
-- Links remo-code users to Titanium Licensing (Keygen) subjects + tracks the
-- license cache + opaque server-side session tokens. password_hash is made
-- nullable so future magic-link-only users can exist without one. The full
-- removal of password_hash + bcrypt is deferred to Phase 07.5.
-- NOTE: `auth_sessions` is intentionally NOT named `sessions` — the existing
-- `sessions` table above means "Claude Code conversation sessions".
ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_subject TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_titanium_subject
  ON users(titanium_subject) WHERE titanium_subject IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_titanium_sync_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_checked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS titanium_link_status TEXT
  CHECK (titanium_link_status IN ('linked','pending_verify','mismatch') OR titanium_link_status IS NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS candidate_subject TEXT;

-- Drop NOT NULL on password_hash only if currently NOT NULL (idempotent guard).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_hash' AND is_nullable='NO') THEN ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL; END IF; END $$;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata   JSONB
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user_ts ON auth_events(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_type_ts ON auth_events(event_type, ts DESC);

-- ── Phase 06 plan 001: Coolify webhook HMAC secret + deployment metadata ─────
-- Missing ALTERs that shipped in code but never landed in schema.sql.
-- Result: GET /api/account/coolify-webhook-secret 500'd on prod (column
-- "coolify_webhook_secret" does not exist) and POST /api/coolify/webhook/:uid
-- would also fail at insertDeploymentRun. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_webhook_secret TEXT;

ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS deployment_uuid TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS application_uuid TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS git_repository TEXT;
ALTER TABLE scheduled_task_runs ADD COLUMN IF NOT EXISTS commit_sha TEXT;

-- ── fix/coolify-webhook-url-token: IP allowlist (Part 3) ─────────────────────
-- Optional comma-separated IPv4 / IPv6 / CIDR list. NULL = allow all (back-compat).
ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_webhook_allowed_ips TEXT;

-- ── fix/coolify-triage-guard: master on/off switch for failed-deploy auto-triage ──
-- When false, a `deployment.failed` webhook still persists its metadata row but
-- skips dispatching a triage session (audit reason `auto_triage_disabled`).
-- Default true preserves existing behavior.
ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_auto_triage_enabled BOOLEAN NOT NULL DEFAULT true;

-- ── fix/coolify-webhook-deprecation-banner ───────────────────────────────────
-- Set whenever the legacy HMAC route ingests a valid webhook (deprecated
-- format). The Settings UI reads this to surface a "rotate to migrate" amber
-- banner. Cleared on rotate (new URL-token secret minted). NULL = never hit
-- the legacy route OR already migrated.
ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_webhook_legacy_hit_at TIMESTAMPTZ;

-- ── fix/coolify-webhook-url-token: webhook attempt audit log (Part 2) ────────
-- Every hit (success + auth-fail + ip-reject) is logged so the user can see
-- in the UI whether Coolify is actually reaching them. Capped at 100 rows/user
-- via app-side delete-oldest in the same transaction as insert.
CREATE TABLE IF NOT EXISTS coolify_webhook_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip TEXT,
  event_type TEXT,
  status TEXT NOT NULL,        -- 'success' | 'auth_failed' | 'ip_rejected' | 'bad_payload' | 'rate_limited' | 'legacy_hmac' | 'ignored'
  reason TEXT,
  raw_body_preview TEXT        -- first 500 chars; never the token/secret
);
CREATE INDEX IF NOT EXISTS idx_coolify_webhook_attempts_user_recv
  ON coolify_webhook_attempts(user_id, received_at DESC);

-- ── feat/claude-usage-thresholds ─────────────────────────────────────────────
-- Per-user thresholds for the Anthropic OAuth usage gate. Compared against the
-- in-memory snapshot from agent/src/usage-poller.ts (utilization is already a
-- percentage 0-100). NULL = gate OFF (back-compat — existing users are not
-- silently opted in on deploy).
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_session_threshold_pct INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_week_threshold_pct INTEGER;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_claude_session_threshold_pct_range
    CHECK (claude_session_threshold_pct IS NULL
           OR (claude_session_threshold_pct BETWEEN 1 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_claude_week_threshold_pct_range
    CHECK (claude_week_threshold_pct IS NULL
           OR (claude_week_threshold_pct BETWEEN 1 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New run status: 'skipped_quota' — distinguishes threshold-gated skips from
-- daily-cost-cap skips so the run history drawer can filter them separately.
DO $$ BEGIN
  ALTER TABLE scheduled_task_runs DROP CONSTRAINT IF EXISTS scheduled_task_runs_status_check;
  ALTER TABLE scheduled_task_runs ADD CONSTRAINT scheduled_task_runs_status_check
    CHECK (status IN ('running','success','failed','skipped','pending','in_flight','cancelled','skipped_quota'));
EXCEPTION WHEN others THEN NULL; END $$;

-- ── Phase 08: GitHub-backed session keying ───────────────────────────────────
-- Additive: collapses N worktrees of one GitHub repo into ONE session per user.
-- NULL repo_key = legacy / local-only / unclassified — partial unique index
-- excludes those rows so we never collide on NULL. Lazy migration via the DAL
-- on next agent connect (see ARCHITECTURE.md §4–§5).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_key TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_owner TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS superseded_by TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_repo_key
  ON sessions(user_id, repo_key)
  WHERE repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_superseded
  ON sessions(superseded_by) WHERE superseded_by IS NOT NULL;

-- Per-(user, hostname, project_dir) dismissals so the "create or dismiss"
-- prompt never re-appears for a folder the user said no to.
CREATE TABLE IF NOT EXISTS dismissed_local_sessions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname     TEXT NOT NULL,
  project_dir  TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hostname, project_dir)
);

-- Folders the agent/supervisor has reported as "not on GitHub yet". Surfaced
-- in the Connect modal so the user can pick Create or Dismiss without the
-- agent re-announcing. Refreshed on every agent connect.
CREATE TABLE IF NOT EXISTS pending_local_repos (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname      TEXT NOT NULL,
  project_dir   TEXT NOT NULL,
  is_git_repo   BOOLEAN NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hostname, project_dir)
);
CREATE INDEX IF NOT EXISTS idx_pending_local_repos_user ON pending_local_repos(user_id);

-- ── Orchestrator session (one per user, pinned root-folder Claude) ──────────
-- Pinned Claude session that runs in the supervisor's roots[0] (not inside a
-- specific repo) and is taught via system prompt to coordinate the user's
-- other sessions via the hub HTTP API. Exactly one open orchestrator session
-- per user is enforced by the partial unique index below. The orchestrator
-- session row has `is_orchestrator=true` and `project_dir` set to the
-- supervisor's root folder.
ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_name TEXT NOT NULL DEFAULT 'Orchestrator';
ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_custom_instructions TEXT;

-- orchestrator-autolaunch (2026-05-28): the orchestrator now auto-launches on
-- supervisor connect and is on-by-default. Flip the column default to true for
-- NEW users, add an explicit-disable sentinel so a user who turns it OFF in the
-- UI is never re-enabled by a future migration or fought by the machine-
-- triggered auto-launch, then backfill the existing fleet to enabled (except
-- anyone already carrying the sentinel). All idempotent.
ALTER TABLE users ALTER COLUMN orchestrator_enabled SET DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_disabled_explicitly BOOLEAN NOT NULL DEFAULT false;
-- Convergence guard (`AND orchestrator_enabled = false`): runMigrations() runs
-- this whole file on EVERY hub boot — without the guard the UPDATE row-locks +
-- rewrites every non-sentinel user row on every deploy (bloat/autovacuum churn).
-- With it, the statement matches 0 rows once converged.
-- schema-lint: allow convergent — `AND orchestrator_enabled = false` guard ⇒ WHERE matches 0 rows once converged
UPDATE users SET orchestrator_enabled = true
  WHERE orchestrator_disabled_explicitly = false AND orchestrator_enabled = false;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_orchestrator BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_orchestrator_unique
  ON sessions(user_id)
  WHERE is_orchestrator = true AND deleted_at IS NULL;

-- Tag rows produced by the orchestrator-key mint so they don't conflict with
-- the per-user single-supervisor api_keys uniqueness. Existing rows backfill
-- to 'supervisor'.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'supervisor';
-- schema-lint: allow convergent — column is NOT NULL DEFAULT 'supervisor' ⇒ NULL/'' matches 0 rows once applied
UPDATE api_keys SET purpose = 'supervisor' WHERE purpose IS NULL OR purpose = '';

-- The legacy partial unique index `idx_api_keys_user_active` enforces ONE
-- active key per user — incompatible with an orchestrator-purpose key
-- coexisting with the supervisor key. Dropped here.
-- Its former replacement (`idx_api_keys_user_purpose_active`, unique on
-- (user_id, purpose)) is GONE too — milestone SKEY allows N active
-- purpose='external' keys per user, so a (user_id, purpose) unique would
-- unique_violation on schema apply and prevent the hub from booting. The
-- surviving invariants (one active supervisor key, one active orchestrator key)
-- are enforced by the purpose-specific partial uniques at the SKEY block below.
-- schema-lint: allow idempotent DDL — IF EXISTS drop of a legacy index; no-op on every boot after the first
DROP INDEX IF EXISTS idx_api_keys_user_active;

-- ── Phase 08: Revanote annotation integration ────────────────────────────────
-- Per-user webhook secret (UUID). NULL = unconfigured. Doubles as URL-path
-- token AND Bearer credential on outbound callbacks. Mirrors the coolify-
-- webhook secret shape exactly; rotation is a single round-trip.
ALTER TABLE users ADD COLUMN IF NOT EXISTS revanote_webhook_secret TEXT;

-- Optional per-user revanote-cost split as a percentage of daily_cost_cap_usd.
-- NULL = default 60. 1..100. Sub-cap enforced inside the revanote dispatcher
-- so revanote storms cannot starve scheduled tasks (and vice versa).
ALTER TABLE users ADD COLUMN IF NOT EXISTS revanote_budget_pct INTEGER;
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_revanote_budget_pct_range
    CHECK (revanote_budget_pct IS NULL OR (revanote_budget_pct BETWEEN 1 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Repo→app mapping. Hostname pattern matches the annotation's page_url host
-- (supports literal + leading-glob `*.example.com`). Most-specific wins (tie
-- breaker: most-recently-updated). `auto_created=true` rows are inserted by
-- the smart-fallback path and surfaced to the user for confirmation before
-- being treated as authoritative.
CREATE TABLE IF NOT EXISTS revanote_app_mappings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname_pattern  TEXT NOT NULL,
  repo_path         TEXT NOT NULL,
  supervisor_id     TEXT REFERENCES supervisors(id) ON DELETE SET NULL,
  deploy_strategy   TEXT NOT NULL DEFAULT 'pr'
    CHECK (deploy_strategy IN ('pr', 'direct', 'none')),
  auto_merge        BOOLEAN NOT NULL DEFAULT false,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  auto_created      BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Self-heal containment: `deploy_strategy='direct'` and `auto_merge=true` let a
-- WEBHOOK-DERIVED (untrusted) annotation reach main without human review. They stay
-- possible, but only for a mapping the owner has explicitly marked trusted. Default
-- false = propose-only (PR). Idempotent DDL — schema.sql re-runs every boot.
ALTER TABLE revanote_app_mappings
  ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_revanote_app_mappings_user
  ON revanote_app_mappings(user_id);
CREATE INDEX IF NOT EXISTS idx_revanote_app_mappings_user_host
  ON revanote_app_mappings(user_id, hostname_pattern);

-- Annotation rows are the durable record of every inbound revanote webhook.
-- `annotation_id_external` is revanote's own id; we UNIQUE on (user_id, that)
-- so revanote-side retries are idempotent. `payload_raw` preserves the entire
-- webhook body so any future field (element_meta, capture_viewport, …) is
-- available to the agent prompt without schema churn.
CREATE TABLE IF NOT EXISTS annotations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  annotation_id_external   TEXT NOT NULL,
  page_url                 TEXT NOT NULL,
  annotation_url           TEXT,
  screenshot_url           TEXT,
  x                        DOUBLE PRECISION,
  y                        DOUBLE PRECISION,
  element_selector         TEXT,
  comment                  TEXT NOT NULL,
  replies_json             JSONB NOT NULL DEFAULT '[]'::jsonb,
  callback_url             TEXT NOT NULL,
  mapping_id               UUID REFERENCES revanote_app_mappings(id) ON DELETE SET NULL,
  session_id               TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dispatched', 'resolved', 'failed', 'failed_offline')),
  skip_reason              TEXT,
  source_ip                TEXT,
  payload_raw              JSONB NOT NULL,
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at            TIMESTAMPTZ,
  resolved_at              TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_user_external
  ON annotations(user_id, annotation_id_external);
CREATE INDEX IF NOT EXISTS idx_annotations_user_recv
  ON annotations(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotations_status
  ON annotations(status) WHERE status IN ('pending', 'dispatched');

CREATE TABLE IF NOT EXISTS annotation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id   UUID NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'success', 'failed', 'cancelled')),
  resolved        BOOLEAN,
  action_taken    TEXT,
  agent_reply     TEXT,
  files_changed   JSONB,
  deployed        BOOLEAN NOT NULL DEFAULT false,
  error           TEXT,
  cost_usd        NUMERIC(10, 6),
  duration_ms     INTEGER,
  output_snippet  TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_annotation_runs_annotation
  ON annotation_runs(annotation_id);
CREATE INDEX IF NOT EXISTS idx_annotation_runs_user_started
  ON annotation_runs(user_id, started_at DESC);

-- Callback retry queue. `next_retry_at IS NULL` means terminal (delivered or
-- dead-lettered). Worker scans the partial index for next_retry_at <= now().
CREATE TABLE IF NOT EXISTS revanote_callback_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  annotation_id  UUID NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  attempt_no     INTEGER NOT NULL DEFAULT 0,
  http_status    INTEGER,
  error          TEXT,
  attempted_at   TIMESTAMPTZ,
  next_retry_at  TIMESTAMPTZ,
  delivered      BOOLEAN NOT NULL DEFAULT false,
  dead           BOOLEAN NOT NULL DEFAULT false,
  payload_json   JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revanote_callback_attempts_pending
  ON revanote_callback_attempts(next_retry_at)
  WHERE next_retry_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revanote_callback_attempts_annotation
  ON revanote_callback_attempts(annotation_id);

-- Audit log for every webhook hit (success + auth-fail + ip-reject). Capped
-- app-side to 100 rows/user, oldest-deleted on each insert. Mirrors
-- coolify_webhook_attempts.
CREATE TABLE IF NOT EXISTS revanote_webhook_attempts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_ip         TEXT,
  event_type        TEXT,
  status            TEXT NOT NULL,
  reason            TEXT,
  raw_body_preview  TEXT
);
CREATE INDEX IF NOT EXISTS idx_revanote_webhook_attempts_user_recv
  ON revanote_webhook_attempts(user_id, received_at DESC);

-- ── Phase 12 (Wave 2): UI restructure backend deltas ─────────────────────────
-- All additive, idempotent. Consumed by the new Home/Tasks/Settings nav.
--
-- auto_nudge_idle_sessions: per-user preference to auto-nudge idle Claude
--   sessions (consumed by Prompts tab). False default keeps existing behavior.
-- notifications: per-user notifications config blob (web push, email digest,
--   per-channel toggles). Empty object default — UI fills schema lazily.
--
-- NOTE: supervisors.roots, users.timezone, users.avatar_url, users.display_name,
-- users.claude_global_md / codex_agents_md / codex_config_toml all exist
-- already (earlier phases). This block only adds what was missing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_nudge_idle_sessions BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Partial index for the Tasks → Activity "in-flight" filter chip.
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_in_flight
  ON scheduled_task_runs(user_id, started_at DESC)
  WHERE finished_at IS NULL AND status IN ('running','pending','in_flight');

-- ── TRIAGE Bundle 6: Postgres race + ordering hygiene ────────────────────────
-- Restored per REVIEW.md BL-04 + BL-05 (Wave 5 over-reverted these alongside
-- the orchestrator removal — they are unrelated to the orchestrator).
--
-- ── Phase 12: Telegram bridge ────────────────────────────────────────────────
-- Additive columns on users — link state for the hub-wide Telegram bot.
-- chat_id is BIGINT (Telegram chat ids exceed 32-bit). UNIQUE enforces 1
-- Telegram chat ↔ 1 remo-code user. default_session_id is nullable and
-- SET NULL on session delete so outbound silently stops rather than orphaning.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id              BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_default_session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL;
-- True ONLY when the user explicitly picked the default via `/session <id>` or
-- by tapping a button in the `/list` inline picker. Auto-pins (lazy-pin in the
-- inbound dispatcher, prewarm-on-link) leave it false so orchestrator-as-default
-- resolution can still prefer the root orchestrator for a no-choice user, while
-- an EXPLICIT repo choice is always honored and never surprise-switched.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_default_explicit     BOOLEAN NOT NULL DEFAULT false;
-- NOTE: there is intentionally NO backfill UPDATE here. schema.sql is re-applied
-- on EVERY hub boot (hub/src/db/migrate.ts runMigrations), so a
-- `SET explicit=true WHERE default IS NOT NULL` would re-run on every redeploy and
-- clobber legitimate post-launch auto-pins (lazy-pin / prewarm write explicit=false
-- on purpose so the orchestrator can still win for a no-choice user). The one-time
-- backfill of PRE-EXISTING prod pins lives in
-- hub/scripts/migrate-telegram-default-explicit.ts and is run manually exactly once.
-- A fresh DB needs no backfill (no pre-existing pins) — DEFAULT false is correct.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_link_code_expires_at TIMESTAMPTZ;

-- Audit log for every Telegram webhook update we accept (incl. silent-drops
-- of unlinked chat_ids). Capped app-side to 100/user, oldest-deleted on each
-- insert. Mirrors coolify_webhook_attempts / revanote_webhook_attempts.
-- (chat_id, update_id) UNIQUE short-circuits Telegram retries (Telegram
-- retries non-2xx for up to 24h).
CREATE TABLE IF NOT EXISTS telegram_inbound_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  chat_id      BIGINT,
  update_id    BIGINT,
  outcome      TEXT NOT NULL,
  error        TEXT,
  raw          JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, update_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_inbound_log_user_recv
  ON telegram_inbound_log(user_id, received_at DESC);
-- ── Phase 12.1: mobile auth handoff tokens ────────────────────────────────────
-- One-time tokens minted at /api/auth/login/callback?platform=ios|android.
-- The opaque token is delivered to the Tauri shell via `remo-code://auth/callback`
-- deep link; the shell exchanges it via POST /api/auth/finalize-mobile for a
-- normal cookie session. Single-use, 60s TTL.
CREATE TABLE IF NOT EXISTS auth_handoff_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'mobile_handoff',
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_handoff_tokens_hash
  ON auth_handoff_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_handoff_tokens_user
  ON auth_handoff_tokens(user_id);
-- ── TRIAGE Bundle 6: Postgres race + ordering hygiene ────────────────────────
-- Restored per REVIEW.md BL-04 + BL-05 (Wave 5 over-reverted these alongside
-- the orchestrator removal — they are unrelated to the orchestrator).
--
-- Partial unique index on (user_id, project_dir) for non-rootless, live rows.
-- Backs the atomic ON CONFLICT in findOrCreateAgentSession (dal.ts) so two
-- concurrent agent reconnects for the same project_dir converge on ONE row
-- instead of racing into a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_project_unique
  ON sessions(user_id, project_dir)
  WHERE deleted_at IS NULL AND is_rootless = false;

-- Monotonic per-row sequence to disambiguate same-millisecond inserts in
-- ORDER BY created_at queries. Nullable + DEFAULT nextval via BIGSERIAL so
-- existing rows backfill cleanly on first scan.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- ── P2 Usage cost ledger ─────────────────────────────────────────────────────
-- Per-turn token + cost ledger captured from the Claude CLI `result` stream
-- (supervisor emits `usage_event`). cost_usd is the SDK's authoritative
-- total_cost_usd when cost_source='sdk', else a hub list-price ESTIMATE
-- (cost_source='estimated'). NOT billed dollars — a subscription list-price
-- equivalent. P2 only RECORDS; the cost cap (P3) is unaffected.
--
-- Idempotent DDL only (this file re-runs in full every hub boot). Any backfill
-- belongs in hub/scripts/, never here.
CREATE TABLE IF NOT EXISTS token_usage (
  id                          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id                  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  model                       TEXT,
  input_tokens                BIGINT NOT NULL DEFAULT 0,
  output_tokens               BIGINT NOT NULL DEFAULT 0,
  cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_input_tokens     BIGINT NOT NULL DEFAULT 0,
  cost_usd                    NUMERIC(12,6) NOT NULL DEFAULT 0,
  cost_source                 TEXT NOT NULL DEFAULT 'sdk' CHECK (cost_source IN ('sdk','estimated')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_user_created ON token_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);

-- Daily per-(user, model) rollup, upserted on each usage_event for cheap
-- today/7d/total aggregates without scanning the full ledger.
CREATE TABLE IF NOT EXISTS token_usage_daily (
  user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day                         DATE NOT NULL,
  model                       TEXT NOT NULL DEFAULT '',
  input_tokens                BIGINT NOT NULL DEFAULT 0,
  output_tokens               BIGINT NOT NULL DEFAULT 0,
  cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_input_tokens     BIGINT NOT NULL DEFAULT 0,
  cost_usd                    NUMERIC(14,6) NOT NULL DEFAULT 0,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, model)
);
CREATE INDEX IF NOT EXISTS idx_token_usage_daily_user_day ON token_usage_daily(user_id, day DESC);

-- ── Phase 10: per-session auto-nudge override ────────────────────────────────
-- sessions.auto_nudge: per-session override for the auto-nudge-when-idle
--   behavior. NULLABLE on purpose: NULL means "inherit the user's global
--   default" (users.auto_nudge_idle_sessions). TRUE/FALSE force on/off for this
--   session regardless of the global. Effective value is currently resolved
--   CLIENT-SIDE in web ChatLayout.tsx as `session.auto_nudge ?? user.auto_nudge_idle_sessions`.
--   CONTRACT: any future server-side nudge dispatcher MUST resolve
--   `session.auto_nudge ?? user.auto_nudge_idle_sessions` too — do NOT nudge
--   unconditionally (NULL means inherit the per-user default, not "always on").
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auto_nudge BOOLEAN;

-- sessions.dangerously_skip_permissions: per-session toggle to bypass the CLI's
--   tool-permission prompts (--dangerously-skip-permissions). NULL or FALSE means
--   OFF; only TRUE requests skip. NEW sessions now DEFAULT ON (SET DEFAULT TRUE
--   below) — the hub passes the REQUESTED value on session.start, but the
--   supervisor's config `allow_dangerous_skip_permissions` is the HARD CEILING
--   (applied = requested && allowed), so the default only REQUESTS the bypass and
--   can never exceed the host config. Users can still turn an individual session
--   OFF via the web toggle. The default flip is backfilled to existing rows by the
--   one-shot `hub/scripts/backfill-skip-permissions-default-on.ts`.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS dangerously_skip_permissions BOOLEAN;
ALTER TABLE sessions ALTER COLUMN dangerously_skip_permissions SET DEFAULT TRUE;

-- ── Milestone TMAC §7.1: per-channel orchestrator-notify opt-in ──────────────
-- users.notify_channels: per-user opt-in/out for each orchestrator notify
--   channel. JSONB map {telegram,inapp,email,push}->bool. Consulted by
--   hub/src/orchestrator/notify.ts BEFORE fanning a channel out. Additive, no
--   backfill: DEFAULT is all-on so existing behavior is preserved, and a MISSING
--   key is treated as opted-IN (only an explicit `false` mutes a channel).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_channels JSONB NOT NULL
  DEFAULT '{"telegram":true,"inapp":true,"email":true,"push":true}'::jsonb;

-- ── Feedback intake (Option A) — per-app end-user feedback → bound session ────
-- feedback_keys: the per-app SUBMIT credential for the public feedback widget.
--   ONE key per app. token_hash is the SHA-256 of an opaque `fb_`-prefixed
--   token (32 random bytes, base64url) — the plaintext is shown ONCE at mint
--   time and never stored (same pattern as auth_sessions / api_keys). The
--   widget embeds the plaintext token and POSTs to /api/feedback/<token>; the
--   hub hashes it, looks up this row, and (when enabled) dispatches the
--   screenshot + comment into session_id via the shared dispatch pipeline.
--   Disable a leaked key by setting enabled=false (revoke without delete).
--   Idempotent DDL only — NO backfill (this re-runs every boot).
CREATE TABLE IF NOT EXISTS feedback_keys (
  token_hash  TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  label       TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_keys_user ON feedback_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_keys_session ON feedback_keys(session_id);


-- ── Milestone ASK — external session-ask API (Phase 1 + 2) ───────────────────
-- Idempotent DDL only — this file RE-RUNS IN FULL on every hub boot. No backfills.

-- api_keys.scopes: ADDITIVE and NULLABLE. NULL = legacy full access (every key
-- minted before this milestone keeps working, including /ws/agent). A key with a
-- non-null array must carry 'ext:read' to use the /api/ext read surface and
-- 'ext:ask' to spend tokens via POST /api/ext/sessions/:id/ask.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[];

-- session_asks: one row per external ask. `session_id` is the session ANSWERING
-- (a stream-json ask-session bound to the target's project_dir); `target_session_id`
-- is the session ASKED ABOUT (may be pty-interactive — we never write to it).
CREATE TABLE IF NOT EXISTS session_asks (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  target_session_id TEXT,
  api_key_id        TEXT,
  question          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  answer            TEXT,
  confidence        TEXT,
  evidence          JSONB,
  raw_reply         TEXT,
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_asks_user_created ON session_asks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_asks_status ON session_asks(status);


-- ── Milestone SKEY — named, scoped, multi API keys ───────────────────────────
-- Idempotent DDL only — this file RE-RUNS IN FULL on every hub boot. No backfills.
-- `scopes` is declared once, above (milestone ASK). SKEY adds 'agent' to the
-- vocabulary: a non-null array must carry 'agent' to authenticate a
-- supervisor/agent socket (/ws/agent, /api/plugin/*).

-- Display-only prefix of the plaintext key (e.g. 'remokey_ab12…'), captured at
-- mint time so the Credentials table can identify a row without ever storing the
-- key. NULL on legacy rows (the plaintext is gone — UI shows an em dash).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;

-- N keys per user. The old per-(user,purpose) unique index made every key a
-- singleton per purpose, which blocks minting several scoped 'external' keys.
-- Keep the at-most-one-active invariant ONLY where it is load-bearing:
-- purpose='supervisor' (the spawn credential) and purpose='orchestrator'.
-- The superseded CREATE of idx_api_keys_user_purpose_active is DELETED (not
-- guarded) further up — schema.sql re-runs IN FULL every boot, so leaving the
-- stale CREATE alongside this DROP would recreate a (user_id,purpose) unique
-- index each boot and hard-fail the apply (hub does not boot) the moment a user
-- legitimately holds two active purpose='external' keys. Same failure mode the
-- comment at the top of this file documents. Regression: hub/test/schema-double-apply.test.ts.
-- schema-lint: allow idempotent DDL — IF EXISTS drop of a legacy index; no-op once no such index exists
DROP INDEX IF EXISTS idx_api_keys_user_purpose_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_supervisor_active
  ON api_keys(user_id) WHERE revoked_at IS NULL AND purpose = 'supervisor';
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_orchestrator_active
  ON api_keys(user_id) WHERE revoked_at IS NULL AND purpose = 'orchestrator';
