---
phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace
plan: 03
type: execute
wave: 3
depends_on:
  - 17-02
files_modified:
  - hub/src/ws/client.ts
  - hub/src/ws/agent.ts
  - hub/src/telegram/bridge.ts
  - hub/src/telegram/approvals.ts
  - hub/test/automation-translation-preserved.test.ts
  - hub/test/telegram-break-marked.test.ts
  - tools/regression-baseline.json
autonomous: false
requirements:
  - R-PTY-14
  - R-PTY-16
  - R-TG-12
must_haves:
  truths:
    - "Hub agent-protocol→bubble translation that exists ONLY to feed the deleted human UI is removed; when a translation path has ANY non-human-UI (automation) consumer, it is PRESERVED"
    - "The runner-side stream-json path (claude-runner.ts + session-bridge.ts) is PRESERVED whole for automation transports (Phase 18)"
    - "usage_event/token_usage capture (the non-bypassable cost-cap source) is PRESERVED end-to-end"
    - "The Telegram bridge's structured-event source + permission_request→onPermissionPending path is removed, leaving Telegram non-functional; each removal point carries an EXPLICIT Phase-20 comment; the bridge module is NOT deleted"
    - "Baseline + no-indigo stay green; a regression test proves automation paths still work after the rip"
  artifacts:
    - path: "hub/test/automation-translation-preserved.test.ts"
      provides: "Proof automation translation (usage/finalize) survives the rip"
    - path: "hub/test/telegram-break-marked.test.ts"
      provides: "Asserts Phase-20 break markers exist + bridge module still on disk"
  key_links:
    - from: "removed Telegram event source point"
      to: "// Phase 17 rip: ... rebuilt in Phase 20 (transcript-tail)."
      via: "explicit code comment + SUMMARY note"
      pattern: "comment marker at each removal site"
---

<objective>
Finish the rip on the hub side WITHOUT collateral damage: remove agent-protocol→bubble translation that
exists ONLY to feed the now-deleted human UI, while PRESERVING translation that automation still needs
(Phase 18) and the non-bypassable usage/cost-cap capture. Mark the Telegram break EXPLICITLY (a Phase-20
comment at each removed source point) and DO NOT delete the Telegram bridge module. Prove automation
paths still work after the rip.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-CONTEXT.md
@.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/ws/agent-protocol.ts
@hub/src/ws/client.ts
@hub/src/telegram/bridge.ts
@hub/src/telegram/approvals.ts
@hub/src/dispatch/gates.ts
@CLAUDE.md

<interfaces>
From hub/src/ws/agent-protocol.ts: kinds thinking/text_delta/tool_use/tool_result/assistant_message/permission_request/user_question/usage_event.
From hub/src/dispatch/gates.ts: dailyCostCapGate/isOverCostCap — usage_event/token_usage MUST survive (cost-cap source).
From hub/src/telegram/bridge.ts: structured-event source (assistant_message:final/tool_use) + permission_request→onPermissionPending — removed here, marked for Phase 20.
</interfaces>
</context>

<threat_model>
- **T-17-07 — Deleting automation-needed translation (CRITICAL).** If a translation/broadcast path that
  Phase 18 automation (or usage/cost-cap capture, scheduler/error-capture finalize) relies on is removed
  as "dead UI," automation breaks silently. Mitigation: import-graph classification; PRESERVE on
  ambiguity; a regression test asserts usage_event capture + a scheduled-style dispatch still finalize
  after the rip. Block on: CRITICAL.
- **T-17-08 — Cost-cap source severed (CRITICAL).** Mitigation: explicitly PRESERVE usage_event →
  token_usage; the regression test asserts the cost-cap path still observes a turn's cost. The
  non-bypassable `dailyCostCapGate` is untouched.
- **T-17-09 — Silent Telegram break (HIGH).** Removing the structured source without a marker would make
  the Phase-20 rebuild hard and the break invisible. Mitigation: explicit Phase-20 comment at each
  removal point; bridge module NOT deleted; grep test asserts the markers + module presence.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Classify + remove DEAD human-UI-only translation; PRESERVE automation translation</name>
  <files>hub/src/ws/client.ts, hub/src/ws/agent.ts, hub/test/automation-translation-preserved.test.ts</files>
  <read_first>
    - hub/src/ws/client.ts + agent.ts (the broadcast/translation that fed the deleted bubbles)
    - hub/src/dispatch/gates.ts (usage_event/cost-cap path that MUST survive)
  </read_first>
  <acceptance_criteria>
    - An enumerated classification (in the SUMMARY) of each translation/broadcast path: human-UI-only (remove) vs automation-shared (preserve); ambiguous ⇒ PRESERVE
    - Only human-UI-only translation is removed; usage_event→token_usage capture and scheduler/error-capture finalize translation are PRESERVED
    - automation-translation-preserved.test.ts asserts a usage_event still records cost AND a scheduled-style dispatch still finalizes after the rip
    - The runner-side stream-json path (claude-runner.ts + session-bridge.ts) is unchanged (R-PTY-16)
  </acceptance_criteria>
  <action>
    Build the import-graph classification first; record it. Remove only paths whose sole consumer was the
    deleted human UI. Add the preservation regression test. Do NOT touch claude-runner.ts/session-bridge.ts
    or the cost-cap gate. This is the autonomous:false checkpoint — operator reviews the classification
    before removal (deleting automation translation is the costliest error).
  </action>
  <verify>
    <automated>cd hub; bun test test/automation-translation-preserved.test.ts 2>$null</automated>
  </verify>
  <done>Dead human-UI translation removed; automation + cost-cap translation provably preserved.</done>
</task>

<task type="auto">
  <name>Task 2: Mark the Telegram break explicitly (Phase-20 comments); keep the bridge module</name>
  <files>hub/src/telegram/bridge.ts, hub/src/telegram/approvals.ts, hub/test/telegram-break-marked.test.ts</files>
  <read_first>
    - hub/src/telegram/bridge.ts (structured-event source: assistant_message:final/tool_use; permission path)
    - hub/src/telegram/approvals.ts (onPermissionPending → inline approval registry)
  </read_first>
  <acceptance_criteria>
    - The structured-event source + permission_request→onPermissionPending path is removed (Telegram is non-functional after this)
    - Each removal point carries: `// Phase 17 rip: Telegram event source removed here; rebuilt in Phase 20 (transcript-tail).`
    - hub/src/telegram/bridge.ts and approvals.ts STILL EXIST on disk (module not deleted; Phase 20 re-sources)
    - telegram-break-marked.test.ts asserts the comment markers exist AND the bridge module file is present
  </acceptance_criteria>
  <action>
    Remove the dead structured-event subscription + permission path; leave the marker comment at each
    site. Keep the module + the inline-approval registry shell (Phase 20 reuses the (sessionId,requestId)
    keying). Record every removal point in the SUMMARY.
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-break-marked.test.ts 2>$null</automated>
    `test -f hub/src/telegram/bridge.ts && grep -rn "rebuilt in Phase 20" hub/src/telegram` returns hits.
  </verify>
  <done>Telegram break is explicit + recoverable; the bridge module survives for Phase 20.</done>
</task>

<task type="auto">
  <name>Task 3: Full QC + docs note</name>
  <files>tools/regression-baseline.json</files>
  <read_first>
    - tools/regression-baseline.json (current counts)
    - CLAUDE.md (cost-cap + mount-order invariants to re-confirm)
  </read_first>
  <acceptance_criteria>
    - `bun run check-baseline` green; baseline updated for removed human-UI tests + new preservation/marker tests
    - `cd web; bun run build` + `web/test/no-indigo.test.ts` green (R-PTY-16)
    - The SUMMARY records: classification table, deleted files, Telegram removal points, grid decision (from 17-02)
  </acceptance_criteria>
  <action>
    Run the full gate. Update the baseline. Confirm the cost-cap + mount-order invariants are untouched.
  </action>
  <verify>
    <automated>bun run check-baseline 2>$null; cd web; bun run build 2>$null</automated>
  </verify>
  <done>The rip is complete, automation-safe, and Telegram-break-marked; QC green.</done>
</task>

</tasks>

<verification>
- Only human-UI-only translation removed; usage_event/cost-cap + automation finalize PRESERVED (test)
- claude-runner.ts + session-bridge.ts stream-json path unchanged (R-PTY-16)
- Telegram structured source removed WITH Phase-20 markers; bridge module still on disk (test + grep)
- `bun run check-baseline` + `web` build + no-indigo all green
</verification>

<success_criteria>
The hub-side rip removes only dead human-UI translation, provably preserves automation + the
non-bypassable cost-cap capture and the stream-json runner path, and marks the Telegram break explicitly
for Phase 20 without deleting the bridge module.
</success_criteria>

<output>
Create `.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/17-03-SUMMARY.md` when done
(include the translation classification table + every Telegram removal point).
</output>
