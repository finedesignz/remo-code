# Gate panel seat B - safety / blast-radius lens (PTYCAP-07 forks)

Basis: 2026-07-11 token-burn class (machine event -> unbounded spawn/inject). Evidence read: hub/src/orchestrator/inject.ts:186-190,345-495; hub/src/dispatch/automation-controls.ts:290-313; hub/src/error-capture/dispatcher.ts:168-175; hub/src/feedback/dispatcher.ts:131-136; hub/src/api/sessions.ts:395-425; hub/src/db/dal.ts:1845-1885; schema.sql:781-788; 07-SPEC.md s1 bounds table.

## F-1 spawn primitive: ACCEPT-WITH-AMENDMENT (option c)
- Only maybeAutospawnOffline carries allowlist + supervisor-online + token pre-check + launch cap + counter key resolved BEFORE launch (inject.ts:361-403). spawn-on-error is flag-only (error-capture/dispatcher.ts:175, feedback/dispatcher.ts:136 pass ensureOnline with no allowlist, no counter key), so leaving it reachable on a heal path is the mis-routed-spawn risk. (a) widens blast radius into ask/dispatch.ts; (b) keeps two spawn paths.
- Amendments:
  1. When heal flag ON, error-capture and feedback MUST NOT pass `ensureOnline` (structural: guard test asserts no `ensureSessionOnline` import under error-capture/, feedback/, heal/ on the unified path). Otherwise REMO_SPAWN_ON_ERROR=1 silently re-opens an un-allowlisted spawn beside routeHeal.
  2. The shared chain function must write the `autospawn-launch` ledger row FAIL-CLOSED for heal. In inject.ts:441-452 it is best-effort ("a missed ledger row only under-counts"); an under-counted launch cap is an unbounded-spawn path under machine-triggered load. If the row cannot be written, refuse (do not treat as ok), or gate on the ledger/reserve count.
  3. Extraction is behaviour-preserving only: inject.ts e2e suites unchanged and green before any heal code lands.
  4. Heal reuses the orchestrator's `isOrchestratorEnabled()` AND `isAutospawnEnabled()` verbatim (spec SH-04); do not add a heal-only enable flag that bypasses them.

## F-2 bound-session resolution: ACCEPT-WITH-AMENDMENT (option b)
- (a) would re-route by repo and change targets (cross-repo landing); (c) is four routing stories. (b) preserves target.
- Amendments:
  1. Bound-but-OFFLINE session becomes an autospawn candidate ONLY through the full SH-04 chain including `isRepoAutospawnAllowed(user, repo_ident-of-that-session)`. A bound session must never be a way around the allowlist (today's spawn-on-error has none). If the bound session has no resolvable repo_ident -> SH-05 terminal, never spawn.
  2. Session ownership check (`sessions.user_id == event.user_id`) happens BEFORE any live check or launch; mismatch -> SH-05. Never fall back to repo resolution after an ownership failure (no silent re-route).
  3. Fall back to repo resolution only when `bound_session_id` is ABSENT, not when present-but-dead/ghost (ghost = defaultIsSessionLive false -> treat as offline candidate, same session).
  4. Orchestrator sessions (`is_orchestrator`) are excluded as heal targets (it is exempt from idle teardown and carries its own cadence state).

## F-3 dedupe/audit store: ACCEPT-WITH-AMENDMENT (option b, new heal_events)
- claimDeployFailure is Coolify-shaped, 2h opportunistic delete, no outcome (dal.ts:1852-1885); cannot back exactly-one-spawn / one-notification / recursion guard.
- Amendments:
  1. Claim is atomic INSERT ... ON CONFLICT DO NOTHING RETURNING on (user_id, source, dedupe_key, window_bucket) plus prev-bucket check, same as dal.ts:1869-1883; claim happens BEFORE any launch.
  2. Rows are NOT reaped on the 2h horizon the Coolify table uses; retain >= the 24h daily-launch-cap horizon and the recursion-guard lookup window, else a storm that outlives the dedupe window respawns. Additive DDL only (CREATE TABLE IF NOT EXISTS, no backfill in schema.sql - schema re-runs every boot).
  3. Store `outcome`, `notified_at` (claim by UPDATE ... WHERE notified_at IS NULL RETURNING), `spawned_run_id`, `metadata_run_id`. A claim that cannot be written (DB error) FAILS CLOSED: refuse, no spawn (7c).
  4. Per-user cap on distinct NEW claims per hour (e.g. reuse REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR style knob) so a flood of distinct fingerprints cannot create unbounded claims/notifications even when the spawn gates refuse.

## F-4 counter key: ACCEPT-WITH-AMENDMENT (option b, heal:<userId>:<repo_ident>)
- lifetimeCounterCheck refuses on missing key (automation-controls.ts:293), so a key is required; (a) is unbounded in aggregate by distinct fingerprints (the exact incident shape); (c) lets one repo starve all. (b) matches the existing POST /heal key (sessions.ts:410-411) so the external route and routeHeal share ONE budget.
- Amendments:
  1. Key MUST be user-scoped (as sessions.ts QC M2 comment) and resolved once before launch, failing closed on error (mirror inject.ts:306-312).
  2. Key must be the SAME string for POST /heal and routeHeal for the same repo (single builder function, unit test) - else the budget silently doubles.
  3. The inject-rate gate (sessionInjectRateGate) is keyed per session id; a heal into a fresh/absent session sees count 0 every time. Add a per-repo trailing-hour heal rate bound (from heal_events) as the rate control for the spawn step; do not rely on the per-session gate alone.
  4. Document that repo_ident case/URL normalisation is canonical (lowercase github://owner/repo) before keying, otherwise variants mint separate 1000-budgets.

## F-5 scheduled-task source: ACCEPT-WITH-AMENDMENT (option b)
- (a) recurses (a failed heal run is itself a failed scheduled run); (c) violates SC1. (b) acceptable only if the guard is structural and fail-closed.
- Amendments:
  1. Recursion guard order: check "this run_id is in heal_events.metadata_run_id/spawned_run_id, or the task is a task_type produced by routeHeal (triage/agent heal runs), or any ancestor chain" BEFORE claiming dedupe. Lookup error or unresolved ancestry -> treat as heal-originated (skip), never as safe.
  2. Exclude by task attributes, not names: `__internal_*` / enabled=false (dal.ts:1622), `task_type IN ('triage','teab','work','orchestrator')`, and runs with `status='skipped'` or `run_timeout` reaper failures (reaper-finalized runs must not trigger spawns; the 6h reaper path is the failure the phase removes).
  3. Dedupe key = task_id + normalized error signature, with a per-task heal ceiling per day in addition to the repo lifetime budget, so a cron task failing every minute cannot churn the budget.
  4. Hook is a single call after the terminal `failed` write, wrapped so a routeHeal throw never changes finalizeRun's result and never retries (no loop); behind the flag.
  5. Guard test: a heal-spawned run that fails produces zero further heal_events rows.
