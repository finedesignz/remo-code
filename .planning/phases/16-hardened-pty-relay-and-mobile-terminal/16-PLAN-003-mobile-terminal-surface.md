---
phase: 16-hardened-pty-relay-and-mobile-terminal
plan: 03
type: execute
wave: 3
depends_on:
  - 16-01
  - 16-02
files_modified:
  - web/src/components/TerminalSurface.tsx
  - web/src/hooks/useTerminalSession.ts
  - web/src/lib/term-ws.ts
  - web/test/no-indigo.test.ts
  - web/test/terminal-surface.test.tsx
autonomous: true
requirements:
  - R-PTY-09
must_haves:
  truths:
    - "A themed xterm.js TerminalSurface renders inside the existing React shell using --bg-primary/--text-primary and the blue accent (never indigo); app chrome (sidebar/nav/fonts) unchanged"
    - "Resize propagates cols/rows to the PTY via term.resize (FitAddon-computed) on container/orientation/keyboard-viewport change"
    - "Reconnect re-opens the WS, sends term.reattach, and replays scrollback into the xterm buffer"
    - "Scrollback works on mobile (touch-scroll) and desktop"
    - "no-indigo test stays green; the surface is opt-in for pty-interactive sessions and runs ALONGSIDE ChatSurface (no deletion this phase)"
  artifacts:
    - path: "web/src/components/TerminalSurface.tsx"
      provides: "Themed xterm.js panel (reconnect/resize/scrollback) for pty-interactive sessions"
    - path: "web/src/hooks/useTerminalSession.ts"
      provides: "term.* WS lifecycle: attach/reattach, data in/out, resize"
  key_links:
    - from: "xterm onData (keystrokes)"
      to: "term.input WS frame → hub relay → PTY stdin"
      via: "web/src/lib/term-ws.ts"
      pattern: "ws.send(term.input)"
    - from: "FitAddon cols/rows"
      to: "term.resize frame → claude-pty-runner.resize"
      via: "container/orientation observer"
      pattern: "term.resize {cols,rows}"
---

<objective>
Build the mobile-ready themed xterm.js terminal surface that renders the interactive `claude` TUI for a
pty-interactive session: reconnect (replay scrollback), resize (propagate cols/rows to the PTY), and
scrollback on mobile + desktop. App chrome and theme tokens are preserved; no indigo. This phase runs the
surface ALONGSIDE the existing ChatSurface (the rip is Phase 17) so it is proven before deletion.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-CONTEXT.md
@.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@web/src/components/ChatSurface.tsx
@web/src/components/ChatLayout.tsx
@web/src/hooks/useChatSurface.ts
@web/src/index.css
@web/test/no-indigo.test.ts
@CLAUDE.md

<interfaces>
From Phase 15: `@xterm/xterm` + `@xterm/addon-fit` installed; minimal panel + term.* frames proven.
From 16-PLAN-002: term-protocol.ts frame set (term.data/term.input/term.resize/term.attach/term.reattach) + authenticated relay.
From web/src/index.css: CSS custom properties `--bg-primary`, `--text-primary`, blue accent tokens.
Design prefs (~/.claude/design-preferences.md): accent=blue, orange CTA-only, NEVER indigo.
</interfaces>
</context>

<threat_model>
- **T-16-09 — Indigo/accent regression (LOW, CI-guarded).** A new component could reintroduce indigo.
  Mitigation: `web/test/no-indigo.test.ts` greps the web source and stays green.
- **T-16-10 — Stale scrollback / wrong-session render (MEDIUM).** On reconnect, replaying the wrong
  session's buffer or stale bytes could mislead the user about live state. Mitigation: reattach is keyed
  by session_id; the hook clears the xterm buffer before replay and only renders frames for the
  subscribed session. Test asserts a session switch clears prior buffer.
- **T-16-11 — Input leakage across sessions (MEDIUM).** Keystrokes must reach only the bound session's
  PTY. Mitigation: term.input carries the session_id; the authenticated relay (16-02) enforces
  subscription. Block on: none HIGH (relay auth is the boundary; covered in 16-02).
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: term-ws.ts + useTerminalSession hook — attach/reattach/resize lifecycle</name>
  <files>web/src/lib/term-ws.ts, web/src/hooks/useTerminalSession.ts</files>
  <read_first>
    - web/src/hooks/useChatSurface.ts (WS lifecycle pattern to mirror)
    - hub/src/ws/term-protocol.ts (frame shapes from 16-02)
  </read_first>
  <acceptance_criteria>
    - term-ws.ts opens/uses the authenticated client WS and sends/receives term.data/term.input/term.resize/term.attach/term.reattach
    - useTerminalSession handles: initial attach, reconnect → term.reattach → scrollback replay, resize → term.resize, teardown on unmount/session switch
    - On session switch the prior xterm buffer is cleared before replay (no cross-session bleed)
  </acceptance_criteria>
  <action>
    Implement the WS lib + hook mirroring useChatSurface's connection lifecycle but on the term.* frames.
    Buffer/replay scrollback on reattach. Key everything by session_id.
  </action>
  <verify>
    <automated>cd web; bun run tsc --noEmit 2>$null</automated>
  </verify>
  <done>Terminal WS lifecycle: attach, reconnect+replay, resize, clean teardown.</done>
</task>

<task type="auto">
  <name>Task 2: TerminalSurface.tsx — themed xterm.js panel, mobile resize/scrollback</name>
  <files>web/src/components/TerminalSurface.tsx</files>
  <read_first>
    - web/src/components/ChatSurface.tsx + ChatLayout.tsx (where the surface mounts; chrome to preserve)
    - web/src/index.css (CSS custom properties to map into xterm theme)
    - ~/.claude/design-preferences.md (accent=blue, never indigo)
  </read_first>
  <acceptance_criteria>
    - Renders xterm.js with theme mapped from `--bg-primary`/`--text-primary` + blue accent; no indigo literals
    - FitAddon computes cols/rows; container resize, orientation change, and mobile keyboard-viewport change all trigger term.resize
    - Touch-scroll and desktop scroll both reach xterm scrollback
    - Mounts for pty-interactive sessions inside the existing shell WITHOUT altering sidebar/nav/fonts; ChatSurface remains for stream-json sessions (no deletion)
  </acceptance_criteria>
  <action>
    Build the panel consuming useTerminalSession. Map CSS custom properties into the xterm `theme`
    option. Add a ResizeObserver + orientation/visualViewport listeners for mobile resize. Gate mounting
    on session.runner_type === 'pty-interactive'.
  </action>
  <verify>
    <automated>cd web; bun test test/terminal-surface.test.tsx test/no-indigo.test.ts 2>$null; bun run build 2>$null</automated>
  </verify>
  <done>Themed, mobile-ready terminal surface renders the TUI alongside ChatSurface; no indigo.</done>
</task>

</tasks>

<verification>
- TerminalSurface renders xterm.js with blue-accent theme tokens; `web/test/no-indigo.test.ts` green
- Resize propagates cols/rows; reconnect replays scrollback; touch-scroll works
- App chrome (sidebar/nav/fonts) unchanged; ChatSurface still present (rip is Phase 17)
- `cd web; bun run build` succeeds; `bun run check-baseline` green
</verification>

<success_criteria>
A themed, mobile-ready xterm.js terminal surface (reconnect/resize/scrollback) renders the interactive
`claude` TUI for pty-interactive sessions inside the existing shell, proven alongside ChatSurface so the
surface is mechanically validated before the Phase-17 rip (sequencing safeguard).
</success_criteria>

<output>
Create `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-03-SUMMARY.md` when done.
</output>
