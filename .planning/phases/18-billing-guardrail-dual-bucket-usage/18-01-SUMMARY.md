---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 01
subsystem: supervisor-usage-poll
requirements: [R-PTY-17]
provides: [UsagePayload.programmatic_credit, parseProgrammaticCredit]
key-files:
  modified: [supervisor/src/usage/oauth-poll.ts]
  created:
    - supervisor/test/oauth-poll-dual-bucket.test.ts
    - supervisor/test/oauth-poll-credit-absent.test.ts
    - supervisor/test/fixtures/oauth-usage-with-credit.json
    - supervisor/test/fixtures/oauth-usage-no-credit.json
commit: c24468c
---

# Phase 18 Plan 01: Dual-bucket poll Summary

Extended the supervisor OAuth usage poll to surface the post-June-15-2026
Agent-SDK programmatic credit pool as an additive dollar bucket
(`programmatic_credit { used_usd, limit_usd, resets_at, claimed }`) on
`UsagePayload`, fail-safe when the source is unknown, OAuth token never leaked.

## What shipped
- `UsagePayload` gains optional nullable `programmatic_credit` (dollar bucket, not
  a util% window).
- `parseProgrammaticCredit(body)` recognises the documented dollar shape under
  candidate keys (`programmatic_credit` / `agent_sdk_credit` / `credit_pool`,
  `*_usd` or bare `used`/`limit`); returns `null` for any unrecognised/absent
  body — **never fabricates a number**.
- `parseUsageResponse` folds the bucket in additively; absent ⇒ omitted (empty state).
- No second network call; parses the existing `/api/oauth/usage` body.

## Tests (supervisor — outside check-baseline; run via `bun test`)
- `oauth-poll-dual-bucket.test.ts` (with-credit parse, sibling keys, no-fabrication, token-leak negative) + `oauth-poll-credit-absent.test.ts` (empty state). 25 pass / 0 fail across the 3 oauth-poll files.

## VALIDATION bindings
- Poll parser fixture (post-claim ⇒ bucket; no-credit ⇒ empty state, no fabricated $): satisfied.
- Token-never-leaves-host (T-18-01): `JSON.stringify(usage)` asserted free of the fake token / `accessToken` / `Bearer`.

## OPEN ITEM (carried)
The live endpoint + exact response field names for the credit balance are
UNCONFIRMED (RESEARCH §2) — the parser is provisional against the documented
dollar shape and degrades to the explicit empty state until captured on a live
post-claim Max account after June 15 2026. No fabricated numbers in the interim.

## Self-Check: PASSED
Files exist; commit c24468c in log.
