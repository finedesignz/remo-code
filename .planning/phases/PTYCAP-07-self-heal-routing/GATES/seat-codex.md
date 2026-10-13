F-1

VERDICT: ACCEPT-WITH-AMENDMENT (option C)

EVIDENCE: Option C has the smallest migration surface, but “reuse the AND-chain verbatim” is not currently safe. maybeAutospawnOffline checks flags, allowlist, supervisor availability, token cap, launch count, and counter-key resolution, then launches at hub/src/orchestrator/inject.ts:357-429; only afterward does it enter dispatch() at hub/src/orchestrator/inject.ts:443-471. Consequently, cost, threshold, rate, and the atomic lifetime reservation occur after the spawn—or, while offline, not until replay—because pipeline parking precedes preSendGuard at hub/src/dispatch/pipeline.ts:327-367. Also, the fork’s caller inventory is wrong: ask/dispatch.ts directly calls launchSessionForUser at hub/src/ask/dispatch.ts:154-164; the actual additional spawn-on-error caller is Revanote. Finally, launchSessionForUser returns send_failed without closing the reserved run at hub/src/telegram/launch.ts:187-220, unlike the explicit cleanup in hub/src/dispatch/spawn-on-error.ts:263-275.

AMENDMENT: Extract a governed pre-launch adapter, not the whole orchestrator-specific function. It must run the complete gate list and atomically reserve the lifetime/rate token before session.start, reuse that token idempotently on replay, and release it on launch failure or grace expiry. The launch primitive must also close/release its run on every non-launch exit. Correct the caller inventory and retain spawn-on-error only for legacy flag-OFF/Revanote behavior.

F-2

VERDICT: ACCEPT-WITH-AMENDMENT (option B)

EVIDENCE: Preserving explicit bindings is correct: error capture takes project.session_id directly at hub/src/error-capture/dispatcher.ts:75-87, and feedback dispatches key.session_id at hub/src/api/feedback-webhook.ts:133-142. Repo lookup is already user-scoped at hub/src/db/dal.ts:12-24, and getSession provides the necessary ownership check at hub/src/db/dal.ts:54-63. However, feedback_keys has no FK or cross-user constraint at hub/src/db/schema.sql:1414-1423, so trusting bound_session_id without revalidation creates a cross-tenant dispatch risk. Option B also conflicts with SH-02: a null repo_ident must fail fast at .planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md:88-96, while the recommendation would dispatch a live bound session even with no repo identity. It could also select a pty-interactive session despite the mandatory PTY denial at .planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md:256-258.

AMENDMENT: Resolve bound_session_id through getSession(boundId, userId); reject missing, deleted, rootless, foreign-user, PTY-ineligible, or repo-mismatched rows without repo fallback. Hydrate a canonical repo_ident from the owned session’s repo_key or valid absolute project_dir before routing. If no identity can be derived, take SH-05 even when the socket is live. Limit bound_session_id in the discriminated union to sources that legitimately possess a binding.

F-3

VERDICT: ACCEPT-WITH-AMENDMENT (option B)

EVIDENCE: A new ledger is necessary because coolify_deploy_idempotency only stores user, application, fingerprint, and timestamp at hub/src/db/schema.sql:781-788; it cannot represent generic sources, outcomes, provenance, or notification ownership. But the proposed “bucket plus previous-bucket check” is not fully atomic: claimDeployFailure performs the previous-bucket SELECT separately before its INSERT at hub/src/db/dal.ts:1867-1883, so simultaneous claims on opposite sides of a bucket boundary can both win. The proposed heal_events DDL also contains neither a bucket nor a notification-claim field at .planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md:200-213. Existing notification throttling is likewise check-then-insert without a unique constraint at hub/src/error-capture/notify.ts:53-89 and hub/src/db/schema.sql:731-737.

AMENDMENT: Use a transaction-scoped advisory lock keyed by user_id plus the source-namespaced dedupe_key, then check the actual time window and insert the winner. Add explicit trigger_run_id, dispatch_run_id, outcome, updated_at, and notification_claimed_at fields. Claim notification ownership with a conditional UPDATE ... WHERE notification_claimed_at IS NULL RETURNING. Specify the guarantee honestly as exactly one send attempt; true exactly-once delivery requires an outbox/provider idempotency contract.

F-4

VERDICT: ACCEPT-WITH-AMENDMENT (option B)

EVIDENCE: Per-user/per-repo is the right blast-radius unit. The lifetime implementation counts solely by counter_key, not user_id, at hub/src/dispatch/automation-controls.ts:274-286, so embedding userId is required to prevent cross-user budget collision. The external endpoint already constructs heal:<userId>:<repo> at hub/src/api/sessions.ts:396-418. The unresolved problem is identity stability: GitHub identities are normalized and lowercased by hub/src/lib/repo-key.ts:20-39, whereas allowlist lookup is an exact string comparison at hub/src/db/orchestrator-rows-dal.ts:482-492. Moreover, POST /heal uses the caller’s raw repo string, so it does not necessarily share a budget with a canonical github:// or path:// identity despite the fork’s claim.

AMENDMENT: Construct the four-source key only from a server-derived canonical repo_ident, never raw event text, and refuse null identities rather than emitting heal:<user>:null. Use the owned session’s stored identity for bound sources. Because D-13 leaves POST /heal unchanged, describe it as prefix-compatible but not necessarily the same per-repo budget. Add hub/src/heal/route.ts to the counter-key assignment guard currently enumerated at hub/test/counter-key-assignment-guard.test.ts:13-22.

F-5

VERDICT: REJECT->option C

EVIDENCE: Option B lacks a sound lifecycle boundary today. finalizeRun performs the terminal update at hub/src/scheduler/dispatcher.ts:771-778 but then invokes post-run handling before returning at hub/src/scheduler/dispatcher.ts:806-816; failed root tasks synthesize an owner email at hub/src/scheduler/post-run/dispatcher.ts:45-53 and :94-111. A heal hook “after finalizeRun” therefore runs too late to prevent duplicate notification ownership. Recursion identity is also ambiguous: HealEvent.metadata_run_id denotes the row that must become terminal at .planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md:85-92, but a scheduled failure’s triggering row is already terminal. The schema does provide triggered_by_run_id at hub/src/db/schema.sql:459-486, yet the recommendation does not define which child run routeHeal creates or how ancestry is atomically checked. Finally, “internal” is inferred from a mutable name prefix at hub/src/scheduler/post-run/dispatcher.ts:59-70 and :90-93 rather than durable provenance.

AMENDMENT: Temporarily amend SC1 to three callers and defer scheduled-task failures. Before restoring this source, define separate trigger_run_id and dispatch_run_id provenance, require every generated heal run to carry a heal-event ancestor, place the hook between the claimed terminal UPDATE and post-run notification processing, assign exactly one notification owner, use a durable internal-task marker, and test a failed child heal run cannot recursively create another event.


