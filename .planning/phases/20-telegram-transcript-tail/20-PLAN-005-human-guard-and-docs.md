---
phase: 20-telegram-transcript-tail
plan: 05
type: execute
wave: 4
depends_on:
  - 20-02
  - 20-03
  - 20-04
files_modified:
  - hub/src/telegram/dispatch.ts
  - hub/test/telegram-human-only-guard.test.ts
  - docs/telegram-bridge.md
  - CLAUDE.md
files_modified_note: "run `bun run docs:sync` only if endpoints changed"
autonomous: true
requirements:
  - R-TG-11
  - R-TG-12
must_haves:
  truths:
    - "Telegram injection passes through the Phase-16 human-only dispatch guard: a real human Telegram message is allowed; auto-nudge/scheduled/automation tagged as Telegram-origin is rejected"
    - "docs/telegram-bridge.md describes the transcript-tail source, per-backend adapters, fail-closed permission-injection, and the write-arbitration turn lock"
    - "CLAUDE.md Docs map row for telegram-bridge is updated; docs:sync run if endpoints changed"
  artifacts:
    - path: "docs/telegram-bridge.md"
      provides: "Updated Telegram bridge doc for the transcript-tail era"
  key_links:
    - from: "telegram dispatch → humanOnlyDispatchGuard(source)"
      to: "PTY injection only for genuine human turns"
      via: "Phase-16 guard (R-PTY-10)"
      pattern: "if (isAutomationSource(source)) reject"
---

<objective>
Close the ToS loop and the docs. Telegram injection rides the Phase-16 human-only guard so it can never
be combined with automation to drive the PTY unattended. Then document the whole transcript-tail era.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/20-telegram-transcript-tail/20-CONTEXT.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/telegram/dispatch.ts
@docs/telegram-bridge.md
@CLAUDE.md
</context>

<threat_model>
- **T-20-13 — Automation drives the PTY via Telegram (HIGH, ToS).** Constraint 3: only genuine human
  turns touch the PTY. If auto-nudge or a scheduled prompt could be routed through the Telegram
  injection path, that is "robot pressing enter via the interactive entrypoint" — the ban-risk move.
  Mitigation: every Telegram injection is tagged with its dispatch source and passes the Phase-16
  human-only guard (R-PTY-10); automation-tagged Telegram-origin dispatch is rejected. Test asserts it.
  Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Route Telegram injection through the human-only guard</name>
  <files>hub/src/telegram/dispatch.ts, hub/test/telegram-human-only-guard.test.ts</files>
  <read_first>
    - hub/src/telegram/dispatch.ts (current Telegram inbound dispatch)
    - the Phase-16 human-only guard (R-PTY-10) entrypoint
  </read_first>
  <acceptance_criteria>
    - A genuine human Telegram message injects to the PTY (allowed)
    - An automation-sourced dispatch tagged as Telegram-origin (auto-nudge / scheduled) is rejected by the guard and injects nothing
    - The rejection path is logged
  </acceptance_criteria>
  <action>
    Ensure Telegram inbound dispatch carries a `source` tag and passes through the Phase-16 human-only
    guard before any PTY injection (both text turns and permission responses). Reuse the guard; do not
    fork a Telegram-specific bypass.
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-human-only-guard.test.ts 2>$null</automated>
  </verify>
  <done>Telegram can drive the PTY only with a genuine human turn; automation is blocked.</done>
</task>

<task type="auto">
  <name>Task 2: Docs — transcript-tail era</name>
  <files>docs/telegram-bridge.md, CLAUDE.md</files>
  <read_first>
    - docs/telegram-bridge.md (current Phase-12 description)
    - CLAUDE.md (Docs map row for Telegram bridge)
  </read_first>
  <acceptance_criteria>
    - docs/telegram-bridge.md documents: the Phase-17 break + Phase-20 rebuild; the backend-agnostic TranscriptSource (Claude projects JSONL / Codex rollout JSONL + scrape fallback, both undocumented/unstable); fail-closed permission/user_question keystroke-injection keyed by (sessionId,requestId); the per-session write-arbitration turn lock; the human-only-guard ToS line; no-API-key invariant
    - CLAUDE.md Docs map telegram-bridge one-liner updated to mention transcript-tail
    - `bun run docs:sync` run ONLY if endpoints changed (note in SUMMARY whether it was needed)
  </acceptance_criteria>
  <action>
    Rewrite the Telegram bridge doc for the transcript-tail era; update the CLAUDE.md Docs map row.
    Keep it source-of-truth and reconciled with the SPEC + REQUIREMENTS (R-TG-01..12).
  </action>
  <verify>
    <automated>cd hub; bun run check-baseline 2>$null</automated>
    Docs-drift CI green; no stale `assistant_message:final`-only description remains.
  </verify>
  <done>Docs reflect the transcript-tail Telegram architecture; no drift.</done>
</task>

</tasks>

<verification>
- Automation-tagged Telegram dispatch rejected; human message allowed
- docs/telegram-bridge.md + CLAUDE.md updated; docs-drift CI green
- `bun run check-baseline` green
</verification>

<success_criteria>
Telegram on transcript-tail is complete and ToS-safe: human-only injection enforced, and the
architecture is documented end-to-end.
</success_criteria>

<output>
Create `.planning/phases/20-telegram-transcript-tail/20-05-SUMMARY.md` when done.
</output>
