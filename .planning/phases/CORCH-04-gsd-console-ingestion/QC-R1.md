# QC R1 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 3 HIGH, 6 MED)

All findings accepted and fixed in the follow-up commit.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | Writes continue after `stop()` (no generation check inside apply) | `handleSummaries` takes `alive()`; checked after the reads and before the single apply call. Test: stop() during an in-flight board read writes nothing. |
| 2 | HIGH | Apply not atomic (cancel and enqueue committed independently; DB failure reported as console failure) | New `store.applyGsdcBoards(entries)`: one `sql.begin` transaction for the whole event; DB failure => rollback + signature `apply_failed` (one notification). e2e proves rollback of an earlier entry. |
| 3 | HIGH | Cancel races `claimNext` (unlocked SELECT then unconditional UPDATE to running resurrects a cancelled item) | `claimNext` candidate SELECT now `FOR UPDATE OF i`; the cancel UPDATE (`status='queued'`) blocks and then re-checks. Dispatcher and quota e2e (48 tests) still green. |
| 4 | MED | Failed connections not aborted | `ac.abort()` in the connect `finally`. Test asserts the signal is aborted after a stream-error. |
| 5 | MED | CRLF normalization broken across chunk boundaries | Whole buffer re-normalized after each append. Test splits `\r\n\r` / `\n`. |
| 6 | MED | Keepalive comments do not re-arm idle timeout | `parseSse(body, onChunk)`: any bytes re-arm. Test counts idle re-arms. |
| 7 | MED | source_ref keeps the console slug case | Derivation uses the lowercased slug (same canonical form as hub ident). |
| 8 | MED | Board response unbounded | `readBoundedJson` (content-length pre-check + 8 MB streaming cap) => `bad_payload`. Test. |
| 9 | MED | Polling guard only counts literals | Added behavioural test: after a snapshot, firing every pending non-idle timer performs no board read; guard also pins the timers-seam-only and single-literal rules. |
