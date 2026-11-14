# CORCH-04 SUMMARY - gsd-console ingestion

REQ: CORCH-R1.14, R1.15, R1.16. Branch phase-corch-04-gsd-console-ingestion, stacked on phase-corch-02-quota-ingest.

## Shipped (all additive; env unset or flag OFF = unchanged behavior, no connection, no timer)

- `hub/src/corch/gsdc-derive.ts`: pure candidate derivation (current, else lowest pending; backlog ignored; skip on
  active_runs/stale/divergent/not-ready; doneRefs; bounded identities).
- `hub/src/corch/gsdc-ingest.ts`: SSE client, all-or-nothing per event, fail closed, one notification per outage,
  backoff 1s..5min, inactivity timeout, bounded reads, generation/abort-safe.
- `hub/src/corch/gsdc-boot.ts` + `startCorch` wiring; `flag.ts` `gsdcConfig()`.
- Store (no DDL): `listEnabledProjects`, `applyGsdcBoards` (one transaction, enrollment re-check, commit-time liveness);
  `claimNext` now `FOR UPDATE OF i` (a CORCH-01 function touched so a concurrent cancel cannot be resurrected).
- Guard change, deliberate: `corch-no-polling-guard` allows `setTimeout(` in `gsdc-ingest.ts` only through the injected
  timers seam, pins no `setInterval`, one stream open and one board read literal, and a behavioural no-event-no-read test.
- Docs: docs/corch.md "gsd-console ingestion", CLAUDE.md env bullet.

## Tests

corch-gsdc-derive 12, corch-gsdc-ingest 43, corch-no-polling-guard 4, real-Postgres e2e/corch-gsdc 2.
check-baseline: actual pass=4116 fail=0 (baseline pass=3802). schema-lint, migration-verify, schema-double-apply (9),
docs:sync (no diff), all pinned guards green (each run as its own process).

## QC

Codex (external seat) responded in all 8 rounds. R1 3 HIGH + 6 MED, R2 1 HIGH + 3 MED, R3 2 HIGH + 1 MED, R4 2 MED,
R5 1 MED, R6 2 MED, R7 2 MED, R8 2 MED. Every HIGH fixed by R3. See QC-R1..QC-R8 and QC-ADJUDICATION (2 by-design
items). Last round (R8) verdict was FAIL with 2 MED: one fixed (unreviewed), one adjudicated. No Codex QC-PASS token.
