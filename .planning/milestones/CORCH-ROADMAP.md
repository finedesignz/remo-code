<!-- updated: 2026-11-13 -->
# Milestone CORCH - Central Orchestrator - ROADMAP

**Requirements:** [CORCH-REQUIREMENTS.md](CORCH-REQUIREMENTS.md) (55 REQs, each mapped once; coverage table at the end).
**Phase dirs:** `.planning/phases/CORCH-NN-<slug>/` in remo-code for EVERY phase (paired-repo phases keep their
planning artifacts here; their code PR lives in the owning repo).
**Architecture:** LOCKED by panel 2026-11-13 (`.planning/phases/CORCH-00-research/PANEL-VERDICT.md`). Phase order
below is the panel's F6 order and is binding: one phase = one PR in one repo.
**Status:** SCOPED. PTYCAP owns `.planning/ROADMAP.md` / `STATE.md` / `REQUIREMENTS.md`; CORCH does not edit them.

## Phases

- [ ] **CORCH-01** backlog-dispatcher-core (remo-code hub) - queue tables, enqueue/enroll API, gate chain, claim/heartbeat/reclaim, requeue, flag OFF + boot mutual exclusion, fail-closed quota provider
- [ ] **CORCH-02** quota-ingest-account-selection (remo-code hub) - `POST/GET /api/quota/snapshot`, fail-closed eligibility, per-dispatch account choice
- [ ] **CORCH-03** cug-hub-publisher (claude-usage-guard) - `hub_publish.rs` posts the snapshot (no email/label), default off
- [ ] **CORCH-04** gsd-console-ingestion (remo-code hub) - SSE-triggered board reads become queued phase items, fail closed
- [ ] **CORCH-05** aaf-provision-adoption (agentautofix) - `POST /api/projects/provision` + red-CI adoption of `corch/*` PRs by convention
- [ ] **CORCH-06** aaf-event-outbox (agentautofix) - outbox + timestamped `signedPost` for `pr.merged|pr.closed|pr.failed`
- [ ] **CORCH-07** aaf-quota-feed (agentautofix) - fixer reads the hub quota feed at claim time, fail closed
- [ ] **CORCH-08** aaf-event-receiver-closure (remo-code hub) - HMAC receiver, closure transitions, provision on enrollment
- [ ] **CORCH-09** slot-injection-worktree (remo-code hub + supervisor) - account slot advert, per-slot OAuth env, worktree/PR-lookup commands, memlog claim
- [ ] **CORCH-10** linux-slot-image (remo-code) - headless per-slot supervisor image + Coolify runbook (no real tokens)
- [ ] **CORCH-11** status-pause-priority (remo-code hub + web + Telegram) - queue view, remote pause/priority/cancel, `/queue`
- [ ] **CORCH-12** e2e-proof-enable-runbook (remo-code) - CI e2e of the full state machine + live throwaway-repo proof
- [ ] **CORCH-13** retire-overlap (remo-code) - delete the flag-OFF macro orchestrator path, merge-command, wave-runner, AAF-owned heal duplication

## Sequencing and ship path

| Phase | Repo | Ships via | Prod effect on merge |
|---|---|---|---|
| 01, 02, 04, 08, 11 | remo-code hub (+ web for 11) | Coolify hub deploy | None while `REMO_CORCH_ENABLED` is OFF (routes store/list only) |
| 09 | remo-code hub + supervisor source | Coolify hub deploy; supervisor code runs from Bun source in the 10 image | None: desktop MSIs never set `REMO_ACCOUNT_SLOT` |
| 10 | remo-code (Dockerfile + Woodpecker pipeline + docs) | Image build only | None: no container deployed with real tokens |
| 12 | remo-code (tests + docs) | CI; live proof after owner cutover items | Live proof on a throwaway repo only |
| 13 | remo-code hub | Coolify hub deploy | Deletes flag-OFF code only (precondition verified live) |
| 03 | claude-usage-guard | Signed release (Azure Trusted Signing during bundling) | None until `hub_publish_url` is configured |
| 05, 06, 07 | agentautofix | AAF Coolify deploy | None until the AAF env in the cutover list is set |

**Hard ordering constraints**

1. CORCH-01 lands first: every later remo-code phase extends `hub/src/corch/` and its tables.
2. CORCH-02 before CORCH-03 (CUG needs the endpoint) and before CORCH-07 (AAF needs `GET /api/quota/snapshot`).
3. CORCH-06 and CORCH-08 share one signature test vector (same fixture file content committed in both repos); 06 merges first.
4. CORCH-09 before CORCH-10 (the image runs the 09 supervisor code).
5. CORCH-12's live proof runs only after cutover items 1-9 below; its CI e2e part does not wait.
6. CORCH-13 runs only after CORCH-12 PASS and a live check that prod `REMO_ORCHESTRATOR_ENABLED` is OFF.

## Milestone-wide invariants (every phase inherits; enforced by guards, not by review)

- Flags default OFF; enabling a flag is a cutover item, never part of a phase.
- Additive DDL only in `hub/src/db/schema.sql` (re-runs every boot): `bun run schema-lint`, `bun run migration-verify`
  and `hub/test/e2e/schema-double-apply.e2e.test.ts` green on every phase that touches it; backfills only as
  one-shot `hub/scripts/corch-*.ts`; no DROP / TRUNCATE / type change. AAF migrations additive, number verified.
- No token in the hub (`corch-no-token-guard`, from 09) and no LLM API key anywhere (subscription OAuth only).
- Every machine gate list keeps kill switch FIRST plus `dailyCostCapGate` and `dailyTokenCapGate`
  (`token-cap-coverage`, `kill-switch-coverage`); lifetime counter keys are built by server code only
  (`counter-key-assignment-guard`).
- Webhook intake = raw body + constant-time HMAC + mounted before the auth catch-all (`mount-order`).
- All external text is fenced untrusted data (`fenceUntrusted`); prompts are server-owned templates.
- Event-driven: the only interval in `hub/src/corch/` is the bounded reconciler (`corch-no-polling-guard`).
- Each phase: research -> plan -> execute -> `/qc` -> PR -> independent verifier (`VERIFICATION.md`).

---

### CORCH-01 -- backlog-dispatcher-core (remo-code hub, Coolify; fully specified, executes first)

**Dir:** `.planning/phases/CORCH-01-backlog-dispatcher-core/`
**Goal:** The hub holds a durable cross-repo priority queue of work items and can claim, launch, watch,
reclaim and requeue them through the existing governed dispatch primitives, so that once a quota source and a
workspace exist (02, 09) a queued item becomes exactly one supervised session. In this phase it can never
launch in prod: the flag defaults OFF and the default quota provider and workspace step both refuse.
**Depends on:** nothing (PTYCAP primitives verified on `origin/main`, assumption A12).
**REQ-IDs:** CORCH-R1.1 .. CORCH-R1.13, CORCH-R3.1 .. CORCH-R3.7.
**Flags/env:** `REMO_CORCH_ENABLED` (default OFF), `REMO_CORCH_LEASE_MS` (default 120000),
`REMO_CORCH_RECONCILE_INTERVAL_MS` (default 60000).

**Research items (first plan task; each answered in `CORCH-01-RESEARCH.md` with file:line):**

1. PTYCAP-04 ledger "2 open HIGH races" (PANEL-A): stale or real on `origin/main`. Real => 7d ticket against
   remo-code and the plan states the exposure; CORCH idempotency does not depend on it (own partial unique indexes,
   R3.1/R3.2).
2. Heal caller sequencing: how the HEAL-policy `preLaunch.reserve` reservation and the first `dispatch()` through
   `automationLifetimeCounterGate` avoid a double count. CORCH copies that sequencing exactly.
3. Which existing signal marks "dispatched turn finalized" and "session died" for heal/triage callers; CORCH run
   end uses the same signal (no new frame).
4. Whether any guard requires `thresholdGate` on every machine gate list (A6). If yes, keep it in the CORCH list
   after `dailyTokenCapGate` (it can only refuse, never admit); CUG stays the admitting source.
5. Re-measure the check baseline (CI typecheck is informational; record the current error count, add none).

**Schema (additive, `hub/src/db/schema.sql`; exact types follow existing schema.sql conventions):**

| Table / column | Columns and constraints |
|---|---|
| `corch_projects` | `id` uuid pk, `user_id` fk users, `repo_ident` text (canonical `github://owner/name`, lowercased), `priority` int default 0, `daily_token_budget` bigint default 2000000 CHECK > 0, `enabled` bool default true, `accept_external` bool default false, `created_at`, `updated_at`; UNIQUE(`user_id`, `repo_ident`) |
| `corch_work_items` | `id` uuid pk, `user_id`, `project_id` fk, `source` text CHECK in (`manual`,`gsd_console`,`aaf`,`memlog`), `source_ref` text, `title`, `body`, `priority` int default 0, `status` text CHECK in (`queued`,`running`,`pr_open`,`done`,`blocked`,`cancelled`), `wait_reason` text null, `not_before` timestamptz null, `attempts` int default 0, `max_attempts` int default 3, `branch` text (= `corch/<id>`), `pr_url` text null, `created_at`, `updated_at`; UNIQUE(`user_id`, `source`, `source_ref`); index (`status`, `not_before`) |
| `corch_runs` | `id` uuid pk, `work_item_id` fk, `project_id` fk, `user_id`, `account_slot` text null, `supervisor_id` text null, `session_id` null, `worktree_path` text null, `counter_key` text, `status` text CHECK in (`launching`,`running`,`stalled`,`ended`), `end_reason` text null, `heartbeat_at`, `started_at`, `ended_at` null; partial UNIQUE(`work_item_id`) WHERE `ended_at IS NULL`; partial UNIQUE(`project_id`) WHERE `ended_at IS NULL` |
| `users.corch_max_concurrent_runs` | int default 1 CHECK > 0 (`ADD COLUMN IF NOT EXISTS`) |

**Module layout:** `hub/src/corch/` - `flag.ts` (`corchEnabled()` read at call time), `store.ts` (queries +
claim transaction), `keys.ts` (`buildCorchKey`), `gates.ts` (`corchProjectBudgetGate`, `corchConcurrencyGate`,
`corchQuotaGate`), `quota-provider.ts` (interface + default refusing provider), `prompt.ts` (server template),
`dispatcher.ts` (evaluate/claim/launch/run-end/requeue), `reconciler.ts` (the one interval), `routes.ts`.

**API routes:**

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/corch/projects`, `POST /api/corch/projects`, `PATCH /api/corch/projects/:id` | cookie only (API key => 403) | Enroll / list / update `priority`, `daily_token_budget`, `enabled`, `accept_external`; `path://` => 400 |
| `POST /api/corch/work-items`, `GET /api/corch/work-items` | cookie only | Enqueue source `manual` (idempotent on `source_ref`), list |
| `POST /api/ext/corch/work-items` | API key, EXPLICIT-only scope `ext:corch` via `hasExplicitScope` | Enqueue sources `aaf|memlog|manual`; unenrolled / disabled / `accept_external=false` project => 403, no row |

All three groups mount AFTER the `/api/*` auth middleware; `hub/test/mount-order.test.ts` pins that (the
pre-auth position is reserved for the CORCH-08 receiver). No other route in this phase.

**Gate chain (one list, two uses):** `[automationKillSwitchGate, dailyCostCapGate, dailyTokenCapGate,
corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate, sessionInjectRateGate,
automationLifetimeCounterGate]` - used as `preLaunch.checkGates` of `governedLaunch` (HEAL policy: gates +
lifetime reservation before the spawn, released on refusal/failure) and as the `dispatch()` gate list for the
prompt turn (grace-park + replay, `inject.ts:395-431`).

**Counter key:** kind `corch:<work_item_id>` from `buildCorchKey(workItemId)` only; request input never reaches it.

**Launch path:** `governedLaunch` (`dispatch/governed-launch.ts:96`) with `armed = corchEnabled()`,
`isRepoAutospawnAllowed` = CORCH enrollment check (`corch_projects.enabled`), never the orchestrator allowlist,
and `launchSessionForUser({ machine: true, skipPermissions: false })`. Injected dependencies with refusing
defaults: `QuotaProvider` (default refuses `quota_no_snapshot`), `Workspace` (default refuses
`workspace_unavailable`), `PrLookup` (real one in 09). `hub/src/corch/` never imports `launchSessionForUser`
directly.

**State machine:** `queued -> running` (claim txn: per-user advisory lock, cap check, insert `corch_runs`
`launching`) `-> pr_open` (09 lookup) `| queued` (death / launch failure / no PR: `attempts+1`, backoff
`60s * 5^(attempts-1)`) `| blocked` (attempts exhausted, one notification). Refusals keep `queued`, attempts
unchanged. `pr_open -> done | blocked` arrives in 08; `queued -> cancelled` in 04/11.

**Triggers:** enqueue, run end, kill-switch release, supervisor hello/close, and one timer re-armed at the
earliest `not_before`. Reconciler every `REMO_CORCH_RECONCILE_INTERVAL_MS`, max 100 runs per pass, applies R3.3
(reclaim only on positive knowledge; no inventory => `stalled` + one notification).

**Boot mutual exclusion:** `assertCorchConfig()` in `hub/src/index.ts` beside `assertTokenCapConfig`: both
`REMO_CORCH_ENABLED` and `REMO_ORCHESTRATOR_ENABLED` truthy => throw, hub does not start.

**Guards to update (each stays green; the diff shows the allowlist line added):**

| Guard | Change |
|---|---|
| `hub/test/counter-key-assignment-guard.test.ts` | allow kind `corch:` built only in `hub/src/corch/keys.ts` |
| `hub/test/token-cap-coverage.test.ts` | scans the CORCH gate list; cost + token caps present |
| `hub/test/kill-switch-coverage.test.ts` | CORCH list has `automationKillSwitchGate` at index 0 |
| `hub/test/launch-callers-guard.test.ts`, `launch-machine-guard.test.ts` | CORCH dispatcher added as a `governedLaunch` caller with `machine: true`, `skipPermissions: false`; no direct `launchSessionForUser` in `hub/src/corch/` |
| `hub/test/session-start-senders-guard.test.ts` | CORCH reaches session start only through `governedLaunch` |
| `hub/test/reserve-caller-guard.test.ts` | CORCH listed as a `reserveSessionSlot` caller via the governor |
| `hub/test/mount-order.test.ts` | `/api/corch/*` and `/api/ext/corch/*` behind auth |
| new `hub/test/corch-no-polling-guard.test.ts` | only `reconciler.ts` may call `setInterval` in `hub/src/corch/` |
| `hub/test/api-keys-scopes.test.ts` | `ext:corch` explicit-only; NULL/legacy key refused |

**Docs:** `docs/corch.md` (model, state machine, gates, env, what is NOT enabled yet); CLAUDE.md env section
gains `REMO_CORCH_ENABLED`, `REMO_CORCH_LEASE_MS`, `REMO_CORCH_RECONCILE_INTERVAL_MS`; `bun run docs:sync`.

**Success criteria (verifier runs these):**

1. `bun run schema-lint`, `bun run migration-verify` and `bun test hub/test/e2e/schema-double-apply.e2e.test.ts`
   exit 0; the schema.sql diff contains no `DROP`, `TRUNCATE` or `ALTER COLUMN ... TYPE`.
2. `bun test hub/test/corch-flag-off.test.ts` proves zero launch/send/timer calls with items queued and the flag
   OFF; the boot-assert test proves the hub refuses to start with both flags ON and starts in the other three
   combinations.
3. Route tests prove: cookie enroll/enqueue works; an API key on a cookie route gets 403; `ext:corch` with a
   NULL-scope key, an unenrolled project, or `accept_external=false` gets 403 with no row; a repeated enqueue
   returns the same item id.
4. Every guard in the table above plus `corch-no-polling-guard` passes; a unit test asserts the exact CORCH gate
   list order with the kill switch first.
5. `bun test hub/test/e2e/corch-dispatcher.e2e.test.ts` (real Postgres, fake provider/workspace/launcher) proves:
   two concurrent evaluations at cap 1 => one run; per-item and per-project uniqueness; death => requeue with
   backoff and `attempts+1`; third failure => `blocked` + exactly one notification; each refusal kind leaves
   attempts unchanged; restart => no double launch; with the DEFAULT provider the item stays `queued`
   `wait_reason='quota_no_snapshot'`.
6. A prompt test proves a hostile title/body (fence-closing sequence + "merge to main") stays inside the fence and
   the template has no merge/deploy instruction; `docs/corch.md` exists and `bun run docs:sync` leaves no diff.

**Not in this phase:** quota ingest or account choice (02); gsd-console (04); AAF anything; supervisor changes,
worktrees, PR lookup, memlog claim (09); UI/Telegram (11); any change to `thresholdGate`, `runMacroCycle`,
`routine_queue` or orchestrator rows; any automated producer for the `ext:corch` route.

---

### CORCH-02 -- quota-ingest-account-selection (remo-code hub, Coolify)

**Dir:** `.planning/phases/CORCH-02-quota-ingest-account-selection/`
**Goal:** The hub knows, from CUG data alone and fail-closed, which Claude account may take the next run, and the
dispatcher picks an eligible account with a free slot supervisor per dispatch.
**Depends on:** CORCH-01.
**REQ-IDs:** CORCH-R2.1 .. CORCH-R2.7.
**Flags/env:** `REMO_CORCH_QUOTA_CEILING_PCT` (default 55; invalid value refuses boot when CORCH is enabled).
New table `corch_quota_accounts` (PK `user_id, account_id`; snapshot fields, `received_at`, `blocked_until`).
Scopes `quota:publish`, `quota:read` (explicit-only). Research item: which frame carries a rate-limit death and
its reset time.

**Success criteria:**

1. Schema checks (invariants) pass; `api-keys-scopes` proves both scopes explicit-only and a `quota:publish` key
   reaches no other route.
2. A strict-schema test proves a body with `email`, `label` or any unknown key => 400 and no row.
3. A table-driven eligibility test covers 600s snapshot age, 900s account age, `source != live`, `blocked`,
   `enabled=false`, null 7d, ceiling, null 5h (eligible with 1-run cap) and `blocked_until`.
4. A selection test proves lowest `max(5h,7d)` wins, tie-break `account_id`, only accounts with an online slot
   supervisor with a free slot; a `supervisor.hello` without `account_slot` is never a target.
5. A quota-death test sets `blocked_until` and requeues without an attempt; a spy proves each snapshot POST triggers
   exactly one evaluation.

**Not in this phase:** the CUG publisher (03), the AAF reader (07), the supervisor sending `account_slot` (09), any
change to `thresholdGate` or the oauth-poll store.

### CORCH-03 -- cug-hub-publisher (claude-usage-guard, signed release)

**Dir:** `.planning/phases/CORCH-03-cug-hub-publisher/` (planning); code PR in claude-usage-guard.
**Goal:** CUG pushes its existing usage snapshot to the hub after each successful poll, without email or label,
without ever slowing or failing the poll, and does nothing until configured.
**Depends on:** CORCH-02.
**REQ-IDs:** CORCH-R2.8, CORCH-R2.9.
**Flags/config:** `hub_publish_url` unset by default; credential via Proton Pass or `crypto::encrypt_secret`.

**Success criteria:**

1. `cargo test` in `src-tauri` runs a payload test proving the exact allowed key set (fixture has email/label
   populated; neither appears).
2. A seam test (`account_commands.rs:1992`) proves: URL unset => zero network calls; set => exactly one POST per
   successful snapshot write; a failing or timing-out POST (timeout <= 10s) leaves the poll result and the local
   snapshot file unchanged; overlapping polls do not stack requests.
3. A test or grep proves the credential is never written to plain `config.json`.
4. CUG CI green; the release artifact is signed during bundling (`Get-AuthenticodeSignature` = Valid, signer
   Titanium Labs LLC).

**Not in this phase:** minting the hub key or configuring CUG (cutover), retries/queues, the hub endpoint.

### CORCH-04 -- gsd-console-ingestion (remo-code hub, Coolify)

**Dir:** `.planning/phases/CORCH-04-gsd-console-ingestion/`
**Goal:** The next GSD phase of every enrolled repo appears in the queue automatically, triggered by gsd-console
events, and disappears when gsd-console reports it done; any console failure adds nothing.
**Depends on:** CORCH-01.
**REQ-IDs:** CORCH-R1.14, CORCH-R1.15, CORCH-R1.16.
**Flags/env:** `REMO_CORCH_GSDC_URL`, `REMO_CORCH_GSDC_TOKEN` (unset => source off). Research item: re-verify the
board API and SSE event shapes against gsd-console `origin/main`.

**Success criteria:**

1. A fake-SSE test proves `snapshot`/`project` events re-read only enrolled projects; stream end reconnects and
   takes a fresh snapshot; error backoff is capped at 5 minutes; flag OFF opens no connection.
2. Table-driven derivation tests cover `current`, lowest `pending`, ignored `backlog`, skip on
   `active_runs`/`stale`/`divergent`, cancel-on-done, and idempotent upsert with
   `source_ref = owner/name:milestone:phase`.
3. Each failure mode (unreachable, 5xx, 401/402/403, `stream-error`, token unset) yields zero upserts and zero
   cancellations, one notification per outage, one 7d ticket per signature.
4. `corch-no-polling-guard` stays green; console text reaches the prompt only fenced.

**Not in this phase:** `.planning/` reads, minting the `gsdc_` token (browser-only cutover), auto-enrollment.

### CORCH-05 -- aaf-provision-adoption (agentautofix, AAF Coolify deploy)

**Dir:** `.planning/phases/CORCH-05-aaf-provision-adoption/` (planning); code PR in agentautofix.
**Goal:** The hub can make any enrolled repo an AAF project by API, and AAF owns red CI on trusted same-repo
`corch/*` PRs without a `plugin_apps` row.
**Depends on:** none in code (branch-name contract `corch/<work_item_id>` only).
**REQ-IDs:** CORCH-R5.1, CORCH-R5.2.
**Flags/env:** `CORCH_TRUSTED_PR_AUTHORS` (default empty => adoption off). Scope `projects:write`.

**Success criteria:**

1. vitest proves provision is idempotent, refuses a cross-org installation, requires `projects:write`, returns
   project ids; the TEN-05 no-webhook-auto-provision test stays green.
2. vitest proves a failing check on a `corch/*` same-repo PR by a trusted author on a provisioned project creates
   exactly one `ci` follow-up (redelivery idempotent, bounded by `CI_FAILURE_RESUME_MAX`); removing any one
   condition yields `pr_context_unsupported`; an empty allowlist changes nothing.
3. `pwsh scripts/preflight.ps1` exits 0; the diff hardcodes no GitHub login.

**Not in this phase:** outbox (06), quota feed (07), the AAF stuck queue, the trusted auto-merge review exposure.

### CORCH-06 -- aaf-event-outbox (agentautofix, AAF Coolify deploy)

**Dir:** `.planning/phases/CORCH-06-aaf-event-outbox/` (planning); code PR in agentautofix.
**Goal:** AAF tells the hub, reliably and verifiably, when a `corch/*` PR merged, closed unmerged, or exhausted its
fix ladder.
**Depends on:** CORCH-05 (branch convention and provisioned-project model).
**REQ-IDs:** CORCH-R5.3, CORCH-R5.4.
**Flags/env:** `CORCH_EVENT_URL`, `CORCH_EVENT_SECRET` (unset => nothing enqueued).

**Success criteria:**

1. The migration number is unique against `origin/main` and open PRs (check recorded in research); the migration
   applies on the test DB with RLS per the 0067 pattern.
2. vitest proves each of merged / closed-unmerged / escalated on a `corch/*` PR writes exactly one outbox row in
   the same transaction; a non-`corch/*` PR or unset env writes none; a duplicate webhook writes one row.
3. vitest proves delivery from the existing reconcile tick (no new timer in the diff), timestamped `signedPost`
   headers, a signature equal to the shared test vector, and `vetOutboundUrl` refusing non-https:443 targets.
4. `pwsh scripts/preflight.ps1` exits 0.

**Not in this phase:** the hub receiver (08), a `pr.opened` event.

### CORCH-07 -- aaf-quota-feed (agentautofix, AAF Coolify deploy)

**Dir:** `.planning/phases/CORCH-07-aaf-quota-feed/` (planning); code PR in agentautofix.
**Goal:** AAF's fixer stops claiming fix work when its Claude account is ineligible on the shared feed, and fails
closed when the feed is unknown. (Single-REQ phase kept: panel order binds one PR per repo concern.)
**Depends on:** CORCH-02.
**REQ-IDs:** CORCH-R2.10.
**Flags/env:** `QUOTA_FEED_URL`, `QUOTA_FEED_TOKEN`, `QUOTA_FEED_ACCOUNT_ID` (any unset => unchanged behavior).

**Success criteria:**

1. vitest covers each branch: env unset => no fetch; ineligible => `pauseFixClaimsUntil(not_before)`;
   unreachable / non-2xx / account missing / stale => fix claims skipped with `quota_feed_unavailable`, one log
   line per window.
2. A fake-clock test proves at most one GET per 30s and no new timer.
3. A request-capture test proves only the `quota:read` bearer is sent, no Claude token.
4. `pwsh scripts/preflight.ps1` exits 0.

**Not in this phase:** the claude-pool broker, key minting.

### CORCH-08 -- aaf-event-receiver-closure (remo-code hub, Coolify)

**Dir:** `.planning/phases/CORCH-08-aaf-event-receiver-closure/`
**Goal:** A merged PR closes its work item, a closed or failed PR blocks it, and only AAF-provisioned projects are
dispatchable.
**Depends on:** CORCH-01, CORCH-06.
**REQ-IDs:** CORCH-R5.5, CORCH-R5.6, CORCH-R5.7.
**Flags/env:** `REMO_CORCH_AAF_EVENT_SECRET` (unset => 503), `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN`. New
table `corch_events` (unique `event_id`); columns `corch_projects.aaf_project_id`, `aaf_provision_status`.

**Success criteria:**

1. Receiver tests: valid signature => 200 + transition; bad signature, >5 min skew => rejected, non-leaky body;
   replayed `event_id` => 200 with no second transition; secret unset => 503 and nothing recorded; the 06 shared
   vector verifies.
2. `mount-order` pins `/api/corch-events/aaf` before the auth catch-all.
3. Transition tests: merged => `done`; closed unmerged => `blocked` and still `blocked` after a reconciler pass;
   failed => `blocked` + one notification; unknown/terminal item => 200, audited, unchanged.
4. Provision tests: a fake AAF yields `provisioned`; failure or unset env => `aaf_unprovisioned` and not
   dispatchable; `hub/scripts/corch-provision-existing.ts` is idempotent on a second run.
5. Schema checks (invariants) pass.

**Not in this phase:** AAF code, `pr.opened`.

### CORCH-09 -- slot-injection-worktree (remo-code hub + supervisor, Coolify)

**Dir:** `.planning/phases/CORCH-09-slot-injection-worktree/`
**Goal:** A Linux slot supervisor can take a CORCH run end to end: advertise its account, spawn `claude` with its
own OAuth token, work in a per-item worktree on `corch/<id>`, report whether a PR exists, all under a memlog claim
and with no token ever reaching the hub.
**Depends on:** CORCH-01, CORCH-02 (ordered after 08 so the first real launch can only target a provisioned project).
**REQ-IDs:** CORCH-R3.8, CORCH-R4.1 .. CORCH-R4.5.
**Flags/env (supervisor):** `REMO_ACCOUNT_SLOT`, `REMO_SLOT_CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`. Research
items: hub->memlog transport (A7; none => 7e ticket to `mcp-servers`, phase BLOCKED-ON-MCP for R3.8 only);
whether `sanitizeSpawnEnv` currently scrubs `CLAUDE_CODE_OAUTH_TOKEN`; where the supervisor command allowlist lives.

**Success criteria:**

1. Supervisor tests: `account_slot` sent only with `REMO_ACCOUNT_SLOT`; spawn env carries the OAuth token and
   `CLAUDE_CONFIG_DIR` only with the slot set; `ANTHROPIC_API_KEY` scrubbed; `no-setup-token-on-interactive`,
   `no-api-key-no-streamjson-pty`, `no-apikey-fallback-guard` green.
2. `corch-no-token-guard` green; a frame test proves no env value leaves the supervisor.
3. Temp-git-repo tests: `corch.worktree_ensure` gives the deterministic path and branch off the default branch,
   reuses an existing worktree, refuses traversal via `assertWithinRoots`; remove runs on done/cancelled, not
   blocked; `haltBeforeMachineSend` precedes every `corch.*` frame (`kill-switch-coverage` green).
4. `corch.pr_lookup` with a fake `gh`: open same-repo PR => `pr_open` + `pr_url`; none => requeue per R3.4; the
   reply carries no credential.
5. Fake-memlog tests: claim before `worktree_ensure`, heartbeat, release on terminal states; conflict =>
   `memlog_conflict` wait; unreachable => `memlog_unavailable` + ticket; no dispatch without a claim.
6. An e2e with a fake slot supervisor drives claim -> worktree -> launch -> turn end -> lookup with the real
   (non-default) Workspace and PrLookup.

**Not in this phase:** the container image (10), real tokens, desktop supervisors as targets.

### CORCH-10 -- linux-slot-image (remo-code, image build only)

**Dir:** `.planning/phases/CORCH-10-linux-slot-image/`
**Goal:** One reproducible headless supervisor image per account slot exists and is documented, ready for the
owner to deploy with real tokens.
**Depends on:** CORCH-09.
**REQ-IDs:** CORCH-R4.6, CORCH-R4.7.

**Success criteria:**

1. The Woodpecker linux/amd64 pipeline builds the image on the PR.
2. `docker run` with a dummy token against a local hub registers and the hub sees `account_slot` in hello; the
   process runs non-root (`id -u` != 0); no Tauri/ConPTY binaries in the image.
3. `docker history` / `docker inspect` show no token in any layer or baked ENV.
4. `docs/corch-linux-slots.md` exists (one app per slot, runtime secrets only, volumes, update path, registration
   check); `bun run docs:sync` clean.

**Not in this phase:** deploying containers with real tokens (cutover item 8).

### CORCH-11 -- status-pause-priority (remo-code hub + web + Telegram, Coolify)

**Dir:** `.planning/phases/CORCH-11-status-pause-priority/`
**Goal:** The owner sees the queue live from anywhere and can pause, reprioritize or cancel without touching a
session.
**Depends on:** CORCH-01, CORCH-02, CORCH-09.
**REQ-IDs:** CORCH-R6.1 .. CORCH-R6.4.
**Flags/env:** column `users.corch_paused` (default false).
**UI hint:** yes

**Success criteria:**

1. `GET /api/corch/queue` test returns projects, items, live runs and quota accounts; a web test proves the panel
   updates from `broadcastToUser` with no polling; `web/test/no-indigo.test.ts` green.
2. Pause test: paused => an evaluation dispatches nothing and live runs continue; resume triggers one evaluation;
   the kill switch is independent.
3. Priority PATCH changes selection order (R1.6 test); cancel works only on `queued` (other states => 409).
4. `/queue` is in `BOT_COMMANDS` and the webhook switch together (lockstep test) and is read-only.
5. Schema checks (invariants) pass.

**Not in this phase:** Telegram pause/priority, any new quota logic.

### CORCH-12 -- e2e-proof-enable-runbook (remo-code)

**Dir:** `.planning/phases/CORCH-12-e2e-proof-enable-runbook/`
**Goal:** The whole loop is proven in CI and once for real: a queued item becomes a PR that AAF merges and the hub
records done.
**Depends on:** CORCH-01 .. CORCH-11; live part also on cutover items 1-9.
**REQ-IDs:** CORCH-R6.5, CORCH-R6.6.

**Success criteria:**

1. `hub/test/e2e/corch-*.e2e.test.ts` (happy path, death requeue, quota wait, `pr.closed` => blocked) pass in
   `.woodpecker/qc.yaml`.
2. `VERIFICATION.md` records the live proof on a throwaway repo: item id, run row, PR url on `corch/<id>`, AAF
   merge, `event_id`, hub status `done`.
3. A8 is answered with evidence: the worker finished the phase under the per-slot permission allowlist, or a panel
   decision is recorded (never a silent `skip_permissions` flip).
4. `docs/corch-enable-runbook.md` lists every flag, secret and key step in order.

**Not in this phase:** enrolling real repos beyond the throwaway one.

### CORCH-13 -- retire-overlap (remo-code hub, Coolify)

**Dir:** `.planning/phases/CORCH-13-retire-overlap/`
**Goal:** Only one orchestration path remains in remo-code.
**Depends on:** CORCH-12 PASS.
**REQ-IDs:** CORCH-R6.7.

**Success criteria:**

1. Research holds a keep/delete table; every deleted symbol (`runMacroCycle` + tick/queue registration,
   `orchestrator/merge-command.ts`, `wave-runner.ts`, `waves.ts`, AAF-owned heal paths) has zero remaining
   importers (grep recorded).
2. A live read of prod hub env (MCP Factory `coolify`) shows `REMO_ORCHESTRATOR_ENABLED` OFF, recorded before
   deletion; the table states whether the boot mutual exclusion stays (it stays while that flag still exists).
3. Full hub suite and all guards green; schema.sql diff has no DROP; `git diff` on Revanote `ci-gate.ts` /
   `merge-gate.ts` is empty.
4. CLAUDE.md and docs drop removed flags/paths; `bun run docs:sync` clean.

**Not in this phase:** dropping tables or columns (dormant tables documented instead).

---

## Live cutover list (owner-gated; never done by a phase)

| # | Item | Needed by | Notes |
|---|---|---|---|
| 1 | Mint hub key scope `quota:publish` (cookie-only `/api/api-keys`); configure CUG `hub_publish_url` + credential | 03 live, 12 | Key never printed; stored via Pass |
| 2 | Mint hub key scope `quota:read` for AAF; set AAF `QUOTA_FEED_URL`, `QUOTA_FEED_TOKEN`, `QUOTA_FEED_ACCOUNT_ID` | 07 live, 12 | A11 mapping |
| 3 | Shared event secret: AAF `CORCH_EVENT_URL` + `CORCH_EVENT_SECRET`, hub `REMO_CORCH_AAF_EVENT_SECRET` | 06/08 live, 12 | Same value both sides |
| 4 | AAF `CORCH_TRUSTED_PR_AUTHORS` (machine-user login) | 05 live, 12 | Default empty = adoption off |
| 5 | AAF key with `projects:write`; hub `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN` | 08 live, 12 | |
| 6 | gsd-console `gsdc_` `board:read` token mint (browser-only); hub `REMO_CORCH_GSDC_URL`, `REMO_CORCH_GSDC_TOKEN` | 04 live, 12 | |
| 7 | Machine-user GitHub account creation, write access to enrolled repos, its git credential for slot containers | 09 live, 12 | 12b gate 4 per panel F5 |
| 8 | Linux per-slot containers on Coolify with real `CLAUDE_CODE_OAUTH_TOKEN` (one per slot) and per-slot `purpose='host'` keys | 10 live, 12 | One token per container, F4 |
| 9 | Prod flag flip `REMO_CORCH_ENABLED=1` after verifying `REMO_ORCHESTRATOR_ENABLED` OFF (boot refuses otherwise) | 12 | Rule 12 live cutover |
| 10 | Optional: mint an `ext:corch` key and enable `accept_external` per project | only if an external producer is configured | No producer ships in v1 |

## Paired repos

| Repo | Phases | How |
|---|---|---|
| claude-usage-guard | CORCH-03 | Own branch + worktree (`git-wt`), `memlog_claim` in claude-usage-guard, own PR, signed release; planning artifacts stay in remo-code |
| agentautofix | CORCH-05, CORCH-06, CORCH-07 | Three PRs, each own branch + worktree, `memlog_claim` in agentautofix, `scripts/preflight.ps1` before first push, migration number verified for 06 |

Each paired-repo phase is executed from a session whose cwd is that repo (repo-confinement guard); the remo-code
session only plans and verifies. Verify each repo is in the `app` list of `~/.claude/hooks/repo-kinds.json` before
branching.

## Out of scope

- Fixing the AAF stuck queue (memlog request `1794608544123-0`; owned by agentautofix).
- Uptime Kuma; rebuilding CI.
- Hub-side merge or CI watching; desktop supervisors as targets; an all-tokens container.
- Direct `.planning/` reads; Revanote `ci-gate.ts` / `merge-gate.ts`; AAF trusted-PR review-skip exposure (logged).
- Automated producers for `POST /api/ext/corch/work-items` (endpoint ships; producers deferred).

## Coverage

| REQ | Phase | REQ | Phase | REQ | Phase |
|---|---|---|---|---|---|
| R1.1-R1.13 | 01 | R2.10 | 07 | R4.6, R4.7 | 10 |
| R3.1-R3.7 | 01 | R5.5-R5.7 | 08 | R6.1-R6.4 | 11 |
| R2.1-R2.7 | 02 | R3.8 | 09 | R6.5, R6.6 | 12 |
| R2.8, R2.9 | 03 | R4.1-R4.5 | 09 | R6.7 | 13 |
| R1.14-R1.16 | 04 | R5.1, R5.2 | 05 | | |
| R5.3, R5.4 | 06 | | | | |

Mapped: 55/55 (01: 20, 02: 7, 03: 2, 04: 3, 05: 2, 06: 2, 07: 1, 08: 3, 09: 6, 10: 2, 11: 4, 12: 2, 13: 1).
No orphans, no duplicates.
