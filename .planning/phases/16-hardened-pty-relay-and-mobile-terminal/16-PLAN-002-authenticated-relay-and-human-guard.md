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
  - tools/emit-phase16-verdict.mjs
  - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md
  - hub/test/phase16-verdict-artifact.test.ts
  - tools/regression-baseline.json
autonomous: true
requirements:
  - R-PTY-08
  - R-PTY-10
  - R-PTY-11
  - R-PTY-28
  - R-PTY-29
  - R-PTY-30
  - R-PTY-31
  - R-PTY-32
  - R-PTY-33
  - R-PTY-34
  - R-PTY-35
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
  <files>hub/src/ws/client.ts, hub/src/ws/agent.ts, hub/src/ws/supervisor-registry.ts, hub/src/dispatch/gates.ts, hub/test/term-relay-auth.test.ts, hub/test/term-agent-inventory-auth.test.ts, hub/test/term-frame-direction-allowlist.test.ts, hub/test/term-ws-origin-guard.test.ts</files>
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
    - T-16-18 frame-direction confusion (HIGH, NH-2): an inventory-valid /ws/agent socket sends a `term.input` (a WRITE), turning the supervisor channel into an unguarded input path into a human PTY. Mitigation: each socket allowlists frame DIRECTION by role — `term.input` (client→PTY write) is accepted ONLY on /ws/client, NEVER on /ws/agent; supervisor→hub terminal frames are OUTPUT-ONLY (`term.data`); a `term.input` arriving on /ws/agent is rejected before any forward.
    - T-16-19 CSWSH / forged-Origin cookie ride (HIGH, NH-3): the `cookie ⇒ human` actor inference treats ANY authenticated browser WS as human; a cross-site WebSocket handshake that rides the user's cookie could drive PTY input as "human". Mitigation: the /ws/client handshake enforces an Origin/CSRF-for-WebSocket check (Origin ∈ HUB_ALLOWED_ORIGINS) and rejects a cross-site/disallowed-Origin handshake BEFORE the connection is treated as a human actor.
    - T-16-20 inventory self-assertion (HIGH, NH-1): the H3 drop-check trusts the supervisor's OWN advertised `session_inventory`; a compromised/buggy supervisor advertises a victim's session_id and passes H3. Mitigation: cross-validate an inventory-claimed session against the DB record of which host legitimately owns it (sessions.hostname / the persisted supervisor identity) before treating that host as authoritative — a host claiming a session it does not own per the DB is dropped even if it appears in the self-asserted inventory.
  </threat_model>
  <acceptance_criteria>
    - A term.input/term.attach/term.reattach frame is accepted only on an authenticated /ws/client AND only when its target session_id is in THAT connection's subscribedSessions set
    - Authorization additionally requires a DB-backed canWriteTerminal(userId, sessionId) ownership check — a client-supplied session_id for a session the user does NOT own is rejected (no PTY hijack via forged session_id)
    - The hub does NOT parse term.data/term.input payload bytes — byte-faithful passthrough
    - FRAME-DIRECTION ALLOWLIST (NH-2): each socket allowlists message direction by role — `term.input` is accepted ONLY on /ws/client (client→PTY write), NEVER on /ws/agent; /ws/agent terminal frames are OUTPUT-ONLY (`term.data`). A `term.input` frame injected on /ws/agent is REJECTED before any forward. `term-frame-direction-allowlist.test.ts` (NAMED) asserts a `term.input` on /ws/agent is rejected and `term.data` on /ws/client (server→client direction injected by a client) is likewise rejected.
    - ORIGIN/CSWSH ENFORCEMENT (NH-3): the /ws/client handshake enforces an Origin/CSRF-for-WebSocket check (Origin ∈ HUB_ALLOWED_ORIGINS); a cross-site/disallowed-Origin handshake is REJECTED at handshake time so a forged-origin socket cannot ride the cookie to drive the human PTY. `term-ws-origin-guard.test.ts` (NAMED) asserts a disallowed-Origin handshake is rejected and an allowed-Origin one proceeds.
    - INVENTORY CROSS-VALIDATION (NH-1): on /ws/agent, before treating a host as authoritative for a session, the hub cross-validates the inventory-claimed session_id against the DB host-ownership record (sessions.hostname / persisted supervisor identity) — a host advertising a session it does not legitimately own per the DB is DROPPED even if the session_id is present in its self-asserted `session_inventory`. `term-agent-inventory-auth.test.ts` is extended (NAMED case) so a SPOOFED inventory entry for a non-owned session is dropped (not just a session absent from the inventory).
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
    a forged/foreign session_id. Add the per-socket DIRECTION allowlist (NH-2): the /ws/client handler
    accepts only client→server write frames (`term.input`/`term.attach`/`term.reattach`/`term.resize`) and
    the /ws/agent handler accepts only server→client output (`term.data`) — reject any out-of-direction
    frame before forwarding. Enforce the Origin/CSWSH check (NH-3) at the /ws/client handshake against
    HUB_ALLOWED_ORIGINS (reuse the existing origin allowlist). On the /ws/agent ingress, consult
    `supervisor-registry.ts` AND cross-validate against DB host-ownership (NH-1) and DROP any term.* frame
    whose session_id is absent from the advertised inventory OR not legitimately owned by that host per the
    DB. Add the named negative tests (cross-user hijack; cross-host injection incl. the SPOOFED-inventory
    case; frame-direction; origin guard). Smallest-diff: branch before the structured switch; reuse existing
    registries + origin allowlist.
  </action>
  <verify>
    <automated>cd hub; bun test test/term-relay-auth.test.ts test/term-agent-inventory-auth.test.ts test/term-frame-direction-allowlist.test.ts test/term-ws-origin-guard.test.ts 2>$null</automated>
  </verify>
  <done>Authenticated, per-session-authorized, byte-faithful, DIRECTION-allowlisted relay with CSWSH/Origin enforcement and DB-cross-validated inventory; cross-user hijack, cross-host injection (incl. spoofed inventory), wrong-direction frames, and forged-origin sockets all rejected by named tests.</done>
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

<shared_verdict_artifact_schema>
SINGLE SOURCE OF TRUTH for the Phase-16 → Phase-17 producer/consumer contract (H11/NH-4). This task is the
PRODUCER; `tools/cutover-deletion-gate.mjs` (Phase 17 / 17-PLAN-002 T1) is the CONSUMER. Both reference THIS
block by its anchor (`16-PLAN-002 §shared_verdict_artifact_schema`). Field names + path are pinned here and
MUST NOT be redefined elsewhere — neither side hardcodes a divergent shape.

Path (FIXED): `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md`
Format: YAML frontmatter. Required keys:

```yaml
verdict: PASS            # PASS | PARTIAL | FAIL  (top-level ship verdict)
render_fidelity: PASS    # PASS | FAIL  (manual, attested)
mobile_reattach: PASS    # PASS | FAIL  (manual, attested)
automated_suite:         # TEST-BOUND — written from real exit code, not retypeable
  result: PASS           # PASS | FAIL
  command: "bun run check-baseline"
  summary: "771/900 ..." # captured verbatim from the run
  run_at: "2026-05-31T18:04:00Z"
term_relay_auth:         # TEST-BOUND — named relay/auth/guard tests' real exit codes
  result: PASS           # PASS | FAIL
  tests: [term-relay-auth, term-relay-human-guard, term-agent-inventory-auth,
          term-frame-direction-allowlist, term-ws-origin-guard, pty-runner-resume-identity]
  run_at: "2026-05-31T18:04:10Z"
manual_attestation:      # structured — NOT a bare PASS token
  render_fidelity: { by: "MM", at: "2026-05-31T18:10:00Z", device_build: "Pixel8/Chrome125 build 0.9.0" }
  mobile_reattach: { by: "MM", at: "2026-05-31T18:12:00Z", device_build: "Pixel8/Chrome125 build 0.9.0" }
```

GATE-PASS RULE (consumed by cutover-deletion-gate.mjs): exit 0 ONLY when
`verdict==PASS` AND `render_fidelity==PASS` AND `mobile_reattach==PASS` AND
`automated_suite.result==PASS` AND `term_relay_auth.result==PASS` AND each `manual_attestation.<field>`
carries a complete `{by, at, device_build}` triplet. Missing file / any FAIL / absent provenance block /
incomplete attestation triplet ⇒ non-zero (abort, zero deletions). The triplet requirement is what makes a
hand-typed `PASS` non-forgeable: a bare `render_fidelity: PASS` with no matching attestation triplet FAILS
the gate's provenance check.
</shared_verdict_artifact_schema>

<task type="auto">
  <name>Task 5: EMIT the test-bound Phase-16 ship-verdict artifact `16-VERIFICATION.md` (producer for the Phase-17 cutover gate — H11/NH-4)</name>
  <files>tools/emit-phase16-verdict.mjs, .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md, tools/regression-baseline.json, hub/test/phase16-verdict-artifact.test.ts</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VALIDATION.md (the Manual-Only Verifications rows for R-PTY-07 reattach + R-PTY-09 mobile — the two manual proofs the gate's `mobile_reattach`/`render_fidelity` fields attest)
    - THIS plan's §shared_verdict_artifact_schema block (the SINGLE SOURCE OF TRUTH for the field names + path + gate-pass rule; the Phase-17 gate parses the SAME schema by reference, not a re-definition)
    - tools/cutover-deletion-gate.mjs is the CONSUMER of this artifact (Phase 17 / 17-PLAN-002 T1) — field names + path MUST match byte-for-byte
    - tools/regression-baseline.json (per-file isolation registration)
  </read_first>
  <threat_model>
    - T-16-16 forged/hand-edited verdict re-opens the manual wave-through H4/H11 killed (HIGH): a human hand-types `verdict: PASS` / `render_fidelity: PASS` so the rip unlocks without a real run. Mitigation: the artifact is EMITTED by a script (`emit-phase16-verdict.mjs`), NEVER hand-authored; the two test-derived signals (`automated_suite`, `term_relay_auth`) are written DIRECTLY from `bun run check-baseline` / the named-test exit codes (not retypeable); the two manual signals (`render_fidelity`, `mobile_reattach`) are captured as a STRUCTURED attestation — operator initials + ISO-8601 timestamp + the device/build string — not a bare `PASS` token, and the emit script REFUSES to write a manual PASS unless the attestation triplet is supplied (so a blank/forged `PASS` is not expressible). A verdict whose `automated_suite`/`term_relay_auth` PASS is not backed by the recorded test-run summary fails the gate's provenance assert.
    - T-16-17 producer/consumer drift (HIGH): Phase-16 emits one field shape, Phase-17 gate parses another → gate always-aborts (permablock) or gets hand-waved. Mitigation: ONE schema defined in the SPEC, referenced by BOTH this task and 17-PLAN-002 T1; `phase16-verdict-artifact.test.ts` asserts the emitted artifact validates against the SAME schema the gate consumes (round-trips through `cutover-deletion-gate.mjs` → exit 0 on a real-run fixture).
  </threat_model>
  <acceptance_criteria>
    - `tools/emit-phase16-verdict.mjs` is a standalone Node ESM script (no deps) that WRITES `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md` conforming to the SHARED VERDICT-ARTIFACT SCHEMA (defined ONCE in interactive-pty-runner-SPEC.md, referenced here and by the Phase-17 gate). The artifact carries YAML frontmatter with EXACTLY these keys: `verdict` (∈ PASS|PARTIAL|FAIL), `render_fidelity` (PASS|FAIL), `mobile_reattach` (PASS|FAIL), plus provenance blocks: `automated_suite: { result: PASS|FAIL, command, summary, run_at }`, `term_relay_auth: { result: PASS|FAIL, tests: [...], run_at }`, and `manual_attestation: { render_fidelity: {by, at, device_build}, mobile_reattach: {by, at, device_build} }`.
    - TEST-BOUND provenance (not hand-typed): the script DERIVES `automated_suite.result` from the ACTUAL exit code of `bun run check-baseline` and `term_relay_auth.result` from the ACTUAL exit codes of the named relay tests (`term-relay-auth.test.ts`, `term-relay-human-guard.test.ts`, `term-agent-inventory-auth.test.ts`, `pty-runner-resume-identity.test.ts`), capturing their summary lines verbatim — it does NOT accept these as CLI args. If any required suite is red the script writes `verdict: FAIL` (or refuses to write a PASS).
    - ATTESTED-but-structured manual fields: `render_fidelity`/`mobile_reattach` PASS are written ONLY when the operator supplies the full attestation triplet (initials + ISO-8601 timestamp + device/build string) for that field; a missing/partial triplet ⇒ that field is written `FAIL` (or omitted), which the gate treats as abort. A bare `PASS` with no triplet is NOT expressible through the script.
    - `verdict: PASS` is emitted ONLY when both automated signals are PASS AND both manual attestations are complete-and-PASS; otherwise `PARTIAL`/`FAIL`.
    - The EMITTED `16-VERIFICATION.md` validates against the SAME schema `tools/cutover-deletion-gate.mjs` parses: `phase16-verdict-artifact.test.ts` round-trips a script-emitted fully-green fixture through the gate and asserts exit 0, and asserts a hand-edited artifact missing a provenance block is REJECTED by the gate's provenance check (detectable forgery).
    - The path `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VERIFICATION.md` and the field names are IDENTICAL to those pinned in 17-PLAN-002 T1 (no drift); the test is registered in tools/regression-baseline.json.
  </acceptance_criteria>
  <action>
    Author `emit-phase16-verdict.mjs` to RUN the automated suites itself (or read an immutable run-summary
    file the check-baseline step writes), derive the two automated PASS/FAIL signals from real exit codes,
    require the manual-attestation triplet for each manual field, and write `16-VERIFICATION.md` in the
    SHARED schema. The schema is pinned ONCE in THIS plan's §shared_verdict_artifact_schema (single source);
    both this producer and the Phase-17 gate reference that anchor so they can't drift. Add `phase16-verdict-artifact.test.ts`
    proving the emitted artifact passes the real gate and a forged/provenance-stripped one is rejected. This
    task runs LAST in Phase 16 (after every other task is green) so the artifact reflects the true phase
    state. Register the new test in the baseline.
  </action>
  <verify>
    <automated>cd hub; bun test test/phase16-verdict-artifact.test.ts 2>$null</automated>
    The emitted `16-VERIFICATION.md` exists with the pinned keys; piping it through `node tools/cutover-deletion-gate.mjs` exits 0 only on a fully-green emit.
  </verify>
  <done>Phase 16 EMITS the exact verdict artifact the Phase-17 gate consumes, with the PASS evidence bound to real test-run output + structured manual attestations — a hand-edited/forged artifact is detectable, closing the producer/consumer gap (H11/NH-4) so the gate neither permablocks nor gets hand-waved.</done>
</task>

</tasks>

<verification>
- term-protocol.ts has zero agent-protocol/RunnerEvent coupling (grep + isolation test)
- Unauthenticated term.input rejected; authenticated relay is byte-faithful
- Cross-session/cross-user PTY hijack via forged session_id is rejected (term-relay-auth.test.ts named cases — H2/R-PTY-29)
- Cross-host term-frame injection on /ws/agent is dropped against the supervisor's advertised inventory AND a spoofed-inventory entry for a non-owned session is dropped via DB host-ownership cross-validation (term-agent-inventory-auth.test.ts — H3/R-PTY-30, NH-1/R-PTY-35)
- `term.input` is accepted ONLY on /ws/client (write) and rejected on /ws/agent; /ws/agent is output-only `term.data` — per-socket frame-direction allowlist (term-frame-direction-allowlist.test.ts — NH-2/R-PTY-33)
- A disallowed/cross-site Origin WS handshake on /ws/client is rejected (CSWSH) so a forged-origin socket can't ride the cookie to drive the human PTY (term-ws-origin-guard.test.ts — NH-3/R-PTY-34)
- Phase 16 EMITS `16-VERIFICATION.md` in the shared verdict-artifact schema with test-bound provenance; a script-emitted fully-green artifact passes the Phase-17 gate and a forged/provenance-stripped one is rejected (phase16-verdict-artifact.test.ts — H11·NH-4/R-PTY-32)
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
