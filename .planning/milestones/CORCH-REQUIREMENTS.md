<!-- updated: 2026-11-13 -->
# Milestone CORCH - Central Orchestrator - REQUIREMENTS

**Milestone CODE:** `CORCH` (phase dirs `.planning/phases/CORCH-NN-<slug>/`, collision-safe per global rule).
**Roadmap:** [CORCH-ROADMAP.md](CORCH-ROADMAP.md)
**Status:** SCOPED. Architecture LOCKED by panel 2026-11-13 (`.planning/phases/CORCH-00-research/PANEL-VERDICT.md`, seats A/B/C). PTYCAP owns `.planning/ROADMAP.md`, `STATE.md` and `REQUIREMENTS.md`; CORCH never writes them.

## Goal

One always-on dispatcher in the remo-code hub that keeps GSD development moving across ~60 repos
without the owner managing sessions: a cross-repo priority backlog, per-account quota-aware
dispatch onto headless Linux worker slots, and PR closure handed to AgentAutofix (AAF).

Owner locks (not re-litigated): build in remo-code; remo-code owns backlog + sessions; AAF owns
everything after a PR exists (CI fix, merge); Claude Usage Guard (CUG) is the single quota source;
subscription OAuth only (`CLAUDE_CODE_OAUTH_TOKEN`), never an API key; every behavior ships behind
a flag that defaults OFF; additive DB changes only; event-driven where an event surface exists.

## Assumptions (explicit; each is checked in the phase named)

| # | Assumption | Basis | Checked in |
|---|---|---|---|
| A1 | The worker's account identity is CUG's stable `account_id`, advertised by a slot supervisor as `account_slot`. CUG `slot` is display only (slots can be reordered). | RESEARCH-cug-gsdconsole.md A1 (`AccountView.id` UUID) | 02, 09 |
| A2 | The CUG payload drops `email` AND `label` (`label` is user-typed and may itself be an email). | RESEARCH-cug-gsdconsole.md A5.3, Pitfall 5 | 03 |
| A3 | Quota ceiling default 55% of `max(5h, 7d)`, matching CUG's own fail-closed `usage-preflight.ps1` default. | RESEARCH-cug-gsdconsole.md A2 | 02 |
| A4 | Defaults: per-project daily token budget 2,000,000 tokens (all four buckets); user concurrency cap 1; max 3 attempts per work item. Owner-adjustable. | Smallest safe values; no data says otherwise | 01 |
| A5 | At most ONE live run per project, and no new dispatch for a project while it has a `pr_open` item. GSD phases are sequential and parallel phases collide on `.planning/`. | GSD lifecycle | 01 |
| A6 | `thresholdGate` (supervisor oauth-poll per-user snapshot, fails OPEN at `threshold.ts:50,53`) is NOT on the CORCH gate list; CORCH reads only the CUG feed. The old store stays display-only. | Owner lock "CUG single quota source"; RESEARCH-remo.md section 3 | 01 (confirm no guard pins `thresholdGate` on machine lists) |
| A7 | The memlog claim per item is taken by hub server code, not by the prompt (a prompt is not a control). The hub->memlog transport is UNVERIFIED. | Global git rule 0; CLAUDE.md "the PROMPT is not the control" | 09 research; none available => 7e ticket to `mcp-servers`, BLOCKED-ON-MCP |
| A8 | Worker sessions keep `dangerously_skip_permissions:false` (existing machine-spawn invariant); tool permission comes from an explicit allowlist in the per-slot `CLAUDE_CONFIG_DIR/settings.json`. Whether that is enough for a full unattended GSD phase is UNVERIFIED. | CLAUDE.md "Machine-triggered spawns force dangerously_skip_permissions: false" | 12; insufficient => panel decision, never a silent flag flip |
| A9 | One work item = one GSD phase (or one external ticket) on one enrolled repo. One run = one launched session + one dispatched turn on branch `corch/<work_item_id>`. Run end = that turn finalizes or the session dies. | PANEL-VERDICT F5 branch convention | 01 |
| A10 | PR existence at run end is read by the worker's own supervisor (`gh` with the worker's git credential), so the hub holds no GitHub write credential. | F4 "token never transits the hub" applied to git credentials | 09 |
| A11 | AAF maps its worker seat to a feed account through env `QUOTA_FEED_ACCOUNT_ID` (owner config). | RESEARCH-aaf.md 4.3 "Account identity" open question | 07 |
| A12 | PTYCAP primitives CORCH reuses are on `origin/main`: verified this session `automation_inject_ledger` (schema.sql:1655), `automation_kill_switch` (:1674), `governedLaunch` (`hub/src/dispatch/governed-launch.ts:96`, HEAL policy = gates + reservation before spawn, :10-18), `haltBeforeMachineSend` (`automation-controls.ts:171`), `fenceUntrusted` (`untrusted.ts:41`), `runIntake` (`webhooks/intake.ts:175`), `hasExplicitScope` (`auth/scopes.ts:89`), `reserveSessionSlot` (`sessions/budget.ts:79`), `fanOutNotify` (`orchestrator/notify.ts:160`); guard tests present in `hub/test/`. The PTYCAP-04 "2 open HIGH races" (PANEL-A) are re-verified in CORCH-01 research. | Grep + dir listing this session | 01 |

## Requirements (REQ-IDs)

Every requirement is testable and maps to exactly ONE phase (traceability table at the end). A
requirement introduced by an early phase that is enforced by a CI guard (schema double-apply,
token-cap coverage, kill-switch coverage, counter-key allowlist, mount order, no-polling, no-token)
binds every later phase automatically through that guard.

### R1 - Cross-repo priority backlog + dispatcher

- **CORCH-R1.1 (additive schema):** tables `corch_projects`, `corch_work_items`, `corch_runs` and column
  `users.corch_max_concurrent_runs` are added to `hub/src/db/schema.sql` with idempotent additive DDL only
  (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_object`
  for constraints). No DROP, no type change of an existing column, no inline backfill; any backfill is a
  one-shot `hub/scripts/corch-*.ts`. Test: `bun run schema-lint`, `bun run migration-verify`,
  `hub/test/e2e/schema-double-apply.e2e.test.ts` green. Every later phase adding DDL re-runs the same three.
- **CORCH-R1.2 (flag default OFF):** `REMO_CORCH_ENABLED` defaults OFF; truthy only for `1|true|yes|on`; read at
  call time. OFF = no dispatcher evaluation, no reconciler, no `not_before` timer, no launch, no supervisor
  frame, no outbound HTTP; the CORCH routes only store and list rows. Test: `hub/test/corch-flag-off.test.ts`
  asserts zero launch/send/timer calls with items queued.
- **CORCH-R1.3 (boot mutual exclusion):** the hub refuses to boot when `REMO_CORCH_ENABLED` and
  `REMO_ORCHESTRATOR_ENABLED` are both truthy (assertion in `hub/src/index.ts` beside `assertTokenCapConfig`).
  The old orchestrator is untouched until CORCH-13. Test: boot-assert unit test over all four combinations.
- **CORCH-R1.4 (enrollment = allowlist, owner priority):** cookie-only routes `GET/POST /api/corch/projects`,
  `PATCH /api/corch/projects/:id` enroll a repo by canonical lowercased `github://owner/name` (`path://` => 400)
  with `priority` (default 0), `daily_token_budget` (default 2000000, CHECK > 0), `enabled` (default true),
  `accept_external` (default false). The enrollment table IS the dispatch allowlist and is empty by default.
  An API key reaching these routes gets 403. Test: route tests.
- **CORCH-R1.5 (idempotent enqueue):** one function `enqueueWorkItem` behind two routes: cookie
  `POST /api/corch/work-items` (source `manual`) and `POST /api/ext/corch/work-items`, EXPLICIT-only scope
  `ext:corch` (`hasExplicitScope`; NULL/legacy keys refused), sources `aaf|memlog|manual`. Idempotent on
  `(user_id, source, source_ref)` (unique index; a repeat returns the existing row). External enqueue for a
  project not enrolled, disabled, or `accept_external=false` => 403 before any row is written. Test.
- **CORCH-R1.6 (deterministic selection):** a candidate is a `queued` item whose `not_before` is NULL or past, on
  an enrolled, enabled project with no live run and no `pr_open` item; order `project.priority DESC,
  item.priority DESC, created_at ASC, id ASC`. Test: ordering unit test.
- **CORCH-R1.7 (concurrency cap):** live CORCH runs per user <= `users.corch_max_concurrent_runs` (default 1,
  CHECK > 0), enforced atomically in the claim transaction (per-user advisory lock), in addition to, never
  instead of, `reserveSessionSlot`. Test: real-Postgres race, cap 1, two evaluations => exactly one run.
- **CORCH-R1.8 (per-project daily token budget):** SUM of all four buckets (`input + output + cache_creation +
  cache_read`) in `token_usage` for that project's CORCH sessions, in the user's tz-day, must be below
  `daily_token_budget`; otherwise the item waits `wait_reason='project_budget'`, `not_before` = next local
  midnight, attempt not consumed. Test: cache-read-only usage trips it.
- **CORCH-R1.9 (gate chain):** every CORCH dispatch goes through shared `dispatch()` with gate list
  `[automationKillSwitchGate, dailyCostCapGate, dailyTokenCapGate, corchProjectBudgetGate, corchConcurrencyGate,
  corchQuotaGate, sessionInjectRateGate, automationLifetimeCounterGate]` (kill switch FIRST, cost + token caps
  present). The same list is the `preLaunch.checkGates` of `governedLaunch`'s HEAL policy, so it runs before
  the spawn. Test: `token-cap-coverage` and `kill-switch-coverage` scan the new list and stay green.
- **CORCH-R1.10 (server-assigned counter key):** new key kind `corch:<work_item_id>` built only by
  `buildCorchKey()` in `hub/src/corch/`, never from request input; `hub/test/counter-key-assignment-guard.test.ts`
  allowlist gains exactly this kind. Test: guard green; a request-body `counter_key` is ignored.
- **CORCH-R1.11 (launch through the governed door):** launch only via `governedLaunch` with the HEAL policy
  (governor supplied: gates + lifetime reservation BEFORE the spawn, released on refusal/failure),
  `armed` = CORCH flag, `isRepoAutospawnAllowed` injected as the CORCH enrollment check (never the orchestrator
  allowlist), `launchSessionForUser({machine:true, skipPermissions:false})`. The CORCH caller is added to
  `launch-callers-guard`, `launch-machine-guard`, `session-start-senders-guard`, `reserve-caller-guard` and
  `kill-switch-coverage`; any machine frame CORCH emits outside `deps.send` calls `haltBeforeMachineSend` first.
  The workspace step (the worktree path + `sessions` row to launch) is an injected dependency whose CORCH-01
  default refuses `workspace_unavailable` (item waits, not consumed); CORCH-09 supplies the real one. Test.
- **CORCH-R1.12 (untrusted fencing, propose-only):** the prompt is a server-owned template
  (`hub/src/corch/prompt.ts`) + `SCOPE_CONTRACT`; every work-item string (title, body, source_ref, any
  gsd-console / AAF / memlog text) appears only inside `fenceUntrusted`. The template instructs: work on branch
  `corch/<work_item_id>` in the given worktree, open a PR, never merge, never push to the default branch,
  never deploy. Test: a payload containing a fence-closing sequence plus "merge to main" stays fenced; the
  template contains no merge/deploy instruction.
- **CORCH-R1.13 (quota provider fails closed by default):** `corchQuotaGate` asks a `QuotaProvider` for
  `{account_slot, supervisor_id}` or a refusal. CORCH-01 ships the default provider that refuses every item
  `quota_no_snapshot`, so this phase alone can never dispatch in prod. Test: item stays `queued`, attempts unchanged.
- **CORCH-R1.14 (gsd-console stream ingestion):** with `REMO_CORCH_ENABLED` ON and `REMO_CORCH_GSDC_URL` +
  `REMO_CORCH_GSDC_TOKEN` (`gsdc_`, scope `board:read`) set, the hub consumes `GET /api/board/stream`; on
  `snapshot` and `project` events it re-reads `GET /api/board/projects/{id}` for ENROLLED projects only (join:
  console slug `owner/name` == hub `github://owner/name`). Stream end (10-minute lifetime) => reconnect + fresh
  snapshot; errors => reconnect with bounded exponential backoff (cap 5 min). No timer polling of the board.
  Test: fake SSE server.
- **CORCH-R1.15 (candidate derivation):** per enrolled project, candidate = the `current` phase, else the
  lowest-numbered `pending` phase; `backlog` (999.x) ignored; project skipped while `active_runs > 0`, `stale`
  or `divergent`. Upsert as source `gsd_console`, `source_ref = <owner/name>:<milestone>:<phase>`; a queued
  `gsd_console` item whose phase is now `done` is cancelled. Mirrored text is stored as data (fenced per R1.12).
  No supervisor `.planning/` reads. Test: table-driven fixtures of board JSON.
- **CORCH-R1.16 (gsd-console fails closed):** unreachable, 5xx, 401/402/403, `stream-error`, or token unset =>
  no new candidates and no cancellations from that source; already-queued items unaffected; one owner
  notification per outage (`fanOutNotify`), one 7d ticket per error signature; no fallback source. Test: each
  failure mode yields zero upserts.

### R2 - Single quota feed (CUG -> hub -> CORCH + AAF), fail closed

- **CORCH-R2.1 (publish endpoint):** `POST /api/quota/snapshot`, api key with EXPLICIT-only scope
  `quota:publish` (NULL/legacy keys refused; a `quota:publish` key reaches no other route). Body = CUG
  usage-snapshot v1 minus `email`/`label`, validated by a `.strict()` Zod schema (any unknown key, including
  `email`, `label` or a token-like field => 400, nothing stored). Upsert latest per `(user_id, account_id)`
  into `corch_quota_accounts` with hub `received_at`. Test.
- **CORCH-R2.2 (read endpoint):** `GET /api/quota/snapshot`, EXPLICIT-only `quota:read`; returns per account the
  server-computed `eligible`, `reason`, `not_before` plus raw percentages; no secrets. One eligibility function
  serves CORCH and AAF. Test.
- **CORCH-R2.3 (fail-closed eligibility, CUG only):** latest snapshot received > 600s ago => every account
  ineligible; account `fetched_at` > 900s => ineligible; `source != 'live'` => ineligible; CUG `blocked` or
  `enabled=false` => ineligible; `seven_d_pct` null => ineligible; `max(five_h_pct, seven_d_pct) >=
  REMO_CORCH_QUOTA_CEILING_PCT` (default 55; non-numeric, <= 0 or > 100 refuses boot when CORCH is enabled)
  => ineligible until that window resets; hub `blocked_until` in the future => ineligible. No snapshot rows =>
  nothing eligible. `thresholdGate` and the supervisor oauth-poll store are never consulted. Test: table-driven.
- **CORCH-R2.4 (null 5h = unknown):** `five_h_pct` null is unknown, never 0: eligible only when 7d is known and
  below the ceiling, and then at most 1 live CORCH run on that account. Test.
- **CORCH-R2.5 (quota death blocks the account):** a run whose session ends on a rate-limit/quota error sets the
  account `blocked_until` to the reset time carried by the error, else the account's latest `resets_*`; with no
  known reset the block clears only on a snapshot whose `fetched_at` is later than the block. The item is
  requeued with `not_before = blocked_until`, attempt not consumed. Which frame carries the signal is verified in
  CORCH-02 research. Test.
- **CORCH-R2.6 (no eligible account = wait, not consumed):** the item stays `queued`,
  `wait_reason='quota:<reason>'`, `not_before` = earliest eligible time when known; attempts unchanged. Each
  snapshot POST triggers one dispatch evaluation (event, not timer). Test.
- **CORCH-R2.7 (per-dispatch account choice):** the hub accepts optional `account_slot` on `supervisor.hello`
  (additive Zod field; absent = never a CORCH target). The real `QuotaProvider` (replacing CORCH-01's default)
  picks among eligible accounts that have an online slot supervisor with a free slot, lowest `max(5h,7d)` first,
  tie-break `account_id`. Test.
- **CORCH-R2.8 (CUG publisher):** new `src-tauri/src/hub_publish.rs`, invoked once after the successful snapshot
  write in `project_cached_usage` (`account_commands.rs:1976-1985`), POSTs the same snapshot to
  `<hub_publish_url>/api/quota/snapshot`. `hub_publish_url` unset (default) => no network call. Credential via
  Proton Pass (`pass_cli.rs`) or sealed with `crypto::encrypt_secret`, never plain `config.json`. Single-flight,
  timeout <= 10s, never blocks or fails the poll, no retry queue (the next cycle is the retry). Shipped through
  CUG's signed release flow. Test: unit test with the existing injection seam (`account_commands.rs:1992`).
- **CORCH-R2.9 (CUG payload allow-list):** the serialized payload holds only `schema, publisher, generated_at,
  poll_interval_secs, accounts[{account_id, slot, five_h_pct, seven_d_pct, resets_5h, resets_7d, fetched_at,
  source, enabled, blocked, current}]`; no `email`, `label`, token or credential field. Test: serialize a fixture
  with email/label populated and assert the exact key set.
- **CORCH-R2.10 (AAF reads the feed at claim time):** new `src/worker/quotaFeed.ts`, called beside
  `fixClaimsPausedUntil()` (`src/worker/agentRunner.ts:2207-2217`). Env `QUOTA_FEED_URL`, `QUOTA_FEED_TOKEN`
  (hub `quota:read` key), `QUOTA_FEED_ACCOUNT_ID`; any unset => no behavior change. Set: account ineligible =>
  `pauseFixClaimsUntil(not_before)`; feed unreachable, non-2xx, account missing, or stale => skip fix claims this
  pass (`fixPassReason='quota_feed_unavailable'`, fail closed), one log line per window, one 7d ticket per
  signature. At most one GET per 30s (result reused inside the window); no new timer; no Claude token is ever
  sent to the hub. Test: vitest unit per branch.

### R3 - No dropped work (idempotent, re-queued, reclaimed)

- **CORCH-R3.1 (one live run per item):** partial unique index `corch_runs(work_item_id) WHERE ended_at IS NULL`;
  concurrent claims produce exactly one live row. Test: real-Postgres race.
- **CORCH-R3.2 (one live run per project):** partial unique index `corch_runs(project_id) WHERE ended_at IS NULL`;
  selection skips a project with a `pr_open` item. Test.
- **CORCH-R3.3 (heartbeat + positive-knowledge reclaim):** `heartbeat_at` is refreshed from the existing
  supervisor `session_inventory` frames that list the run's session (no new poll). Reclaim ONLY on positive
  knowledge: the supervisor socket closed, or that supervisor's fresh inventory has lacked the session for longer
  than `REMO_CORCH_LEASE_MS` (default 120000). No fresh inventory = unknown = never reclaimed; such a run is
  marked `stalled` once and the owner notified once. Test.
- **CORCH-R3.4 (requeue on death, bounded):** reclaim, launch failure, session death, or run end without a PR =>
  run ended with `end_reason`; item -> `queued`, `attempts + 1`, `not_before = now + 60s * 5^(attempts-1)`;
  `attempts >= max_attempts` (default 3) => `blocked` + one owner notification. Test.
- **CORCH-R3.5 (refusals never burn work):** kill switch, cost/token cap, project budget, concurrency, quota,
  inject-rate and lifetime refusals leave the item `queued` with `wait_reason` (and `not_before` when known),
  attempts unchanged; a halt detected after the claim ends the run `automation_halted` and requeues without an
  attempt. Test: one case per refusal.
- **CORCH-R3.6 (event-driven, one bounded reconciler):** dispatch evaluation is triggered by enqueue, run end,
  kill-switch release, supervisor hello/close, quota snapshot POST (02), gsd-console event (04), AAF event (08),
  and ONE timer re-armed at the earliest `not_before` (never a fixed interval). The only interval in
  `hub/src/corch/` is the reconciler (`REMO_CORCH_RECONCILE_INTERVAL_MS`, default 60000, at most 100 runs per pass)
  that applies R3.3. Guard `hub/test/corch-no-polling-guard.test.ts` fails on any other `setInterval` there.
- **CORCH-R3.7 (restart safe):** all queue state lives in Postgres; after a hub restart no item is
  double-launched and live runs are reclaimed only per R3.3 after the supervisor's first fresh inventory.
  Test: real-Postgres restart e2e.
- **CORCH-R3.8 (memlog claim per item):** before `corch.worktree_ensure` the hub takes a memlog claim
  `{repo, session: corch:<work_item_id>, branch: corch/<work_item_id>, worktree, scope}`, heartbeats it from the run
  heartbeat and releases it on done/blocked/cancelled. A conflicting live claim on that branch/worktree => item
  waits `memlog_conflict`; memlog unreachable => item waits `memlog_unavailable` + one 7d ticket (no dispatch
  without a claim). Test with a fake memlog client; transport verified in phase research (A7).

### R4 - Server-side Linux worker (one container per account slot)

- **CORCH-R4.1 (slot advertisement):** the supervisor sends `account_slot` (CUG `account_id`) in
  `supervisor.hello` only when env `REMO_ACCOUNT_SLOT` is set; without it (every desktop MSI) it is never a CORCH
  target. Test.
- **CORCH-R4.2 (per-slot spawn env, OAuth only):** the stream-json automation runner (`claude-runner.ts`) passes
  the process's `CLAUDE_CODE_OAUTH_TOKEN` and per-slot `CLAUDE_CONFIG_DIR` (from `REMO_SLOT_CLAUDE_CONFIG_DIR`)
  through `sanitizeSpawnEnv` only when `REMO_ACCOUNT_SLOT` is set; `ANTHROPIC_API_KEY` stays scrubbed; the human
  PTY path is unchanged and `no-setup-token-on-interactive`, `no-api-key-no-streamjson-pty`,
  `no-apikey-fallback-guard` stay green. Test.
- **CORCH-R4.3 (no token in hub, no API key):** no hub source, schema, log line, WS frame or API response carries
  `CLAUDE_CODE_OAUTH_TOKEN` or any token value; supervisor frames never include env. No CORCH code reads
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` except to delete it. Guard `hub/test/corch-no-token-guard.test.ts`
  (scan of `hub/src` + `schema.sql`) + supervisor frame test.
- **CORCH-R4.4 (worktree commands):** allowlisted `corch.worktree_ensure {repo_ident, work_item_id}`: ensure the
  canonical clone `<root>/<owner>/<name>` (https clone with the worker git credential when absent), then
  `git worktree add <root>/corch/<name>-<work_item_id> -b corch/<work_item_id> origin/<default-branch>`;
  idempotent (an existing worktree on that branch is reused); path passes `assertWithinRoots`; reply `{path}`.
  `corch.worktree_remove` on done/cancelled (kept on blocked for inspection). The hub sends each only after
  `haltBeforeMachineSend`, then creates or reuses the `sessions` row for the path (hostname = the slot
  supervisor) and launches per R1.11. Test.
- **CORCH-R4.5 (PR lookup at run end):** the hub sends allowlisted `corch.pr_lookup {path}`; the supervisor runs
  `gh pr list --head corch/<work_item_id> --state open` with the worker credential; an open same-repo PR =>
  item `pr_open` + `pr_url`; none => R3.4. The reply carries no credential. Test.
- **CORCH-R4.6 (per-slot image):** a headless supervisor image from the cloud-session Bun source path (no Tauri,
  no ConPTY), non-root, one container per slot, env `REMO_HUB_URL`, `REMO_API_KEY` (own `purpose='host'` key),
  `REMO_ACCOUNT_SLOT`, exactly one `CLAUDE_CODE_OAUTH_TOKEN` (Coolify runtime secret),
  `REMO_SLOT_CLAUDE_CONFIG_DIR`, git credential env; per-slot `settings.json` permission allowlist (A8). Builds
  in a Woodpecker linux/amd64 pipeline; `docker run` with a dummy token registers against a local hub and
  advertises its slot.
- **CORCH-R4.7 (Coolify runbook):** `docs/corch-linux-slots.md`: one Coolify app per slot, secrets as runtime
  env only, volumes, update path, registration check. Not deployed with real tokens in the phase.

### R5 - PR hand-off and closure with AAF

- **CORCH-R5.1 (AAF provision API):** `POST /api/projects/provision`, scope `projects:write`, org owner/admin,
  installation must belong to the caller's org; wraps existing `provisionReposCoreWith`
  (`src/lib/server/provisioning/provisionReposCore.ts:242`) for `{repo_slugs[], installation_id}`; idempotent;
  returns project ids. Webhook-driven auto-provision stays forbidden (TEN-05). Test: unit + db test
  (idempotency, cross-org refusal).
- **CORCH-R5.2 (red-CI adoption by convention):** a failing PR check (`status` or `check_run`) on a PR with head
  ref `corch/*`, head repo == base repo, author in `CORCH_TRUSTED_PR_AUTHORS` (default empty => off), on a
  provisioned project (no `plugin_apps` row required) idempotently creates the defect record the follow-up path
  needs and calls `enqueuePrFollowupInTransaction` kind `ci`, bounded by the existing `CI_FAILURE_RESUME_MAX` +
  escalation. Every other PR context keeps `pr_context_unsupported` (`ciFailureClassify.ts:64-68`). No GitHub
  identity is hardcoded. Test.
- **CORCH-R5.3 (AAF event outbox):** migration (next free number, checked against `origin/main` + open PRs)
  creating `orchestrator_event_outbox` (RLS per the 0067 pattern, `unique(event, repo_slug, pr_number,
  occurrence_key)`); events `pr.merged`, `pr.closed` (unmerged), `pr.failed` (fix ladder exhausted/escalated)
  only for head refs `corch/*`, enqueued in the same transaction as the triggering handler (closed branch at
  `src/routes/api/webhooks/github/+server.ts:872-888`; escalation site), drained from the existing reconcile tick
  (no new timer). `CORCH_EVENT_URL` / `CORCH_EVENT_SECRET` unset => nothing enqueued. Test.
- **CORCH-R5.4 (AAF signed delivery, one signer):** via `signedPost`, extended additively with a timestamped mode:
  `X-ZeroExposure-Timestamp: <unix seconds>`, `X-ZeroExposure-Signature: sha256=<hex HMAC-SHA256(secret,
  ts + "." + rawBody)>`, `X-ZeroExposure-Event-Id` stable across retries; body `{event_id, event, repo, pr_number,
  head_ref, merged_sha?, occurred_at}`; transport `pinnedRequest` + `vetOutboundUrl` (https:443). Test: a
  signature vector shared with the hub receiver test.
- **CORCH-R5.5 (hub receiver):** `POST /api/corch-events/aaf` via `runIntake`: raw body before JSON parse,
  constant-time HMAC over `${ts}.${rawBody}`, reject > 5 min skew, dedupe on `event_id` (`corch_events` unique),
  non-leaky errors; mounted BEFORE the `/api/*` auth catch-all and pinned in `hub/test/mount-order.test.ts`;
  `REMO_CORCH_AAF_EVENT_SECRET` unset => 503, nothing recorded. Test: good, bad sig, skew, replay, duplicate.
- **CORCH-R5.6 (closure transitions):** item resolved by repo + head ref `corch/<work_item_id>`: `pr.merged` =>
  `done`; `pr.closed` unmerged => `blocked`, never auto-requeued; `pr.failed` => `blocked` + one owner notification;
  unknown or terminal item => 200, audited, no change. Each transition triggers one dispatch evaluation. Test.
- **CORCH-R5.7 (provision on enrollment):** enrolling or re-enabling a project calls AAF provision (env
  `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN` with `projects:write`); result on `corch_projects`
  (`aaf_project_id`, `aaf_provision_status`); not provisioned (failed or env unset) => project not dispatchable
  (`aaf_unprovisioned`, fail closed). Earlier enrollments: one-shot `hub/scripts/corch-provision-existing.ts`. Test.

### R6 - Status, remote control, retirement

- **CORCH-R6.1 (status view):** cookie `GET /api/corch/queue` returns projects, items (status, wait_reason,
  not_before, attempts, pr_url), live runs (account_slot, supervisor, age, heartbeat) and quota accounts
  (eligible, reason); a web panel renders it, updated by `broadcastToUser` on every transition (no client
  polling); blue accent (`web/test/no-indigo.test.ts` green). Test.
- **CORCH-R6.2 (remote pause):** `users.corch_paused` (default false) and `corch_max_concurrent_runs` set via
  cookie `PATCH /api/corch/settings`; paused => no new dispatch, live runs continue; distinct from the kill
  switch; resume triggers one evaluation. Test.
- **CORCH-R6.3 (remote priority + cancel):** PATCH project and item priority; cancel only `queued` items
  (`cancelled`, terminal); web controls for both. Test.
- **CORCH-R6.4 (Telegram /queue):** read-only summary (paused flag, live runs, top 5 queued with wait reasons,
  blocked count); added to `BOT_COMMANDS` (`telegram/commands.ts:77-83`) and the webhook switch in lockstep; a
  human surface, not kill-switch gated. Test.
- **CORCH-R6.5 (CI end-to-end):** real-Postgres `hub/test/e2e/corch-*.e2e.test.ts` drives enqueue -> quota POST
  -> claim -> fake slot supervisor hello -> worktree_ensure -> launch -> turn end -> pr_lookup -> signed AAF
  `pr.merged` -> `done`, plus death-requeue, quota-wait and `pr.closed` -> `blocked`; runs in `.woodpecker/qc.yaml`.
- **CORCH-R6.6 (live proof + enable runbook):** on a throwaway repo with one slot container and one enrolled
  project, one item yields a real PR on `corch/<id>`, AAF merges it, and the hub records `done` from the signed
  event; evidence (item id, run row, PR url, event id) in the phase `VERIFICATION.md`;
  `docs/corch-enable-runbook.md` lists the exact flag/secret/key steps. Runs only after the owner-gated cutover
  items it needs.
- **CORCH-R6.7 (retire overlapping flag-OFF code):** delete the macro orchestrator cycle path (tick, queue drain
  registration, `runMacroCycle`), `orchestrator/merge-command.ts`, the PR wave-runner library (`wave-runner.ts`,
  `waves.ts`) and heal code whose remit AAF now owns (exact keep/delete table written in phase research).
  Precondition: prod `REMO_ORCHESTRATOR_ENABLED` verified OFF live. Guards that pinned deleted code are updated;
  no DROP TABLE/COLUMN (tables stay, documented dormant); Revanote merge/CI gate untouched. Test: suite green,
  guards green.

## Future requirements (deferred)

- `pr.opened` AAF event (run-end `pr_lookup` covers it in v1).
- More than one live run per project; cross-repo dependency ordering.
- Desktop supervisors as CORCH targets (needs a known account per host).
- Auto-enrollment of every gsd-console project.
- Telegram pause/priority commands (web covers remote control in v1).
- AAF claude-pool broker as a quota consumer of the feed.

## Out of scope

- Fixing the AAF stuck queue (memlog request `1794608544123-0`, owned by agentautofix).
- Uptime Kuma; rebuilding CI.
- Hub-side merge or CI watching (AAF owns everything after a PR exists).
- A single container holding all account tokens (rejected, F4).
- Direct `.planning/` reads by the hub or supervisor (gsd-console is the only backlog read source).
- Changing AAF trusted-PR auto-merge skipping review on green CI (exposure noted by seat C, logged, unchanged).
- Revanote `ci-gate.ts` / `merge-gate.ts` (live product path).
- Any API-key transport; any change to the human PTY no-API-key invariant.

## Traceability

| Requirement | Phase | Status |
|---|---|---|
| CORCH-R1.1 .. CORCH-R1.13 | CORCH-01 | Pending |
| CORCH-R3.1 .. CORCH-R3.7 | CORCH-01 | Pending |
| CORCH-R2.1 .. CORCH-R2.7 | CORCH-02 | Pending |
| CORCH-R2.8, CORCH-R2.9 | CORCH-03 | Pending |
| CORCH-R1.14 .. CORCH-R1.16 | CORCH-04 | Pending |
| CORCH-R5.1, CORCH-R5.2 | CORCH-05 | Pending |
| CORCH-R5.3, CORCH-R5.4 | CORCH-06 | Pending |
| CORCH-R2.10 | CORCH-07 | Pending |
| CORCH-R5.5 .. CORCH-R5.7 | CORCH-08 | Pending |
| CORCH-R3.8, CORCH-R4.1 .. CORCH-R4.5 | CORCH-09 | Pending |
| CORCH-R4.6, CORCH-R4.7 | CORCH-10 | Pending |
| CORCH-R6.1 .. CORCH-R6.4 | CORCH-11 | Pending |
| CORCH-R6.5, CORCH-R6.6 | CORCH-12 | Pending |
| CORCH-R6.7 | CORCH-13 | Pending |

Total 55 requirements (R1 16, R2 10, R3 8, R4 7, R5 7, R6 7), each mapped to exactly one phase.
