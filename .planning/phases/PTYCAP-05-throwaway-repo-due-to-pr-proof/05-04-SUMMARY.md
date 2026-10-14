---
phase: PTYCAP-05-throwaway-repo-due-to-pr-proof
plan: 04
subsystem: api
tags: [proof, read-only, openapi, tenancy]
requires: [05-01]
provides:
  - GET /api/orchestrator/proof (orchestratorProofApi) - latest proof run plus up to 5 earlier runs
  - OpenAPI registration plus regenerated docs/openapi.json and docs/api.md
affects: [05-09]
key-files:
  created:
    - hub/src/api/orchestrator-proof.ts
    - hub/test/orchestrator-proof-api.test.ts
  modified:
    - hub/src/index.ts
    - hub/src/api/_openapi.ts
    - hub/test/mount-order.test.ts
    - docs/openapi.json
    - docs/api.md
decisions:
  - "bypass_verification reads arm_preconditions.bypass_verification === 'verified', anything else (absent, other value) is 'unverified' (fail closed). The key name is defined here because the arm script (05-07) is not yet written; 05-07 must write that exact key."
  - "usage.injects is computed per run via countProofInjects(counter_key, started_at ?? armed_at); a DAL error for that one figure yields null, not a failed response"
  - "Router mounted directly after /api/orchestrator; orchestratorApi has no /proof or param route so there is no swallow; the existing /api/orchestrator/* step-up and mutating-only rate limit middleware cover it (GET needs no new middleware)"
status: complete
plan_head_before: 77786d88273d73a222e30f2388e6106007ee5e05
commits: 2
actuals:
  tokens: 14000
  tasks: 2
  commits: 2
---

# Phase PTYCAP-05 Plan 04: Proof status route Summary

Read-only, cookie-authenticated, tenant-scoped GET /api/orchestrator/proof exposing the latest proof run and up to 5 prior runs (status, outcome, outcome_detail, pr_url, branch, frozen budgets, live counters, protection shape, 12-char digest, bypass verification provenance, timestamps) through an explicit allowlist mapping. No installation id, ruleset ids, raw arm preconditions or counter key in the response.

## Commits

- 742adfc feat(ptycap-05-04): read-only GET /api/orchestrator/proof status route (router, mount, tests, mount-order pin)
- 62fc83d docs(ptycap-05-04): OpenAPI registration plus `bun run docs:sync` regenerated docs

## Verification

- `bun test test/orchestrator-proof-api.test.ts` (hub): 10 pass, 0 fail (mapping, history cap, tenancy isolation, 500 no-leak, inject-count degrade, no mutating handler, unverified fail-closed)
- `bun test test/mount-order.test.ts` (hub): 23 pass, 0 fail (new assertion: unauth GET /api/orchestrator/proof is 401)
- `bun run docs:sync` run twice: output byte-identical on rerun; /api/orchestrator/proof present in docs/openapi.json and docs/api.md
- `grep` for .post/.put/.patch/.delete in the router: none
- `bun run typecheck` (hub): no errors in orchestrator-proof.ts or the new _openapi.ts block; the file's pre-existing `RouteConfig` typing errors elsewhere are unchanged

## Deviations from Plan

None - plan executed as written. Notes:
- docs/api.md diff is larger than one route (447+/119-) because widdershins output was committed exactly as generated, per plan instruction not to hand-revert.
- Terminal runs in `history` also get a countProofInjects figure (plan-literal); it counts since the run's start, so for a terminal run it can include later injects on a reused counter key. Informational only.

## Known Stubs

None.

## Threat Flags

None. The new endpoint is a read-only GET behind the existing auth catch-all; T-05-15/16/17 mitigations are implemented and tested.

## Self-Check: PASSED

Files exist: hub/src/api/orchestrator-proof.ts, hub/test/orchestrator-proof-api.test.ts. Commits 742adfc and 62fc83d present.
