---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 05
type: execute
wave: 3
depends_on:
  - 18-02
  - 18-03
files_modified:
  - web/src/pages/settings/UsageTab.tsx
  - web/src/components/UsageStrip.tsx
  - web/test/usage-dual-bucket.test.tsx
files_modified_note: "exact web paths = discretion; the Usage tab + strip components per CLAUDE.md Settings UI"
autonomous: true
requirements:
  - R-PTY-20
must_haves:
  truths:
    - "The usage strip/tab renders BOTH buckets: the interactive subscription windows (existing) AND the programmatic credit bucket (dollars used/remaining + reset), without exposing the OAuth token"
    - "The programmatic-leak alert surfaces as a visible notice; the opt-in hard-halt is a toggle + bound input"
    - "Pre-claim / unknown programmatic bucket shows an explicit empty state, never a fabricated number"
    - "Accent stays blue; web/test/no-indigo.test.ts stays green"
  artifacts:
    - path: "web/src/pages/settings/UsageTab.tsx"
      provides: "dual-bucket render + leak notice + hard-halt control"
  key_links:
    - from: "subscription_usage WS (now carrying programmatic_credit) + programmatic_leak_alert WS"
      to: "UsageTab / UsageStrip render"
      via: "existing usage WS subscription in the web client"
      pattern: "render four windows + programmatic_credit card + alert banner"
---

<objective>
Show the user both buckets and the guardrail controls: subscription windows (existing) + the
programmatic credit dollar bucket, the leak notice, and the opt-in hard-halt toggle. Empty state when
the programmatic bucket is unknown/pre-claim. No token exposure. Blue accent preserved.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@hub/src/ws/protocol.ts
@CLAUDE.md
</context>

<threat_model>
- **T-18-08 — Token/secret exposure in the UI (HIGH).** The usage UI must render only the non-secret
  snapshot; it must never display or fetch the OAuth token. Mitigation: the UI consumes only the
  `subscription_usage` WS payload (which carries no token); a test asserts no token-shaped field is
  read/rendered. Empty state for unknown programmatic bucket prevents implying a fake balance.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Render the programmatic-credit bucket + empty state</name>
  <files>web/src/pages/settings/UsageTab.tsx, web/src/components/UsageStrip.tsx, web/test/usage-dual-bucket.test.tsx</files>
  <read_first>
    - the existing UsageTab/UsageStrip (subscription-window rendering)
    - hub/src/ws/protocol.ts (subscription_usage shape with programmatic_credit)
  </read_first>
  <acceptance_criteria>
    - A "Programmatic credit" card shows used/limit USD + reset when present; an explicit "not claimed / unavailable" empty state when null/absent (no fabricated number)
    - The existing subscription windows render unchanged
    - A test asserts both states render and that no token-shaped value is referenced
    - Accent classes are blue tokens (no indigo)
  </acceptance_criteria>
  <action>
    Add the card to the existing Usage surface; reuse the existing card/token styling. Drive from the
    WS payload only.
  </action>
  <verify>
    <automated>cd web; bun test test/usage-dual-bucket.test.tsx test/no-indigo.test.ts 2>$null</automated>
  </verify>
  <done>Both buckets render; empty state honest; no token exposed; accent blue.</done>
</task>

<task type="auto">
  <name>Task 2: Leak-alert notice + opt-in hard-halt control</name>
  <files>web/src/pages/settings/UsageTab.tsx, web/test/usage-dual-bucket.test.tsx</files>
  <read_first>
    - hub/src/ws/protocol.ts (programmatic_leak_alert message)
    - the hard-halt config endpoint/field added in 18-03
  </read_first>
  <acceptance_criteria>
    - A leak-alert banner appears when a `programmatic_leak_alert` arrives; dismissible, non-blocking
    - A hard-halt control: an OFF-by-default toggle + a dollar-bound input that persists via the 18-03 config; UI copy states it halts automation only, never your interactive work
    - A test asserts default-off and that enabling persists the bound
  </acceptance_criteria>
  <action>
    Wire the alert into the existing WS handler; add the toggle + bound input persisting through the
    18-03 config path. Keep copy aligned with "no surprise hard-stop".
  </action>
  <verify>
    <automated>cd web; bun test test/usage-dual-bucket.test.tsx 2>$null</automated>
  </verify>
  <done>User can see leaks and opt into a halt that affects only automation.</done>
</task>

</tasks>

<verification>
- both buckets + empty state render; no token in the UI
- leak banner + hard-halt toggle (default off) present
- `bun test web/test/no-indigo.test.ts` green
- `bun run check-baseline` green
</verification>

<success_criteria>
The usage UI makes the dual-bucket reality and the guardrail controls visible and honest, with no
secret exposure and the blue-accent design preserved.
</success_criteria>

<output>
Create `.planning/phases/18-billing-guardrail-dual-bucket-usage/18-05-SUMMARY.md`.
</output>
