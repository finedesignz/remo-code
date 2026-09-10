---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 02
subsystem: hub-usage-plumbing
requirements: [R-PTY-17]
provides: [usage_report.programmatic_credit, subscription_usage.programmatic_credit, store.ProgrammaticCredit]
key-files:
  modified:
    - hub/src/ws/agent-protocol.ts
    - hub/src/ws/protocol.ts
    - hub/src/usage/store.ts
  created: [hub/test/usage-dual-bucket-additive.test.ts]
commit: f8ba50e
---

# Phase 18 Plan 02: Hub store + WS additive Summary

The programmatic-credit bucket now travels the existing usage plumbing — Zod
schema, in-memory store, `subscription_usage` WS broadcast — ADDITIVELY. Old
supervisors/clients and pre-claim accounts keep working.

## What shipped
- `AgentUsageReport.usage` gains optional nullable `programmatic_credit` (Zod).
- `subscription_usage` WS message + store `UsagePayload` gain the same optional field.
- `agent.ts` (usage_report → setUsage → broadcast) and `client.ts` already forward
  `usage`/`snap.usage` WHOLESALE, so the second bucket flows through unchanged — no
  edit needed there (smallest-diff per plan).
- No store-persistence change (still in-memory, reconverges on 5-min repoll).

## Tests (hub — in check-baseline)
- `usage-dual-bucket-additive.test.ts`: old-shape validates (additive), new-shape carries the bucket, null accepted, store round-trips, no token field on the snapshot. 6 pass / 0 fail.

## VALIDATION bindings
- WS additivity (old-shape `usage_report` still validates): satisfied (T-18-03).
- Second bucket reaches the web client when present: store + broadcast carry it wholesale.
- No OAuth token in hub-side types/store: negatively tested.

## Self-Check: PASSED
Files exist; commit f8ba50e in log.
