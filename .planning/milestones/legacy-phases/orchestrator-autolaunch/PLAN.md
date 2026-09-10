# PLAN — Orchestrator Auto-Launch + Telegram Default Target

**Branch:** `feat/orchestrator-autolaunch` · **Worktree:** `C:\Users\artic\GitHub\remo-code-orchestrator-autolaunch`
**Author:** Backend Architect · **Status:** plan-only (do NOT implement from this doc without the per-phase QC gate)

---

## 1. Executive Summary

### What changes
Make the **root orchestrator session auto-exist** and **become Telegram's default target**, so a freshly-linked Telegram chat (or any first message) reaches a live Claude session instead of the dead-end "No default session set" reply.

Three behavioral changes, in dependency order:

1. **Auto-launch the orchestrator on `supervisor.hello`** when the user has no open orchestrator session and hasn't explicitly disabled it. Hooked alongside the existing PR-#133 orphan-resume sweep in `hub/src/ws/agent.ts`.
2. **Telegram dispatch falls back to the orchestrator session** when `telegram_default_session_id` is null — and auto-launches the orchestrator on inbound Telegram if it isn't running (reusing the existing `agent_offline → runDoctor autoheal` path).
3. **Enablement default flips to on-by-default**, but a user who *explicitly* disabled the orchestrator in the UI is never overridden.

### Security recommendation (the load-bearing decision — read first)
**Adopt option (a) with a hardening clamp.** Allow the machine-triggered auto-launch path to mint the orchestrator key **without `requireRecentAuth()` step-up**, because the supervisor already authenticated over `/ws/agent` with a valid `api_keys` row, and that key is *already* full-power (it spawns arbitrary Claude processes with FS access on the host). The orchestrator key grants nothing the supervisor connection doesn't already imply. **BUT**: gate the auto-mint behind the persisted enablement flag (so a compromised supervisor key cannot *turn on* the orchestrator for a user who disabled it), keep the key server-side-only (never echoed over WS — unchanged), and continue to require `requireRecentAuth()` for the *interactive* `POST /api/orchestrator/start` and `PUT /api/orchestrator` mutation paths. Threat model + rationale in §4 decision 3.

### Phase list
- **P0 — Schema & migration** (enablement default + migrate existing users; idempotent).
- **P1 — Hub auto-launch hook** (`maybeAutoLaunchOrchestrator` in agent.ts `supervisor.hello`, idempotent, race-safe).
- **P2 — Telegram default = orchestrator** (dispatch fallback + inbound auto-launch).
- **P3 — Supervisor/UI touch-ups** (OrchestratorTab "auto-launch on connect" copy; supervisor side needs **no** change — `session.start` with `orchestrator` already works).
- **P4 — Tests & docs** (unit + integration; update `docs/auth.md` + `docs/telegram-bridge.md` + CLAUDE.md orchestrator rollup).

---

## 2. Current-State Findings (file:line evidence)

### Orchestrator is opt-in and never auto-starts
- `hub/src/db/schema.sql:641` — `orchestrator_enabled BOOLEAN NOT NULL DEFAULT false`. The feature ships **off**; the user never enabled it → no orchestrator session exists. **This is the root cause of "telegram didn't work."**
- `hub/src/api/orchestrator.ts:78-83` — `POST /start` hard-refuses with `409 orchestrator_disabled` unless `orchestrator_enabled` is true.
- `hub/src/api/orchestrator.ts:91-108` — START cwd resolution: preferred supervisor (when online) → first online → `roots[0]`. Refuses with `no_online_supervisor` / `supervisor_has_no_roots`.
- `hub/src/api/orchestrator.ts:126-130` — mints a fresh full-power hub key via `mintOrchestratorApiKey`; raw key (`rawHubApiKey`) goes into the `session.start.orchestrator.hub_api_key` field **only** (line 156), never echoed in the HTTP response (lines 164-169).
- `hub/src/db/orchestrator-dal.ts:89-103` — `mintOrchestratorApiKey` revokes prior `purpose='orchestrator'` rows, inserts `capabilities=ARRAY['agent','supervisor','orchestrator']`. NEVER touches `purpose='supervisor'`.
- `hub/src/db/orchestrator-dal.ts:50-84` — `findOpenOrchestratorSession` / `createOrchestratorSession`; the `INSERT` relies on the partial unique index for race safety.

### The one-orchestrator invariant
- `hub/src/db/schema.sql:647-649` — `CREATE UNIQUE INDEX idx_sessions_orchestrator_unique ON sessions(user_id) WHERE is_orchestrator = true AND deleted_at IS NULL`. **Per-user, not per-(user,host).** Two supervisors / a double-connect must NOT each create a row → concurrent INSERTs will collide on this index. Auto-launch must handle the unique-violation gracefully (treat as "already exists, reuse").
- `hub/src/db/schema.sql:662-663` — `idx_api_keys_user_purpose_active ON api_keys(user_id, purpose) WHERE revoked_at IS NULL`. One active orchestrator key per user; re-mint revokes the old. Safe under re-launch.

### Auth gating on the REST surface
- `hub/src/index.ts:296-299` — `/api/orchestrator` + `/api/orchestrator/*`: mutating methods get `requireRecentAuth()` (15-min step-up) **and** `userMutationLimit`. GET is exempt.
- `hub/src/index.ts:226` — license gate `requireActiveLicense({ readOnlyOk: true })` — GET passes during EXPIRED grace; mutations are ACTIVE-only.
- The auto-launch path is **machine-triggered from a WS handler**, not an HTTP request — it does NOT pass through `hub/src/index.ts` middleware at all. So it bypasses `requireRecentAuth` by construction. The decision in §4.3 is whether that's acceptable (recommendation: yes, gated on the enablement flag).

### Supervisor-connect lifecycle (the hook site)
- `hub/src/ws/agent.ts:568-663` — the `supervisor.hello` handler. Order today: `upsertSupervisor` → `registerSupervisor` → `updateSupervisorState('idle')` → hello_ack with sentry creds → stale-row reap → **auto-resume orphans** (`resumeOrphansForSupervisor`, lines 627-647) → `broadcastToUser(supervisor_update)` → scheduler grace drain. **The auto-launch hook belongs right after the orphan-resume block (line ~647), before the broadcast** — so a freshly auto-launched orchestrator run is reflected in the same `supervisor_update` broadcast.
- `hub/src/orchestrator/orphan-resume.ts:99-205` — the orphan sweep. Note: the orchestrator session **also** produces `session_runs` rows, so once an orchestrator run exists, the *existing* orphan-resume path will already respawn it on reconnect (subject to the `user_stopped` sentinel, 24h stale cap, restart cap, and `reserveSessionSlot`). **This means auto-launch only needs to handle the "no orchestrator session row exists yet" case** — the resume path covers "exists but its run is orphaned." Critical to avoid double-spawning.

### Telegram "didn't work" path (confirmed)
- `hub/src/api/telegram-webhook.ts:201-204` — `if (!user.telegram_default_session_id)` → replies `"No default session set. Use /list and /session <id> to pick one."` and returns `no_session`. **This is the exact dead end.**
- `hub/src/api/telegram-webhook.ts:255-285` — when a default IS set, dispatch runs; `agent_offline` triggers `bufferReplay` + `runDoctor({autoheal:true})` (lines 619-637), which calls `launchSessionForUser` and replays the buffered message once the runner is live. **This autoheal machinery is exactly what we reuse for "orchestrator default but not running."**
- `hub/src/telegram/commands.ts:141-182` — `prewarmAfterLink` already picks the most-recently-used session on `/start` link and sets it as default + fires `launchSessionForUser`. It only runs when `existingDefault` is null and the user has ≥1 session. **It does NOT consider the orchestrator and does nothing for a brand-new user with zero sessions** — which is the fresh-install case the feature targets.
- `hub/src/telegram/bridge.ts` (outbound) — `onFinal` forwards `assistant_message:final` to every user whose `telegram_default_session_id === e.sessionId` (via `getUsersWithTelegramDefaultSession`). If the default is the orchestrator session id, outbound "just works" with no bridge change.
- `hub/src/db/dal.ts:1669-1672` — `setTelegramDefaultSession(userId, sessionId)`. `dal.ts:1619-1621` — `getUserByTelegramChatId` selects `telegram_default_session_id`.

### Concurrency / cost gate (unchanged, must stay on path)
- `hub/src/sessions/budget.ts` — `reserveSessionSlot(userId, supervisorId)`: `SELECT … FOR UPDATE` on the supervisor row, `cap = min(override ?? budget, budget*2)`, rejects `at_capacity` when open `session_runs >= cap`. Every spawn path (orphan-resume line 163, launch.ts line 107) goes through it. **Auto-launch MUST too.**
- Note: `hub/src/api/orchestrator.ts` POST /start does **NOT** currently call `reserveSessionSlot` or `createRun` — it creates the `sessions` row and sends `session.start` with a self-generated `run_id` (line 141, `crypto.randomUUID()`), bypassing the hub concurrency gate and the `session_runs` ledger. **This is a pre-existing gap.** The auto-launch path should NOT copy that bug — it should reserve a slot + create a `session_runs` row so the orchestrator run participates in capacity accounting and is auto-resumable. See §4.6 + Invariant Register.

### Supervisor side already supports it
- `supervisor/src/hub-client.ts:549-564` — `onSessionStart` recognizes the `orchestrator` field and routes through `ProcessManager`.
- `supervisor/src/process-manager.ts:263` — `requireGitRepo` gate is bypassed `&& !spec.orchestrator`. Good for root-folder cwd.
- `supervisor/src/runners/claude-runner.ts:95-107` — injects `REMO_HUB_API_KEY`/`REMO_HUB_URL`, writes `.remo-orchestrator.md`. **No supervisor change needed.**

---

## 3. Design Decisions (each question, recommended answer + rationale)

### 4.1 Trigger & idempotency  ⟶ **Auto-launch on `supervisor.hello` when no OPEN orchestrator session exists; reuse the orphan-resume hook site; rely on the partial unique index for race safety.**
- **Trigger:** in the `supervisor.hello` handler (`hub/src/ws/agent.ts` ~line 647, right after orphan-resume), call a new `maybeAutoLaunchOrchestrator({ userId, supervisorId, hostname, roots })`.
- **Idempotency gate (in order):**
  1. Read prefs; bail if `orchestrator_enabled=false` AND `orchestrator_disabled_explicitly=true` (new column, §4.2).
  2. `findOpenOrchestratorSession(userId)` — if a row exists, **do nothing**: the orphan-resume sweep that ran moments earlier already respawned its run if it was orphaned. Auto-launch only creates the row when it's **absent**.
  3. Create the session row inside a `try/catch` on **unique-violation** (`idx_sessions_orchestrator_unique`). On violation (a sibling supervisor connected concurrently), re-`findOpenOrchestratorSession` and treat as "already launched" — never spawn twice.
- **Two supervisors:** the first to win the unique insert owns the orchestrator row; the second sees the violation and no-ops. The cwd is pinned to the winning supervisor's `roots[0]` and its hostname (matching the existing preferred-supervisor logic in `orchestrator.ts:91-108`). A later `POST /api/orchestrator/start` can still relocate it.
- **Double-connect of one supervisor:** second hello finds the existing open row → no-op.
- **Rationale:** mirrors the proven orphan-resume idempotency model; the DB unique index is the hard backstop, not application-level locking.

### 4.2 Enablement default ⟶ **Flip default to `true` for NEW users; migrate existing users to enabled; add an explicit-disable sentinel so the user always wins.**
- **Schema:** change column default to `true` for fresh rows; add `orchestrator_disabled_explicitly BOOLEAN NOT NULL DEFAULT false`.
- **Migration (idempotent, additive):**
  - `ALTER TABLE users ALTER COLUMN orchestrator_enabled SET DEFAULT true;`
  - `ALTER TABLE users ADD COLUMN IF NOT EXISTS orchestrator_disabled_explicitly BOOLEAN NOT NULL DEFAULT false;`
  - `UPDATE users SET orchestrator_enabled = true WHERE orchestrator_disabled_explicitly = false;` — turns it on for the back-catalog without overriding anyone who later opts out.
- **Wire the sentinel:** `PUT /api/orchestrator` with `enabled:false` must set `orchestrator_disabled_explicitly=true`; `enabled:true` clears it. The auto-launch gate (§4.1 step 1) checks the sentinel, not just `orchestrator_enabled`, so re-enabling defaults never resurrect a deliberately-disabled orchestrator on the next migration.
- **Rationale:** "auto-exist by default" is the feature ask; the sentinel honors global rule "don't fight the user." A single boolean default flip without the sentinel would re-enable on every migration — unacceptable.

### 4.3 SECURITY — the key fork ⟶ **Option (a): no step-up for the auto-launch mint, gated on the enablement flag. (Recommended; load-bearing.)**
- **Threat model.** What can a compromised supervisor `api_keys` row already do *today*, before this change? It can connect `/ws/agent`, receive `session.start`, and spawn arbitrary Claude processes on the host with full FS access (subject to `assertWithinRoots`). It can read every activity event for the user's sessions. The orchestrator key adds: the ability for *Claude inside the orchestrator process* to call the hub REST API as that user (start/stop other sessions, read sessions list). That capability is reachable **only** by a process the supervisor already spawned — i.e., the supervisor key already implies the power to run code that holds the orchestrator key. **Conclusion: auto-minting the orchestrator key off a valid supervisor connection grants no escalation beyond what the supervisor key already confers.**
- **The one thing step-up genuinely protects:** *enabling* the feature for a user who turned it off. A stolen supervisor key should not be able to silently switch the orchestrator on. We close that by gating auto-mint on the persisted `orchestrator_enabled && !orchestrator_disabled_explicitly` flag — a state only the *interactive* (cookie + step-up) `PUT /api/orchestrator` can flip on. So: stolen supervisor key + feature already enabled = orchestrator launches (no new power); stolen supervisor key + feature disabled = nothing.
- **Decision:** auto-launch mints the key without step-up, **only when the flag is enabled**. Interactive `POST /start` and `PUT` keep `requireRecentAuth()` unchanged.
- **Rejected alternatives:** (b) narrower-scoped key — the orchestrator's whole job is cross-session coordination; narrowing capabilities breaks the feature and the existing `OrchestratorTab` contract. (c) one-time confirmation on first auto-launch — adds a Telegram round-trip / UI modal to a flow whose entire point is "just works on connect"; the flag *is* the confirmation (set once, interactively).

### 4.4 cwd / root folder ⟶ **Keep existing resolution (`roots[0]` of the connecting/preferred supervisor); `requireGitRepo` already bypassed. No change for single-root fresh installs.**
- The connecting supervisor's `roots[0]` is the right cwd. For a fresh install with exactly one root, that's the repos-parent the user configured — correct.
- `supervisor/src/process-manager.ts:263` already bypasses `requireGitRepo` for orchestrator specs, so a non-repo parent dir is fine. `assertWithinRoots` still applies.
- If `roots.length === 0`, auto-launch **skips silently** (log only) — same posture as the REST path's `supervisor_has_no_roots` 409, but non-fatal since this is machine-triggered.

### 4.5 Telegram default = orchestrator ⟶ **Dispatch FALLBACK to the orchestrator (not a hard-pinned default), and auto-launch the orchestrator on inbound Telegram if its run isn't live (reuse the autoheal path).**
- **Why fallback over pinning:** the orchestrator session id is stable per user (one open row, reused across restarts). A fallback (`telegram_default_session_id ?? orchestratorSessionId`) tracks the orchestrator even if the user later sets/clears an explicit default, and survives orchestrator-row recreation. Pinning the id at `/start` would go stale if the orchestrator row is ever recreated (e.g. after a hard delete).
- **Where:** in `telegram-webhook.ts` `dispatchInbound` (currently lines 201-204). Replace the bare null-check with: resolve effective target = `telegram_default_session_id || findOpenOrchestratorSession(userId)?.id`. If still null (orchestrator disabled AND no default) → keep the existing "No default session" reply.
- **`prewarmAfterLink` (commands.ts:141-182):** extend so that when the user has no sessions but the orchestrator is enabled, it sets the orchestrator as the prewarm target and launches it. For users *with* sessions, current behavior is fine — but consider preferring the orchestrator as the welcome target (open question OQ-2).
- **Not-running case:** the existing `dispatch → agent_offline → bufferReplay + runDoctor(autoheal)` chain (webhook lines 619-637) already launches an offline session and replays. The orchestrator session is launched via the **same** `launchSessionForUser` mechanic (it's a normal `sessions` row with `project_dir` + `hostname` once auto-launch created it). **One nuance:** `launchSessionForUser` sends a plain `session.start` *without* the `orchestrator` field — it would spawn a non-orchestrator Claude in the orchestrator's cwd (no system prompt, no hub key). Either (i) teach `launchSessionForUser` / a sibling to re-send the orchestrator extension when `session.is_orchestrator`, or (ii) route orchestrator (re)launch through the orchestrator-aware path. **Recommend (i):** add an `is_orchestrator` branch in `launch.ts` that rebuilds the orchestrator `session.start` payload (mint key + seed prompt). This keeps Telegram autoheal, web, and supervisor.hello all converging on one orchestrator-launch helper. Extract `launchOrchestrator(userId, supervisorId)` as the shared primitive (§ P1).
- **`hub/src/dispatch/` pipeline coordination:** the parallel Round-2 work may migrate Telegram dispatch onto `hub/src/dispatch/`. This plan touches only `dispatchInbound`'s target *resolution* (one line) and does not restructure the send path — low conflict surface. Flag for the dispatch-pipeline owner: "Telegram target resolution now falls back to orchestrator; preserve that when migrating." (OQ — coordination note, not a user question.)

### 4.6 Lifecycle edges ⟶ **Exempt the orchestrator from idle-teardown; on supervisor reconnect rely on orphan-resume; auto-launch only fills the "no row" gap.**
- **Idle-teardown vs auto-relaunch loop:** `REMO_SESSION_IDLE_GRACE_SECONDS` teardown sends `shutdown:idle_no_subscribers` when no web client is subscribed. If the orchestrator is auto-relaunched on every supervisor.hello, but torn down 5 min later for lack of subscribers, and the supervisor reconnects… you get a respawn churn. **Mitigation:** exempt `is_orchestrator` sessions from idle-teardown (the orchestrator is meant to be persistently available for Telegram, which is not a WS subscriber). Add an `is_orchestrator` check in the idle-teardown selection (`hub/src/ws/idle-teardown.ts`).
- **Auto-launch ≠ orphan-resume:** auto-launch creates the *row*; orphan-resume respawns the *run*. On reconnect, orphan-resume fires first and respawns the existing orchestrator run (it has a `session_runs` row because §4.6 routes the orchestrator launch through `reserveSessionSlot` + `createRun`). Auto-launch then finds the row present → no-op. No double spawn.
- **`user_stopped` sentinel:** if the user hits Stop on the orchestrator, orphan-resume's sacred `user_stopped` guard (orphan-resume.ts:36-40, 136-145) prevents respawn. **But auto-launch checks `findOpenOrchestratorSession` which ignores run exit_reason** — it would see the still-open `sessions` row (Stop ends the run, not the session) → no-op, correct. The session row only goes away on explicit delete. So Stop = orchestrator stays idle until next user message / interactive start. Good.
- **Supervisor disconnect:** nothing to do; the next hello re-runs orphan-resume + auto-launch.

### 4.7 Codex ⟶ **Out of scope. Orchestrator stays Claude-only** (`createOrchestratorSession` hardcodes `cli_kind='claude'`, orchestrator-dal.ts:78). No change.

---

## 4. Sequenced Phases

> Each phase: files · risk · rollback · the test that proves it. QC gate (build + the named test green) between phases per global rule 13a.

### P0 — Schema & migration
- **Files:** `hub/src/db/schema.sql` (default flip + new column + backfill UPDATE); `hub/scripts/` new one-shot `migrate-orchestrator-default.ts` (or fold the idempotent statements into schema.sql since they're `IF NOT EXISTS` / `SET DEFAULT` safe). `hub/src/db/orchestrator-dal.ts` (`OrchestratorPrefs` gains `orchestrator_disabled_explicitly`; `updateOrchestratorState` writes the sentinel).
- **Risk:** the backfill `UPDATE users SET orchestrator_enabled=true` flips every existing user on. Acceptable per feature intent, but it means every connected supervisor will auto-launch an orchestrator on next hello — a fleet-wide spawn. Mitigate by shipping P0 + P1 together so the cap (`reserveSessionSlot`) governs, and by the per-user single-orchestrator index.
- **Rollback:** `ALTER COLUMN orchestrator_enabled SET DEFAULT false;` + leave the new column (additive, inert). No data loss.
- **Proof test:** `hub/test/orchestrator-autolaunch.test.ts` → "migration enables back-catalog users but leaves explicitly-disabled users off" (seed two users, run migration SQL, assert flags).

### P1 — Hub auto-launch hook + shared `launchOrchestrator` primitive
- **Files:**
  - NEW `hub/src/orchestrator/auto-launch.ts` — `maybeAutoLaunchOrchestrator({userId, supervisorId, hostname, roots})` + `launchOrchestrator({userId, supervisorId})` (the shared primitive: resolve cwd, `reserveSessionSlot`, find-or-create orchestrator session row with unique-violation catch, `createRun`, `mintOrchestratorApiKey`, `buildOrchestratorPrompt`, `sendToSupervisor` with the `orchestrator` extension, `updateSupervisorState('starting', runId)`).
  - `hub/src/ws/agent.ts` (~line 647) — call `maybeAutoLaunchOrchestrator` after orphan-resume, before the `supervisor_update` broadcast; swallow errors (must never tear down hello).
  - `hub/src/api/orchestrator.ts` — refactor `POST /start` to delegate to the shared `launchOrchestrator` (fixes the pre-existing `reserveSessionSlot`/`createRun` bypass noted in §2). Keep the `orchestrator_disabled` 409 + step-up middleware.
- **Risk:** the orchestrator-launch payload must carry the `orchestrator` extension (key + prompt). Getting `run_id` semantics right: today REST uses `crypto.randomUUID()` as run_id; the shared primitive should use `createRun(...).id` so the run is in the `session_runs` ledger and orphan-resumable. Concurrency: unique-index violation on the session insert under two-supervisor connect — must be caught and converted to a reuse, not a 500.
- **Rollback:** feature-flag `REMO_ORCHESTRATOR_AUTOLAUNCH` (default on). Set false → `maybeAutoLaunchOrchestrator` early-returns; interactive path unaffected.
- **Proof tests:** `hub/test/orchestrator-autolaunch.test.ts` →
  - "supervisor.hello with enabled flag + no orchestrator row → creates row + reserves slot + sends orchestrator session.start"
  - "second concurrent hello → unique violation caught → exactly one orchestrator row, one session.start" (simulate by inserting the row between find and insert)
  - "explicitly-disabled user → no launch"
  - "no online roots → skip, no throw"
  - "orchestrator run goes through reserveSessionSlot (at_capacity → skipped, no row leak)"

### P2 — Telegram default = orchestrator (fallback + inbound autoheal)
- **Files:**
  - `hub/src/api/telegram-webhook.ts` (lines 201-204 + 255-269) — effective-target resolution: `const targetId = user.telegram_default_session_id || (await findOpenOrchestratorSession(user.id))?.id || null`. Null → existing "No default session" reply (now only reachable when orchestrator disabled).
  - `hub/src/telegram/launch.ts` — add `is_orchestrator` branch (select `is_orchestrator` in the session query; when true, delegate to the shared `launchOrchestrator` from P1 instead of sending a plain `session.start`). This fixes the autoheal-launches-wrong-Claude bug (§4.5).
  - `hub/src/telegram/commands.ts` `prewarmAfterLink` (141-182) — when `existingDefault` null and orchestrator enabled, prefer the orchestrator as prewarm target (OQ-2 gates whether to prefer it even when the user has other sessions).
  - Outbound bridge (`hub/src/telegram/bridge.ts`) — **no change**; it already matches on `telegram_default_session_id`. NOTE: with the fallback approach, outbound only fires when the column is explicitly set. **Decision:** to make outbound work for the implicit-orchestrator case, the fallback path should also *persist* the orchestrator id into `telegram_default_session_id` on first resolve (lazy-pin), so the bridge's DAL query (`getUsersWithTelegramDefaultSession`) finds it. This reconciles "fallback for inbound" with "explicit column for outbound" — fallback resolves + lazy-pins once.
- **Risk:** lazy-pinning the orchestrator id means if the orchestrator row is later recreated with a new id, the pinned default goes stale → "agent_offline" → autoheal can't find the old session → dead. Mitigate: on `no_session`/`session_not_found` during Telegram dispatch, re-resolve via `findOpenOrchestratorSession` and re-pin. (Self-healing pin.)
- **Rollback:** revert the target-resolution line; Telegram returns to "explicit default only."
- **Proof tests:** `hub/test/telegram-orchestrator-default.test.ts` →
  - "linked chat, null default, orchestrator enabled+open → dispatch targets orchestrator + lazy-pins it"
  - "linked chat, null default, orchestrator disabled → 'No default session' reply"
  - "stale pinned default (session deleted) → re-resolves to orchestrator + re-pins"
  - "outbound bridge forwards orchestrator final reply after lazy-pin"

### P3 — UI touch-ups
- **Files:** `web/src/components/OrchestratorTab.tsx` — copy: "Auto-launches when your supervisor connects" + the enable/disable toggle now also controls auto-launch (it already PUTs `enabled`; P0 makes `enabled:false` set the sentinel). No new endpoint. Verify the red-ring confirm modal on *enable* still makes sense (it does — enabling is the interactive consent that authorizes auto-mint per §4.3).
- **Risk:** minimal (copy + existing toggle semantics).
- **Rollback:** revert copy.
- **Proof:** manual UI check + existing OrchestratorTab tests if any; no new logic test required (doc-ish change).

### P4 — Tests & docs
- **Files:** the two new test files above; update `docs/auth.md` (orchestrator auto-launch + the §4.3 security rationale + the no-step-up-for-machine-path exception), `docs/telegram-bridge.md` (default = orchestrator fallback + lazy-pin), and the **CLAUDE.md "Orchestrator Session" rollup** (auto-launch invariants, the new `orchestrator_disabled_explicitly` sentinel, idle-teardown exemption). Per global rule "update docs in the same commit."
- **Proof:** `bun test` green for both new files + the existing `hub/test/*orchestrator*` and `hub/test/*telegram*` suites unaffected.

---

## 5. Invariant-Risk Register

| # | Invariant | Risk introduced | Guard |
|---|-----------|-----------------|-------|
| I1 | One open orchestrator per user (`idx_sessions_orchestrator_unique`) | Concurrent supervisor.hello → two INSERTs | Catch unique-violation in `launchOrchestrator`, re-`findOpenOrchestratorSession`, reuse. Test P1#2. |
| I2 | Orchestrator API key stays server-side / in spawned env only | New mint path | Auto-launch puts raw key only in `session.start.orchestrator.hub_api_key`; never returned over WS/HTTP. Unchanged from REST path (orchestrator.ts:156). |
| I3 | Cost-cap + concurrency apply to orchestrator activity | REST `/start` currently bypasses `reserveSessionSlot` | P1 routes BOTH auto-launch and REST through the shared `launchOrchestrator` which reserves a slot + creates a `session_runs` row. Fixes a pre-existing gap. Test P1#5. |
| I4 | Don't fight a user who disabled the orchestrator | Default flip + per-hello relaunch | `orchestrator_disabled_explicitly` sentinel gates auto-launch and auto-mint. Test P0 + P1#3. |
| I5 | `user_stopped` is sacred (no auto-resurrect) | Auto-launch could recreate a Stopped orchestrator | Auto-launch only acts when NO open `sessions` row exists; Stop ends the run not the row → row present → no-op. Orphan-resume's `user_stopped` guard still blocks run respawn. |
| I6 | hello flow must never tear down on a sub-step failure | New hook in supervisor.hello | Wrap `maybeAutoLaunchOrchestrator` in try/catch + log (matches the orphan-resume / sentry-seed posture at agent.ts:589-647). |
| I7 | Idle-teardown integrity | Orchestrator churn vs auto-relaunch | Exempt `is_orchestrator` from idle-teardown selection (`hub/src/ws/idle-teardown.ts`). |
| I8 | Telegram outbound only forwards FINAL to the matching default session | Lazy-pin changes which session matches | Lazy-pin writes the orchestrator id into `telegram_default_session_id`, so the bridge's existing match gate is satisfied without loosening it. |

---

## 6. Open Questions for the User (genuine forks only)

1. **Fleet-wide enablement on migration.** P0's backfill turns the orchestrator **on for every existing user**, so each connected supervisor auto-spawns a Claude orchestrator process on next connect (one per user, cost-capped). Acceptable, or should existing users stay opt-in and only **new** signups get default-on? (Default-on-for-all is the literal feature ask; calling it out because it's an immediate, fleet-wide cost + process footprint change.)

2. **Telegram welcome target for users who already have sessions.** On `/start` link, should Telegram's default become the **orchestrator** (consistent "first agent you talk to is the root orchestrator") even when the user has existing project sessions, or keep the current behavior of prewarming their **most-recently-used** session and only falling back to the orchestrator when they have none? (Recommend: orchestrator-first, to match the stated mental model — but it changes existing linked users' default on their next link.)

3. **Idle-teardown exemption scope.** Exempting the orchestrator from idle-teardown (I7) means it stays running indefinitely once launched (until Stop), consuming a session slot + a Claude process per user 24/7. Acceptable for the "always-available Telegram brain" goal, or should it idle-down after N minutes and rely on inbound-Telegram autoheal to relaunch (slower first reply, lower steady-state cost)?

---

## 7. Doc Path
`C:\Users\artic\GitHub\remo-code-orchestrator-autolaunch\.planning\phases\orchestrator-autolaunch\PLAN.md`
