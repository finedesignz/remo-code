---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - supervisor/src/usage/oauth-poll.ts
  - supervisor/test/oauth-poll-dual-bucket.test.ts
  - supervisor/test/oauth-poll-credit-absent.test.ts
  - supervisor/test/fixtures/oauth-usage-with-credit.json
  - supervisor/test/fixtures/oauth-usage-no-credit.json
autonomous: false
requirements:
  - R-PTY-17
must_haves:
  truths:
    - "The poll surfaces a SECOND bucket — the Agent-SDK programmatic credit pool — alongside the existing four subscription windows, in a shape additive to UsagePayload"
    - "The programmatic bucket is a DOLLAR balance ({used_usd, limit_usd, resets_at, claimed}), not a util% window"
    - "When the endpoint does not return a usable credit balance (pre-claim / absent / unrecognized), the bucket degrades to an explicit empty state — NEVER a fabricated dollar number"
    - "The OAuth access token is read locally and used only as the Authorization header; it is NEVER returned, logged, or added to the payload sent to the hub"
  artifacts:
    - path: "supervisor/src/usage/oauth-poll.ts"
      provides: "extended pollUsage + parser emitting the second (programmatic credit) bucket"
  key_links:
    - from: "pollUsage() programmatic-credit parse"
      to: "UsagePayload.programmatic_credit (new optional field)"
      via: "same /api/oauth/usage poll or a sibling credit endpoint (OPEN ITEM — degrade to empty if absent)"
      pattern: "parseProgrammaticCredit(body) -> {used_usd,limit_usd,resets_at,claimed} | null"
---

<objective>
Extend the existing supervisor OAuth usage poll to ALSO surface the post-June-15 Agent-SDK programmatic
credit pool, as an additive dollar bucket on `UsagePayload`. Preserve the hard invariant that the OAuth
token never leaves the host. Fail safe: unknown/absent credit endpoint ⇒ explicit empty state, never a
fabricated number.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@supervisor/src/usage/oauth-poll.ts
@CLAUDE.md
</context>

<threat_model>
- **T-18-01 — OAuth token leak via the second bucket (CRITICAL).** Adding the credit parse touches the
  same code that reads `~/.claude/.credentials.json`. A careless change could serialize the token into
  the `usage_report` payload. Mitigation: the new field carries ONLY parsed dollar values; a test
  asserts the returned `UsagePayload` (and the JSON that goes on the wire) contains no token-shaped
  string. Block on: CRITICAL.
- **T-18-02 — Fabricated credit number when the endpoint is unknown (HIGH).** If the credit endpoint is
  absent or its shape unrecognized, guessing a number would mislead the guardrail (and the user).
  Mitigation: parser returns `null` ⇒ explicit "unknown/unclaimed" empty state; NEVER a default dollar
  value; test asserts the empty-state path emits no number.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Add the programmatic-credit bucket to UsagePayload + parser</name>
  <files>supervisor/src/usage/oauth-poll.ts</files>
  <read_first>
    - supervisor/src/usage/oauth-poll.ts (UsagePayload, parseUsageResponse, pollUsage, readAccessToken)
    - .planning/phases/18-billing-guardrail-dual-bucket-usage/18-RESEARCH.md (endpoint OPEN ITEM + dollar shape)
  </read_first>
  <acceptance_criteria>
    - `UsagePayload` gains an OPTIONAL `programmatic_credit?: { used_usd: number; limit_usd: number; resets_at: string; claimed: boolean } | null` (exact name = discretion, but optional + nullable so old shape stays valid)
    - A `parseProgrammaticCredit(body)` helper returns the bucket or `null` when the body lacks a usable credit balance; it NEVER returns a fabricated/default dollar value
    - `pollUsage()` includes the parsed bucket (or omits/nulls it) without changing the existing four-window behavior or the `{ ok:false }` failure contract
    - No token value is ever placed on the returned payload (grep + assertion)
    - tsc passes
  </acceptance_criteria>
  <action>
    Extend the interface and parser. If the live endpoint that carries the credit balance is unknown at
    implementation time (RESEARCH §2 OPEN ITEM), implement `parseProgrammaticCredit` defensively against
    the documented dollar shape and return `null` for any unrecognized body — wire the actual endpoint
    once captured (gate this task's sign-off on the manual endpoint capture, autonomous:false). Do not
    add a second network call unless the sibling endpoint is confirmed; prefer parsing the existing
    `/api/oauth/usage` body first.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/oauth-poll-dual-bucket.test.ts 2>$null</automated>
    Manual: capture the real post-claim endpoint + body on a live Max account after June 15.
  </verify>
  <done>The poll can carry the programmatic bucket, fail-safe when unknown, token never leaked.</done>
</task>

<task type="auto">
  <name>Task 2: Fixtures + token-safety + empty-state tests</name>
  <files>supervisor/test/oauth-poll-dual-bucket.test.ts, supervisor/test/oauth-poll-credit-absent.test.ts, supervisor/test/fixtures/oauth-usage-with-credit.json, supervisor/test/fixtures/oauth-usage-no-credit.json</files>
  <read_first>
    - supervisor/src/usage/oauth-poll.ts (pollUsage fetchImpl override for injecting fixture bodies)
  </read_first>
  <acceptance_criteria>
    - `oauth-usage-with-credit.json` (post-claim shape) ⇒ pollUsage returns the four windows + the programmatic bucket parsed
    - `oauth-usage-no-credit.json` (pre-claim / no credit field) ⇒ programmatic bucket is null/absent (explicit empty state), four windows still parse
    - A test asserts neither the returned payload nor its JSON.stringify contains the fixture's access-token value (token-never-leaves-host)
    - New test files registered in tools/regression-baseline.json if the gate requires
  </acceptance_criteria>
  <action>
    Author fixtures + tests using the existing `pollUsage({ fetchImpl, credentialsPathOverride })`
    injection seam. The token-leak test reads a known fake token from a fixture credentials file and
    asserts it is absent from the outbound payload.
  </action>
  <verify>
    <automated>cd supervisor; bun test test/oauth-poll-credit-absent.test.ts 2>$null</automated>
  </verify>
  <done>Both buckets covered; empty state proven; token-leak negatively tested.</done>
</task>

</tasks>

<verification>
- `grep -n accessToken supervisor/src/usage/oauth-poll.ts` shows the token only as the Authorization header, never on the payload
- with-credit fixture ⇒ programmatic bucket present; no-credit fixture ⇒ explicit empty state, no fabricated $
- `bun run check-baseline` green
</verification>

<success_criteria>
The existing poll now surfaces both billing buckets, the programmatic one fail-safe when its source is
unknown, with the OAuth-token-never-leaves-host invariant preserved and negatively tested.
</success_criteria>

<output>
Create `.planning/phases/18-billing-guardrail-dual-bucket-usage/18-01-SUMMARY.md` (record the captured
programmatic-credit endpoint + body shape, or NOTE it remains the empty state pending June-15 capture).
</output>
