# QC R4 - CORCH-04 (external seat: Codex; verdict QC-FAIL, 2 MED; R1-R3 fixes confirmed present, 53 tests passed in the seat)

Both findings accepted and fixed (no HIGH remained). Note: the common brief caps QC at 3 rounds; R4 and R5 were run
because each round kept returning real (if shrinking) defects, as CORCH-02 also needed 4 rounds.

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | MED | Milestone truncation can make two long milestones collide on `source_ref` | A milestone over 100 chars is now `<first 83 chars>#<first 16 hex of sha256(whole string)>`: bounded and collision-free. Test: two 150-char milestones differing only in the last char keep distinct refs. |
| 2 | MED | A superseded connection finishing late still resets shared `outage`/`failures` | After `handleSummaries` the event path returns when `!live()` (stopped, superseded or aborted) before touching outage/backoff state. Test: stop(), start() (new stream 503), release the old read => failures and notification count unchanged, nothing written. |
