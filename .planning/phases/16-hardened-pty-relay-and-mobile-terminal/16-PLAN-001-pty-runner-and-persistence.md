---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supervisor/src/runners/claude-pty-runner.ts
  - supervisor/src/runners/pty-persistence.ts
  - supervisor/test/no-api-key-no-streamjson-pty.test.ts
  - supervisor/test/pty-runner-env.test.ts
  - supervisor/test/pty-reattach-persistence.test.ts
autonomous: false
requirements:
  - R-PTY-06
  - R-PTY-07
  - R-PTY-27
must_haves:
  truths:
    - "claude-pty-runner.ts spawns interactive `claude` in node-pty with NO -p/--print/--input-format/--output-format and deletes ANTHROPIC_API_KEY from the spawned env"
    - "The runner is raw-bytes-only: it does NOT import RunnerEvent, agent-protocol, or session-bridge, and never reads ~/.claude/.credentials.json"
    - "The PTY process is owned by the supervisor (not the client WS), so a dropped client connection does NOT kill the session"
    - "A reattach restores live state with the last-N lines of scrollback intact (tmux on POSIX where available; supervisor-owned persistent PTY + output ring-buffer as the cross-platform baseline)"
    - "The extended canary fails the build if a programmatic flag or a live ANTHROPIC_API_KEY appears on the PTY path"
  artifacts:
    - path: "supervisor/src/runners/claude-pty-runner.ts"
      provides: "Hardened interactive-claude PTY runner (raw bytes; lifecycle; resize; scrollback hooks)"
    - path: "supervisor/src/runners/pty-persistence.ts"
      provides: "Disconnect-survival + scrollback replay (persistent PTY + ring-buffer; tmux on POSIX)"
    - path: "supervisor/test/pty-reattach-persistence.test.ts"
      provides: "Proof a dropped connection reattaches with scrollback intact"
  key_links:
    - from: "claude-pty-runner.ts spawn site"
      to: "node-pty.spawn('claude', [], { env })"
      via: "env with ANTHROPIC_API_KEY deleted, argv with no programmatic flags"
      pattern: "delete (env as any).ANTHROPIC_API_KEY"
    - from: "client WS disconnect"
      to: "pty-persistence keeps PTY alive + buffers output"
      via: "supervisor-owned PTY lifecycle, not WS-scoped"
      pattern: "ring-buffer replay on term.reattach"
---

<objective>
Promote the Phase-15 spike seed into a hardened, persistent `claude-pty-runner.ts`: interactive `claude`
in a node-pty PTY (no API key, no programmatic flags, raw bytes only) with a robust lifecycle, and make
the session SURVIVE a dropped phone/browser connection — reattach restores live state with scrollback
intact. tmux on POSIX where available; a supervisor-owned persistent PTY + output ring-buffer is the
cross-platform (Windows dev host) baseline. Lock the no-API-key / no-stream-json invariants behind the
extended Phase-15 canary so they cannot regress.

Output: a production-grade PTY runner + persistence module, plus green canary/env/reattach tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-RESEARCH.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@supervisor/src/runners/claude-runner.ts
@supervisor/src/runners/types.ts
@supervisor/test/no-legacy-agent-spawn.test.ts
@CLAUDE.md

<interfaces>
From supervisor/src/runners/claude-runner.ts (current):
- Programmatic argv: `['claude','--input-format','stream-json','--output-format','stream-json','--verbose']` (lines 79-84) — the PTY runner uses NONE of these.
- Env strip: `const env = { ...process.env }; delete (env as any).ANTHROPIC_API_KEY` (line ~94) — copied verbatim.
From the Phase-15 seed (claude-pty-runner.ts): start({cwd,cols,rows,onData}), write(bytes), resize(cols,rows), kill().
From supervisor/test/no-legacy-agent-spawn.test.ts: recursive-grep canary pattern with exclude-self.
</interfaces>
</context>

<threat_model>
- **T-16-01 — Programmatic-flag leak (HIGH).** If the hardened runner's argv ever includes
  `-p`/`--print`/`--input-format stream-json`, the interactive session becomes a programmatic client and
  bills the credit pool / risks the ToS line. Mitigation: the extended Phase-15 canary greps the runner
  for forbidden tokens and fails the build.
- **T-16-02 — API-key billing (HIGH).** If `ANTHROPIC_API_KEY` survives in the spawned env, the client
  may bill API rates (constraint 1). Mitigation: explicit `delete` + env unit test inspecting the object
  passed to node-pty.
- **T-16-03 — OAuth token reuse (HIGH, design-level).** The runner spawns the official `claude` only;
  never reads/stores/forwards `~/.claude/.credentials.json`, never imports oauth-poll internals.
  Mitigation: static grep test asserts no credentials/oauth-poll import.
- **T-16-04 — Persistence resource leak / orphan PTY (MEDIUM, H7 / R-PTY-27).** A supervisor-owned PTY
  that outlives every client could leak processes; a crashed supervisor could leave a detached PTY
  orphaned. Mitigation: an EXPLICIT detach-vs-kill policy — client disconnect DETACHES (PTY survives),
  while session close / idle-reap / supervisor shutdown (SIGINT/SIGTERM/exit) KILL it — backed by
  idle-teardown integration (reuse `hub/src/ws/idle-teardown.ts` semantics), a bounded ring-buffer, and a
  parent-PID dead-man's-switch; a killed/exited PTY is reaped. A test asserts no orphan after
  close/idle/shutdown and survival after a mere disconnect. Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Harden claude-pty-runner.ts (lifecycle, resize, scrollback hooks) — still raw-bytes-only</name>
  <files>supervisor/src/runners/claude-pty-runner.ts</files>
  <read_first>
    - supervisor/src/runners/claude-pty-runner.ts (the Phase-15 seed)
    - supervisor/src/runners/claude-runner.ts (env-strip line to keep verbatim)
    - supervisor/src/runners/types.ts (align naming; do NOT reuse RunnerEvent)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md (locked decisions)
  </read_first>
  <acceptance_criteria>
    - The runner spawns via node-pty with file `claude` and argv containing NONE of: `-p`, `--print`, `--input-format`, `--output-format`
    - env built as `{ ...process.env }` then `delete env.ANTHROPIC_API_KEY`
    - Exposes start({cwd,cols,rows,onData}), write(bytes), resize(cols,rows), kill(), plus an onExit hook and an exposed pure env-builder helper (for the env test)
    - Does NOT import `RunnerEvent`, `agent-protocol`, `session-bridge`; does NOT read/import `~/.claude/.credentials.json` or oauth-poll internals
    - Uses the Phase-15 SPIKE-FINDINGS shipping approach to resolve node-pty from the compiled-sidecar context (no re-derivation)
  </acceptance_criteria>
  <action>
    Promote the seed: add exit handling, a typed options object, the exported pure env-builder, and the
    resize/scrollback hooks the persistence module consumes. Keep the top-of-file comment naming
    constraints 1, 2, 5. Do NOT translate output — raw bytes only. Reference the SPIKE-FINDINGS shipping
    contract for the node-pty load path; do not change it.
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    `grep -nE "\-\-input-format|\-\-output-format|'\-p'|\"\-p\"|--print" supervisor/src/runners/claude-pty-runner.ts` returns NOTHING. `grep -n "delete (env as any).ANTHROPIC_API_KEY" supervisor/src/runners/claude-pty-runner.ts` returns a hit. `grep -nE "RunnerEvent|agent-protocol|session-bridge|credentials.json|oauth-poll" supervisor/src/runners/claude-pty-runner.ts` returns NOTHING.
  </verify>
  <done>Hardened PTY runner: interactive claude, no API key, no programmatic flags, raw bytes only.</done>
</task>

<task type="auto">
  <name>Task 2: pty-persistence.ts — disconnect survival + scrollback replay</name>
  <files>supervisor/src/runners/pty-persistence.ts</files>
  <read_first>
    - supervisor/src/runners/claude-pty-runner.ts (the lifecycle/onData/resize hooks)
    - hub/src/ws/idle-teardown.ts (idle reaping semantics to mirror so persistent PTYs don't leak)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-RESEARCH.md (tmux vs ring-buffer decision)
  </read_first>
  <acceptance_criteria>
    - The PTY is owned by the supervisor process, NOT scoped to a client WS — a client disconnect does not kill it
    - A bounded output ring-buffer (cap configurable, default e.g. last N KB / lines) records recent PTY output for replay
    - On reattach, the module replays the buffered scrollback then resumes live `term.data`
    - On POSIX where tmux is available, the runner is hosted in a detached tmux session (`new-session -d`/`attach-session`) for survival across supervisor restarts; on Windows the persistent-PTY + ring-buffer baseline is used and documented in the SUMMARY
    - An idle/exited PTY is reaped (no orphan); the mechanism is recorded in the SUMMARY
    - The detach-vs-kill policy is EXPLICIT (H7 / R-PTY-27): a client WS DISCONNECT detaches and keeps the supervisor-owned PTY alive (persistence); session CLOSE, idle-reap, AND supervisor SHUTDOWN (SIGINT/SIGTERM/exit) KILL the PTY. tmux-backed sessions: detach = `detach-client` (session survives), kill = `kill-session`. A parent-PID dead-man's-switch ensures a crashed supervisor does not leave a detached non-tmux PTY orphaned
    - A test asserts: after a session CLOSE / idle-reap / supervisor SHUTDOWN there is NO surviving PTY/claude child (no orphan); after a mere client DISCONNECT the supervisor-owned PTY SURVIVES (reattachable)
  </acceptance_criteria>
  <action>
    Implement supervisor-owned PTY persistence with a bounded ring-buffer for scrollback replay as the
    cross-platform baseline. Add the tmux-host path behind a runtime capability check (tmux present →
    detached session; else baseline). Wire reaping to the idle-teardown semantics. This is the
    autonomous:false checkpoint — confirm the Windows persistence mechanism with the operator before
    sign-off (it determines reattach UX on the dev host).
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    A unit test drives output → ring-buffer → replay and asserts the last-N lines survive a simulated disconnect.
  </verify>
  <done>A dropped client reattaches the same session with scrollback intact; persistent PTYs don't leak.</done>
</task>

<task type="auto">
  <name>Task 3: Extend canary + env test; add reattach test</name>
  <files>supervisor/test/no-api-key-no-streamjson-pty.test.ts, supervisor/test/pty-runner-env.test.ts, supervisor/test/pty-reattach-persistence.test.ts</files>
  <read_first>
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts (Phase-15 canary to extend)
    - supervisor/src/runners/claude-pty-runner.ts + supervisor/src/runners/pty-persistence.ts (files under test)
  </read_first>
  <acceptance_criteria>
    - The canary now covers the hardened claude-pty-runner.ts (forbidden argv tokens absent; ANTHROPIC_API_KEY only ever adjacent to `delete`)
    - pty-runner-env.test.ts asserts the exported env-builder strips ANTHROPIC_API_KEY when process.env has it set
    - pty-reattach-persistence.test.ts simulates output → disconnect → reattach and asserts scrollback replay + live resume
    - `bun run check-baseline` green; new files registered in tools/regression-baseline.json if required
  </acceptance_criteria>
  <action>
    Extend the Phase-15 canary's file list to include the hardened runner. Add the reattach test driving
    the ring-buffer. Run `bun run check-baseline`; register new tests in the baseline. Prove the canary
    FAILS when a programmatic flag is reintroduced, then revert.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-api-key-no-streamjson-pty.test.ts test/pty-runner-env.test.ts test/pty-reattach-persistence.test.ts 2>$null</automated>
  </verify>
  <done>Invariants locked by canary; persistence proven by an automated reattach test.</done>
</task>

</tasks>

<verification>
- claude-pty-runner.ts contains the ANTHROPIC_API_KEY delete and zero programmatic flags
- The runner imports no RunnerEvent/agent-protocol/session-bridge/credentials path (grep)
- A dropped connection reattaches with scrollback intact (automated + manual on a live TUI)
- `bun run check-baseline` green
</verification>

<success_criteria>
A hardened interactive-claude PTY runner with disconnect-surviving persistence and scrollback replay,
with the no-API-key / no-stream-json invariants locked behind a build-time canary. Foundation for the
authenticated relay (Plan 02) and mobile surface (Plan 03).
</success_criteria>

<output>
Create `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-01-SUMMARY.md` when done (record
the chosen Windows persistence mechanism + tmux availability finding + ring-buffer cap).
</output>
