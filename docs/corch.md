# CORCH: central orchestrator backlog and dispatcher (milestone CORCH, phase 01)

Source: `hub/src/corch/`. Planning: `.planning/phases/CORCH-01-backlog-dispatcher-core/`.

## Purpose

A per-user backlog of work items, grouped by enrolled repository ("project"), and a dispatcher that turns one
queued item at a time into one launched session working one GSD phase on branch `corch/<work_item_id>`.
It is a NEW queue beside the old auto-dev orchestrator. It reuses primitives only (`governedLaunch`, the shared
`dispatch()` pipeline, the lifetime counter, the kill switch) and never extends `runMacroCycle` or `routine_queue`.

**This phase cannot launch a session in production.** The flag defaults OFF, the enrollment table is empty by
default, and the three provider seams all fail closed (see "Fail-closed defaults").

## Flags and environment

| Variable | Default | Meaning |
|---|---|---|
| `REMO_CORCH_ENABLED` | OFF (`1\|true\|yes\|on` enables) | Read at call time. OFF is a true no-op: the routes only store and list rows; no dispatcher evaluation, no reconciler interval, no `not_before` timer, no launch, no send. |
| `REMO_CORCH_LEASE_MS` | 120000 | How long a live run may go without positive liveness knowledge before it is reclaimed or marked stalled. Non-positive or garbage means the default. |
| `REMO_CORCH_RECONCILE_INTERVAL_MS` | 60000 | The reconciler's single interval. Non-positive or garbage means the default. |
| `REMO_CORCH_QUOTA_CEILING_PCT` | 55 | CORCH-02. An account is eligible only while `max(5h, 7d)` utilization is below this percent. Validated at boot only when `REMO_CORCH_ENABLED` is on: a value that is non-numeric, `<= 0` or `> 100` refuses boot (`assertCorchConfig`), it never becomes the default. With CORCH off, `GET /api/quota/snapshot` answers `500 quota_ceiling_invalid` instead. |
| `REMO_CORCH_AAF_EVENT_SECRET` | unset | CORCH-08. Shared secret AgentAutofix signs PR-outcome events with. Unset: `POST /api/corch-events/aaf` answers `503 not_configured` and records nothing. |
| `REMO_CORCH_AAF_URL`, `REMO_CORCH_AAF_TOKEN`, `REMO_CORCH_AAF_INSTALLATION_ID` | unset | CORCH-08. AgentAutofix base URL (https, or loopback http), a token with scope `projects:write`, and the AAF GitHub installation id. Any unset: no provision call is made and the project stays `aaf_unprovisioned`. The token is read only to build one Authorization header. |

**Boot mutual exclusion:** the hub refuses to boot when `REMO_CORCH_ENABLED` and `REMO_ORCHESTRATOR_ENABLED` are
both truthy (`assertCorchConfig()` in `hub/src/index.ts`, directly after `assertTokenCapConfig()`). The other three
combinations boot.

## Tables (additive DDL, `hub/src/db/schema.sql`)

- `corch_projects`: one row per enrolled `github://owner/repo` per user (`priority`, `daily_token_budget`,
  `enabled`, `accept_external`). Unique `(user_id, repo_ident)`.
- `corch_work_items`: the backlog. Unique `(user_id, source, source_ref)` makes enqueue idempotent.
  `status` is `queued | running | pr_open | done | blocked | cancelled`; `attempts` / `max_attempts` (default 3);
  `not_before`; `wait_reason`; `branch` (`corch/<id>`); `pr_url`.
- `corch_runs`: one row per attempt. Partial unique indexes allow at most one LIVE run (`ended_at IS NULL`) per
  work item and per project.
- `users.corch_max_concurrent_runs` (default 1, CHECK > 0): the per-user concurrency cap.
- `corch_quota_accounts` (CORCH-02): the latest CUG usage reading per account slot, primary key
  `(user_id, account_id)`. Columns: `slot`, `five_h_pct`, `seven_d_pct` (NUMERIC, NULL = unknown), `resets_5h`,
  `resets_7d`, `fetched_at`, `source`, `enabled`, `cug_blocked`, `received_at` (hub clock, set on every POST) and
  the hub-owned `blocked_until` / `blocked_at` (quota death). **No email or label column exists, ever.** Upsert
  rules: every CUG field and `received_at` are overwritten per POST, except that a reading whose `fetched_at` is OLDER
  than the stored one is ignored entirely (replay / out-of-order); a quota-death block (`blocked_until` / `blocked_at`)
  is cleared by the next `source = 'live'` reading whose `fetched_at` is later than `blocked_at`, because CUG is the
  single quota source and the death text is only run output. Rows for accounts absent from later POSTs are kept and age
  out through the staleness rules (fail closed). `user_id` always comes from the verified key.

## Routes

Cookie routes (mounted after the auth catch-all; an API key gets 403 there):

- `POST /api/corch/projects` enroll (canonical lowercase `github://owner/repo`; `path://` idents are refused
  with `path_ident_not_supported`), `GET /api/corch/projects`, `PATCH /api/corch/projects/:id`
  (priority, budget, enabled, accept_external only).
- `POST /api/corch/work-items` (source `manual`), `GET /api/corch/work-items?status=`.

External route `POST /api/ext/corch/work-items` needs the **EXPLICIT-only `ext:corch` scope** (`hasExplicitScope`:
NULL/legacy keys and other `ext:*` scopes do not satisfy it), a source of `aaf | memlog | manual`, a `source_ref`,
and a project that is enrolled, enabled and `accept_external`; otherwise 403 before any write.

Request bodies are zod-validated with unknown keys stripped, so a caller can never set `counter_key`, `status`,
`branch` or `attempts`.

Quota routes (CORCH-02, mounted BEFORE the auth catch-all, route-local Bearer api-key auth, cookies never
authenticate, rate limit 120/min per key prefix, `/api/quota/` is CSRF-allowlisted and skips the license gate):

- `POST /api/quota/snapshot` needs the **EXPLICIT-only `quota:publish` scope**. Body is a CUG usage-snapshot v1,
  strict at both levels (`.strict()`): `{schema: 1, publisher: "cug", generated_at, poll_interval_secs, accounts[0..32]}`
  with each account `{account_id, slot, five_h_pct, seven_d_pct, resets_5h, resets_7d, fetched_at, source, enabled,
  blocked, current}`. `email`, `label`, `user_id` and any unknown key return `400 {error: "invalid_snapshot"}` with
  no value echoed and no row written; so does an account `fetched_at` (or the top-level `generated_at`) more than 120 s
  ahead of server time (a future-dated reading would pin the stored row ahead of every genuine later reading); the body
  is never logged. Over 64 KiB returns `413` before parsing.
  `200 {ok: true, accepted: n}`. Each successful POST triggers exactly one dispatcher evaluation when
  `REMO_CORCH_ENABLED` is on and none when it is off; a 4xx triggers none.
- `GET /api/quota/snapshot` needs the **EXPLICIT-only `quota:read` scope** and returns the key owner's accounts with
  the eligibility verdict: `{ceiling_pct, accounts: [{account_id, slot, eligible, reason, not_before, five_h_pct,
  seven_d_pct, resets_5h, resets_7d, fetched_at, source, received_at, blocked_until}]}`.
- `401` for a missing, malformed or unknown key (a failed lookup also fails closed to 401), `403
  {error: "insufficient_scope", required}` for a NULL/legacy key or the other quota scope. Neither scope implies the
  other, and a quota key is refused by `/api/ext/*`, `/api/cloud-hook/*`, `/ws/agent` and every cookie route.

## One evaluation (LD-6)

flag check, claim transaction, `Workspace.resolve`, attach session to the run, build prompt and request,
`governedLaunch` (HEAL policy), then on `launched` the single shared `dispatch()`.

The claim transaction takes `pg_advisory_xact_lock(hashtext('corch:user:<userId>'))`, checks the user's cap, and
selects ONE candidate: queued, due (`not_before` null or past), project enabled, no live run on the project, no
`pr_open` item on the project; ordered by project priority DESC, item priority DESC, `created_at` ASC, `id` ASC.
A unique violation on a live-run index means a lost race and returns nothing.

## The 8-gate chain (LD-5)

`buildCorchPipelineDeps` holds the only `gates: [` literal. Order is binding:

1. `automationKillSwitchGate` (first on every machine list)
2. `dailyCostCapGate`
3. `dailyTokenCapGate`
4. `corch_project_budget` (four-bucket tokens of the project's CORCH sessions today vs `daily_token_budget`)
5. `corch_concurrency` (other live runs of the user vs the cap)
6. `corch_quota` (the `QuotaProvider`)
7. `sessionInjectRateGate`
8. `automationLifetimeCounterGate` (last)

`thresholdGate` is deliberately absent: CORCH does not use the subscription-threshold gate, and no guard pins it
on machine lists. The launch's `preLaunch.checkGates` runs this SAME list object, so the launch and the prompt turn
cannot disagree.

## Identity strings (LD-3)

Counter key `corch:<work_item_id>` (`buildCorchKey`, the only builder; the lifetime cap is per ITEM). Dispatch
token `corch-run:<corch_runs.id>`. Actor `corch`. Branch `corch/<work_item_id>`. Claim lock `corch:user:<userId>`.
`counterKey` is attached in one place, `buildCorchRequest`, pinned by `counter-key-assignment-guard`.

## State machine

Refusals never consume an attempt (LD-7): the run ends, the item returns to `queued`.

| Refusal | `end_reason` | `not_before` |
|---|---|---|
| `project_budget`, cost cap, token cap, `over_token_cap`, `launch_cap` | the reason | next local midnight (user tz) |
| inject-rate (`over_session_inject_rate:`) | the reason | now + 60 min |
| `autospawn_launch_*` | the reason | now + lease |
| `automation_halted:<scope>` | `automation_halted` | none (event-driven) |
| `corch_concurrency`, `quota_*`, `lifetime_inject_exhausted*`, `workspace_unavailable`, `supervisor_offline`, `disabled`, `not_allowlisted`, `in_flight`, `ledger_unavailable`, unknown | the reason | none |

Failures consume an attempt (LD-8): `launch_failed`, `dispatch_failed`, `dropped_busy`, `spawn_timeout`,
`launch_error` (any throw in the launch path), `workspace_error` (a throwing Workspace), `claim_orphaned`,
`supervisor_closed`, `session_absent`, `no_pr` (run ended, no PR found), `pr_lookup_unavailable`. New attempts =
attempts + 1; at `max_attempts` the item becomes `blocked` and the owner is notified exactly once; otherwise it
returns to `queued` with `not_before = now + 60s * 5^(attempts-1)` (60s, then 300s). A run that ends with an open PR
marks the item `pr_open` and stores `pr_url`.

Every end-of-run transition is one transaction whose first statement is
`UPDATE corch_runs ... WHERE id = $1 AND ended_at IS NULL`: zero rows means nothing else happens, so a double
delivery (callback plus returned outcome) never double-counts an attempt or double-notifies (LD-9). Reservation
release (LD-10) only on a no-attempt refusal after a successful launch, on park expiry and on `dropped_busy`.

## Positive-knowledge reclaim (LD-13, CORCH-R3.3)

A live run is reclaimed only when this process KNOWS it is gone:

- the supervisor socket closed and was not replaced by a reconnect (`ws/agent.ts` close hook): `supervisor_closed`;
- a FRESH `session_inventory` (the dead-session reaper's freshness rule) FROM THE RUN'S OWN SUPERVISOR lacks the
  session and the heartbeat is older than the lease: `session_absent`. A run with no `supervisor_id` (the hub crashed
  between launch and `markRunLaunched`) has no owner on record: another supervisor's inventory can prove it ALIVE,
  never gone, so it can only stall;
- a run with no session id, not in this process's in-flight launches, older than the lease: `claim_orphaned`. It
  consumes an attempt so a deterministic failure before the session is attached is bounded (blocked + one
  notification) rather than re-claimed forever.

The reconciler reads one page of at most 100 live runs per pass in stable id order and carries a cursor, so runs it
can only mark `stalled` cannot starve the rest. An ended run never sends: the three CORCH gates refuse it
(`corch_run_not_live`), a parked replay re-checks liveness, and `markDispatched` throws when the conditional update
finds the run ended. A busy session (`markSkipped('session_busy')`) is a `dropped_busy` failure with an attempt.
A reclaim that lands AFTER `markDispatched` succeeded is also stopped: every run-ending path drops the run from an in-memory
sendable set before its first await, and the corch send seam (`corchSend` / `guardSendDeps`) asserts it immediately before the
message insert and immediately before `ws.send` (no await between), so no ws send or message row follows the reclaim.
`corchSend` resolves the DAL module before the insert guard, so no await sits between the guard and the row write. The
shared `dispatch()` also checks hook ownership (the exact hook object it armed) before cleaning up after a refused or failed
send: when a reclaim already released the hook and promoted a waiter, the old send's failure touches neither the successor's
hook nor the queue slot.

No fresh inventory is "unknown", never "gone": past the lease the run becomes `stalled` once, with one owner
notification. A listed session refreshes the heartbeat (and a stalled run returns to `running`). A hub restart
therefore reclaims nothing and never double-launches: the old live run still holds the cap and the unique indexes.
Notifications carry ids, `repo_ident`, attempts and `end_reason` only, never item text (LD-14).

## Triggers and the single interval (LD-12)

On boot (flag ON) the already-due backlog is evaluated once, then the timer is armed for the next future deadline.
Event-driven: enqueue (both routes), project `enabled` false to true, run end, kill-switch release
(`api/automation.ts` `resumeDeferredWork`), supervisor hello and close (`ws/agent.ts`), plus ONE `setTimeout`
re-armed to the earliest future `not_before`. The only periodic loop is the reconciler's single `setInterval`
(`reconciler.ts`), pinned by `corch-no-polling-guard.test.ts`. Every trigger returns before any DB access while
the flag is OFF (`corch-flag-off.test.ts`).

## Prompt (CORCH-R1.12)

Server-owned template (`prompt.ts`): header, `SCOPE_CONTRACT`, work only in the given worktree on `corch/<id>` as
one GSD phase, push the branch and open a pull request, and the single sentence "Never merge any pull request,
never push to the default branch, never deploy." Title, body, source and source_ref pass ONLY through
`fenceUntrusted`. Launch goes through `governedLaunch` HEAL policy, which forces `skipPermissions: false`.

## Quota eligibility (CORCH-02)

The hub uses ONLY the CUG snapshot (never the oauth-poll `hub/src/usage/**` store or the threshold gate; a test
parses the imports of `hub/src/corch/**` and `hub/src/api/quota.ts` to prove it). One pure function,
`evaluateAccounts` in `hub/src/corch/quota-eligibility.ts`, feeds both `GET /api/quota/snapshot` and the dispatcher's
provider. The first failing rule wins, in this order:

| # | Rule | Reason | `not_before` |
|---|---|---|---|
| 1 | no rows at all | `quota:no_snapshot` (reported by the caller) | none |
| 2 | `now - received_at > 600 s` | `quota:snapshot_stale` | none |
| 3 | `fetched_at` null, older than 900 s, or more than 60 s in the future | `quota:account_stale` | none |
| 4 | `source != live` | `quota:source_not_live` | none |
| 5 | CUG `blocked` | `quota:cug_blocked` | none |
| 6 | `enabled = false` | `quota:cug_disabled` | none |
| 7 | `blocked_until > now`, or `blocked_at` set with `blocked_until` NULL | `quota:blocked` | `blocked_until`, else none |
| 8 | `seven_d_pct` null | `quota:seven_d_unknown` | none |
| 9 | `max(5h, 7d) >= REMO_CORCH_QUOTA_CEILING_PCT` | `quota:over_ceiling` | the later reset of the window(s) at or over the ceiling; none if any is null or past |
| 10 | `five_h_pct` null and the account already has a live CORCH run | `quota:five_h_unknown_busy` | none |

Unknown is never zero: a null `five_h_pct` is eligible only while 7d is known and under the ceiling, and only with
no other live run on that account (CUG treats unknown as eligible; the hub does not).

**Selection.** With `REMO_CORCH_ENABLED` on, `createQuotaProvider` replaces the CORCH-01 default provider. Per
dispatch it takes the eligible accounts that have an online supervisor advertising that `account_slot` (new optional
`supervisor.hello` field, same charset as `account_id`) and a free slot (capacity = the largest hello
`max_concurrent` for that account, default 1, capped at 1 when `five_h_pct` is null; busy = live `corch_runs` on the
account). It picks the lowest `max(5h ?? 7d, 7d)`, tie-break `account_id` ascending, and records it on
`corch_runs.account_slot` with one conditional `UPDATE` (refusal `quota:slot_taken` if the account filled meanwhile).
A run that already holds an account is never moved. A hello without `account_slot` is never a target. No candidate:
the shared reason when every account has the same one, `quota:no_slot_supervisor` when accounts are eligible but none
has an online slot supervisor with a free slot, else `quota:no_eligible_account`. The claim is serialized per
`(user_id, account_id)` by a transaction advisory lock. The selection carries `supervisor_id` (the lowest-id online
supervisor advertising the account) and the corch launch targets exactly that supervisor (`governedLaunch`
`resolveTarget` -> `launchSessionForUser` `targetSupervisorId`, corch only); with no supervisor for the run's account
the item is refused `quota:supervisor_unbound` (no attempt). At launch resolution the target supervisor's CURRENT
advertised account is re-read from the registry and must equal the run's recorded `account_slot` (and the supervisor
must be connected), else the same refusal. `GET /api/quota/snapshot` evaluates eligibility with the
same live per-account busy counts as dispatch.

**Wait.** A `quota:` refusal requeues the item with `wait_reason = quota:<reason>`, no attempt consumed, and
`not_before` = `min(earliest time any account can become eligible, now + 600s)` when EVERY ineligible account carries
one, else NULL (only an event can change it: a snapshot POST, a supervisor hello or close, a run end). The item is
never held to a far-future reset: the account state alone governs eligibility, so a healthy snapshot arriving before
the reset releases the item within one 600 s backoff window. The existing single `not_before` scheduler consumes it;
no new timer or poll was added.

**Quota death (R2.5).** A run whose end text (`onFinalize` content or `markFailed` error) is, as a whole, the CLI
usage-limit signal (`hub/src/corch/quota-death.ts`: the legacy `Claude AI usage limit reached|<epoch>` or the
current `You've hit your session|weekly|Opus|Sonnet limit ...`, at most 500 chars) marks its account
`blocked_at = now()` and `blocked_until = min(candidate reset, now + cap)`, where the candidate is the signal's reset
when in the future, else that window's reset from the reading, else the earliest future reset, and the cap is 7 days
for the weekly window and 5 hours otherwise (a far-future or past epoch therefore clamps; text can never block an
account indefinitely). A later death keeps the later `blocked_until`. When the block was recorded the item only backs
off 600 s (`not_before = now + 600s`): the account block alone governs quota (dispatch refuses a blocked account and a
clearing live snapshot triggers an evaluation), so a healthy reading releases the item after the backoff. If the
account cannot be identified or the block was not recorded (`markDeath` threw, or returned no `blocked_until`), the
item is held 5 hours (`not_before = now + 5h`), never redispatched at once. The item is requeued with `end_reason quota_death`, `wait_reason quota:death`, no
attempt, and the PR lookup is skipped. A long assistant message that merely mentions a limit is not a death. Known
limit: the supervisor relays a whole turn's text, so a run that wrote prose and then hit the limit does not match
the whole-text anchor and follows the CORCH-01 `no_pr` path (fail-safe direction). Details and evidence:
`.planning/phases/CORCH-02-quota-ingest/CORCH-02-RESEARCH.md`.

**Future-dated stored readings (QC3 H2).** Ingest rejects a `fetched_at` or `generated_at` more than 120 s ahead of
server time. A row already stored with such a timestamp (written before that bound) is treated as invalid by the
upsert: any genuine reading overwrites it, so it cannot reject later readings or pin a block.

**Accepted residuals (CORCH-02).**
- Supervisor rebinding between `resolveTarget` and the send: the binding is re-read at launch resolution, not again
  across the reservation and ledger awaits. Each supervisor container uses one fixed account token, so a reconnect
  preserves its account binding; this is a documented operational constraint, not an enforced code invariant.
- Publisher-declared source trust: `source: live` and `fetched_at > blocked_at` are publisher-supplied and clear a
  death block. Only a holder of a `quota:publish` key can do this, and only for that key owner's own user.

## gsd-console ingestion (CORCH-04)

Source: the gsd-console board (`GET /api/board/stream` SSE, `GET /api/board/projects/{id}`), read with a `gsdc_`
Bearer token that has scope `board:read`. Code: `hub/src/corch/gsdc-derive.ts` (pure derivation),
`gsdc-ingest.ts` (SSE client, backoff, fail-closed apply), `gsdc-boot.ts` (wiring, started from `startCorch`).

| Variable | Default | Meaning |
|---|---|---|
| `REMO_CORCH_GSDC_URL` | unset | gsd-console origin. |
| `REMO_CORCH_GSDC_TOKEN` | unset | `gsdc_` token, `board:read`. Read only to build one `Authorization` header; never logged, stored or put in a notification. Minting it is a browser-only cutover step, not part of this phase. |

Both unset (or `REMO_CORCH_ENABLED` OFF) = source off: no connection, no timer, no store access. Exactly one of the
two set = misconfiguration: no connection, one owner notification (`token_unset` / `url_unset`), no retry.

**Flow.** On `snapshot` (data `{projects: Summary[]}`) and `project` (data `Summary`) the hub re-reads the board of
every summary whose console slug `owner/name` equals an ENABLED hub project `github://owner/name` (case-insensitive).
Other projects are never read. A summary with `active_runs > 0`, `stale` or `divergent` is skipped before any read.
The stream is closed by the console after 10 minutes: the hub reconnects and takes a fresh snapshot. There is no
timer polling of the board; the only timers are one reconnect timeout (and one inactivity timeout) per stream,
re-armed through the injected `CorchTimers` seam, never a loop (`corch-no-polling-guard`).

**Derivation (R1.15).** Candidate = the `current` phase, else the lowest-numbered `pending` phase (numeric dotted
order); `backlog` (999.x) is never a candidate. Upsert as source `gsd_console`, `source_ref =
<owner/name>:<milestone>:<phase>` where milestone is `position.milestone.version`, else its heading, else `none`;
`title` = `Phase <n>: <name>`, `body` = the phase goal, `priority` = the project's priority. The unique index
`(user_id, source, source_ref)` makes the upsert idempotent. A QUEUED `gsd_console` item whose phase the console now
reports in `done` is cancelled; the whole event (every enrolled board of it: cancellations then upserts) is written by ONE transaction, `store.applyGsdcBoards`, and `claimNext` now locks its candidate row (`FOR UPDATE OF i`) so a concurrent cancel can never be overwritten back to `running`; running, `pr_open`, done, blocked and manual/other-source
items are never touched. A board whose snapshot is not `ready` or is stale is skipped (no upsert, no cancel).
Mirrored text is stored as data and reaches a prompt only through `fenceUntrusted` (`prompt.ts`). No supervisor
`.planning/` read, no auto-enrollment.

**Fail closed (R1.16).** Unreachable, 5xx, 401/402/403 (and any other non-2xx), a `stream-error` event, a stream
that ends before a snapshot, an unparseable or schema-failing frame, or a failing board read all yield ZERO upserts
and ZERO cancellations: a snapshot is applied all-or-nothing (every enrolled board is read first; a single failed
read discards the whole snapshot). Already-queued items are unaffected. One owner notification per outage
(`fanOutNotify` over the durable channels email and telegram only, detail = the error signature only, to every user with an enabled project; an owner counts as notified only when email or telegram reported success, the in-app socket broadcast persists nothing and never counts, and an owner not yet reached is retried alone on the next failure of the same outage); one AgentAutofix ticket per distinct error signature per outage through `hub/src/agentautofix/reporter.ts` (`reportTriageFindingToAgentautofix`, immediate and unthrottled, retried on the next failure until a positive result) (fingerprint `corch-gsdc:<signature>`, signature only, no console text or token; sends nothing when AgentAutofix is unconfigured; a ticket failure never affects ingestion); an outage ends at the
next fully applied event. Reconnect after an error uses bounded exponential backoff, 1s doubling to a 5 minute cap;
a stream that stayed up at least 30s resets the ladder, and a stream that ends right after its snapshot is backed
off too, so a console that closes immediately cannot cause a reconnect storm. No fallback source.
Error signatures: `unreachable`, `http_5xx`, `http_401|402|403|<n>`, `stream_error[:<code>]`, `stream_ended`,
`bad_payload` (malformed/oversized frame or board, 8 MB board cap), `apply_failed` (the hub database write failed and rolled back), `token_unset`, `url_unset`.
Every failed or finished connection is aborted; any received bytes (keepalive comments included) re-arm the 3 minute inactivity timeout.

## Fail-closed defaults (LD-11)

| Seam | Phase-01 default | Replaced by |
|---|---|---|
| `QuotaProvider.snapshotFor` | `quota_no_snapshot` (still the default object; unchanged for flag OFF and tests) | CORCH-02 `createQuotaProvider` when the flag is ON: every rule above fails closed (`quota:*`) |
| `Workspace.resolve` | `workspace_unavailable` | CORCH-09 (supervisor worktrees) |
| `PrLookup.lookup` | `unavailable` (`pr_lookup_unavailable`, attempt consumed) | CORCH-09 |

With these defaults an item stays `queued` with `attempts` unchanged and `wait_reason` `quota_no_snapshot` or
`workspace_unavailable`.

## Shared autospawn launch cap

CORCH launches go through the same `governedLaunch` and write the same `AUTOSPAWN_LAUNCH_COMMAND` ledger rows as
the old orchestrator and heal autospawn, so they count against the shared `REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES`
cap (refusal `launch_cap`). CORCH enrollment (`corch_projects.enabled`) replaces `orchestrator_autospawn_allowlist`
as the repo check; CORCH never reads or writes that table.

## Tests

`corch-boot-assert`, `corch-flag-off`, `corch-gates` (gates, keys, refusal schedule, dispatcher and reconciler with
fakes), `corch-prompt`, `corch-routes`, `corch-no-polling-guard`, and the real-Postgres
`e2e/corch-dispatcher.e2e.test.ts` (selection order, race at cap 1, uniqueness, backoff then blocked with one
notification, one case per refusal, restart without double launch, `pr_open` success path). CORCH-02 adds
`corch-quota-ingest` (auth, strict body, 413, no-log probe, per-user read), `corch-quota-eligibility` (the ordered
table and the CUG-only import guard), `corch-quota-selection`, `corch-quota-wait`, `corch-quota-death`, and the
real-Postgres `e2e/corch-quota.e2e.test.ts`. Guard additions:
`token-cap-coverage`, `kill-switch-coverage`, `counter-key-assignment-guard`, `launch-callers-guard`,
`launch-machine-guard`, `session-start-senders-guard`, `reserve-caller-guard`, `mount-order`, `api-keys-scopes`.
CORCH-04 adds `corch-gsdc-derive` (table-driven board fixtures), `corch-gsdc-ingest` (fake SSE console: enrolled-only
reads, reconnect, backoff cap, every failure mode, fencing), the real-Postgres `e2e/corch-gsdc.e2e.test.ts`, and extends
`corch-no-polling-guard` (allows `gsdc-ingest.ts` timeouts only through the injected timers seam).


## AAF event receiver, closure and provisioning (CORCH-08)

Only AgentAutofix-provisioned projects are dispatchable, and a PR outcome closes the work item.

**Provisioning (CORCH-R5.7).** `corch_projects.aaf_provision_status` is `aaf_unprovisioned` (default) or
`provisioned`, with `aaf_project_id` (additive `ADD COLUMN IF NOT EXISTS`). Enrolling a project
(`POST /api/corch/projects`) or re-enabling it (`PATCH` enabled false to true) calls AAF
`POST {REMO_CORCH_AAF_URL}/api/projects/provision` with `{repo_slugs: ["owner/name"], installation_id}` and a bearer
`REMO_CORCH_AAF_TOKEN` (scope `projects:write`). Any failure, an unreachable AAF, a malformed reply or an unset env
leaves `aaf_unprovisioned` and never blocks enrollment (`hub/src/corch/aaf-provision.ts`; the reply is untrusted: only a
well-formed project id for the same repo is kept). `claimNext`, `usersWithDueItems` and `earliestFutureNotBefore`
require `aaf_provision_status = 'provisioned'`, so an unprovisioned project never dispatches (fail closed). Projects
enrolled earlier are backfilled once, idempotently: `bun hub/scripts/corch-provision-existing.ts` (needs `DATABASE_URL`
and the three AAF variables; prints counts only; a second run finds nothing to do).

**Receiver (CORCH-R5.5).** `POST /api/corch-events/aaf`, mounted BEFORE the `/api/*` auth catch-all (pinned in
`hub/test/mount-order.test.ts`; CSRF-allowlisted, skips the license gate; 120/min per source IP; body cap 16 KiB).
Auth is the signature, via the shared `runIntake`: raw body before any JSON parse, `X-ZeroExposure-Signature:
sha256=<hex HMAC-SHA256(secret, X-ZeroExposure-Timestamp + "." + rawBody)>` compared in constant time, a timestamp more
than 5 minutes off rejected, every credential failure the same `401 {"error":"unauthorized"}`. `X-ZeroExposure-Event-Id`,
when present, must equal the signed `event_id`. Secret unset: `503`, nothing recorded. The shared vector
`hub/test/fixtures/corch-event-signature-vector.json` is byte-identical to the agentautofix CORCH-06 copy and is verified
by `corch-aaf-events.test.ts`. Body: `{event_id, event, repo, pr_number, head_ref, merged_sha?, occurred_at}`; every
field is untrusted data, used only as a lookup key (never echoed, logged or put in a notification).

**Closure transitions (CORCH-R5.6).** The item is resolved by repo (`github://<repo>` lowercased, case-insensitive) and
head ref `corch/<work_item_id>`. One transaction dedupes on `corch_events.event_id` (unique) and applies:

| Event | Item status before | Result |
|---|---|---|
| `pr.merged` | queued, running, pr_open, blocked | `done` |
| `pr.closed` (unmerged) | queued, running, pr_open | `blocked` (`wait_reason=pr_closed`), never auto-requeued |
| `pr.failed` | queued, running, pr_open | `blocked` (`wait_reason=pr_failed`) + ONE notification (telegram and email, the durable channels the gsd-console outage notice uses; see "Notification durability") |
| any | done, cancelled, or no matching item, or already blocked (closed/failed) | no change, audited in `corch_events.outcome` |
| replayed `event_id` | any | `200 duplicate`, no second transition, no second notification (a still-pending notification is retried) |

Responses are `200 {ok:true, status: applied | duplicate | ignored}` (unknown and terminal are both `ignored`).
Every done/blocked transition also ENDS the item's live run in the same transaction (`end_reason` `aaf_pr_merged` /
`aaf_pr_closed` / `aaf_pr_failed`): the run row's `ended_at` is what every dispatch gate and the parked-turn replay check, so
a turn parked offline can never be sent for a closed item, and the concurrency slot is freed. As a second guard
`endRunAndRequeue` and `endRunMarkPrOpen` only touch an item that is still `running`: a run ending after a closure
event leaves the item as the event set it (`itemUntouched`, no requeue, no second blocked notification), which is why a
closed PR stays blocked across reconciler passes.

**Notification durability.** The `pr.failed` notification intent is stored with the transition (`corch_events.notify_state`
`pending`), claimed atomically (`sending`, reclaimable after 5 minutes) and marked `sent` only after a durable delivery.
An undelivered notification releases the claim and the receiver answers `503 notification_pending` so AgentAutofix retries
the SAME `event_id`; that retry is a duplicate for the transition (never applied twice) but re-attempts the notification. Each applied transition triggers one dispatch evaluation (a no-op while
`REMO_CORCH_ENABLED` is OFF).

Tests: `corch-aaf-events` (auth envelope, vector, skew, replay, non-leaky errors), `corch-aaf-provision` (fake AAF, env
unset, enrollment hook, backfill), real-Postgres `e2e/corch-aaf.e2e.test.ts` (transitions, reconciler pass, race,
provision gate, backfill idempotency); `corch-dispatcher` and `corch-quota` e2e fixtures seed `provisioned` projects.
