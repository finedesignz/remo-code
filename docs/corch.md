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

## Fail-closed defaults (LD-11)

| Seam | Phase-01 default | Replaced by |
|---|---|---|
| `QuotaProvider.snapshotFor` | `quota_no_snapshot` | CORCH-02 |
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
notification, one case per refusal, restart without double launch, `pr_open` success path). Guard additions:
`token-cap-coverage`, `kill-switch-coverage`, `counter-key-assignment-guard`, `launch-callers-guard`,
`launch-machine-guard`, `session-start-senders-guard`, `reserve-caller-guard`, `mount-order`, `api-keys-scopes`.
