---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 02
type: execute
wave: 2
depends_on:
  - 16-01
files_modified:
  - hub/src/ws/term-protocol.ts
  - hub/src/ws/client.ts
  - hub/src/ws/agent.ts
  - hub/src/dispatch/gates.ts
  - hub/src/dispatch/pipeline.ts
  - hub/src/db/schema.sql
  - hub/src/api/sessions.ts
  - hub/test/term-channel-isolation.test.ts
  - hub/test/term-relay-auth.test.ts
  - hub/test/human-only-guard.test.ts
  - hub/test/pty-runner-type.test.ts
autonomous: true
requirements:
  - R-PTY-08
  - R-PTY-10
  - R-PTY-11
must_haves:
  truths:
    - "A raw-terminal WS frame schema (term.data/term.input/term.resize/term.attach/term.reattach) lives OUTSIDE agent-protocol.ts and carries no RunnerEvent coupling"
    - "Raw-terminal frames are authenticated by the existing opaque-cookie session (/ws/client) and api_keys (/ws/agent); an unauthenticated frame is rejected"
    - "The hub relays term.* frames between matched /ws/client and /ws/agent by session_id WITHOUT parsing payload bytes"
    - "A human-only dispatch GATE rejects automation sources (scheduler/orchestrator-background/auto-dev/error-capture) for pty-interactive sessions, composed into the shared pipeline — never bypassing the cost cap"
    - "Per-session runner_type ('stream-json'|'pty-interactive', default stream-json) is stored via idempotent DDL; a Telegram-default session cannot be switched to pty-interactive"
  artifacts:
    - path: "hub/src/ws/term-protocol.ts"
      provides: "Zod raw-terminal frame schema, isolated from agent-protocol"
    - path: "hub/src/dispatch/gates.ts"
      provides: "humanOnlyPtyGate composed into the shared dispatch pipeline"
  key_links:
    - from: "/ws/client term.input"
      to: "/ws/agent term.input → claude-pty-runner.write"
      via: "session_id-keyed byte-faithful relay"
      pattern: "term.* frames, no agent-protocol parse"
    - from: "dispatch source + session.runner_type"
      to: "humanOnlyPtyGate reject/allow"
      via: "composed gate in pipeline.ts, after/with dailyCostCapGate"
      pattern: "automation source + pty-interactive ⇒ reject"
---

<objective>
Stand up the authenticated raw-terminal relay end-to-end (isolated from the structured pipeline) and the
human-only dispatch guard (constraint 3). Add the per-session runner-type seam. The relay rides the
EXISTING authenticated WS connections; the guard composes into the EXISTING shared dispatch pipeline and
never weakens the non-bypassable cost cap.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/ws/agent-protocol.ts
@hub/src/ws/client.ts
@hub/src/ws/agent.ts
@hub/src/dispatch/pipeline.ts
@hub/src/dispatch/gates.ts
@hub/src/api/sessions.ts
@hub/src/db/schema.sql
@CLAUDE.md

<interfaces>
From hub/src/ws/agent-protocol.ts: existing kinds (thinking/text_delta/tool_use/tool_result/status/assistant_message/permission_request/user_question/usage_event) — term.* MUST NOT join this union.
From hub/src/ws/client.ts: opaque-cookie token auth on /ws/client; subscribe by session_id(s).
From hub/src/dispatch/gates.ts: dailyCostCapGate / isOverCostCap — the single non-bypassable cost source; new gate composes alongside it.
From hub/src/api/sessions.ts: `cli_kind: z.enum(['claude','codex'])` — mirror for runner_type.
From hub/src/db/schema.sql: `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS cli_kind ...` idempotent pattern — mirror for runner_type (NO backfill in schema.sql).
</interfaces>
</context>

<threat_model>
- **T-16-05 — Unauthenticated terminal attach (HIGH).** If term.* frames bypass session auth, a stranger
  could attach to a live coding TUI (read output, inject input). Mitigation: term.* frames ride the
  existing authenticated /ws/client (opaque cookie) + /ws/agent (api_keys); a frame on an unauthenticated
  or unsubscribed connection is rejected. Test: a term.input without a valid session is dropped.
- **T-16-06 — Automation drives the interactive PTY (HIGH, the constraint-3 boundary).** If a scheduler /
  auto-dev / error-capture / orchestrator-background dispatch reaches a pty-interactive session, that is
  "a robot pressing enter via the interactive entrypoint" — the flagged/ban-risk move. Mitigation:
  humanOnlyPtyGate rejects automation sources for pty-interactive sessions, composed into the shared
  pipeline. Test asserts rejection for each automation source and allow for human interactive.
- **T-16-07 — Structured-pipeline coupling leak (MEDIUM).** If term.* frames depend on / emit
  RunnerEvent, the rip in Phase 17 would break the terminal surface. Mitigation: term-protocol.ts is a
  separate schema; isolation test asserts no RunnerEvent import on the terminal path.
- **T-16-08 — Cost-cap bypass via the new channel (HIGH).** Mitigation: the human-only gate composes
  WITH dailyCostCapGate; the PTY path does not introduce an uncapped dispatch route. (Interactive PTY
  turns still emit usage_event, captured by token_usage — see CLAUDE.md cost-cap invariant.)
Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: term-protocol.ts — isolated raw-terminal frame schema</name>
  <files>hub/src/ws/term-protocol.ts, hub/test/term-channel-isolation.test.ts</files>
  <read_first>
    - hub/src/ws/agent-protocol.ts (the union term.* must stay OUT of)
    - hub/src/ws/protocol.ts (client-side message shapes for parity)
  </read_first>
  <acceptance_criteria>
    - term-protocol.ts defines a Zod schema for term.data / term.input / term.resize {cols,rows} / term.attach / term.reattach {scrollback?}
    - The schema is NOT part of the agent-protocol union and term-protocol.ts does NOT import agent-protocol.ts or the RunnerEvent type
    - term-channel-isolation.test.ts asserts (static) no RunnerEvent/agent-protocol coupling on the terminal path
  </acceptance_criteria>
  <action>
    Create the standalone term frame schema. Keep byte payloads opaque (base64 or binary). Add the
    isolation test mirroring the Phase-15 isolation check.
  </action>
  <verify>
    <automated>cd hub; bun test test/term-channel-isolation.test.ts 2>$null</automated>
    `grep -nE "agent-protocol|RunnerEvent" hub/src/ws/term-protocol.ts` returns NOTHING.
  </verify>
  <done>Raw-terminal frames are a separate, RunnerEvent-free schema.</done>
</task>

<task type="auto">
  <name>Task 2: Authenticated byte-faithful relay /ws/client ↔ /ws/agent</name>
  <files>hub/src/ws/client.ts, hub/src/ws/agent.ts, hub/test/term-relay-auth.test.ts</files>
  <read_first>
    - hub/src/ws/client.ts (opaque-cookie auth + subscribe-by-session routing)
    - hub/src/ws/agent.ts (api_keys-keyed agent channel)
    - hub/src/ws/term-protocol.ts (frames to relay)
  </read_first>
  <acceptance_criteria>
    - term.* frames are accepted only on an authenticated /ws/client (valid opaque session) subscribed to the target session, and relayed to the matched /ws/agent (and back) keyed by session_id
    - The hub does NOT parse term.data/term.input payload bytes — byte-faithful passthrough
    - A term.input on an unauthenticated or unsubscribed connection is rejected (test)
    - Existing structured-pipeline routing is unchanged (regression: agent-protocol tests stay green)
  </acceptance_criteria>
  <action>
    Add a term.* relay branch on both WS handlers reusing the existing auth + session-subscription
    routing. Do not introduce a new socket. Pass payload bytes through untouched.
  </action>
  <verify>
    <automated>cd hub; bun test test/term-relay-auth.test.ts 2>$null</automated>
  </verify>
  <done>Authenticated, byte-faithful raw-terminal relay; unauth frames rejected.</done>
</task>

<task type="auto">
  <name>Task 3: Per-session runner_type column + API (idempotent DDL, no backfill)</name>
  <files>hub/src/db/schema.sql, hub/src/api/sessions.ts, hub/test/pty-runner-type.test.ts</files>
  <read_first>
    - hub/src/db/schema.sql (the `ADD COLUMN IF NOT EXISTS cli_kind` idempotent pattern — mirror it)
    - hub/src/api/sessions.ts (`cli_kind: z.enum(['claude','codex'])` validation to mirror)
  </read_first>
  <acceptance_criteria>
    - schema.sql adds `runner_type TEXT NOT NULL DEFAULT 'stream-json'` via `ADD COLUMN IF NOT EXISTS` (idempotent; re-runs safely every boot; NO data backfill in schema.sql)
    - sessions API validates runner_type ∈ {'stream-json','pty-interactive'} and is opt-in per session
    - A Telegram-default session cannot be set to 'pty-interactive' (API/guard rejects); a test asserts this
  </acceptance_criteria>
  <action>
    Mirror the cli_kind column + enum validation. Add the Telegram-default guard at the set-runner-type
    path. Any one-shot migration of existing rows (none needed; default applies) goes in hub/scripts/,
    never schema.sql.
  </action>
  <verify>
    <automated>cd hub; bun test test/pty-runner-type.test.ts 2>$null</automated>
    `grep -n "ADD COLUMN IF NOT EXISTS runner_type" hub/src/db/schema.sql` returns a hit.
  </verify>
  <done>Per-session runner type exists, opt-in, idempotent; Telegram-default stays stream-json.</done>
</task>

<task type="auto">
  <name>Task 4: humanOnlyPtyGate — reject automation sources for PTY sessions</name>
  <files>hub/src/dispatch/gates.ts, hub/src/dispatch/pipeline.ts, hub/test/human-only-guard.test.ts</files>
  <read_first>
    - hub/src/dispatch/gates.ts (dailyCostCapGate / isOverCostCap — compose alongside, do not bypass)
    - hub/src/dispatch/pipeline.ts (how gates are composed; the dispatch source field)
  </read_first>
  <acceptance_criteria>
    - A new humanOnlyPtyGate rejects dispatches whose source ∈ {scheduler, orchestrator-background, auto-dev, error-capture} when the target session.runner_type = 'pty-interactive'
    - A genuine interactive human turn to a pty-interactive session is ALLOWED
    - Automation to a stream-json session is UNCHANGED (still cost-capped)
    - The gate composes into the shared pipeline; the non-bypassable dailyCostCapGate still applies (no new uncapped route)
    - human-only-guard.test.ts asserts reject-per-automation-source, allow-human, and cost-cap-still-applies
  </acceptance_criteria>
  <action>
    Add the gate keyed on (dispatch source, session.runner_type) and compose it in pipeline.ts alongside
    the cost-cap gate. Read the dispatch source from the existing dispatch context (scheduler/error-capture/
    revanote/telegram/interactive already flow through the pipeline). Do NOT create a parallel dispatch path.
  </action>
  <verify>
    <automated>cd hub; bun test test/human-only-guard.test.ts 2>$null</automated>
  </verify>
  <done>Automation can never drive a PTY session; human turns pass; cost cap intact.</done>
</task>

</tasks>

<verification>
- term-protocol.ts has zero agent-protocol/RunnerEvent coupling (grep + isolation test)
- Unauthenticated term.input rejected; authenticated relay is byte-faithful
- Every automation source rejected for pty-interactive; human interactive allowed; cost cap unaffected
- schema.sql runner_type is idempotent `ADD COLUMN IF NOT EXISTS`, no backfill
- `bun run check-baseline` green
</verification>

<success_criteria>
An authenticated, isolated raw-terminal relay end-to-end plus a human-only dispatch guard that makes
constraint 3 enforceable, with a per-session runner-type seam Phase 17/20 reuse — and the cost cap
provably intact.
</success_criteria>

<output>
Create `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-02-SUMMARY.md` when done.
</output>
