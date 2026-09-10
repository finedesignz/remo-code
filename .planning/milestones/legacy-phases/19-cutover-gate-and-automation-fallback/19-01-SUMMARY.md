# Phase 19 Plan 01: Cutover-Gate Runbook Summary

June-15 cutover-gate runbook + checklist authored as a dual-bucket snapshot-diff measurement procedure with an unambiguous decision rule; the gate is documented + test-locked, measurement pending a live post-June-15 account.

## Shipped
- `docs/cutover-gate-june15.md` — the four SPEC checks as a `snapshot → one interactive PTY turn → snapshot → diff` procedure on the Phase-18 `subscription_usage` poll; decision rule (interactive ⇒ `claude-pty`; programmatic/unknown ⇒ fail-safe `codex-pty`); NOT-a-build-blocker statement; explicit operator steps to unblock both the billing gate and the deletion gate (`cutover-deletion-gate.mjs` attestation triplets).
- `cutover-gate-checklist.md` — one row per check with a Result column (interactive/programmatic/unknown) + decision + deletion-gate rows; reclassification flagged ONGOING-watch.
- `hub/test/cutover-gate-runbook.test.ts` — presence + reference test (7 pass).

## Deviations
None — plan executed as written.

## Commit
- `34911c5` docs(19-01)

## Self-Check: PASSED
- docs/cutover-gate-june15.md, cutover-gate-checklist.md, hub/test/cutover-gate-runbook.test.ts present; commit 34911c5 in log.

## Note
Measurement is operator-run later; this plan authored the procedure only.
