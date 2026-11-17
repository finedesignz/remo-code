# CORCH-02 QC - Claude adversarial lens (security + correctness)

VERDICT: CONTENT BLOCK (1 HIGH, 2 MED, 4 LOW). Everything else in the locked spec holds.

Verified by tools: individual bun test files all green (death 15, eligibility 37, ingest 28, selection 22, wait 14, flag-off 5, boot-assert 15, api-keys-scopes 37, mount-order 29, csrf 30); e2e corch-quota 11 pass on fresh db. Note: running those files in ONE bun process fails 6 (mock.module leakage, "createAuthSession not found" in mount-order) - run per file, not a product defect.

## HIGH

1. Untrusted run text can block an account indefinitely (prompt-injection DoS on own accounts, no recovery path).
   - hub/src/corch/quota-death.ts (LEGACY regex ~L22, classify ~L28) + hub/src/corch/quota-store.ts markDeath (~L104-120) + dispatcher.ts endQuotaDeath/handleRunEnd.
   - Evidence: classifyQuotaDeath('Claude AI usage limit reached|99999999999') returns resetAt 5138-11-16 (run live). markDeath sets blocked_until = resetAt when it is in the future, with no clamp. The text comes from the agent's final assistant_message (and markFailed error), i.e. model output steered by repo/issue/web content. A CORCH run that outputs exactly that string as its whole final message blocks the account it holds, and requeues the item to not_before=year 5138. The snapshot upsert preserves blocked_until verbatim and only clears when blocked_until IS NULL, so a non-null far-future block can never be cleared by CUG readings, even ones showing 3% usage and a fresh fetched_at. Only manual SQL clears it.
   - Scope: same user only (user_id scoped; no cross-user effect). But it defeats "quota death blocks until reset" safety: a hostile README can take all of a user's accounts offline.
   - Fix: (a) clamp legacy resetAt to <= now + 7d (+ small slack) and ignore epochs in the past/implausible; (b) corroborate: only trust a death when the account's latest live reading is consistent (>= ceiling, or window reset matches), else treat as unverified and block only until the next newer live reading; (c) let a newer live reading (fetched_at > blocked_at, source live, pct below ceiling, no cug_blocked) clear blocked_until too, not just the NULL-until case. Add tests: far-future epoch, death with low-usage reading.

## MED

2. Per-account capacity / "max 1 concurrent session when 5h null" is not race-safe.
   - hub/src/corch/quota-store.ts claimAccountSlot (~L88-98); callers evaluateUser (dispatcher.ts ~L596) have no per-user mutex and are triggered concurrently (POST snapshot, supervisor hello, run end, timer).
   - Evidence: the capacity check is a count subquery inside a single UPDATE on the run's own row. Under READ COMMITTED two concurrent claims for two different runs each count 0 other holders (the other's uncommitted account_slot is invisible) and both succeed with capacity 1. Classic write skew. e2e has no concurrent-claim test (Promise.all absent).
   - Fix: serialize per (user_id, account_id): `pg_advisory_xact_lock(hashtext(user_id||account_id))` in a tx around the count+update, or SELECT ... FOR UPDATE on the corch_quota_accounts row first. Add a concurrent claim test with capacity 1.

3. Quota death is a false positive for any exact-match text from the agent and never validated against real usage (see 1; separate impact: also blocks an account that is genuinely under the ceiling for the whole window). Covered by the 1(b) fix; listed so tests assert it: a death at 5% usage must not block longer than the next live reading.

## LOW

4. blocked_at clear relies on publisher-supplied fetched_at (quota-store.ts upsert CASE): a reading fetched before the death but carrying a skewed/replayed fetched_at greater than hub blocked_at clears a NULL-until block. Compare against received_at ordering or require generated_at monotonic per user.
5. Unbounded row growth: account_id is free-form [A-Za-z0-9_-]{1,64}, 32 per POST, never deleted; a quota:publish key can mint unlimited rows over time (own data only). Cap rows per user (reject/prune beyond N) or prune rows absent from a full snapshot.
6. Out-of-order/replayed POST overwrites a newer row (no generated_at monotonic check). Fails closed (older fetched_at goes stale) so low severity, but can flap eligibility.
7. Flag OFF: POST/GET /api/quota/snapshot, DDL and WS hello schema are live regardless (data stored, no dispatch). Acceptable (additive, no behavior change in dispatch, evaluate no-ops via corchEnabled) but note the endpoints are not 404 when REMO_CORCH_ENABLED is off. Rate-limit keyFn uses first 24 chars of Authorization (index.ts), trivially varied by suffix; same as cloud-hook, low.

## Checked and OK (refute attempts that failed)

- Auth/scope: hasExplicitScope = Array.isArray && includes; NULL/legacy keys, supervisor keys, other scopes rejected; quota:publish and quota:read do not imply each other; verifyApiKeyFull filters revoked_at; lookup throw -> 401; cookies/JWT never authenticate (route-local, mounted before catch-all, csrf allowlist is bearer-only, exact `/api/quota` without slash falls to JWT 401). Key minting via api-keys.ts only mints for own user.
- Cross-user: user_id only from verified key; all SQL (accountsFor, upsert, claim, markDeath, liveRunsByAccount) filters user_id; GET returns only own rows. No leak found.
- Fail closed: snapshot >600s, account >900s, null/future fetched_at, source != live, cug_blocked, disabled, null 7d, ceiling, null-5h busy cap all in one pure function used by both GET and provider.
- No email/token: strict schemas (email/label/unknown keys -> 400), no column; logs carry user id only, never body or Zod values.
- DDL: CREATE TABLE IF NOT EXISTS, additive, FK to users ON DELETE CASCADE.
- No polling added; trigger is event-driven (POST -> evaluateUserNow).
- Known deferral (documented in SUMMARY): supervisor_id null, supervisors do not yet send account_slot, so flag ON refuses quota:no_slot_supervisor until CORCH-09. Run is not bound to its account's supervisor yet; acceptable only because dispatch cannot succeed before CORCH-09.

## Ship condition
Fix 1 (+3) and 2 with tests, re-QC. 4-7 may be follow-ups.
