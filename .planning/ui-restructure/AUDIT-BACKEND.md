# UI Restructure — Backend Audit

**Scope:** `hub/` + `supervisor/` only. Audit-only — no code edits.
**Target nav:** Home (List + Grid) · Tasks (Upcoming + Activity + Schedule) · Settings (Connections + Credentials + Prompts + Usage + Profile).
**Methodology:** read `schema.sql`, `db/dal.ts`, `api/*`, `ws/protocol.ts`, `ws/agent-protocol.ts`, `index.ts`, `license-gate.ts`, supervisor `src/index.ts` + `config.ts` + `hub-client.ts`. Cross-referenced the parallel `remo-code-supervisor-improvements` worktree where it has shipped surfaces not yet on `main` (called out inline).

---

## 1. Data model adequacy

| Target feature | Current schema support | Gap |
|---|---|---|
| **Home → List View** (chat surface + sidebar) | `sessions(id,user_id,name,project_dir,status,cli_kind,is_rootless,hostname,agent_info,deleted_at,last_activity)` + `messages` + `idx_sessions_user_project`. `listSessions` already returns everything UI needs. | None. |
| **Home → Grid View** | `chat_tabs(id,user_id,name,layout,position)` + `chat_tab_sessions(tab_id,session_id,position)` (Phase 03). 12-session cap enforced server-side. WS `subscribe` overload accepts `session_ids[]`. | None. |
| **Tasks → Upcoming** (`next_fire_at > now()`) | `scheduled_tasks.next_fire_at` + `idx_scheduled_tasks_next_fire ON (next_fire_at) WHERE enabled`. | None — index exists. |
| **Tasks → Activity** (in-flight + recent runs) | `scheduled_task_runs(id,task_id,user_id,session_id,status,started_at,finished_at,completed_at,cost_usd,duration_ms,target_kind,target_id,scheduled_for,error)` + `idx_scheduled_runs_user(user_id, started_at DESC)`. | **No multi-task listing endpoint.** `/api/scheduled-task-runs` requires `task_id`. Need a new "all runs for user" endpoint, or extend the existing one to accept `task_id` optional with status filter. |
| **Tasks → Schedule grouped by repo** | `scheduled_tasks.target_kind/target_id` + `scheduled_tasks.session_id` (nullable). No `repo` column. Repo derived via `session_id → sessions.project_dir`. | **Server-side grouping requires a JOIN to `sessions.project_dir`**. UI could group client-side (current tasks list already returned with target metadata), but for `target_kind='supervisor'` or `target_kind='all_sessions'`, there is no inherent repo. Recommend deriving group key in the API response (`{...task, repo_group: project_dir | hostname | 'all'}`). |
| **Settings → Connections (root repo folder)** | Supervisor reads `roots: string[]` from `%LOCALAPPDATA%\remo-code-supervisor\config.json` at startup, sends in `supervisor.hello`. Hub holds it in `SupervisorEntry.roots` (in-memory `supervisor-registry`). **No DB persistence on `main`.** The `remo-code-supervisor-improvements` worktree has a `supervisors` table + `listSupervisorsForUser` DAL — not on `main`. | **Roots are not hub-controllable.** No endpoint, no WS event, no DB column. See §2/§3/§4 below. |
| **Settings → Credentials (webhooks)** | Coolify: `users.coolify_webhook_secret` + `coolify_webhook_attempts`. Revanote: `users.revanote_webhook_secret` + `revanote_webhook_attempts`. GitHub: gateway-fetched creds (not user-rotatable). Per-webhook rotate endpoints on `account.ts` for Coolify; Revanote endpoints in `revanote-webhook.ts` / DAL. | **No unified `GET /api/account/webhooks` summary.** UI today fetches per-provider. Adequate but inefficient — recommend a single endpoint. |
| **Settings → Credentials (API key)** | `api_keys(id,user_id,key_hash,name,capabilities[],created_at,last_used_at,revoked_at)` + `/api/api-keys` CRUD. | None. |
| **Settings → Prompts (auto-nudge)** | **Stored in `localStorage` (`remo:auto-nudge`).** No server persistence. No column. | **New column needed:** `users.auto_nudge BOOLEAN NOT NULL DEFAULT true`. Or store under a single `users.preferences JSONB` blob to avoid one-column-per-toggle churn going forward. |
| **Settings → Prompts (commands/skills)** | `seed_files` sent in `auth_ok` from hub → agent (`users.claude_global_md`, `users.codex_agents_md`, `users.codex_config_toml`). Edited via `PUT /api/instructions`. Supervisor commands synced via `SupervisorCommandsSync` WS message (agent → hub). | Edit form already wired. **No "list available commands/skills" GET for the prompts page** — the UI today reads from `agent_info` or last-seen sync. Need `GET /api/supervisors/:id/commands` (or piggyback on existing) for the UI's command picker. |
| **Settings → Usage (thresholds)** | `users.claude_session_threshold_pct` + `users.claude_week_threshold_pct` (PR #52). | None. |
| **Settings → Usage (cost caps)** | `users.daily_cost_cap_usd` (user-level) + `scheduled_tasks.cost_cap_usd_per_day` (per-task). | None. |
| **Settings → Usage (stats)** | `scheduled_task_runs.cost_usd` aggregable by `user_id` + `started_at`. `GET /api/profile/cost-today` exists (returns today's spend). No weekly/monthly rollup endpoint. In-memory `usage/store.ts` holds Anthropic OAuth window snapshot from agent. | **No `GET /api/usage/summary`** — UI would compute weekly/monthly on-the-fly via N queries. Recommend a single aggregation endpoint. |
| **Settings → Profile** | `users.display_name, avatar_url, system_prompt, daily_cost_cap_usd, web_push_enabled, timezone`. `/api/profile` GET + PATCH wired. | None. |

---

## 2. New endpoints needed

| METHOD | Path | Purpose | Auth | Request | Response |
|---|---|---|---|---|---|
| `GET` | `/api/tasks/activity` | All runs for user (across tasks) for Tasks → Activity tab. Filter by `status`, `since`, `limit`. | `auth` (license-gated) | query: `status?=running\|success\|failed\|skipped\|cancelled`, `since?=<iso>`, `limit?=1..200`, `cursor?` | `{ runs: ScheduledTaskRun[], next_cursor?: string }` |
| `GET` | `/api/tasks/upcoming` | Convenience: `scheduled_tasks WHERE enabled AND next_fire_at IS NOT NULL ORDER BY next_fire_at LIMIT 50`, optional `within=24h`. UI could compute from existing list — endpoint just avoids client filter logic + lets server cap. | `auth` (license-gated) | query: `within?=24h\|7d`, `limit?=1..100` | `{ tasks: ScheduledTask[] }` |
| `GET` | `/api/supervisors` | List user's supervisors (already exists in `improvements` worktree, NOT yet on `main`). Surfaces roots + status. | `auth` | — | `{ supervisors: [{id, hostname, status, roots[], last_seen_at, version}] }` |
| `PATCH` | `/api/supervisors/:id/roots` | Set the root repo folder list from the web UI. Persisted; pushed live via WS. **See §3/§4 decision matrix.** | `auth` + CSRF; `requireRecentAuth` **NO** (low-risk, scoped to user's own supervisor) | `{ roots: string[] }` (each absolute path, max 16 entries, each ≤ 512 chars) | `{ ok: true, applied: 'live'\|'queued' }` |
| `GET` | `/api/account/webhooks` | Unified credentials summary for Settings → Credentials card. | `auth` | — | `{ coolify: {configured, url?}, revanote: {configured, url?}, github: {connected, login?} }` |
| `POST` | `/api/account/revanote-webhook-secret/rotate` | Rotate Revanote webhook secret (parity with Coolify). Confirm — may already exist; not surfaced in audit scan. | `auth` + CSRF + `requireRecentAuth` | — | `{ url, token }` |
| `PATCH` | `/api/profile/preferences` | Server-persist `auto_nudge` + any future UI toggles. Recommend `JSONB` blob to avoid columns sprawl. | `auth` + CSRF | `{ auto_nudge?: boolean, ... }` | `{ preferences: {...} }` |
| `GET` | `/api/usage/summary` | Today / 7d / 30d cost rollups + Anthropic window snapshot for Settings → Usage. Aggregates `scheduled_task_runs.cost_usd` + reads `usage/store.ts`. | `auth` | query: `tz?=IANA` | `{ today_usd, week_usd, month_usd, daily_cap_usd, claude_window: {five_hour, seven_day, ...} }` |
| `GET` | `/api/supervisors/:id/commands` | List supervisor-discovered commands/skills (cached from last `supervisor.commands_sync` WS frame). Powers the Prompts tab picker. | `auth` | — | `{ commands: [{name, source, path?, description?}] }` |

**Note on `/api/scheduled-task-runs`:** could also be extended to accept `task_id?` (currently required) with a status filter, removing the need for `/api/tasks/activity`. Either works.

---

## 3. WS protocol additions

| Direction | Type | Purpose | Payload |
|---|---|---|---|
| Hub → Supervisor | `supervisor.set_roots` | Push updated roots from web UI to running supervisor without restart. | `{ type, roots: string[], req_id: string }` |
| Supervisor → Hub | `supervisor.set_roots_ack` | Ack with applied roots + scan trigger result. | `{ type, req_id, ok: boolean, applied_roots: string[], error?: string }` |
| Hub → Client (broadcast) | `supervisor.roots_changed` | Echo to other browser tabs / sessions so UI stays in sync. | `{ type, supervisor_id, roots: string[] }` |

**Already shipped (no action):** `key_rotated` (PR #98), `subscribe` overload (Phase 03), `error_*` events (Phase 06), `scheduled_run_*` (scheduler V2).

---

## 4. Schema migrations needed (additive only)

```sql
-- 4.1 Persist supervisor roots in DB so web UI is the source of truth.
--     Requires the `supervisors` table that lives in the improvements
--     worktree but not on main. Either land that table first OR store on
--     api_keys (one-supervisor-per-key model).
--
--     Option A — supervisors table (cleaner, matches improvements worktree):
CREATE TABLE IF NOT EXISTS supervisors (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  hostname    TEXT,
  roots       TEXT[] NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supervisors_user ON supervisors(user_id);

--     Option B — roots on api_keys (minimal, if we never get multi-supervisor):
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS roots TEXT[] NOT NULL DEFAULT '{}';

-- 4.2 Auto-nudge + future UI prefs (recommend JSONB blob over per-column).
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Reads: COALESCE((preferences->>'auto_nudge')::boolean, true)
-- (Avoids a follow-up ALTER for every new toggle.)

-- 4.3 Activity query coverage. Existing idx_scheduled_runs_user
-- (user_id, started_at DESC) already covers Activity tab queries.
-- Add a partial index for in-flight if PR shows hot-path:
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_in_flight
  ON scheduled_task_runs(user_id, started_at DESC)
  WHERE finished_at IS NULL AND status IN ('running','pending','in_flight');
```

**No drops, no NOT NULL on existing columns, no data backfill required.**

---

## 5. Performance considerations

- **`/api/tasks/activity`** — must paginate. 200/page cap. `idx_scheduled_runs_user(user_id, started_at DESC)` already supports `WHERE user_id=$1 AND started_at < $cursor` keyset pagination.
- **`/api/tasks/upcoming`** — `idx_scheduled_tasks_next_fire WHERE enabled` already optimal.
- **Schedule grouped by repo** — typical user has < 50 tasks. Group client-side from a single `GET /api/scheduled-tasks` call. Server JOIN to `sessions.project_dir` adds one row per task — acceptable.
- **`/api/usage/summary`** — Today + 7d + 30d sums over `scheduled_task_runs`. With `idx_scheduled_runs_user(user_id, started_at DESC)` the 30d slice is index-only-scannable. Cache for 60s in-memory (hot tab refresh, no need for DB round-trip on every poll).
- **`/api/supervisors/:id/roots` PATCH** — write to DB + send WS event to supervisor. Supervisor `set_roots_ack` confirms in ≤ 200 ms. If supervisor offline, queue: WS handler on next `auth_ok` re-pushes from DB.

**No new indices strictly required beyond 4.3 (optional).** Existing indices cover all new query shapes.

---

## 6. Auth / security implications

- **License-gate exclusion list stays identical.** New endpoints all live under `/api/*` and are license-gated (read-only GET fine during 7-day grace, mutations require ACTIVE).
- **`/api/supervisors/:id/roots` PATCH** — not sensitive enough for `requireRecentAuth`. Bad roots = bad scan = no data loss. CSRF only.
- **`/api/profile/preferences` PATCH** — CSRF only, no step-up.
- **`/api/account/revanote-webhook-secret/rotate`** — `requireRecentAuth` (parity with Coolify rotate).
- **WS `supervisor.set_roots`** — hub MUST verify the supervisor's connected `apiKeyId` belongs to the requesting `userId` (already done by `supervisor-registry` — confirm reuse).
- **Roots path validation** — reject `..`, NUL bytes, paths > 512 chars, list > 16 entries. Reject relative paths (must start with drive letter on Windows or `/` on POSIX). Server cannot stat the path (it's the supervisor's filesystem); validation is shape-only.

---

## 7. Migration / backward-compat

- **Deep links to retire** (add 301/redirects in `web/src/App.tsx`):
  - `#/schedules` → `#/tasks/schedule`
  - `#/settings?tab=schedules` → `#/tasks/schedule`
  - `#/error-capture` → `#/settings?tab=credentials` (no longer top-level)
  - `#/revanote` → `#/settings?tab=credentials`
- **`{{run_url}}` template variable** — points at `${REMO_PUBLIC_URL}/runs/:id` or similar; verify in `post-run/template.ts` that the rendered URL doesn't hard-code old nav (likely OK, but grep before ship).
- **Email + Telegram + webhook post-run actions** — these embed `run_url`. Same audit.
- **Docs to update in same PR:**
  - `docs/scheduled-tasks.md` — new endpoints, nav references.
  - `docs/auth.md` — `requireRecentAuth` list if `/api/account/revanote-webhook-secret/rotate` is added.
  - `docs/api.md` + `docs/openapi.json` — regenerate via `bun run docs:sync` (CI enforces).
  - `README.md` + `CLAUDE.md` — nav screenshot / structure paragraph.
- **Supervisor MSI compatibility** — older supervisors don't know `supervisor.set_roots`. Hub must tolerate `set_roots_ack` never arriving (timeout + log + leave DB value; supervisor will pick up roots from DB on next `auth_ok` once upgraded). Hub should advertise the feature only when supervisor `version >= 0.6.0` (or whatever ships with the handler).

---

## 8. Recommended phasing

**Ship BEFORE the UI restructure** (so frontend has stable APIs to call):

1. Schema migration 4.1 (supervisors table OR `api_keys.roots`) + 4.2 (`users.preferences`). Idempotent — safe to land alone.
2. `GET /api/supervisors` (port from improvements worktree).
3. `PATCH /api/supervisors/:id/roots` + WS `supervisor.set_roots` round-trip + supervisor handler (write `supervisor.json`, re-scan, emit ack).
4. `PATCH /api/profile/preferences` (auto-nudge persistence).

**Ship WITH the UI restructure** (frontend consumes immediately):

5. `GET /api/tasks/activity` + `/api/tasks/upcoming` (or extend `/api/scheduled-task-runs`).
6. `GET /api/usage/summary`.
7. `GET /api/account/webhooks` unified summary.
8. `GET /api/supervisors/:id/commands`.
9. Deep-link redirects in `App.tsx`.

**Ship AFTER the UI restructure** (optimizations, only if measured):

10. Partial index 4.3 for in-flight runs.
11. `POST /api/account/revanote-webhook-secret/rotate` (verify it doesn't already exist; if missing, low priority — webhook can be rotated by Revanote-side reissue).
12. Supervisor MSI version gate for `set_roots` capability advertisement.

**Out of scope for this audit** (separate planning):

- Per-supervisor scan settings (`max_depth`, `ignore_globs`) exposure to web UI — supervisor already has `ScanSettings` in `config.ts`. Add to `PATCH /api/supervisors/:id/roots` body if desired, or defer.
- Multi-supervisor-per-user UI (already supported in `supervisor-registry` in-memory; needs DB table from 4.1 Option A to persist).
