---
phase: 18-billing-guardrail-dual-bucket-usage
verified: 2026-06-01T00:00:00Z
status: passed
score: 5/5 plan must-haves verified
re_verification:
  previous_status: none
---

# Phase 18: Billing Guardrail — Dual-Bucket Usage — Independent Verification

**Verdict:** PASS
**Verified:** 2026-06-01 (independent, against source — SUMMARY claims not trusted)
**Mode:** Initial verification

## Goal Achievement — Observable Truths

| # | Truth (plan) | Status | Evidence |
|---|---|---|---|
| 1 | Dual-bucket poll: nullable programmatic_credit, no fabrication, token never serialized | ✓ VERIFIED | `supervisor/src/usage/oauth-poll.ts` |
| 2 | Hub store + WS additive (optional/nullable), old payload still validates | ✓ VERIFIED | `agent-protocol.ts:162`, `usage/store.ts:25`, additive test |
| 3 | Leak alert + hard-halt added INSIDE dailyCostCapGate (no bypass); DDL idempotent | ✓ VERIFIED | `dispatch/gates.ts:121-143`, `usage/programmatic-leak.ts`, `schema.sql:294` |
| 4 | Automation sources PTY-excluded → stream-json, no ANTHROPIC_API_KEY | ✓ VERIFIED | `automation-routing-guard.test.ts` |
| 5 | UsageTab dual-bucket card + empty state + opt-in halt toggle (default OFF); no indigo; accent blue | ✓ VERIFIED | `web/src/pages/settings/UsageTab.tsx` |

**Score:** 5/5 truths verified.

## Item-by-Item Findings

### 1. Dual-bucket poll (supervisor/src/usage/oauth-poll.ts)
- `ProgrammaticCredit` typed `programmatic_credit?: ProgrammaticCredit | null` (line 65), optional + nullable.
- `parseProgrammaticCredit(body)` (line 136) returns `null` when: body absent/non-object (137), no recognised credit container — checks `programmatic_credit ?? agent_sdk_credit ?? credit_pool` (138-143), or used/limit not finite numbers via `pickFiniteNumber` (147-149). **No fabricated numbers** — explicit comment "never default to 0/limit".
- OAuth token read ONLY in `readAccessToken` from `~/.claude/.credentials.json`; the parse path (`parseProgrammaticCredit`/`parseUsageResponse`) never touches it.
- **Negative test EXISTS:** `supervisor/test/oauth-poll-dual-bucket.test.ts:80-96` ("returns both buckets and NEVER leaks the token") — asserts `JSON.stringify(res.usage)` does not contain FAKE_TOKEN, "accesstoken", or "Bearer".

### 2. Hub store + WS additive (non-breaking)
- `hub/src/ws/agent-protocol.ts:162` — `programmatic_credit: ProgrammaticCredit.nullable().optional()` inside `usage_report`.
- `hub/src/usage/store.ts:25` — `programmatic_credit?: ProgrammaticCredit | null`.
- **Test:** `hub/test/usage-dual-bucket-additive.test.ts` — "old-shape payload (no programmatic_credit) still validates" (line 38), new-shape validates + carries bucket (44), null accepted (57), store round-trips (69), old-shape stores with no bucket (75), no token-shaped field on snapshot (81). 6/6 pass.

### 3. Leak alert + hard-halt (cost-cap invariant intact)
- `hub/src/usage/programmatic-leak.ts` exports `detectProgrammaticLeak` (line 65) and `isOverProgrammaticHalt` (line 108).
- **Hard-halt is an ADDED predicate INSIDE `dailyCostCapGate`** (`hub/src/dispatch/gates.ts:121-143`): the gate first checks `getCostCapStatus`/`isOverCostCap` (cost cap, single SQL source of truth — lines 125-131), THEN checks `getProgrammaticHaltStatus` → `isOverProgrammaticHalt` (138-141). Same gate object, same chokepoint. **NOT a fork/bypass** — no parallel gate; comment line 132-137 explicitly documents "rides the SAME chokepoint as an additional predicate (no parallel gate)".
- **Cost-cap single-source invariant CONFIRMED:** `isOverCostCap` remains the only daily-USD predicate; the halt does not replace, weaken, or short-circuit it. Default OFF (null bound → `isOverProgrammaticHalt` returns false). Automation-routing test line 49 asserts the cost-cap gate is the gate automation flows through.
- **DDL:** `hub/src/db/schema.sql:294` — `ALTER TABLE users ADD COLUMN IF NOT EXISTS programmatic_halt_usd NUMERIC(10,4) NULL;` — idempotent, NULL default, **NO inline backfill** (explicit comment line 936 "intentionally NO backfill UPDATE here").

### 4. Automation-routing guard
- **Test:** `hub/test/automation-routing-guard.test.ts`. `UNATTENDED_SOURCES = ['scheduler','orchestrator-background','auto-dev','error-capture']`. Each: recognised AUTOMATION actor (28-29), REJECTED on `pty-interactive` (31-32), ALLOWED on `stream-json` (34-37). Only `human` may drive pty-interactive (41-46). No-ANTHROPIC_API_KEY: every spawning runner deletes ANTHROPIC_API_KEY from env (59-69). 15/15 pass.
- Supplementary supervisor canary `no-api-key-no-streamjson-pty.test.ts` (5/5) enforces no programmatic flag + literal `delete env.<KEY>` / `sanitizeSpawnEnv` on PTY runners.

### 5. Usage UI
- `web/src/pages/settings/UsageTab.tsx`: `ProgrammaticCreditCard` (line 90) renders dual-bucket; **empty state** lines 113-115 ("Programmatic credit not claimed or unavailable yet") when `!credit || !credit.claimed`. **Opt-in halt toggle default OFF** (lines 408-417): `haltEnabled` initialized from `profile.programmatic_halt_usd ?? null`; null → OFF. Disabled/empty/0 persists null (OFF) (lines 472-478).
- **No indigo:** grep "indigo" in UsageTab → none. `web/test/no-indigo.test.ts` present and passing in suite. Accent **blue** (`accent-blue-500`, `ring-blue-500/50`).

## Behavioral / Test Execution

### check-baseline (JWT_SECRET dummy 36-char)
```
baseline: pass=785 skip=129 fail=0 total=914
actual:   pass=1218 skip=130 fail=0 total=1348
OK — within tolerance.
```
**fail=0.**

### Isolated Phase 18 test files
| Test file | Result |
|---|---|
| hub/test/programmatic-hard-halt.test.ts | 10 pass / 0 fail |
| hub/test/programmatic-leak-alert.test.ts | 6 pass / 0 fail |
| hub/test/usage-dual-bucket-additive.test.ts | 6 pass / 0 fail |
| hub/test/automation-routing-guard.test.ts | 15 pass / 0 fail |
| hub/test/usage-store.test.ts | 5 pass / 0 fail |
| supervisor/test/oauth-poll-dual-bucket.test.ts | 5 pass / 0 fail |
| supervisor/test/oauth-poll-credit-absent.test.ts | 2 pass / 0 fail |
| supervisor/test/no-api-key-no-streamjson-pty.test.ts | 5 pass / 0 fail |

**Total isolated: 54 pass / 0 fail.** No flaky/pre-existing failures observed.

## Cost-Cap Invariant Confirmation

CONFIRMED INTACT. `dailyCostCapGate` is the single chokepoint; `isOverCostCap` (single SQL source of truth, `gates.ts:66`) is checked first and unchanged. The programmatic hard-halt is an additional `return {ok:false}` predicate appended within the same `check()` after the cost-cap check — it can only ADD a denial, never permit a dispatch the cap would block. No parallel/fork gate exists. Cap was NOT bypassed.

## Deferred / Open Items

- Live `/api/oauth/usage` field-name confirmation for the programmatic-credit container is the documented OPEN ITEM (oauth-poll.ts:117 / RESEARCH §2). It is legitimately deferred: parser recognises 3 candidate shapes and **degrades to the empty state** (returns null, no fabrication) if the live shape differs. Does not block the phase.

## Gaps

None. All 5 plans genuinely implemented, cost-cap invariant intact, only open item is the legitimately-deferred live-endpoint field confirmation (safe empty-state degradation).

---
_Verified: 2026-06-01_
_Verifier: Claude (independent gsd-verifier), worktree feat/interactive-pty-runner_
