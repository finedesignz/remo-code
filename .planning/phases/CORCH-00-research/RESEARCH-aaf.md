# CORCH-00 Research: AgentAutofix (AAF) capabilities vs CORCH needs

**Researched:** 2026-11-13
**Source:** `C:\Users\artic\GitHub\agentautofix`, `origin/main` @ `80c69ce0` (after `git fetch origin`; read-only via `git show`/`git grep`/`git ls-tree`; no checkout, no prod calls).
**Scope:** one question - what exists in AAF today for (a) PR owner for red CI + merge, (b) outbound event on merge/terminal failure, (c) shared per-account quota feed; smallest additive change for each.
**Tags:** `[VERIFIED: path:lines]` = file opened this session, values quoted. `[UNVERIFIED]` = inference / not opened. All `path:line` are in the agentautofix repo at origin/main unless prefixed `remo`.

> Caveat: AAF docs say "Line references drift" (`docs/automerge-runbook.md:4`). Line numbers below are from the blobs read at `80c69ce0`; `docs/automerge-runbook.md` gate numbering is partly stale vs code (see 2).

---

## 0. Headline findings (read this first)

1. **Merge exists and fits; red-CI repair for a non-AAF PR does not.** AAF merges every same-repo write-author PR in an owned org once gates pass (trusted-PR mode, default on). But **every automated red-CI repair path is bound to AAF-authored PRs / existing defect rows**. A content-red check on a remo-authored PR is, today, a PR that sits open with a "merge blocked" comment. No fix job is ever created. (Section 1.)
2. **A repo with no `projects` row is invisible to AAF.** Webhooks for it are acked and ignored; AAF deliberately never auto-provisions from webhook content (TEN-05). There is **no API to register a review-only repo** - only `POST /api/plugin/apps` (creates client + project + plugin_app) and code-only provisioning scripts. (Section 2.)
3. **No generic outbound event exists.** No webhook/callback on PR merged/closed or fix job failed/exhausted, no Telegram, no push to remo. Closest reusable parts: `signedPost.ts` (the single HMAC signer), `intake_callbacks` outbox pattern, and the already-present webhook branch for `pull_request closed+merged`. (Section 3.)
4. **Quota: AAF's own pause is in-process only** (`quotaPause.ts`), no external feed. A seat-pool broker integration (`claudePool`, flag OFF) already exists and is the natural neighbour of a shared quota feed. Fixer uses subscription OAuth only; **no API-key use found, no hard-floor violation** (grep-verified over `src/**`). (Section 4.)
5. Remo linkage is one-directional and unrelated to PR events: AAF -> remo hub chat proxy (`chat:session` key). (Section 6.)

---

## 1. CI-failure ingest: when does a red check become a fix job?

### 1.1 INFRA-01 status-webhook ingest (`docs/ci-failure-ingest.md`, `src/lib/server/ci/`)

Flow `[VERIFIED: docs/ci-failure-ingest.md:8-22]`: Woodpecker posts GitHub commit status `ci/woodpecker/<pr|push>/<workflow>` -> GitHub `status` webhook -> `POST /api/webhooks/github` -> `ingestCiFailure` -> annotation (`author 'ai'`, `source 'heal'`, `heal_external_id 'ci:<project>:<repo>:<sha>:<context>'`) + defect + `runDispatch`.

Exact conditions to become a fix job (ALL must hold):

| # | Condition | Evidence |
|---|-----------|----------|
| 1 | Env `CI_FAILURE_INGEST === 'true'` on web service (default off, "ships dark") | `src/lib/server/ci/ciFailureIntake.ts:132` `if (env.CI_FAILURE_INGEST !== 'true') return skipped('ci_ingest_disabled');`; `docs/ci-failure-ingest.md:26` |
| 2 | `plugin_apps.ci_failure_ingest = true` on an **active plugin_apps row** for the project | `ciFailureIntake.ts:156-162,176,194` (join `plugin_apps pa on pa.project_id = p.id and pa.status = 'active'`; `if (!project.ci_failure_ingest) return skipped('flag_off')`); set via `PATCH /api/plugin/apps/<id>` `{"ci_failure_ingest": true}` (`docs/ci-failure-ingest.md:27-28`) |
| 3 | `CI_STATUS_TRUSTED_CREATORS` set; webhook `sender.login` (the **status creator**, i.e. the Woodpecker forge user, NOT the PR author) is on the list; unset/empty -> skip `trusted_creators_unconfigured` | `src/lib/server/ci/ciFailureClassify.ts:24,96-102`; `docs/ci-failure-ingest.md:30-35` |
| 4 | Context matches `/^ci\/woodpecker\/(push\|pr)\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/` | `ciFailureClassify.ts:38,55-57` |
| 5 | `state` is `failure` or `error`, and description does not match `/^Pipeline was (cancel(l)?ed\|rejected)\s*$/i` | `ciFailureClassify.ts:46,58-63` |
| 6 | **Context must NOT be a PR context.** `ciFailureClassify.ts:64-68`: `// Known limitation: the fixer works on the default branch (runFix.ts), not the PR head ...` `if (context.startsWith(PR_CONTEXT_PREFIX)) { return { ok: false, reason: 'pr_context_unsupported' };` (`PR_CONTEXT_PREFIX = 'ci/woodpecker/pr/'`, line 39) | verified |
| 7 | Default branch is among the status's `branches` (`non_default_branch` otherwise; `default_branch_unknown`) | `ciFailureClassify.ts:72-77` |
| 8 | Project resolved by (installation, repo), exactly one, installation bound | `docs/ci-failure-ingest.md:60-64` |

**Result: a red check on an arbitrary PR does NOT become a fix job via INFRA-01.** Only red *default-branch push* contexts do (condition 6). Author of the PR is never examined by this path. `[VERIFIED: ciFailureClassify.ts:64-68]`

### 1.2 Woodpecker PR-failure callback (`docs/woodpecker-ci-callback.md`, `POST /api/webhooks/woodpecker`)

- Needs per-repo Woodpecker config: a `notify-ze-ci-failure` step with secrets `ze_ci_callback_url`/`ze_ci_callback_secret`, allowed for `pull_request` event (`docs/woodpecker-ci-callback.md:13-60`). Signature `X-ZE-Signature-256: sha256=<hmac-sha256 of raw body>` (`:89`), secret `WOODPECKER_CALLBACK_SECRET` on web (`:64-70`).
- It resumes "a `pr_followup` job of kind `ci` on the defect whose `pr_url` is that pull request" (`:104-107`). For any PR with no such defect: `src/lib/server/ci/woodpeckerFailureIntake.ts:116` `if (!defect) return finish('ignored_not_ze', { action: 'ignored', reason: 'not_ze_pr' });`. Also requires `defect.status === 'fixed'` (`:118`), open same-repo PR (`:121-122`).
- Cap: `CI_FAILURE_RESUME_MAX` default 3, ceiling 10 (`docs/woodpecker-ci-callback.md:72-77`); next failure sets defect `escalated`, enqueues `defect_escalated` notification, posts one PR comment (`:109-111`).

**Result:** works for fix PRs AAF opened (defect + `pr_url`). A remo-authored PR is `ignored_not_ze`. Rolling the Woodpecker notify step into ~60 repos is a heavy per-repo config change, so this path is a poor fit unless the status-webhook path is extended.

### 1.3 Phase 5B remediation loop (`src/worker/remediate/`, `src/lib/server/webhooks/remediationEvent.ts`)

This is the only red-CI path that is **author-agnostic**:
- `status` failure/error and `check_run`/`check_suite` failure events -> `pr_remediation_jobs` row for a *provisioned project* (`remediationEvent.ts:1-13,18-23` skip reasons incl. `repo_not_provisioned`); invoked from the github webhook at `src/routes/api/webhooks/github/+server.ts:1116` (status), `:1297` (check_run), `:1335` (check_suite).
- Gated by worker env `AUTOMERGE_REMEDIATE`, **default off**: `src/worker/runtimeEnv.ts:335-358` - `off` (record + skip), `bounce` (ONE evolving PR comment saying who must act, "Zero push / rerun authority"), `fix` ("bounce, plus the mechanical fix / rerun paths").
- Eligibility (`src/worker/remediate/eligibility.ts:67-99`): repo owner in `AUTOMERGE_OWN_GITHUB_ORGS`, not a fork, head repo == base repo, org not paused, app not opted out, not PHI repo, no `CHANGES_REQUESTED` review, cycle cap, quiet window (`REMEDIATE_QUIET_WINDOW_MS = 10 * 60_000`, runtimeEnv.ts:361), and a push record for the head (`no_push_record`).
- **Fix scope is mechanical only**: `evaluate.ts:16-19` "a push class (version bump / lint / formatter) goes to the executor (`runRemediation.ts`, ONE plain commit); a rerun / generator class bounces". A **content-red** check (failing tests, type errors) -> "one evolving bounce comment" (`evaluate.ts:13`). Nobody fixes it.

### 1.4 PR follow-up sweep (`src/worker/review/prFollowupSweep.ts`)

Re-dispatches the fixer on the same PR branch for blocking review findings or conflicts, but scoped to "AAF-authored open PR" (`:1-17`), bounded by `PR_FIX_LOOP_MAX_ROUNDS`. Not a red-CI path for foreign PRs.

### 1.5 What would make remo-session PRs qualify

Author identity (`finedesignz` vs bot) matters only for **merge**, not for ingest:
- Merge trusted-author test: `src/worker/review/autoMergeAfterReview.ts:93-110` `isTrustedAuthorPr` - head repo == base repo AND `repos.getCollaboratorPermissionLevel(login)` returns `admin|maintain|write` (`WRITE_PERMISSIONS`, :85); any lookup error -> false. **`finedesignz` (owner, same-repo branch) qualifies.** A GitHub App/bot author: `[UNVERIFIED]` whether the collaborator-permission endpoint returns write for a bot login; do not assume. Recommendation: CORCH PRs should be authored by the owner account (or a machine user added as a repo collaborator with write), same-repo branch, never a fork.
- Red CI repair for these PRs needs a **new adoption path** (see 1.6). None of INFRA-01 / Woodpecker callback / sweep qualifies a foreign-authored PR today.

### 1.6 Smallest additive change for need (a), red-CI half `[UNVERIFIED design - not prototyped]`

Goal: a CORCH-authored red PR gets a fix job with AAF's existing cap/escalation.
Proposal (reuse, do not fork):
1. Add `POST /api/pr-adoptions` (scope `defects:write`; org owner/admin) `{repo_slug, pr_number, head_sha}` that inserts an annotation (`source 'heal'`, `heal_external_id` namespaced e.g. `corch:<project>:<repo>:<pr>`) + defect with `pr_url`, `status 'fixed'` (the status the Woodpecker intake requires, `woodpeckerFailureIntake.ts:118`). CORCH calls it right after opening each PR. Idempotent on `heal_external_id`.
2. In `ciFailureClassify.ts:64-68`/`ciFailureIntake.ts`, instead of skipping `pr_context_unsupported`, look up a defect by `pr_url` and call `enqueuePrFollowupInTransaction` (`src/lib/server/dispatch/enqueuePrFollowup.js`, already imported at `woodpeckerFailureIntake.ts:8`) with kind `ci`; keep the skip when no adopted defect exists. This removes the per-repo Woodpecker notify-step requirement because the GitHub `status` webhook already arrives for every installed repo.
3. Keep existing cap (`CI_FAILURE_RESUME_MAX`) and `defect_escalated` notification as the terminal signal (feeds need (b)).
Open risk: INFRA-01 requires an active `plugin_apps` row + `ci_failure_ingest` flag (ciFailureIntake.ts:156-194); an adopted-PR branch must not require it, or CORCH must also register a plugin_app per repo. Needs a panel decision.

---

## 2. Merge: gates, registration, the sweep gap

### 2.1 Policy and gate list

`docs/merge-policy.md` is canonical (`:1-7`): AAF merges every PR it handles once gates pass, incl. "session-authored PRs in repos AAF serves" (`:8-10`). `CLAUDE.md` "Merge policy (2026-09-26)" repeats it.

Gates (merge-policy.md:43-52, code-verified where noted):
1. Every required check green **on that head SHA** (per-SHA status API, never rollup) - `src/worker/review/autoMergeChecks.ts` (`fetchAndEvaluateChecks`, merge-policy.md:163-165). No required checks on base -> falls back to "all reported checks/statuses green and at least one exists".
2. REVGATE + QC marker pass on SHA - **satisfied by policy** while `REVGATE_SKIP_ON_GREEN_CI` is on (default; `docs/merge-policy.md:15-41`). `qc_ready_markers` row for exact head SHA still required (`:167-176`).
3. Not destructive diff; no CI/gate config touched (`src/worker/agent/ciDenylist.ts`).
4. Repo owner in `AUTOMERGE_OWN_GITHUB_ORGS` - `evaluateAutoMergeGate` `src/worker/review/autoMergeGate.ts:115-117` `ownsRepo`; empty/unset env refuses every repo (`docs/automerge-runbook.md:58`).
5. Kill switches: `orgs.agent_paused` must be explicitly `false`; `projects.merge_enabled` effective on - `src/lib/server/dispatch/mergeGate.ts:45-70` (`row.agent_paused !== false` -> refuse; `effectiveMergeSwitch(row.merge_enabled, automergeTrustedPrsEnabled())`). Re-checked immediately before `pulls.merge`; merge SHA-pinned (`merge-policy.md:218-222`).
6. Authorship: `autoMergeGate.ts:130-147` - in trusted mode a same-repo write-author passes in place of `selfAuthored && defectKnown`. Trusted mode = `AUTOMERGE_TRUSTED_PRS`, **on when unset** (`src/lib/server/automergePolicy.ts:21-42`; fails closed to off on unrecognized value).
7. Per-app `plugin_apps.automerge_enabled` / per-project `merge_enabled` are tri-state: NULL = on in trusted mode, explicit `false` = opt-out (`automergePolicy.ts:44-53`; migration 0119).
8. Branch freshness (stale branch waits/rebases; `merge_stale_after_minutes` default 60), oldest-PR-first, drafts never merged, two-rounds-then-merge cap (`merge-policy.md:54-109`, runbook `:91-93`).
9. Draft: never rebased or merged (`merge-policy.md:99-104`).

`docs/automerge-runbook.md` gate 7 ("PR must have been opened by AAF worker identity") and "no auto-merge can fire in production today" (`:15-18`) are **stale** relative to trusted-PR mode and the 2026-09-26 policy; code wins.

### 2.2 No project row = no review, no merge, no remediation

- `src/lib/server/webhooks/resolveReviewProject.ts:1-29`: resolves the `projects` row by (installation.id, repo full_name) and `review_enabled = true`; null -> "the caller must reject/ignore the event, never auto-provision a project, client, or org from webhook content" (TEN-05). `remediationEvent.ts` has the same `repo_not_provisioned` skip.
- A merge candidate needs a `projects` row with `github_installation_id` and `review_enabled=true` (runbook `:62`), but **not** a `plugin_apps` row in trusted mode: `autoMergeAfterReview.ts:161-163` "LEFT join: a review-enabled repo with no plugin app (review-only onboarding) can still merge in trusted-PR mode"; README:561 "The missing-plugin-app ('review-only' repo) skip and the 3-file/80-line size cap are bypassed for such PRs."
- The GitHub App installation: the `installation`/`installation_repositories` webhook (`+server.ts:903`) only updates `github_installations` rows that already exist or have a `plugin_apps` org mapping; **it never creates a project** (`src/lib/server/webhooks/upsertInstallation.ts:1-18`).

### 2.3 How a project row is created today (no review-only API)

| Mechanism | Creates | Auth | Notes |
|-----------|---------|------|-------|
| `POST /api/plugin/apps` (`src/routes/api/plugin/apps/+server.ts:1-30,249-372`) | client (kind plugin) + `projects` (`repo_kind`,`repo_slug`,`github_installation_id`, `review_enabled` default true unless another project already reviews that (installation, repo)) + `plugin_apps` (one active per repo, migration 0104) | session cookie or token with `apps:write`; org owner/admin; installation must be org-trusted or caller proven GitHub admin of repo (`:215-246`) | returns `signing_secret` once; idempotent (`already_exists`) |
| `POST /api/plugin/apps/register` (`.../register/+server.ts:1-52`) | `plugin_apps` `status:'pending'` (not active) | Titanium Licensing license-key bearer | for our own licensed apps; pending apps are rejected at ingest |
| `provisionReposCoreWith` (`src/lib/server/provisioning/provisionReposCore.ts:242` `insert into projects (client_id, url, title, created_by, repo_slug, repo_kind, github_installation_id, review_enabled)`) via `provisionLegacyRepos.ts` / `provisionSelfRepo.ts` | client + projects only (no plugin_app) | code/script, not an HTTP route | idempotent find-or-create; refuses to re-tenant an installation (`InstallationOrgConflictError`) |
| `GET /api/projects` (`src/routes/api/projects/+server.ts:1-42`) | read only (scope `projects:read`) | - | file contains only `GET` |

`SCOPES` includes `projects:write` and `apps:write` (`src/lib/server/auth/apiTokens.ts:30-43`); API tokens are `zex_`-prefixed (legacy `aaf_`). `[UNVERIFIED]` whether any route currently consumes `projects:write`.

### 2.4 Smallest additive change for need (a), merge/registration half `[UNVERIFIED design]`

Add `POST /api/projects/provision` (scope `projects:write`, org owner/admin, same-org-installation check) that calls the existing `provisionReposCoreWith` for `{repo_slugs[], installation_id}` and returns project ids. CORCH (hub) calls it **before** opening the first PR in a repo. No webhook-driven auto-provision (preserves TEN-05). Per-repo prerequisites remain: owner org in `AUTOMERGE_OWN_GITHUB_ORGS`, AAF GitHub App installed on the repo, repo allows squash/merge/rebase.

Alternative with zero code: call `POST /api/plugin/apps` per repo (heavier: creates plugin_app + client). The provisioning route is smaller blast radius for 60 repos.

### 2.5 `merge-policy.md:39` "Known gap" (sweep gap)

`docs/merge-policy.md:39-41`: "jobs enqueued by worker sweeps (backfill, infra retry, check re-run) are also settled as skipped, but only the webhook paths post the `success` check run. A sweep-created skipped row has no check run until the next webhook/`/review`." Impact for CORCH: in a repo whose branch protection requires the `ai-review` context, a PR whose review row was created by a sweep (not a webhook) never gets the `ai-review` success check run, so a required-`ai-review` repo can sit pending. Mitigation within CORCH: ensure the PR is opened/synchronized via GitHub (webhook path) and prefer repos that do not require `ai-review` as a required check. Fix is AAF-side (post the check run in the sweep path), not CORCH.

---

## 3. Outbound events

### 3.1 What exists

- **No generic outbound webhook on PR merged/closed or fix job failed/exhausted.** `[VERIFIED by grep]` no `pr.merged`/`pr.failed` emitter; no Telegram code (`git grep -i telegram` in `src/**`, `docs`, `README`, `migrations`: no hits).
- `src/lib/server/dispatch/runDispatch.ts:873-883` `deliverWebhook` posts to `client_webhook_url || org_webhook_url` with `client_webhook_secret || org_webhook_secret`, but comment at `:9` says "no production caller (no code sets client/org webhook_url outside tests)". It carries dispatch payloads, not merge events.
- **Revanote outbox (closest pattern)**: `src/lib/server/intake/outcomeForward.ts` - durable `intake_callbacks` outbox (`enqueueIntakeCallback` :356 inside the same tx; `deliverIntakeCallbackById` :599 after commit; drained from the worker's annotation-reconcile sweep, header :4-10), events `pr_opened | clarification | failed | verified_no_change | merged` (:45), signed via `signedPost` with `requireSecret`, SSRF-vetted per send (`outboundGuard.ts:1-28` https only, 443 only, no IP literals, resolve once and pin). `merged` is emitted by `src/lib/server/intake/mergedForward.ts` only for Revanote-tracked PRs after deploy.
- **Email-only notifier**: `notification_jobs` (`migrations/0067_notification_jobs.sql:1-50`; event types `clarification_needed|job_failed|pr_opened`, extended by 0118 with `defect_escalated`), FOR UPDATE SKIP LOCKED poller, drains to email via E4A (`src/lib/server/notifications/e4aClient.ts`, `alertSender.ts`). Bound to `annotation_id`, org-scoped. Not an HTTP-callback channel.
- **Remo link is inbound-to-hub only**: `src/lib/server/orchestratorChat/config.ts:10-37` (`ORCH_CHAT_HUB_URL` default `https://app.remo-code.com`, `ORCH_CHAT_HUB_KEY` scope `chat:session`, `ORCH_CHAT_PROJECT_DIR` default `C:\Users\artic\GitHub`); `hub.ts:60-86` guard. AAF proxies a browser chat to `/api/chat/*`; it does not push events. Using chat to deliver events would be a misuse (and the key is `chat:session` scoped).

### 3.2 Hook points for `pr.merged` / `pr.failed`

| Event | Where (file:line) | Why this site |
|-------|-------------------|---------------|
| `pr.merged` (any merger: AAF or human) | `src/routes/api/webhooks/github/+server.ts:872-884` - branch `if (action === 'closed' && body.pull_request?.merged === true)`; comment at :872-874 states it "Covers AAF's own auto-merge and human merges alike (both emit this event), so merge.ts needs no hook" | Single authoritative GitHub-driven site; event-driven (rule 23); sits after the review-trigger block so it runs for any installed repo `[UNVERIFIED: that this branch is reached for repos with no projects row - structure suggests yes, not exercised]`. Add `enqueueOrchestratorEvent(tx, ...)` in the same `withServiceRole/begin` as `handlePullRequestClosed` (:877-881), then `void deliver...(id)` like :882. Also `closed` unmerged (currently a deliberate no-op, :886-888) if CORCH wants `pr.closed`. |
| `pr.failed` terminal: fix resume cap exhausted / defect escalated | `src/lib/server/ci/woodpeckerFailureIntake.ts` (escalation branch; `enqueueNotification` imported :12; behavior `docs/woodpecker-ci-callback.md:109-111`) | same tx as the `defect_escalated` notification |
| `pr.failed` terminal: review-fix cap reached then merge blocked / merge refused permanently | `src/worker/review/qcCapMerge.ts` (`markPrFixCapped`), `src/worker/review/mergeBlockNotice.ts` (non-transient refusals, merge-policy.md:230-235) | where AAF already decides "will not fix itself" |
| `pr.failed` terminal: agent job exhausted | worker settle path for `agent_jobs` (`settleJob*` in `src/worker/`; `[UNVERIFIED]` exact file:line, not opened) | `job_failed` notification already enqueued there |

### 3.3 Smallest additive change for need (b)

1. Migration `0175_orchestrator_events.sql`: table `orchestrator_event_outbox(id uuid pk, org_id, repo_slug, pr_number, event text check in ('pr.merged','pr.closed','pr.failed'), occurrence_key text, payload jsonb, status, attempts, next_attempt_at, ...)` with `unique (event, repo_slug, pr_number, occurrence_key)` for idempotent redelivery; RLS select for org members, writes under service role (copy 0067 pattern).
2. `enqueueOrchestratorEvent` + deliver/drain mirroring `outcomeForward.ts` (drain from the existing reconcile tick, no new timer).
3. Delivery: **reuse `signedPost`** - `src/lib/server/dispatch/signedPost.ts:1-3,44-46` ("The ONE HMAC-SHA256 signer + POST for AgentAutofix's outbound webhooks ... no second signer"; `signBody(secret, body)` -> `sha256=<lowercase hex HMAC-SHA256(secret, body)>`), emitted as `X-ZeroExposure-Signature` plus `X-ZeroExposure-Event-Id` (signedPost.ts:55-60,73-80), `requireSecret: true`, transport = `pinnedRequest` + `vetOutboundUrl` (`outboundGuard.ts`). **Constraint:** `vetOutboundUrl` allows only https:443 and public addresses, so the hub receiver must be a public https:443 URL (e.g. `https://app.remo-code.com/...`).
4. Config: `CORCH_EVENT_URL` + `CORCH_EVENT_SECRET` env (web + worker), unset -> nothing enqueued (no fallback). Receiver verifies with the `X-ZE-Signature-256` pattern: `src/lib/server/ci/woodpeckerFailure.ts:49-61` (`sha256=` + `createHmac('sha256', secret).update(rawBody,'utf8')`, constant-time `timingSafeEqual`) - header name differs from `signedPost`'s (`X-ZeroExposure-Signature`); algorithm is identical. Decide one header name for the hub receiver; recommend signedPost's to honor the "one signer" rule. Body should carry `event_id` (stable across retries) + a fresh `timestamp` per send (outcomeForward.ts:24-25 convention) so the hub can enforce +-5 min skew.

---

## 4. Quota

### 4.1 What exists

- `src/worker/quotaPause.ts:1-45`: **in-process only** (module-level `pausedUntilMs`, `streak`; "In-process on purpose (no migration): a restart forgets the pause"). API: `pauseFixClaimsUntil(until)`, `fixClaimsPausedUntil()`, `noteQuotaRecovered()`, `rateLimitStreak()`. Only fix jobs consult it (`:13-15`); review jobs have `review/quotaDefer.ts`.
- Armed by a 429: `src/worker/runFix.ts:2476-2479` `isRateLimited(e)` -> `computeRateLimitRetryAt(e.headers, rateLimitStreak())` -> `pauseFixClaimsUntil(nextAttemptAt)`.
- Consumed in the claim loop: `src/worker/agentRunner.ts:2207-2217` - `if (k === 'fix') { const resumeAt = fixClaimsPausedUntil(); if (resumeAt) { done.add(k); fixPassReason = 'provider_quota'; ... continue; } }`.
- `src/worker/rateLimitRelease.ts:1-101`: early-releases parked jobs (`last_error like 'rate_limited:%'`, `next_attempt_at > now()`) when a later job in `agent_run_transcripts` completed cleanly with `input_tokens > 0` and `outcome_kind <> 'threw'`; runs from the reconcile tick. Evidence-based; never shortens a real quota park.
- **No external quota feed, no HTTP read of any usage data.**
- **Adjacent: Claude seat pool** - `docs/claude-pool.md` (`:1-57`): flag `CLAUDE_POOL_ENABLED` (**built, OFF**; "Turning it on is an owner action (terms review pending)"), worker leases a seat per fix job from the `titanium-claude-pool` broker (`CLAUDE_POOL_URL`, `CLAUDE_POOL_APP_KEY`). Vendored client `src/lib/server/claudePool/client.ts` has `LeaseGrant.accountFp`, `ObservationInput{window: 'five_hour'|'seven_day', utilization, resetsAt}` forwarded from CLI `rate_limit_event`s, and `PoolStatus{accounts, activeLeases, freeSlots, nextAvailableAt}` (client.ts:35-52). Broker answers `pool_exhausted`/`broker_unavailable` -> job **deferred** (re-queued at `retry_at`, attempt refunded; fails after 24h); `auth_failed`/`policy_disabled`/etc. -> permanent failure, no fallback to shared token (`docs/claude-pool.md:30-35`). Chat and reviewer seats do **not** use the pool (`:17-24`).

### 4.2 Fixer launch + auth (hard-floor check, rule 22c)

- Default fixer transport is **SDK HTTP, not CLI**: `src/lib/server/models/transports.ts:95-99` `ROLE_TRANSPORT = { fixer: 'sdk', triage: 'cli', chat: 'cli' }`; `runFix.ts:1106` `const transport: TransportName = cliMcpRequested && canaryOk ? 'cli-mcp' : 'sdk';`. `runCliFix` (`src/worker/cli/runCliFix.ts:165,437` spawns `bin: 'claude'`) runs only when the project requested `cli-mcp` and canary passes.
- SDK path: `runFix.ts:821-823` `real = new Anthropic({ apiKey: null, authToken: sdkClaudeBearer(claudeOAuthToken), ...` (comment :806-809: Bearer + `anthropic-beta: oauth-2025-04-20`, "apiKey is pinned null so the SDK can NEVER fall back" to an API key; carries a "NOTE ON RISK" about the OAuth-beta bearer approach).
- CLI path env: `src/worker/cli/containment.ts:301-318` `buildChildEnv` builds from `{}`, `env.CLAUDE_CODE_OAUTH_TOKEN = token` (`pooledClaudeToken() ?? claudeOAuthToken()`), missing token throws `NoCliCredential`, comment `:299` "Never reads `ANTHROPIC_API_KEY`".
- `transports.ts:20-23`: "Subscription OAuth ONLY (`CLAUDE_CODE_OAUTH_TOKEN`, global rule 22c). No raw-API-key env var string appears anywhere in this file". `providerProbe.ts:92` deletes `ANTHROPIC_API_KEY` from the env; `src/terminal/childEnv.ts:111` same.
- **Verdict: no API-key use found on the fix path; no hard-floor violation.** Scope of check: `git grep` for `ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN` over `src/**` excluding tests (first 30 lines of hits read; not exhaustive over `scripts/`). Caveat to flag: the repo's `CLAUDE.md` Stack section still says "AI: Anthropic SDK directly, model `claude-opus-4-8`" (stale; superseded by the Architecture section "subscription OAuth only -- never an API key"). `[UNVERIFIED]` the reviewer path's Codex seat (`CODEX_AUTH_JSON_B64`) is subscription OAuth; not opened further.
- Single shared seat today: `CLAUDE_CODE_OAUTH_TOKEN` on the worker (every transport row `seat: 'worker-oauth'`, transports.ts:40-43), unless the pool flag is on.

### 4.3 Where a pre-launch quota feed check goes

Primary: `src/worker/agentRunner.ts:2207-2217`, beside the existing `fixClaimsPausedUntil()` check - same place, same effect (`done.add('fix')`, `fixPassReason = 'provider_quota'`, one log line per window). Implementation: new `src/worker/quotaFeed.ts` that GETs the feed (env `QUOTA_FEED_URL`, bearer secret from env), caches for a short TTL, and on "account exhausted until T" calls `pauseFixClaimsUntil(T)` so every downstream consumer (log line, `fixPassReason`, rate-limit streak) is unchanged. Secondary: `runFixPooled.ts` (pool lease path) for the per-account case.
Design constraints to decide in a panel, not here (rule 7c: no fallbacks):
- **Account identity**: the feed is per-account (Usage Guard / CUG rotation), but AAF's worker uses one shared token (or a pool-leased seat with `accountFp`). The feed is only actionable if AAF can map "my seat" to a feed account id. `[UNVERIFIED]` which CUG account the AAF worker token belongs to. Without that mapping a per-account feed cannot gate AAF.
- **Feed unreachable/stale**: either fail-closed (pause) or "no signal = today's behavior" (429-driven pause stays authoritative). The latter is not a fallback transport, but it is a policy choice to lock explicitly.
- **Cloud boundary**: AAF worker runs on Coolify and must not run locally (`CLAUDE.md` "Local/cloud execution boundary", `docs/aaf-local-cloud-boundary.md`); the feed must be reachable from Coolify (hub public URL), not a localhost endpoint.
- Overlap with the claude-pool broker's utilization observations: if the pool is ever enabled, the broker is already the per-seat quota authority; the CORCH feed should either be consumed *by the broker* or be explicitly defined as the source of truth to avoid two quota sources.

Smallest additive change for need (c): `quotaFeed.ts` + one call at agentRunner.ts:2207 + env `QUOTA_FEED_URL`/`QUOTA_FEED_TOKEN`, default unset = no behavior change. No migration (matches quotaPause.ts's in-process design).

---

## 5. DB engine, migration convention, tests, preflight

- **Engine:** Postgres on Coolify via `postgres` (porsager) tagged-template SQL; tenant isolation by RLS (`withTenant` for sessions, `withServiceRole` BYPASSRLS for webhooks/worker). `CLAUDE.md` Stack ("vanilla Postgres on Coolify - no Supabase"). Migrations tool `node-pg-migrate` (`-m migrations -j sql`).
- **Run migrations:** `package.json:29` `"db:migrate": "node-pg-migrate -m migrations -j sql --no-check-order up"` (`--no-check-order` because numbers land out of order).
- **Convention** (`migrations/0174_comment_fidelity_needs_human.sql:1-30`, `migrations/0067_notification_jobs.sql:1-50`): file `migrations/NNNN_snake_case.sql`, first line `-- Up Migration`, header comment explains additive-ness; idempotent DDL (`create table if not exists`, `alter ... drop constraint if exists` then re-add, `create index if not exists`); `alter table ... enable row level security` + org-member SELECT policy created inside a `do $$ ... if not exists (select 1 from pg_policy ...)` block; writes only under service role. Check constraints on enums are dropped and recreated with the new value list (0174 does this for `intake_callbacks_event_chk`).
- **Numbering:** latest on origin/main is `0174_comment_fidelity_needs_human.sql`; `0172`/`0173` are reserved by an open PR (0174 header :10-11); `0165` is duplicated (`woodpecker_ci_failures` and `worker_heartbeats_fix_claim_state`); 0168-0170 are absent. Next free number must be re-checked against open PRs at implementation time (`git ls-tree --name-only origin/main migrations/` + `gh pr list`). `[UNVERIFIED]` that 0175 is free.
- **Tests:** `npm run test:unit` = `vitest run --project unit` (no Postgres); `npm test` = `vitest run` (includes `*.db.test.ts`, needs migrated Postgres); `npm run test:rls` = RLS integration config (`DATABASE_URL_TEST`); `npm run test:serial`; `npm run check` = `svelte-check`; `npm run build:worker`. (`package.json:11-29`)
- **Preflight:** `scripts/preflight.ps1` exists: `npm ci` -> `npx svelte-kit sync` -> `npm run check` -> `npm run build` -> `npm run test:unit`; deliberately skips DB-backed tests and `test:rls`; has a documented Windows allowance for three real-git tests (`destructiveGate.test.ts`, `fsTools.test.ts` + one more, cut off in my read of the header). Rule 7 requires it green before first push. DB-touching changes also need a local Postgres run (preflight will not catch them; Woodpecker CI will).

---

## 6. Existing linkage with remo-code

- **Remo -> AAF-as-app:** `docs/automerge-runbook.md:156` (2026-09-12 snapshot) lists a `remo-code` plugin_apps row among 11; **stale, do not rely** (re-query live if needed; no prod calls made here).
- **AAF -> remo hub:** orchestrator chat sidebar, `docs/orchestrator-chat.md:1-12,42-47`: AAF server holds ONE hub key (`chat:session`), proxies `/api/orchestrator-chat/*` to hub `/api/chat/*`. Key minted per remo `docs/auth.md` "Chat via API key" (`POST /api/api-keys {"name":"aaf-chat","scopes":["chat:session"]}`). Source vendored from remo-code worktree `remo-code-ext-chat` branch `feat/ext-chat-bearer` (`docs/orchestrator-chat.md:58-60`).
- **remo PR #533:** `git grep -n -E "#533|PR 533|pull/533"` over `docs/orchestrator-chat.md` returned no hits; I did not search the rest of the repo. **No evidence of #533 in AAF; UNVERIFIED.** Nothing in AAF reads a remo session key from a PR/branch/annotation.
- **No PR-event channel between them today.** CORCH's merge/terminal events (need b) would be the first AAF -> hub event path; CORCH's quota feed (need c) would be the first hub -> AAF data path.

---

## 7. Per-need summary: exists vs smallest additive change

| Need | Exists today | Gap | Smallest additive change |
|------|--------------|-----|--------------------------|
| (a1) Merge owner for orchestrator PRs | Trusted-PR auto-merge (default on) for same-repo write-author PRs in `AUTOMERGE_OWN_GITHUB_ORGS`, review-only projects allowed, REVGATE skipped on green CI | Needs a `projects` row (+ installation, `review_enabled`); no API to create one without a plugin_app; sweep-created rows lack `ai-review` check run | `POST /api/projects/provision` over `provisionReposCoreWith` (projects:write); optionally post the skipped `ai-review` success check in sweep paths (fixes merge-policy.md:39 gap) |
| (a2) Owner for red CI | INFRA-01 (default-branch push only), Woodpecker callback + 5B remediation (mechanical only, off by default), review-fix sweep (AAF PRs only) | Content-red check on a foreign PR has no fixer | `POST /api/pr-adoptions` (annotation+defect with `pr_url`) + route `pr` status contexts to `enqueuePrFollowupInTransaction` kind `ci` when an adopted defect exists (replaces `pr_context_unsupported` skip for adopted PRs) - UNVERIFIED design, needs panel |
| (b) Outbound event on merge / terminal failure | Nothing generic; `signedPost` signer, `intake_callbacks` outbox pattern, merged-PR webhook branch at `webhooks/github/+server.ts:875` | No event table/sender | migration `orchestrator_event_outbox` + enqueue at `+server.ts:875-884` and at terminal-escalation sites + `signedPost`/`pinnedRequest` delivery; env `CORCH_EVENT_URL`/`CORCH_EVENT_SECRET` |
| (c) Quota feed read before launch | In-process pause from 429 only; pool broker (flag off) with per-seat observations | No external feed; per-account identity mapping unknown | `src/worker/quotaFeed.ts` feeding `pauseFixClaimsUntil` at `agentRunner.ts:2207`; no migration; resolve account-id mapping + feed-down policy by panel |

## 8. Open questions for CORCH planning (each needs a panel, not an owner ask)

1. Which GitHub identity will author orchestrator PRs (owner account vs machine user vs App bot)? Merge trust depends on collaborator-write lookup; bot behavior UNVERIFIED.
2. Does adopted-PR red-CI fixing need a `plugin_apps` row (INFRA-01 requires one) or can it key on `projects` only?
3. Quota feed account mapping and feed-down policy (section 4.3).
4. Which header name the hub receiver verifies (`X-ZeroExposure-Signature` from `signedPost`, or `X-ZE-Signature-256` used by the Woodpecker callback). Algorithm is identical.
5. Whether `pr.closed` (unmerged) is a CORCH event; AAF currently treats it as a deliberate no-op (`+server.ts:886-888`).

## 9. Not done / limits

- No prod, DB, or authenticated calls; live AAF state (which repos have projects, flags, env values) is **UNVERIFIED** and docs with live counts are stale (`docs/automerge-runbook.md:20-22`).
- Did not open: `enqueuePrFollowup.ts`, `ciFailureIntake.ts` beyond grep lines, worker job-settle code, `qcCapMerge.ts`/`mergeBlockNotice.ts` bodies, `runFixPooled.ts`. Hook points for terminal failures are therefore identified by module, not exact line.
- No live stuck queue investigation (out of scope per brief). No errors hit, so no AAF tickets filed.
