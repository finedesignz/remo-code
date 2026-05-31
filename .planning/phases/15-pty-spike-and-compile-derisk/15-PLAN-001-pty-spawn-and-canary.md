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
autonomous: true
requirements:
  - R-PTY-01
must_haves:
  truths:
    - "A claude-pty-runner.ts module spawns interactive `claude` inside a node-pty PTY with NO -p, --print, --input-format, or --output-format flags"
    - "The PTY spawn deletes ANTHROPIC_API_KEY from the spawned env (parity with claude-runner.ts:94)"
    - "A canary test fails the build if the PTY runner argv contains a programmatic flag or if ANTHROPIC_API_KEY is present in its spawned env"
    - "node-pty (or a prebuilt-multiarch variant) is a declared supervisor dependency"
  artifacts:
    - path: "supervisor/src/runners/claude-pty-runner.ts"
      provides: "Interactive claude PTY spawn (raw bytes; no RunnerEvent translation)"
    - path: "supervisor/test/no-api-key-no-streamjson-pty.test.ts"
      provides: "Build-time canary for constraints 1 + 5 on the PTY path"
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
  </acceptance_criteria>
  <action>
    Create `supervisor/src/runners/claude-pty-runner.ts`. Import `spawn as ptySpawn` from `node-pty`.
    Build env as `const env = { ...process.env }; delete (env as any).ANTHROPIC_API_KEY` (copy the exact
    line from claude-runner.ts:94). Spawn `ptySpawn('claude', [], { name: 'xterm-256color', cwd, cols,
    rows, env })` — empty argv array (interactive default). Wire `pty.onData(d => onData(d))` for output;
    expose `write(data: string)` to `pty.write(data)`, `resize(cols, rows)` to `pty.resize(cols, rows)`,
    `kill()` to `pty.kill()`. Keep this module raw-bytes-only: it MUST NOT emit `RunnerEvent`, import
    `agent-protocol`/`session-bridge`, or translate output. Add a top-of-file comment naming constraints
    1, 2, 5 so future edits keep them. Do not add tmux yet (Phase 16). Do not wire it into index.ts yet
    (Plan 02 introduces the channel; spike wiring is minimal).
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
  <done>Constraints 1 + 5 are enforced at build time by a canary; env-strip proven by unit test.</done>
</task>

</tasks>

<verification>
- `grep -c "node-pty" supervisor/package.json` >= 1
- claude-pty-runner.ts contains the ANTHROPIC_API_KEY delete and zero programmatic flags
- The canary fails when a programmatic flag is reintroduced (proven, then reverted)
- `bun run check-baseline` green
</verification>

<success_criteria>
Interactive `claude` spawns in a PTY with no API key and no stream-json/`-p`, raw bytes only, and the
two hard constraints are locked behind a build-time canary. Foundation for the channel + panel plans.
</success_criteria>

<output>
Create `.planning/phases/15-pty-spike-and-compile-derisk/15-01-SUMMARY.md` when done.
</output>
