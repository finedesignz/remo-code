# Phase 7 Forks (for panel lock)

Each fork has a recommendation grounded in the code read for `07-CONTEXT.md`. Locking = panel verdict; CONTEXT already assumes the recommendation.

## F-1 Which spawn primitive does the heal path use? (spec's open question)

Evidence: `inject.ts:351-495` `maybeAutospawnOffline` = allowlist + supervisor-online + token cap + launch-count cap + counter key + grace-park + replay re-entering `dispatch()` + ledger row (feeds the launch cap). `spawn-on-error.ts:156` = leak-safe reserve/start/poll but NO allowlist, NO launch-count cap, NO counter key, flag-only gating (`REMO_SPAWN_ON_ERROR`); it launches via its own `session.start` (pinned MACHINE in `session-start-senders-guard`).

- (a) Retire spawn-on-error now; error-capture/feedback use heal. Cleanest end state; touches `ask/dispatch.ts` (also a caller) - out of scope, bigger blast radius.
- (b) Keep spawn-on-error, make it call the same AND-chain. Two spawn code paths remain behind one chain; coupling to a poll-based wait.
- (c) Extract the BSA AND-chain into one shared function used by orchestrator inject AND `routeHeal`; leave spawn-on-error untouched and unused on the unified path (error-capture/feedback pass no `ensureOnline` when the flag is ON).

Recommendation: (c). One governed chain (matches the spec: "reused verbatim"), zero change for `ask`/flag-OFF behaviour, retirement deferred. Risk: refactor of proven `inject.ts` - mitigated by keeping its e2e suites unchanged.

## F-2 How does a source with an explicit bound session resolve its target?

Evidence: error-capture resolves `project.session_id` (`error-capture/dispatcher.ts:84`); feedback resolves `sub.sessionId` (`feedback/dispatcher.ts:106`). The spec's `HealEvent` has only `repo_ident`, so these sources would be re-routed by repo and could change target session vs today (also error projects may have no `repo_key`).

- (a) Closed union as spec; resolve everything by `repo_ident`. Behaviour change for session-bound sources; null repo => always SH-05 (a bound project with no repo_key would stop healing).
- (b) Add optional `bound_session_id`; if present and live => dispatch there; if present and offline => treat THAT session as the autospawn candidate; fall back to repo resolution only when absent.
- (c) Source-specific resolvers passed in as callbacks. Reintroduces four routing stories.

Recommendation: (b). Preserves today's target for two sources, keeps one decision site, additive to the union. Same-user check: the session row must belong to `user_id` (trust boundary).

## F-3 Dedupe/audit store: reuse `coolify_deploy_idempotency` or new `heal_events`?

Evidence: `claimDeployFailure` (`db/dal.ts:1852`) is keyed `(user_id, application_uuid, fingerprint)` - Coolify-shaped, 2h opportunistic delete, no outcome column, no notification claim. Spec s5 left this uncertain.

- (a) Reuse: no new table, but cannot dedupe other sources, cannot hold outcome/notification claim, would couple the generic seam to a Coolify column set.
- (b) New `heal_events` (additive DDL), atomic claim with window bucket + prev-bucket check mirroring the Coolify logic; Coolify table untouched for flag-OFF.

Recommendation: (b). Needed anyway for "exactly one notification per dedupe_key" and the recursion guard (D-11). Cost: one additive table.

## F-4 Lifetime counter key granularity

Evidence: today triage `triage:<app>` (`triage.ts:181`), agent `task:<id>`, `POST /heal` `heal:<user>:<repo>` (`sessions.ts:410`); error-capture/feedback carry NO counter key (Phase 4 delivery note: governed lists without a key refuse `lifetime_counter_key_missing` once governed-PTY is ON).

- (a) Per source per fingerprint (`heal:<src>:<dedupe_key>`): a storm of distinct fingerprints each gets 1000 - unbounded in aggregate.
- (b) Per user+repo `heal:<userId>:<repo_ident>`: one budget per repo across all four sources and the external `POST /heal`; repo-less events (null `repo_ident`) never reach a send (SH-05) so need no key.
- (c) Per user aggregate: one noisy repo starves all healing.

Recommendation: (b). Bounded per repo (matches the blast-radius table), shares the existing `heal:` prefix. Note: sources then share one 1000-lifetime budget per repo; exhaustion pages the owner via the Phase 4 warn/exhaust path.

## F-5 Scheduled-task failure as a source: scope and recursion

Evidence: `finalizeRun` (`scheduler/dispatcher.ts:740`) has no heal hook; post-run default email only for failed/blocked; internal tasks are `enabled=false` by design (`dal.ts:1622`). A heal run is itself a scheduled run (triage/agent), so naive "any failed run heals" can recurse (the 2026-07-11 loop class).

- (a) Heal every failed run. Recursion + noise.
- (b) Heal only: non-internal tasks, `failed` status, task has a repo-bound session, run not itself created by routeHeal (membership in `heal_events.metadata_run_id`/triggered chain), deduped by task+error signature.
- (c) Defer the source (document, do not wire). Violates SC1 (four sources).

Recommendation: (b). The recursion guard is a structural check (ledger membership), not a prompt instruction; a failed heal run can never spawn another heal. Hook placement: a single call after `finalizeRun` terminal write for `failed`, behind the flag.
