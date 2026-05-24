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

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id) WHERE revoked_at IS NULL;
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
-- Ensure all active keys have the supervisor cap (idempotent backfill)
UPDATE api_keys SET capabilities = ARRAY['agent','supervisor'] WHERE capabilities IS NULL OR NOT ('supervisor' = ANY(capabilities));

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
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS task_type TEXT NOT NULL DEFAULT 'prompt'
  CHECK (task_type IN ('prompt','skill','security_scan','log_check','continue_dev'));
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

-- W2/T8: drop legacy NOT NULL on session_id so fan-out tasks
-- (all_agents/all_supervisors) and supervisor-targeted tasks can omit it.
-- Idempotent — Postgres no-ops if the column is already nullable.
ALTER TABLE scheduled_tasks ALTER COLUMN session_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_fire
  ON scheduled_tasks(next_fire_at) WHERE enabled;

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

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task_scheduled
  ON scheduled_task_runs(task_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_user_scheduled
  ON scheduled_task_runs(user_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_chained
  ON scheduled_task_runs(triggered_by_run_id) WHERE triggered_by_run_id IS NOT NULL;

-- Per-user daily spend cap for the scheduler cost guard and web push toggle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_cost_cap_usd NUMERIC(10,4) NOT NULL DEFAULT 10.0000;
ALTER TABLE users ADD COLUMN IF NOT EXISTS web_push_enabled BOOLEAN NOT NULL DEFAULT true;

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
