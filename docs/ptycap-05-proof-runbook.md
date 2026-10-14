# PTYCAP-05 Throwaway-Repo Due-to-PR Proof - Owner Arming and Rollback Runbook (OWNER GO / NO-GO)

> **This document authorizes nothing.** Arming unattended AI spawning is the capability class that
> burned the owner on 2026-07-11 (the orchestrator tick loop that consumed 2.83B cache-read tokens).
> Phase 5 built and tested the machinery and drafted this runbook. It armed nothing, set no flag,
> and contacted no GitHub, Coolify or prod system. **Arming is an OWNER GO/NO-GO.** Every step below
> is an OWNER step; nothing in this repository performs it.
>
> **Honest scope.** Success criterion 3 ("this has never once happened") closes only on the live run.
> Until the owner says GO and a real proof reaches a terminal outcome, SC-2 and SC-3 are reported as
> **armed-ready, live proof pending owner GO** - never PASS. The machinery is proven against a fake
> GitHub client and, in CI, against real Postgres; that is not the live proof.

## 1. What the proof does and does not do

- Drives the existing orchestrator macro cycle (`runMacroCycle` -> `injectOrchestratorPrompt` ->
  `dispatch()` -> `user_message` to a supervisor-hosted stream-json session). It does NOT use the PTY
  door. The automation `term.input` PTY byte-producer is deliberately NOT built here (decision D-01:
  largest unreviewed autonomy escalation, not needed for the proof, deferred to a later phase or GOV).
- One branch `proof/<run-id>`, one trivial docs change, one pull request against the default branch.
  Branch-only. The proof never merges that PR and never pushes to the default branch. The hub
  verifier reads GitHub itself (compare, PR scope, CI); the agent's self-report gates nothing.
- One repo, one session, hard budget frozen at arm time (defaults: 6 injects, 3,000,000 tokens counted
  across all four buckets, 6 h wall; cadence every 30 minutes; branch prefix `proof/`).
- Single-shot: after any terminal outcome the proof is finished and you disarm (section 5).

## 2. Control model (read this before deciding)

- The PREVENTIVE never-merge control is a **GitHub ruleset** that the hub asserts at arm time and
  re-asserts before every dispatch (frozen id + digest + `updated_at`; any drift or ambiguity is
  terminal). The dev macro squash-merges a green PR, so a ruleset of only "require PR + green check"
  is NOT protection and the hub rejects it.
- The hub verifier is the detective layer. The macro prompt is advisory only.
- **Credential scrubbing is not relied on (F1-6).** The orchestrator session is exempt from the
  git-push scrub (`supervisor/src/runners/claude-runner.ts`), so the agent may hold a working git
  credential. That is why the ruleset must have zero bypass actors and the agent credential must be
  non-admin.
- Merge routing: while an armed or running proof run owns a repo, the merge command never merges that
  repo and refuses it (`proof_repo_never_merges`, fail closed on lookup error).

## 3. Owner prerequisites (verify each before the dry run)

1. **Phases 3, 4 and 5 PRs merged and deployed**, with the hub verified live by bundle hash, not by
   `/health`. The Phase 4 controls (lifetime counter, kill switch) are live and the kill switch is
   NOT engaged: `GET /api/automation/kill-switch` shows no engaged rows for you.
2. **GitHub App permission grant.** The App today holds Contents (read/write), Metadata (read) and
   Pull requests (read) only (see `docs/HANDOFF.md`). The proof additionally needs **Administration
   (read)**, **Checks (read)** and **Commit statuses (read)**. In the GitHub App settings add them,
   then the installation owner must accept the updated permissions on the installation page. Verify:
   the dry run in section 4 must not report `proof_permissions_missing`.
3. **Dependency: ruleset `bypass_actors` visibility.** GitHub returns a ruleset's `bypass_actors`
   only to a caller with WRITE access to that ruleset. If the dry run reports
   `proof_protection_unverifiable` with detail `bypass_actors_not_visible`, the hub's token cannot see
   the bypass list and arming refuses by design: it fails closed on ambiguity and no attestation path
   exists. Resolving this is an OWNER decision about the App's permission level; it is a dependency
   of this proof, and the runbook offers no way around it.
4. **Create the throwaway repo** (owner: `<owner>/<repo>`; a repo nobody cares about). Install the
   GitHub App on it. Add a CI workflow under `.github/workflows/` with a **stable check name** (for
   example a job named `ci` that runs a trivial command). Arm refuses `no_ci_workflow` without one.
5. **Create the ruleset** on the default branch, targeting the default branch, enforcement **Active**,
   with an **EMPTY bypass list** (no roles, no teams, no apps, no admins). Use one of two rule sets:
   - **Branch-lock (preferred):** restrict updates, restrict deletions, block force pushes, and
     require the CI status check by its stable name.
   - **Review-gate:** require a pull request with at least one approval and approval of the most
     recent push, block force pushes, and require the CI status check.

   A ruleset of only "require pull request plus green check" is rejected, because the dev macro
   squash-merges green PRs.
6. **Make the agent credential non-admin.** The supervisor host's git/gh identity must have **write**,
   not maintain or admin, on that repo only. Verify with the collaborator permission endpoint
   (`GET /repos/<owner>/<repo>/collaborators/<login>/permission`) and pass `--agent-login <login>` so
   the dry run records it. If you omit it, arm records `agent_permission = unverified` with a warning:
   the hub cannot read the agent credential, so this check is then the only control.
7. **A supervisor online and a session bound to the repo** (the session's `repo_key` equals
   `github://<owner>/<repo>`). The autospawn allowlist must be empty or hold exactly this repo.

## 4. The steps

All commands run where the hub code and `DATABASE_URL` are available (the script refuses without
`DATABASE_URL` and ignores `REMO_E2E_DB_URL`). The script never flips a `REMO_*` flag and never reaches
a hosting provider.

1. **Dry run** (read-only, zero writes):

   ```
   bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --session <session-id> \
     --repo-ident github://<owner>/<repo> --installation-id <installation-id> \
     --agent-login <login> --dry-run
   ```

   Optional: `--max-injects N --max-tokens N --max-wall-ms N` (digits only; otherwise
   `REMO_PROOF_MAX_INJECTS` / `REMO_PROOF_MAX_TOKENS` / `REMO_PROOF_MAX_WALL_MS`, then the defaults)
   and `--every N --unit minutes|hours`. Read the printed summary: default branch, base sha, protection
   shape, ruleset ids and digest prefix, required contexts, allowlist, bypass verification, agent
   permission.

2. **Refusal codes** (exit 2). The check order is the table order:

   | Code | Meaning | Owner action |
   |------|---------|--------------|
   | `github_app_unconfigured` | the hub has no GitHub App id/key | configure the App on the hub host |
   | `invalid_budget` | a budget value is not a positive integer | fix the flag or env value |
   | `invalid_schedule` | `--every` / `--unit` invalid | use a positive integer and `minutes` or `hours` |
   | `installation_not_owned` | the installation is not an active installation of this user | check `--installation-id` |
   | `repo_not_in_installation` | the repo ident is malformed or not in the installation | install the App on the repo |
   | `session_repo_mismatch` | the session is missing, not yours, or bound to another repo | bind the session to the repo |
   | `proof_permissions_missing` | the App lacks Administration, Checks or Commit statuses read | section 3 item 2 |
   | `no_ci_workflow` | no workflow file on the default branch (or unreadable) | section 3 item 4 |
   | `proof_protection_unverifiable` | ruleset unreadable or ambiguous, including `bypass_actors_not_visible` | section 3 item 3 |
   | `proof_protection_insufficient` | ruleset is not an accepted shape, or has a bypass actor | fix the ruleset, section 3 item 5 |
   | `agent_credential_is_admin` | the agent login is a repo admin and could edit the ruleset | section 3 item 6 |
   | `other_repo_allowlisted` | the autospawn allowlist holds another repo | empty it or target that repo |
   | `proof_already_active` | an armed or running proof already exists for this user | disarm it first |

3. **Arm (data only).** Re-run the same command without `--dry-run`. In one transaction it creates
   the single allowlist entry, the DISABLED proof task, its due-scan row and the frozen proof run. The
   task is disabled, so nothing runs yet.

4. **Set the hub flags** `REMO_ORCHESTRATOR_PROOF=1`, `REMO_ORCHESTRATOR_ENABLED=1`,
   `REMO_ORCHESTRATOR_AUTOSPAWN=1` in the hub's environment through the hosting console, and review the
   daily token ceiling `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` (the 20M default is not a per-proof bound).
   This is an owner step; nothing in this repo performs it. Then redeploy the hub.

5. **Verify idle safety.** `GET /api/orchestrator/proof` shows the run `armed`, no session spawned,
   the task disabled. If anything differs, stop and roll back (section 5).

6. **GO.** The `--enable` command is the owner's final act:

   ```
   bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --enable
   ```

   It works only on an armed run (`proof_not_armed` otherwise). Everything before this point is
   reversible and runs nothing.

7. **Monitor, event-driven.** Do not poll in a loop. The hub notifies once at the terminal outcome.
   Inspect on demand: `GET /api/orchestrator/proof` (state, outcome, PR url, usage vs budget),
   `routine_run_log` rows whose `command` is `autospawn-launch` or `proof-outcome`, and the throwaway
   repo (a PR from `proof/<run-id>`, the default branch unchanged).

8. **Outcomes and notifications.**

   | Outcome | Notification |
   |---------|--------------|
   | `pr_open_green` | blocking, all channels, event ship; includes the PR url |
   | `nothing:<reason>` (not_allowlisted, supervisor_offline, launch_cap, over_token_cap, kill_switch, lifetime_exhausted, cost_cap, no_session, no_pr_produced_within_budget, agent_declined, guard_error, repo_mismatch) | quiet info, in-app and email only; the proof cleanly did nothing and says why |
   | `terminated:<reason>` (pr_open_ci_red, budget_injects, budget_tokens, budget_wall, budget_attribution_lost, main_advanced, pr_scope_violation, proof_protection_unverifiable, proof_protection_drift) | blocking, all channels, event failure |

9. **After any terminal outcome** run `--disarm` and unset `REMO_ORCHESTRATOR_AUTOSPAWN` (the proof is
   single-shot). Closing the PR and deleting the `proof/<run-id>` branch is optional owner cleanup.

## 5. ABORT AND ROLLBACK - in this exact order

1. **FIRST engage the session kill switch** (`POST /api/automation/kill-switch/engage` with body
   `{"scope":"session","session_id":"<session-id>","reason":"proof abort"}`; no step-up needed) **or
   run the transactional disarm**:

   ```
   bun run hub/scripts/arm-orchestrator-proof.ts --user <user-id> --disarm
   ```

   The disarm disables the task and the proof row, removes exactly one allowlist row (this user and
   this repo) in one transaction, and only then engages the session kill switch best-effort. If the
   script warns that the kill switch failed, engage it by hand.
2. **THEN** unset REMO_ORCHESTRATOR_PROOF and REMO_ORCHESTRATOR_AUTOSPAWN in the hub environment.
3. **THEN** redeploy the hub.

**Why this order.** An ONLINE bound session bypasses the autospawn branch (the autospawn path is
reached only for an offline or ghost session), so unsetting flags alone does not stop a still-enabled
proof task. With the proof flag unset the proof guard is a no-op, and the ordinary dev macro (which
squash-merges green PRs) would then run against the throwaway repo. Reversing the order can therefore
let the ordinary dev macro run unguarded on that repo. Stop the driver first, then remove the flags.

## 6. Residuals (stated plainly)

- An in-flight turn is not cancelled when a budget trips or the kill switch engages (Phase 4 D-07);
  only the next send is refused.
- The 20M default daily token cap is not a per-proof bound; the per-proof bound is the frozen 3M
  token budget counted across all four buckets.
- With one session lock, inject overshoot of the frozen budget is at most one.
- `routine_run_log.pr_url` is not reconciled from the agent's sentinels (the reconcile step does not
  parse a PR url). The proof reads GitHub directly; the PR url in `GET /api/orchestrator/proof`
  comes from that read.
- The `term.input` automation producer is deferred (D-01).

## 7. Owner decisions in this runbook, and only these

1. Which throwaway repo.
2. The budget numbers, if the defaults are wrong.
3. The GO (`--enable`).

Placeholders in this document (`<owner>`, `<repo>`, `<user-id>`, `<session-id>`, `<installation-id>`,
`<login>`) are never real identifiers or credentials. Do not paste a token anywhere.
