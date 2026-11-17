# QC-CODEX-R2 (CORCH-02 round 2)

Seat: Codex (codex exec, read-only by prompt, bypass sandbox flag)
Model: gpt-6-astra
Range reviewed: 77fe72a..f68df22 (HEAD unchanged before/after; git status clean)
Tests: 136 passed across seven individually run files; PostgreSQL E2E inspected, not executed.
VERDICT: CONTENT BLOCK
END-OF-REVIEW present: yes

## Findings (verbatim)

1. **MED - Clearing the account does not release the affected work item.**
dispatcher.ts:390 copies the death deadline into the item's `not_before`. Snapshot ingestion clears only the account's block; store.ts:252 still excludes that item until its deadline.
Evidence: ordinary assistant output matching a weekly death can delay the item for seven days even after the next healthy live reading makes its account eligible. The new recovery test checks GET eligibility, not item redispatch. Add death -> healthy snapshot -> item-reclaim coverage.

2. **MED - A future-dated stored reading prevents recovery by valid newer live readings.**
quota-store.ts:63 rejects incoming timestamps below the stored timestamp. Ingestion validates timestamp syntax but imposes no future bound.
Evidence: store a reading dated 2099, record a death, then publish a genuine live reading fetched after the death. The entire UPDATE is rejected, including block clearing. Eligibility's future-skew rejection does not repair the stored row. New failure mode from F7; tests cover only ordinary older/equal/newer timestamps.

3. **MED - Supervisor binding is checked once, not preserved through launch and dispatch.**
dispatcher.ts:535 resolves account A to supervisor S before several awaited operations. launch.ts:90 subsequently checks ownership and online status, but not S's account.
Evidence: S can reconnect advertising B after resolution. Launch still targets S. If another supervisor advertises A, the quota gate can also pass: gates.ts:70 discards the returned supervisor identity. Add a reconnect/account-change test and enforce the expected account binding at send.

4. **LOW - Clear provenance remains publisher-controlled.**
quota-store.ts:50 trusts `source: 'live'` and `fetched_at > blocked_at`. A `quota:publish` key holder can manufacture that clear; a previously accepted reading with a slightly future timestamp can also clear a later death when replayed. Confined to the authenticated publisher's user. Assistant text alone cannot publish the clear. Summary acknowledges this limitation.

## Prior HIGH/MED status

| Prior finding | Result |
|---|---|
| Codex HIGH #1; Claude HIGH #1, MED #3 (untrusted death text) | NOT FIXED fully (reset clamping + clear mitigate; ordinary assistant text still triggers death; findings 1-2 block full recovery; no runner-origin distinction) |
| Codex HIGH #2 (account/launch mismatch) | NOT FIXED fully (static fixed; finding 3 reconnect race) |
| Codex HIGH #3; Claude MED #2 (capacity write skew) | FIXED (quota-store.ts:102-112 lock before count/update; contention + concurrent-claim E2E) |
| Codex HIGH #4 (failed block write redispatch) | FIXED for reported exceptions (dispatcher.ts:373-390 five-hour hold); null/missing results still lack fallback |
| Codex HIGH #5 (later death shortens block) | FIXED (quota-store.ts:131 GREATEST) |
| Codex MED #6 (GET ignores busy counts) | FIXED (api/quota.ts:153-154) |

## Launch targeting (question b)
No changed behavior for non-CORCH callers (they omit new options). Explicit targets checked against the user's supervisor list; no cross-user path found. Does not bypass gates, lifetime reservation, ledger insert, supervisor capacity reservation, or machine halt checks. Residual issue is account-binding continuity (finding 3).
