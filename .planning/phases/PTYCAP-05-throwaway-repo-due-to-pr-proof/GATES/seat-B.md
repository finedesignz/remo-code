# Gate seat B - safety / blast-radius lens

Lens: unattended agent must never merge to main, stay on one throwaway repo, hard budget (2026-07-11 token burn). Read-only review; evidence is file:line on branch phase-ptycap-05.

## F1 - never-merge enforcement: ACCEPT-WITH-AMENDMENT (B, A detective inside, C stays deferred)

Why B, not C: C is not buildable now and not sufficient.
- The orchestrator session is EXEMPT from the git-push scrub: `supervisor/src/runners/claude-runner.ts:162-165` passes `scrubGitPush: !isOrchestratorSession`. The scrub only strips env names (`env-sanitize.ts:137-148`); the agent's `gh` auth normally lives in the gh keyring/credential helper, not env, so no env scrub can remove merge ability. `env-sanitize.ts:55` explicitly leaves GITHUB_TOKEN/GH_TOKEN alone. Any C needs a supervisor change = new MSI (out of scope, CONTEXT.md:15).
- Hub cannot merge-prevent: `merge-command.ts:1-35` is text-only by invariant. Only GitHub can refuse a merge in code the LLM cannot edit.

Amendments (all code/test, buildable now with a fake `ProofGithub`):
1. ADMIN-EDIT HOLE. A ruleset with no bypass actors still can be edited/deleted by a repo admin. If the agent's ambient gh identity is admin on the throwaway repo, the agent can delete the ruleset and then merge; prevention is then prompt-grade. Mitigations to make code-enforced: (a) arm script + every tick assert the ruleset is `enforcement=active`, targets the default branch, has `pull_request` + `required_status_checks` rules, and `bypass_actors=[]`; ANY change from the snapshot frozen at arm (store ruleset id + `updated_at` on the proof row) => terminal `terminated:protection_changed`, task disabled, session kill switch engaged; (b) runbook precondition (documented, not claimed as enforced): throwaway repo lives where the agent identity has WRITE, not ADMIN. State this residual plainly.
2. TICK GAP. Tick cadence is 30 min (CONTEXT:62); a merge+ruleset delete between ticks is detected late. Detective layer must compare default-branch HEAD to `base_sha` AND list merged PRs/commits on default branch since `base_sha`, not only HEAD equality. Wall budget (6h) bounds the exposure; say so.
3. UNREADABLE = FAIL CLOSED is mandatory and must be tested: 403/404 on the rulesets read => `protection_unverifiable`, no inject. `githubApiGet` (`hub/src/auth/github-app.ts:79-96`) throws on non-2xx; the guard must catch and treat as unverifiable, never as "no protection needed" or "assume ok". The existing github-app.ts has no ruleset/protection call yet (grep: zero matches), so this is new code and UNVERIFIED App permission (Administration: read) is a real arm-time risk.
4. Merge route guard (D-10 i): `dispatchMergeIfDue` (`controller.ts:458-463`) gets `ctx.repoKey`; the refusal must key on repo_ident of ANY proof row (armed/active/terminal, not only active), since a terminal proof repo stays allowlisted until disarm. Also guard the `hot` path `controller.ts:726-728`.
5. Verifier must compute violations from GitHub only (never the agent's `<<STATE>>`), matching D-12. Pin with a test where STATE claims success but fake GitHub shows a merged PR => `main_advanced`.

## F2 - proof state table: ACCEPT-WITH-AMENDMENT (A)

Evidence for A: allowlist table is `(user_id, repo_ident)` only, `schema.sql:616-621`; no room for frozen budgets, and disarm deletes the row. `automation_inject_ledger` exists with unique `(counter_key, token)` `schema.sql:1605-1618` for injects, so no second counter (matches D-06). Partial unique index = DB-enforced single-flight: strongest available.

Amendments:
1. `token_usage.session_id` is `REFERENCES sessions(id) ON DELETE SET NULL` (`schema.sql:1334`): if the proof session row is deleted, attributed tokens go NULL and the token budget UNDER-counts (budget bypass). Fix: proof row stores `session_id`; token sum also covers the proof's `task_id`/time window with `user_id`, OR budget gate treats "proof session row missing" as budget exhausted (fail closed). Add a test deleting the session mid-run.
2. Add CHECK constraints on the proof table: `max_injects BETWEEN 1 AND 20`, `max_tokens <= 20_000_000`, `max_wall_ms <= 24h`, so a typo or hostile arm cannot freeze an unbounded budget (the env-fed `REMO_PROOF_*` values are validated at arm AND by CHECK; invalid => arm refuses, no clamp-to-default silently).
3. Partial unique index must also be on the repo: at most one non-terminal run per `repo_ident` as well as per user.
4. Rule 6 note: table is new/empty, DDL additive; no DROP in rollback path (disarm = status transition only).

## F3 - how proof gets a different prompt: ACCEPT-WITH-AMENDMENT (A)

Evidence for A: B alters `scheduled_tasks_macro_task_type_check` (`schema.sql:312-315`) on a populated table and the autospawn `isBuild` test `macro-cycle.ts:221-224`; C changes the live dev macro (merge text `task-macros.ts:129-136, 207-210, 279-282`). A leaves flag OFF a true no-op.

Safety hole to close (the override is the ONLY thing between the allowlisted repo and the merge-bearing dev text):
1. FAIL CLOSED ON NO OVERRIDE. If a task has ever had a proof row (any status) and `proofPromptFor(taskId)` returns null (run terminal, flag OFF, guard error, lookup error), `runMacroCycle` must NOT fall back to `macro.prompt`; record `nothing:no_proof_prompt` and skip inject. Today's differential test (OFF = zero queries) conflicts with that lookup when the flag is OFF; resolve by keying the lookup off the cheap existing allowlist path instead: in `maybeAutospawnOffline` (inject.ts allowlist check) and `isBuild` branch, refuse when the repo has a proof row and `REMO_ORCHESTRATOR_PROOF` is off. This is only reachable after arming (no proof rows exist when never armed), so the never-armed OFF path stays zero-query.
2. Arm script leaves task DISABLED (D-17) and terminal transition disables it; add a test that a terminal/disarmed proof task cannot dispatch the dev macro even if re-enabled by hand.
3. Prompt grep test (D-10 ii) must scan the FINAL string injected after `renderProofPrompt`, including any suffix the inject seam appends, not just the template.

## Cross-cutting (not forks)
- Budget enforcement as a DispatchGate after `automationKillSwitchGate` is correct and code-enforced; gate-list coverage scan extension (D-15) is mandatory, since a missed list is a silent bypass.
- Overshoot residual (in-flight turn, bounded only by 20M daily cap, D-07) must be in the runbook; consider lowering `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` for the proof window as an owner-side step.
- SC-3 stays not closable here (CONTEXT:16).
