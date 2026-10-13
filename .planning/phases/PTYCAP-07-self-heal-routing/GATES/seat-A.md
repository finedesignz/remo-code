# Gate seat A (refute-first) - PTYCAP-07 forks

## F-1 spawn primitive - ACCEPT-WITH-AMENDMENT (c)
No better option: (a) touches ask/dispatch.ts, (b) keeps a poll path. But the shared chain as written in inject.ts is not heal-ready:
- `inject.ts:~356-358` returns `no_session` unless `autospawn.isBuild` and `deps.isOrchestratorEnabled() && deps.isAutospawnEnabled()` (controller.ts:57,69). Verbatim reuse makes heal spawning depend on REMO_ORCHESTRATOR_ENABLED (currently 0 in prod after the 07-11 incident) and an orchestrator-shaped `isBuild` input.
- Chain is keyed on an existing `sessionId` (launchSessionForUser, graceParkPending(sessionId)); a repo with NO session row cannot spawn.
Amendment: extract only the post-flag part (allowlist, supervisor online, token cap, launch cap, counter key, grace-dedupe, launch, ledger). Each caller supplies its own enable predicate; heal's = REMO_ORCHESTRATOR_AUTOSPAWN AND a new heal flag (default OFF), NOT REMO_ORCHESTRATOR_ENABLED. Spec must state how an absent session row is created (create a repo-bound session row first, same user, then launch). Keep inject e2e suites unchanged as the regression proof.

## F-2 bound session - ACCEPT-WITH-AMENDMENT (b)
error-capture uses project.session_id (error-capture/dispatcher.ts:84); feedback uses sub.sessionId. (b) is right.
Amendments: (1) bound session row must match user_id AND, if both known, its repo_key must equal event.repo_ident, else ignore binding. (2) bound-offline autospawn still requires the allowlist on repo_ident; null repo_ident + offline bound session => SH-05 (never spawn unallowlisted). (3) bound-LIVE with null repo_ident dispatches but needs a counter key: use `heal:<userId>:session:<sessionId>` so no governed list hits lifetime_counter_key_missing.

## F-3 dedupe store - ACCEPT (b)
claimDeployFailure is Coolify-shaped; no outcome/notification columns. New additive `heal_events` correct (idempotent DDL only, schema.sql reruns every boot). Amendment: unique index on (user_id, source, dedupe_key, window_bucket) with INSERT ... ON CONFLICT DO NOTHING for the atomic claim; no backfill inline.

## F-4 counter key - ACCEPT-WITH-AMENDMENT (b)
sessions.ts:410 already uses `heal:${userId}:${repo}` (user-scoped per QC M2) - (b) extends the existing key. Amendments: (1) canonicalize repo_ident to ONE form for the key and make POST /heal use the same normalization, or the two budgets silently split; (2) note shared 1000 budget means a feedback/error flood can lock out Coolify heal for that repo - exhaustion must page owner once (Phase 4 path) and be visible in HealOutcome (`refused:lifetime_exhausted`); (3) reserve ONCE per heal event (not per hop) and release on every non-start exit, as sessions.ts does.

## F-5 scheduled-task source - ACCEPT-WITH-AMENDMENT (b)
(a) recursion, (c) violates SC1; (b) right. Amendments: (1) recursion guard must be structural AND cover both ids: run is skipped if its id appears in `heal_events.metadata_run_id` OR its task is a heal-spawned/`__internal_*` task; membership check runs inside the same transaction as the claim. (2) Hook only on `failed` terminal write that actually transitioned (use the finalizeRun only_if_active result) so a reaper `run_timeout` vs racing finalizer cannot double-fire. (3) A heal-run failure itself is never healed but still emails owner once. (4) dedupe_key = task_id + error signature hash, never raw error text.
