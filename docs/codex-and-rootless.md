# Codex CLI + Rootless Ambient Sessions

Phase 05 of remo-code: lets a single agent host Claude *and* Codex sessions side
by side, with always-on "ambient" sessions per host that never need a project
directory.

## Overview

Before Phase 05, every Claude Code session had to be pinned to a project
directory and the agent process could only spawn `claude`. Phase 05 lifts both
constraints:

- **Per-session `cli_kind`** — each row in `sessions` chooses `claude` or
  `codex`. The agent spawns the matching CLI for that session.
- **Rootless ambient sessions** — at most one Claude row + one Codex row per
  `(user, hostname)`. Working directory is `~/.remo-code/rootless/<cli>/`.
  Spawned lazily on first user message.
- **Hub-stored instruction blobs** — three TEXT columns on `users`
  (`claude_global_md`, `codex_agents_md`, `codex_config_toml`) are synced to
  the agent on connect and written to disk **create-if-absent** (never
  overwrites).

## Per-session CLI selection

`sessions.cli_kind` is a `TEXT NOT NULL DEFAULT 'claude'` column with CHECK
constraint `cli_kind IN ('claude','codex')`. Existing rows backfill to
`'claude'`. A session's CLI is pinned at create time and is **not** mutable.

REST: `POST /api/sessions { name, project_dir, cli_kind }` — `cli_kind` is
optional and defaults to `claude`; unknown values return 400.

Agent auth handshake: agent sends `cli_kind` in its `auth` payload. Hub creates
or reuses a project session pinned to that CLI. If the existing row's
`cli_kind` differs from what the agent requested, the hub keeps the existing
pin and emits an `agent_log` warning.

## Codex requirements

- `npm i -g @openai/codex`
- `codex login` **or** set `OPENAI_API_KEY` in the agent's environment
- Tested against `codex app-server` stdio JSON-RPC

Agent does a per-CLI preflight (`codex --version`) only when it is about to
host a Codex session. Missing CLI exits with a clear actionable error.

## Codex protocol mapping

The agent talks to Codex via `codex app-server` over child-process stdio,
JSON-RPC 2.0 framed as newline-delimited JSON (with LSP `Content-Length:`
fallback auto-detected on first byte). All Codex events translate into the
same `RunnerEvent` union Claude emits, so the web UI renders them with the
same components.

| Codex notification | RunnerEvent emitted |
|---|---|
| `item/started` type=`reasoning` | `status: 'thinking'` |
| `item/started` type=`agent_message` | `status: 'writing'` |
| `item/started` type=`command_execution` | `status: 'tool_calling'` + `tool_use { tool: 'bash', tool_id, input: { command } }` |
| `item/started` type=`mcp_tool_call` | `status: 'tool_calling'` + `tool_use { tool: name, tool_id, input: arguments }` |
| `item/agentMessage/delta` (reasoning parent) | `thinking` |
| `item/agentMessage/delta` (agent_message parent) | `text_delta` |
| `item/completed` type=`command_execution` | `tool_result { content: stdout+stderr, is_error: exit_code !== 0 }` |
| `item/completed` type=`mcp_tool_call` | `tool_result` |
| `turn/completed` | `assistant_message` + `status: 'idle'` |
| `approval/required` | `permission_request { tool_name: 'bash', tool_input }` |
| `error` | `log: 'Codex error: ...'` |

Outbound (agent → Codex):
- `initialize` request → `initialized` notify → `thread/start` (or
  `thread/resume`) → `turn/start { thread_id, input }`
- `approval/response { request_id, decision: approve|deny }`
- `turn/cancel { thread_id }`

**SPIKE STATUS:** the framing assumption (`ndjson` vs LSP-style) and exact
method/payload shapes were derived from research and have not yet been
verified against a live Codex binary on the build host. The runner is the
source of truth — adjust the file in place if the live protocol differs from
the table above.

## Rootless ambient sessions

A rootless session is a "no project directory" ambient session attached to a
specific host. The agent advertises capability in its auth payload:

```json
{ "type": "auth", "api_key": "...", "hostname": "host-a",
  "rootless_sessions": ["claude", "codex"] }
```

Hub looks up or creates one row per (`user_id`, `hostname`, `cli_kind`)
enforced by partial unique index `idx_sessions_rootless_unique ON sessions
(user_id, hostname, cli_kind) WHERE is_rootless = true AND deleted_at IS
NULL`. The hub returns the row ids in `auth_ok.rootless_session_ids`.

The agent stores rootless ids in its session map but does NOT spawn the
runner eagerly. The runner spawns on the first `user_message` to that
session id, with cwd = `~/.remo-code/rootless/<cli>/` (created if absent).

Project session + rootless sessions coexist in one agent process — the
runner registry is `Map<sessionId, CliRunner>`.

## Instructions sync (seed_files)

Three nullable TEXT columns on `users` store per-CLI global instruction
blobs:

| Column | Synced to | Purpose |
|---|---|---|
| `claude_global_md` | `~/.claude/CLAUDE.md` | Global Claude Code instructions |
| `codex_agents_md` | `~/.codex/AGENTS.md` | Codex global agent instructions |
| `codex_config_toml` | `~/.codex/config.toml` | Codex TOML configuration |

On agent auth, the hub computes a `seed_files` array containing only the
blobs relevant to the CLIs the agent is about to host (project + rootless),
each with its SHA-256:

```json
{
  "seed_files": [
    { "path": "~/.claude/CLAUDE.md", "content": "...", "sha256": "abc...", "mode": "create_if_absent" }
  ]
}
```

Agent semantics (`agent/src/seed.ts`):
- File does not exist → write it. Log: `Seeded <path> from hub`.
- File exists, sha matches → silent no-op.
- File exists, sha differs → **leave the file alone** and log: `Local <path>
  differs from hub version — keeping local. Reconcile in Settings →
  Instructions.`
- **The agent NEVER overwrites a local file.** Ever.

Tilde paths (`~/x`) expand via `os.homedir()`. Parent directories created
with `mkdirSync(recursive: true)`. Per-file errors do not abort the loop.

## Settings UI — Instructions tab (status)

A `GET/PUT /api/instructions` REST endpoint round-trips the three blobs
scoped to the authenticated user. On PUT, `codex_config_toml` is
secret-stripped: any line matching `^(api[_-]?key|apikey|token|secret|password)\s*=`
is removed and the response reports `stripped_secret_lines`.

**Web UI status (2026-05-25):** the dedicated Instructions tab in
`SettingsPage.tsx` and CLI-aware sidebar badges (`codex`, `ambient`) were
drafted but reverted by concurrent agent commits on the same branch. The
API + agent-side plumbing is shipped; the UI surface needs to be re-applied
in a follow-up commit on a clean branch.

## Troubleshooting

- **"Codex runner not starting"** — run `codex --version` to verify the CLI
  is in PATH; the agent exits at preflight with a clear install hint.
- **"My ambient session is missing"** — agent must advertise
  `rootless_sessions` in its auth payload AND send a non-empty `hostname`.
  Check the agent's startup log.
- **"My CLAUDE.md didn't sync"** — the file already existed locally. Either
  the existing local copy matches (silent no-op) or it differs and the
  agent emitted a drift warning in `agent_log`. Inspect logs and reconcile
  manually in Settings → Instructions.
- **"My Codex config keeps losing my api_key= line"** — that's intentional.
  Secrets are stripped server-side on PUT. Put credentials in environment
  variables (`OPENAI_API_KEY`) or run `codex login`.

## File map

| Layer | Files |
|---|---|
| Hub schema | `hub/src/db/schema.sql` (`cli_kind`, `is_rootless`, `hostname`, partial unique index, three user instruction columns) |
| Hub DAL | `hub/src/db/dal.ts` — `findOrCreateRootlessSession`, `getUserInstructions`, `updateUserInstructions`, extended `findOrCreateAgentSession` |
| Hub API | `hub/src/api/instructions.ts` (GET/PUT), extended `hub/src/api/sessions.ts` (cli_kind in CreateSessionBody) |
| Hub WS | `hub/src/ws/agent.ts` (auth_ok builds seed_files + rootless_session_ids), `hub/src/ws/protocol.ts` + `agent-protocol.ts` (Zod schemas) |
| Agent | `agent/src/cli-runner.ts` (interface), `claude-runner.ts` (implements), `codex-runner.ts` + `codex-jsonrpc.ts` (Codex), `seed.ts` (writer), `index.ts` (per-session runner map) |
| Web | `web/src/hooks/useSessions.ts` (CodeSession includes cli_kind/is_rootless/hostname) |
