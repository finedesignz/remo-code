---
phase: 15-pty-spike-and-compile-derisk
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supervisor/package.json
  - supervisor/src/runners/claude-pty-runner.ts
  - supervisor/test/no-api-key-no-streamjson-pty.test.ts
  - supervisor/test/pty-runner-env.test.ts
  - supervisor/test/pty-spawn-interception.test.ts
  - supervisor/test/pty-orphan-teardown.test.ts
autonomous: true
requirements:
  - R-PTY-01
  - R-PTY-26
  - R-PTY-27
must_haves:
  truths:
    - "A claude-pty-runner.ts module spawns interactive `claude` inside a node-pty PTY with NO -p, --print, --input-format, or --output-format flags"
    - "The PTY spawn deletes ANTHROPIC_API_KEY from the spawned env (parity with claude-runner.ts:94)"
    - "A canary test fails the build if the PTY runner argv contains a programmatic flag or if ANTHROPIC_API_KEY is present in its spawned env"
    - "node-pty (or a prebuilt-multiarch variant) is a declared supervisor dependency"
    - "A BEHAVIORAL spawn-interception harness intercepts the actual spawn factory at runtime and asserts on the real {file, argv, env} (not only static grep); the spike establishes it as a mockable, non-runtime-exported ptySpawn factory reused by 16/17/19 (R-PTY-26 / H6)"
    - "runner.kill() is wired to session-teardown + WS-disconnect + supervisor-shutdown with a parent-PID dead-man's-switch; no orphan claude/pty host process survives (R-PTY-27 / H7)"
  artifacts:
    - path: "supervisor/src/runners/claude-pty-runner.ts"
      provides: "Interactive claude PTY spawn (raw bytes; no RunnerEvent translation); mockable non-runtime ptySpawn factory seam; kill() lifecycle hooks"
    - path: "supervisor/test/no-api-key-no-streamjson-pty.test.ts"
      provides: "Build-time canary for constraints 1 + 5 on the PTY path (secondary line; primary is the interception harness)"
    - path: "supervisor/test/pty-spawn-interception.test.ts"
      provides: "Behavioral harness — intercepts the spawn factory, asserts real file/argv/env (R-PTY-26 / H6)"
    - path: "supervisor/test/pty-orphan-teardown.test.ts"
      provides: "Asserts no surviving PTY child after disconnect/teardown (R-PTY-27 / H7)"
  key_links:
    - from: "claude-pty-runner.ts spawn site"
      to: "node-pty.spawn('claude', [], { env })"
      via: "env with ANTHROPIC_API_KEY deleted, argv with no programmatic flags"
      pattern: "delete (env as any).ANTHROPIC_API_KEY"
---

<objective>
Create the seed PTY runner module that spawns the genuine *interactive* `claude` TUI inside a node-pty
PTY on the supervisor host, with `ANTHROPIC_API_KEY` deleted from the spawned env and ZERO programmatic
flags. Lock the two non-negotiable constraints (no API key, no stream-json/`-p`) behind a build-time
canary test so they can never silently regress.

Purpose: establishes the spawn contract every later PTY phase inherits. This is the seed of
`claude-pty-runner.ts`, not throwaway.

Output: a module exporting a startable PTY-backed interactive `claude`, plus green canary + env tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-CONTEXT.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@supervisor/src/runners/claude-runner.ts
@supervisor/test/no-legacy-agent-spawn.test.ts
@supervisor/package.json
@CLAUDE.md

<interfaces>
From supervisor/src/runners/claude-runner.ts (current):
- Programmatic argv: `['claude','--input-format','stream-json','--output-format','stream-json','--verbose']` (lines 79-84)
- Env strip: `const env = { ...process.env }; delete (env as any).ANTHROPIC_API_KEY` (line ~94)
From supervisor/test/no-legacy-agent-spawn.test.ts:
- Pattern: recursively read supervisor/src/**, grep literal needles, fail on any finding outside excluded files.
</interfaces>
</context>

<threat_model>
- **T-15-01 — Programmatic-flag leak (HIGH).** If argv ever includes `-p`/`--print`/`--input-format
  stream-json`, the "interactive" session becomes a programmatic client and bills the credit pool —
  defeating the whole feature and risking the ToS line. Mitigation: canary test greps the PTY spawn site
  for forbidden tokens and fails the build.
- **T-15-02 — API-key exfil/billing (HIGH).** If `ANTHROPIC_API_KEY` survives in the spawned env, the
  client may bill API rates and violates constraint 1. Mitigation: explicit `delete` + unit test that
  inspects the env object the runner passes to node-pty.
- **T-15-03 — OAuth token reuse (HIGH, design-level).** Spawning the official `claude` only; the runner
  never reads, stores, or forwards `~/.claude/.credentials.json`. Mitigation: the module must not import
  oauth-poll internals or touch the credentials file.
- **T-15-05 — Static-grep evasion of the spawn invariants (HIGH, H6).** A forbidden flag or a live
  `ANTHROPIC_API_KEY` constructed at runtime (string concat, aliased const, read from config, or merged
  from `process.env`) passes the source-level grep canary yet still reaches the real spawn. Mitigation: a
  BEHAVIORAL spawn-interception harness intercepts the actual spawn factory and asserts on the real
  `{ file, argv, env }` the runner passes at runtime; grep stays as a cheap secondary. (R-PTY-26.)
- **T-15-06 — Orphaned PTY process leak (MED, H7).** The spike wires start/write/resize but if `kill()`
  is not bound to teardown/disconnect/supervisor-exit, a dropped connection or a crashed supervisor leaves
  a zombie `claude` + `pty` host holding memory, file locks, and a live OAuth session. Mitigation: wire
  `runner.kill()` to session-teardown + WS-disconnect + supervisor-shutdown plus a parent-PID dead-man's-
  switch; an orphan-teardown test asserts no surviving child. (R-PTY-27.)
Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Add node-pty dependency to the supervisor package</name>
  <files>supervisor/package.json</files>
  <read_first>
    - supervisor/package.json (current deps + scripts)
    - .planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md (PTY library choice section)
  </read_first>
  <acceptance_criteria>
    - supervisor/package.json dependencies contains "node-pty" (or "@homebridge/node-pty-prebuilt-multiarch")
    - `bun install` completes and the native module builds/loads on the dev host (Windows ConPTY)
  </acceptance_criteria>
  <action>
    Add `node-pty` (latest) to supervisor/package.json dependencies. If `bun install` cannot build the
    native addon under Bun on the dev host, switch the dependency to
    `@homebridge/node-pty-prebuilt-multiarch` (ships prebuilt binaries) and note the swap in the SUMMARY.
    Run `bun install` from the repo root. Do not yet attempt compiled-sidecar bundling — that is Plan 03.
  </action>
  <verify>
    <automated>cd supervisor; bun install</automated>
    `grep -n "node-pty" supervisor/package.json` returns a hit. A one-off `bun -e "require('node-pty')"` (or import) does not throw on the dev host.
  </verify>
  <done>node-pty is a declared, installable supervisor dependency on the dev host.</done>
</task>

<task type="auto">
  <name>Task 2: claude-pty-runner.ts — interactive spawn, env-strip, raw byte I/O surface</name>
  <files>supervisor/src/runners/claude-pty-runner.ts</files>
  <read_first>
    - supervisor/src/runners/claude-runner.ts (full — copy the env-strip exactly; note it does NOT use stream-json for the PTY path)
    - supervisor/src/runners/types.ts (existing runner-side types to align naming, NOT to reuse RunnerEvent)
    - .planning/phases/15-pty-spike-and-compile-derisk/15-CONTEXT.md (locked decisions)
  </read_first>
  <acceptance_criteria>
    - claude-pty-runner.ts spawns via node-pty with file `claude` and argv that contains NONE of: `-p`, `--print`, `--input-format`, `--output-format`
    - The spawned env is built as `{ ...process.env }` then `delete env.ANTHROPIC_API_KEY`
    - The module exposes: a start/spawn fn taking `{ cwd, cols, rows, onData }`, a `write(bytes)` for input, a `resize(cols, rows)`, and a `kill()` — raw bytes only
    - The module does NOT import the `RunnerEvent` union, agent-protocol, or session-bridge
    - The module does NOT read or import `~/.claude/.credentials.json` or oauth-poll internals
    - The actual spawn call goes through a single injectable `ptySpawn` factory seam (default = real `node-pty` spawn) so the behavioral harness (Task 4) can intercept the real `{file, argv, env}` WITHOUT that seam being exported to / used by runtime callers (test-only override). (R-PTY-26 / H6)
    - `kill()` is idempotent and the module exposes the lifecycle hook the spike's disconnect/teardown wiring (Task 5) binds to. (R-PTY-27 / H7)
  </acceptance_criteria>
  <action>
    Create `supervisor/src/runners/claude-pty-runner.ts`. Route the spawn through an injectable factory
    seam (e.g. a module-level `let ptySpawn = realNodePtySpawn` with a test-only `__setPtySpawnForTest()`
    NOT re-exported from the package entrypoint, or a constructor-injected factory defaulting to the real
    one) so the Task-4 harness can capture the real call args. Build env as
    `const env = { ...process.env }; delete (env as any).ANTHROPIC_API_KEY` (copy the exact line from
    claude-runner.ts:94). Spawn `ptySpawn('claude', [], { name: 'xterm-256color', cwd, cols, rows, env })`
    — empty argv array (interactive default). Wire `pty.onData(d => onData(d))` for output; expose
    `write(data: string)` to `pty.write(data)`, `resize(cols, rows)` to `pty.resize(cols, rows)`, and an
    idempotent `kill()` to `pty.kill()`. Keep this module raw-bytes-only: it MUST NOT emit `RunnerEvent`,
    import `agent-protocol`/`session-bridge`, or translate output. Add a top-of-file comment naming
    constraints 1, 2, 5 so future edits keep them. Do not add tmux yet (Phase 16). Do not wire it into
    index.ts yet (Plan 02 introduces the channel; spike wiring is minimal).
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    `grep -nE "\-\-input-format|\-\-output-format|'\-p'|\"\-p\"|--print" supervisor/src/runners/claude-pty-runner.ts` returns NOTHING. `grep -n "delete (env as any).ANTHROPIC_API_KEY" supervisor/src/runners/claude-pty-runner.ts` returns a hit. `grep -nE "RunnerEvent|agent-protocol|session-bridge|credentials.json|oauth-poll" supervisor/src/runners/claude-pty-runner.ts` returns NOTHING.
  </verify>
  <done>PTY runner spawns interactive claude with no programmatic flags and no API key, raw bytes only.</done>
</task>

<task type="auto">
  <name>Task 3: Build-time canary + env unit test (constraints 1 + 5)</name>
  <files>supervisor/test/no-api-key-no-streamjson-pty.test.ts, supervisor/test/pty-runner-env.test.ts</files>
  <read_first>
    - supervisor/test/no-legacy-agent-spawn.test.ts (mirror its recursive-grep structure + exclude-self pattern)
    - supervisor/src/runners/claude-pty-runner.ts (the file under test)
  </read_first>
  <acceptance_criteria>
    - no-api-key-no-streamjson-pty.test.ts fails if claude-pty-runner.ts contains `-p`, `--print`, `--input-format`, or `--output-format` as argv tokens
    - The same canary fails if `ANTHROPIC_API_KEY` appears WITHOUT a preceding `delete` in the PTY runner
    - pty-runner-env.test.ts constructs the runner's env (mock process.env with ANTHROPIC_API_KEY set) and asserts the env passed to the spawn has ANTHROPIC_API_KEY undefined
    - Both tests pass (`bun test` exits 0) and are added to the baseline
  </acceptance_criteria>
  <action>
    Create `supervisor/test/no-api-key-no-streamjson-pty.test.ts` modeled on no-legacy-agent-spawn.test.ts:
    read `supervisor/src/runners/claude-pty-runner.ts`, assert the forbidden literal tokens
    (`--input-format`, `--output-format`, `--print`, and `-p` as a standalone argv token) are absent, and
    assert `ANTHROPIC_API_KEY` only ever appears adjacent to a `delete`. Create
    `supervisor/test/pty-runner-env.test.ts` that mock-injects `process.env.ANTHROPIC_API_KEY='sk-test'`,
    invokes the runner's env-building path (refactor the env build into an exported pure helper if needed
    for testability — smallest diff), and asserts the resulting env has no ANTHROPIC_API_KEY. Run
    `bun run check-baseline` and add the new files to `tools/regression-baseline.json` if the gate
    requires registration.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-api-key-no-streamjson-pty.test.ts test/pty-runner-env.test.ts 2>$null</automated>
    Both test files exit 0. Temporarily adding `--input-format` to the runner makes the canary FAIL (revert after proving).
  </verify>
  <done>Constraints 1 + 5 are enforced at build time by a canary (SECONDARY line — the behavioral harness in Task 4 is primary); env-strip proven by unit test.</done>
</task>

<task type="auto">
  <name>Task 4: Behavioral spawn-interception harness (primary enforcement of the spawn invariants) — H6 / R-PTY-26</name>
  <files>supervisor/test/pty-spawn-interception.test.ts</files>
  <read_first>
    - supervisor/src/runners/claude-pty-runner.ts (the injectable ptySpawn factory seam added in Task 2)
    - supervisor/src/runners/claude-runner.ts (forbidden programmatic argv to assert ABSENT on the PTY path)
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts (the grep canary this test SUPERSEDES as primary)
  </read_first>
  <acceptance_criteria>
    - The test installs a fake `ptySpawn` via the Task-2 test-only seam, drives the runner's real start path, and captures the EXACT `{ file, argv, env }` the runner passed at runtime
    - Asserts `file === 'claude'` and the captured `argv` is empty (no Claude flags) in PTY mode
    - Asserts the captured `argv` contains NONE of: `-p`, `--print`, `--input-format`, `--output-format` (even if a token were constructed at runtime — this catches what grep cannot)
    - Asserts the captured `env.ANTHROPIC_API_KEY` is `undefined` EVEN WHEN `process.env.ANTHROPIC_API_KEY` is set during the test
    - The harness is structured for reuse (exported helper or documented pattern) by Phases 16/17/19 — a comment names the reusing phases
  </acceptance_criteria>
  <action>
    Create `supervisor/test/pty-spawn-interception.test.ts`. Set `process.env.ANTHROPIC_API_KEY='sk-test'`,
    inject a capturing fake through the runner's test-only `ptySpawn` seam, call the runner's start, and
    assert on the captured real call args (file/argv/env) — NOT on source text. Prove the harness CATCHES a
    runtime-constructed violation: temporarily make the runner build a forbidden flag via string concat,
    confirm this behavioral test FAILS while the grep canary still PASSES (demonstrating why behavioral is
    primary), then revert. Keep the grep canary (Task 3) as the cheap secondary. Register the new test in
    `tools/regression-baseline.json` if the gate requires it.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/pty-spawn-interception.test.ts 2>$null</automated>
    Exits 0. Runtime-constructed forbidden flag makes THIS test fail (proven, then reverted); the grep canary alone would have missed it.
  </verify>
  <done>The spawn invariants (no API key, no programmatic flags, official claude) are enforced BEHAVIORALLY at runtime; grep is now the secondary line; harness reusable by 16/17/19.</done>
</task>

<task type="auto">
  <name>Task 5: Orphaned-PTY teardown — kill on disconnect/closure/shutdown + dead-man's-switch — H7 / R-PTY-27</name>
  <files>supervisor/src/runners/claude-pty-runner.ts, supervisor/src/index.ts, supervisor/test/pty-orphan-teardown.test.ts</files>
  <read_first>
    - supervisor/src/runners/claude-pty-runner.ts (the idempotent kill() + lifecycle hook from Task 2)
    - supervisor/src/index.ts (how sessions/runners are torn down + WS-close + process-exit handling)
    - supervisor/test/no-legacy-agent-spawn.test.ts (test style)
  </read_first>
  <acceptance_criteria>
    - `runner.kill()` is invoked on: session teardown, the owning client WS disconnect (spike connection-scoped lifecycle), and supervisor process shutdown (SIGINT/SIGTERM/exit)
    - A parent-PID dead-man's-switch ensures a killed/crashed supervisor does not leave a detached `claude` + `pty` host (e.g. the PTY child observes the parent PID and self-exits, or is reaped on next supervisor boot)
    - `pty-orphan-teardown.test.ts` spawns the PTY runner against a harmless long-lived command, simulates a disconnect/teardown, and asserts NO surviving child process afterward (poll the child PID / process list)
    - The Phase-16 detach-vs-kill policy is NAMED here as a forward note: in Phase 16 client-disconnect DETACHES (supervisor-owned persistence) while session-close / idle-reap / supervisor-exit KILLS; the spike's connection-scoped kill is the pre-persistence baseline
  </acceptance_criteria>
  <action>
    Wire `runner.kill()` into the supervisor teardown path (session close + WS-disconnect) and add
    process-level `SIGINT`/`SIGTERM`/`exit` handlers that kill all live PTY runners. Add a parent-PID
    dead-man's-switch so an orphaned child self-terminates if the supervisor dies. Create
    `pty-orphan-teardown.test.ts` driving a real harmless PTY (e.g. a sleep/echo loop) → simulate
    disconnect → assert the child PID is gone (with a bounded poll). Add the forward note about the
    Phase-16 detach-vs-kill split. Register the test in the baseline if required.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/pty-orphan-teardown.test.ts 2>$null</automated>
    Exits 0. After a simulated disconnect/teardown, the spawned child PID is no longer alive.
  </verify>
  <done>No orphaned PTY/claude process survives disconnect, session teardown, or supervisor shutdown; Phase-16 detach-vs-kill policy is documented forward.</done>
</task>

</tasks>

<verification>
- `grep -c "node-pty" supervisor/package.json` >= 1
- claude-pty-runner.ts contains the ANTHROPIC_API_KEY delete and zero programmatic flags
- The canary fails when a programmatic flag is reintroduced (proven, then reverted)
- The behavioral spawn-interception harness (Task 4) asserts the REAL file/argv/env and CATCHES a runtime-constructed forbidden flag the grep canary misses (H6 / R-PTY-26)
- No orphan PTY/claude child survives a simulated disconnect/teardown (Task 5 / H7 / R-PTY-27)
- `bun run check-baseline` green
</verification>

<success_criteria>
Interactive `claude` spawns in a PTY with no API key and no stream-json/`-p`, raw bytes only, and the
two hard constraints are locked behind a build-time canary. Foundation for the channel + panel plans.
</success_criteria>

<output>
Create `.planning/phases/15-pty-spike-and-compile-derisk/15-01-SUMMARY.md` when done.
</output>
