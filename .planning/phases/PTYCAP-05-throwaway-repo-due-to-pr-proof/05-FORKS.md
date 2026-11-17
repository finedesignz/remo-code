# Phase 5 - Genuine Architecture Forks

Each fork changes the trust boundary, the data model, or which subsystem owns enforcement. Cheap choices (numbers, names, route shape) are NOT here; they are auto-defaults in 05-CONTEXT.md. Recommendations are adopted by the planner unless a refute-first panel overturns them.

## F1 - Who enforces "never merge to main" (trust boundary)

**Question:** The hub is text-only by invariant (it never shells gh/git; `merge-command.ts` header, CLAUDE.md "agent proposes, hub disposes"). The proof agent is a supervisor-hosted CLI with the owner's git/gh credentials. A prompt cannot be the control. What actually stops a merge?

| Option | Mechanism | Consequence |
|---|---|---|
| A. Hub-only | Prompt (no merge text) + hub refuses merge routing + hub verifier detects a default-branch advance after the fact | Pure code in this repo, no MSI. But only DETECTIVE: a merge has already happened when detected. Fails SC-1 "never" in spirit. |
| B. GitHub-side prevention + hub assertion + hub detection | Branch ruleset on the throwaway repo (no bypass actors, PR + required check) is the PREVENTIVE control; hub asserts it exists via the GitHub App at arm time and every tick (fail closed if unreadable); hub verifier is DETECTIVE backstop; prompt is advisory | No MSI. Prevention is enforced by GitHub, not by an LLM. Requires owner repo config (a runbook step) and the App needing read permission on rulesets. Hub code enforces that the precondition HOLDS, not the merge itself. |
| C. Credential scrub | Proof session env stripped of merge-capable credentials (`scrubDeployCredentials` pattern, `env-sanitize.ts`) so the agent can open a PR but not merge | Strongest prevention inside our code; but needs a supervisor change => signed MSI release gate, and the agent still needs push credentials, which the scrub cannot narrow to non-default branches. |

**Recommendation: B (with A's detective layer inside it), C deferred.**
Evidence: `merge-command.ts` header and `work/publish.ts` establish hub-disposes-via-API as the house pattern; `hub/src/auth/github-app.ts` already provides installation-token reads (`githubApiGet` :79), so B needs no new transport; C ships only with a new MSI (CLAUDE.md: supervisor halves are release-gated) and cannot restrict push targets anyway. A alone cannot meet "Never merges to main" because detection is after the fact.
Risk to carry: UNVERIFIED that the App holds ruleset/branch-protection read permission; if not, ARM FAILS CLOSED (`proof_protection_unverifiable`) and the owner must grant it - this is a runbook prerequisite, not a fallback.

## F2 - Where proof state lives (data model)

**Question:** The proof needs frozen budgets, `base_sha`, status, outcome, PR URL, installation id and single-flight. Where?

| Option | Consequence |
|---|---|
| A. New table `orchestrator_proof_runs` (additive, idempotent DDL, partial unique index for single-flight) | Clean state machine, conditional-UPDATE terminal gives exactly-once notification, budgets frozen at arm so env changes mid-run cannot widen them. One more table; DDL is additive so safe on every boot. |
| B. Columns on `orchestrator_autospawn_allowlist` | Allowlist is per-(user, repo) config; mixing run state into it conflates "may run" with "this run", loses history on re-arm, and the allowlist row is deleted on disarm (rollback). |
| C. Encode in `routine_run_log` rows only | No atomic terminal claim, no single-flight, budget would have to be re-derived from env each tick (widenable mid-run), outcome scattered across rows. |

**Recommendation: A.** Evidence: Phase 4 chose dedicated tables for the same reasons (ledger, kill switch, alarm claim; 04-CONTEXT D-01, D-06, D-13); `routine_run_log` already has no uniqueness (Phase 4 rejected it for the alarm claim for the same reason). Reversibility: moderate (Phase 6 e2e and any later proof reuse depend on it); the table is droppable only with explicit permission (rule 6).

## F3 - How the proof gets a different prompt (data model / eligibility)

**Question:** The `dev` macro text instructs the agent to merge (task-macros.ts :129-136, :207-210, :279-282). The proof must use a no-merge prompt. How is it selected?

| Option | Consequence |
|---|---|
| A. Override keyed by an active proof run: `macro_task_type` stays `'dev'`; `macro-cycle.ts` swaps the prompt when `proofPromptFor(taskId)` is non-null | No schema change to `scheduled_tasks`; autospawn `isBuild` test (`macroTaskType === 'dev'`, macro-cycle.ts:221) unchanged; flag OFF => zero behavior change. One more conditional in macro-cycle. |
| B. New macro type `'proof'` | Requires altering `scheduled_tasks_macro_task_type_check` (schema.sql:312-315, an existing-column constraint change on a populated table), `isTaskType`, the stage presets and the `isBuild` test; the 'proof' type must also be taught to autospawn. Larger blast radius for a one-shot. |
| C. Edit the `dev` macro to be merge-free globally | Changes live behavior for every dev task; violates the flag-OFF true-no-op requirement. |

**Recommendation: A.** Evidence: B alters an existing CHECK on a table with live rows and touches autospawn eligibility (a Phase-4-era safety path); C breaks the no-op guarantee. A keeps the control surface inside the new proof module and is removable by deleting one branch. The prompt remains advisory (F1), so the choice carries no security weight - it is a blast-radius choice.
