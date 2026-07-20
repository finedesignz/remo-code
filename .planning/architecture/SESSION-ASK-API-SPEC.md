# Session Ask API — design spec

**Status:** design only (read-only research; no code changed).
**Goal (owner, 2026-07-14):** an EXTERNAL agent — a Claude Desktop scheduled task, or any
MCP/HTTP client — must be able to (a) address a specific remo-code session, (b) send it a
question, (c) get the ANSWER back, and (d) read that session's memory/transcript, so a
completion-check task can *ask the session that did the work* instead of guessing from the
outside.

---

## 1. What exists today, and why none of it solves this

### 1.1 There is no "ask a session and get an answer" endpoint

`hub/src/api/sessions.ts` exposes only management routes — `GET /`, `GET /:id`,
`GET /:id/messages`, `POST /`, `POST /:id/disconnect`, `POST /:id/rotate-token`,
`GET /:id/runner-identity`, `POST /:id/launch` (sessions.ts:41–551). Nothing sends a prompt.
Prompt-sending exists only on the WS client path (`send_message` on `/ws/client`) and inside
the four inbound subsystems (scheduler / error-capture / feedback / revanote / telegram),
none of which is callable by a third party with a stable request→response contract.

### 1.2 The closest existing primitive is Revanote — and it is exactly the right shape

Revanote already implements request/response over a session:

1. Webhook → `hub/src/webhooks/intake.ts` → `dispatch()` (`hub/src/dispatch/pipeline.ts`),
   which runs gates → per-session queue → offline-grace → `send()` on the agent socket as a
   `user_message`.
2. The prompt envelope tells the CLI to end its reply with
   `<<JSON>>{ ... }<<END>>` (docs/revanote.md, "Agent prompt envelope").
3. The supervisor's **stream-json** runner emits `assistant_message`; `hub/src/ws/agent.ts:659`
   handles it and calls `onSessionReply(sessionId, msg.content)` (agent.ts:729–730), which
   fires the subsystem's `RunStore.onFinalize` hook.
4. Revanote's hook (`hub/src/revanote/run-lifecycle.ts:47 finalizeAnnotationReply`) parses the
   envelope (`hub/src/revanote/result-schema.ts` — tolerant: envelope → ```json fence → bare
   prose fallback) and POSTs a callback with retry (`hub/src/revanote/callback.ts`).

**Reuse this, do not invent a new one.** The only thing Revanote lacks is a *pull* result
surface (it pushes a callback) and an external-agent auth model.

### 1.3 THE BLOCKER: a PTY-interactive session cannot answer, at all, in prod today

Two independent walls, both live in prod (`REMO_PTY_INTERACTIVE=1` since the 2026-06-04 cutover):

**Wall A — the gate.** `sessions.runner_type` is `'stream-json' | 'pty-interactive'`
(`hub/src/db/schema.sql:615–621`). The human web/phone surface runs `pty-interactive`.
`humanOnlyRejectsActor(actor, runnerType)` (`hub/src/dispatch/gates.ts:371–374`) returns true
for **any** actor ≠ `'human'` when `runnerType === 'pty-interactive'`, and `humanOnlyPtyGate`
(gates.ts:388–401) turns that into `automation_blocked_on_pty:<actor>`. An external ask is
by definition non-human (server-inferred from an api_key), so it is rejected before send.

**Wall B — the reply has nowhere to come from.** Even with the gate removed, a PTY session
emits **raw terminal bytes**, not `assistant_message` frames. `onSessionReply` (agent.ts:729)
is only reached from the `assistant_message` branch, which only the stream-json runner
produces. The one mechanism that extracts replies from a PTY is the Telegram
**transcript-tail** (`hub/src/telegram/transcript/{manager,tail,claude-adapter,codex-adapter}.ts`)
— and it **reads the CLI's on-disk transcript**, which lives on the *supervisor host*, not in
the Coolify hub container. That is precisely why `REMO_TELEGRAM_TRANSCRIPT_TAIL` is **OFF** in
prod (#247) and Telegram outbound falls back to the host-agnostic stream-json event bus
(`hub/src/telegram/bridge.ts` header comment; docs/telegram-bridge.md:8–40).

> **Concretely: in prod, there is NO path by which the hub can read the reply of a
> PTY-interactive session.** Telegram only "works" because the sessions it talks to still
> produce stream-json `assistant_message` events. Any design that assumes "just inject the
> question into the live PTY the human is using" is not implementable today without new
> supervisor→hub plumbing (see §2.5 / Phase 4).

### 1.4 The human-only-PTY invariant vs. the owner's stated direction

`~/.claude/projects/.../memory/project_direction_pty_orchestrator_monetize.md` (2026-07-12):
the owner has **deliberately** decided automation will eventually drive the interactive PTY,
with a **mandatory ordering**: (1) caps proven on all dispatch paths, (2) **cap the PTY path
FIRST** (it has no token gate today; usage is post-hoc), (3) *then* relax `humanOnlyPtyGate`
into a governed-automation gate (new flag, default OFF, server-inferred actor), (4) prove
due→PR, (5) 30-night receipts.

**This spec does not jump that queue.** Phases 1–3 below deliver the owner's goal **without
touching the PTY at all**, and stay 100% inside the current invariant. Phase 4 (PTY-native
ask) is explicitly parked behind the owner's ordering.

### 1.5 Auth surface that already exists

`hub/src/index.ts:246–248` mounts `/api/plugin/*` with a rate limit + **`apiKeyMiddleware`**
(api_keys table, SHA-256 hashes) **before** the cookie/JWT catch-all at index.ts:293. So the
hub already has a working machine-auth mount pattern; `POST /api/plugin/sessions` +
`GET /api/plugin/verify` (`hub/src/api/plugin.ts`) are the template. **No MCP server for
remo-code exists anywhere** — `C:\Users\artic\GitHub\mcp-servers\apps\` has 35 servers, none
of them remo.

### 1.6 GHL precedent (quick look)

`GHLApps` models completion-checks as: webhook in → job row with a status enum → poll/callback
out, never a blocking synchronous call. Same shape adopted below (`ask_id` + poll, with an
optional long-poll convenience so a Desktop tool call can still feel synchronous).

---

## 2. Recommended design

### 2.1 The key move: **ask a stream-json "ask session", not the human's PTY**

A "session" in the owner's mental model = *the Claude that knows this repo*. That knowledge
lives in the **repo** (`CLAUDE.md`, `.planning/`, git state) and in the **CLI's on-disk
transcript + project memory** — not in the PTY process. So:

- The ask is dispatched to a session row whose `runner_type = 'stream-json'`, bound to the
  **same `project_dir`** as the target session (spawned on demand via the existing scheduler
  `launchSessionForUser` primitive, same as orchestrator autospawn).
- Its prompt envelope hands it the target session's **transcript tail + memory** (Phase 1
  read surface) so it can answer "is X done?" from the actual session's history, then verify
  physically with its own tools (git log, tests, `gh pr view`).
- The reply comes back through the **existing** `assistant_message → onSessionReply →
  RunStore.onFinalize` path. Zero new transport.

This is the only shape that ships **this week**, in prod, with no ToS change, no supervisor
release, and no relaxation of the human-only guard.

> Constraint to respect: never run two CLI processes on the same `project_dir` concurrently —
> the resumed transcript forks. The ask session is a **separate, short-lived** CLI in the same
> repo (fresh conversation, same CLAUDE.md + memory + git state), NOT a resume of the human's
> conversation. It reads the human session's history as *data*, injected into the prompt.

### 2.2 Endpoints

Mounted at **`/api/ext`**, registered in `hub/src/index.ts` **immediately after the
`/api/plugin` block (index.ts:248) and BEFORE the cookie catch-all (index.ts:293)** — the
mount-order invariant is enforced by `hub/test/mount-order.test.ts`, so add a case there.

```
app.use('/api/ext/*', rateLimit({ windowMs: 60_000, max: 30, keyFn: authHeader }))
app.use('/api/ext/*', apiKeyMiddleware)      // reuses api_keys; sets c.get('userId')
app.route('/api/ext', ext)                   // new hub/src/api/ext.ts
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/ext/sessions` | List the caller's sessions: `{id, name, repo_ident, project_dir, runner_type, active, last_activity}`. Lets Desktop resolve "the remo-code session for repo X". |
| `POST` | `/api/ext/sessions/:id/ask` | Body `{ question, context?, wait_ms?: 0..120000, mode?: 'ask'\|'verify' }` → `202 { ask_id, status: 'queued'\|'dispatched'\|'answered', answer? }`. With `wait_ms>0` the handler long-polls internally and returns the answer inline if it lands in time (one-call UX for Desktop); otherwise the caller polls. |
| `GET` | `/api/ext/sessions/:id/ask/:ask_id` | `{ status: 'queued'\|'dispatched'\|'answered'\|'timeout'\|'skipped'\|'failed', answer?, confidence?, evidence?[], raw_reply?, reason?, created_at, answered_at }`. |
| `GET` | `/api/ext/sessions/:id/transcript?tail=N` | Last N turns of the session's on-disk CLI transcript (see §3). Read-only, zero tokens. |
| `GET` | `/api/ext/sessions/:id/memory` | The session project's memory files (see §3). Read-only, zero tokens. |
| `GET` | `/api/ext/sessions/:id/state` | Cheap status roll-up: `active`, `runner_type`, last assistant message time, last `routine_run_log` row (if orchestrator-driven), open `session_runs`. |

`:id` accepts a session id **or** a `repo_ident` (`github://owner/repo` / `path://<abs>`), so
Desktop doesn't have to memorize UUIDs.

### 2.3 Auth model

- **Reuse `api_keys`.** Claude Desktop stores one `remo_…` key (minted in Settings →
  Credentials, existing `/api/api-keys` surface) and sends `Authorization: Bearer <key>`.
- Add a nullable `api_keys.scopes TEXT[]` (idempotent DDL in `schema.sql`; default NULL =
  legacy full access). `/api/ext/*` requires `scopes IS NULL OR 'ext:ask' = ANY(scopes)`.
  Read-only Desktop keys get `{'ext:read'}` only. This is additive and does not disturb
  `/ws/agent`, which stays keyed by `api_keys` unchanged.
- **The actor is server-inferred, never client-asserted**: an api_key-authenticated request is
  actor `'external-ask'`, which is in the automation class. This is the rule the owner's
  direction memo insists on keeping.

### 2.4 Dispatch, gates, timeouts

`hub/src/ask/dispatch.ts` — an adapter over `hub/src/dispatch/pipeline.ts`, exactly like
`hub/src/telegram/dispatch.ts`:

- `token: 'ask:<ask_id>'` (queue token + finalize key).
- **Gates, in order — all non-bypassable:**
  `thresholdGate` → `dailyCostCapGate` → **`dailyTokenCapGate`** → `humanOnlyPtyGate` →
  `askRateGate` (new: N asks/hour/session, default 10) → `concurrencyGate(supervisorId)` when
  autospawning.
  `dailyTokenCapGate` is mandatory on every gate list and is scanned by
  `hub/test/token-cap-coverage.test.ts` — a new `gates: [...]` array missing it **fails CI**.
  `humanOnlyPtyGate` stays in the list: if the resolved target is a `pty-interactive` row, the
  ask is **rejected** (`automation_blocked_on_pty:external-ask`) rather than silently
  redirected — the redirect to a stream-json ask-session is an explicit resolution step
  (§2.1), decided *before* dispatch, not a gate bypass.
- **RunStore**: new `session_asks` table.

```sql
CREATE TABLE IF NOT EXISTS session_asks (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,  -- the session ANSWERING
  target_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,     -- the session ASKED ABOUT
  api_key_id   TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|dispatched|answered|timeout|skipped|failed
  answer       TEXT,
  confidence   TEXT,                              -- high|medium|low
  evidence     JSONB,                             -- string[]
  raw_reply    TEXT,
  reason       TEXT,                              -- gate/skip reason
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_asks_user_created ON session_asks(user_id, created_at DESC);
```
(Idempotent DDL only — `schema.sql` re-runs every boot; no backfills inline.)

- **Envelope** (`hub/src/ask/result-schema.ts`, modeled 1:1 on `revanote/result-schema.ts`):

```
<<ASK>>
{ "answer": "…", "done": true, "confidence": "high",
  "evidence": ["PR #412 merged 2026-07-13", "tests green in CI run 9931"] }
<<END>>
```
Tolerant parse: envelope → ```json fence → bare prose (`{answer: <raw>, confidence: 'low'}`).

- **Timeout / failure semantics:**
  - `wait_ms` long-poll ceiling **120s**; on expiry return `202 {status:'dispatched'}` — the
    ask keeps running and the answer lands on the poll endpoint.
  - Hard ask ceiling **`REMO_ASK_MAX_MS`** (default 900_000 = 15min). A reaper
    (`hub/src/ask/reaper.ts`, same shape as `hub/src/scheduler/run-reaper.ts`) finalizes stale
    `queued|dispatched` rows as `timeout`, using a conditional `UPDATE … AND status IN
    ('queued','dispatched')` so a raced late reply never double-finalizes.
  - Gate block → `status='skipped'`, `reason=<gate reason>` (e.g. `cost_capped`,
    `token_capped`, `automation_blocked_on_pty:external-ask`) — the caller sees *why*.
  - Agent offline → parked in the shared grace buffer (pipeline behavior), status stays
    `queued`; if the target's supervisor is offline entirely, `skipped/agent_offline`.

### 2.5 Human-only-PTY invariant: kept

Phases 1–3 **never write to a PTY**. Reads (§3) are file reads on the supervisor host, no
keystrokes, no tokens. Asks go to a stream-json CLI. `humanOnlyPtyGate` is untouched and its
guard test (`hub/test/automation-routing-guard.test.ts`) still passes.

**What must change for a true PTY-native ask (Phase 4, owner-gated):**
1. A **token gate on the PTY path** (it has none today — the owner's ordering rule #2).
2. Supervisor→hub **transcript streaming** over `/ws/agent` (new `transcript_delta` /
   `turn_complete` frames) so the hub can extract a reply from a PTY without reading the
   supervisor's disk. Requires a new signed MSI.
3. `humanOnlyPtyGate` → `governedAutomationGate` (new flag, default OFF, server-inferred
   actor, + lifetime per-ask counter + kill switch).
Until all three exist, **a PTY-native ask is not implementable and must not be attempted.**

---

## 3. Reading a session's memory / state

Three sources, in order of value:

1. **On-disk CLI transcript + project memory (the real answer).** These live on the
   **supervisor host**, not the hub — so the hub cannot read them directly. Add a **read-only
   supervisor capability** to the existing allowlisted `run_command` registry (same mechanism
   as TEAB's `teab_run`/`teab_status`, see docs/teab-tasks.md):
   - `session_transcript_tail { session_id, n }` → last N user/assistant turns, parsed by the
     **already-written** backend adapters (`hub/src/telegram/transcript/claude-adapter.ts`,
     `codex-adapter.ts`) — reuse them; the parsing is done, only the *host* is wrong.
     `sessions.transcript_path` is already captured at PTY spawn (docs/telegram-bridge.md:23).
   - `session_memory { session_id }` → contents of
     `~/.claude/projects/<slug>/memory/*.md` (+ `MEMORY.md` index) for that project dir.
   Hub proxies both at `GET /api/ext/sessions/:id/transcript|memory`. **This is the single
   highest-value, lowest-risk item in the whole spec** — it gives Claude Desktop everything it
   needs to *check* completion without spending a single token or touching a PTY, and it works
   for BOTH runner types. Ship it first.
   *Requires a new signed supervisor release* (new command in the registry) — flag it.
2. **Hub `messages` table** — only populated for stream-json sessions. Empty for the human's
   PTY session. Use as a cheap fallback, never as the primary.
3. **`routine_run_log`** (`hub/src/db/schema.sql:359–373`: `command`, `outcome`, `pr_url`,
   `reviewer_verdict`, `deploy_verify_result`) — orchestrator-only, and the orchestrator is
   OFF in prod. Surface it in `/state` when rows exist; do not depend on it.

---

## 4. How Claude Desktop consumes this

**Recommendation: a tiny MCP server** — `mcp-servers/apps/remo-code/`, bootstrapped from
`mcp-servers/apps/_TEMPLATE`, gateway-registered like the other 35. Raw-HTTP-tool usage from a
Desktop scheduled task is brittle (no schema, awkward auth, no retry) and the owner's whole
tooling world already routes through MCP.

Tools (thin wrappers over §2.2):
- `remo_list_sessions()` → id / repo / runner_type / active
- `remo_read_memory(session)` → project memory (zero tokens)
- `remo_read_transcript(session, tail=30)` → recent turns (zero tokens)
- `remo_ask(session, question, wait_ms=90000)` → `{status, answer, confidence, evidence}` —
  long-poll so the Desktop task usually gets its answer in **one** tool call
- `remo_ask_result(session, ask_id)` → poll when the long-poll expired

Config: `REMO_HUB_URL=https://app.remo-code.com`, `REMO_API_KEY=remo_…` (scoped `ext:read` for
a checker task; `ext:ask` only if it needs to spend tokens).

Desktop scheduled-task shape: `remo_read_memory` + `remo_read_transcript` first (free), and
only escalate to `remo_ask` when the free reads are inconclusive.

---

## 5. Phased plan

| Phase | Deliverable | Touchpoints | Ships without |
|---|---|---|---|
| **1. Read surface (do this first)** | External api-key-authed READ of a session's transcript tail + memory + state. Zero tokens, zero PTY writes, works for PTY *and* stream-json sessions. | supervisor: new allowlisted `session_transcript_tail` / `session_memory` commands (registry alongside `teab_run`); reuse `hub/src/telegram/transcript/{claude,codex}-adapter.ts` for parsing. hub: `hub/src/api/ext.ts` (`/sessions`, `/:id/transcript`, `/:id/memory`, `/:id/state`), mount in `hub/src/index.ts` after L248, `api_keys.scopes` DDL in `schema.sql`, `hub/test/mount-order.test.ts` case. | **Needs a new signed supervisor MSI.** |
| **2. Ask** | `POST /api/ext/sessions/:id/ask` + poll/long-poll, answered by a stream-json ask-session bound to the target's `project_dir`. | `hub/src/ask/{dispatch,result-schema,prompt,reaper}.ts` (mirroring `hub/src/revanote/*`), `session_asks` DDL, ask-session resolution/autospawn reusing `launchSessionForUser`, gates list incl. `dailyTokenCapGate` + new `askRateGate` in `hub/src/dispatch/gates.ts`, finalize hook wired via existing `onSessionReply` (no change to `hub/src/ws/agent.ts:729`). | Hub-only. No supervisor change, no PTY change, no gate relaxation. |
| **3. MCP server** | `mcp-servers/apps/remo-code/` (5 tools above) + gateway registration + `docs/api.md` regen (`bun run docs:sync`). | `mcp-servers/apps/remo-code/*`, remo-code `hub/src/api/_openapi.ts` + `docs/api.md`. | — |
| **4. PTY-native ask (OWNER-GATED — do not start early)** | Ask the *live* human PTY session and read its reply. | (a) token gate on the PTY path; (b) supervisor `transcript_delta`/`turn_complete` frames on `/ws/agent` + hub-side consumer replacing the disk tail; (c) `humanOnlyPtyGate` → `governedAutomationGate` (new flag, default OFF, lifetime ask counter, kill switch). | Blocked on the owner's mandatory ordering in `project_direction_pty_orchestrator_monetize`. |

### Test strategy

- `hub/test/ext-ask-gates.test.ts` — every gate blocks: cost-capped, **token-capped**
  (cache-read alone must trip it), ask-rate, and `automation_blocked_on_pty:external-ask` when
  the target is `runner_type='pty-interactive'`. Assert `send()` is NEVER called on a block
  (IR-1).
- `hub/test/token-cap-coverage.test.ts` — already scans every `gates: [...]` in `hub/src`; the
  new ask gate list is covered automatically and **fails CI if `dailyTokenCapGate` is omitted**.
- `hub/test/ext-ask-envelope.test.ts` — `<<ASK>>` envelope / fenced-json / bare-prose fallback,
  mirroring the revanote result-schema tests.
- `hub/test/ext-ask-reaper.test.ts` — stale `dispatched` → `timeout`; late reply after a reap
  does not double-finalize (conditional UPDATE).
- `hub/test/mount-order.test.ts` — `/api/ext/*` is api-key-authed and mounted **before** the
  cookie catch-all; a cookie session must NOT authenticate it and an api_key must NOT
  authenticate `/api/sessions/*`.
- `hub/test/automation-routing-guard.test.ts` — unchanged and still green (proves Phase 1–3
  did not relax the human-only invariant).
- E2E (Woodpecker postgres:16, `hub/test/e2e/`): ask → fake stream-json agent replies with an
  envelope → poll returns `answered` with parsed evidence.

---

## 6. Things that CANNOT work in prod today (flagged)

1. **Asking the live PTY session the human is using.** Blocked twice: `humanOnlyPtyGate`
   rejects the actor, and no reply can be extracted (no `assistant_message`; the transcript
   lives on the supervisor host, not in the Coolify hub container — this is exactly why
   `REMO_TELEGRAM_TRANSCRIPT_TAIL=0`). Needs Phase 4.
2. **Reading a session's transcript/memory from the hub alone.** The hub container has no
   `~/.claude/projects/…`. Every read must go through the supervisor → **new signed MSI
   required** for Phase 1.
3. **Relying on `routine_run_log` for state.** Orchestrator is OFF in prod
   (`REMO_ORCHESTRATOR_ENABLED=0` since the 2026-07-11 token-burn incident); the table is
   mostly empty.
4. **Assuming `messages` holds the human session's history.** It does not for
   `pty-interactive` rows.
