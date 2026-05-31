---
phase: 19-cutover-gate-and-automation-fallback
plan: 02
type: execute
wave: 2
depends_on:
  - 19-01
files_modified:
  - supervisor/src/runners/backend-selector.ts
  - supervisor/src/runners/index.ts
  - supervisor/test/default-backend-selector.test.ts
files_modified_note: "exact runner-registry paths = discretion; selector lives where human-session runner choice is made"
autonomous: false
requirements:
  - R-PTY-22
must_haves:
  truths:
    - "A default-backend selector governs which runner a NEW human session uses ('claude' | 'codex')"
    - "FAIL-SAFE default: until the cutover gate confirms PTY-interactive billing, the default human backend is NOT Claude-PTY (so users are never silently put on a programmatic-billed path)"
    - "The flip to Claude-PTY-default is a recorded config change gated on the runbook result — NOT an automatic behavior"
  artifacts:
    - path: "supervisor/src/runners/backend-selector.ts"
      provides: "default_human_backend resolution + the gated-flip decision record"
  key_links:
    - from: "new human session spawn"
      to: "backend-selector.resolve() -> claude-pty-runner | codex-pty-runner"
      via: "default_human_backend config gated on the cutover-gate result"
      pattern: "confirmedInteractive ? configuredDefault : 'codex' (fail-safe)"
---

<objective>
Wire the default-backend selector so the green-light only flips human sessions onto Claude-PTY-default
AFTER the cutover gate confirms interactive billing. Fail safe until then: do not default users onto a
programmatic-billed path.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/19-cutover-gate-and-automation-fallback/19-CONTEXT.md
@.planning/phases/19-cutover-gate-and-automation-fallback/19-RESEARCH.md
@supervisor/src/runners/types.ts
@CLAUDE.md
</context>

<threat_model>
- **T-19-02 — Silent default onto a programmatic-billed backend (CRITICAL).** If the selector defaults
  new human sessions to Claude-PTY before the gate confirms interactive billing — and Claude-via-PTY
  turns out to bill programmatic — every human session silently drains the credit pool. Mitigation:
  fail-safe — until a recorded `cutover_gate.claude_interactive_confirmed` flag is set, the default is
  NOT Claude-PTY; the flip is an explicit recorded config change, never automatic; a negative test
  asserts the unconfirmed default is not Claude-PTY. Block on: CRITICAL.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Backend selector with fail-safe default</name>
  <files>supervisor/src/runners/backend-selector.ts, supervisor/src/runners/index.ts</files>
  <read_first>
    - supervisor/src/runners/types.ts (cliKind union; runner registry shape)
    - supervisor/src/runners/index.ts (where a runner is chosen for a session)
  </read_first>
  <acceptance_criteria>
    - `backend-selector.ts` exports `resolveHumanBackend(ctx)` → 'claude' | 'codex', reading a config (`default_human_backend`) AND a gate flag (`claude_interactive_confirmed`)
    - When the gate flag is NOT set, resolve returns the fail-safe (Codex, or an explicitly chosen non-Claude default) regardless of config — never Claude-PTY by accident
    - When the flag IS set, resolve honors the configured default
    - The selector governs ONLY human sessions; automation does not use it (automation is stream-json/programmatic)
    - tsc passes
  </acceptance_criteria>
  <action>
    Implement the resolver + the config/flag plumbing (config storage = discretion; the gate flag is a
    recorded value set by the operator after the runbook, NOT auto). Wire the human-session spawn to
    call it.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/default-backend-selector.test.ts 2>$null</automated>
  </verify>
  <done>Human backend selection is gated + fail-safe.</done>
</task>

<task type="auto">
  <name>Task 2: Fail-safe + gated-flip tests</name>
  <files>supervisor/test/default-backend-selector.test.ts</files>
  <read_first>
    - supervisor/src/runners/backend-selector.ts
  </read_first>
  <acceptance_criteria>
    - Test: gate flag unset ⇒ resolve never returns 'claude' even if config says claude (fail-safe, negative)
    - Test: gate flag set + config 'claude' ⇒ resolve returns 'claude'; gate flag set + config 'codex' ⇒ 'codex'
    - Test: the flag is not flipped by any automatic code path (it is operator-set) — assert no production code writes it
  </acceptance_criteria>
  <action>
    Author the tests; the "no auto-flip" assertion can grep the codebase for writes to the flag and
    assert they are only in operator/config tooling, not the runtime.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/default-backend-selector.test.ts 2>$null</automated>
  </verify>
  <done>The fail-safe + gated-flip behavior is regression-locked.</done>
</task>

</tasks>

<verification>
- unconfirmed gate ⇒ default ≠ Claude-PTY (negative)
- confirmed gate ⇒ configured default honored
- flag is operator-set, not auto-flipped
- `bun run check-baseline` green
</verification>

<success_criteria>
New human sessions never silently land on a programmatic-billed backend; Claude-PTY-default is reached
only via a recorded, gate-confirmed config flip.
</success_criteria>

<output>
Create `.planning/phases/19-cutover-gate-and-automation-fallback/19-02-SUMMARY.md` (record the selector
config key + the gate flag location).
</output>
