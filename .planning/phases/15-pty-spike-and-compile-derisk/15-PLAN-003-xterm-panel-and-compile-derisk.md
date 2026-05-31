---
phase: 15-pty-spike-and-compile-derisk
plan: 03
type: execute
wave: 3
depends_on:
  - 15-02
files_modified:
  - web/package.json
  - web/src/components/TerminalSurface.tsx
  - web/src/components/ChatLayout.tsx
  - supervisor/tauri/scripts/build-and-update.ps1
  - .planning/phases/15-pty-spike-and-compile-derisk/15-SPIKE-FINDINGS.md
autonomous: false
requirements:
  - R-PTY-04
  - R-PTY-05
must_haves:
  truths:
    - "A themed xterm.js TerminalSurface renders PTY output and sends keystrokes/resize over the term channel"
    - "The panel uses theme tokens (--bg-primary/--text-primary, blue accent); no indigo; app chrome unchanged"
    - "The node-pty native addon is demonstrated to ship and run from the bun build --compile sidecar via a chosen approach (a/b/c)"
    - "SPIKE-FINDINGS.md documents the chosen compile-shipping approach as the Phase-16 contract"
  artifacts:
    - path: "web/src/components/TerminalSurface.tsx"
      provides: "Themed xterm.js panel wired to the raw-terminal WS channel"
    - path: ".planning/phases/15-pty-spike-and-compile-derisk/15-SPIKE-FINDINGS.md"
      provides: "node-pty / bun-compile shipping decision + proof, consumed by Phase 16"
  key_links:
    - from: "TerminalSurface xterm onData"
      to: "term.input frame on /ws/client"
      via: "existing client WS send"
      pattern: "term.input"
---

<objective>
Render the raw-terminal session in a themed xterm.js panel inside the existing React shell (R-PTY-05),
and DERISK the named blocker: prove node-pty ships and runs from a `bun build --compile` sidecar and write
the chosen approach into SPIKE-FINDINGS.md as the Phase-16 contract (R-PTY-04).

Purpose: closes the spike — a human can drive interactive `claude` in the browser terminal, and the team
knows exactly how the PTY host will ship in the compiled supervisor.

Output: a working themed terminal panel + a documented, demonstrated compile-shipping approach.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-CONTEXT.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md
@.planning/phases/15-pty-spike-and-compile-derisk/15-02-SUMMARY.md
@web/src/components/ChatLayout.tsx
@web/src/components/ChatSurface.tsx
@web/test/no-indigo.test.ts
@hub/src/ws/term-protocol.ts
@supervisor/tauri/scripts/build-and-update.ps1
@CLAUDE.md

<interfaces>
- web has no xterm dep today; add @xterm/xterm + @xterm/addon-fit.
- Theme tokens are CSS custom properties (--bg-primary, --text-primary). Accent = blue; never indigo
  (web/test/no-indigo.test.ts greps source).
- Sidecar is built by `bun build --compile` (invoked from supervisor/tauri/scripts/build-and-update.ps1).
- term.* frames: term.data (out), term.input (in), term.resize (in) — from hub/src/ws/term-protocol.ts.
</interfaces>
</context>

<threat_model>
- **T-15-05 — theme/branding regression (LOW).** Introducing indigo or hard-coded colors. Mitigation:
  map xterm theme from CSS tokens; web/test/no-indigo.test.ts stays green.
- **T-15-06 — shipping a Node/PTY helper widens attack surface (MEDIUM, design note).** If approach (b)
  helper-exe is chosen, the helper must only accept local connections and only host PTYs for the
  authenticated supervisor process. Mitigation: document the trust boundary in SPIKE-FINDINGS; full
  hardening is Phase 16. Spike helper binds localhost only.
Block on: HIGH (none here; documented mediums carried to Phase 16).
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Add xterm.js and build the themed TerminalSurface panel</name>
  <files>web/package.json, web/src/components/TerminalSurface.tsx</files>
  <read_first>
    - web/src/components/ChatSurface.tsx (how a session surface mounts + receives session_id + WS access)
    - web/src/components/ChatLayout.tsx (where a conversation surface is placed in the shell)
    - web/test/no-indigo.test.ts (forbidden color list)
  </read_first>
  <acceptance_criteria>
    - web/package.json depends on @xterm/xterm and @xterm/addon-fit
    - TerminalSurface.tsx mounts an xterm Terminal, writes incoming term.data bytes, sends term.input on keystroke (onData), sends term.resize via FitAddon on container resize
    - xterm theme background/foreground are derived from --bg-primary/--text-primary; no indigo hex/utility appears
    - `bun test web/test/no-indigo.test.ts` exits 0
  </acceptance_criteria>
  <action>
    `bun add @xterm/xterm @xterm/addon-fit` in web/. Create `web/src/components/TerminalSurface.tsx`:
    construct a `Terminal` with a `theme` whose `background`/`foreground` read from the resolved CSS
    custom properties (`getComputedStyle(document.documentElement).getPropertyValue('--bg-primary')`
    etc.), load FitAddon, subscribe to the client WS for `term.data` frames matching the session_id and
    `term.write` them (base64-decode), wire `term.onData(d => sendTermInput(sessionId, d))`, and on
    container/window resize call `fitAddon.fit()` then `sendTermResize(sessionId, cols, rows)`. Import
    xterm CSS. Do NOT restyle app chrome.
  </action>
  <verify>
    <automated>cd web; bun test test/no-indigo.test.ts 2>$null; bun run build 2>$null</automated>
    `grep -nE "@xterm/xterm|@xterm/addon-fit" web/package.json` returns hits. Build succeeds.
  </verify>
  <done>Themed xterm.js panel exists and is wired to the term channel; no-indigo green.</done>
</task>

<task type="auto">
  <name>Task 2: Mount TerminalSurface for a PTY-interactive session in the shell</name>
  <files>web/src/components/ChatLayout.tsx</files>
  <read_first>
    - web/src/components/ChatLayout.tsx (how the active session's surface is chosen + rendered)
    - web/src/components/TerminalSurface.tsx (props it needs: sessionId)
  </read_first>
  <acceptance_criteria>
    - When the active session is PTY-interactive (spike: an explicit flag/toggle is acceptable), ChatLayout renders TerminalSurface instead of ChatSurface
    - Sidebar/nav/theme are unchanged; only the conversation surface swaps
    - Non-PTY sessions still render ChatSurface (no regression — full ChatSurface deletion is Phase 17)
  </acceptance_criteria>
  <action>
    In ChatLayout.tsx, branch on a session's runner type (spike may read a per-session flag or a dev
    toggle): PTY-interactive renders `<TerminalSurface sessionId=... />`; everything else renders the
    existing `<ChatSurface .../>` untouched. Keep the swap surgical — do not begin deleting ChatSurface
    (that is Phase 17, the rip-and-replace).
  </action>
  <verify>
    <automated>cd web; bun run build 2>$null</automated>
    Manual: toggling a session to PTY mode shows the terminal; non-PTY sessions still show chat bubbles.
  </verify>
  <done>The shell hosts the terminal panel for PTY sessions without disturbing existing chat.</done>
</task>

<task type="auto-with-checkpoint">
  <name>Task 3: Derisk + document node-pty in the bun build --compile sidecar (R-PTY-04)</name>
  <files>supervisor/tauri/scripts/build-and-update.ps1, .planning/phases/15-pty-spike-and-compile-derisk/15-SPIKE-FINDINGS.md</files>
  <read_first>
    - supervisor/tauri/scripts/build-and-update.ps1 (the existing `bun build --compile` sidecar step)
    - .planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md (three shipping options a/b/c)
    - supervisor/src/runners/claude-pty-runner.ts (the consumer of node-pty)
  </read_first>
  <acceptance_criteria>
    - The node-pty native addon is demonstrated to LOAD and RUN from a built sidecar context via a chosen approach: (a) native module shipped beside the exe, (b) helper exe hosting the PTY, or (c) out-of-band PTY host
    - The build script (or a documented manual step) places/loads the native artifact so the compiled sidecar can spawn a PTY
    - 15-SPIKE-FINDINGS.md records: which approach worked, why the others were rejected, the exact files/steps, the trust boundary if a helper is used, and the concrete Phase-16 contract
    - A PTY turn is exercised THROUGH the built sidecar at least once (not only `bun run` source)
  </acceptance_criteria>
  <action>
    Attempt approach (a) first: keep `node-pty` external from the compiled blob (Bun `--external node-pty`
    or equivalent), ship `pty.node` + the node-pty JS next to the sidecar exe, resolve it at runtime via a
    path relative to the executable. Build the sidecar and try to spawn a PTY through it. If Bun cannot
    load the addon, fall to approach (b): add a tiny helper executable (prebuilt Node or compiled binary)
    that hosts the PTY and speaks the term byte protocol over stdio/local socket to the Bun sidecar; wire
    the sidecar to launch/connect to it. Whichever works, update build-and-update.ps1 so the artifact is
    staged with the sidecar, and write 15-SPIKE-FINDINGS.md as the authoritative Phase-16 shipping
    contract. This task is `autonomous:false` — pause for operator confirmation of the chosen approach
    before committing the build-script change if it materially changes the MSI packaging.
  </action>
  <verify>
    <automated>pwsh -File supervisor/tauri/scripts/build-and-update.ps1 -WhatIf 2>$null</automated>
    Manual checkpoint: launch the built sidecar, trigger a PTY turn, confirm node-pty loads and the TUI
    streams. Record the working approach + steps in 15-SPIKE-FINDINGS.md.
  </verify>
  <done>The compile blocker is derisked with a working, documented shipping approach for Phase 16.</done>
</task>

</tasks>

<verification>
- xterm.js panel renders interactive claude; keystrokes + resize propagate; no-indigo green; web build green
- node-pty runs from a built sidecar via a documented approach (a/b/c)
- 15-SPIKE-FINDINGS.md exists and states the Phase-16 shipping contract
- `bun run check-baseline` green
</verification>

<success_criteria>
A human drives interactive `claude` in a themed browser terminal end-to-end, and the team has a proven,
documented answer to "how does node-pty ship in the compiled sidecar" — the milestone's two real risks
are retired. Phase 16 can productionize against SPIKE-FINDINGS.
</success_criteria>

<output>
Create `.planning/phases/15-pty-spike-and-compile-derisk/15-03-SUMMARY.md` when done.
Also create `.planning/phases/15-pty-spike-and-compile-derisk/15-SPIKE-FINDINGS.md` (Phase-16 contract).
</output>
