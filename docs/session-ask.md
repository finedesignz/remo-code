# Session-Ask API (`/api/ext`) — milestone ASK

**Goal (owner, 2026-07-14):** an EXTERNAL agent — a Claude Desktop scheduled task, or
any MCP/HTTP client — must be able to (a) address a specific remo-code session,
(b) READ its memory + transcript, and (c) ASK it a question and get an ANSWER back, so
a completion-check task can *ask the session that did the work* instead of guessing
from the outside.

Design spec: [`.planning/architecture/SESSION-ASK-API-SPEC.md`](../.planning/architecture/SESSION-ASK-API-SPEC.md).

## Shipped

| Phase | What | Cost |
|---|---|---|
| **1 — Read surface** | Supervisor-native, allowlisted, READ-ONLY `run_command`s `session_transcript_tail` / `session_memory` + hub proxies. Works for **pty-interactive sessions too**. | FREE — zero tokens, zero PTY writes |
| **2 — Ask** | `POST /api/ext/sessions/:id/ask` (+ long-poll / poll), answered by a **stream-json ask-session** bound to the target's `project_dir`. | PAID — a real CLI turn |
| **3 — MCP server** | `mcp/` workspace package: `remo_list_sessions`, `remo_read_transcript`, `remo_read_memory`, `remo_state`, `remo_ask`, `remo_get_ask`. | — |
| **4 — PTY-native ask** | **NOT shipped. Owner-gated.** | — |

## Invariants (do not violate)

- **The human's PTY is NEVER written to.** The ask is dispatched to a *separate,
  short-lived* stream-json CLI in the **same repo** (same `CLAUDE.md`, memory, git
  state) — never a resume of, or a keystroke into, the human's live conversation
  (which would fork the transcript and break the human-only guard).
- **The actor is SERVER-INFERRED** from the api_key (`external-ask`, an automation
  actor). Nothing in the request body can claim `human`. `humanOnlyPtyGate` therefore
  **rejects** a pty-interactive target (`automation_blocked_on_pty:external-ask`) —
  it is never silently redirected. The redirect to a stream-json ask-session is an
  explicit *resolution* step that happens BEFORE dispatch.
- **Every ask rides the shared, non-bypassable gate list**:
  `thresholdGate → dailyCostCapGate → dailyTokenCapGate → humanOnlyPtyGate → askRateGate`.
  `hub/test/token-cap-coverage.test.ts` hard-fails CI if the token cap is ever dropped.
- **Reads are read-only, on the supervisor host, and byte-capped.** The hub never
  supplies a path — it supplies the session's `project_dir` and the supervisor derives
  `~/.claude/projects/<slug>` itself, rejecting anything that resolves outside that base
  (`invalid_project_dir` / `path_escape`). See
  `supervisor/src/commands/session-read.ts` + `supervisor/test/session-read.test.ts`.
- Transcript + memory enter the ask prompt as **fenced untrusted DATA**, never as
  instructions (`hub/src/ask/prompt.ts` `fenceUntrusted`).

## Endpoints

Mounted at `/api/ext`, immediately after `/api/plugin` and **BEFORE** the cookie/JWT
catch-all in `hub/src/index.ts` (asserted by `hub/test/mount-order.test.ts`).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/ext/sessions` | id / name / repo_ident / project_dir / runner_type / active |
| `GET` | `/api/ext/sessions/:id/transcript?tail=N` | last N turns (default 30, cap 200) |
| `GET` | `/api/ext/sessions/:id/memory` | `~/.claude/projects/<slug>/memory/*.md` (+ `MEMORY.md` first) |
| `GET` | `/api/ext/sessions/:id/state` | active / runner_type / last assistant message / open runs |
| `POST` | `/api/ext/sessions/:id/ask` | `{question, context?, wait_ms?≤120000, include_transcript?, include_memory?}` → `202 {ask_id, status, answer?…}` |
| `GET` | `/api/ext/sessions/:id/ask/:ask_id` | `{status, answer, confidence, evidence, reason}` |

`:id` accepts a **session id**, a **repo_ident** (`github://owner/repo`, `path://<abs>`),
or a bare repo name — Desktop does not have to memorize UUIDs.

`status` ∈ `queued | dispatched | answered | timeout | skipped | failed`. A non-answered
ask always carries a `reason` (`over_daily_cost_cap:…`, `over_daily_token_cap:…`,
`over_ask_rate:…`, `automation_blocked_on_pty:external-ask`, `session_offline`,
`session_busy`, `ask_timeout`).

## Auth

Reuses the existing **`api_keys`** credential (`Authorization: Bearer remokey_…`),
plus an **additive, NULLABLE** `api_keys.scopes TEXT[]`:

- `scopes IS NULL` ⇒ **legacy full access** — every existing key keeps working
  (including `/ws/agent`). Nothing is broken by this milestone.
- `ext:read` ⇒ the free read surface.
- `ext:ask` ⇒ **also** allowed to spend tokens on `POST …/ask`.

Mint a read-only key for a checker task:

```sql
UPDATE api_keys SET scopes = ARRAY['ext:read'] WHERE id = '<key id>';
```

## Reply envelope

The ask prompt instructs the CLI to verify physically (git, tests, `gh pr view`) and end
with:

```
<<ASK>>
{ "answer": "…", "done": true, "confidence": "high",
  "evidence": ["PR #412 merged 2026-07-13", "CI run 9931 green"] }
<<END>>
```

Tolerant parse (`hub/src/ask/result-schema.ts`): envelope → ```json fence → bare prose
(the raw text becomes the answer at `confidence:'low'`), so a caller always gets *an*
answer.

## Env

| Var | Default | Meaning |
|---|---|---|
| `REMO_ASK_MAX_MS` | `900000` (15min) | Hard ask ceiling; the reaper finalizes older asks `timeout`. |
| `REMO_ASK_REAPER_INTERVAL_MS` | `60000` | Sweep cadence (`hub/src/ask/reaper.ts`). |
| `REMO_ASK_REAPER_DISABLED` | off | `1\|true\|yes\|on` ⇒ sweep is a no-op. |
| `REMO_ASK_MAX_PER_HOUR` | `10` | Per-api-key ask-rate ceiling (`askRateGate`). Non-positive ⇒ disabled. |

## MCP server (`mcp/`)

```json
{ "mcpServers": { "remo-code": {
  "command": "bun", "args": ["run", "<repo>/mcp/src/index.ts"],
  "env": { "REMO_HUB_URL": "https://app.remo-code.com", "REMO_API_KEY": "remokey_…" } } } }
```

**Cost discipline — the point of the whole design:** a scheduled completion-check runs
`remo_read_memory` + `remo_read_transcript` **first** (free), and escalates to `remo_ask`
**only** when those are inconclusive.

Promoting the server to `mcp-servers/apps/remo-code/` (gateway registration alongside the
other ~35) is a follow-up; it ships in-repo so it versions with the API it wraps.

## Release gating

- **Phase 1 requires a NEW SIGNED SUPERVISOR RELEASE** to reach installed hosts: the
  `session_transcript_tail` / `session_memory` commands only exist in a supervisor built
  from this branch. Until a host runs it, the read endpoints answer
  `502 unknown_command` (fail closed, nothing else regresses).
- **Phase 4 (PTY-native ask) is deliberately NOT here.** Per the owner's mandatory
  ordering (`project_direction_pty_orchestrator_monetize`), it needs (1) a token gate on
  the PTY path, (2) supervisor→hub transcript streaming, (3) `humanOnlyPtyGate` →
  a governed-automation gate. Until all three exist, do not attempt it.

## Tests

- `supervisor/test/session-read.test.ts` — path-traversal rejection + byte cap.
- `hub/test/ext-ask-gates.test.ts` — the gate list; `external-ask` can never drive a PTY.
- `hub/test/ext-ask-envelope.test.ts` — `<<ASK>>` / fence / prose fallback + the untrusted fence.
- `hub/test/ext-ask-reaper.test.ts` — stale ask → `timeout`; a late reply never double-finalizes.
- `hub/test/mount-order.test.ts` — `/api/ext` is api-key-authed, before the cookie catch-all.
