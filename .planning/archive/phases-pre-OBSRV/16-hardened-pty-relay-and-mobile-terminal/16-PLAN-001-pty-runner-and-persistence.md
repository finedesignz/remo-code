---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  # Task 0 — Rust ConPTY derisk spike (decision gate); spike-only, paths depend on chosen crate
  - supervisor/tauri/src-tauri/src/pty_spike.rs
  - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md
  # Option C (PRIMARY, if spike PASSES) — PTY hosting in the Tauri Rust process; Bun relays bytes
  - supervisor/tauri/src-tauri/src/pty_host.rs
  - supervisor/src/runners/claude-pty-bridge.ts
  # Option A (FALLBACK, if spike FAILS) — bundled portable node + node-pty + pty-host.mjs (Phase-15 proven)
  - supervisor/src/runners/claude-pty-runner.ts
  - supervisor/src/runners/pty-persistence.ts
  # Tests (both branches)
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
    - "Task 0 (decision gate) runs FIRST: a Rust-side spike (wezterm `portable-pty` candidate; `conpty` crate alternative) spawns the GENUINE interactive `claude` TUI from the Tauri Rust process with ANTHROPIC_API_KEY deleted and NO -p/--input-format stream-json, captures the real trust prompt, and confirms byte relay round-trips"
    - "If the Rust spike renders the real interactive TUI → Option C: PTY hosting lives in the Tauri Rust process and the Bun sidecar relays bytes to/from Rust over a local channel (Tauri command/event or localhost socket); the Node pty-host.mjs detour is dropped on Windows"
    - "If the Rust spike CANNOT render the real interactive TUI → Option A fallback: bundled portable node.exe + node-pty + pty-host.mjs (already fully proven in Phase 15)"
    - "On EITHER branch the runner spawns interactive `claude` with NO -p/--print/--input-format/--output-format and deletes ANTHROPIC_API_KEY from the spawned env"
    - "The PTY host is raw-bytes-only: it does NOT translate to RunnerEvent/agent-protocol/session-bridge, and never reads ~/.claude/.credentials.json"
    - "The PTY process is owned by the supervisor (Rust host on Option C; supervisor-owned Node PTY on Option A), so a dropped client connection does NOT kill the session"
    - "A reattach restores live state with the last-N lines of scrollback intact (output ring-buffer cross-platform baseline; tmux on POSIX where available)"
    - "The extended canary fails the build if a programmatic flag or a live ANTHROPIC_API_KEY appears on the PTY path (whichever branch ships)"
  artifacts:
    - path: ".planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md"
      provides: "Decision-gate verdict: PASS (Option C) or FAIL (Option A fallback), with captured trust-prompt evidence and chosen crate"
    - path: "supervisor/src/runners/claude-pty-runner.ts"
      provides: "Hardened interactive-claude PTY runner — Option C: thin Bun↔Rust byte bridge; Option A: bundled-Node node-pty host (raw bytes; lifecycle; resize; scrollback hooks)"
    - path: "supervisor/src/runners/pty-persistence.ts"
      provides: "Disconnect-survival + scrollback replay (persistent PTY + ring-buffer; tmux on POSIX)"
    - path: "supervisor/test/pty-reattach-persistence.test.ts"
      provides: "Proof a dropped connection reattaches with scrollback intact"
  key_links:
    - from: "Task-0 Rust spike (pty_spike.rs)"
      to: "genuine interactive `claude` TUI via portable-pty/conpty"
      via: "Rust-hosted ConPTY, env with ANTHROPIC_API_KEY deleted, argv with no programmatic flags"
      pattern: "PASS → Option C primary; FAIL → Option A fallback"
    - from: "PTY runner spawn site (Rust pty_host.rs on C; node-pty on A)"
      to: "spawn('claude', [], { env })"
      via: "env with ANTHROPIC_API_KEY deleted, argv with no programmatic flags"
      pattern: "delete (env as any).ANTHROPIC_API_KEY (A); env.remove(\"ANTHROPIC_API_KEY\") (C)"
    - from: "client WS disconnect"
      to: "pty-persistence keeps PTY alive + buffers output"
      via: "supervisor-owned PTY lifecycle, not WS-scoped"
      pattern: "ring-buffer replay on term.reattach"
---

<objective>
Open the phase with a Rust-ConPTY DERISK SPIKE that decides the PTY hosting strategy, then promote the
result into a hardened, persistent interactive-`claude` PTY runner (no API key, no programmatic flags, raw
bytes only) with a robust lifecycle, and make the session SURVIVE a dropped phone/browser connection —
reattach restores live state with scrollback intact.

**Target end-state is Option C (Rust ConPTY):** PTY hosting moves into the Tauri Rust process and the Bun
sidecar relays bytes to/from Rust over a local channel; the Node `pty-host.mjs` detour is dropped on
Windows. This is GATED on the Task-0 spike succeeding. If the Rust spike cannot render the real interactive
TUI, the phase falls back to **Option A** (bundled portable node.exe + node-pty + pty-host.mjs) — the
approach already fully proven in Phase 15. tmux on POSIX where available; an output ring-buffer is the
cross-platform (Windows dev host) baseline. Lock the no-API-key / no-stream-json invariants behind the
extended Phase-15 canary so they cannot regress.

Output: a decision-gate findings artifact, a production-grade PTY runner + persistence module (on the
chosen branch), plus green canary/env/reattach tests.
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
- Env strip: `const env = { ...process.env }; delete (env as any).ANTHROPIC_API_KEY` (line ~94) — copied verbatim on the A branch; mirrored as `env.remove("ANTHROPIC_API_KEY")` on the C (Rust) branch.
From the Phase-15 seed (claude-pty-runner.ts): start({cwd,cols,rows,onData}), write(bytes), resize(cols,rows), kill().
From supervisor/test/no-legacy-agent-spawn.test.ts: recursive-grep canary pattern with exclude-self.
For Option C: wezterm `portable-pty` crate (`PtySystem`/`CommandBuilder`/`MasterPty` reader+writer) is the recommended candidate; the `conpty` crate is the alternative. PTY bytes cross the Bun↔Rust seam via a Tauri command/event channel or a localhost socket.
</interfaces>
</context>

<threat_model>
- **T-16-00 — Inconclusive spike / wrong hosting choice (HIGH, decision-gate).** Shipping Option C without
  proving the Rust side can render the GENUINE interactive `claude` TUI risks a dead end mid-phase.
  Mitigation: Task 0 is a blocking decision gate — Option C proceeds ONLY on a captured real trust-prompt +
  byte-round-trip; otherwise the phase falls back to the Phase-15-proven Option A. Verdict recorded in
  `16-SPIKE-FINDINGS-rust-conpty.md`. Block on: HIGH.
- **T-16-01 — Programmatic-flag leak (HIGH).** If the hardened runner's argv ever includes
  `-p`/`--print`/`--input-format stream-json`, the interactive session becomes a programmatic client and
  bills the credit pool / risks the ToS line. Mitigation: the extended Phase-15 canary greps the runner
  (and the Rust spawn site on Option C) for forbidden tokens and fails the build.
- **T-16-02 — API-key billing (HIGH).** If `ANTHROPIC_API_KEY` survives in the spawned env, the client
  may bill API rates (constraint 1). Mitigation: explicit `delete`/`remove` + env unit test inspecting the
  object passed to the spawner (node-pty on A; the Rust `CommandBuilder` env on C).
- **T-16-03 — OAuth token reuse (HIGH, design-level).** The runner spawns the official `claude` only;
  never reads/stores/forwards `~/.claude/.credentials.json`, never imports oauth-poll internals.
  Mitigation: static grep test asserts no credentials/oauth-poll import.
- **T-16-04 — Persistence resource leak / orphan PTY (MEDIUM, H7 / R-PTY-27).** A supervisor-owned PTY
  that outlives every client could leak processes; a crashed supervisor could leave a detached PTY
  orphaned. Mitigation: an EXPLICIT detach-vs-kill policy — client disconnect DETACHES (PTY survives),
  while session close / idle-reap / supervisor shutdown (SIGINT/SIGTERM/exit) KILL it — backed by
  idle-teardown integration (reuse `hub/src/ws/idle-teardown.ts` semantics), a bounded ring-buffer, and a
  parent-PID dead-man's-switch; a killed/exited PTY is reaped. On Option C the Rust host owns the PTY
  lifecycle and ties it to supervisor-process lifetime; on Option A the supervisor-owned Node PTY does. A
  test asserts no orphan after close/idle/shutdown and survival after a mere disconnect. Block on: HIGH.
</threat_model>

<tasks>

<task type="checkpoint:decision" gate="blocking">
  <name>Task 0: Rust ConPTY derisk spike (DECISION GATE) — Option C vs Option A</name>
  <files>supervisor/tauri/src-tauri/src/pty_spike.rs, .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md</files>
  <read_first>
    - .planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md + the Phase-15 SPIKE-FINDINGS (the Node proof this spike mirrors on the Rust side)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md (locked constraints 1, 2, 5)
    - supervisor/src/runners/claude-runner.ts (env-strip + interactive-only argv to mirror)
    - supervisor/tauri/src-tauri/ (Tauri Rust crate where the spike lives)
  </read_first>
  <decision>Whether Phase 16 hosts the interactive PTY in the Tauri Rust process (Option C, target end-state) or falls back to a bundled Node host (Option A, Phase-15-proven). This determines every subsequent runtime/host/persistence task in this plan.</decision>
  <context>
    The operator has set Option C (Rust ConPTY) as the TARGET, but GATED on a derisk spike that mirrors the
    Phase-15 Node proof. The spike must prove the Rust side can render the GENUINE interactive `claude` TUI
    — not a programmatic stream. If it cannot, Option A (bundled portable node.exe + node-pty +
    pty-host.mjs) is the already-proven fallback and the phase proceeds on that branch with NO loss of scope.
  </context>
  <acceptance_criteria>
    - A minimal Rust spike (in the Tauri crate) spawns `claude` through a ConPTY using the wezterm
      `portable-pty` crate (recommended candidate) or the `conpty` crate (alternative)
    - The spawn uses argv containing NONE of `-p`/`--print`/`--input-format`/`--output-format` and an env
      with `ANTHROPIC_API_KEY` REMOVED (`env.remove("ANTHROPIC_API_KEY")`) — parity with constraints 1 & 5
    - The spike CAPTURES the real interactive trust/welcome prompt bytes from the TUI (proof it is the genuine
      interactive `claude`, not a programmatic `-p` stream) and confirms a byte written to the PTY master
      round-trips (input → TUI reacts → output bytes observed)
    - `16-SPIKE-FINDINGS-rust-conpty.md` records: chosen crate, captured trust-prompt evidence, byte-round-trip
      result, and an explicit verdict — **PASS → Option C** or **FAIL → Option A fallback**
  </acceptance_criteria>
  <action>
    Build a throwaway-grade but honest Rust spike inside the Tauri crate that opens a ConPTY (prefer wezterm
    `portable-pty`; fall back to the `conpty` crate if portable-pty stalls), spawns the official `claude` with
    interactive-only argv and `ANTHROPIC_API_KEY` removed from the command env, reads the master, and asserts
    the genuine interactive trust prompt appears + an input byte round-trips. Run it on the Windows dev host
    with `ANTHROPIC_API_KEY` deleted from the shell and NO programmatic flags. Record the verdict in
    `16-SPIKE-FINDINGS-rust-conpty.md`. PRESENT the verdict to the operator at this blocking checkpoint:
    - **PASS:** proceed with Option C — Tasks 1-3 host the PTY in Rust (`pty_host.rs`) with a Bun↔Rust byte
      channel; the Node pty-host.mjs detour is dropped on Windows.
    - **FAIL:** proceed with Option A — Tasks 1-3 use the bundled portable node.exe + node-pty + pty-host.mjs
      path already proven in Phase 15.
  </action>
  <verify>
    <automated>cd supervisor/tauri/src-tauri; cargo run --bin pty_spike 2>$null</automated>
    The spike prints the captured interactive trust-prompt bytes and a "byte round-trip OK" line; `16-SPIKE-FINDINGS-rust-conpty.md` exists with an explicit PASS/FAIL verdict and the chosen crate.
  </verify>
  <resume-signal>Confirm "Option C" (Rust spike rendered the real TUI) or "Option A" (fall back to bundled Node host); execution of Tasks 1-3 follows the confirmed branch.</resume-signal>
  <done>The hosting strategy is decided and recorded: Option C if the Rust spike rendered the genuine interactive TUI, else Option A fallback.</done>
</task>

<task type="auto">
  <name>Task 1: Harden the PTY runner (lifecycle, resize, scrollback hooks) — still raw-bytes-only — on the Task-0-chosen branch</name>
  <files>supervisor/tauri/src-tauri/src/pty_host.rs + supervisor/src/runners/claude-pty-bridge.ts (Option C) OR supervisor/src/runners/claude-pty-runner.ts (Option A)</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md (the Task-0 verdict that selects this task's branch)
    - supervisor/src/runners/claude-pty-runner.ts (the Phase-15 seed)
    - supervisor/src/runners/claude-runner.ts (env-strip line to keep verbatim)
    - supervisor/src/runners/types.ts (align naming; do NOT reuse RunnerEvent)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md (locked decisions)
  </read_first>
  <acceptance_criteria>
    - **Option C (PRIMARY — spike PASSED):** `pty_host.rs` hosts the interactive `claude` ConPTY in the Tauri
      Rust process using the spike-chosen crate; argv contains NONE of `-p`/`--print`/`--input-format`/`--output-format`;
      the command env has `ANTHROPIC_API_KEY` removed. `claude-pty-bridge.ts` is a THIN Bun-side relay that ferries
      raw bytes to/from the Rust host over the local channel (Tauri command/event or localhost socket) and exposes
      start({cwd,cols,rows,onData}), write(bytes), resize(cols,rows), kill(), onExit. The Node pty-host.mjs detour is
      NOT used on Windows. No byte translation; no RunnerEvent.
    - **Option A (FALLBACK — spike FAILED):** Promote `claude-pty-runner.ts` per the original Phase-15-proven plan —
      spawns via node-pty with file `claude` and argv containing NONE of `-p`/`--print`/`--input-format`/`--output-format`;
      env built as `{ ...process.env }` then `delete env.ANTHROPIC_API_KEY`; exposes start({cwd,cols,rows,onData}),
      write(bytes), resize(cols,rows), kill(), onExit, and an exported pure env-builder helper. Uses the Phase-15
      SPIKE-FINDINGS shipping approach to resolve node-pty / the bundled portable node from the compiled-sidecar context.
    - **Both branches:** Does NOT import `RunnerEvent`, `agent-protocol`, `session-bridge`; does NOT read/import
      `~/.claude/.credentials.json` or oauth-poll internals; raw bytes only.
  </acceptance_criteria>
  <action>
    Follow the Task-0 verdict.
    - **Option C:** implement `pty_host.rs` (Rust-owned ConPTY via the chosen crate, env `remove`, interactive-only
      argv, master reader/writer, resize, kill, exit signalling) and a thin `claude-pty-bridge.ts` Bun relay over the
      local Bun↔Rust channel. Keep raw bytes end-to-end. Drop the Node pty-host.mjs detour on Windows.
    - **Option A (fallback, original plan text preserved):** Promote the Phase-15 seed — add exit handling, a typed
      options object, the exported pure env-builder, and the resize/scrollback hooks the persistence module consumes.
      Keep the top-of-file comment naming constraints 1, 2, 5. Do NOT translate output — raw bytes only. Reference the
      SPIKE-FINDINGS shipping contract for the node-pty load path; do not change it.
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    On Option C: `cd supervisor/tauri/src-tauri; cargo check 2>$null` passes. On either branch, the chosen runner file contains the API-key strip (`delete (env as any).ANTHROPIC_API_KEY` on A; `env.remove("ANTHROPIC_API_KEY")` on C) and NONE of `--input-format`/`--output-format`/`-p`/`--print`; and contains NONE of `RunnerEvent`/`agent-protocol`/`session-bridge`/`credentials.json`/`oauth-poll`.
  </verify>
  <done>Hardened PTY runner on the chosen branch: interactive claude, no API key, no programmatic flags, raw bytes only.</done>
</task>

<task type="auto">
  <name>Task 2: pty-persistence.ts — disconnect survival + scrollback replay (branch-aware)</name>
  <files>supervisor/src/runners/pty-persistence.ts</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md (which host owns the PTY lifecycle)
    - supervisor/src/runners/claude-pty-bridge.ts / supervisor/tauri/src-tauri/src/pty_host.rs (Option C) OR supervisor/src/runners/claude-pty-runner.ts (Option A) — the lifecycle/onData/resize hooks
    - hub/src/ws/idle-teardown.ts (idle reaping semantics to mirror so persistent PTYs don't leak)
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-RESEARCH.md (tmux vs ring-buffer decision)
  </read_first>
  <acceptance_criteria>
    - The PTY is owned by the supervisor (the Rust host on Option C; the supervisor-owned Node PTY on Option A), NOT
      scoped to a client WS — a client disconnect does not kill it
    - A bounded output ring-buffer (cap configurable, default e.g. last N KB / lines) records recent PTY output for replay
    - On reattach, the module replays the buffered scrollback then resumes live `term.data`
    - On POSIX where tmux is available, the runner is hosted in a detached tmux session (`new-session -d`/`attach-session`) for survival across supervisor restarts; on Windows the persistent-PTY (Rust-owned on C, Node-owned on A) + ring-buffer baseline is used and documented in the SUMMARY
    - An idle/exited PTY is reaped (no orphan); the mechanism is recorded in the SUMMARY
    - The detach-vs-kill policy is EXPLICIT (H7 / R-PTY-27): a client WS DISCONNECT detaches and keeps the supervisor-owned PTY alive (persistence); session CLOSE, idle-reap, AND supervisor SHUTDOWN (SIGINT/SIGTERM/exit) KILL the PTY. tmux-backed sessions: detach = `detach-client` (session survives), kill = `kill-session`. A parent-PID dead-man's-switch ensures a crashed supervisor does not leave a detached non-tmux PTY orphaned (on Option C the Rust host ties PTY lifetime to the supervisor process)
    - A test asserts: after a session CLOSE / idle-reap / supervisor SHUTDOWN there is NO surviving PTY/claude child (no orphan); after a mere client DISCONNECT the supervisor-owned PTY SURVIVES (reattachable)
  </acceptance_criteria>
  <action>
    Implement supervisor-owned PTY persistence with a bounded ring-buffer for scrollback replay as the
    cross-platform baseline, sourcing PTY output/lifecycle from whichever host Task 0 selected (the Rust
    `pty_host.rs` via `claude-pty-bridge.ts` on Option C; `claude-pty-runner.ts` on Option A). Add the tmux-host
    path behind a runtime capability check (tmux present → detached session; else baseline). Wire reaping to the
    idle-teardown semantics. This is the autonomous:false checkpoint — confirm the Windows persistence mechanism
    with the operator before sign-off (it determines reattach UX on the dev host).
  </action>
  <verify>
    <automated>cd supervisor; bun run tsc --noEmit -p . 2>$null</automated>
    A unit test drives output → ring-buffer → replay and asserts the last-N lines survive a simulated disconnect.
  </verify>
  <done>A dropped client reattaches the same session with scrollback intact; persistent PTYs don't leak.</done>
</task>

<task type="auto">
  <name>Task 3: Extend canary + env test; add reattach test (branch-aware)</name>
  <files>supervisor/test/no-api-key-no-streamjson-pty.test.ts, supervisor/test/pty-runner-env.test.ts, supervisor/test/pty-reattach-persistence.test.ts</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-SPIKE-FINDINGS-rust-conpty.md (which files the canary must cover)
    - supervisor/test/no-api-key-no-streamjson-pty.test.ts (Phase-15 canary to extend)
    - The chosen-branch host files (pty_host.rs + claude-pty-bridge.ts on C; claude-pty-runner.ts on A) + supervisor/src/runners/pty-persistence.ts
  </read_first>
  <acceptance_criteria>
    - The canary now covers the chosen-branch host: forbidden argv tokens absent and ANTHROPIC_API_KEY only ever
      adjacent to `delete`/`remove`, across `claude-pty-runner.ts` (A) AND `pty_host.rs`/`claude-pty-bridge.ts` (C)
      — whichever shipped (the canary globs both paths so it holds regardless of branch)
    - pty-runner-env.test.ts asserts the env passed to the spawner strips ANTHROPIC_API_KEY when process.env has it set
    - pty-reattach-persistence.test.ts simulates output → disconnect → reattach and asserts scrollback replay + live resume
    - `bun run check-baseline` green; new files registered in tools/regression-baseline.json if required
  </acceptance_criteria>
  <action>
    Extend the Phase-15 canary's file list to include the chosen-branch host (the Rust `pty_host.rs` + Bun
    `claude-pty-bridge.ts` on Option C; the hardened `claude-pty-runner.ts` on Option A) — glob both so the canary
    is branch-agnostic. Add the reattach test driving the ring-buffer. Run `bun run check-baseline`; register new
    tests in the baseline. Prove the canary FAILS when a programmatic flag is reintroduced, then revert.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/no-api-key-no-streamjson-pty.test.ts test/pty-runner-env.test.ts test/pty-reattach-persistence.test.ts 2>$null</automated>
  </verify>
  <done>Invariants locked by canary; persistence proven by an automated reattach test.</done>
</task>

</tasks>

<packaging_and_shipping>
**Primary — Option C (Rust ConPTY, spike PASSED):** the supervisor ships NO bundled JS runtime for the PTY
path. The interactive `claude` ConPTY is hosted inside the Tauri Rust process (`pty_host.rs`) via the
spike-chosen crate, compiled into the existing Tauri MSI by `supervisor/tauri/scripts/build-and-update.ps1`.
The Bun sidecar carries only the thin `claude-pty-bridge.ts` relay; the Node `pty-host.mjs` detour is dropped
on Windows. No node-pty / portable-node resource staging is added to `supervisor/tauri/tauri.conf.json`.

**Fallback — Option A (bundled Node, spike FAILED):** revert to the Phase-15-proven packaging — a portable
`node.exe` + prebuilt `node-pty` + `pty-host.mjs` staged as Tauri resources. `build-and-update.ps1` stages
those resources and `supervisor/tauri/tauri.conf.json` lists them under `bundle.resources` so the compiled
sidecar can resolve the bundled node-pty at runtime (per the Phase-15 SPIKE-FINDINGS shipping contract).

The build-and-update.ps1 / tauri.conf.json resource-staging changes belong to whichever branch ships; on
Option C they are NOT added (no JS runtime bundled).
</packaging_and_shipping>

<verification>
- The Task-0 spike verdict is recorded in `16-SPIKE-FINDINGS-rust-conpty.md` (PASS → C / FAIL → A)
- The chosen-branch host contains the ANTHROPIC_API_KEY delete/remove and zero programmatic flags
- The host imports no RunnerEvent/agent-protocol/session-bridge/credentials path (grep, branch-agnostic)
- A dropped connection reattaches with scrollback intact (automated + manual on a live TUI)
- `bun run check-baseline` green
</verification>

<success_criteria>
A hosting decision proven by a Rust-ConPTY derisk spike, then a hardened interactive-claude PTY runner on
the chosen branch (Option C Rust-hosted primary / Option A bundled-Node fallback) with disconnect-surviving
persistence and scrollback replay, with the no-API-key / no-stream-json invariants locked behind a build-time
canary. Foundation for the authenticated relay (Plan 02) and mobile surface (Plan 03).
</success_criteria>

<output>
Create `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-01-SUMMARY.md` when done (record the
Task-0 verdict + chosen branch, the chosen Windows persistence mechanism + tmux availability finding +
ring-buffer cap, and — on Option C — the Bun↔Rust byte-channel mechanism).
</output>
</content>
</invoke>
