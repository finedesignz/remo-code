# Phase 5: Throwaway-Repo Due->PR Proof - Context

**Gathered:** 2026-10-13
**Status:** Ready for planning (3 forks in `05-FORKS.md` carry recommendations the planner adopts unless the panel overturns them)
**Stack:** branch `phase-ptycap-05-throwaway-repo-proof`, stacked on Phase 4 PR #506 / Phase 3 PR #505.

<domain>
## Phase Boundary

Phase 5 delivers ALL code, config and docs needed so that ONE owner-armed run can take the orchestrator from a due `dev` build task to ONE reviewable PR with green CI on ONE whitelisted throwaway repo, branch-only, never merging to main, under a hard per-proof budget, OR cleanly do nothing and record why.

**In scope (owner-fixed):**
(a) allowlist entry mechanism for exactly one repo; (b) hard per-proof token + inject budget that terminates the run; (c) branch-only enforcement; (d) code-enforced never-merge-to-main guard; (e) "cleanly does nothing and says why" terminal outcome; (f) the Phase-4 lifetime counter key for the path Phase 5 drives. Everything flag-gated default OFF, a TRUE no-op when OFF.

**Out of scope (explicit):** ARMING the proof in prod (`REMO_ORCHESTRATOR_AUTOSPAWN`, allowlist row, any Coolify env) is an OWNER GO/NO-GO gate - this phase builds and drafts the runbook, it does not run it. No prod DB/env/Coolify change. No supervisor change (no new MSI). No new PTY byte-producer (see D-01). Cleanup of the throwaway PR/branch. Multi-repo proof.

**Honest scope statement (carry into VERIFICATION):** SC-3 ("this has never once happened") is only closed by the LIVE run, which this phase cannot do. Phase 5 verification can prove the machinery against a fake GitHub client and real Postgres; it must report SC-2/SC-3 as "armed-ready, live proof pending owner GO", not PASS.

</domain>

<decisions>
## Implementation Decisions

### Drive path and the counter key ((f))
- **D-01 (evidence-driven, LOCKED):** The path Phase 5 drives is the existing orchestrator macro cycle: `runMacroCycle` -> `injectOrchestratorPrompt` -> `dispatch()` -> `user_message` to a supervisor-hosted stream-json session. NOT the PTY door. Evidence: `governed-pty.ts` HONEST SCOPE (every adapter sends `user_message`, which the supervisor routes to stream-json); no automation `term.input` producer exists in `hub/src`. Phase 4 deferred "automation `term.input` producer (Phase 5)" - this phase deliberately does NOT build it (largest unreviewed autonomy escalation; the proof does not need it; defer to a later phase/GOV). Record the deferral in the Phase 5 VERIFICATION.
- **D-02 (f, LOCKED):** The counter key is ALREADY supplied: `macro-cycle.ts:231-232` threads `taskId` -> `inject.ts` `resolveInjectCounterKey` (:181-189) -> `task:<scheduled_tasks.id>`; both gate lists carry `automationKillSwitchGate` first and `automationLifetimeCounterGate` last (`inject.ts:290-296`, `:447-`), and `preSendGuard` reserves in `pipeline.ts:349`. Phase 5 adds NO new key. It adds (1) a pin test that a proof inject request carries `counterKey === 'task:<proofTaskId>'` and that a missing taskId fails closed `lifetime_counter_key_missing` (no silent `session:` fallback for a proof task: the resolver's DB fallback is acceptable, but the proof gate requires the `task:` form), and (2) the proof budget (D-06) as a LOWER, per-run ceiling than the global 1000-per-key lifetime cap (the global cap is env-global and cannot express a per-proof budget).

### Flag, state, single-flight
- **D-03 (LOCKED):** Master flag `REMO_ORCHESTRATOR_PROOF` (call-time reader, `1|true|yes|on`, default OFF). It ANDs with the existing `isOrchestratorEnabled() && isAutospawnEnabled()` - it does not replace them. OFF => `proofGuard`, `proofBudgetGate`, the prompt override and the verifier return pass-through BEFORE any DB or network call (differential test: zero queries, zero fetches, identical outcomes to today). No env flag is flipped by any code in this phase.
- **D-04 (F2, recommended):** State lives in ONE new additive table `orchestrator_proof_runs` (see FORKS F2). Idempotent DDL only in `schema.sql`; no backfill. Partial unique index: at most ONE non-terminal proof run per user (single-flight). Terminal transition is a conditional `UPDATE ... WHERE status IN (non-terminal) RETURNING` so the terminal notification fires exactly once.

### (a) Allowlist entry
- **D-05 (LOCKED):** Entry mechanism = operator one-shot `hub/scripts/arm-orchestrator-proof.ts` (DATA ONLY, never flips a flag, never sets a cap), composing the existing `addRepoToAutospawnAllowlist` (`orchestrator-rows-dal.ts:568`) and the task-create/convert logic of `hub/scripts/create-autospawn-build-task.ts`. It: (1) REFUSES if the user's allowlist already contains any repo other than the target (exactly-one invariant, via `listRepoAutospawnAllowlist` :496); (2) REFUSES unless `--installation-id` resolves the repo through the GitHub App (`github-app.ts` `listInstallationRepos` :152) and the D-09 preconditions hold; (3) inserts the allowlist row, creates/converts ONE `dev` task (disabled-by-default until step 5 of the runbook is reached - see D-17), and inserts the `orchestrator_proof_runs` row (`status='armed'`, budgets frozen into the row); (4) supports `--dry-run` and `--disarm` (disarm = proof row -> `disarmed`, task disabled, allowlist row removed by exact `(user_id, repo_ident)` WHERE - a config row, not data; rule 6 note in the script header). Reuse `reuse existing allowlist table` - no new allowlist table, no admin HTTP route (a route is a new auth surface to defend for a one-time operation). Rejected: admin route; env-var allowlist.
  
### (b) Hard budget
- **D-06 (LOCKED shape, numbers = auto-default):** Per-run budget stored on the proof row at arm time: `max_injects` (default **6**), `max_tokens` (default **3_000_000**, all four buckets: input + output + cache_creation + cache_read), plus `max_wall_ms` (default **6h**). Enforced in TWO places: (1) `proofBudgetGate` - a `DispatchGate` placed in BOTH `injectOrchestratorPrompt` gate lists immediately after `automationKillSwitchGate`; pass-through unless `req.counterKey` maps to an ACTIVE proof run; blocks `proof_budget_injects:<n>>=<cap>` / `proof_budget_tokens:<n>>=<cap>` / `proof_budget_wall`; fail CLOSED on DB error for proof keys only. (2) A hub tick-side check in `proofGuard` (D-12) so an exhausted run terminates and DISABLES ITS TASK even when no inject is attempted. Tokens = sum of `token_usage` rows for the proof SESSION since `started_at` (new DAL `sumSessionTokensSince`, all 4 buckets, mirrors `getTodayTokenTotal`'s bucket set, `token-usage-dal.ts:230`). Injects = `automation_inject_ledger` unreleased rows for `task:<id>` (the Phase-4 reserve is the source of truth; do not add a second counter).
- **D-07 (LOCKED):** Termination = (1) proof row -> terminal `terminated`, reason recorded; (2) the proof task is set `enabled=false`; (3) a SESSION-scope kill switch is engaged for the proof session via the existing `engageKillSwitch` (`automation-controls.ts:200`), so no queued/parked send survives (Phase 4 D-10 re-runs gates on promotion). Reuse, no new halt mechanism. Documented residual: a turn already in flight when the budget trips is not cancelled (Phase 4 D-07); its overshoot is bounded by the daily token cap (`DEFAULT_DAILY_TOKEN_CAP` 20M), which is NOT a per-proof bound. State this plainly in the runbook.

### (c)/(d) Branch-only and never-merge
- **D-08 (F1, recommended; trust-boundary fork):** Never-merge enforcement is layered, ownership split by what each layer can actually guarantee (see FORKS F1): PREVENTIVE = a GitHub-side branch ruleset on the throwaway repo (no bypass actors, PR + required status check required to update the default branch), asserted by the hub at ARM time and at every tick via the GitHub App read API (fail closed if unreadable); DETECTIVE = hub verifier compares default-branch HEAD to the `base_sha` frozen at arm time; ADVISORY = the proof prompt. The prompt is NOT the control.
- **D-09 (LOCKED):** Arm-time preconditions (script) and per-tick re-assertions (`proofGuard`): repo reachable via App installation; default-branch protection/ruleset present and denies direct push + merge without the required check (exact assertion shape = planner verifies against the GitHub REST ruleset response; if the App lacks the read permission, ARM FAILS CLOSED with `proof_protection_unverifiable` - never "assume protected"); throwaway repo has >=1 CI check workflow (else `pr_open_no_ci` can never be green).
- **D-10 (LOCKED, code-enforced guards):** (i) `runMergeToMain` / `isMergeCommand` routing (`merge-command.ts`, `controller.ts:452-463`) REFUSES for a repo with an active or armed proof run: `proof_repo_never_merges`, with a run-log row; (ii) the proof prompt (D-11) contains ZERO merge/deploy instructions - a unit test greps the rendered prompt for `merge`, `--admin`, `deploy`, `push origin main`, `git push` to anything but the proof branch prefix; (iii) the verifier (D-12) treats ANY default-branch advance past `base_sha`, any merged proof PR, or any PR whose `base` is not the default branch / `head` is not under `proof/` as terminal `terminated:main_advanced` (pages once, engages the session kill switch); (iv) the proof task never routes through the dev macro text that says "Merge (squash...)" (task-macros.ts:129-136, 207-210, 279-282) - see D-11.
- **D-11 (F3, recommended):** The proof prompt is a prompt OVERRIDE keyed by an active proof run on the task, NOT a fifth `macro_task_type` (that would require altering the `scheduled_tasks_macro_task_type_check` CHECK, schema.sql:314-315, and would also change the `isBuild` autospawn eligibility test `macroTaskType === 'dev'`, macro-cycle.ts:221). `macro_task_type` stays `'dev'`; `macro-cycle.ts` swaps `macro.prompt` for `renderProofPrompt(ctx)` only when `proofPromptFor(taskId)` returns non-null (flag ON + active run). Prompt content (auto-default): one branch `proof/<run-id>`, one trivially safe change (add/modify a single file under a docs path), open a PR against the default branch, wait for CI, report PR URL via `<<STATE>>`, STOP; explicit "if you cannot, emit `<<STATE>> last_action=nothing` with the reason and stop". Untrusted-data fencing not needed (no inbound text).

### (e) Terminal outcomes and "says why"
- **D-12 (LOCKED):** `hub/src/orchestrator/proof.ts` owns `proofGuard(input)`, called from `runMacroCycle` BEFORE step 3 (resume/inject), after reconcile. It (flag-gated, D-03): loads the active proof run for `input.taskId` -> evaluates in order: kill switch (existing predicate) -> wall/budget -> protection re-assertion -> GitHub verifier -> decision `{proceed}` or `{terminal: outcome}`. The verifier NEVER trusts the agent's `<<STATE>>`: PR existence, head/base, merged flag, default-branch HEAD and combined check state all come from the GitHub App API through an injectable client (`ProofGithub` interface; tests use a fake). Hub stays text-only/never shells gh (merge-command.ts header invariant).
- **D-13 (LOCKED, enumerated outcomes, stored in `orchestrator_proof_runs.outcome`):**
  - `pr_open_green` - open PR, `head` under `proof/`, `base` = default, not merged, default-branch HEAD == `base_sha`, >=1 check and ALL check-runs/statuses on head SHA success. SUCCESS terminal; task disabled; one notification with PR URL.
  - `pr_open_ci_pending` - non-terminal; keep ticking (budget still bounds it).
  - `terminated:pr_open_ci_red` - PR exists, CI red after the agent's allowed fix-injects; terminal (a red PR is honest "did something, not green").
  - `nothing:<reason>` - clean no-op terminal, reason from the closed set `not_allowlisted | supervisor_offline | launch_cap | over_token_cap | kill_switch | protection_unverifiable | no_pr_produced_within_budget | agent_declined:<sentinel text, truncated>`; maps from existing `InjectOutcome.refused:*`/`no_session` kinds (inject.ts:54-70) so no outcome is invented.
  - `terminated:budget_injects | budget_tokens | budget_wall | main_advanced`.
  Every terminal writes ONE `routine_run_log` row `command='proof-outcome'`, sends exactly ONE notification (via existing `fanOutNotify`, claimed by the D-04 conditional UPDATE), and is readable via read-only `GET /api/orchestrator/proof` (cookie auth, `_openapi.ts`, `bun run docs:sync`; auto-default).
- **D-14 (LOCKED):** The notification classes: `nothing:*` for infra reasons already treated as benign in macro-cycle (:297-306) stay benign (no page storm); `terminated:main_advanced` and `pr_open_green` page once.

### Integration discipline
- **D-15 (LOCKED):** Gate placement obeys the existing coverage scans: `proofBudgetGate` is added to both orchestrator inject lists; `hub/test/token-cap-coverage.test.ts` and the Phase-4 kill-switch/lifetime coverage test are extended with an explicit assertion that the orchestrator lists carry it (and a self-check). No change to the `DispatchGate` return shape (Phase 4 D-12). No edits to `governed-pty.ts` bodies.
- **D-16 (LOCKED):** Invariants carried: no LLM API key anywhere; the no-API-key/argv-allowlist guard tests unchanged and green; actor stays server-inferred; additive idempotent DDL, no INSERT/UPDATE/DELETE in `schema.sql` (tools/schema-sql-lint.ts); backfills none; no polling (verification is tick-driven by the existing controller tick, not a new timer - rule 23); no new skipped tests (skip baseline 259 vs `skip_max` 260).
- **D-17 (LOCKED, runbook shape):** The proof task is created DISABLED. The owner's final act in the runbook is enabling it, after the flags are set. Arming order therefore fails safe: flags without an enabled task do nothing; an enabled task without the proof flag runs the ordinary dev path against the allowlisted repo only if autospawn is ON (hence the script refuses to leave the task enabled, and `proofGuard`/the allowlist exactly-one rule bound the blast radius to the throwaway repo).

### Auto-defaults (cheap, reversible; planner may change without escalation)
- Numbers: 6 injects, 3M tokens, 6h wall; cadence `--every 30 --unit minutes` (under the 4/hr inject ceiling, so the rate gate is not the binding limit; the proof budget is); branch prefix `proof/`; script and file names; prompt wording; the read-only GET route and its payload; `ProofGithub` interface shape; table column names beyond those listed; test file names.

### Claude's Discretion
Plan/task ordering (migration + DAL first, guard + gate next, verifier + prompt next, script, then docs/runbook last); how `proof.ts` is split into files.

</decisions>

<canonical_refs>
## Canonical References

- `.planning/ROADMAP.md` lines 14-28 (hard invariants), 123-131 (Phase 5), Phase 4 delivery notes (:119-121)
- `.planning/phases/PTYCAP-04-lifetime-inject-counter-kill-switch/04-CONTEXT.md` (D-01 counter key, D-02 reserve, D-06 kill switch, D-07 residual, D-10) and `04-VERIFICATION.md`
- `docs/orchestrator-autospawn-runbook.md` (the BSA flip runbook this phase's runbook extends), `docs/auto-dev-orchestrator.md` ("Build-Session Autospawn", "Off-hours merge to main"), `docs/usage-cost.md` (PTYCAP sections), `CLAUDE.md` (env section: AUTOSPAWN, token cap, cost cap, work-site invariants "agent proposes, hub disposes")

### Code map (reuse points, file:line on this branch)
- `hub/src/orchestrator/macro-cycle.ts` - `runMacroCycle` :121; autospawn `isBuild` :221-224; inject call + `taskId` :226-233; benign-reason list :297-306; `reconcileSentinels` :357
- `hub/src/orchestrator/inject.ts` - `InjectInput.taskId` :86-100; `resolveInjectCounterKey` :181-189; online gate list :290-296; counterKey on req :307-314; `maybeAutospawnOffline` :351 (allowlist :364, launch cap :380-384, counterKey :389, grace park :401, launch :408-415, gate list :447)
- `hub/src/orchestrator/controller.ts` - `isAutospawnEnabled` :57, `isOrchestratorEnabled` :68, merge routing :452-463, macro tick :589-645
- `hub/src/orchestrator/merge-command.ts` - `runMergeToMain` (hub-text-only invariant, header :1-35)
- `hub/src/orchestrator/task-macros.ts` - dev macro text incl. merge instructions :129-136, :207-210, :279-282; `renderMacro` :402
- `hub/src/orchestrator/auto-launch.ts`, `orphan-resume.ts` - machine spawn sites already kill-switch guarded (Phase 4 D-09)
- `hub/src/db/orchestrator-rows-dal.ts` - `isRepoAutospawnAllowed` :482, `listRepoAutospawnAllowlist` :496, `countAutospawnLaunchesToday` :515, `countSessionInjectsSince` :552, `addRepoToAutospawnAllowlist` :568
- `hub/src/db/schema.sql` - `orchestrator_autospawn_allowlist` :616-621; `scheduled_tasks.macro_task_type` CHECK :312-315
- `hub/src/dispatch/automation-controls.ts` - `engageKillSwitch` :200, `isAutomationHalted` :132, `lifetimeCounterCheck` :290, `reserveInject` :363, `preSendGuard` :524, `resolveOrchestratorCounterKey` :566
- `hub/src/dispatch/pipeline.ts` - `preSendGuard` call :349; `hub/src/dispatch/governed-pty.ts` - governors (unchanged)
- `hub/src/db/token-usage-dal.ts` - `getTodayTokenTotal` :230 (bucket set to mirror), `usageBySession` :283
- `hub/src/auth/github-app.ts` - `githubApiGet` :79, `getInstallationToken` :55, `listInstallationRepos` :152, `listBranches` :176
- `hub/scripts/create-autospawn-build-task.ts` - task create/convert logic to reuse (header :1-50)
- `hub/src/work/verify.ts`, `publish.ts` - precedent: "agent proposes, hub disposes", hub-side verification as the boundary, injectable deps

### Tests to extend/model
`hub/test/token-cap-coverage.test.ts` (scan + self-check), Phase-4 kill-switch/lifetime coverage test, `hub/test/e2e/orchestrator-autospawn.e2e.test.ts` (real-Postgres autospawn precedent), `hub/test/orchestrator-macro-path-guard.test.ts`.

</canonical_refs>

<code_context>
## Existing Code Insights

- The counter/budget/kill-switch machinery is complete from Phase 4; Phase 5 is mostly a COMPOSITION + a verifier + a hub-side stop, not new dispatch plumbing.
- `macro-cycle.ts` swallows most errors by design (fail-open observability); `proofGuard` must be the opposite for proof tasks: an unexpected error in the guard => DO NOT inject (fail closed), record `nothing:guard_error`.
- Known doc/code drift to fix in the runbook, not paper over: `docs/orchestrator-autospawn-runbook.md` Step 5 expects `routine_run_log.pr_url` to be reconciled, but `reconcileSentinels` (macro-cycle.ts:357-) does not parse a PR URL. The proof does not depend on it (D-12 reads GitHub), and VERIFICATION must say so.
- UNVERIFIED (planner must check before coding): (1) how a GitHub App installation id maps to a remo-code user/repo_ident (github-app.ts reads, no user mapping seen); (2) whether the App holds the permission to READ branch protection/rulesets and check-runs; (3) that `token_usage` carries `session_id` for supervisor-hosted stream-json sessions (assumed from `usageBySession`).

</code_context>

<deferred>
## Deferred Ideas

- Automation `term.input` PTY byte-producer + per-turn token (D-01) -> later phase / GOV, behind its own panel.
- Supervisor-side read-only verify command (would remove the GitHub App dependency) - needs a signed MSI.
- Auto-cleanup/closing of the throwaway PR and branch.
- Reusing the proof state machine for non-throwaway repos (the proof is deliberately single-repo).
- Telegram/UI trigger for disarm (GOV); today disarm = script or kill switch API.
- Per-proof cost telemetry beyond tokens.

</deferred>

## SC Traceability

| Success criterion | Decisions | Provable in this phase | Needs LIVE run |
|---|---|---|---|
| SC-1 Branch-only | D-08, D-09, D-10, D-11 | prompt grep test; verifier unit tests (fake GitHub); protection-precondition refusal test | protection actually enforced by GitHub |
| SC-1 Never merges to main | D-08, D-10 | `proof_repo_never_merges` refusal test; `main_advanced` terminal test; zero merge strings in prompt | no merge occurred |
| SC-1 One whitelisted repo | D-05, D-04 | exactly-one allowlist refusal; single-flight unique index test | - |
| SC-1 Hard budget | D-06, D-07, D-02 | gate blocks at cap; tick terminates + disables task + engages session kill switch; real-Postgres e2e | - |
| SC-2 PR with green CI | D-12, D-13 | verifier green/pending/red/no-CI matrix | a real PR with green CI exists |
| SC-2 or cleanly nothing + why | D-13, D-14 | each `nothing:*` reason mapped from an existing InjectOutcome; one run-log row + one notification | - |
| SC-3 Never happened | - | NOT closable here | YES - owner GO, runbook below |
| (f) counter key | D-02 | pin test `task:<id>`; missing-key fail closed | - |
| Flag OFF no-op | D-03, D-16 | differential: zero DB/network, identical results | - |

## Draft Arming Runbook (OWNER GO/NO-GO - not authorization; becomes `docs/orchestrator-proof-runbook.md`, extends `docs/orchestrator-autospawn-runbook.md`)

> Arming unattended AI spawning is the capability class that burned the owner on 2026-07-11. Perform in this order; every step is reversible by Rollback.

**Pre-reqs**
1. This phase's PR AND Phase 3/4 PRs (#505/#506) merged, deployed, `docs:sync` clean; CI green on main; verify the hub is live by bundle hash, not `/health`.
2. Phase 4 controls live: kill switch `GET /api/automation/kill-switch` reports not engaged; `REMO_AUTOMATION_LIFETIME_INJECT_CAP` valid (hub boots only if so); token cap env checked (`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` unset => 20M default).
3. Throwaway repo exists (owner picks: e.g. `github://finedesignz/<throwaway>`), contains a trivial CI workflow, and the GitHub App is installed on it with read access to contents, pull requests, checks and administration/rulesets.
4. Branch ruleset on the default branch: block direct pushes and force pushes, require a pull request and the CI check, NO bypass actors (including admins).
5. A supervisor is online for the owner; a bound session for the throwaway repo exists (it may be offline - autospawn handles that).

**Steps**
1. Dry run: `bun run hub/scripts/arm-orchestrator-proof.ts --user <id> --session <sid> --repo-ident github://finedesignz/<throwaway> --installation-id <n> --dry-run` - confirms allowlist exactly-one, protection assertion, CI present, and prints the frozen budget (6 injects / 3M tokens / 6h). Fix anything it refuses; do not proceed on `proof_protection_unverifiable`.
2. Arm (DATA ONLY): same command without `--dry-run`. Result: allowlist row, proof row `armed` with `base_sha`, `dev` task created DISABLED.
3. Set Coolify env on the hub app (owner): `REMO_ORCHESTRATOR_PROOF=1`, confirm `REMO_ORCHESTRATOR_ENABLED=1`, set `REMO_ORCHESTRATOR_AUTOSPAWN=1`; optionally lower `REMO_PROOF_MAX_INJECTS`/`REMO_PROOF_MAX_TOKENS` before step 2 (they are frozen at arm). Redeploy; the hub refuses to boot on bad config.
4. Verify idle safety: hub log shows proof guard active; `GET /api/orchestrator/proof` shows `armed`; no spawn yet (task disabled).
5. GO: enable the proof task (script `--enable` or the tasks UI). First tick spawns the build session (`autospawn-launch` run-log row), injects the proof prompt.
6. Monitor (event-driven; the hub notifies on terminal): `GET /api/orchestrator/proof`; SQL `routine_run_log WHERE command IN ('autospawn-launch','proof-outcome')`; GitHub: a PR from `proof/<run-id>` into the default branch, default-branch HEAD unchanged. Success = outcome `pr_open_green` + one notification. Honest-nothing = `nothing:<reason>` + one notification. Either is a valid end state of the proof attempt.
7. Disarm immediately after a terminal outcome: `--disarm` and set `REMO_ORCHESTRATOR_AUTOSPAWN` back to unset (the proof is single-shot).

**Abort / Rollback (any time):** engage the kill switch (`POST /api/automation/kill-switch/engage`, no step-up), or `--disarm`, or unset `REMO_ORCHESTRATOR_PROOF`/`REMO_ORCHESTRATOR_AUTOSPAWN` and redeploy. Closing the throwaway PR and deleting its branch is manual cleanup by the owner. A turn already in flight is not cancelled (Phase 4 D-07).

**Owner decisions in this runbook (and only these):** which throwaway repo; the budget numbers if the defaults are wrong; the GO in step 5.

---

*Phase: 5-throwaway-repo-due-to-pr-proof*
*Context gathered: 2026-10-13*
