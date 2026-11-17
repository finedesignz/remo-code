# QC R2 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 1 HIGH, 3 MED; R1 fixes #2-#9 confirmed present)

All findings accepted and fixed.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | Shutdown still permits a pending apply transaction and post-stop dispatch | `applyGsdcBoards(entries, shouldCommit)` re-checks `alive` before each entry and immediately before commit and throws (rollback); the ingest treats that as a silent stop and skips `onEnqueued` once not alive. Tests: unit (gate held, stop, release => no write, no evaluate, no outage) and e2e (late rollback undoes an earlier entry). |
| 2 | MED | Enrollment may be disabled between the enabled-project read and apply | The transaction re-checks each entry's project (`enabled = true`, `FOR SHARE`, which conflicts with `updateProject`'s `FOR UPDATE`) and skips a disabled one. e2e test. |
| 3 | MED | Per-snapshot memory not bounded (all boards retained until all reads finish) | Each board is derived immediately after its read and dropped; only compact entries (title <= 200, body <= 4000 chars) are retained. |
| 4 | MED | Untrusted stream-error code reaches logs and notifications | Only codes in a fixed allowlist (`listener_unavailable`, from gsd-console hosted/runs/hub.js) enter the signature; anything else collapses to `stream_error`. Tests incl. a hostile code. |
