# QC R7 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 2 MED; R1-R6 confirmed, keepalive adjudication accepted, 79 tests passed in the seat)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MED | `fanOutNotify` swallows channel failures; the adapter ignored its result so `notified` was set without delivery | `gsdc-boot` `notifyOutage` counts owners with a non-empty `delivered` list and THROWS when no owner at all was reached; the ingest then keeps the outage un-notified and retries on the next failure. Test (adapter throws once, then delivered exactly once). |
| 2 | MED | Notification completion not generation-safe (stale lookup sends a notification / flips `notified` after stop()/start()) | `reportFailure(signature, gen)` re-checks stopped/generation after the recipient lookup and after delivery. Test. |
