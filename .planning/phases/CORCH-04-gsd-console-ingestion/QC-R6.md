# QC R6 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 2 MED; R1-R5 fixes confirmed present, 55 tests passed in the seat)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MED | Event processing blocks keepalive consumption (3 min of processing aborts a healthy stream); an abort during evaluation loses the trigger for later users | PARTLY FIXED, PARTLY ADJUDICATED (see QC-ADJUDICATION.md). Lost trigger fixed: `applyGsdcBoards` now returns every user with a QUEUED candidate (new or already queued), so the fresh snapshot after the reconnect re-fires evaluation. Decoupling consumption from processing is adjudicated by design. |
| 2 | MED | A failed recipient lookup permanently suppresses the outage notification | Fixed: new `notified` flag set only after `notifyOutage` succeeds; a failed lookup is retried on the next failure of the same outage and never duplicated after delivery. Test. |
