---
phase: CORCH-02-quota-ingest
verified: 2026-11-13T00:00:00Z
status: passed
score: 12/12 must-haves verified (SC1-SC5 all PASS)
head: 6bf7e36
base: 0f12261
behavior_unverified: 0
overrides_applied: 0
verdict: SHIP-WITH-NOTES
---

# CORCH-02 Verification (independent, tool-gathered)

Branch phase-corch-02-quota-ingest at HEAD 6bf7e36 (confirmed), diff base 0f12261. Worktree clean.
SUMMARY self-report was not relied on; every line below was re-run in this session.

## Ship verdict: SHIP-WITH-NOTES

All roadmap SC1-SC5 and all plan truths hold. Flag defaults OFF, no prod-affecting change, additive schema only.
Notes (none blocking) are at the bottom.

## Per-goal results

| # | Goal / SC | Result | Evidence |
|---|---|---|---|
| SC1 | Schema ok; both scopes explicit-only; quota:publish key reaches no other route | PASS | scopes.ts adds SCOPE_QUOTA_PUBLISH/READ (+ALL_SCOPES). hub/src/api/quota.ts:93 `hasExplicitScope` only (no hasScope). Route-local Bearer auth (quota.ts:80-98), cookie never authenticates. api-keys-scopes.test.ts:310 describe "quota:publish and quota:read are EXPLICIT-only" - 37 pass. mount-order 29 pass, csrf 30 pass. schema-lint rc 0, migration-verify rc 0, schema-double-apply e2e 9 pass/0 skip |
| SC2 | Strict schema: email/label/unknown key => 400, no row | PASS | quota.ts:30-54 `.strict()` at both levels; 400 `invalid_snapshot` with no issue echo (quota.ts:111,116); corch-quota-ingest 32 pass |
| SC3 | Table-driven eligibility | PASS | quota-eligibility.ts:39-41,64-90: 600s (L64), 900s + null fetched_at + >60s future (L66-72), source!=live (L74), cug_blocked, enabled=false, blocked_until / NULL-until block (L79-80), null 7d (L82), ceiling (L84-85), null 5h = unknown with busy cap 1 (L87). corch-quota-eligibility 37 pass |
| SC4 | Selection: lowest max(5h,7d), tie-break account_id, online slot supervisor with free slot; hello without account_slot never a target | PASS | corch-quota-selection 24 pass, corch-quota-binding 10 pass; agent.ts hello passes account_slot/max_concurrent (agent.ts diff, one line); e2e corch-quota 18 pass/0 skip on real Postgres |
| SC5 | Quota death sets blocked_until, requeues without attempt; each POST = exactly one evaluation | PASS | dispatcher.ts:368-409,457 endQuotaDeath (consumeAttempt false, waitReason quota:death); quota-death.ts anchored whole-text match, 500-char cap; markDeath GREATEST/LEAST clamp (quota-store.ts:120-130). quota.ts:145-149 evaluate once after commit, none on 4xx. corch-quota-death 18 pass, corch-quota-wait 14 pass, ingest spy test in 32 pass |

## Requested checks

(2) Auth / privacy: POST needs explicit quota:publish, GET explicit quota:read; legacy NULL key, other scopes, cookies refused (quota.ts:80-98). user_id only from verified key (quota.ts:140,162). No email column in corch_quota_accounts; grep of quota.ts / quota-*.ts for "email" hits only comments; logs carry user id + error code only, never body or Zod values (quota.ts:110,115,123,142,148). PASS.

(3) Fail-closed rules: in code (quota-eligibility.ts 600s L64, 900s L68, source L74, null-5h L87) and covered by tests (eligibility 37, e2e 18). Unknown 7d never eligible; null 5h not treated as 0. PASS.

(4) Flag OFF: realCorchDeps (dispatcher.ts:788) is reached only by dynamic import after corchEnabled; defaultQuotaEvaluate returns before import when flag off (quota.ts:193-197); DEFAULT_QUOTA_PROVIDER retained. corch-flag-off 5 pass, corch-boot-assert 15 pass, corch-gates 58 pass (CORCH-01 untouched files), launch-callers-guard 12, launch-machine-guard 11, kill-switch-coverage 10, token-cap 7, counter-key 9. Diff 0f12261..HEAD of hub/src/telegram/launch.ts (+21/-1) and governed-launch.ts (+15/-1): purely opt-in additions (`targetSupervisorId`, `resolveTarget`); both default to the previous pick-by-hostname path when omitted, and heal/orchestrator/non-corch callers omit them (guards green). PASS with scope note N1.

(5) Schema diff: single `CREATE TABLE IF NOT EXISTS corch_quota_accounts` with FK to users ON DELETE CASCADE; no DROP/TRUNCATE/ALTER; nothing else in schema.sql changed. PASS.

(6) No API keys/secrets: grep of added hub/src + hub/test lines for ANTHROPIC/OPENAI keys, sk-*, AKIA, private-key blocks: 0 hits. No setInterval/setTimeout/setImmediate in quota.ts or corch/quota-*.ts; corch-no-polling-guard 2 pass unchanged. No hub/src/usage or thresholdGate import under hub/src/corch or api/quota.ts. PASS.

(7) Each as its own bun process (all rc 0, 0 fail): kill-switch-coverage 10, token-cap-coverage 7, counter-key-assignment-guard 9, launch-callers-guard 12, launch-machine-guard 11, corch-no-polling-guard 2, api-keys-scopes 37, mount-order 29, csrf 30; corch-boot-assert 15, corch-flag-off 5, corch-gates 58, corch-prompt 3, corch-quota-binding 10, corch-quota-death 18, corch-quota-eligibility 37, corch-quota-ingest 32, corch-quota-selection 24, corch-quota-wait 14, corch-routes 13.

(8) CI-equivalent (fresh db vf_p02 created, createdb rc 0; DATABASE_URL and REMO_E2E_DB_URL set; JWT_SECRET placeholder): `bun run check-baseline` exit 0: actual pass=4054 skip=0 fail=0 total=4054 ("OK within tolerance"). E2E on same DB: corch-quota 18 pass/0 skip/0 fail, corch-dispatcher 28 pass/0 skip, schema-double-apply 9 pass/0 skip.

(9) `bunx tsc --noEmit -p hub/tsconfig.json`: 253 error TS (<= 253, equals recorded N0 in RESEARCH.md). Five errors sit in files this phase touched (launch.ts:64, agent.ts:493/887/891/1246) but git blame shows those lines predate the phase (2026-05 / 2026-06 authors), so delta is 0. schema-lint rc 0, migration-verify rc 0 (pg bin on PATH).

## QC artifacts noted

- QC-CLAUDE.md: round-1 Claude lens vs 77fe72a, CONTENT BLOCK (1 HIGH untrusted-text death DoS, MED write-skew, MED false-positive). Subsequent commits 9c450ac (F1 window cap + clear), 2bce816 (F4 advisory xact lock, quota-store.ts:103), 781c455/2a3e396/9a4c442/e5e0eed address them; code confirmed present.
- QC-CODEX.md: round-1 Codex vs 77fe72a, CONTENT BLOCK (5 HIGH, 1 MED). Fixes present: F2 GREATEST (quota-store.ts:130), F3 5h hold (dispatcher.ts:76-77,372), F4 lock, F5 account/launch binding (resolveTarget dispatcher.ts:540), F6 busy counts in GET (quota.ts:163).
- QC-CODEX-R2.md: round-2 Codex vs 77fe72a..f68df22, CONTENT BLOCK (3 MED, 1 LOW). Follow-up commits 0ea4702 (G1 item 600s backoff), 150c17b (G2 future-dated reading rejected, quota.ts:118-125), 7b73b1c (G3 re-read supervisor account at launch resolution) target exactly those; tests pass.

## Notes (non-blocking)

- N1 Scope fence: plan do_not_touch listed hub/src/dispatch bodies, and files_modified omits hub/src/telegram/launch.ts and hub/src/dispatch/governed-launch.ts. Both were edited (QC F5 binding fix). Additive and opt-in; guards green. Plan/SUMMARY should record the deviation.
- N2 No QC round on final HEAD: 6bf7e36 post-dates every QC report (latest reviewed range ends f68df22). G1-G3 fixes were verified here by tests and code reading only, not by a third independent QC pass. Per global rule 15 a final /qc re-run is advisable before merge.
- N3 Residual by design (acknowledged in QC-CODEX-R2 LOW 4 / QC-CLAUDE): quota death is classified from assistant text (whole-text anchored, 500 char cap, window clamped, cleared by next live reading); no runner-origin signal exists yet. Impact limited to own user's account, bounded block.
- N4 Baseline note stale: `_skip_note_corch_02` and skip_max 336 are computed for 13 e2e tests but corch-quota.e2e.test.ts now has 20 tests (20 skip without DB). A bare local `check-baseline` with no DB would count 323+20=343 skips > 336; CI qc.yaml sets DB (skip=0) so CI is green (verified: skip=0 here). Update skip_max / note to 20 before merge to keep a DB-less local run green.
- N5 Flag OFF still serves POST/GET /api/quota/snapshot and stores rows (documented; no dispatch effect).
- N6 Supervisor-side `account_slot` is CORCH-09; with flag ON dispatch refuses quota:no_slot_supervisor until then (intended, nothing launches in prod).

## Gaps

None blocking. No MISSING or PARTIAL success criteria. No deferred items needed.

## Errors / tickets

No tool errors hit; no autofix tickets filed. Test DB vf_p02 left on 127.0.0.1:55432 (scratch).

_Verified: 2026-11-13 - Verifier: Claude (gsd-verifier)_
