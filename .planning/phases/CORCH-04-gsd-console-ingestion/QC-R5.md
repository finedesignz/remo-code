# QC R5 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 1 MED; R1-R4 fixes confirmed present, 55 tests passed in the seat)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MED | An idle-timeout abort of the CURRENT connection during apply returns silently: no outage report, no reconnect (a defect introduced by the R3/R4 guards) | After `handleSummaries`, the event path returns silently only when stopped/superseded; an aborted current connection throws `unreachable` into the normal failure path (one notification, backoff, reconnect). Test now asserts the notification and the armed reconnect timer. |
