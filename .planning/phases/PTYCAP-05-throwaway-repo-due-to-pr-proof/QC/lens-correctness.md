# PTYCAP-05 QC - lens: CORRECTNESS + TEST-HONESTY

Scope: git diff ec2237e..HEAD -- hub/ supervisor/ tools/ (supervisor/ has no diff). Reviewed proof-guard, proof-gates, proof-evaluators, proof-verifier, proof-protection (reassert), proof-arm, proof-prompt, orchestrator-proof-dal, schema.sql delta, macro-cycle / merge-command / inject wiring, API route, coverage-test and baseline deltas. Re-ran dal, cycle, gates, disarm test files: all pass (23/12/23/10).

Result: no CRITICAL, no MAJOR found. Fail-closed behavior verified on every path checked.

## Verified OK (hunted, not found)
- Guard fails closed: claim throw -> terminalize-by-task + blocked; render throw -> abort, no inject, never the dev macro (macro-cycle.ts step 1b, proof-guard.ts:159-204).
- Single-winner: claim and terminalize are single conditional UPDATEs (dal:18-76); disarm/arm/enable under per-user advisory xact lock; partial unique indexes enforce single-flight.
- Flag OFF: macro-cycle/merge-command/gates only statically import proof-types (no db/network); guard, DAL, GitHub are dynamic-imported behind isProofEnabled().
- schema.sql delta is idempotent (IF NOT EXISTS, DO-block constraints, no backfill, no FK).
- Gates fail closed on lookup error; terminal run blocks parked replays; protection gate swallows only `updated_at_changed` AFTER the digest (which includes every ruleset updatedAt) matched.
- Verifier never greens on neutral/skipped/truncated/unreadable; default-branch advance is re-compared after the CI read.
- baseline: pass_min/skip_max/fail_max untouched (1850/260/0); no skip/only/todo in new tests; kill-switch and token-cap coverage tests assert length 2 (non-vacuous).

## Findings

1. MINOR - stale prior-reply sentinel can end a fresh proof as agent_declined.
   proof-evaluators.ts:134-142 (also proof-guard.ts:51 duplicate evaluator). agentDeclined reads `input.sentinels.state.last_action` from the session's PRIOR reply with no check that a proof inject has happened (e.g. run.last_inject_outcome null / started this tick). On the first proof tick a leftover `last_action: nothing ...` from earlier non-proof activity terminates the run `nothing:agent_declined` before it injects. Fail-safe (not fail-open) but yields a false proof result. Fix: honor the claim only when run.last_inject_outcome is a dispatched/queued kind (an inject occurred for this run).

2. MINOR - merge-refusal is skipped when ctx.repoKey is null.
   merge-command.ts:129 `isProofEnabled() && ctx.repoKey`; MergeCtx.repoKey is `string | null` (line 66). With null the proof-repo refusal never runs (fail-open on that layer). Mitigated because the inject gate list (counter-key pin) still blocks, but D-10(i) says refuse. Fix: if isProofEnabled() and repoKey is null, look up by session (findProofRunForRequest sessionId) or refuse `proof_repo_never_merges:unverifiable`.

3. MINOR - never-merge refusal ends when the proof goes terminal; allowlist row and repo stay armed-capable.
   finishProofRun (proof-guard.ts:111-151) does not remove the allowlist row; findActiveProofRunForRepo only matches armed/running (dal:270). After `succeeded` the repo remains autospawn-allowlisted and merge-to-main is no longer refused; only the task being disabled + session kill switch + the GitHub ruleset stand. If the owner re-enables the task, dev macro could run against it. Fix: remove the exact allowlist row in the terminalizer (or make merge refusal consider the latest terminal run too).

4. MINOR - disarm deletes a pre-existing owner allowlist row for the same repo.
   dal:172-176 uses ON CONFLICT DO NOTHING (row may pre-exist) but disarm (dal:226-229) always deletes it. Fix: record in arm_preconditions whether the arm created the row and delete only then.

5. MINOR - re-arm accumulates duplicate `proof` orchestrator_rows.
   dal:168-171 inserts a new row each arm; schema has no unique (task_id, command) and disarm only disables. The task is reused (dal:143-153), so duplicate disabled/enabled rows accumulate and a stale enabled row could be due-scanned. Fix: delete-by-exact (task_id, command='proof') or upsert in the arm tx.

6. MINOR (test-honesty) - real-SQL proof is folded into an existing DB-gated test.
   orchestrator-autospawn.e2e.test.ts + e2e/proof-checks.ts: DAL unit tests run on proof-fake-sql.ts (an in-memory emulation); real postgres coverage only runs inside Woodpecker and silently vanishes (no skip counted) wherever that host test is skipped. Baseline "pass" +438 is only 380 itemised (58 unexplained, disclosed). Not a defect in behavior; fix: make the e2e helper its own named test (accept +1 skip locally) so absence is visible.

7. MINOR - claim flips armed->running (and starts the wall clock) before the HALT/gate check.
   macro-cycle.ts:158-188 vs step 2 halt return: a halted tick still sets started_at. Harmless (fail-safe, shortens budget) but surprising. Fix: none required; document.

## Verdict: PASS (no CRITICAL/MAJOR; 7 MINOR advisory)
