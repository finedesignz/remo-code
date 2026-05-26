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
  kind            TEXT NOT NULL CHECK (kind IN ('dedupe_hit','rate_limit','daily_cap','dispatch_failed','session_offline','stack_not_detected')),
  dedupe_key      TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_sent_lookup ON notifications_sent(kind, dedupe_key, sent_at DESC);
-- Idempotent CHECK relax for existing prod DBs to allow the stack_not_detected kind (added in W5).
ALTER TABLE notifications_sent DROP CONSTRAINT IF EXISTS notifications_sent_kind_check;
ALTER TABLE notifications_sent ADD CONSTRAINT notifications_sent_kind_check
  CHECK (kind IN ('dedupe_hit','rate_limit','daily_cap','dispatch_failed','session_offline','stack_not_detected'));

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

-- ── Phase 04 plan 002: supervisor budget + preferred-supervisor routing ──────
-- Columns the hub remembers for each supervisor's reported resource budget.
-- A supervisor reports its cgroup-derived `concurrency_budget` periodically via
-- the `host_resources` WS message (Plan 001). The hub may also store an
-- admin/user-controlled `concurrency_override` that is hard-clamped server-side
-- to [1, concurrency_budget * 2] (see ARCHITECTURE-REVIEW §3).
-- `budget_source` records which cgroup/host path produced the budget.
-- `budget_updated_at` lets the UI detect stale reports.
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS cpu_cores INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS total_mem_mb INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS free_mem_mb INTEGER;
ALTER TABLE supervisors ADD COLUMN IF NOT EXISTS concurrency_budget INTEGER NOT NULL DEFAULT 1;
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
  status TEXT NOT NULL,        -- 'success' | 'auth_failed' | 'ip_rejected' | 'bad_payload' | 'rate_limited' | 'legacy_hmac'
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

