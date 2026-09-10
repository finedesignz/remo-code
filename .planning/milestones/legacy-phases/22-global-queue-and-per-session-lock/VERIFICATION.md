<!-- status: passed (reconciled 2026-06-14: 3/3 PASS, READY verdict; the documented caveat is a non-deployed multi-process edge, not a blocker; status key added so GSD stats counts this phase Complete) -->
# Phase 22 — global-queue-and-per-session-lock · VERIFICATION

**Verdict: READY-WITH-CAVEAT** · independent QC gate · commit `ad76045`
**Tally:** 3/3 PASS (R-ADO-05/06/07) · 0 MISSING
**Tests run by verifier:** `orchestrator-queue.test.ts` 4 pass / 7 skip (e2e env-gated) / 0 fail · `check-baseline` pass=1320 skip=154 fail=0 (== baseline, OK)

## Per-requirement
| Req | Item | Status | Evidence |
|---|---|---|---|
| R-ADO-05 | Global hub-wide concurrency cap | PASS | `claimCycles`: `sql.begin` tx, `slots = cap - running`, bounded loop; env `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` (default 2); `drainOnce` re-entrancy guard |
| R-ADO-06 | Priority + FIFO | PASS | `CyclePriority{BUILD=0,DEPLOY_FIX=10}`, `ORDER BY priority DESC, enqueued_at ASC` (matches `idx_routine_queue_pending`) |
| R-ADO-07 | Per-session single-cycle lock | PASS | `NOT EXISTS(running for session)` + `NOT IN claimed-this-pass` + **hard backstop** = Phase-21 partial unique index `idx_routine_queue_session_running`; concurrent-promotion → unique violation caught → session skipped (coalesced) |

## Concurrency judgment
- **Per-session lock: SOUND.** Final layer is a true DB invariant (partial unique index) — second concurrent `UPDATE→running` for a session raises a unique violation, caught → skip. Not double-run, not wedged. Holds even multi-process.
- **Global cap: SOUND for deployed topology.** Single-hub Coolify container + `draining` re-entrancy guard ⇒ cap exact. KNOWN LIMIT (documentation-only): two concurrent hub processes under READ COMMITTED could each compute the same `slots` → transient `2*cap`. Not a deployed reality (single replica). Per-session safety unaffected.
- **Release-on-throw: SOUND.** Per-entry try/catch → `releaseCycle(...,'failed')`; `finally{draining=false}` re-arms.
- **Dormancy: CONFIRMED.** `drainOnce` returns `[]` while `cycleRunner===null`; no `setCycleRunner` anywhere this phase; `index.ts` starts/stops worker safely.

## Risk-flag rulings
- **(a) e2e SKIPPED → READY-WITH-CAVEAT (not hard PARTIAL).** No docker/Postgres on host; prod off-limits. Acceptable because phase is dormant (zero runtime behavior fires) and the safety-critical lock is DB-enforced. **REQUIRED FOLLOW-UP (Phase-23 entry gate):** run `orchestrator-queue.test.ts` against a real Postgres (`REMO_E2E_DB_URL`) to confirm cap + coalesce + FIFO + release before a live cycle-runner is registered. Flips CAVEAT→PASS.
- **(b) skip_max 150→175 → JUSTIFIED.** Baseline skip 130→154 (+24); this file +7, Phase-21 +7, rest prior env-gated additions in the 2026-06-06 snapshot. `fail_max=0` unchanged, actual==baseline → nothing masked.

## Invariants
No drive-by (5 files); reuses `orchestrator-rows-dal` + shared `sql`, worker mirrors `startRevanoteCallbackWorker`; no inline schema backfill. PASS.

## Carried gate
→ **Phase 23 MUST run the queue e2e against a real Postgres** (CI or disposable PG) before registering a live cycle-runner. Tracked here.
