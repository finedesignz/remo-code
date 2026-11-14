# QC R3 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 2 HIGH, 1 MED; R1/R2 fixes confirmed present except as noted)

All findings accepted and fixed.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | After stop(), a second user's evaluation callback can still run | Liveness re-checked before EACH `onEnqueued` call. Test: evaluation of user 1 blocked, stop(), release => user 2 never evaluated. |
| 2 | HIGH | A bounded response can still amplify into huge derived data (unbounded milestone, done list) | zod bounds: <= 1000 phases per column, slug <= 200, phase name <= 2000, goal <= 20000 chars (violation => `bad_payload`); milestone truncated to 100 chars; event-wide derived-text budget of 16 MB (`bad_payload`). Tests. |
| 3 | MED | Idle-timeout abort does not invalidate a pending write | The `alive` guard now also requires `!ac.signal.aborted`. Test: idle timer fired while apply waits => nothing written, nothing evaluated. |
