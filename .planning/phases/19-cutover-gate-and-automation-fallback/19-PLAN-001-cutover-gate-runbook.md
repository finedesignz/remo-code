---
phase: 19-cutover-gate-and-automation-fallback
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/cutover-gate-june15.md
  - .planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md
  - hub/test/cutover-gate-runbook.test.ts
autonomous: false
requirements:
  - R-PTY-21
must_haves:
  truths:
    - "A documented cutover-gate runbook encodes the four SPEC checks (PTY-interactive bucket; setup-token vs login; subagents/hooks/MCP residual; login-credential headless reclassification) as a measurement procedure using the Phase-18 dual-bucket poll"
    - "The gate is NOT a build blocker: Phases 15-18 ship before June 15; only the default-on flip is gated"
    - "The measurement is operator-recorded (snapshot -> controlled turn -> snapshot -> diff which bucket moved), not auto-asserted"
  artifacts:
    - path: "docs/cutover-gate-june15.md"
      provides: "the runbook + measurement procedure + decision rule"
    - path: ".planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md"
      provides: "machine-checkable checklist artifact (one row per check, result column)"
  key_links:
    - from: "runbook measurement step"
      to: "Phase-18 dual-bucket poll (subscription_usage snapshot)"
      via: "before/after snapshot diff of which bucket's used value moved"
      pattern: "snapshot -> one interactive PTY turn -> snapshot -> diff"
---

<objective>
Author the June-15 cutover-gate runbook + a checklist artifact: the four SPEC checks as a measurement
procedure driven by the Phase-18 dual-bucket poll, with an explicit decision rule (interactive ⇒ Claude
default; programmatic ⇒ Codex default). Not a build blocker — only the default-on flip is gated.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/19-cutover-gate-and-automation-fallback/19-CONTEXT.md
@.planning/phases/19-cutover-gate-and-automation-fallback/19-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@CLAUDE.md
</context>

<threat_model>
- **T-19-01 — Gate treated as a build blocker / or skipped (MED).** If the gate is misread as blocking
  the build, Phases 15-18 stall before June 15; if skipped, users get defaulted onto an unverified
  billing path. Mitigation: the runbook states explicitly it is NOT a build blocker and that the
  default-on flip (R-PTY-22) is the only gated action; a test asserts the checklist artifact exists and
  references the dual-bucket poll + all four checks. Block on: MED.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Write the runbook + checklist artifact</name>
  <files>docs/cutover-gate-june15.md, .planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md</files>
  <read_first>
    - .planning/architecture/interactive-pty-runner-SPEC.md (§"Verify after June 15", §"If PTY fails")
    - .planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md (the dual-bucket poll shape)
  </read_first>
  <acceptance_criteria>
    - docs/cutover-gate-june15.md documents the four checks, the snapshot→turn→snapshot→diff measurement procedure using the dual-bucket poll, the decision rule (interactive ⇒ Claude default; programmatic ⇒ Codex default), and that it is NOT a build blocker
    - The checklist artifact has one row per check with a result column (interactive/programmatic/unknown) to be filled post-June-15
    - The login-credential headless reclassification item is marked as an ONGOING watch, not a one-time check
  </acceptance_criteria>
  <action>
    Author both files. Keep the decision rule unambiguous. Reference the Phase-18 poll fields by name.
    The measurement is run later on a live account — this task only authors the procedure.
  </action>
  <verify>
    <automated>cd hub; bun test test/cutover-gate-runbook.test.ts 2>$null</automated>
  </verify>
  <done>The gate is documented + checkable; ready to run post-June-15.</done>
</task>

<task type="auto">
  <name>Task 2: Runbook-presence + reference test</name>
  <files>hub/test/cutover-gate-runbook.test.ts</files>
  <read_first>
    - docs/cutover-gate-june15.md, the checklist artifact
  </read_first>
  <acceptance_criteria>
    - Test asserts both files exist, the checklist has all four check rows, and the runbook references the dual-bucket poll + the not-a-build-blocker statement + the decision rule
  </acceptance_criteria>
  <action>
    A simple presence/content test (read the files, assert required headings/rows). Register in
    tools/regression-baseline.json if required.
  </action>
  <verify>
    <automated>cd hub; bun test test/cutover-gate-runbook.test.ts 2>$null</automated>
  </verify>
  <done>Runbook can't silently drift out of existence.</done>
</task>

</tasks>

<verification>
- runbook + checklist present; four checks encoded; decision rule explicit; not-a-build-blocker stated
- `bun run check-baseline` green
</verification>

<success_criteria>
A documented, checkable June-15 cutover gate that turns the four SPEC checks into a dual-bucket-poll
measurement with an unambiguous default-backend decision rule.
</success_criteria>

<output>
Create `.planning/phases/19-cutover-gate-and-automation-fallback/19-01-SUMMARY.md` (record the runbook +
checklist paths; note the measurement is pending a live post-June-15 account).
</output>
