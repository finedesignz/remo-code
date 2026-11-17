# CORCH-02 QC adjudication (milestone orchestrator, 2026-11-13)

Final external seat: Codex gpt-6-astra, R4 on 6bf7e36..8d9e954 (QC-CODEX-R4.md).

| Finding | Disposition | Reason |
|---|---|---|
| R3 #1 MED (refusal held item to reset) | FIXED (R4 confirmed) | dispatcher.ts:328 cap min(earliestEligibleAt, now+600s); e2e :390 |
| R3 #2 MED (poisoned future row) | FIXED (R4 confirmed) | quota-store.ts:66; e2e :453 |
| R4 #1 MED (5h item hold when markDeath fails/null or runContext throws) | ACCEPTED BY DESIGN | Locked in QC round 2 (G1) as the fail-closed path: if the account block was NOT recorded, the account still looks eligible, so a short hold would redispatch straight into an exhausted account and loop. Liveness cost (one item delayed up to 5h after a rare DB write failure), not a safety or fail-open defect. Codex notes the behaviour predates the R3 diff. Follow-up candidate for CORCH-11 (status/pause/priority): owner "release now" action on held items. |
| R4 #2 LOW (e2e advances deadline by hand) | ACCEPTED | Event-driven redispatch is covered by the snapshot-triggers-one-evaluation tests (Task 5); the e2e proves reclaimability. |
| Accepted residuals | ACCEPTED | Supervisor rebinding between resolveTarget and send (F4: one fixed token per supervisor container); publisher-declared source trust (own user only). Both documented in docs/corch.md. |

No HIGH open. No fail-open quota path found by R4.
