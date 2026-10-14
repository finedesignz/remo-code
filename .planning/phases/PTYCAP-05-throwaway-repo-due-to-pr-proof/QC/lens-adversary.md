# PTYCAP-05 QC - Security/Adversary lens

Diff: ec2237e..HEAD (hub/, docs/ptycap-05-proof-runbook.md; supervisor/ untouched).
Method: read of guard, gates, arm, protection, verifier, evaluators, github adapter, DAL, schema, macro-cycle/inject/merge-command diffs, API route, script, runbook. Ran `bun test hub/test/orchestrator-proof-noop.test.ts` (39 pass).

Checked and CLEAN: no provider API key anywhere in proof modules; supervisor unchanged; `/api/orchestrator/proof` is GET-only, mounted after auth/step-up catch-all, user id only from c.get('userId'), allowlist-mapped response, `/api/api-keys` untouched; both inject.ts gate lists carry kill switch first, proof gates 2nd/3rd, token cap + counter retained (coverage tests pin it); counter-key pin makes any non-`task:<id>` dispatch to the proof session fail closed (covers merge-command/verify-tail/wave-runner injects); proof prompt is rendered from the claimed snapshot with no fallback to the dev macro while the flag stack is ON; guard fails closed on claim/lookup/render error; terminalize is single-winner conditional UPDATE; read-only GitHub adapter (GET only, ids URL-encoded); ruleset shapes require zero VISIBLE bypass actors; rollback order (disarm/kill first, flags second) is correct.

## Findings

### 1. MAJOR - Arming flips the GLOBAL orchestrator flags with no check (or runbook warning) that no other orchestrator task is enabled
- Where: hub/src/orchestrator/proof-arm.ts (armProof steps 1-10 inspect only the autospawn allowlist), hub/src/orchestrator/controller.ts:`scanAndEnqueueDueCycles` (selects EVERY `task_type='orchestrator' AND enabled`), docs/ptycap-05-proof-runbook.md section 4 step 4.
- Exploit path: runbook step 4 sets `REMO_ORCHESTRATOR_ENABLED=1` + `REMO_ORCHESTRATOR_AUTOSPAWN=1` hub-wide. The allowlist only restricts OFFLINE autospawn; any other enabled orchestrator task on an ONLINE session (this user or any user) now ticks. `proofGuard` returns `pass_through` for tasks with no proof run, so they receive the ordinary dev macro (squash-merge, deploy) on their repos. Project history: orchestrator was paused (ENABLED=0) after it self-scoped and merged through red CI (#309). This is the "escape to another repo / get the dev macro" path (b)/(d), caused by arming rather than by the agent.
- Fix: arm refuses (`other_orchestrator_task_enabled`) when any other enabled orchestrator task exists (scope: all users, since flags are global); add the same check to `--enable`; add a runbook prerequisite and an idle-safety verification line ("zero enabled orchestrator tasks other than the proof task").

### 2. MINOR - Dev macro reachable for a proof task if the flag stack is partially off (documented, panel-locked, no code backstop)
- Where: macro-cycle.ts `if (isProofEnabled())`; proof-arm.ts/DAL create the task with `macro_task_type='dev'`; `enableProofTaskTx` does not verify flags.
- Exploit path: task enabled via `--enable`, then any of PROOF/ENABLED/AUTOSPAWN is off or drifts (typo, redeploy of old env, rollback done in wrong order) -> guard skipped, merge-command refusal skipped, dev macro injected on the throwaway repo. Preventive control is then only the ruleset.
- Fix: cheap boot/tick assertion: if an active proof run exists and `!isProofEnabled()`, disable the proof task (single UPDATE, only runs when a proof row exists, preserves flag-OFF zero-work for everyone else via an existence check at boot).

### 3. MINOR - Arm proceeds with `agent_permission = unverified`
- Where: proof-arm.ts step 9, proof-protection.ts `assertAgentNotAdmin` (no `--agent-login` => `verified:false`).
- Exploit path (e): if the supervisor host's git/gh identity is the repo owner (admin on a personal repo), the agent can delete/edit the ruleset and merge in one turn; hub re-assert only detects it at the NEXT dispatch/tick (after damage). Only a warning is printed; `--enable` does not require `verified`.
- Fix: require `--agent-login` (refuse `agent_login_required`) or make `--enable` refuse unless `agent_permission === 'verified'`.

### 4. MINOR - Verifier PR-scope misses PRs whose head is not under `proof/` and never checks changed files
- Where: proof-github.ts `listPullsWithHeadPrefix` filters to `proof/` heads; proof-verifier.ts.
- Gap vs CONTEXT D-10(iii) ("any PR whose head is not under proof/ is terminal") and prompt promise (one docs file). A PR from `feature/x` into main, or a proof PR that edits `.github/workflows/*` to force a green required check, is not flagged; `pr_open_green` can be rigged. Main stays protected by the ruleset, so this is proof-integrity, not a merge path.
- Fix: also list open PRs against the default branch with any head and terminate `pr_scope_violation` on a non-proof head; fetch PR files and require exactly `docs/proof-<run-id>.md`.

### 5. MINOR - Session-scope kill switch persists after terminal/disarm and arm does not check it
- Where: proof-guard.ts `finishProofRun` / proof-arm.ts `disarmProof` engage it; evaluators run `killSwitch` first; armProof and runbook never release it.
- Effect: re-arming the same session ends immediately as `nothing:kill_switch` with no explanation. Fail-safe direction, operationally confusing.
- Fix: arm dry-run reports an engaged kill switch for the session; runbook adds a release step.

### 6. MINOR - No upper bound on arm budgets
- Where: proof-arm.ts `resolveBudget` accepts any safe positive integer (`--max-tokens 9e15`). Owner-supplied only; the global daily cap still binds, but the "hard budget" can be set effectively unbounded. Fix: ceiling constants (e.g. tokens <= daily cap, wall <= 24h) requiring a distinct flag to exceed.

## Residuals acknowledged (not findings)
In-flight turn not cancelled on budget trip/kill switch (runbook section 6); the agent process and its git credential survive terminal/disarm until the supervisor session idles out.

## Verdict: CONTENT-BLOCK (1 MAJOR: finding 1)
