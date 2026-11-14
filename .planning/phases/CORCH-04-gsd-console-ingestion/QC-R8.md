# QC R8 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 2 MED; R1-R7 confirmed, keepalive adjudication accepted, 61 tests passed in the seat)

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MED | `fanOutNotify` counts `inapp` as delivered even when the owner is offline; one reached owner suppresses retries for others; track durable per-owner delivery | ADJUDICATED BY DESIGN (QC-ADJUDICATION.md, item 2). Not changed. |
| 2 | MED | Notification fan-out is generation-unsafe: after stop(), remaining owners are still notified | Fixed: `GsdcOutage.isLive` is handed to the notifier and checked before each recipient. Test asserts the guard is true while running and false after stop(). |

No QC round beyond R8 was run: the common brief caps QC at 3 rounds and 8 were spent; every HIGH was fixed by R3 and
the last five rounds found only narrowing MEDs in the notification path. The orchestrator should treat the final QC
state as: Codex R8 FAIL (2 MED), one fixed and unreviewed, one adjudicated.
