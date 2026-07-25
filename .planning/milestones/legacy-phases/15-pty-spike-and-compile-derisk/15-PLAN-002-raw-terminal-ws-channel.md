---
phase: 15-pty-spike-and-compile-derisk
plan: 02
type: execute
wave: 2
depends_on:
  - 15-01
files_modified:
  - hub/src/ws/term-protocol.ts
  - hub/src/ws/agent.ts
  - hub/src/ws/client.ts
  - supervisor/src/index.ts
  - hub/test/term-channel-isolation.test.ts
  - supervisor/test/pty-byte-relay.test.ts
autonomous: true
requirements:
  - R-PTY-02
  - R-PTY-03
must_haves:
  truths:
    - "A dedicated raw-terminal frame schema (term.data / term.input / term.resize / term.attach) exists in its OWN module, NOT in agent-protocol.ts"
    - "The hub relays term.* frames between matched /ws/client and /ws/agent keyed by session_id, forwarding payload bytes without parsing them as RunnerEvents"
    - "Typed input from the client reaches the PTY; PTY output bytes reach the client — round-trip proven"
    - "The terminal path has zero RunnerEvent coupling (static assertion)"
  artifacts:
    - path: "hub/src/ws/term-protocol.ts"
      provides: "Zod schema for raw-terminal frames, separate from agent-protocol.ts"
    - path: "supervisor/test/pty-byte-relay.test.ts"
      provides: "Input-injection / output-byte round-trip proof"
  key_links:
    - from: "web client term.input frame"
      to: "claude-pty-runner.write(bytes)"
      via: "hub relay /ws/client to /ws/agent, keyed by session_id"
      pattern: "term.input"
---

<objective>
Add a NEW raw-terminal WS channel — a small frame set (`term.data`, `term.input`, `term.resize`,
`term.attach`) carried over the existing WS connections but validated by its OWN schema and relayed
byte-faithfully by the hub — completely isolated from the structured `/ws/agent` RunnerEvent to
agent-protocol pipeline. Wire it to the Plan-01 PTY runner so a typed turn reaches the PTY and PTY output
reaches the browser.

Purpose: proves the transport seam the whole milestone depends on (R-PTY-03 isolation; R-PTY-02 byte
relay) without contaminating the structured pipeline.

Output: a working two-hop byte relay (client to hub to supervisor PTY and back) + isolation test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-CONTEXT.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-01-SUMMARY.md
@hub/src/ws/agent.ts
@hub/src/ws/client.ts
@hub/src/ws/protocol.ts
@hub/src/ws/agent-protocol.ts
@supervisor/src/index.ts
@supervisor/src/runners/claude-pty-runner.ts
@CLAUDE.md

<interfaces>
From hub/src/ws: structured pipeline lives in agent.ts + agent-protocol.ts (supervisor to hub) and
client.ts + protocol.ts (hub to browser). Both Zod-validated. Subscription routing is keyed by
session_id (multi session_ids cap 12). The new term.* frames reuse the SAME sockets + session keying but
a SEPARATE schema; the hub must forward term.* without running them through agent-protocol.
</interfaces>
</context>

<threat_model>
- **T-15-03 — pipeline contamination (MEDIUM).** If term.* frames are validated/parsed by
  agent-protocol.ts or translated to RunnerEvent, the isolation invariant breaks and a later refactor
  could route raw terminal bytes into the persisted-message path. Mitigation: separate schema module +
  static isolation test asserting no RunnerEvent import on the terminal path.
- **T-15-04 — unauthenticated terminal attach (HIGH).** A raw-terminal channel that bypasses the
  existing opaque-cookie auth would expose a live shell-adjacent TUI. Mitigation: term.* frames ride the
  ALREADY-authenticated /ws/client and /ws/agent connections (auth handshake unchanged); the hub only
  relays term.* for a session the connection is authorized to subscribe to. (Full hardening is Phase 16;
  the spike must still not relay across auth boundaries.)
Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: term-protocol.ts — raw-terminal frame schema (isolated from agent-protocol)</name>
  <files>hub/src/ws/term-protocol.ts</files>
  <read_first>
    - hub/src/ws/agent-protocol.ts (Zod style to mirror — do NOT add term frames here)
    - hub/src/ws/protocol.ts (client message shapes)
  </read_first>
  <acceptance_criteria>
    - term-protocol.ts exports Zod schemas for: term.data {session_id, bytes:base64}, term.input {session_id, bytes:base64}, term.resize {session_id, cols, rows}, term.attach {session_id}
    - term-protocol.ts does NOT import agent-protocol.ts and does NOT reference the RunnerEvent union
    - `bun run tsc --noEmit` green for hub
  </acceptance_criteria>
  <action>
    Create `hub/src/ws/term-protocol.ts` with a discriminated-union Zod schema on a `kind` field
    (`term.data`/`term.input`/`term.resize`/`term.attach`). Payload bytes carried as base64 strings (or
    binary frames — pick smallest credible; base64 over the existing JSON WS is simplest for the spike).
    Keep it standalone: no import of agent-protocol.ts, no RunnerEvent reference.
  </action>
  <verify>
    <automated>cd hub; bun run tsc --noEmit 2>$null</automated>
    `grep -nE "agent-protocol|RunnerEvent" hub/src/ws/term-protocol.ts` returns NOTHING.
  </verify>
  <done>Standalone raw-terminal frame schema exists, isolated from the structured pipeline.</done>
</task>

<task type="auto">
  <name>Task 2: Hub relay of term.* frames between client and agent</name>
  <files>hub/src/ws/agent.ts, hub/src/ws/client.ts</files>
  <read_first>
    - hub/src/ws/agent.ts (how supervisor frames are received + how session_id routing works)
    - hub/src/ws/client.ts (how browser subscriptions + per-conn routing work)
    - hub/src/ws/term-protocol.ts (just created)
  </read_first>
  <acceptance_criteria>
    - A term.input frame from an authorized /ws/client is forwarded to the /ws/agent connection hosting that session_id
    - A term.data frame from /ws/agent is forwarded to the subscribed /ws/client(s) for that session_id
    - term.* frames are NOT passed through agent-protocol validation/translation and do NOT create persisted messages
    - The relay only forwards term.* for sessions the connection is authorized to access (reuse existing subscribe authorization)
  </acceptance_criteria>
  <action>
    In agent.ts and client.ts, add an early branch: if an inbound frame parses as a term-protocol frame,
    relay it to the counterpart connection(s) keyed by session_id using the EXISTING subscription/registry
    routing, then return — do NOT fall through to the agent-protocol handler. Reuse existing
    authorization checks (a client may only send/receive term.* for sessions it is subscribed to / owns).
    Smallest-diff: branch before the structured-message switch; do not refactor the existing pipeline.
  </action>
  <verify>
    <automated>cd hub; bun run tsc --noEmit 2>$null; bun test test/mount-order.test.ts 2>$null</automated>
    Manual: with a running hub, a term.input sent on /ws/client arrives on the matching /ws/agent (log trace), and term.data flows back. No new rows appear in `messages` for term.* traffic.
  </verify>
  <done>Hub relays raw-terminal frames byte-faithfully, isolated from the structured pipeline.</done>
</task>

<task type="auto">
  <name>Task 3: Wire the PTY runner to the term channel in the supervisor (spike wiring)</name>
  <files>supervisor/src/index.ts</files>
  <read_first>
    - supervisor/src/index.ts (how runners are hosted per session + how it sends/receives on /ws/agent)
    - supervisor/src/runners/claude-pty-runner.ts (the start/write/resize/kill surface)
    - hub/src/ws/term-protocol.ts (frame shapes the supervisor emits/consumes)
  </read_first>
  <acceptance_criteria>
    - For a session flagged PTY-interactive (spike: a hard-coded/opt-in flag is acceptable), the supervisor starts claude-pty-runner and forwards pty.onData bytes out as term.data frames
    - Inbound term.input frames call runner.write(bytes); term.resize calls runner.resize(cols, rows)
    - This path does NOT instantiate ClaudeRunner (stream-json) for that session and does NOT emit RunnerEvents for it
  </acceptance_criteria>
  <action>
    In supervisor/src/index.ts, add a minimal PTY session path: when a session is marked PTY-interactive
    (spike may gate behind an env/config flag or an explicit term.attach), instantiate the Plan-01 PTY
    runner instead of ClaudeRunner, bridge `onData` to a `term.data` frame on /ws/agent, and route inbound
    `term.input`/`term.resize` to the runner. Keep it additive and behind the flag — do NOT alter the
    existing stream-json session path. (Full per-session runner-type selection is Phase 16.)
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    Manual round-trip covered by Task 4's test + the manual TUI check in Plan 03.
  </verify>
  <done>Supervisor hosts a PTY-interactive session and bridges it to the term channel, additive only.</done>
</task>

<task type="auto">
  <name>Task 4: Isolation test + byte-relay round-trip test</name>
  <files>hub/test/term-channel-isolation.test.ts, supervisor/test/pty-byte-relay.test.ts</files>
  <read_first>
    - hub/src/ws/term-protocol.ts, hub/src/ws/agent.ts, hub/src/ws/client.ts
    - supervisor/src/runners/claude-pty-runner.ts
    - supervisor/test/no-legacy-agent-spawn.test.ts (grep-test style)
  </read_first>
  <acceptance_criteria>
    - term-channel-isolation.test.ts asserts: term-protocol.ts has no agent-protocol/RunnerEvent import, and the relay branch in agent.ts/client.ts returns before the agent-protocol handler for term.* frames
    - pty-byte-relay.test.ts spawns the PTY runner against a harmless echo-style command (or a stubbed pty) and asserts write(input) results in onData output containing the input bytes
    - Both exit 0 under bun test and are registered in the baseline
  </acceptance_criteria>
  <action>
    Create `hub/test/term-channel-isolation.test.ts` — static grep assertions that term-protocol.ts does
    not import agent-protocol/RunnerEvent, plus an assertion that the term relay short-circuits (e.g.
    the handler source contains an early `return` in the term.* branch). Create
    `supervisor/test/pty-byte-relay.test.ts` — to avoid a hard dependency on a real `claude` login in CI,
    parametrize the PTY runner's command for the test (spawn `node -e "process.stdin.pipe(process.stdout)"`
    or platform echo) and assert input bytes round-trip via onData. Run `bun run check-baseline`; register
    new files.
  </action>
  <verify>
    <automated>cd hub; bun test test/term-channel-isolation.test.ts 2>$null; cd ../supervisor; bun test test/pty-byte-relay.test.ts 2>$null</automated>
    Both exit 0. `bun run check-baseline` green from repo root.
  </verify>
  <done>Isolation invariant and byte round-trip are both test-enforced.</done>
</task>

</tasks>

<verification>
- term-protocol.ts is standalone (no agent-protocol/RunnerEvent import) — grep + test
- term.input to/from PTY round-trips (test)
- No `messages` rows created by term.* traffic (manual log/db check)
- `bun run check-baseline` green
</verification>

<success_criteria>
A working, authenticated-by-inheritance raw-terminal byte relay exists end-to-end (client to hub to PTY
and back), provably isolated from the structured agent-protocol pipeline. Plan 03 renders it.
</success_criteria>

<output>
Create `.planning/phases/15-pty-spike-and-compile-derisk/15-02-SUMMARY.md` when done.
</output>
