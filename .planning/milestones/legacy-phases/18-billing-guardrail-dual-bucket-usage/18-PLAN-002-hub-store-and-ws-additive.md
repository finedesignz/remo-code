---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/ws/agent-protocol.ts
  - hub/src/ws/protocol.ts
  - hub/src/usage/store.ts
  - hub/src/ws/agent.ts
  - hub/src/ws/client.ts
  - hub/test/usage-dual-bucket-additive.test.ts
autonomous: true
requirements:
  - R-PTY-17
must_haves:
  truths:
    - "The usage_report Zod schema, the in-memory store, and the subscription_usage WS message all carry the programmatic-credit bucket ADDITIVELY — an old supervisor/client with no second bucket still validates and renders"
    - "The hub never receives or stores an OAuth token; only the parsed snapshot (four windows + optional dollar bucket)"
  artifacts:
    - path: "hub/src/ws/agent-protocol.ts"
      provides: "usage_report schema extended with optional programmatic_credit"
    - path: "hub/src/ws/protocol.ts"
      provides: "subscription_usage WS message extended with optional programmatic_credit"
  key_links:
    - from: "agent.ts usage_report handler -> setUsage"
      to: "store snapshot -> subscription_usage broadcast -> client.ts -> web"
      via: "existing usage path, second bucket carried through unchanged plumbing"
      pattern: "setUsage(userId, msg.usage) then broadcast snapshot"
---

<objective>
Carry the second bucket through the EXISTING usage plumbing additively: Zod schema, in-memory store,
and the `subscription_usage` WS broadcast. No shape break — old supervisors/clients keep working.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-RESEARCH.md
@hub/src/ws/agent-protocol.ts
@hub/src/ws/protocol.ts
@hub/src/usage/store.ts
@hub/src/ws/agent.ts
@hub/src/ws/client.ts
@CLAUDE.md
</context>

<threat_model>
- **T-18-03 — Non-additive schema break locks out old supervisors (HIGH).** Making the second bucket
  REQUIRED would reject `usage_report` from a supervisor that has not upgraded (or a pre-claim account),
  blanking the whole usage strip. Mitigation: the field is `.optional().nullable()` everywhere; a test
  feeds an old-shape `usage_report` (no second bucket) and asserts it validates + the four windows
  still broadcast. Block on: HIGH.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Extend the usage_report + subscription_usage schemas + store (additive)</name>
  <files>hub/src/ws/agent-protocol.ts, hub/src/ws/protocol.ts, hub/src/usage/store.ts</files>
  <read_first>
    - hub/src/ws/agent-protocol.ts (usage_report schema, UsageWindow)
    - hub/src/ws/protocol.ts (subscription_usage message ~line 347)
    - hub/src/usage/store.ts (UsagePayload, UsageSnapshot)
  </read_first>
  <acceptance_criteria>
    - `usage_report.usage` Zod gains optional nullable `programmatic_credit` ({used_usd,limit_usd,resets_at,claimed})
    - `subscription_usage` WS message + store `UsagePayload` gain the same optional field
    - An old-shape payload (no programmatic_credit) still passes the Zod parse (additive)
    - tsc passes
  </acceptance_criteria>
  <action>
    Mirror the supervisor's `UsagePayload` field name exactly. Keep `.optional().nullable()` on every
    surface. No store-persistence change (still in-memory).
  </action>
  <verify>
    <automated>cd hub; bun test test/usage-dual-bucket-additive.test.ts 2>$null</automated>
  </verify>
  <done>Schemas + store carry the bucket additively.</done>
</task>

<task type="auto">
  <name>Task 2: Plumb through agent.ts handler + client.ts broadcast</name>
  <files>hub/src/ws/agent.ts, hub/src/ws/client.ts, hub/test/usage-dual-bucket-additive.test.ts</files>
  <read_first>
    - hub/src/ws/agent.ts (~line 582, usage_report → setUsage → subscription_usage)
    - hub/src/ws/client.ts (~line 196, subscription_usage send)
  </read_first>
  <acceptance_criteria>
    - The agent handler stores + broadcasts the full snapshot including the optional second bucket without dropping it
    - The client send includes the second bucket when present, omits/nulls it when absent
    - Test: feed a usage_report with the bucket → broadcast carries it; feed an old-shape one → broadcast carries the four windows, bucket null/absent, no error
  </acceptance_criteria>
  <action>
    The plumbing already forwards `msg.usage` wholesale — verify nothing strips unknown fields and the
    type now includes the bucket. Smallest diff.
  </action>
  <verify>
    <automated>cd hub; bun test test/usage-dual-bucket-additive.test.ts 2>$null</automated>
  </verify>
  <done>Second bucket flows supervisor→hub→web through the existing path; old clients unaffected.</done>
</task>

</tasks>

<verification>
- Old-shape usage_report validates (additive)
- second bucket reaches the web client when present
- no OAuth token anywhere in the hub-side types/store
- `bun run check-baseline` green
</verification>

<success_criteria>
The programmatic-credit bucket travels the existing usage plumbing end to end, additively, with no
break for un-upgraded supervisors or pre-claim accounts.
</success_criteria>

<output>
Create `.planning/phases/18-billing-guardrail-dual-bucket-usage/18-02-SUMMARY.md`.
</output>
