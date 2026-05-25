# Phase 05: codex-cli-and-rootless-sessions — Research

**Researched:** 2026-05-25
**Domain:** CLI agent integration, session schema, cross-host config seeding
**Confidence:** MEDIUM-HIGH (Codex protocol facts cited from official docs; integration design assumed)

## Summary

Codex CLI ships a first-class bidirectional streaming mode — `codex app-server` — that speaks JSON-RPC-lite over stdio with the same primitives (thread → turn → item) and streaming deltas (`item/agentMessage/delta`, `item/started`, `item/completed`) that Claude's `--input-format stream-json` provides. This is the correct integration surface for remo-code, not `codex exec --json` (which is one-shot, not interactive).

Rootless sessions are cleanly modeled as a per-(user, hostname, cli_kind) pair with `project_dir = NULL` and a new `is_rootless boolean` flag for explicit semantics. Working dir is best routed to a dedicated `~/.remo-code/rootless/{claude|codex}/` sandbox so file ops have a home.

Cross-host instruction persistence is best done as a **hub-stored, agent-pulled** seed (option b): store the user's global `CLAUDE.md` + `AGENTS.md` + `~/.codex/config.toml` snippets in the DB, agent fetches on first connect and writes them to disk only if absent (never overwrite). This requires zero install-time prompts and "just works" on any new machine.

**Primary recommendation:** Use `codex app-server` over stdio (NOT `codex exec`). Abstract `ClaudeRunner` → `CliRunner` interface with `ClaudeRunner` and `CodexRunner` implementations. Add `cli_kind` and `is_rootless` columns to `sessions`. Seed instructions from hub on agent auth.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary | Rationale |
|---|---|---|---|
| Spawn CLI subprocess | Agent (local) | — | Only local has access to user's machine |
| Per-session CLI selection | Hub (DB column) | Web (picker UI) | Persisted choice survives reconnect |
| Stream-json ↔ JSON-RPC translation | Agent | — | Agent already owns event normalization |
| Rootless session uniqueness | Hub (DB constraint) | Agent (auth payload signals rootless) | Hub enforces 1×Claude + 1×Codex per hostname |
| Instructions seeding | Hub (storage) | Agent (write-to-disk-if-absent) | Centralized config follows user across hosts |

---

## 1. Codex CLI Integration

### 1.1 The right integration surface — `codex app-server` [CITED: github.com/openai/codex/blob/main/codex-rs/app-server/README.md]

Codex has **three** non-interactive modes — pick the right one:

| Mode | Shape | Use? |
|---|---|---|
| `codex exec "prompt"` | One-shot, prompt → final answer | ❌ no streaming control |
| `codex exec --json "prompt"` | One-shot, JSONL events to stdout | ❌ no follow-up messages mid-process |
| `codex app-server` | **Persistent bidirectional JSON-RPC over stdio** | ✅ **THIS** — equivalent to Claude's `--input-format stream-json` |

`codex app-server` is purpose-built for harnesses like remo-code. From the official docs:

> "The Codex App Server is the interface that provides clients with harness capabilities using the bidirectional JSON-RPC protocol over traditional input and output (stdio) streams."
> "The client spawns the codex app-server subprocess and reads/writes JSONL on its stdout/stdin."

[CITED: developers.openai.com/codex/app-server]

### 1.2 Protocol primitives (matches Claude's mental model)

| Codex concept | Claude equivalent | Notes |
|---|---|---|
| Thread | Conversation/session | Multi-turn container |
| Turn | One user→assistant exchange | Triggered by `turn/start` request |
| Item | Stream-json content block | Types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `plan_update` |

**Lifecycle:** `initialize` → `initialized` notification → `thread/start` → `turn/start { input: "..." }` → stream of `item/started`, `item/agentMessage/delta`, `item/completed` → `turn/completed`.

### 1.3 Event → existing remo-code event mapping

| Codex event | Remo `RunnerEvent` | Notes |
|---|---|---|
| `item/agentMessage/delta` | `text_delta` | Direct mapping |
| `item/started` (type=reasoning) | `thinking` | Reasoning summary stream |
| `item/started` (type=command_execution) | `tool_use` (synthetic `tool="bash"`) | Codex bundles all shell exec |
| `item/completed` (type=command_execution) | `tool_result` | Pair with started by item id |
| `item/started` (type=mcp_tool_call) | `tool_use` | MCP tool name in payload |
| `turn/completed` with final agent_message | `assistant_message` | Final text persisted |
| `error` | `agent_log` (severity=error) | |

Approval requests (Codex emits `approval/required` notifications) map cleanly onto the existing `permission_request` / `permission_response` flow in `agent-protocol.ts`.

### 1.4 Auth

| Var | Where | Notes |
|---|---|---|
| `OPENAI_API_KEY` | env on agent host | Standard, works with app-server |
| `CODEX_API_KEY` | env on agent host | **Only supported by `codex exec`** [CITED: developers.openai.com/codex/noninteractive] — not relevant for us |
| `codex login` | interactive ChatGPT OAuth, writes to `~/.codex/auth.json` | Default for human use |

**Recommendation:** Document that the user must run `codex login` once on each machine (one-time interactive flow), OR set `OPENAI_API_KEY` in agent env. Remo does not need to manage credentials — Codex CLI handles it the same way Claude CLI handles `claude login`.

### 1.5 Session resume & working dir

- **Working dir flag:** `--cd <path>` sets cwd before processing [CITED: developers.openai.com/codex/cli/reference]
- **Session storage:** `~/.codex/sessions/<session-id>.jsonl` [CITED: inventivehq.com/knowledge-base/openai/where-configuration-files-are-stored]
- **Resume in app-server:** `thread/resume { thread_id }` request (analogous to thread/start)
- **Per-project semantics:** Codex uses cwd + git-root for AGENTS.md discovery, not an explicit project_dir concept — `--cd <project_dir>` is sufficient

### 1.6 Codex CLI install detection (agent pre-flight)

`agent/src/index.ts` lines 12–28 already does this for `claude --version`. Add an equivalent `codex --version` check — but only when the session's `cli_kind = 'codex'`. Don't hard-require both CLIs.

### 1.7 Required changes — files & shape

**`agent/`**
- Extract `ClaudeRunner` interface → `CliRunner` interface (start, stop, sendMessage, respondToPermission, isReady, on RunnerEvent)
- New `agent/src/codex-runner.ts` — spawns `codex app-server`, owns JSON-RPC framing (Content-Length-style or LSP-style — verify), translates events to `RunnerEvent`
- `agent/src/index.ts` — receive `cli_kind` in `auth_ok` payload, instantiate appropriate runner
- Pre-flight: only check the CLI the session needs

**`hub/`**
- `sessions` schema: `ALTER TABLE sessions ADD COLUMN cli_kind TEXT NOT NULL DEFAULT 'claude' CHECK (cli_kind IN ('claude','codex'))`
- `AgentAuth` (agent-protocol.ts line 23): add optional `cli_kind: z.enum(['claude','codex']).optional()` for new-agent advertisement; hub also returns it in `auth_ok` so agent knows what to spawn
- Session create API (`hub/src/api/sessions.ts:9` `CreateSessionBody`): add `cli_kind` field
- `HubToAgent.auth_ok` (protocol.ts:154): add `cli_kind: 'claude' | 'codex'`

**`web/`**
- Session create form: CLI picker dropdown
- Session list: badge showing which CLI

---

## 2. Rootless Session Mode

### 2.1 Schema — recommended shape

```sql
ALTER TABLE sessions
  ADD COLUMN is_rootless BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN hostname TEXT;  -- already implicitly available via agent_info, but promote for uniqueness

-- Enforce: per (user, hostname, cli_kind), at most ONE rootless session
CREATE UNIQUE INDEX idx_sessions_rootless_unique
  ON sessions(user_id, hostname, cli_kind)
  WHERE is_rootless = true AND deleted_at IS NULL;
```

**Why `is_rootless` boolean + `project_dir IS NULL` (not a sentinel string):**
- Sentinels (`"__root__"`) leak into UI labels, search, and FK comparisons — fragile
- Explicit boolean makes intent clear in DAL queries (`WHERE is_rootless = true`)
- Existing code already handles `project_dir` nullable (schema.sql line 19: `project_dir TEXT` — nullable)

### 2.2 Working directory for spawned CLI

**Recommendation:** Dedicated sandbox `~/.remo-code/rootless/{claude|codex}/` (created on first use by agent).

Rationale:
- User's home dir → CLI could `rm` something valuable
- OS temp → wiped on reboot, breaks file continuity for Q&A like "edit that script I wrote yesterday"
- Dedicated dir → predictable, scoped, easy to inspect, persists across reboots, safe to `chmod` later if needed
- Symmetric with future Codex sandbox (Codex has its own `~/.codex/` — keep ours separate)

### 2.3 Agent auth payload

Agent advertises rootless capability via a new field:

```ts
AgentAuth = z.object({
  ...,
  rootless_sessions: z.array(z.enum(['claude','codex'])).optional(),
  // e.g. ['claude','codex'] = "I can host both ambient sessions"
})
```

Hub responds with the assigned `session_id`s. One agent process can host the project session(s) **and** the rootless ones (the supervisor will spawn distinct CLI subprocesses per session).

### 2.4 Lifecycle — auto-spawn vs lazy

**Recommendation: lazy on first message.**

- Auto-spawn doubles CLI process count per agent connect — wasteful for users who never open the rootless tab
- First-message latency is acceptable (Claude/Codex boot ~2s)
- Aligns with existing `startRunnerOnce()` pattern at `agent/src/index.ts:57`

### 2.5 UI surface

- Sidebar: pinned "Ambient" group at top, two rows: "Claude (rootless)" / "Codex (rootless)" with hostname suffix when user has multiple agents
- Always visible regardless of project filter
- Same chat surface as project sessions — only the badge differs

---

## 3. Cross-Machine Instruction Persistence

### 3.1 Files in scope

| File | Path | Purpose | Read by |
|---|---|---|---|
| Global Claude instructions | `~/.claude/CLAUDE.md` | All projects | Claude CLI |
| Project Claude instructions | `<repo>/CLAUDE.md` | Repo-specific | Claude CLI |
| Global Codex instructions | `~/.codex/AGENTS.md` | All projects [CITED: developers.openai.com/codex/guides/agents-md] | Codex CLI |
| Project Codex instructions | `<repo>/AGENTS.md` | Repo-specific | Codex CLI |
| Codex config | `~/.codex/config.toml` | Model, profile, sandbox defaults | Codex CLI |
| Codex auth | `~/.codex/auth.json` | OAuth token (DO NOT seed — host-specific) | Codex CLI |
| Remo agent config | `~/.config/remo-code/config.json` | hub URL, API key | Remo agent |

### 3.2 Recommended strategy — hub-stored, agent-pulled (option b)

**Why this beats the alternatives:**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| (a) Bundle templates in npm package | Zero network | Static — user's personal CLAUDE.md never propagates; updates require npm publish | ❌ doesn't solve the actual user problem |
| **(b) Hub-stored, agent-pulled** | **User edits once on any machine → propagates everywhere; survives npm reinstall; no extra infra** | New hub endpoints, DB columns, conflict policy | ✅ **recommended** |
| (c) Git dotfiles repo clone | Familiar pattern | Requires user to maintain a separate repo + git credentials on every host | ❌ friction |
| (d) `--seed-from <url>` flag | Explicit | Manual on every host; user forgets | ❌ defeats "just works" goal |

### 3.3 Schema

```sql
ALTER TABLE users
  ADD COLUMN claude_global_md TEXT,        -- ~/.claude/CLAUDE.md content
  ADD COLUMN codex_agents_md TEXT,          -- ~/.codex/AGENTS.md content
  ADD COLUMN codex_config_toml TEXT;        -- ~/.codex/config.toml content (minus auth)
```

### 3.4 Seed protocol

On agent connect, hub `auth_ok` includes:

```ts
{
  type: 'auth_ok',
  session_id: '...',
  cli_kind: 'claude' | 'codex',
  seed_files?: Array<{
    path: string,         // e.g. "~/.claude/CLAUDE.md"
    content: string,
    sha256: string,       // for change detection
    mode: 'create_if_absent' | 'sync_if_unchanged'
  }>
}
```

**Conflict policy (critical):**
- `create_if_absent` (default for instructions): write only if file does not exist
- `sync_if_unchanged`: write only if current file sha256 matches the hub's last-known sha256 (3-way merge avoidance)
- **Never overwrite a file the user has manually edited.** If sha drifts, agent emits `agent_log` warning + leaves file alone. User must explicitly resolve via web UI ("local version differs from hub — keep local / pull from hub / merge").

### 3.5 Web UI surface

New "Instructions" tab in Settings:
- Editor for global CLAUDE.md
- Editor for global AGENTS.md
- Editor for Codex config.toml (with secrets stripped)
- Per-host "Sync status" panel: which agents have which sha — drift indicators

### 3.6 Install-time flow

```bash
npx remo-code-agent --api-key <key>
# → connects to hub
# → hub returns seed_files in auth_ok
# → agent writes ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.codex/config.toml if absent
# → user's CLI sessions on new host behave identically to home machine
```

No new flags. No new install steps. Existing alias `claude-remote` continues to work.

---

## 4. Plan Slicing Recommendation

Suggest 5 plans across 3 waves:

### Wave 1 — Foundations (parallel)
- **05-PLAN-001-cli-kind-schema-and-api** — DB column `cli_kind`, schema migration, CreateSessionBody, sessions list payload, web session picker
- **05-PLAN-002-rootless-schema-and-api** — `is_rootless` column + unique index, hostname promotion to `sessions` table, DAL for rootless lookup, AgentAuth `rootless_sessions` field, hub-side auto-create on agent connect

### Wave 2 — Runtime (sequential after Wave 1)
- **05-PLAN-003-codex-runner-and-runner-abstraction** — extract `CliRunner` interface, refactor `ClaudeRunner` to implement it, build `CodexRunner` over `codex app-server` JSON-RPC stdio, event mapping, install detection per-CLI, integration tests with real Codex binary (gated on env var)

### Wave 3 — UX + Persistence (parallel)
- **05-PLAN-004-instructions-seeding** — `users` columns for instruction blobs, settings editor, `auth_ok` seed_files payload, agent-side write-if-absent + sha drift detection + warning emission
- **05-PLAN-005-ambient-ui-and-docs** — sidebar "Ambient" group, rootless badge in session list, README + CLAUDE.md updates, `docs/codex-cli.md`, `docs/rootless-sessions.md`, `docs/instructions-sync.md`

---

## 5. Open Questions / Risks

1. **JSON-RPC framing in `codex app-server`** — docs say "JSON-RPC lite, JSONL over stdio." Need to spike with a real `codex app-server` binary to confirm exact framing (LSP-style `Content-Length:` headers? Or newline-delimited? Search results suggest newline-delimited but not 100% confirmed). [ASSUMED: newline-delimited JSON, no headers] — must verify at start of PLAN-003.
2. **Codex CLI minimum version** — `app-server` was introduced in `codex-rs`; older `@openai/codex` npm builds may not expose it. PLAN-003 must check minimum version and document `codex --version >= X`.
3. **Approval/permission flow** — Codex `approval/required` notification shape not in the docs we read; verify whether it carries enough info to map onto `AgentPermissionRequest` cleanly, or whether we need a new Codex-specific permission protocol.
4. **One-agent vs. one-CLI-per-session process model** — current code has `ClaudeRunner` singleton per agent (one Claude process). For rootless + project sessions on same agent, we need N runners per agent process. Confirm the supervisor (Phase 04 dependency surface) is the actual spawner — if so, this is already a supervisor concern, not an agent concern.
5. **`OPENAI_API_KEY` provisioning UX** — for users who haven't run `codex login`, agent will silently fail to start Codex. PLAN-005 should add a clear error → web UI surface ("Codex not authenticated on host X — run `codex login`").
6. **Conflict policy for instructions** — what does the user see when 3 machines have drifted CLAUDE.md? Need a UX decision in PLAN-004.
7. **`~/.codex/config.toml` may contain MCP server tokens** — must strip/redact secrets before storing in DB. Document allowlist of safe keys.
8. **Plan dependency on Phase 04** — Roadmap shows Phase 05 `Depends on: []` but the goal mentions "supervisor." If supervisor spawning is the host model (Phase 04), Phase 05 should declare `Depends on: [Phase 04]`. Flag for plan-checker / user confirmation.

---

## Assumptions Log

| # | Claim | Section | Risk |
|---|---|---|---|
| A1 | `codex app-server` uses newline-delimited JSON (no LSP Content-Length headers) | 1.1 | Wrong framing breaks runner — verify in PLAN-003 spike |
| A2 | `item/agentMessage/delta` is the exact streaming-text event name | 1.3 | Event names may differ slightly — verify against live `codex app-server` output |
| A3 | Codex CLI supports `--cd` flag in app-server mode | 1.5 | If only available on `exec`, rootless sandbox cwd must be set via env / `cd` before spawn |
| A4 | One npm-installed `remo-code-agent` can host multiple CLI subprocesses (Claude + Codex + rootless variants) | 2.3 | Current code is single-runner — refactor scope larger than estimated |
| A5 | Phase 04 supervisor is the spawner; Phase 05 is the protocol/schema work | 5.4 | If supervisor not landed, Phase 05 inherits spawning code too |
| A6 | Users want hub-stored instructions (option b) over git dotfiles (c) | 3.2 | Surveyed via reasoning, not user — confirm in discuss-phase |

---

## Sources

### Primary (HIGH)
- [Codex App Server — JSON-RPC over stdio (official)](https://developers.openai.com/codex/app-server)
- [Codex App Server README — openai/codex GitHub](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex CLI reference — flags & subcommands](https://developers.openai.com/codex/cli/reference)
- [Codex non-interactive mode — `codex exec --json`](https://developers.openai.com/codex/noninteractive)
- [Codex AGENTS.md guide — discovery order, override files](https://developers.openai.com/codex/guides/agents-md)

### Secondary (MEDIUM)
- [Codex App-Server protocol deep dive](https://codex.danielvaughan.com/2026/03/28/codex-app-server-json-rpc-protocol/)
- [`~/.codex/` config locations](https://inventivehq.com/knowledge-base/openai/where-configuration-files-are-stored)
- [Codex CLI v0.130 reference (remote-control, app-server flags)](https://blakecrosley.com/guides/codex)
- [Codex exec resume — follow-up syntax](https://www.verdent.ai/guides/codex-cli-resume-continue-save-chat)

### Tertiary (LOW — corroboration only)
- [Shipyard Codex cheatsheet](https://shipyard.build/blog/codex-cli-cheat-sheet/)
- [Codex CLI cheatsheet](https://computingforgeeks.com/codex-cli-cheat-sheet/)
- [takopi exec --json event cheatsheet](https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/)

---

## RESEARCH COMPLETE
