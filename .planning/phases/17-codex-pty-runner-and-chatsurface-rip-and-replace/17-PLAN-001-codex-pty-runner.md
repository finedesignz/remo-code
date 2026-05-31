---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supervisor/src/runners/codex-pty-runner.ts
  - supervisor/src/index.ts
  - supervisor/test/no-api-key-no-streamjson-pty.test.ts
  - supervisor/test/codex-pty-runner-env.test.ts
autonomous: false
requirements:
  - R-PTY-12
must_haves:
  truths:
    - "codex-pty-runner.ts spawns the INTERACTIVE Codex CLI inside node-pty with NO programmatic/headless flags, raw bytes only"
    - "It reuses the Phase-16 PTY host + persistence + raw-terminal WS + tmux; it does NOT import RunnerEvent/agent-protocol/session-bridge"
    - "Backend selection: (runner_type='pty-interactive', cli_kind='codex') instantiates codex-pty-runner; cli_kind='claude' instantiates claude-pty-runner"
    - "The Codex PTY runner rides the Phase-16 human-only dispatch guard — automation never touches it"
    - "The extended canary covers the Codex runner (no programmatic flags; env hygiene)"
  artifacts:
    - path: "supervisor/src/runners/codex-pty-runner.ts"
      provides: "Interactive Codex CLI PTY runner (raw bytes; mirrors claude-pty-runner)"
  key_links:
    - from: "(runner_type=pty-interactive, cli_kind=codex)"
      to: "supervisor instantiates codex-pty-runner"
      via: "supervisor/src/index.ts runner selection"
      pattern: "cliKind === 'codex' ? CodexPtyRunner : ClaudePtyRunner"
---

<objective>
Add the Codex interactive/PTY runner so Codex human sessions run on the SAME raw-terminal surface as
Claude — a near-verbatim mirror of the Phase-16 `claude-pty-runner.ts` with the spawned binary swapped to
the interactive Codex CLI (no programmatic/headless flags). This proves the surface is backend-agnostic
before the deletions. This is the safe, additive half of Phase 17 (built first; deletions come after).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-CONTEXT.md
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@supervisor/src/runners/claude-pty-runner.ts
@supervisor/src/runners/types.ts
@supervisor/src/index.ts
@docs/codex-and-rootless.md
@CLAUDE.md

<interfaces>
From supervisor/src/runners/claude-pty-runner.ts (Phase 16): start({cwd,cols,rows,onData}), write, resize, kill, onExit, exported env-builder; raw bytes only; consumes the Phase-15 shipping contract.
From docs/codex-and-rootless.md (Phase 05): Codex CLI invocation + cli_kind='codex'.
From supervisor/src/index.ts: per-session runner instantiation site (where cli_kind + runner_type resolve).
</interfaces>
</context>

<threat_model>
- **T-17-01 — Codex programmatic/headless flag leak (HIGH).** If the Codex runner spawns a headless/
  programmatic mode, it defeats the interactive-surface goal and may carry the same billing-classification
  risk. Mitigation: spawn the interactive Codex entrypoint only; extended canary greps the Codex runner
  for programmatic flags and fails the build.
- **T-17-02 — Env/credential hygiene (HIGH).** The Codex spawn path must not carry ANTHROPIC_API_KEY and
  must not reuse/forward Claude OAuth credentials; Codex auth is delegated to its own client. Mitigation:
  env unit test + static grep (no credentials/oauth-poll import).
- **T-17-03 — Automation reaching the Codex PTY (HIGH, constraint 3).** Mitigation: the Codex PTY runner
  is behind the Phase-16 human-only dispatch guard (same gate; runner_type='pty-interactive'). A test
  confirms automation is rejected for a Codex PTY session. Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: codex-pty-runner.ts — interactive Codex CLI in a PTY (mirror claude-pty-runner)</name>
  <files>supervisor/src/runners/codex-pty-runner.ts</files>
  <read_first>
    - supervisor/src/runners/claude-pty-runner.ts (the template to mirror exactly in structure)
    - docs/codex-and-rootless.md (Codex CLI interactive invocation)
    - supervisor/src/runners/types.ts (align naming; do NOT reuse RunnerEvent)
  </read_first>
  <acceptance_criteria>
    - Spawns the INTERACTIVE Codex CLI inside node-pty with NO programmatic/headless flags; raw bytes only
    - Same lifecycle surface as claude-pty-runner: start({cwd,cols,rows,onData}), write, resize, kill, onExit, exported env-builder
    - Env hygiene: no ANTHROPIC_API_KEY on the spawn path; no reuse/forward of Claude OAuth credentials; does NOT import oauth-poll internals or read ~/.claude/.credentials.json
    - Does NOT import RunnerEvent/agent-protocol/session-bridge; reuses the Phase-16 PTY host + persistence + shipping contract
  </acceptance_criteria>
  <action>
    Copy the structure of claude-pty-runner.ts; swap the spawned binary/argv to the interactive Codex CLI
    entrypoint (confirm exact argv against the installed Codex version — RESEARCH open item). Keep the
    top-of-file comment naming constraints 1, 2, 3, 5. Reuse pty-persistence.ts. Raw bytes only.
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    `grep -nE "RunnerEvent|agent-protocol|session-bridge|credentials.json|oauth-poll" supervisor/src/runners/codex-pty-runner.ts` returns NOTHING.
  </verify>
  <done>Interactive Codex CLI runs in a PTY, raw bytes only, env-clean, behind the human-only guard.</done>
</task>

<task type="auto">
  <name>Task 2: Wire backend selection in the supervisor</name>
  <files>supervisor/src/index.ts</files>
  <read_first>
    - supervisor/src/index.ts (per-session runner instantiation; cli_kind + runner_type resolution)
    - supervisor/src/runners/codex-pty-runner.ts
  </read_first>
  <acceptance_criteria>
    - For runner_type='pty-interactive': cli_kind='codex' → CodexPtyRunner; cli_kind='claude' → ClaudePtyRunner
    - For runner_type='stream-json': existing claude-runner / session-bridge path unchanged
    - No automation source can reach either PTY runner (Phase-16 guard unchanged)
  </acceptance_criteria>
  <action>
    Add the backend-selection branch at the runner instantiation site. Do not change the stream-json path.
    This is the autonomous:false checkpoint — confirm the interactive Codex argv with the operator if the
    installed Codex CLI's interactive entrypoint is uncertain.
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
  </verify>
  <done>Backend-agnostic PTY: Claude and Codex human sessions both route to the terminal surface.</done>
</task>

<task type="auto">
  <name>Task 3: Extend canary + Codex env test</name>
  <files>supervisor/test/no-api-key-no-streamjson-pty.test.ts, supervisor/test/codex-pty-runner-env.test.ts</files>
  <read_first>
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts (canary to extend to the Codex runner)
    - supervisor/src/runners/codex-pty-runner.ts (file under test)
  </read_first>
  <acceptance_criteria>
    - The canary now also scans codex-pty-runner.ts for programmatic/headless flags (none) and credential imports (none)
    - codex-pty-runner-env.test.ts asserts the exported env-builder carries no ANTHROPIC_API_KEY and no forwarded Claude OAuth token
    - `bun run check-baseline` green; new files registered in tools/regression-baseline.json
  </acceptance_criteria>
  <action>
    Add codex-pty-runner.ts to the canary's scanned file list. Add the Codex env test mirroring
    pty-runner-env.test.ts. Run check-baseline and register.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-api-key-no-streamjson-pty.test.ts test/codex-pty-runner-env.test.ts 2>$null</automated>
  </verify>
  <done>Codex runner invariants locked by canary + env test.</done>
</task>

</tasks>

<verification>
- codex-pty-runner.ts: interactive only, raw bytes, no RunnerEvent/credential imports (grep)
- Backend selection routes Codex+Claude human sessions to PTY; stream-json path unchanged
- Automation rejected for Codex PTY sessions (Phase-16 guard); canary + env tests green
- `bun run check-baseline` green
</verification>

<success_criteria>
Codex human sessions run on the same backend-agnostic raw-terminal surface as Claude, proving the surface
is backend-agnostic before the destructive rip. No deletions in this plan (sequencing safeguard).
</success_criteria>

<output>
Create `.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-01-SUMMARY.md` when done
(record the exact interactive Codex CLI argv confirmed).
</output>
