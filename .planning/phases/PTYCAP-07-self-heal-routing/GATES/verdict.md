# Phase 7 fork panel - LOCKED VERDICT

Seats: A (sonnet, refute-first), B (sonnet, blast-radius), Codex (gpt, read-only judge). Raw: seat-A.md, seat-B.md, seat-codex.md.

| Fork | A | B | Codex | LOCKED |
|---|---|---|---|---|
| F-1 spawn primitive | c+amend | c+amend | c+amend | (c) shared governed pre-launch adapter |
| F-2 bound sessions | b+amend | b+amend | b+amend | (b) bound_session_id, revalidated |
| F-3 dedupe store | b | b+amend | b+amend | (b) new heal_events table |
| F-4 counter key | b+amend | b+amend | b+amend | (b) heal:<userId>:<canonical repo_ident> |
| F-5 sched-task source | b+amend | b+amend | REJECT->c | (b) WITH codex's conditions as mandatory (keeps SC1) |

## Mandatory amendments (planner MUST encode each as a task + test)

F-1
- Extract a governed pre-launch adapter from inject.ts maybeAutospawnOffline (post-flag part only); heal has its OWN flag, not REMO_ORCHESTRATOR_ENABLED.
- The full gate list AND the atomic lifetime reservation run BEFORE session.start (codex: today cost/threshold/rate/lifetime run after spawn, inject.ts:357-471, pipeline.ts:327-367). Reservation reused idempotently on replay; released on launch failure / grace expiry.
- autospawn-launch ledger row written fail-closed (inject.ts:441-452 is best-effort today).
- Launch primitive closes its reserved run on every non-launch exit (telegram/launch.ts:187-220 leaks send_failed).
- Error-capture and feedback stop using ensureOnline when the heal flag is ON. spawn-on-error stays only for flag-OFF / Revanote.
- Correct the caller inventory (ask/dispatch.ts calls launchSessionForUser directly; Revanote is the other spawn-on-error caller).

F-2
- bound_session_id resolved via getSession(id, userId); reject missing / deleted / rootless / foreign-user / PTY-ineligible / repo-mismatched with NO silent repo fallback.
- Hydrate canonical repo_ident from the owned session; if none derivable -> no_routable_session even if live.
- Offline bound session autospawns only if its repo is allowlisted.
- bound_session_id only on sources that legitimately carry a binding (discriminated union).

F-3
- heal_events claim atomic: transaction-scoped advisory lock on (user_id, source-namespaced dedupe_key), window check, insert. Unique index on (user_id, source, dedupe_key, window_bucket) as backstop.
- Columns: trigger_run_id, dispatch_run_id, outcome, updated_at, notification_claimed_at. Notification ownership via conditional UPDATE ... WHERE notification_claimed_at IS NULL RETURNING. Guarantee stated as "exactly one send attempt".
- Retention >= 24h. Per-user cap on new claims per hour. Coolify table untouched for the flag-OFF path.

F-4
- Key built only from server-derived canonical repo_ident (lib/repo-key.ts normalization); null identity refused (never heal:<u>:null).
- One shared key builder; POST /heal left unchanged and documented as prefix-compatible only.
- Add hub/src/heal/route.ts to hub/test/counter-key-assignment-guard.test.ts.
- Per-repo hourly rate bound (session-keyed rate gate cannot see a fresh session). Exhaustion reported in outcome.

F-5
- Fire only on a real failed transition of a non-internal, repo-bound task; exclude reaper-finalized runs.
- Hook sits between the claimed terminal UPDATE and post-run notification processing (dispatcher.ts:771-816); exactly one notification owner (heal path suppresses the duplicate failure email when it claims).
- Durable provenance: trigger_run_id vs dispatch_run_id; every heal-generated run carries a heal-event ancestor (heal_events membership / triggered_by_run_id). Recursion guard runs BEFORE the dedupe claim and fails closed; durable internal marker, not name prefix alone.
- Test: a failed child heal run cannot create another heal event. Per-task daily heal ceiling.
