# Phase 15: pty-spike-and-compile-derisk - Research

**Researched:** 2026-05-31
**Phase requirement IDs:** R-PTY-01, R-PTY-02, R-PTY-03, R-PTY-04, R-PTY-05

> Answers: "What do I need to know to PLAN the PTY spike + compile-derisk well?"

## Summary

The spike has two genuinely uncertain technical risks, both load-bearing for the whole milestone:

1. **`node-pty` native addon + `bun build --compile`** — the named blocker (R-PTY-04). `bun build
   --compile` produces a single self-contained executable; native `.node` addons are NOT embedded in
   that bundle. The PTY host therefore cannot be a plain `import 'node-pty'` inside the compiled sidecar.
2. **Bun runtime + node-pty compatibility** — node-pty targets Node's N-API. Bun implements much of
   N-API but PTY addons have historically been flaky under Bun. This must be proven, not assumed, in the
   spike.

Everything else (raw WS relay, xterm.js panel, env-delete, no-stream-json-flags) is low-risk and mirrors
existing remo-code patterns.

## Key findings

### 1. PTY library choice
- **`node-pty`** (Microsoft) is the canonical PTY/ConPTY binding. ConPTY on Windows (Win10+), forkpty on
  POSIX. It is a native addon (`pty.node`).
- The repo is Windows-first (dev host Windows 11) AND the hub/Coolify is Linux — supervisors run on both.
  ConPTY (Windows) + forkpty (Linux) are both needed eventually; the spike targets the dev host first
  (Windows ConPTY) but must not hard-code a single OS path.
- Alternative bindings (`@homebridge/node-pty-prebuilt-multiarch`) ship prebuilt binaries for more
  Node ABIs — relevant if prebuild/rebuild against Bun's ABI is painful. Evaluate during the spike.

### 2. The compile blocker — three shipping options (R-PTY-04, the derisk)
`bun build --compile` cannot embed a `.node` file. The three credible approaches, in increasing
robustness:

- **(a) Ship the native module beside the sidecar.** Keep `pty.node` (+ node-pty JS) out of the compiled
  blob, place it next to the sidecar exe, and `require`/`createRequire` it at runtime from a path
  resolved relative to the executable. Simplest; depends on Bun being able to load the addon at runtime.
- **(b) Helper exe / sidecar-of-the-sidecar.** Ship a tiny separate Node (or prebuilt) executable whose
  only job is to host the PTY and speak a line/byte protocol over stdio or a local socket to the Bun
  sidecar. Decouples the PTY ABI from Bun entirely. Tauri already supports multiple sidecars.
- **(c) Out-of-band PTY host.** Run the PTY host as a separate long-lived local process (e.g. spawned by
  the Tauri Rust shell) and connect over a localhost socket / named pipe.

**Recommendation for the spike:** attempt (a) first (cheapest); if Bun cannot load `pty.node` reliably,
fall to (b). Whichever works, DOCUMENT it as the Phase-16 shipping contract in SPIKE-FINDINGS. The spike
must include a *proof* that the chosen approach runs from the compiled-sidecar context (build the sidecar
once and exercise the PTY through it), not just from `bun run` source.

### 3. Spawn argv + env (R-PTY-01) — mirror claude-runner, strip programmatic flags
- Current programmatic spawn (`supervisor/src/runners/claude-runner.ts:79-84`):
  `['claude', '--input-format','stream-json', '--output-format','stream-json', '--verbose']`.
- The interactive PTY spawn is just `claude` (no flags) launched inside the PTY. NO `-p`, `--print`,
  `--input-format`, `--output-format`.
- Replicate `const env = { ...process.env }; delete env.ANTHROPIC_API_KEY` (claude-runner.ts:94). The PTY
  spawn passes this env to node-pty's `spawn(file, args, { env, cols, rows, cwd })`.
- Auth: rely on the host's existing `claude login` credential in `~/.claude/.credentials.json`. The spike
  does NOT touch credentials (oauth-poll.ts already proves the read-only pattern; do not serialize tokens).

### 4. Raw-terminal WS channel — isolated from the structured pipeline (R-PTY-02, R-PTY-03)
- Existing structured pipeline: supervisor `RunnerEvent` to `hub/src/ws/agent.ts` (validated by
  `agent-protocol.ts`) to bubble events on `/ws/client` (`hub/src/ws/client.ts`, `protocol.ts`). The PTY
  path must NOT enter this.
- New channel design: a small message kind set carried over the EXISTING WS connections but on a distinct
  envelope, e.g. `term.data` (base64/binary bytes), `term.input`, `term.resize {cols,rows}`,
  `term.attach`/`term.reattach`. Validate with a NEW Zod schema separate from `agent-protocol.ts`.
- Relay is byte-faithful: hub forwards `term.*` frames between matched `/ws/client` and `/ws/agent`
  without parsing the payload bytes. Keying by session_id reuses existing subscription routing.
- Isolation test (R-PTY-03): assert the PTY runner module does not import the `RunnerEvent` union and the
  terminal frame schema is defined outside `agent-protocol.ts`.

### 5. xterm.js panel (R-PTY-05)
- Add `@xterm/xterm` (current package name; formerly `xterm`) + `@xterm/addon-fit` to `web/`. No xterm
  dep exists today.
- Render in a panel inside the existing shell (beside/instead of ChatSurface for a PTY session). Apply
  theme via xterm's `theme` option mapped from CSS custom properties (`--bg-primary`, `--text-primary`,
  blue accent). Do NOT introduce indigo (`web/test/no-indigo.test.ts` greps for it).
- On output frames: `term.write(bytes)`. On user keystrokes: `term.onData(d => ws.send(term.input))`.
  On container resize: FitAddon to compute cols/rows, send `term.resize`.

### 6. Canary test pattern (R-PTY-01)
- `supervisor/test/no-legacy-agent-spawn.test.ts` greps `supervisor/src/**` for forbidden literal argv
  tokens. Mirror it: a new canary asserts the PTY runner spawn site never contains `-p`/`--print`/
  `--input-format`/`--output-format stream-json`, and that `ANTHROPIC_API_KEY` is deleted from the
  spawned env. Build-time enforcement of constraints 1 + 5.

### 7. QC gate
- `bun run check-baseline` (per-file isolation, `tools/regression-baseline.json`) must stay green. New
  tests added to the baseline; no regression to existing 771/900.

## Open technical questions for the spike to answer (feed SPIKE-FINDINGS / Phase 16)
- Does Bun load `pty.node` at runtime via approach (a)? If not, is (b) helper-exe the contract?
- ConPTY behavior for the interactive `claude` TUI (alt-screen, resize, color) under the relay?
- Latency/throughput of byte relay through two WS hops for a full-screen TUI redraw — acceptable on mobile?

## Validation Architecture

The phase's risk is concentrated in the PTY-spawn + compile-shipping mechanic and the channel isolation.
Validation sampling (Nyquist) must cover:

- **Spawn-correctness sampling:** automated canary (argv has no programmatic flags; env has no
  ANTHROPIC_API_KEY) + a runtime assertion the spawned process is interactive `claude`.
- **End-to-end byte-relay sampling:** a typed turn produces TUI output rendered in xterm.js (manual +
  scripted input-injection check).
- **Isolation sampling:** static assertion that the terminal path has zero `RunnerEvent` coupling.
- **Compile-shipping sampling:** the chosen node-pty shipping approach is exercised through a built
  sidecar at least once (not only `bun run` source), with the result documented.

## Sources
- Microsoft `node-pty` README (ConPTY/forkpty, native addon, N-API).
- Bun docs: `bun build --compile` (single-file executable; native addons not embedded).
- remo-code in-repo: `supervisor/src/runners/claude-runner.ts`, `supervisor/src/usage/oauth-poll.ts`,
  `hub/src/ws/{agent,client,protocol,agent-protocol}.ts`, `supervisor/test/no-legacy-agent-spawn.test.ts`,
  `supervisor/tauri/scripts/build-and-update.ps1` (sidecar `bun build --compile`).

## RESEARCH COMPLETE
