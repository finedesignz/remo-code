# CORCH panel seat A - refute-first (correctness / failure modes)

Evidence read: PANEL-BRIEF.md, RESEARCH-remo.md, RESEARCH-cug-gsdconsole.md, RESEARCH-aaf.md (no code spot-checks beyond their cited lines; code-dependent claims marked UNVERIFIED).
Assumptions stated: (1) PTYCAP P4 (ledger/kill switch) and P7 (heal) are merged on main (research ROADMAP row says P4 "QC BLOCKED, 2 open HIGH races" but heal P7 sits on top of it; stale or not must be verified before CORCH-01 starts, because the reserve-before-send ledger is the double-dispatch backstop). (2) CUG host (owner Windows box) is the only place CUG can run.

## F1. Dispatcher core

**Verdict:** REPLACE with a new cross-repo work-item queue (`corch_*` tables); reuse only primitives: `dispatch()` + gate list, `governedLaunch`/`launchSessionForUser(machine:true)`, `reserveSessionSlot`, kill switch, lifetime ledger, `fanOutNotify`, reapers' "positive knowledge only" rule. Do not touch `orchestrator_rows`/`routine_queue`; retire them in the last phase.

**Rationale:**
- The orchestrator is a per-session heartbeat: one task per session, cadence via `last_fired_at`, completion = agent-reported `<<STATE>>` sentinels (RESEARCH-remo.md:8, :17, :21). A backlog needs item identity, lease, attempt and not-before; none of that fits a row keyed by session.
- Its prod due->PR loop has never produced a PR (ROADMAP.md:131 via RESEARCH-remo.md:29); extending inherits an unproven loop plus in-memory `SessionQueue` locks (4h stale-lock reaper) that lose state on restart.
- Exactly-once needs DB truth: `UPDATE ... WHERE status='queued' RETURNING` claim, partial unique index on one live attempt per item AND one per (repo, worktree), reclaim only on positive knowledge (fresh supervisor inventory lacks the session, same rule as dead-session reaper) with an attempt cap (3) then BLOCKED. One session per work item gives clean per-project token attribution (`token_usage.session_id`).

**Strongest counter:** "Extend: the macro path is e2e-tested against real Postgres in CI and already has caps, notify, reconcile." Loses because those tests prove the per-session heartbeat shape, not a cross-repo claim/lease/requeue; bolting item identity onto `routine_queue` still needs a new table set, so extending yields the new design plus the legacy coupling (and the agent-reported-state reconcile is exactly the self-report failure mode we want to remove).

**Risk:**
- New dispatch path must pass PTYCAP guards: new counter-key kind `corch:<work_item_id>` (per item, so the literal lifetime cap of 1000 is per-item, never per-repo recurring) added to `counter-key-assignment-guard`; gate list carries kill switch FIRST, cost + token caps (`token-cap-coverage`), `launch-callers-guard`/`session-start-senders-guard`/`reserve-caller-guard` updates; all launches via `governedLaunch`.
- `initial_prompt` is not delivered by the supervisor (RESEARCH-remo.md:35): launch, wait for `/ws/agent` auth, then `dispatch()`; reuse the grace-park pattern or a prompt is silently dropped.
- Existing `thresholdGate` FAILS OPEN on null/stale snapshot (threshold.ts:50,53). CORCH must add its own fail-closed `corchQuotaGate` to its gate list; do NOT change `threshold.ts` (humans stay fail-open).
- Must not dispatch into a repo a human is working in: pre-dispatch check = no online non-CORCH session / open `session_runs` for that repo and no memlog claim. Hub reachability of memlog UNVERIFIED; if unreachable, fail closed per repo.
- Flag `REMO_CORCH_ENABLED` default OFF; true no-op OFF (pin with a flag-off test like `heal-flag-off`).

## F2. Backlog storage + ingestion

**Verdict:** Hub Postgres is the sole system of record for CORCH state (items, attempts, leases, per-repo priority + budget). Phase/backlog candidates are derived from gsd-console only (SSE `/api/board/stream` as the change trigger, `GET /api/board/projects[/{id}]` to re-read the changed project, `gsdc_` `board:read` token from Pass). NOT supervisor-reads-`.planning`; NOT both.

**Rationale:**
- Reading `.planning` directly creates a second, divergent backlog truth and re-implements the gsd-core parser (RESEARCH-cug:134). One feed, fail closed.
- Owner priority + budget are CORCH decisions, not gsd-console data: table `corch_projects(repo_slug pk, priority, daily_token_budget, enabled, paused_until)`, edited via an authenticated hub API. gsd-console owns "what phase is next"; hub owns "whether and when to run it".
- Item identity is `(repo_slug, source, external_id)` unique, so SSE reconnect re-snapshots (10-min stream lifetime, 10 streams/account) are idempotent upserts, not duplicate work. Resync on reconnect is event recovery, not polling.

**Strongest counter:** "Supervisor reading `.planning` is fresher (uncommitted work), covers all 60 repos without connector enrollment, and has no gsd-console SPOF." Loses: it yields two truths, makes the supervisor an ingestion engine on a flaky Windows host, and the fresher uncommitted state is precisely what a hub should NOT dispatch over (an owner interactive session may be mid-phase). Coverage gap is a real cost but is solved by enrolling repos, not a second source.

**Risk:**
- Dispatch gates must fail closed on `stale`/`divergent`/`snapshot_state != ready`/`active_runs > 0` (RESEARCH-cug:127-129). GitHub-feed-only repos are default-branch truth: ok for derive, but a connector-offline repo stays undispatchable.
- gsd-console down (5xx) = no new items, ticket it (7d), NO fallback to `.planning` reads (7c).
- Next-actionable derivation (current phase else lowest pending, ignore 999 backlog) is hub code with no upstream endpoint; pin it with tests; completion of an item is determined by PR merged event / next snapshot, not the agent's claim.
- Mirrored phase names/todos are untrusted: any text reaching a prompt goes through `fenceUntrusted` + `SCOPE_CONTRACT`; prompt = fixed GSD macro + repo + phase ref, not free text.
- Other entrants (AAF tickets, memlog requests, owner manual) enter through ONE `POST /api/corch/work-items` (explicit-only scope `corch:enqueue`, idempotency key = `(source, external_id)`), not separate ingesters; ship gsd-derived + manual first, tickets/memlog later (memlog has no verified hub reachability; do not poll Redis).
- Enrollment of the ~60 repos in gsd-console is UNVERIFIED: first operational gate is an authenticated `GET /api/mirror/projects` diff against the repo list.
- Token mint is browser-only owner action; rotation needs owner approval (7f).

## F3. Quota feed

**Verdict:** CUG (Rust) POSTs its field-allow-listed snapshot to a new hub endpoint with an explicit-only scope `quota:publish`; hub persists latest per account in Postgres (not in-memory) with hub-clock `received_at`; AAF PULLS via `GET /api/corch/quota` with explicit-only `quota:read` at fix-claim time. Fail CLOSED everywhere for machine work.

**Rationale:**
- Supervisor-relay (zero CUG change) couples quota to supervisor liveness and Windows-only file access, and the R4 Linux workers have no CUG file; CUG-publishes is host-agnostic and matches the locked "CUG is the single source". CUG already rewrites the snapshot every cycle even when upstream fails, giving a free heartbeat (lib.rs:745-756 via RESEARCH-cug:25, :68).
- Persist, do not keep in memory like `usage/store.ts`: a hub restart must not blind the gate or reset to "unknown -> allow"; TTL runs on `received_at` (hub clock, immune to CUG clock skew). Reject out-of-order/replayed payloads (older `generated_at` than stored is ignored).
- Freshness: snapshot stale if `now - received_at > 2 x poll_interval_secs` (payload value clamped to a hub max, e.g. 900s, so a bad payload cannot widen it); per account additionally require `source=='live'` and `now - fetched_at <= 3 x interval` (CUG's own trust window). `fetch_failed`, `scope_blind`, missing, stale = no headroom.
- Null rule: per FIELD, null = unknown, never 0. `seven_d_pct == null` => ineligible. `five_h_pct == null` on a fresh `live` entry (5 of 5 live slots today, cause UNVERIFIED) => 5h-unknown: eligible only if 7d is known and under the dispatch ceiling (55% reference from usage-preflight.ps1), AND at most one in-flight CORCH session on that account until the next snapshot shows a 5h figure. Before the flag is turned ON, a read-only check against `usage.rs` / a live `/api/oauth/usage` response must establish whether null means "no open 5h window"; if it means "unreadable", the rule flips to ineligible.

**Strongest counter:** "Supervisor relay: no CUG release, no new secret on the CUG box, and the hub already has an authenticated `/ws/agent` channel." Loses on R2/R4: it cannot serve server-side workers, ties the feed to an agent process that can be down independently of CUG, and violates the locked decision (CUG publishes).

**Risk:**
- THE availability blocker: CUG is a Windows tray app. Laptop asleep/CUG down => no feed => fail closed => "always-on" server dispatch stops (and AAF fix claims pause). That is correct behavior, not something to fall back around (7a/7c); state it plainly to the owner as a dependency: always-on dispatch is exactly as available as the CUG host. A Linux/server CUG is the real fix if that is unacceptable.
- CUG publisher secret must come from Pass via existing `pass_cli.rs` or DPAPI, never plain `config.json`; payload drops `email` (label may be an email too: confirm).
- AAF needs a seat->account mapping (which CUG account its worker token is): env `QUOTA_FEED_ACCOUNT`; flag set but mapping absent/unknown => closed. Unset flag = no behavior change (default OFF).
- Pool broker overlap (`claudePool`, flag OFF): if ever enabled, define one quota authority; flagged for AAF devs.
- Existing hub `usage/store.ts` stays display-only; assert in a test that no CORCH gate reads it.

## F4. Server-side Linux worker

**Verdict:** One long-lived worker container PER ACCOUNT SLOT (6), each with exactly one setup-token in its Coolify env (`CLAUDE_CODE_OAUTH_TOKEN`) and its own `CLAUDE_CONFIG_DIR`; each registers to the hub as its own supervisor (own `purpose='host'` key) advertising `account_slot` in `supervisor.hello`. The hub "selects the account" by selecting the supervisor; the token never transits the hub and the supervisor needs NO per-run env-injection code. Workspace: supervisor command `corch.prepare_workspace` does `git fetch` + `git worktree add <root>/<repo>-corch-<id>` (deterministic path), then hub creates the session row with that `project_dir` and launches. Windows desktop supervisor: no per-account injection in v1; it stays ambient-account and is excluded from CORCH autonomous dispatch.

**Rationale:**
- Smallest blast radius: a prompt-injected agent can read its own env (stream-json child needs the token), so a multi-token supervisor puts all 6 accounts one `echo` away; one token per container caps a leak at one account. "Pulled per dispatch from hub" violates the no-transit rule; "Pass at boot" puts a Pass master login on the server for no gain over Coolify secret env.
- Reuses existing selection (`pickSessionTarget`/`reserveSessionSlot`, per-supervisor concurrency) instead of inventing an env-injection seam in `claude-runner.ts`/`env-sanitize.ts` (which carries `no-setup-token-on-interactive` constraints).
- Windows is excluded because CUG's rotation broker flips the host's ambient account under it; injecting per run there needs a new signed MSI and fights CUG for the same credential file.
- Worktrees are created by deterministic supervisor code, not by the agent in-turn (the session row and `assertWithinRoots` need the path BEFORE launch; supervisor today never runs `git worktree add`, RESEARCH-remo.md:72). On Linux no MSI is needed.

**Strongest counter:** "One multi-account supervisor with per-run `CLAUDE_CODE_OAUTH_TOKEN` injection: 1 container, 1 clone set, standard 'hub picks slot'." Loses: all tokens in one process env/FS readable by every session's tools, plus new injection code in a guarded spawn path; disk duplication (6 clone sets, lazy-cloned, worktrees per item) is cheap by comparison, and clones must NOT be shared across containers (concurrent git on a shared volume).

**Risk:**
- Headless Linux stream-json path is UNPROVEN (only the cloud-session script exists; node-pty/ConPTY not needed). A prove-it phase gates everything after it; Docker image needs bun, `claude` CLI, git.
- Setup-tokens are inference-only; usage visibility needs CUG's separate `usage_credential` per account (scope_blind otherwise): confirm each of the 6 slots is `live` in the feed before it may receive work.
- The agent can still read its own account token (CLI limitation); mitigate with `scrubDeployCredentials` equivalent, no deploy creds in env, output redaction; record as accepted risk, not solved.
- Same account used concurrently by owner on Windows and a server container shares one quota; the feed reflects the sum, so gating is correct but throughput is not exclusive.
- Container with GitHub write credential (F5) = additional secret; fine-grained, machine-user-scoped.
- Container restarts mid-run: the supervisor reports inventory; reclaim uses positive-knowledge rule (F1) and resumes in the SAME worktree (idempotent prompt: inspect branch state first).

## F5. PR identity + AAF closure

**Verdict:** (a) Machine user `corch-bot` (not the owner account, not a GitHub App for v1) as write collaborator, same-repo branches `corch/<work_item_id>`, never forks, with a per-repo fine-grained PAT on the worker containers. (b) BOTH AAF changes, in this order: `POST /api/projects/provision` (required prerequisite: no project row = invisible, no merge) THEN auto-adoption of CORCH PRs for red CI. Adoption triggered by the `pull_request.opened` webhook when author is in `CORCH_PR_AUTHORS` and the project is provisioned (race-free), with `POST /api/pr-adoptions` kept as the authenticated manual/backfill route. (c) Outbound events via `orchestrator_event_outbox` + `signedPost`: `X-ZeroExposure-Signature: sha256=hex(HMAC(secret, body))` + `X-ZeroExposure-Event-Id`, body carries `event_id` (stable across retries) + fresh `timestamp`. (d) `pr.closed` unmerged IS an event.

**Rationale:**
- Owner PAT on 6 containers = a prompt-injection env-exfil gives the whole owner identity (every repo, org admin scopes). Machine user is revocable, repo-scoped, and passes AAF's `getCollaboratorPermissionLevel` write test deterministically (autoMergeAfterReview.ts:93-110). GitHub App bot author behavior against that API is UNVERIFIED (RESEARCH-aaf:66), so it cannot be the v1 choice.
- Provision-only is insufficient: INFRA-01 skips every `ci/woodpecker/pr/*` context (`pr_context_unsupported`, ciFailureClassify.ts:64-68) and 5B remediation only bounces content-red; adoption-only is insufficient: no project row = webhooks ignored (TEN-05). So both.
- Creating adoption from the `opened` webhook avoids the ordering race of "hub calls adopt after opening PR": a red status that lands before the adoption row exists is dropped by the intake and never retried (woodpeckerFailureIntake.ts:116 `not_ze_pr`). If the explicit route is used instead, adoption MUST re-evaluate the current head SHA's statuses at insert time.
- Signature: reuse `signedPost` unchanged (the "one signer" rule, signedPost.ts:1-3). Hub receiver verifies HMAC over the raw body, enforces +-5 min on the signed `timestamp`, dedupes on `event_id` (unique), and mounts before the `/api/*` catch-all (`mount-order` test). The hub's `${ts}.${rawBody}` convention differs from signedPost's body-only scheme; add a receiver config variant, do not change the signer. URL must be public https:443 (`vetOutboundUrl`).
- `pr.closed` unmerged: without it a human-closed PR leaves the item `pr_open` forever. Hub maps it to `cancelled_by_human`: NOT auto-requeued (a deliberate close re-dispatched in a loop is the worst outcome) until owner resets.

**Strongest counter:** "Use the owner account: AAF already trusts it, zero setup, merges attribute cleanly." Loses on blast radius (above); the added setup is one account + collaborator invites + a PAT per container.

**Risk:**
- Hub-side state machine must be monotonic and order-tolerant: terminal states (`merged`, `cancelled_by_human`, `blocked`) ignore later events; `pr.merged` beats `pr.failed`; duplicate event_id = 200 no-op.
- Dropped-event dead end: a repo with no project row, AAF down, or an outbox that never delivers leaves `pr_open` forever. Add a bounded reconciler (a reaper, same class as existing reapers, stated as the exception to no-polling because no event exists for "AAF never saw it"): after TTL, GET the PR state on GitHub; merged/closed => synthesize the transition, still open => `stuck_pr` + `fanOutNotify`, never re-dispatch (AAF owns after PR).
- Do not start another item in a repo until the previous PR is adopted/provisioned (else the second PR stacks conflicts).
- Merge prerequisites per repo remain: owner org in `AUTOMERGE_OWN_GITHUB_ORGS`, AAF App installed, a `qc_ready_markers`/green-CI path; the merge-policy "sweep never posts `ai-review` check" gap (merge-policy.md:39-41) can stall repos that require `ai-review`; pick repos accordingly, AAF-side fix is its own ticket.
- CI on same-repo collaborator PRs exposes CI secrets to PR code (already true for the owner); note, not a new class.
- Adoption modeled as defect with `status 'fixed'` is semantic abuse; give AAF devs a panel decision (explicit `origin='corch'` flag) rather than faking status.
- Open: whether adoption needs a `plugin_apps` row (INFRA-01 requires one); recommend keying on `projects` only.

## F6. Phase order (one phase = one PR in one repo)

Preconditions (not PRs): P0a verify PTYCAP P4 ledger/kill switch actually merged and the "2 HIGH races" resolved (else CORCH-01 inherits double-dispatch). P0b create machine user `corch-bot`, add to target repos, store PAT/keys in Pass (agent action, no PR). P0c authenticated `GET /api/mirror/projects` coverage diff of gsd-console vs the repo list.

1. **CORCH-01 remo-code** - backlog + dispatcher core: `corch_*` tables (additive, idempotent in schema.sql), work-item state machine, claim/lease/heartbeat/reclaim (positive knowledge), concurrency cap, per-project daily token budget gate, fail-closed `corchQuotaGate` (reads `corch_quota_snapshot`; empty = closed), `REMO_CORCH_ENABLED` OFF, manual `POST /api/corch/work-items`, counter-key kind + all guard-test updates, `fenceUntrusted` prompt builder, session-per-work-item launch via `governedLaunch` + post-connect dispatch. Dispatches only to an existing host supervisor with an existing worktree path (no workspace command yet).
2. **CORCH-02 remo-code** - quota feed endpoints: `POST /api/corch/quota` (`quota:publish`), `GET /api/corch/quota` (`quota:read`), persistence, TTL/null/monotonic rules, scope registration, docs:sync, mount-order test.
3. **CORCH-03 claude-usage-guard (paired PR)** - `hub_publish.rs` at the `write_snapshot` seam, config fields, secret via Pass/DPAPI, no email, tests via `finish_cached_refresh_at`, schema doc; signed MSI release. Ship after 2 is deployed. Gate G1 (not a PR): end-to-end proof on a throwaway repo, one account, flag ON for one repo: due -> branch -> PR, quota feed live, kill switch tested. No later phase enables a flag until G1 passes.
4. **CORCH-04 agentautofix** - `POST /api/projects/provision` (`projects:write`, same-org installation check) over `provisionReposCoreWith`.
5. **CORCH-05 agentautofix** - `pull_request.opened` auto-adoption (`CORCH_PR_AUTHORS`) + route PR-context red status to `enqueuePrFollowupInTransaction` kind `ci` for adopted PRs + `POST /api/pr-adoptions` (backfill, head-SHA catch-up). Depends on 4 and on the explicit-origin decision.
6. **CORCH-06 agentautofix** - `orchestrator_event_outbox` migration (re-check next free number against open PRs), enqueue at merged/closed/escalated sites, `signedPost` delivery, `CORCH_EVENT_URL/SECRET` (unset = nothing enqueued).
7. **CORCH-07 remo-code** - AAF event receiver (HMAC body + signed timestamp skew + `event_id` dedupe), item closure state machine, `cancelled_by_human`, stuck-PR reconciler, `fanOutNotify`. Depends on 6.
8. **CORCH-08 agentautofix** - `quotaFeed.ts` at `agentRunner.ts:2207` beside `fixClaimsPausedUntil()` (pull, short cache, closed on stale/unreachable/unmapped, flag OFF default). Depends on 2.
9. **CORCH-09 remo-code** - gsd-console ingest: SSE trigger + board GET re-read, next-actionable derivation, stale/divergent/active_runs fail-closed, `corch_projects` priority/budget API. (Placed after closure so a wrong derivation cannot flood the pipe before PR hand-off works; manual enqueue covers phases 1-8.)
10. **CORCH-10 remo-code** - Linux worker: Dockerfile/headless supervisor packaging, `supervisor.hello` `account_slot`, `corch.prepare_workspace` command (worktree), account-aware supervisor selection (hub picks slot with quota headroom), per-container Coolify deploy config. Gate G2 (not a PR): 6 slots each `live` in the feed, one real Linux item due->PR->AAF merge.
11. **CORCH-11 remo-code** - status view (extend `AutoDevActivityPanel`/new page via WS broadcast), Telegram `/queue`, remote pause/priority endpoints (kill-switch aware).
12. **CORCH-12 remo-code** - retire flag-OFF overlap: delete macro-orchestrator cycle path, `merge-command.ts` (AAF owns merge), autospawn allowlist consumers that CORCH superseded; update guard tests and docs. Last, only after G2 plus a soak, because deletion removes the rollback.

Ordering rationale: nothing is flag-ON before G1; AAF provision/adoption/events (4-6) precede closure (7) and the Linux fleet (10) so no PR is ever opened into an unprovisioned repo; ingestion (9) and scale-out (10) come after the loop is proven on manual items; deletion (12) last.
