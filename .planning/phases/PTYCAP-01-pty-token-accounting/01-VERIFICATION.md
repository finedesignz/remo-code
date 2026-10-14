---
phase: PTYCAP-01-pty-token-accounting
verified: 2026-10-07
status: gaps_found
score: 3/3 success criteria implemented; 1 MAJOR accuracy gap (G-1), 1 MINOR evidence gap (G-2); 0 BLOCKERs
verifier: independent goal-backward verification (SUMMARY.md self-reports not trusted)
merged_as: "22cb187 feat(PTYCAP-01) (#395)"
worktree: C:\Users\artic\GitHub\remo-code-gsd (branch phase-ptycap-03-governed-automation-guard)
---

# Phase PTYCAP-01: PTY Token Accounting - Verification Report

**Goal:** The hub knows what a PTY turn is spending while it spends it, not after.

Method: read implementing code directly, ran each proving test file in isolation (one bun process per file), and
checked one claim against a real on-disk Claude transcript. No source, test, or config file was modified.

## Success criteria

| SC | Criterion | Verdict | Evidence |
|----|-----------|---------|----------|
| SC-1 | A live PTY turn's token usage is observable mid-turn, not only on completion | PASS | Tailer: `supervisor/src/usage/pty-usage-emitter.ts` `pinAndTail` L321-386 calls `tailJsonl(..., {fromStart:true})` and emits one `usage_event` per assistant record (L350-362), no exit/kill gating. Lifecycle owner `supervisor/src/runners/session-bridge.ts` L539 (pre-spawn snapshot), L570-579 (`new PtyUsageEmitter().start`, `emit: sendToHub`), stop at L267/L348/L557. Hub ingest `hub/src/ws/agent.ts` L790-840 `recordTokenUsage({runnerType: msg.runner_type ?? 'stream-json'})`. Proof test `supervisor/test/pty-usage-tail.test.ts` 28 pass / 0 fail (incl. "live-appended assistant usage record emits exactly one tagged frame while the file is still open"). Wired into CI: `.woodpecker/qc.yaml` L52. |
| SC-2 | Interactive and programmatic usage remain in separate buckets | PASS | `hub/src/db/schema.sql` L1351 `ADD COLUMN IF NOT EXISTS runner_type ... DEFAULT 'stream-json'`, L1353 guarded CHECK, L1354 `idx_token_usage_user_runner_created` (additive/idempotent; later 'cloud' widening at L1584-1597 is guarded and from another milestone). Zod `hub/src/ws/agent-protocol.ts` L201 `runner_type` (exact key name verified; absent => 'stream-json'). DAL `hub/src/db/token-usage-dal.ts` L27/L38-49 threads runnerType; `getTodayTokenTotalByRunner` L231-252 splits the buckets for observability. `token_usage_daily` PK deliberately unchanged (documented). Tests: `token-usage-runner-type` 7/0, `usage-event-handler` 5/0 (untagged frame => stream-json). Live-Postgres CHECK-rejection case in `hub/test/e2e/schema-double-apply.e2e.test.ts` is DB-gated: 0 pass / 10 skip locally (see G-2). |
| SC-3 | A long-running TUI turn that crosses the ceiling mid-flight is detectable | PASS (caveat G-2) | `getTodayTokenTotal()` (`token-usage-dal.ts` L209-222) sums all four buckets (input+output+cache_creation+cache_read) from `token_usage`, live, no close event required; PTY rows land per assistant record (SC-1), so the total climbs mid-turn. Cap stays token-denominated. Mid-flight proof `hub/test/pty-usage-midflight-visibility.test.ts` is `REMO_E2E_DB_URL`-gated: 0 pass / 6 skip / 0 fail locally; only executes in Woodpecker postgres:16. I could not observe it pass. Phase deliberately does NOT gate (RECORD only; gating is Phase 2). `token-cap-coverage` 3/0, `token-cap-gate-fires` 8/0 still green. |

## Plan must_haves (existence + wiring, read from code)

| Plan | Artifact / link | Status |
|------|-----------------|--------|
| 01-01 | `supervisor/src/usage/pty-transcript-tail.ts` (144 lines), `pty-usage-emitter.ts` (405 lines) exist, substantive | VERIFIED |
| 01-01 | session-bridge `ensurePtyRunner` -> `PtyUsageEmitter.start` -> `sendToHub` -> zod -> `recordTokenUsage` chain | WIRED (all hops read) |
| 01-01 | Malformed line never fatal (try/catch L363, `onParseError`); uuid dedupe bounded (cap 5000); capture-once locator fails closed on ambiguity/unreliable snapshot; claude-only (codex no-op L240) | VERIFIED in code + tests |
| 01-01 | No hub module reads homedir transcript path | `hub/test/no-hub-side-transcript-fs.test.ts` 4/0 |
| 01-02 | `hub/test/token-usage-runner-type.test.ts`, usage-event-handler cases, e2e CHECK case | exist; e2e case skipped locally |
| 01-03 | midflight test, hub-fs canary, `supervisor/test/pty-usage-path-containment.test.ts` | exist; containment 6/0, canary 4/0, midflight skipped locally |
| 01-04 | `.woodpecker/qc.yaml` L52 runs both supervisor tests; `tools/regression-baseline.json` has `_skip_note_ptycap` with stated reasons; `docs/usage-cost.md` L241-345 PTYCAP Phase 1 section (flow, 4 decisions, tests); `CLAUDE.md` L392 usage-ledger row names the PTY source | VERIFIED; docs match code (index name `idx_token_usage_user_runner_created`, key `runner_type`) |

## Hard invariants

| Invariant | Verdict | Evidence |
|-----------|---------|----------|
| No provider API key on PTY path / argv allowlist-of-one | PASS | Emitter is read-only transcript tail; touches no env/argv. Guards: `no-api-key-no-streamjson-pty` 5/0, `no-apikey-fallback-guard` 7/0, `default-backend-selector` 22/0. |
| Caps denominated in tokens | PASS | `getTodayTokenTotal` 4-bucket token sum; cost_usd from frames is 0/estimated, hub estimates. |
| Additive idempotent DDL only | PASS | `ADD COLUMN IF NOT EXISTS`, pg_constraint-guarded CHECK, `CREATE INDEX IF NOT EXISTS`; no backfill. |
| RECORD only, never gates/writes PTY | PASS | No gate imports; emit only. |

## Test runs (each file isolated, own bun process)

| File | Pass | Fail | Skip |
|------|------|------|------|
| supervisor/test/pty-usage-tail.test.ts | 28 | 0 | 0 |
| supervisor/test/pty-usage-path-containment.test.ts | 6 | 0 | 0 |
| supervisor/test/no-api-key-no-streamjson-pty.test.ts | 5 | 0 | 0 |
| supervisor/test/no-apikey-fallback-guard.test.ts | 7 | 0 | 0 |
| supervisor/test/default-backend-selector.test.ts | 22 | 0 | 0 |
| hub/test/token-usage-runner-type.test.ts | 7 | 0 | 0 |
| hub/test/usage-event-handler.test.ts | 5 | 0 | 0 |
| hub/test/no-hub-side-transcript-fs.test.ts | 4 | 0 | 0 |
| hub/test/token-cap-coverage.test.ts | 3 | 0 | 0 |
| hub/test/token-cap-gate-fires.test.ts | 8 | 0 | 0 |
| hub/test/pty-usage-midflight-visibility.test.ts | 0 | 0 | 6 (REMO_E2E_DB_URL unset) |
| hub/test/e2e/schema-double-apply.e2e.test.ts | 0 | 0 | 10 (REMO_E2E_DB_URL unset) |

## Gaps

### G-1 (MAJOR) - Per-record uuid dedupe overcounts: one API response is split across several transcript records
- Evidence: `pty-usage-emitter.ts` L340-349 dedupes only on the record `uuid`, and emits every assistant record's `message.usage`. Checked against a real local Claude transcript (read-only analysis, largest-3rd session in `~/.claude/projects/C--Users-artic-GitHub-remo-code`): 165 assistant records with usage, 165 unique uuids, but only 89 unique `message.id`. Summing every record = 39,436,414 tokens vs 21,419,447 when counting each `message.id` once, a 1.84x overcount (dominated by repeated cache_read). Neither the emitter, `extractUsage`, the tests, nor RESEARCH/REVIEW docs mention `message.id` / `requestId`.
- Impact: the ledger and `getTodayTokenTotal()` run high for PTY sessions (fail-safe direction for a cap, but it falsifies "what a PTY turn is spending", trips the token cap early in Phase 2, and skews the interactive-vs-programmatic early-warning comparison). SC-1..3 observability is unaffected; accuracy is.
- Proposed minimal fix: key the dedupe on `record.message.id` (fallback `uuid` when absent), and when the same id reappears keep only the max/last usage per id (emit a delta rather than a repeat). Add a test fixture with three records sharing one `message.id`.

### G-2 (MINOR) - Live-Postgres proofs not observed in this run
- Evidence: `pty-usage-midflight-visibility.test.ts` (6) and the `token_usage_runner_type_check` case in `schema-double-apply.e2e.test.ts` skip without `REMO_E2E_DB_URL`; no disposable Postgres in this environment. SC-3's mid-flight climb and SC-2's DB-level CHECK rejection are therefore verified by code reading (SQL and DDL inspected) plus the Woodpecker wiring claim, not by an observed green run.
- Proposed minimal fix: confirm the PR #395 / latest main `qc` pipeline ran these un-skipped against postgres:16 (or run them once with `REMO_E2E_DB_URL`). Not a code change.

## Summary

Goal is achieved in code: PTY transcript spend is tailed supervisor-side, tagged `pty-interactive`, recorded per assistant record while the session is live, stored in a CHECK-constrained `runner_type` column, and summed live by the existing 4-bucket token total. All invariants hold and all runnable proofs pass (0 fail). Status is `gaps_found` solely because of G-1 (token accuracy: roughly 1.8x overcount on a real transcript); G-2 is an evidence caveat. No BLOCKERs.
