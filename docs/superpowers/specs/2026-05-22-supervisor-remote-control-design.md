# Supervisor — Remote Control of Local Claude Code Sessions

**Date:** 2026-05-22
**Status:** Historical (Phase 09, 2026-05-26)
**Author:** brainstorming session

> **Note (Phase 09, 2026-05-26):** The `npx remo-code-supervisor install` / NSSM distribution model documented in this spec has been retired. The supervisor now ships exclusively as a Tauri Windows MSI from https://github.com/finedesignz/remo-code/releases/latest. The supervisor protocol over `/ws/agent` is unchanged; only the install/distribution surface changed. See `supervisor/MIGRATION.md` and `.planning/phases/09-retire-npm-packages/`.

## Problem

User wants to leave the house and have Claude Code working on chosen local repos, manageable from the web UI. Needs auto-restart on crash, GitHub repo selection, and a single long-running supervisor process on the local machine that survives reboots.

## Solution Summary

A new local **Supervisor** process registers with the hub over the existing `/ws/agent` WebSocket, advertising the `supervisor` capability. The hub exposes a control plane (scan repos, clone, start session, stop, status) via REST and WS. The supervisor manages exactly one inner `claude-remote` (claude-code) process at a time, restarts it on crash with a circuit breaker, and clones repos on demand using short-lived tokens minted by a GitHub App installed on the user's account.

## Architecture

```
Browser ──WS /ws/client + REST──> Hub (Coolify)
                                    │
                                    │  /ws/agent (role-multiplexed)
                                    ▼
                            Supervisor (NSSM service as user)
                                    │ stdin/stdout (stream-json)
                                    ▼
                            claude-code CLI (current repo dir)
```

## Decisions

| # | Decision |
|---|----------|
| 1 | Hybrid repo discovery — local scan + GitHub list + clone-on-demand |
| 2 | One active inner claude process per supervisor (parallelism via Task tool inside Claude) |
| 3 | Reuse `/ws/agent` with `role: "agent" \| "supervisor"` per message; `capabilities` column on `api_keys` |
| 4 | **GitHub App** (not OAuth App) for fine-grained, short-lived installation tokens |
| 5 | Start dialog: branch picker, optional pull, optional initial prompt; refuse dirty worktree |
| 6 | Supervisor runs as NSSM Windows Service **under the user's account** (not LocalSystem) |
| 7 | Circuit breaker: 5 crashes / 10 min → stop; UI surfaces red banner with last stderr |
| 8 | New `session_runs` ledger row per spawn (incl. restarts); existing `sessions` row unchanged |

## Database Schema (additive, idempotent)

```sql
-- 1) api_keys gains capabilities
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT ARRAY['agent'];

-- 2) GitHub App installations
CREATE TABLE IF NOT EXISTS github_installations (
  id            bigint PRIMARY KEY,            -- GitHub installation_id
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_login text NOT NULL,
  account_type  text NOT NULL,                 -- 'User' | 'Organization'
  installed_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_github_inst_user ON github_installations(user_id);

-- 3) Supervisor registrations (one per api_key with supervisor capability)
CREATE TABLE IF NOT EXISTS supervisors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id     uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  hostname       text NOT NULL,
  version        text,
  os             text,
  roots          text[] NOT NULL DEFAULT '{}',
  state          text NOT NULL DEFAULT 'idle',   -- idle|starting|running|stopping|crashed|stopped|offline
  current_run_id uuid,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supervisors_api_key ON supervisors(api_key_id);

-- 4) Session runs ledger
CREATE TABLE IF NOT EXISTS session_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,
  supervisor_id   uuid REFERENCES supervisors(id) ON DELETE SET NULL,
  repo_path       text NOT NULL,
  branch          text,
  pulled          boolean NOT NULL DEFAULT false,
  initial_prompt  text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  exit_code       int,
  exit_reason     text,                          -- clean|crash|user|circuit_open
  restart_of      uuid REFERENCES session_runs(id) ON DELETE SET NULL,
  restart_count   int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON session_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_supervisor ON session_runs(supervisor_id);
```

## WS Protocol — Control Plane

Every WS frame now carries `role: "agent" | "supervisor"`. Existing agent frames default to `role: "agent"` (backward compatible — missing field treated as agent).

### Hub → Supervisor

```ts
{ role: "supervisor", type: "repo.scan", req_id }
{ role: "supervisor", type: "repo.clone", req_id, clone_url, target_path, repo_full_name }
{ role: "supervisor", type: "repo.pull",  req_id, repo_path, branch, clone_url }
{ role: "supervisor", type: "repo.branch_checkout", req_id, repo_path, branch, create }
{ role: "supervisor", type: "session.start", req_id, run_id, repo_path, branch?, pull, initial_prompt? }
{ role: "supervisor", type: "session.stop",  req_id, run_id, reason }
{ role: "supervisor", type: "session.status", req_id }
```

### Supervisor → Hub

```ts
{ role: "supervisor", type: "supervisor.hello", version, os, hostname, roots, capabilities }
{ role: "supervisor", type: "supervisor.state", state, run_id?, repo_path?, pid?, restart_count, last_exit? }
{ role: "supervisor", type: "supervisor.log",   level, message, run_id?, ts }
{ role: "supervisor", type: "repo.scan_result", req_id, repos: [{path,remote,branch,dirty,last_commit}] }
{ role: "supervisor", type: "repo.clone_progress", req_id, stage, percent? }
{ role: "supervisor", type: "repo.op_result", req_id, op, ok, error? }
```

Inner-Claude activity (`thinking`, `text_delta`, `tool_use`, `tool_result`, `assistant_message`) sent with `role: "agent"` and the current `session_id`. Browser code unchanged.

## State Machine

```
idle ──session.start──> starting ──ready──> running
running ──crash──> [backoff] ──> starting (restart_of=prev)
running ──session.stop──> stopping ──exited──> idle
running ──exit code 0──> idle (no restart)
running ──>5 crashes/10min──> stopped (terminal until user)
```

- Hub-side serialization per supervisor: a `session.start` for a non-idle supervisor returns HTTP `409 Conflict`.
- Restart backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
- Each restart writes a fresh `session_runs` row with `restart_of` pointing at the prior run.

## GitHub App Flow

1. User clicks **Connect GitHub** in settings → hub redirects to `https://github.com/apps/<app-slug>/installations/new`.
2. GitHub redirects back to `/api/github/callback?installation_id=...&setup_action=install`.
3. Hub stores `github_installations` row.
4. To list repos/branches: hub mints a JWT (signed with App private key) → exchanges for a 1-hour installation token at `POST /app/installations/{id}/access_tokens` → caches 50min.
5. To clone: hub mints a one-shot token, constructs `https://x-access-token:<tok>@github.com/<owner>/<repo>.git`, sends to supervisor via `repo.clone`. Supervisor clones, then rewrites `.git/config remote.origin.url` to tokenless URL. Same flow per `git pull`.

**Permissions required (GitHub App):** `Contents: Read & Write`, `Metadata: Read`, `Pull requests: Read`. No org/admin scopes.

## REST Endpoints (hub)

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/github/install_url`         | Returns GitHub App install URL |
| GET  | `/api/github/callback`            | OAuth callback (stores installation_id) |
| GET  | `/api/github/installations`       | List user's installations |
| GET  | `/api/github/repos`               | List repos across installations |
| GET  | `/api/github/repos/:owner/:repo/branches` | List branches |
| GET  | `/api/supervisors`                | List user's supervisors + state |
| POST | `/api/supervisors/:id/scan`       | Trigger repo.scan |
| POST | `/api/supervisors/:id/clone`      | Trigger repo.clone (with hub-minted URL) |
| POST | `/api/supervisors/:id/start`      | Trigger session.start (returns run_id; 409 if not idle) |
| POST | `/api/supervisors/:id/stop`       | Trigger session.stop |
| GET  | `/api/supervisors/:id/runs`       | List session_runs history |

## Web UI

- New route `#/supervisor` — supervisor list, repo list (filter local/github/all + search), start dialog (branch + pull + prompt), runs drawer.
- Settings page: **Connect GitHub** button + installations list.
- Existing chat view unchanged.

## Supervisor Package (`supervisor/`)

New Bun workspace package, published to npm as `remo-code-supervisor`.

**Structure:**
```
supervisor/
  src/
    index.ts              — entry, parses CLI commands
    config.ts             — config file at %APPDATA%/remo-code/supervisor.json
    hub-client.ts         — WS reconnect, message dispatch
    repo-scanner.ts       — enumerate repos under configured roots
    git-ops.ts            — clone/pull/checkout/dirty-check via spawned git
    process-manager.ts    — spawn/kill claude-remote, stream-json relay, state machine, backoff, circuit breaker
    nssm-installer.ts     — NSSM service install/uninstall/update on Windows
  package.json
```

**CLI:**
```
remo-code-supervisor install --api-key olx_... [--roots <paths>] [--hub-url ...]
remo-code-supervisor uninstall
remo-code-supervisor run        # foreground (used by the service)
remo-code-supervisor status
```

## Supervisor Install & Lifecycle

- `install` command:
  1. Validates API key against hub `/api/api-keys/verify` (hub auto-grants `supervisor` capability on first connect from a key that has agent capability).
  2. Writes config to `%APPDATA%\remo-code\supervisor.json`.
  3. Downloads NSSM (or detects existing).
  4. Creates Windows Service `RemoCodeSupervisor` running `node "<bundled-entry>" run`, `ObjectName: .\<user>` (prompts for password once).
  5. `Startup: Automatic`; logs to `%LOCALAPPDATA%\remo-code\logs\`.
  6. Starts service.

- Inner-process crash policy:
  - Exit 0 → idle, no restart
  - Exit ≠ 0 / signal → restart with backoff 1→2→4→8→16→30s
  - >5 crashes in 10min → state=`stopped` (terminal)
  - User-initiated stop → no restart

## Security Notes

- GitHub App private key in hub env var; never logged.
- Installation tokens minted on demand, cached 50 min; never sent to browser.
- Clone URLs (containing token) only over WS to supervisor; supervisor strips token from `.git/config` immediately after clone.
- API key `capabilities` checked on every control-plane verb (defence in depth alongside role flag).
- Competing-agent guard: hub rejects `session.start` if another agent is already attached to the target `session_id`.
- Dirty worktree: refuse by default; UI offers discard/stash/new-branch; never silent stash.

## Out of Scope (Follow-up)

- v2: Process enumeration to detect external Claude processes + "take over" action.
- v2: Multi-concurrent inner sessions per supervisor.
- v2: GitHub webhook → auto-pull on push.
- v2: macOS / Linux supervisor (launchd / systemd).

## Acceptance Criteria

1. User connects GitHub via UI → installations stored.
2. User runs `npx remo-code-supervisor install --api-key ...` → service registered and connects to hub.
3. UI shows supervisor `online`, lists local repos under configured roots.
4. User clicks a repo, picks branch, optionally checks pull, types prompt, hits Start → claude-remote spawns in that dir, chat UI shows activity.
5. Crash mid-session → supervisor restarts with backoff; UI shows `restart_count` rising.
6. User clicks Stop → process exits cleanly, supervisor returns to idle.
7. User clones an uncloned GitHub repo via UI → supervisor clones into configured root; repo appears in local list.
