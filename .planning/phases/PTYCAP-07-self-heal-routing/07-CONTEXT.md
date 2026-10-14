# Phase 7 Context - Unified Self-Heal Routing (PTYCAP)

Branch `phase-ptycap-07-self-heal-routing`, stacked on Phase 4 (#506) / Phase 3 (#505). PR #346 is
merged to main and included. Primary input: `07-SPEC.md`. Forks needing a lock: `07-FORKS.md`.
Locked recommendations in FORKS are referenced here as D-xx "(fork F-n)".

## 1. Domain and boundary

One seam, `hub/src/heal/route.ts::routeHeal(event)`, owns the single routing decision for a machine
failure event. Four sources (Coolify deploy webhook, scheduled-task failure, error-capture, feedback)
build a `HealEvent` and call it, behind `REMO_HEAL_UNIFIED` (default OFF, OFF = byte-for-byte today).

In: seam + types, `heal_events` ledger/dedupe, fast terminal for un-routable failures, one
notification, reuse of the BSA AND-chain and shared `dispatch()` pipeline, source rewiring, guard tests.
Out (spec s8, unchanged): any cap/gate value change, populating the allowlist, flipping
`REMO_ORCHESTRATOR_*`, PTY path, auto-merge, Telegram/Revanote, deleting `pickSessionTarget`.

IMPORTANT - the spec is STALE against main. PR #346 already changed the Coolify path (verified):
- `hub/src/scheduler/senders/triage.ts:1-40` header + `:74-76`: triage is LOCAL-AGENT ONLY. The
  supervisor spawn branch and the legacy `pending` map / `onTriageAssistantMessage` are GONE, and
  `pickSessionTarget` is no longer imported there. SH-06's "legacy pending map" requirement is
  already satisfied for triage; SH-03's "remove capacity routing" is only partially true (see below).
- `hub/src/api/coolify-webhook.ts:166-195`: when no repo-keyed session AND no online agent session,
  the metadata run is finalized `skipped`/`no_routable_session` immediately. The original incident
  (supervisor online, no agent session -> NULL-session run pending 6h) is therefore already closed
  for that exact shape.
Residual defects that are the real Phase 7 value (each gets a test):
1. `triage.ts:75` `listOnlineAgentSessionsForUser(userId)[0]` and `coolify-webhook.ts:182` still
   route a repo-X failure into ANY online agent session (a stranger bound to repo Y). SH-03 violation.
2. An OFFLINE session bound to the failing repo is never woken (no allowlist-governed autospawn path
   for heals); `ensureSessionOnline` exists only for error-capture/feedback behind `REMO_SPAWN_ON_ERROR`.
3. `coolify-webhook.ts:150-152` and `:193-195` fail OPEN on errors (dispatch anyway) - a probe/claim
   error can still produce an un-terminal run. Phase 7 must keep a terminal guarantee on every path.
4. `skipped` on an internal task is silent (`post-run/dispatcher.ts` default email only for
   failed/blocked) - today an un-routable failure produces ZERO notifications; SH-05 demands exactly one.
5. Scheduled-task failure has no heal source at all; error-capture/feedback each hand-roll a
   `PipelineDeps` + gate list (`error-capture/dispatcher.ts:168-175`, `feedback/dispatcher.ts:131-136`).
6. `dedupe` is Coolify-only (`claimDeployFailure`, `db/dal.ts:1852`, table `coolify_deploy_idempotency`).

## 2. Existing code map (file:line)

| Concern | Location |
|---|---|
| Coolify webhook entry, dedupe claim, routability probe, runNow | `hub/src/api/coolify-webhook.ts:121-215` (`dispatchTriage`); caller `:391` |
| Storm dedupe claim (INSERT ON CONFLICT, 2h reap, prev-bucket check) | `hub/src/db/dal.ts:1852-1884`; table `coolify_deploy_idempotency` (schema.sql) |
| Triage sender (agent-only, shared dispatch, counterKey `triage:<app>`) | `hub/src/scheduler/senders/triage.ts:55-191` |
| Internal tasks (`enabled=false` BY DESIGN, never "fix") | `hub/src/db/dal.ts:1622` `ensureInternalTriageTask`, `:1643` `ensureInternalDeploymentTask` |
| Repo-keyed live lookup (channel-only, NOT ghost-aware) | `hub/src/sessions/repo-routing.ts:42-81` |
| Sessions by repo_key incl. OFFLINE rows | `hub/src/db/dal.ts:12-25` `listSessionIdsForRepoKey` |
| Ghost-aware liveness (private, fails open to live) | `hub/src/orchestrator/inject.ts:143-160` `defaultIsSessionLive` |
| Autospawn AND-chain + launch + grace park | `hub/src/orchestrator/inject.ts:351-495` `maybeAutospawnOffline` (private; deps seam `:104-125`) |
| Spawn primitive (needs an EXISTING session row) | `hub/src/telegram/launch.ts:84-` `launchSessionForUser({machine:true})` |
| Allowlist / launch count | `hub/src/db/orchestrator-rows-dal.ts:482` `isRepoAutospawnAllowed`, `:515` `countAutospawnLaunchesToday`, `AUTOSPAWN_LAUNCH_COMMAND` |
| Gates | `hub/src/dispatch/gates.ts:107` threshold, `:122` cost, `:267` token, `:325` inject-rate, `:445-457` launch cap |
| Phase-4 controls (kill switch FIRST, lifetime counter LAST, `counterKey`) | `hub/src/dispatch/automation-controls.ts:181,315`; `pipeline.ts:52,239,341-420` |
| Competing spawn primitive (flag `REMO_SPAWN_ON_ERROR`) | `hub/src/dispatch/spawn-on-error.ts:65,156`; used by `error-capture/dispatcher.ts:175`, `feedback/dispatcher.ts:136`, `ask/dispatch.ts:154` |
| Error-capture dispatch (bound `project.session_id`, no counterKey) | `hub/src/error-capture/dispatcher.ts:68-196` |
| Feedback dispatch (bound session, no counterKey) | `hub/src/feedback/dispatcher.ts:106-160` |
| Scheduled-task finalize + post-run (default email failed/blocked only) | `hub/src/scheduler/dispatcher.ts:740` `finalizeRun`; `hub/src/scheduler/post-run/dispatcher.ts:43-143` |
| 6h pending reaper (query `status='pending'`) | `hub/src/scheduler/run-reaper.ts:42-141` (`reapStaleRuns` deps seam `:74`) |
| Untrusted fence + scope contract | `hub/src/dispatch/untrusted.ts` (`fenceUntrusted`, `SCOPE_CONTRACT`) |
| 5th machine surface, external self-heal service | `hub/src/api/sessions.ts:376-529` `POST /heal` (own counter key `heal:<userId>:<repo>` at `:410`; deliberately "heal-specific counter policy is Phase 7") |
| Guards to extend | `hub/test/token-cap-coverage.test.ts`, `hub/test/session-start-senders-guard.test.ts`, `launch-callers-guard.test.ts` |

## 3. Locked decisions

- **D-01 Flag.** `REMO_HEAL_UNIFIED`, default OFF; accepts `1|true|yes|on`, anything else (incl. unrecognized) = OFF.
  Read at call time (not import time) so tests toggle it. OFF: each source runs its current code
  untouched and `routeHeal` is never called. Companion knobs `REMO_HEAL_DEDUPE_WINDOW_MS` (900000) and
  `REMO_HEAL_SPAWN_TIMEOUT_MS` (25000): non-positive/non-finite => default, never "no dedupe".
- **D-02 One seam, closed union.** `routeHeal(event): Promise<HealOutcome>` in `hub/src/heal/route.ts`; `HealEvent`
  per SH-02 plus `bound_session_id?` (fork F-2). `HealOutcome`: `dispatched_live | autospawn_launched | autospawn_parked | no_routable_session | deduped | refused:<reason> | failed:<reason>`.
- **D-03 Live wins.** Target = the repo-bound (or source-bound) session that passes a GHOST-AWARE liveness check.
  `defaultIsSessionLive` is exported from a shared module (move, do not copy) and used by both
  `inject.ts` and `heal/`. No capacity fallback, no stranger session: `listOnlineAgentSessionsForUser`
  is never consulted in `heal/` (guard test). Live => `dispatched_live`, zero spawn calls.
- **D-04 Autospawn reuses the BSA chain verbatim.** The AND-chain body of `maybeAutospawnOffline`
  (enabled, autospawn-enabled, allowlisted, supervisor online, token cap, launch cap, counter key, dedupe of in-flight launch,
  launch, ledger row, park + replay re-entering `dispatch()`) is extracted into one shared function
  consumed by BOTH the orchestrator inject and `routeHeal` (fork F-1). Candidate session = most recent
  OFFLINE session row bound to the repo (`listSessionIdsForRepoKey`); none exists => SH-05. Heal never creates a session row.
- **D-05 Fail fast, terminal, one notification.** Un-routable => same request: finalize `metadata_run_id`
  `skipped`/`no_routable_session` (`finalizeRun`), write `heal_events.outcome`, emit exactly ONE notification
  (email via existing `notify_email` machinery / E4A path, naming repo + reason). Notification is claimed via the
  `heal_events` row (insert-once) so retries and multi-source repeats cannot double-send. Dedupe-dropped events send nothing.
- **D-06 Every path terminal.** `routeHeal` wraps its body so any thrown error finalizes `metadata_run_id`
  `failed`/`heal_route_error:<msg>` and files nothing silently (rule 7d ticket is the operator's, not a code fallback).
  No fail-open dispatch-anyway. (Replaces the fail-open at `coolify-webhook.ts:150,193` when the flag is ON.)
- **D-07 Shared pipeline only.** All dispatch via `dispatch()` with a `RunStore` finalizing through `onSessionReply`.
  ONE gate list constant in `heal/`: `[automationKillSwitchGate, thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, automationLifetimeCounterGate]` (Phase-4 composition: kill switch first, lifetime counter last).
  Found by the `token-cap-coverage` scan; extend `session-start-senders-guard` so `heal/` carries no direct `session.start`.
- **D-08 Counter key.** `counterKey = heal:<userId>:<repo_ident>` for all four sources (fork F-4). The pipeline reserves before send; grace replay re-enters `dispatch()` (Phase-4 D-03).
- **D-09 Dedupe store.** New `heal_events` table (spec s5) with `UNIQUE(user_id, dedupe_key, bucket)`-style atomic claim
  (INSERT ON CONFLICT DO NOTHING RETURNING), window `REMO_HEAL_DEDUPE_WINDOW_MS` (fork F-3). `coolify_deploy_idempotency` is untouched and used only on the flag-OFF path.
- **D-10 Untrusted data.** Sources render `prompt` with `fenceUntrusted`; `routeHeal` appends `SCOPE_CONTRACT` once (idempotent) and forces
  `dangerously_skip_permissions: false` semantics as today. Propose-only: a heal never merges/deploys.
- **D-11 Source scoping.** `scheduled_task` heals fire only for non-internal tasks (`name` not `__internal_*`), status `failed` (not `skipped`/`skipped_quota`/`cancelled`),
  and never for runs that are themselves heal runs (recursion guard: `heal_events.metadata_run_id` membership) (fork F-5).
- **D-12 Seam isolation.** Guard test `heal-single-seam.test.ts`: no `pickSessionTarget(`, `sendToSupervisor(`, `launchSessionForUser(`,
  `listOnlineAgentSessionsForUser(`, or heal-path `dispatch(` in `api/coolify-webhook`, `scheduler/senders/triage`, `error-capture/`, `feedback/` outside the flag-OFF legacy branch markers; none imported in `hub/src/heal/` except the shared autospawn module's launch.
- **D-13 `POST /api/sessions/heal` stays out.** Separate external-service HTTP surface with its own Phase-4 reservation;
  not one of the four sources. Phase 7 only adds a pin that it keeps its `heal:` key prefix compatible with D-08 (same prefix, caller-supplied repo string).
- **D-14 DDL.** Additive, idempotent `heal_events` in `schema.sql`; no INSERT/UPDATE/DELETE there (`tools/schema-sql-lint.ts`); reaping of old rows via an
  opportunistic bounded DELETE in the DAL (same pattern as `claimDeployFailure`), not schema.sql.
- **D-15 No cap/gate semantic changes** (spec s8). Asserted by diffing no edits to `dispatch/gates.ts` values.

### Auto-defaults (cheap, reversible)

- auto-default: `heal_events.id` TEXT uuid default, as spec. Outcome vocabulary as D-02.
- auto-default: dedupe key per source: coolify `coolify:<application_uuid>:<fingerprint>`; scheduled `task:<task_id>:<error-signature>`; error-capture `err:<fingerprint>`; feedback `fb:<submission_id>`.
- auto-default: `repo_ident` from `repo_key` via `github://<owner>/<repo>` (same format `isRepoAutospawnAllowed` stores); sessions bound by path use `path://<abs>`. Verify the exact stored format against `orchestrator_autospawn_allowlist` rows in plan task 1.
- auto-default: notification channel = existing owner `notify_email` action path (E4A, `from_inbox_id`), plain subject `[heal] <repo>: no routable session`.
- auto-default: ledger row written BEFORE routing (claim) and `outcome` updated after; a crash between leaves an outcome-NULL row which still dedupes (fail closed on duplicates).
- auto-default: tests under `hub/test/` named per spec s6; e2e under `hub/test/e2e/` (real Postgres, Woodpecker `postgres:16`).

## 4. Incident fixtures (replayable from spec data, no prod DB)

Runs `8a6e0534`, `fa377e27`; task `0e16bf38` (`__internal_coolify_deployment`); Coolify apps `xxhodf65`, `zl7c3u88`. Shape reconstructed
from spec s1 + code: `scheduled_task_runs` rows, `task_id=0e16bf38...`, `session_id = NULL`, `status='pending'`,
`started_at` backdated >6h (so `run-reaper.ts:94` would select them), user with an online supervisor and NO live
repo session. Fixtures are created by seeding a test user, an `ensureInternalDeploymentTask`-shaped task row, and the two run rows via the DAL,
using the incident ids as literal ids/application_uuids (full UUIDs are not in the spec: pad deterministically, document it in the fixture header; short ids are the asserted labels).
Verified feasible: all inputs (task name/type, app uuids, null session, pending status, supervisor-online) are expressible with existing DAL inserts + `supervisor-registry` test seams.
Two replay variants are required because #346 already fixed the original shape:
- V1 (original): no agent session online => metadata run terminal `skipped`/`no_routable_session` < 5s, reaper sees zero candidates.
- V2 (residual hole): an UNRELATED agent session for another repo is online => with flag ON the event must NOT dispatch into it; outcome `no_routable_session` (or `autospawn_*` if allowlisted).
Not reproducible: exact prod timings, the real Coolify payload bytes; both irrelevant to the assertions.

## 5. Deferred

- Retiring `spawn-on-error.ts` / its flag (F-1 keeps it; revisit after one armed release).
- Folding `POST /api/sessions/heal` (D-13) and a per-source counter policy for QC keys (Phases 8/9).
- Heal-turn PTY support (spec out of scope; `governedAutomationPtyGate` owns it).
- Notification digesting across repos; UI surfacing of `heal_events` (GOV).
- Arming (allowlist population, `REMO_ORCHESTRATOR_*` flips): owner action, runbook only.
- Phase 7 docs sweep + openapi (`bun run docs:sync`) land in the phase's doc task; version bump is Phase 6's release.

## 6. Success criteria traceability

| SC | Requirement | Decisions | Proof |
|---|---|---|---|
| SC1 one seam, guard test | SH-01, SH-02 | D-02, D-12 | `heal-single-seam.test.ts`; `token-cap-coverage` scan |
| SC2 live / allowlisted spawn / fail-fast + one notice | SH-03, SH-04, SH-05 | D-03, D-04, D-05, D-06, D-09 | `heal-route-live`, `heal-route-autospawn`, `heal-route-no-target` |
| SC3 shared dispatch chain | SH-06 | D-07, D-08, D-10 | `token-cap-coverage` (extended), `session-start-senders-guard`, cost/token-capped user never calls `send` |
| SC4 no run pending to 6h | SH-05 | D-05, D-06, D-14, fixtures s4 | `e2e/heal-incident-replay.test.ts` V1+V2, reaper zero candidates, no `ended_at IS NULL` orphan |
| SC5 flag OFF true no-op | SH-07 | D-01 | `heal-flag-off.test.ts` (unset + unrecognized value; snapshot of three legacy paths) |

## 7. Risks to carry into planning

- Moving `defaultIsSessionLive` and extracting the autospawn core touches `inject.ts` (BSA, proven by e2e): the extraction must be behaviour-preserving with the existing `hub/test/e2e/orchestrator-*` suites green and unchanged.
- `launchSessionForUser` consumes a supervisor concurrency slot; every non-launch exit must release (existing contract). Reuse, do not reimplement.
- PGlite vs real Postgres divergence (memory: reference_pglite_vs_postgres_e2e_divergence): `heal_events` e2e must pass on postgres:16 in CI, not only locally.
