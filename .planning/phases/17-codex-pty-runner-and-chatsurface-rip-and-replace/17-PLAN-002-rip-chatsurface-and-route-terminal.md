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
  - tools/cutover-deletion-gate.mjs
  - web/test/cutover-deletion-gate.test.ts
autonomous: false
requirements:
  - R-PTY-13
  - R-PTY-15
  - R-PTY-13b
must_haves:
  truths:
    - "DELETIONS begin ONLY after Phase 15–16 verification has passed (terminal surface proven) — the one-way-door safeguard"
    - "The gate is MECHANICAL: a script reads the Phase-16 ship-verdict artifact and exits non-zero (aborting the deletion task) unless it records verdict=PASS AND explicit manual render-fidelity + mobile-reattach PASS fields — a CI-green-but-renders-wrong surface CANNOT unlock the rip"
    - "ChatSurface (full/cell/mobile-expanded), the structured activity-bubble rendering (thinking/text_delta/tool_use/tool_result), and the human-chat hooks are removed from web/src"
    - "ALL human sessions (Claude AND Codex) render on the Phase-16 TerminalSurface; grid/list views host terminal cells or drop conversation rendering"
    - "App chrome (sidebar/nav/fonts/theme) and the blue accent are preserved; no-indigo stays green"
    - "A test asserts NO ChatSurface/structured-bubble render path remains for human sessions"
  artifacts:
    - path: "web/test/no-human-chatsurface.test.tsx"
      provides: "Static/render assertion that the human chat UI is gone"
    - path: "tools/cutover-deletion-gate.mjs"
      provides: "Machine-verifiable one-way-door gate: parses the Phase-16 ship-verdict artifact, exits non-zero unless verdict=PASS + required manual PASS fields present"
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
  ChatSurface before Phases 15–16 verification passes could leave NO working human UI. Mitigation: a
  TWO-LAYER gate. Layer 1 (NEW, mechanical, H4): `tools/cutover-deletion-gate.mjs` READS the Phase-16
  ship-verdict artifact (`16-VERIFICATION.md` or the gsd-verify-work verdict file) and exits non-zero —
  ABORTING the deletion task in Task 3 — unless that file records `verdict: PASS` AND the explicit manual
  PASS fields (`render_fidelity: PASS`, `mobile_reattach: PASS`). A missing file, a `FAIL`/`PARTIAL`
  verdict, or absent manual fields all abort. This closes the prior gap where the gate was only a
  narrative note that an operator could wave through (and where a CI-green-but-renders-wrong surface
  could trigger the rip). Layer 2 (existing): the `autonomous:false` operator checkpoint in Task 1.
- **T-17-04b — Deletion task runs despite a failed/absent gate (CRITICAL, NEW).** If Task 3 ran without
  invoking the gate, the mechanical check is moot. Mitigation: Task 3's FIRST action is
  `node tools/cutover-deletion-gate.mjs` and it MUST hard-abort (non-zero ⇒ task fails) before any `rm`/
  delete; `web/test/cutover-deletion-gate.test.ts` proves the gate aborts on missing/`FAIL`/manual-field-
  absent verdicts and passes only on a fully-green verdict fixture.
- **T-17-05 — Deleting shared chrome / non-UI logic (HIGH).** ChatLayout/GridPage host sidebar/nav and
  now the terminal. Mitigation: remove ONLY the conversation/bubble rendering region; keep the shell.
  `web/test/no-indigo.test.ts` + `bun run build` + a manual smoke confirm chrome intact.
- **T-17-06 — Accent regression during refactor (LOW, CI-guarded).** Mitigation: no-indigo test green.
  Block on: CRITICAL (the sequencing gate).
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: MECHANICAL GATE — a script that reads the Phase-16 ship-verdict and aborts deletion unless PASS+manual-fields</name>
  <files>tools/cutover-deletion-gate.mjs, web/test/cutover-deletion-gate.test.ts</files>
  <read_first>
    - .planning/phases/16-hardened-pty-relay-and-mobile-terminal/16-VALIDATION.md (manual proofs)
    - the Phase-16 VERIFICATION ship-verdict artifact (gsd-verify-work output — the canonical filename/path
      Phase 16 emits, e.g. `16-VERIFICATION.md`; confirm exact name at execution and pin it in the gate)
  </read_first>
  <acceptance_criteria>
    - `tools/cutover-deletion-gate.mjs` reads the Phase-16 ship-verdict artifact at a FIXED, documented path
      and parses three required signals: (1) `verdict: PASS` (top-level ship verdict), (2) a manual
      `render_fidelity: PASS` field, (3) a manual `mobile_reattach: PASS` field. (Field names pinned in the
      script; Phase-16 H5/verification must emit them — cross-ref the Phase-16 VALIDATION manual-proof rows.)
    - The script EXITS NON-ZERO (aborting the caller) when ANY of: the verdict file is MISSING, verdict is
      `FAIL`/`PARTIAL`/absent, OR either manual PASS field is missing/not `PASS`. It exits 0 ONLY when all
      three are present and PASS. It prints the parsed values + the resolved verdict-file path (immutable
      evidence) on both paths.
    - `web/test/cutover-deletion-gate.test.ts` drives the script against fixtures: (a) fully-green verdict ⇒ exit 0;
      (b) missing file ⇒ non-zero; (c) `verdict: FAIL` ⇒ non-zero; (d) `verdict: PASS` but `mobile_reattach` absent ⇒ non-zero;
      (e) `verdict: PASS` but `render_fidelity: FAIL` ⇒ non-zero. (A CI-green-but-renders-wrong surface is rejected by (e).)
    - tsc/test green; the test is registered in tools/regression-baseline.json
  </acceptance_criteria>
  <action>
    Write the gate as a standalone Node ESM script (no deps) so Task 3 can invoke it as a hard precondition.
    Parse the Phase-16 verdict artifact (YAML frontmatter or a `### Ship verdict` block — match Phase-16's
    actual emit shape; pin the exact field discriminators). Author the test with the five fixtures above.
    This is the mechanical Layer-1 gate; the autonomous:false operator checkpoint (below) remains as Layer 2.
  </action>
  <verify>
    <automated>cd web; bun test test/cutover-deletion-gate.test.ts 2>$null</automated>
    Layer 2: operator confirms the Phase-16 verdict before proceeding (autonomous:false).
  </verify>
  <done>The one-way door is unlocked only by a machine-checked PASS+manual-fields verdict — not a note an operator can wave through.</done>
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
    - PRECONDITION: `node tools/cutover-deletion-gate.mjs` exits 0 (mechanical gate, Task 1). If it exits non-zero, this task aborts with ZERO deletions.
    - ChatSurface.tsx, ChatSurfaceShowcase.tsx, the bubble components, and useChatSurface.ts are deleted; useChat.ts has any human-bubble-only logic removed
    - no-human-chatsurface.test.tsx asserts (static + render) that no ChatSurface/structured-bubble render path remains for human sessions
    - no-indigo test stays green; baseline updated for deleted human-UI tests; no PRESERVED path regresses
    - `cd web; bun run build` succeeds
  </acceptance_criteria>
  <action>
    FIRST: run `node tools/cutover-deletion-gate.mjs` (Task 1). If it exits non-zero, HARD-ABORT this task —
    perform NO deletions. Only on exit 0 proceed. Then delete the human chat UI files. Add
    no-human-chatsurface.test.tsx (grep for ChatSurface import on human-session routes + render assertion).
    Update tools/regression-baseline.json for removed tests. Run check-baseline.
  </action>
  <verify>
    <automated>node tools/cutover-deletion-gate.mjs; cd web; bun test test/no-human-chatsurface.test.tsx test/no-indigo.test.ts 2>$null; bun run build 2>$null</automated>
    `grep -rn "ChatSurface" web/src` returns nothing on human-session render paths.
  </verify>
  <done>The stream-json human chat UI is gone; one terminal surface remains; no-indigo green.</done>
</task>

</tasks>

<verification>
- `tools/cutover-deletion-gate.mjs` exits 0 (mechanical PASS+manual-fields check) BEFORE any deletion; `web/test/cutover-deletion-gate.test.ts` proves it aborts on missing/FAIL/manual-field-absent verdicts
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
