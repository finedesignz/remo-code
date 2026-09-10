# Phase 1: PTY Token Accounting - Research

**Researched:** 2026-07-27
**Domain:** Cross-process (Rust PTY host <-> Bun supervisor <-> hub) token/usage telemetry for an interactive terminal session
**Confidence:** HIGH (all core claims verified directly against this branch's code and, for the transcript-format claim, against a live on-disk transcript file)

## Summary

Today a PTY turn's token spend is **completely invisible** to the hub, not just post-hoc-delayed.
The only code path that ever calls `recordTokenUsage()` is `supervisor/src/runners/session-bridge.ts`,
which fires ONLY on the stream-json SDK's `result` event (`e.usage`) - a message type that literally
does not exist in the raw-byte PTY relay (`supervisor/src/runners/claude-pty-bridge.ts` <-> Rust
`pty_host.rs`). The PTY wire protocol is `spawn | input | resize | kill | data | scrollback | exit`
frames only - no result event, no usage field, nothing. So `token_usage` (and therefore
`dailyTokenCapGate`, which Phase 2 will extend to the PTY) currently records **zero** rows for any
`runner_type='pty-interactive'` session, forever, no matter how long it runs.

The fix does not require touching the Rust PTY host, the wire protocol, or adding any programmatic
flag to the spawned `claude`/`codex` binary (which would violate the no-API-key /
argv-allowlist-of-one invariant). It requires exploiting a fact this research **verified directly
against a live transcript file on this machine**: the interactive `claude` CLI - spawned with zero
flags, exactly as the PTY host spawns it - writes the *exact same* per-project JSONL transcript
(`~/.claude/projects/<slug>/<session-uuid>.jsonl`) that a programmatic session writes, and each
`"type":"assistant"` record in that file carries a `message.usage` block with the identical four
token buckets (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`) that `token_usage` already stores. A single 100-line transcript sampled
from this repo's own project dir contained 27 such usage-bearing assistant records - i.e. usage is
recorded **per agentic loop turn**, not once at the end of a long human-submitted turn, which is
exactly the granularity Phase 1 needs for "detectable mid-flight."

This repo already has 90% of the machinery to read that file live: `hub/src/telegram/transcript/`
(Phase 20) built a byte-offset JSONL tailer (`tail.ts`) and a Claude-record parser
(`claude-adapter.ts`) for exactly this file - but that code runs **in the hub process**, and the hub
is a Coolify container that does not have `~/.claude/projects` (this is explicitly why
`REMO_TELEGRAM_TRANSCRIPT_TAIL` defaults OFF and is documented as "keep OFF in Coolify" in
`CLAUDE.md`). **Do not reuse that module as-is.** The correct home for a transcript tailer is the
**supervisor** process, which already runs on the same host as the file. The supervisor already has
a proven, shipped, cross-host channel for exactly this shape of read
(`supervisor/src/commands/session-read.ts` -> `session_transcript_tail`, milestone ASK, confirmed
working for `pty-interactive` sessions per `docs/session-ask.md`), and it already has a proven push
channel for per-turn usage (`usage_event` over `/ws/agent`, milestone P2). The recommended Phase 1
mechanism combines both: run a `tail.ts`-style watcher **inside the supervisor**, keyed to each live
PTY session's transcript file, and push a `usage_event` (additively tagged `runner_type`) to the hub
every time a new assistant record with a `usage` block appears - reusing the hub-side
`recordTokenUsage()` write path unchanged.

**Primary recommendation:** Port the byte-offset JSONL-tail primitive into `supervisor/src/`, run one
tailer per live PTY session (started at spawn, closed at kill/detach), emit the existing `usage_event`
WS message (additively carrying `runner_type: 'pty-interactive'`) per assistant-record-with-usage, and
add one additive `token_usage.runner_type TEXT NOT NULL DEFAULT 'stream-json'` column so the ledger
carries the bucket split at the row level (satisfies success criterion #2) with zero change to
`dailyTokenCapGate`'s SQL shape (criterion #3 - "detectable mid-flight" - falls out for free, because
`getTodayTokenTotal()` already sums `token_usage` live and now has PTY rows landing throughout a long
turn instead of never).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Locate + read the live PTY transcript file | Supervisor (local fs) | - | The file lives on the supervisor host; the hub container cannot see it (documented, see Pitfall 1) |
| Tail the transcript for new usage-bearing records | Supervisor | - | Byte-offset tail state must live where the file lives; a hub-side poll would need a round-trip per interval per session |
| Push per-turn usage to the hub | Supervisor -> Hub (`/ws/agent`) | - | Reuses the existing `usage_event` frame + handler; no new transport |
| Persist + tag the ledger row | Hub (`hub/src/db/token-usage-dal.ts`) | Database (Postgres) | `recordTokenUsage()` already owns this; only needs an additive `runner_type` column |
| Read/aggregate live spend for observability | Hub (DAL + future API) | - | `getTodayTokenTotal` / `getTodayTokenCostUsd` already exist and are runner_type-agnostic sums; Phase 1 makes them non-zero for PTY |
| Gate/block on the cap | *(out of scope - Phase 2)* | - | Phase 1 is record-only, mirroring the existing P2 "usage_event is RECORD only" invariant |

## Package Legitimacy Audit

**Not applicable.** This phase adds no new external dependency. Every primitive needed
(`node:fs`/`node:fs/promises` byte-offset read + `fs.watch`, `JSON.parse` line-by-line, the existing
`postgres.js` `sql` tag, the existing WS relay) is already in the codebase or the Node/Bun standard
library. If a planner is tempted to reach for an npm JSONL-tail or file-watch package, don't - the
exact primitive already exists at `hub/src/telegram/transcript/tail.ts` and only needs to be
relocated/ported into `supervisor/src/`, not replaced.

## Standard Stack

No new libraries. Everything below is existing in-repo code being **extended** or **relocated**, not
new dependency surface.

### Reused / ported components

| Component | Current location | Role in Phase 1 |
|-----------|------------------|------------------|
| `tailJsonl()` | `hub/src/telegram/transcript/tail.ts` | Port (not import - hub and supervisor are separate Bun workspace packages with no shared runtime) into `supervisor/src/` as the byte-offset tail primitive. `fs.watch` + 500ms poll-fallback already handles Windows watch flakiness and mid-write partial lines. |
| Claude JSONL record shape knowledge | `hub/src/telegram/transcript/claude-adapter.ts` (`mapClaudeRecord`) | Reference only - that function *discards* `message.usage` (it only wants role/text/tool_use/permission). Phase 1's new parser is a sibling function that extracts `message.usage` + `message.model` instead, not a reuse of `mapClaudeRecord` itself. |
| `usage_event` WS message type + handler | `supervisor/src/runners/types.ts` (type), `supervisor/src/runners/session-bridge.ts` (existing emitter, stream-json only), `hub/src/ws/agent.ts:759` (handler, `recordTokenUsage`) | Extend the type additively with `runner_type?: 'stream-json' \| 'pty-interactive'` (default-inferred `'stream-json'` if absent, for backward compat with older supervisors); add a **second, new** emitter for the PTY path. Handler code changes minimally (thread the field through to `recordTokenUsage`). |
| `recordTokenUsage()` / `token_usage` table | `hub/src/db/token-usage-dal.ts`, `hub/src/db/schema.sql:1311` | Add `runner_type TEXT NOT NULL DEFAULT 'stream-json'` column (additive, idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, matching the exact pattern used for `sessions.runner_type` at schema.sql:641). |
| `sessions.runner_type` / `pty_backend_id` / `transcript_path` columns | `hub/src/db/schema.sql:635-647` | Already exist (Phase 16, H10). **`transcript_path` is currently NEVER WRITTEN** - `setSessionPtyIdentity()` (`hub/src/db/dal.ts:115`) is defined but has zero call sites anywhere in the repo (grep-verified). Phase 1 is the first phase that has a reason to actually wire it - see Pitfall 2. |
| `runSupervisorReadCommand` / `EXT_READ_COMMANDS` allowlist | `hub/src/ext/supervisor-read.ts` | Reference pattern only for the *ranked alternative* (poll-based) design below - the recommended push design does not need a new allowlisted RPC command. |

### Alternatives considered

| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| Supervisor-side push tail (recommended) | Hub-initiated periodic RPC poll via `runSupervisorReadCommand('session_transcript_tail', ...)` (already shipped for milestone ASK) | Zero new WS message type, zero Rust/wire changes, reuses an already-released mechanism. But: adds a new allowlisted command (or extends the existing one to also sum usage), needs the hub to track a durable per-session cursor (byte offset or last-seen record id) to avoid double-counting on each poll, and gives coarser mid-flight granularity (bounded by poll interval, e.g. 30-60s) instead of near-real-time (`fs.watch`, ~500ms). Ranked #2 - simpler to build, weaker on "mid-turn" and "mid-flight" criteria. |
| Tailing the on-disk transcript JSONL | Adding a structured "usage" frame to the Rust `pty_host.rs` <-> Bun wire protocol, sourced from... nothing - the interactive `claude` TUI does not print a parseable token count to its own stdout/PTY output, and there is no IPC/debug pipe available without adding a flag, which is exactly the forbidden path | Not viable without violating the argv-allowlist-of-one / no-programmatic-flags invariant (`interactive-pty-runner-SPEC.md` constraint 5). Discarded. |
| Byte-count sampling of raw PTY output as a token proxy | (no library - would be hand-rolled) | Explored per the phase brief's Q3 fallback suggestion. Discarded: `pty_host.rs`'s reader thread already sees every output byte (`spawn_session`'s 8192-byte read loop, `pty_host.rs:190-206`) so it's *technically* free to sample, but PTY output bytes include ANSI escape sequences, TUI chrome (box-drawing, status lines, syntax highlighting codes), and human-echoed input - none of which correlates cleanly with token count. The on-disk transcript gives an *exact* SDK-reported figure for free; a byte-count estimate would be strictly worse for no savings. Not recommended even as a fallback. |

**Installation:** none - no new packages for either the primary or alternative path.

**Version verification:** N/A (no new external package).

## Architecture Patterns

### System Architecture Diagram

```
 Interactive `claude` process (spawned by Rust pty_host.rs, PTY, zero programmatic flags)
        |
        | writes (CLI's own doing, not code we control)
        v
 ~/.claude/projects/<slug>/<uuid>.jsonl   <-- lives on the SUPERVISOR HOST filesystem
        |
        | [NEW] byte-offset tail (ported tail.ts), one per live PTY session,
        |       started at PTY spawn, closed at PTY kill/detach
        v
 [NEW] supervisor-side usage extractor
   - parses each new line as JSON
   - if record.type === 'assistant' && record.message.usage present:
       sum 4 token buckets, note record.message.model
        |
        | usage_event WS frame (EXISTING type, additively tagged
        |   runner_type: 'pty-interactive')
        v
 hub/src/ws/agent.ts  usage_event handler (EXISTING, ~line 759)
        |
        | recordTokenUsage({ ...,  runner_type })  [dal signature extended additively]
        v
 token_usage table (Postgres)  -- NEW column runner_type TEXT DEFAULT 'stream-json'
        |
        v
 getTodayTokenTotal() / getTodayTokenCostUsd()  (EXISTING, unchanged SQL shape,
   now non-zero for PTY sessions) -- consumed later by Phase 2's dailyTokenCapGate
   and by any dashboard/alert that already reads these DAL functions
```

Parallel existing flow (unchanged by this phase, shown for contrast):

```
 stream-json `claude -p ... --output-format stream-json` subprocess
        |  SDK emits a `result` event with `usage` + `total_cost_usd`
        v
 session-bridge.ts (EXISTING) --usage_event (runner_type: 'stream-json', new default)--> same hub path
```

### Recommended file layout

```
supervisor/src/
  runners/
    claude-pty-bridge.ts        # EXISTING - unchanged; still pure raw-byte relay
  usage/
    oauth-poll.ts                # EXISTING - subscription util% poll, unrelated pattern reference
    pty-transcript-tail.ts       # NEW - ports tail.ts's byte-offset primitive
    pty-usage-emitter.ts         # NEW - owns per-session tail lifecycle + usage_event emission
```

```
hub/src/
  ws/agent.ts                   # usage_event handler - thread runner_type through (small diff)
  db/
    token-usage-dal.ts          # recordTokenUsage() - add runnerType param (additive, optional, defaults 'stream-json')
    schema.sql                  # ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS runner_type ...
```

### Pattern 1: Supervisor-owned, per-session tail lifecycle

**What:** One tail watcher per live `pty-interactive` session, started when the PTY is spawned
(hook into wherever the Bun side currently calls `ClaudePtyBridge.start()` / the `selectPtyBridge`
call site) and torn down on `kill()`/session close - mirroring exactly how the PTY itself is
lifecycle-scoped (see `claude-pty-bridge.ts`'s DETACH-vs-KILL doc comment).

**When to use:** Any time the supervisor needs live visibility into a process it does not directly
control the stdout of (the interactive CLI's real output goes to the PTY, not to a pipe the
supervisor parses for structure - see Pitfall 3).

**Example (ported primitive, not new code):**
```typescript
// Source: hub/src/telegram/transcript/tail.ts (existing, hub-only today) - port verbatim
// into supervisor/src/usage/pty-transcript-tail.ts. Signature unchanged.
export function tailJsonl(
  path: string,
  onRecord: (record: unknown) => void,
  opts?: { onParseError?: (line: string, err: unknown) => void; fromStart?: boolean },
): JsonlTail
```

### Pattern 2: Additive WS message tagging (established convention in this codebase)

**What:** Every prior "add a new dimension to an existing signal" change in this codebase (Phase 18's
`programmatic_credit` on `UsagePayload`, Phase 16's `runner_type` on `sessions`) is done as an
**additive, optional field with a safe default**, never a breaking schema change to an existing
message type - specifically so an older supervisor build (pre-upgrade) does not crash a newer hub, and
vice versa.

**When to use:** Extending `usage_event` here.

**Example:**
```typescript
// Source: supervisor/src/runners/types.ts (existing usage_event variant, to be extended)
| {
    type: 'usage_event'
    session_id: string
    model: string | null
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
    cost_usd: number
    cost_source: 'sdk' | 'estimated'
    ts: string
    runner_type?: 'stream-json' | 'pty-interactive'  // NEW, optional; hub defaults to 'stream-json' when absent
  }
```

### Anti-Patterns to Avoid

- **Reusing `hub/src/telegram/transcript/*` unmodified for this phase:** that code runs in the hub
  process and does direct `node:fs` calls against a path that does not exist in the deployed hub
  container. It is flag-gated OFF in Coolify for exactly this reason (`REMO_TELEGRAM_TRANSCRIPT_TAIL`,
  documented in `CLAUDE.md`). Port the *primitive* (`tail.ts`), do not import the *module* as deployed.
- **Adding a stream-json flag to the PTY spawn to get structured usage output.** This is the literal
  invariant this milestone exists to protect (`interactive-pty-runner-SPEC.md` constraint 5; the
  `no-api-key-no-streamjson-pty.test.ts` canary). Never do this, even temporarily, even for
  diagnostics.
- **Assuming `sessions.transcript_path` is already populated for live PTY sessions.** It is a schema
  column with zero writers today (verified: `setSessionPtyIdentity` has no call sites). Any plan that
  reads `getTranscriptOpenContext()`/`transcript_path` and assumes it is non-null for a PTY session
  will silently degrade to scrape-mode or fail. See Pitfall 2.
- **Double-counting on hub restart.** If the cursor/offset for "what's already been recorded" is kept
  only in hub memory (like `hub/src/usage/store.ts`'s subscription snapshot, which is explicitly
  "cleared on hub restart, agents repoll"), a naive re-tail-from-start after a hub restart would
  re-emit already-recorded usage rows. Because the recommended design keeps the byte offset in the
  **supervisor** (which does not restart on hub restart) this is naturally avoided - but if a planner
  instead chooses the poll-based alternative (hub-initiated RPC), the cursor MUST be persisted
  hub-side (e.g., a `sessions.pty_usage_cursor` column or small tracking table), not kept in the
  existing in-memory `hub/src/usage/store.ts` pattern.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tailing a growing JSONL file safely (partial trailing lines, truncation/rotation, watch flakiness on Windows) | A new fs-watch loop from scratch | Port `hub/src/telegram/transcript/tail.ts` verbatim | It already solves partial-line carry-over, truncation detection (`size < offset`), and the Windows-watch-unreliable problem via a 500ms poll fallback. Re-deriving this is pure risk for zero benefit. |
| Estimating cost when the SDK-reported cost is absent | A new pricing table | `hub/src/usage/pricing.ts` `estimateCostUsd()` (existing, already model-prefix-aware) | Already exists, already tested (`hub/test/usage-pricing.test.ts`), already the single source of truth CLAUDE.md documents for "update prices here." A PTY-side `usage_event` should set `cost_source` from whether the JSONL record's `total_cost_usd` (if the transcript ever carries one - not confirmed, see Open Question 1) is present, falling back to this exact function. |
| Deciding which supervisor hosts a given session for an RPC/relay | A new lookup | `findSupervisorForSession()` / `supervisor-registry.ts` (existing, used by `hub/src/api/ext.ts`) | Already the resolver used by the milestone-ASK read surface for the identical "which live supervisor owns this session" question. |

**Key insight:** This phase's entire job is a **data-source substitution problem**, not a new
capability: the token counts already exist on disk in a format this repo already knows how to parse
(minus one field the existing parser discards). Every piece of infrastructure needed - the tail
primitive, the WS push channel, the ledger write path, the supervisor-resolution lookup - is already
built and shipped for a sibling use case (Telegram transcript-tail, P2 usage ledger, milestone ASK).
The risk in this phase is entirely in **correct file targeting** (Pitfall 2) and **not conflating the
"dual bucket" Phase 18 already shipped with the bucket this phase needs** (Pitfall 4), not in missing
tooling.

## Common Pitfalls

### Pitfall 1: The hub container cannot see the transcript file
**What goes wrong:** A plan that has the HUB directly read `~/.claude/projects/...` (as
`hub/src/telegram/transcript/claude-adapter.ts` does today) will work in local dev (hub and supervisor
on the same machine) and then silently do nothing / error in prod, where the hub runs in a Coolify
Docker container with no such path.
**Why it happens:** The existing Phase-20 telegram-transcript-tail code was apparently built/tested
against a same-host topology and is explicitly flagged OFF in Coolify for this exact reason - but nothing stops a planner
from copying that pattern without noticing the flag/comment.
**How to avoid:** Any file read must happen supervisor-side. Cross the host boundary only via the
existing `/ws/agent` channel (either the push design's `usage_event`, or the alternative poll design's
`runSupervisorReadCommand`), never via direct hub-side `fs`.
**Warning signs:** Any new code under `hub/src/**` that calls `fs.existsSync`/`readFileSync` against a
path derived from `homedir()` or `~/.claude` should be treated as a red flag in review for this phase.

### Pitfall 2: No reliable, already-wired way to know *which* JSONL file belongs to a freshly-spawned interactive session
**What goes wrong:** The PTY spawn (`pty_host.rs` `spawn_session`) passes **empty argv** - no
`--session-id` equivalent exists for the interactive CLI, so the supervisor does not learn the CLI's
self-generated session UUID at spawn time. `sessions.transcript_path` / `setSessionPtyIdentity()` were
built in schema (Phase 16, H10) apparently to solve exactly this, but the capture step was **never
implemented** (zero call sites, grep-verified). The only working fallback today
(`session-read.ts:newestJsonl()`, used by the shipped milestone-ASK `session_transcript_tail`) picks
the **most-recently-modified `.jsonl` in the project directory** - which is correct as long as at most
one live session is writing to that directory, but will silently attribute tokens to the wrong session
if a human PTY session and, say, a stream-json ask-session (`docs/session-ask.md`'s `POST
.../ask`) are both active in the same `project_dir` at once.
**Why it happens:** The interactive CLI's session id is CLI-internal and not surfaced to its spawner
by design (raw PTY, no structured startup handshake).
**How to avoid:** Two ranked options for the planner:
  1. **(Recommended if time allows)** Have the supervisor watch the project's `~/.claude/projects/<slug>/`
     directory for a **new** `.jsonl` file appearing within a few seconds after PTY spawn (a directory
     watch, not a periodic listing), capture its path once, and finally wire `setSessionPtyIdentity()`
     to persist it. This closes the ambiguity permanently and pays down Phase-16 tech debt in the same
     motion.
  2. **(Pragmatic fallback, matches what's already shipped)** Reuse `newestJsonl()` exactly as
     milestone ASK does today, and explicitly document the cross-wire risk as a known limitation (single
     concurrent session per project_dir is the safe case; this is very likely true for the vast majority
     of real usage, since a human doesn't typically run a PTY session and a stream-json ask on the same
     repo simultaneously).
**Warning signs:** Token counts appearing on the wrong session in a repo where the user also has an
ask-session or an orchestrator session active on the same `project_dir`.

### Pitfall 3: The interactive CLI's PTY *output* stream is not a usable usage signal
**What goes wrong:** A plan that tries to parse token counts out of the raw terminal bytes the PTY
emits (what a human sees on screen) will find that Claude Code's interactive TUI does not print a
machine-parseable running token count anywhere in its rendered output - what's visible is a
human-oriented status line/spinner, not the SDK's structured `usage` object.
**Why it happens:** The interactive TUI's job is to render for a human, not to emit structured
telemetry; that structured data goes to the on-disk transcript, not to the terminal screen.
**How to avoid:** Always source usage from the on-disk transcript JSONL, never from PTY output bytes
(confirmed by inspection of `pty_host.rs`'s reader loop, which only ever sees/broadcasts raw
already-rendered bytes with zero structure imposed).
**Warning signs:** Any design that references `broadcast_data()` / the `onData` callback in
`claude-pty-bridge.ts` as a usage source.

### Pitfall 4: Conflating this phase's "dual bucket" with Phase 18's "dual bucket" (they are unrelated signals)
**What goes wrong:** ROADMAP.md success criterion #2 says "interactive and programmatic usage remain
in separate buckets" - it is tempting to think this is already solved by Phase 18's
`ProgrammaticCredit` / `UsagePayload` (`hub/src/usage/store.ts`), which already has an "interactive vs
programmatic" split. It is not the same thing.
**Why it happens:** Both use the words "interactive" and "programmatic."
**How to avoid:** Phase 18's dual bucket is a **per-user, in-memory, OAuth-polled subscription
utilization snapshot** (util% windows + a dollar credit balance), refreshed every 5 minutes by
`supervisor/src/usage/oauth-poll.ts`, entirely disconnected from any specific session or turn, and
answering "how much of my Anthropic subscription have I used." This phase's bucket is a **per-row,
persisted, per-turn ledger tag** on `token_usage` answering "did THIS specific token spend come from a
human at a keyboard or from unattended automation" - the metering signal Phase 2-4 need to eventually
gate/alert on. They are complementary, not overlapping; do not try to derive one from the other.
**Warning signs:** A plan task that touches `hub/src/usage/store.ts` or `oauth-poll.ts` expecting to
find/create the PTYCAP bucket split there instead of on `token_usage`.

### Pitfall 5: `token_usage_daily`'s primary key does not have room for a runner_type split yet
**What goes wrong:** `token_usage_daily`'s PK is `(user_id, day, model)`. If a future dashboard wants a
daily rollup **split by runner_type**, the current upsert (`ON CONFLICT (user_id, day, model) DO
UPDATE ... accumulate`) will silently merge PTY and stream-json totals into one row.
**Why it happens:** The rollup table predates this phase and was never designed for a third dimension.
**How to avoid:** Out of scope for Phase 1's stated success criteria (which only require the *ledger*
row-level split, satisfied by `token_usage.runner_type`) - but the planner should explicitly decide
whether to extend `token_usage_daily`'s PK to `(user_id, day, model, runner_type)` now (small,
idempotent, no data loss since it's a rollup) or defer it to whichever later phase first needs a
runner_type-split daily view. Flag it as an explicit decision point in the plan rather than leaving it
implicit.

## Code Examples

### Extracting usage from a Claude Code transcript record (new parsing logic, sibling to `mapClaudeRecord`)

```typescript
// NOT an existing function - reference shape based on the VERIFIED on-disk record format
// (sampled directly from this machine's own transcript during this research session):
//   {"type":"assistant","uuid":"...","timestamp":"...","message":{"id":"...","model":"claude-opus-5",
//    "role":"assistant","type":"message","usage":{"input_tokens":N,"output_tokens":N,
//    "cache_creation_input_tokens":N,"cache_read_input_tokens":N,"server_tool_use":{...}}}}
interface TranscriptUsageRecord {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  model: string | null
}

function extractUsage(record: unknown): TranscriptUsageRecord | null {
  if (!record || typeof record !== 'object') return null
  const r = record as any
  if (r.type !== 'assistant') return null
  const usage = r.message?.usage
  if (!usage || typeof usage !== 'object') return null
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    outputTokens: Number(usage.output_tokens ?? 0),
    cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
    cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    model: typeof r.message?.model === 'string' ? r.message.model : null,
  }
}
```

### Additive schema change (matches the existing convention exactly)

```sql
-- Source: pattern established at hub/src/db/schema.sql:641 (sessions.runner_type)
-- ── PTYCAP Phase 1: per-row runner_type tag on the usage ledger ──────────────
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'token_usage_runner_type_check'
  ) THEN
    ALTER TABLE token_usage ADD CONSTRAINT token_usage_runner_type_check
      CHECK (runner_type IN ('stream-json', 'pty-interactive'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_token_usage_user_runner_type ON token_usage(user_id, runner_type, created_at DESC);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Post-hoc-only accounting via `session-bridge.ts` `result` event (stream-json only) | Same mechanism for stream-json; NEW live-tail mechanism for PTY (this phase) | This phase | PTY sessions become visible to the token ledger for the first time - previously zero rows ever |
| `token_usage` with no bucket dimension | `token_usage.runner_type` additive column | This phase | Enables Phase 2's gate (and any dashboard) to distinguish human-keyboard spend from automation spend |

**Deprecated/outdated:** none - this is additive, not a replacement of anything shipped.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The Codex interactive TUI's on-disk rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carries an equivalent per-turn token-usage field the same way Claude's does. **Not verified this session** - no local Codex rollout sample was inspected, and the existing `hub/src/telegram/transcript/codex-adapter.ts` (Phase 20) has zero references to token/usage fields, suggesting this was never explored even for the sibling Telegram feature. | Standard Stack / Don't Hand-Roll | If false, Codex PTY sessions stay unaccounted-for even after this phase ships for Claude; the planner should explicitly scope Phase 1 to `cli_kind='claude'` first (matching the existing Phase-20 precedent, which shipped a full Claude adapter and a documented-weaker Codex adapter with scrape-mode fallback) and treat Codex usage accounting as a fast-follow, not silently assume parity. |
| A2 | The interactive `claude` CLI, when spawned via PTY with zero flags, writes its transcript to the SAME path convention (`~/.claude/projects/<slug>/<session-uuid>.jsonl`) as a stream-json session. **Verified this session** by direct inspection of a live transcript file on this machine (100 lines, 27 assistant-with-usage records, real model id `claude-opus-5`) - but that sample came from an interactive CLI session in general, not from a session specifically spawned through this repo's `pty_host.rs` code path (which strips `ANTHROPIC_API_KEY`/etc. from the env but does not change the CLI's own transcript-writing behavior, so this should hold, but was not end-to-end verified through an actual `pty_host.rs`-spawned process in this research pass). | Summary / Code Examples | Low risk - the transcript-writing behavior is a CLI-internal convention unrelated to how the process was spawned or what env vars were stripped; a planner should still do one live smoke test (spawn a real PTY session via this branch's supervisor, confirm the JSONL appears and updates) as part of Wave 0 / Definition of Done before trusting this in production. |
| A3 | No existing code path already emits `usage_event` (or an equivalent) for PTY sessions under some other name this research missed. | Summary | Verified by full-repo grep for `usage_event` (5 hits, all accounted for above) and by reading every PTY-adjacent runner file (`claude-pty-bridge.ts`, `pty_host.rs`, `claude-pty-runner.ts`) - none reference usage/tokens/cost. High confidence this is a genuine gap, not a rediscovery of existing coverage. |

## Open Questions

1. **Does the on-disk transcript ever carry a `total_cost_usd`-equivalent per assistant record, or only the four raw token buckets?**
   - What we know: the sampled record showed `usage: {input_tokens, output_tokens,
     cache_creation_input_tokens, cache_read_input_tokens, server_tool_use: {...}}` - no cost field
     visible in the sampled record.
   - What's unclear: whether other record shapes (e.g. a terminal "result"-equivalent record, if one
     exists in the interactive transcript format) carry a cost figure the way the stream-json `result`
     event's `total_cost_usd` does.
   - Recommendation: default `cost_source: 'estimated'` for every PTY-sourced `usage_event` and let the
     existing `estimateCostUsd()` fallback compute it from the token counts + model, exactly as the
     stream-json path already does when the SDK omits cost. This requires no new code (the fallback path
     already exists) and is a safe default regardless of the answer.

2. **What is the actual current cadence/latency the planner should target for "mid-turn" visibility, and is `fs.watch` reliable enough on this project's target hosts (Windows, primarily)?**
   - What we know: `tail.ts` already ships a poll-fallback specifically because "watch is unreliable on
     some Windows / network filesystems" (its own doc comment) - so the existing 500ms poll interval is
     an already-chosen, already-shipped answer for a sibling feature on the same OS target.
   - What's unclear: whether 500ms is the right interval to also reuse here, or whether a coarser
     interval (e.g. 2-5s) is preferable to reduce WS chatter for a usage signal that does not need
     sub-second precision the way a live terminal render does.
   - Recommendation: reuse the identical 500ms constant for consistency and because a low-latency signal
     directly serves criterion #1 ("observable... while it spends it"); revisit only if the plan-checker
     or verifier flags WS message volume as a concern.

## Environment Availability

Skipped - this phase has no new external tool/service/runtime dependency. It runs entirely within the
existing Bun (supervisor + hub) and Rust (`pty_host.rs`, unmodified) toolchains already required to
build this repo.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Bun's built-in test runner (`bun:test`) - used uniformly across `hub/test/` and `supervisor/test/` |
| Config file | none — Bun test auto-discovers `*.test.ts`; CI gate is `bun run check-baseline` (`tools/regression-baseline.json`, per-file isolation) |
| Quick run command | `bun test <path/to/file>.test.ts` (per-file, matches the CI isolation model - avoids `mock.module` cross-file pollution, see project memory `feedback_bun_mock_pollution`) |
| Full suite command | `bun run check-baseline` |

### Phase Requirements -> Test Map

No `REQUIREMENTS.md` IDs are mapped to this milestone (confirmed - PTYCAP requirements live only in
`ROADMAP.md`'s Phase 1 Success Criteria). Mapping the three ROADMAP criteria directly:

| Criterion | Behavior | Test Type | Automated Command | File Exists? |
|-----------|----------|-----------|--------------------|-------------|
| SC-1 (mid-turn observable) | A `usage_event` with `runner_type:'pty-interactive'` lands in `token_usage` while a simulated PTY transcript is still being appended to (i.e., before an `exit`/`kill` frame) | integration | `bun test supervisor/test/pty-usage-tail.test.ts` *(new)* | ❌ Wave 0 |
| SC-2 (separate buckets) | Two `recordTokenUsage()` calls with different `runnerType` produce two `token_usage` rows distinguishable by `runner_type`, and `token_usage_runner_type_check` rejects a third value | unit | `bun test hub/test/token-usage-runner-type.test.ts` *(new)* | ❌ Wave 0 |
| SC-3 (mid-flight detectable) | After N simulated incremental transcript writes (each under the day's token cap individually, cumulative total over it), `getTodayTokenTotal()` reflects the cumulative sum without waiting for a session-close event | integration | `bun test hub/test/pty-usage-midflight-visibility.test.ts` *(new)* | ❌ Wave 0 |
| (regression) usage_event backward-compat | An old-shape `usage_event` (no `runner_type` field) still records with `runner_type='stream-json'` default | unit | `bun test hub/test/usage-event-handler.test.ts` *(extend existing)* | ✅ existing file, extend |
| (regression) transcript-file host boundary | A guard/comment-level test (or lint) asserting no new `hub/src/**` module reads `homedir()`-derived paths directly (Pitfall 1) | static/guard | `bun test hub/test/no-hub-side-transcript-fs.test.ts` *(new, cheap grep-based canary, same style as `no-legacy-agent-spawn.test.ts`)* | ❌ Wave 0, optional but recommended given Pitfall 1's severity |

### Sampling Rate
- **Per task commit:** the single new/changed test file's `bun test <file>`
- **Per wave merge:** `bun run check-baseline`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `supervisor/test/pty-usage-tail.test.ts` — covers SC-1; needs a fixture that writes a fake
      growing JSONL file (same technique likely already used by
      `hub/test/transcript-adapter-claude.test.ts` for the Phase-20 adapter — reuse that fixture
      pattern if present)
- [ ] `hub/test/token-usage-runner-type.test.ts` — covers SC-2
- [ ] `hub/test/pty-usage-midflight-visibility.test.ts` — covers SC-3
- [ ] `hub/test/no-hub-side-transcript-fs.test.ts` — optional guard canary for Pitfall 1
- [ ] Framework install: none — `bun:test` already present

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | No | This phase adds no new auth surface — the `usage_event` frame already rides the existing authenticated `/ws/agent` connection (`api_keys` credential, per CLAUDE.md's WS Protocol section) |
| V3 Session Management | No | No session-lifecycle change |
| V4 Access Control | Yes (narrow) | The new supervisor-side file read is scoped to files the supervisor itself already has OS-level access to on its own host — this is strictly less exposure than the milestone-ASK `session_transcript_tail` command, which is externally triggerable via an API key. If the planner reuses any part of `session-read.ts`'s path-resolution (`resolveSessionDir` / `realPathContained`), that existing path-traversal + symlink-escape guard must be reused verbatim, not re-derived, for any code path an external actor can influence (e.g. if `project_dir` ever comes from a session row an attacker could have renamed — unlikely here since the tailer is spawned supervisor-locally off its own PTY-spawn bookkeeping, not off an externally-supplied path, but worth a explicit negative test given this exact class of bug (symlink escape) was already found and fixed once in `session-read.ts`) |
| V5 Input Validation | Yes | Transcript JSONL lines are **untrusted-ish** in the sense that a malformed/adversarial line (e.g. from a compromised or buggy CLI release) must never crash the tailer or corrupt the ledger. Mirror `tail.ts`'s existing behavior: a JSON.parse failure on one line is skipped (`onParseError`), never fatal — same posture as `mapClaudeRecord`'s "unknown type -> skip + count, never crash." |
| V6 Cryptography | No | No new crypto surface |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| A crafted/corrupted transcript line causes the tailer to throw and kill the supervisor's usage-tracking (denial of observability, not of the PTY itself — the human's session keeps working, but spend goes dark again) | Denial of Service (narrow) | Wrap per-line parse + extraction in try/catch exactly as `tail.ts`/`mapClaudeRecord` already do; a parse failure must degrade to "skip this line, keep tailing," never tear down the watcher |
| Symlink/path-escape via a manipulated `project_dir` or transcript path, if any future extension lets an external actor influence which file is tailed | Tampering / Information Disclosure | Reuse `session-read.ts`'s `resolveSessionDir` + `realPathContained` pattern verbatim if the file path is ever derived from anything other than the supervisor's own local PTY-spawn bookkeeping. For Phase 1's scope (supervisor tails a file it itself is watching for a session it itself spawned), this risk is low but should still get a negative test given the precedent |
| Fabricated/inflated token counts pushed by a malicious or buggy supervisor build, silently trusted into `token_usage` | Tampering | Out of scope for Phase 1 (the entire WS transport already trusts the supervisor as an authenticated principal — this is the same trust boundary `usage_event` already operates under for stream-json today; no new exposure introduced by this phase) |

## Sources

### Primary (HIGH confidence — verified directly against this branch's code, this session)
- `supervisor/src/runners/session-bridge.ts` (lines ~469-490) — usage_event emission, stream-json only
- `supervisor/src/runners/claude-pty-bridge.ts` (full file) — PTY wire protocol, no usage signal
- `supervisor/tauri/src-tauri/src/pty_host.rs` (spawn_session, handle_frame, PtySession/RingBuffer) — Rust PTY host has zero token/usage structure
- `hub/src/ws/agent.ts` (~line 754-794) — usage_event handler, RECORD-only
- `hub/src/db/token-usage-dal.ts` (full file) — recordTokenUsage, getTodayTokenTotal, getTodayTokenCostUsd
- `hub/src/db/schema.sql` (sessions runner_type/pty_backend_id/transcript_path block at 635-647; token_usage/token_usage_daily at 1311-1341)
- `hub/src/db/dal.ts` (setSessionPtyIdentity, getTranscriptOpenContext, getSessionPtyIdentity) — confirmed setSessionPtyIdentity has zero call sites via repo-wide grep
- `hub/src/telegram/transcript/{types,tail,claude-adapter,manager}.ts` — existing JSONL-tail machinery + its hub-locality limitation
- `hub/src/usage/{store,pricing,programmatic-leak}.ts` — Phase 18 dual-bucket (confirmed unrelated to this phase's bucket requirement)
- `hub/src/ext/supervisor-read.ts` + `supervisor/src/commands/session-read.ts` — milestone-ASK cross-host RPC pattern (alternative design reference)
- `hub/src/dispatch/gates.ts` (dailyTokenCapGate, AUTOMATION_ACTORS, humanOnlyPtyGate) — confirms Phase 1 writes into the same ledger Phase 2 will gate on
- Live on-disk transcript file on this machine (`~/.claude/projects/C--Users-artic-GitHub-remo-code/45baec6e-....jsonl`) — direct `grep`/`wc` verification that assistant records carry `message.usage` with the same four token buckets used elsewhere in this codebase, and that a 100-line transcript contains 27 such records (i.e., per-agentic-loop-turn granularity)
- `docs/usage-cost.md`, `docs/session-ask.md`, `CLAUDE.md` (Usage cost ledger / PTY terminal surface / cross-cutting invariants sections) — architectural context + explicit "keep OFF in Coolify" documentation for the hub-side transcript-tail limitation
- `.planning/ROADMAP.md` — Phase 1 success criteria, milestone hard invariants
- `git log --oneline -20` on `feat/ptycap-token-gate` — confirmed no prior PTYCAP-01 implementation work exists on this branch (all recent commits are unrelated fixes)

### Secondary (MEDIUM confidence)
- none — every claim above was checked directly against code or a live artifact on this machine rather than via external search, given the phase is entirely internal-architecture research

### Tertiary (LOW confidence)
- Codex rollout JSONL usage-field parity (Assumption A1) — not verified this session, flagged explicitly

## Metadata

**Confidence breakdown:**
- Standard stack (no new deps, port existing primitives): HIGH — verified by direct file reads, no external claims
- Architecture (supervisor-side push tail + additive schema): HIGH — every component cited is existing, working code in this exact branch; the only genuinely new logic is the usage-extraction function and the tail-lifecycle wiring, both small and directly modeled on shipped sibling code
- Pitfalls: HIGH for Pitfalls 1/3/4/5 (directly demonstrated by code/docs); MEDIUM for Pitfall 2 (the file-targeting ambiguity is real and verified, but the two ranked resolution options are design recommendations, not yet-proven code)

**Research date:** 2026-07-27
**Valid until:** 30 days (stable internal architecture; re-verify if the Phase-16/H10 `transcript_path` wiring or the Phase-20 telegram-transcript machinery changes before Phase 1 is planned)

## RESEARCH COMPLETE
