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
  - hub/src/ws/supervisor-registry.ts
  - hub/src/dispatch/gates.ts
  - hub/src/dispatch/pipeline.ts
  - hub/src/db/schema.sql
  - hub/src/api/sessions.ts
  - hub/test/term-channel-isolation.test.ts
  - hub/test/term-relay-auth.test.ts
  - hub/test/term-relay-human-guard.test.ts
  - hub/test/term-agent-inventory-auth.test.ts
  - hub/test/human-only-guard.test.ts
  - hub/test/pty-runner-type.test.ts
  - hub/test/pty-runner-resume-identity.test.ts
autonomous: true
requirements:
  - R-PTY-08
  - R-PTY-10
  - R-PTY-11
  - R-PTY-28
  - R-PTY-29
  - R-PTY-30
  - R-PTY-31
must_haves:
  truths:
    - "A raw-terminal WS frame schema (term.data/term.input/term.resize/term.attach/term.reattach) lives OUTSIDE agent-protocol.ts and carries no RunnerEvent coupling"
    - "Raw-terminal frames are authenticated by the existing opaque-cookie session (/ws/client) and api_keys (/ws/agent); an unauthenticated frame is rejected"
    - "The hub relays term.* frames between matched /ws/client and /ws/agent by session_id WITHOUT parsing payload bytes"
    - "A human-only dispatch GATE rejects automation sources (scheduler/orchestrator-background/auto-dev/error-capture) for pty-interactive sessions, composed into the shared pipeline — never bypassing the cost cap"
    - "Per-session runner_type ('stream-json'|'pty-interactive', default stream-json) is stored via idempotent DDL; a Telegram-default session cannot be switched to pty-interactive"
    - "The human-only guard gates the term.input RELAY path itself (not only dispatch/pipeline.ts); the actor is SERVER-INFERRED from the connection (cookie⇒human, api_key⇒agent), never a client-asserted source field (R-PTY-28 / H1)"
    - "Every term.input/term.attach/term.reattach is authorized server-side against the connection's own subscribed/owned session set + a DB-backed canWriteTerminal(userId, sessionId) — no cross-session/cross-user PTY hijack via forged session_id (R-PTY-29 / H2)"
    - "On /ws/agent the hub drops any term.* frame for a session_id NOT in that supervisor's advertised session_inventory — no cross-host term-frame injection (R-PTY-30 / H3)"
    - "runner_type AND backend PTY/tmux identity + transcript path/id captured at spawn are persisted per session; resume READS the persisted mode/identity so a session can't be dual-spawned or mis-routed on reconnect/restart (R-PTY-31 / H10)"
  artifacts:
    - path: "hub/src/ws/term-protocol.ts"
      provides: "Zod raw-terminal frame schema, isolated from agent-protocol"
    - path: "hub/src/dispatch/gates.ts"
      provides: "humanOnlyPtyGate (shared chokepoint) gating BOTH the dispatch pipeline AND the term.input relay path; canWriteTerminal ownership check"
  key_links:
    - from: "/ws/client term.input (server-inferred human actor + canWriteTerminal authz)"
      to: "/ws/agent term.input → claude-pty-runner.write"
      via: "session_id-keyed byte-faithful relay, gated by the shared humanOnlyPtyGate chokepoint"
      pattern: "term.* frames, no agent-protocol parse, actor inferred not asserted"
    - from: "dispatch source + session.runner_type"
      to: "humanOnlyPtyGate reject/allow"
      via: "composed gate in pipeline.ts, after/with dailyCostCapGate"
      pattern: "automation source + pty-interactive ⇒ reject"
    - from: "/ws/agent term.* frame (session_id)"
      to: "supervisor-registry session_inventory check"
      via: "drop if session_id ∉ this supervisor's advertised inventory"
      pattern: "cross-host injection rejected"
    - from: "PTY spawn (runner_type + backend transcript path/id)"
      to: "persisted session identity → resume re-binds same backend"
      via: "idempotent DDL columns; resume reads persisted mode"
      pattern: "no dual-spawn / no mis-route on restart"
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
- **T-16-10 — Relay path bypasses the human-only guard (HIGH, H1 — the load-bearing seam).** The
  `humanOnlyPtyGate` in `dispatch/pipeline.ts` does NOT cover the raw `term.input` relay: a robot writing
  bytes via the relay drives the interactive entrypoint, exactly the flagged/ToS-risk move the gate exists
  to stop. Mitigation: route `term.input` through the SAME `humanOnlyPtyGate` chokepoint (or a shared
  guard helper) BEFORE forwarding bytes; no second, ungated write route. Test: an automation/agent-sourced
  `term.input` is rejected on the relay. (R-PTY-28.)
- **T-16-11 — Client-asserted actor spoof (HIGH, H1).** If the gate trusts a `source`/actor field in the
  frame, a client claims `source: "human"` and bypasses it. Mitigation: the actor is SERVER-INFERRED from
  the connection identity — authenticated `/ws/client` opaque-cookie ⇒ `human`, `/ws/agent` api_keys ⇒
  `agent` — never read from the payload. Test: a `term.input` carrying `source: "human"` on a non-human
  connection is still rejected. (R-PTY-28.)
- **T-16-12 — Cross-session / cross-user PTY hijack via forged session_id (HIGH, H2).** A client supplies
  another user's `session_id` on `term.input`/`term.attach` and reads/injects into a PTY it does not own.
  Mitigation: server-side authz on every term frame — `session_id ∈ connection.subscribedSessions` AND a
  DB-backed `canWriteTerminal(userId, sessionId)` ownership check; reject otherwise. Test: user A cannot
  attach to / write to user B's PTY session even with a valid session of their own. (R-PTY-29.)
- **T-16-13 — Cross-host term-frame injection from /ws/agent (HIGH, H3).** A compromised/buggy supervisor
  emits `term.data` for a `session_id` it does not host, injecting output into another host's session.
  Mitigation: on `/ws/agent`, drop any `term.*` frame whose `session_id` is not in that supervisor
  connection's advertised `session_inventory` (supervisor-registry). Test: a `term.data` from supervisor X
  for supervisor Y's session is dropped. (R-PTY-30.)
- **T-16-14 — Dual-spawn on resume (HIGH, H10).** A reconnect/restart that does not read the persisted
  runner identity spawns a SECOND PTY for a session that already has one, or fails to re-bind the live one.
  Mitigation: persist runner_type + backend PTY/tmux identity + transcript path/id at spawn; resume reads
  it and re-binds the same backend (no second spawn). Test: resume reads persisted identity, no second
  spawn. (R-PTY-31.)
- **T-16-15 — Runner-mode mis-route on restart (HIGH, H10).** A pty-interactive session resumed via the
  stream-json path (or vice-versa) silently changes billing bucket / breaks the surface. Mitigation: the
  persisted `runner_type` is authoritative on resume. Test: a pty-interactive session is NOT resumed via
  the stream-json path. (R-PTY-31.)
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
  <name>Task 2: Authenticated, per-session-authorized byte-faithful relay /ws/client ↔ /ws/agent (H2 + H3)</name>
  <files>hub/src/ws/client.ts, hub/src/ws/agent.ts, hub/src/ws/supervisor-registry.ts, hub/src/dispatch/gates.ts, hub/test/term-relay-auth.test.ts, hub/test/term-agent-inventory-auth.test.ts</files>
  <read_first>
    - hub/src/ws/client.ts (opaque-cookie auth + subscribe-by-session routing; the per-conn subscribedSessions set)
    - hub/src/ws/agent.ts (api_keys-keyed agent channel)
    - hub/src/ws/supervisor-registry.ts (advertised session_inventory per supervisor — the source for the H3 check)
    - hub/src/ws/term-protocol.ts (frames to relay)
    - hub/src/dispatch/gates.ts (where canWriteTerminal(userId, sessionId) ownership helper lives/added)
  </read_first>
  <threat_model>
    - T-16-12 cross-session/cross-user hijack (HIGH, H2): forged session_id reads/injects another user's PTY → server-side subscribedSessions + DB-backed canWriteTerminal authz.
    - T-16-13 cross-host injection (HIGH, H3): supervisor emits term.* for a session it doesn't host → drop if session_id ∉ that supervisor's advertised inventory.
  </threat_model>
  <acceptance_criteria>
    - A term.input/term.attach/term.reattach frame is accepted only on an authenticated /ws/client AND only when its target session_id is in THAT connection's subscribedSessions set
    - Authorization additionally requires a DB-backed canWriteTerminal(userId, sessionId) ownership check — a client-supplied session_id for a session the user does NOT own is rejected (no PTY hijack via forged session_id)
    - The hub does NOT parse term.data/term.input payload bytes — byte-faithful passthrough
    - On /ws/agent, a term.* frame whose session_id is NOT in that supervisor connection's advertised session_inventory (supervisor-registry) is DROPPED (cross-host injection rejected)
    - A term.input on an unauthenticated or unsubscribed connection is rejected
    - term-relay-auth.test.ts includes NAMED cross-session and cross-user hijack cases: user A cannot write/attach to user B's PTY session even with their own valid session
    - term-agent-inventory-auth.test.ts asserts a term.data from supervisor X for a session hosted by supervisor Y is dropped
    - Existing structured-pipeline routing is unchanged (regression: agent-protocol tests stay green)
  </acceptance_criteria>
  <action>
    Add a term.* relay branch on both WS handlers reusing the existing auth + session-subscription
    routing. Do not introduce a new socket. Pass payload bytes through untouched. On the /ws/client
    ingress, enforce `session_id ∈ subscribedSessions` AND `canWriteTerminal(userId, sessionId)` (add the
    ownership helper in gates.ts, DB-scoped by user_id like every other query) BEFORE forwarding — reject
    a forged/foreign session_id. On the /ws/agent ingress, consult `supervisor-registry.ts` and DROP any
    term.* frame whose session_id is not in that supervisor's advertised inventory. Add the two named
    negative tests (cross-user hijack; cross-host injection). Smallest-diff: branch before the structured
    switch; reuse existing registries.
  </action>
  <verify>
    <automated>cd hub; bun test test/term-relay-auth.test.ts test/term-agent-inventory-auth.test.ts 2>$null</automated>
  </verify>
  <done>Authenticated, per-session-authorized, byte-faithful relay; cross-user hijack and cross-host injection both rejected by named tests.</done>
</task>

<task type="auto">
  <name>Task 3: Per-session runner identity — runner_type + persisted backend identity, resume reads it (idempotent DDL, no backfill) (H10)</name>
  <files>hub/src/db/schema.sql, hub/src/api/sessions.ts, hub/test/pty-runner-type.test.ts, hub/test/pty-runner-resume-identity.test.ts</files>
  <read_first>
    - hub/src/db/schema.sql (the `ADD COLUMN IF NOT EXISTS cli_kind` idempotent pattern — mirror it)
    - hub/src/api/sessions.ts (`cli_kind: z.enum(['claude','codex'])` validation to mirror; session resume/reconnect-by-project_dir path)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md (resume-by-project_dir semantics)
  </read_first>
  <threat_model>
    - T-16-14 dual-spawn on resume (HIGH, H10): resume not reading persisted identity spawns a 2nd PTY → persist + read identity, re-bind same backend.
    - T-16-15 runner-mode mis-route on restart (HIGH, H10): pty-interactive resumed as stream-json (or vice-versa) → persisted runner_type is authoritative on resume.
  </threat_model>
  <acceptance_criteria>
    - schema.sql adds `runner_type TEXT NOT NULL DEFAULT 'stream-json'` via `ADD COLUMN IF NOT EXISTS` (idempotent; re-runs safely every boot; NO data backfill in schema.sql)
    - schema.sql ALSO adds idempotent nullable columns persisting the backend PTY/tmux identity + transcript path/id captured at PTY spawn (e.g. `pty_backend_id TEXT NULL`, `transcript_path TEXT NULL` — names per CONTEXT; nullable so non-PTY rows are unaffected; NO backfill)
    - sessions API validates runner_type ∈ {'stream-json','pty-interactive'} and is opt-in per session
    - A Telegram-default session cannot be set to 'pty-interactive' (API/guard rejects); a test asserts this
    - On reconnect/restart the resume path READS the persisted runner_type + backend identity and re-binds the SAME backend — a pty-interactive session is NOT resumed via the stream-json path and is NOT dual-spawned; pty-runner-resume-identity.test.ts asserts both (resume reads persisted mode; no second spawn; persisted identity re-bound)
  </acceptance_criteria>
  <action>
    Mirror the cli_kind column + enum validation. Add the nullable backend-identity + transcript-path
    columns (idempotent `ADD COLUMN IF NOT EXISTS`, no backfill — captured/written at PTY spawn time in
    16-PLAN-001's persistence module / the supervisor handshake). Add the Telegram-default guard at the
    set-runner-type path. Make the resume/reconnect path read the persisted runner_type + identity and
    re-bind rather than re-decide (no dual-spawn, no mis-route). Add pty-runner-resume-identity.test.ts.
    Any one-shot migration of existing rows (none needed; defaults/nullable apply) goes in hub/scripts/,
    never schema.sql.
  </action>
  <verify>
    <automated>cd hub; bun test test/pty-runner-type.test.ts test/pty-runner-resume-identity.test.ts 2>$null</automated>
    `grep -n "ADD COLUMN IF NOT EXISTS runner_type" hub/src/db/schema.sql` returns a hit; the backend-identity/transcript-path columns also use `ADD COLUMN IF NOT EXISTS`.
  </verify>
  <done>Per-session runner type + backend identity persisted, opt-in, idempotent; resume reads persisted mode (no dual-spawn / no mis-route); Telegram-default stays stream-json.</done>
</task>

<task type="auto">
  <name>Task 4: humanOnlyPtyGate as a SHARED chokepoint — gates the dispatch pipeline AND the term.input relay; server-inferred actor (H1)</name>
  <files>hub/src/dispatch/gates.ts, hub/src/dispatch/pipeline.ts, hub/src/ws/client.ts, hub/test/human-only-guard.test.ts, hub/test/term-relay-human-guard.test.ts</files>
  <read_first>
    - hub/src/dispatch/gates.ts (dailyCostCapGate / isOverCostCap — compose alongside, do not bypass)
    - hub/src/dispatch/pipeline.ts (how gates are composed; the dispatch source field)
    - hub/src/ws/client.ts (the term.input relay ingress — where the actor is inferred from the authenticated connection, NOT the payload)
  </read_first>
  <threat_model>
    - T-16-10 relay bypasses human guard (HIGH, H1): robot writes bytes via the relay → route term.input through the SAME humanOnlyPtyGate chokepoint, not only dispatch/pipeline.ts.
    - T-16-11 client-asserted actor spoof (HIGH, H1): client claims source:"human" → actor SERVER-INFERRED from connection (cookie⇒human, api_key⇒agent), never from payload.
  </threat_model>
  <acceptance_criteria>
    - A new humanOnlyPtyGate (shared helper) rejects writes whose actor/source ∈ automation {scheduler, orchestrator-background, auto-dev, error-capture, agent} when the target session.runner_type = 'pty-interactive'
    - The SAME gate (shared chokepoint) is applied to BOTH (a) the dispatch pipeline AND (b) the term.input relay ingress in client.ts — there is NO second, ungated write route into a PTY session
    - On the relay path the actor is SERVER-INFERRED from the connection identity: authenticated /ws/client opaque-cookie ⇒ human; /ws/agent api_keys ⇒ agent. A client-asserted `source`/actor field in the frame is IGNORED for the decision
    - A genuine interactive human turn (human connection) to a pty-interactive session is ALLOWED on both paths
    - Automation to a stream-json session is UNCHANGED (still cost-capped)
    - The gate composes into the shared pipeline; the non-bypassable dailyCostCapGate still applies (no new uncapped route)
    - human-only-guard.test.ts asserts reject-per-automation-source (dispatch path), allow-human, and cost-cap-still-applies
    - term-relay-human-guard.test.ts (NAMED) asserts: an automation/agent-originated term.input is rejected ON THE RELAY; a frame carrying client-asserted `source:"human"` on a non-human connection is STILL rejected; a genuine human-connection term.input is forwarded
  </acceptance_criteria>
  <action>
    Add humanOnlyPtyGate keyed on (actor, session.runner_type) as a SHARED helper in gates.ts. Compose it
    in pipeline.ts alongside the cost-cap gate (dispatch path), reading the dispatch source from the
    existing dispatch context. ALSO call the same gate at the term.input relay ingress in client.ts, with
    the actor SERVER-INFERRED from the connection (human for the authenticated cookie connection) — never
    from a payload field. Do NOT create a parallel dispatch path and do NOT leave the relay as an ungated
    second route. Add both tests.
  </action>
  <verify>
    <automated>cd hub; bun test test/human-only-guard.test.ts test/term-relay-human-guard.test.ts 2>$null</automated>
  </verify>
  <done>Automation can never drive a PTY session via EITHER the dispatch pipeline OR the term.input relay; the actor is server-inferred (spoof-proof); human turns pass; cost cap intact.</done>
</task>

</tasks>

<verification>
- term-protocol.ts has zero agent-protocol/RunnerEvent coupling (grep + isolation test)
- Unauthenticated term.input rejected; authenticated relay is byte-faithful
- Cross-session/cross-user PTY hijack via forged session_id is rejected (term-relay-auth.test.ts named cases — H2/R-PTY-29)
- Cross-host term-frame injection on /ws/agent is dropped against the supervisor's advertised inventory (term-agent-inventory-auth.test.ts — H3/R-PTY-30)
- Automation/agent term.input is rejected ON THE RELAY path; client-asserted source:"human" cannot bypass the server-inferred actor (term-relay-human-guard.test.ts — H1/R-PTY-28)
- Every automation source rejected for pty-interactive on the dispatch path; human interactive allowed; cost cap unaffected
- schema.sql runner_type + nullable backend-identity/transcript-path columns are idempotent `ADD COLUMN IF NOT EXISTS`, no backfill; resume reads persisted mode — no dual-spawn / no mis-route (pty-runner-resume-identity.test.ts — H10/R-PTY-31)
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
