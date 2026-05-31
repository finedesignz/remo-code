---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 02
type: execute
wave: 2
depends_on:
  - 17-01
files_modified:
  - web/src/components/ChatSurface.tsx
  - web/src/components/ChatSurfaceShowcase.tsx
  - web/src/components/ChatPanel.tsx
  - web/src/components/ChatLayout.tsx
  - web/src/components/GridPage.tsx
  - web/src/hooks/useChatSurface.ts
  - web/src/hooks/useChat.ts
  - web/test/no-human-chatsurface.test.tsx
  - web/test/no-indigo.test.ts
  - tools/regression-baseline.json
autonomous: false
requirements:
  - R-PTY-13
  - R-PTY-15
must_haves:
  truths:
    - "DELETIONS begin ONLY after Phase 15–16 verification has passed (terminal surface proven) — the one-way-door safeguard"
    - "ChatSurface (full/cell/mobile-expanded), the structured activity-bubble rendering (thinking/text_delta/tool_use/tool_result), and the human-chat hooks are removed from web/src"
    - "ALL human sessions (Claude AND Codex) render on the Phase-16 TerminalSurface; grid/list views host terminal cells or drop conversation rendering"
    - "App chrome (sidebar/nav/fonts/theme) and the blue accent are preserved; no-indigo stays green"
    - "A test asserts NO ChatSurface/structured-bubble render path remains for human sessions"
  artifacts:
    - path: "web/test/no-human-chatsurface.test.tsx"
      provides: "Static/render assertion that the human chat UI is gone"
  key_links:
    - from: "human session route (Claude or Codex)"
      to: "TerminalSurface (Phase 16)"
      via: "ChatLayout/GridPage conversation region replaced by terminal"
      pattern: "runner_type='pty-interactive' renders TerminalSurface only"
---

<objective>
Execute the destructive half of the rip: DELETE the stream-json human chat UI (ChatSurface + structured
activity-bubble rendering + feeding hooks) from `web/src`, and route ALL human sessions to the single
Phase-16 themed xterm.js terminal surface. The shell chrome, theme tokens, and blue accent are preserved.
This is a ONE-WAY DOOR — it begins ONLY after Phase 15–16 verification confirms the terminal surface works.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-CONTEXT.md
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@web/src/components/ChatSurface.tsx
@web/src/components/ChatLayout.tsx
@web/src/components/GridPage.tsx
@web/src/components/TerminalSurface.tsx
@web/src/hooks/useChatSurface.ts
@web/test/no-indigo.test.ts
@CLAUDE.md

<interfaces>
From Phase 16: TerminalSurface.tsx + useTerminalSession.ts (the surviving human surface); runner_type per session.
From web/src/components/ChatLayout.tsx + GridPage.tsx: the conversation region to replace + the chrome (sidebar/nav) to keep.
From ~/.claude/design-preferences.md: accent=blue, never indigo.
</interfaces>
</context>

<threat_model>
- **T-17-04 — Premature deletion before the surface is proven (CRITICAL, one-way door).** Deleting
  ChatSurface before Phases 15–16 verification passes could leave NO working human UI. Mitigation: this
  plan's GATE precondition — deletions begin only after the Phase-16 VERIFICATION ship-verdict is PASS
  (autonomous:false; operator-confirmed). The Codex runner (17-01) and surface (Phase 16) exist first.
- **T-17-05 — Deleting shared chrome / non-UI logic (HIGH).** ChatLayout/GridPage host sidebar/nav and
  now the terminal. Mitigation: remove ONLY the conversation/bubble rendering region; keep the shell.
  `web/test/no-indigo.test.ts` + `bun run build` + a manual smoke confirm chrome intact.
- **T-17-06 — Accent regression during refactor (LOW, CI-guarded).** Mitigation: no-indigo test green.
  Block on: CRITICAL (the sequencing gate).
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: GATE — confirm Phase 15–16 verification PASS before any deletion</name>
  <files>.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-02-PRECHECK.md</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VALIDATION.md (manual proofs)
    - the Phase-16 VERIFICATION ship-verdict (gsd-verify-work output)
  </read_first>
  <acceptance_criteria>
    - A precheck note records that Phase 16's VERIFICATION verdict is PASS (terminal surface functional + proven: render fidelity, input injection, reattach/persistence, mobile resize/scrollback, authenticated relay, human-only guard)
    - If verification is not PASS, this plan HALTS — no deletions occur
  </acceptance_criteria>
  <action>
    Verify the Phase-16 ship-verdict is PASS and the manual reattach + mobile proofs are done. Record in
    17-02-PRECHECK.md. This is the autonomous:false one-way-door checkpoint — operator confirms before
    deletions proceed.
  </action>
  <verify>
    <automated>test -f .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VALIDATION.md</automated>
    Operator confirms Phase-16 verdict = PASS in 17-02-PRECHECK.md.
  </verify>
  <done>The one-way door is unlocked only after the surface is proven.</done>
</task>

<task type="auto">
  <name>Task 2: Route all human sessions to TerminalSurface; remove bubble rendering region</name>
  <files>web/src/components/ChatLayout.tsx, web/src/components/GridPage.tsx, web/src/components/ChatPanel.tsx</files>
  <read_first>
    - web/src/components/ChatLayout.tsx + GridPage.tsx (conversation region vs chrome boundary)
    - web/src/components/TerminalSurface.tsx (the replacement)
  </read_first>
  <acceptance_criteria>
    - The conversation region for human sessions renders TerminalSurface only; the structured activity-bubble rendering (thinking/text_delta/tool_use/tool_result) is removed
    - Grid/list views host terminal cells OR drop conversation rendering (planner's smallest-diff choice), consistent with one surface
    - Sidebar/nav/fonts/theme chrome preserved; the app still builds and renders
  </acceptance_criteria>
  <action>
    Replace the bubble/conversation region with TerminalSurface in ChatLayout and GridPage. Decide
    grid: terminal-cells vs drop-rendering (record choice in SUMMARY). Keep all chrome.
  </action>
  <verify>
    <automated>cd web; bun run tsc --noEmit 2>$null; bun run build 2>$null</automated>
  </verify>
  <done>Every human session renders on the single terminal surface; chrome intact.</done>
</task>

<task type="auto">
  <name>Task 3: Delete ChatSurface + bubble components + feeding hooks; assert none remain for human sessions</name>
  <files>web/src/components/ChatSurface.tsx, web/src/components/ChatSurfaceShowcase.tsx, web/src/hooks/useChatSurface.ts, web/src/hooks/useChat.ts, web/test/no-human-chatsurface.test.tsx, web/test/no-indigo.test.ts, tools/regression-baseline.json</files>
  <read_first>
    - web/src/components/ChatSurface.tsx (+ variants) and the hooks (what's human-UI-only vs shared)
    - web/test/no-indigo.test.ts
  </read_first>
  <acceptance_criteria>
    - ChatSurface.tsx, ChatSurfaceShowcase.tsx, the bubble components, and useChatSurface.ts are deleted; useChat.ts has any human-bubble-only logic removed
    - no-human-chatsurface.test.tsx asserts (static + render) that no ChatSurface/structured-bubble render path remains for human sessions
    - no-indigo test stays green; baseline updated for deleted human-UI tests; no PRESERVED path regresses
    - `cd web; bun run build` succeeds
  </acceptance_criteria>
  <action>
    Delete the human chat UI files. Add no-human-chatsurface.test.tsx (grep for ChatSurface import on
    human-session routes + render assertion). Update tools/regression-baseline.json for removed tests.
    Run check-baseline.
  </action>
  <verify>
    <automated>cd web; bun test test/no-human-chatsurface.test.tsx test/no-indigo.test.ts 2>$null; bun run build 2>$null</automated>
    `grep -rn "ChatSurface" web/src` returns nothing on human-session render paths.
  </verify>
  <done>The stream-json human chat UI is gone; one terminal surface remains; no-indigo green.</done>
</task>

</tasks>

<verification>
- Phase-16 verdict PASS recorded BEFORE deletions (one-way-door gate)
- No ChatSurface/structured-bubble path remains for human sessions (test + grep)
- All human sessions render TerminalSurface; chrome/theme/blue-accent preserved; no-indigo green
- `cd web; bun run build` succeeds; `bun run check-baseline` green
</verification>

<success_criteria>
The stream-json human chat UI is deleted and ALL human sessions (Claude + Codex) render on the single
themed terminal surface, with the deletion gated behind the proven-surface checkpoint (sequencing
safeguard) and the app shell + theme intact.
</success_criteria>

<output>
Create `.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-02-SUMMARY.md` when done
(record the grid decision + the exact deleted files).
</output>
