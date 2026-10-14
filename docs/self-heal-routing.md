# Unified Self-Heal Routing (PTYCAP Phase 7)

Source of truth for the one seam that routes a machine failure to a session that can fix it.
Code: `hub/src/heal/` (seam `route.ts::routeHeal`), ledger `hub/src/db/heal-events-dal.ts`,
shared launch `hub/src/dispatch/governed-launch.ts`, liveness `hub/src/sessions/liveness.ts`.
Planning record: `.planning/phases/PTYCAP-07-self-heal-routing/`.

Everything here is behind `REMO_HEAL_UNIFIED` (default OFF). With the flag OFF every source runs
its previous code path unchanged and `routeHeal` is never called.

## 1. Why it exists

2026-07-11 incident shape: a Coolify deploy-failure run was routed to a session that was not
there. The supervisor was online but no agent session was, so the run sat in `pending` with a
NULL `session_id` until the 6h stale-run reaper. PR #346 already closed that exact shape for the
Coolify path (the metadata run is finalized `skipped`/`no_routable_session` at once). What stayed
open, and what this seam fixes:

- a failure for repo X could still be dispatched into any online agent session bound to repo Y;
- an offline session bound to the failing repo was never woken under an allowlist;
- the Coolify path failed open (dispatched anyway) when its dedupe claim or routability probe threw;
- an un-routable failure produced zero notifications;
- a failed scheduled task had no heal source at all;
- error-capture and feedback each hand-rolled their own pipeline dependencies and gate list.

## 2. Sources and the event union

Four sources build a `HealEvent` (`hub/src/heal/types.ts`, a closed zod discriminated union,
`.strict()` per variant, `parseHealEvent` throws on any violation) and call `routeHeal`:

| Source | Builder | Dedupe key | `bound_session_id` |
|---|---|---|---|
| `coolify_deploy` | `heal/sources/coolify.ts` | `coolify:<application_uuid>:<hash(repo,sha)>` (time-free) | never (rejected by the schema) |
| `scheduled_task` | `heal/sources/scheduled-task.ts` | `task:<task_id>:<error-signature>` | never (resolved from the task's session) |
| `error_capture` | `heal/sources/error-capture.ts` | `err:<project>:<fingerprint>` | the project's bound session |
| `feedback` | `heal/sources/feedback.ts` | `fb:<submission_id>` | the key's bound session |

Only `error_capture` and `feedback` carry a binding, because only they have one (a discriminated
union, not an optional field everywhere). The project id is part of the error-capture key because
the fingerprint is shared with the production `/api/sentry` path and would otherwise collapse the
same error from two apps. Every `prompt` is rendered with `fenceUntrusted`; `routeHeal` appends
`SCOPE_CONTRACT` once and normalizes punctuation to ASCII. A heal is propose-only: it never
merges or deploys.

## 3. Routing decision table

`routeHeal(event)` returns one `HealOutcome`. Order of work: validate the event, recursion/provenance
guard (before any claim, fails closed), resolve the target, claim the ledger row, per-repo hourly
bound, then route.

| Target resolved | Result |
|---|---|
| a live session bound to the repo (or the source binding), ghost-aware liveness | dispatch through the shared pipeline: `dispatched_live`, zero launch calls |
| no live session, an OFFLINE session row bound to the repo, repo on the allowlist, heal armed, supervisor online | governed autospawn: `autospawn_launched` or `autospawn_parked`; the request is delivered after the session connects (`dispatched_after_spawn` is stored in the ledger) |
| anything else (no session for the repo, not allowlisted, not armed, supervisor offline, bound session rejected) | fail fast in the same request: `no_routable_session` plus one owner notification |

There is no capacity fallback and no stranger session: `listOnlineAgentSessionsForUser` is never
called under `hub/src/heal/` (guard test). The target is found with an owner-scoped lookup.

Bound-session validation (`heal/resolve.ts`): the session must exist for this user (`getSession(id,
userId)`), not be rootless, not be PTY-ineligible, and its derived canonical repo ident must match
the event. Reasons: `bound_session_unavailable`, `bound_session_rootless`,
`bound_session_pty_ineligible`, `repo_mismatch`, `no_repo_identity`, `no_session_for_repo`. There is
never a silent fallback to a repo-keyed session. When the event has no `repo_ident`, it is derived
from the owned session; if none is derivable the event is `no_routable_session` even if a session
is live.

Outcome vocabulary (persisted verbatim in `heal_events.outcome` by `outcomeToString`):
`dispatched_live`, `autospawn_launched`, `autospawn_parked`, `dispatched_after_spawn`,
`no_routable_session`, `deduped`, `refused:<reason>`, `failed:<reason>`. Refusal reasons include
`invalid_event`, `heal_disabled`, `heal_provenance`, `heal_guard_error`, `repo_rate_bound`,
`session_busy`, the pipeline gate reasons, and the claim reasons (`duplicate` maps to `deduped`).
`no_routable_session` reasons include `autospawn_not_armed`, `not_allowlisted`,
`supervisor_offline`, `target_went_offline`.

## 4. Shared governed launch

`governedLaunch` (`hub/src/dispatch/governed-launch.ts`) is the post-flag autospawn chain that used
to be private to the orchestrator (`maybeAutospawnOffline`). It has two policies:

- legacy: the orchestrator, byte-identical order and strings, best-effort ledger row;
- heal: a pre-launch governor runs the full gate list and the atomic lifetime reservation BEFORE
  the spawn, writes the `autospawn-launch` ledger row BEFORE the spawn and refuses fail-closed if
  that write fails, and releases the reservation on every refusal and failed launch. The spawn is
  last, so a refusal never costs a supervisor slot.

The reservation is idempotent on replay (same token `heal:<eventId>`). `launchSessionForUser` now
closes its reserved run on every non-launch exit (it previously leaked a run on `send_failed` or a
post-reservation throw), which keeps the supervisor concurrency counter honest. One deadline timer
(`REMO_HEAL_SPAWN_TIMEOUT_MS`) bounds the wait for the launched session; no polling. The liveness
predicate (`isSessionLive`) moved out of `orchestrator/inject.ts` into `sessions/liveness.ts` and
is shared by the orchestrator and the heal seam (moved, not copied).

Gate chain (one constant, `route.ts`, found by the `token-cap-coverage` scan), in the Phase 4
composition: kill switch first, lifetime counter last:
`automationKillSwitchGate`, `thresholdGate`, `dailyCostCapGate`, `dailyTokenCapGate`,
`sessionInjectRateGate`, `automationLifetimeCounterGate`. No gate value changed in this phase.

## 5. The `heal_events` ledger

Additive, idempotent DDL in `schema.sql` (no data statements there). The claim
(`claimHealEvent`) is a single transaction: a transaction-scoped advisory lock on
`(user_id, source-namespaced dedupe_key)`, a real elapsed-time window check against
`created_at`, a per-user claim cap, then the insert. A unique index on
`(user_id, source, dedupe_key, window_bucket)` is the backstop, not the mechanism. A claim failure
propagates (fail closed); there is no dispatch-anyway branch.

Columns of note: `outcome`, `repo_ident`, `session_id`, `trigger_run_id` (the run that failed) vs
`dispatch_run_id` (the run the heal created), `notification_claimed_at`, `updated_at`. Every
heal-generated run is traceable to a heal event, which is what the recursion guard checks.
A row written before routing with a NULL outcome still dedupes (a crash mid-route fails closed on
duplicates). Retention is at least 24h (`REMO_HEAL_RETENTION_HOURS`, floor 24), pruned
opportunistically by a bounded DELETE in the DAL before a claim; a prune failure is logged and
never blocks a claim. The Coolify `coolify_deploy_idempotency` table is untouched and used only on
the flag-OFF path.

## 6. Notification guarantee

`heal/notify.ts::notifyOnce` claims ownership with a conditional update
(`UPDATE ... WHERE notification_claimed_at IS NULL RETURNING`) and then makes exactly one send
attempt, subject `[heal] <repo>: <reason>`. The guarantee is exactly one send attempt, not
exactly-once delivery: a send that fails is not retried and never changes the outcome. A
`deduped` event sends nothing. For scheduled-task failures, when the heal path claims the
notification (`no_routable_session`, `notified: true`) the default failure email is suppressed
(`suppressDefaultFailureEmail`), so there is a single owner.

Known residual: `notified` is surfaced only on `no_routable_session`. A `refused` or `failed`
outcome on the scheduled-task source also sends the heal owner notice and still lets the default
failure email go: two messages on two channels, never zero.

## 7. Counter key and the per-repo bound

The Phase 4 lifetime counter key is `heal:<userId>:<canonical repo_ident>`, built only by
`buildHealKey` (`heal/counter-key.ts`) from a server-derived canonical ident
(`lib/repo-key.ts` normalization, `github://owner/repo` lowercase or `path://<abs>`). A null or
non-canonical ident throws `HealKeyError`; `heal:<u>:null` can never exist. The key is assigned in
`route.ts` only (allow-listed in `counter-key-assignment-guard.test.ts`).

Because the session-keyed inject-rate gate cannot see a freshly launched session, a per-repo
hourly bound (`REMO_HEAL_MAX_PER_REPO_HOUR`, counted from the ledger) refuses with
`refused:repo_rate_bound`. Exhaustion is reported in the outcome.

`POST /api/sessions/heal` is unchanged. Its key shares only the `heal:` prefix with the seam
(prefix-compatible), with a caller-supplied repo string, so it does not necessarily share the
per-repo budget. See `self-heal-integration.md`.

## 8. Scheduled-task failure source

A heal is built from `finalizeRun` only when all hold: the status transition is a real
`failed` (not `skipped`, `skipped_quota`, `cancelled`; not an `only_if_active` no-op); the failure
is not `run_timeout` (reaper-finalized runs are excluded); the task is non-internal (`is_internal`
column, with the legacy `__internal_` name prefix also honoured, fail closed on a missing row); the
run is not itself heal-derived (provenance probe; a probe error means no event); the task's
session resolves to a non-rootless canonical repo; and the per-task daily count is below
`REMO_HEAL_MAX_PER_TASK_DAY`. The hook sits between the task load and post-run notification
processing and is wrapped so an error resolves to "hook off" (the legacy email path continues).
A failed child heal run cannot create another heal event.

## 9. Flag, knobs, arming, boot sweep

All read at call time in `hub/src/heal/config.ts` (the only module that reads `REMO_HEAL_*`; the
flag itself lives in the leaf `heal/flag.ts`). A non-positive, non-finite or non-numeric value
falls back to the default and never disables a bound.

| Variable | Default | Meaning |
|---|---|---|
| `REMO_HEAL_UNIFIED` | OFF | master flag; only `1`, `true`, `yes`, `on` (case-insensitive, trimmed) turn it ON |
| `REMO_HEAL_DEDUPE_WINDOW_MS` | 900000 | dedupe window per `(user, source, dedupe_key)` |
| `REMO_HEAL_SPAWN_TIMEOUT_MS` | 25000 | deadline for a launched session to connect |
| `REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR` | 30 | per-user cap on new claims per hour |
| `REMO_HEAL_MAX_PER_REPO_HOUR` | 4 | per-repo hourly dispatch bound |
| `REMO_HEAL_MAX_PER_TASK_DAY` | 3 | per-scheduled-task daily heal ceiling |
| `REMO_HEAL_RETENTION_HOURS` | 48 | ledger retention, floor 24 |

Arming for the autospawn branch needs the heal flag AND `REMO_ORCHESTRATOR_AUTOSPAWN`
(`healAutospawnArmed`). It does NOT depend on `REMO_ORCHESTRATOR_ENABLED`. The allowlist
(`orchestrator_autospawn_allowlist`) is shared with the orchestrator and EMPTY by default, so a
default configuration spawns nothing: live dispatch and fail-fast still work, autospawn is a
no-op. Arming is an owner action; steps are in `orchestrator-autospawn-runbook.md`.

Boot sweep (`heal/sweep.ts`, called from `hub/src/index.ts` only when the flag is ON, imported
lazily): terminalizes launches stranded by a hub restart (`autospawn_launched` and
`autospawn_parked` rows past the deadline), releases their reservations, and finalizes the metadata
run. With the flag OFF it performs zero reads.

## 10. Flag OFF and the caller inventory

Flag OFF is the previous behaviour byte for byte: each source's legacy body is kept verbatim
between `heal-legacy-path:begin/end` markers and `routeHeal` is not reached (proved by
`hub/test/heal-flag-off.test.ts` across unset, empty and unrecognized values, and by static
checks). The spawn-primitive inventory, corrected:

- `dispatch/spawn-on-error.ts` (`REMO_SPAWN_ON_ERROR`) stays for flag-OFF error-capture and
  feedback, and for Revanote. With the heal flag ON, error-capture and feedback no longer use the
  ensure-online hook.
- `ask/dispatch.ts` calls `launchSessionForUser` directly (it does not go through spawn-on-error).
- The orchestrator inject uses `governedLaunch` (legacy policy); the heal seam uses it (heal policy).

## 11. Guards

`heal-single-seam.test.ts`: no capacity picker, supervisor-frame sender, launch call, online-agent
lister or direct dispatch in the four source areas outside the legacy markers; inside
`hub/src/heal/` one gates literal, dispatch only as `deps.dispatch` in `route.ts`, lifetime key only
from `buildHealKey`, no `session.start`, no `ensureOnline`. Extended guards:
`token-cap-coverage`, `counter-key-assignment-guard`, `session-start-senders-guard`,
`launch-callers-guard`. Replay of the incident (V1: no agent session; V2: an unrelated agent
session online) is `hub/test/e2e/heal-incident-replay.e2e.test.ts`, which needs
`REMO_E2E_DB_URL` (Woodpecker `postgres:16`; skipped without it).

## 12. Out of scope (not shipped)

Retiring `spawn-on-error` and its flag; folding `POST /api/sessions/heal` into the seam; PTY heal
turns (`governedAutomationPtyGate` owns PTY); UI surfacing of `heal_events`; notification
digesting across repos; populating the allowlist or flipping any `REMO_ORCHESTRATOR_*` flag.
