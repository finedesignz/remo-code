# Auto-Dev Orchestrator

Source of truth for the session-level auto-dev orchestrator (milestone
`m-auto-dev-orchestrator`, Phases 21–32). Scope: **hub + web only** — no supervisor
changes. The orchestrator runs gsd commands INSIDE the bound session agent (Claude
Code, which holds the gsd skills): the hub injects a templated prompt and the agent
itself spawns parallel Task subagents (locked decision D6). The hub does NOT
re-implement orchestration and never shells `gh`/git/merge — it ships TEXT ONLY.

> **Default OFF.** With `REMO_ORCHESTRATOR_ENABLED` unset, nothing registers,
> enqueues, or injects. The live path is **e2e-proven against real Postgres** — the OEE
> suite (`hub/test/e2e/`, run in CI on every PR) proves queue/lock, due→waves,
> macro-cycle + sentinels, cost-cap, the notify matrix, verify-tail, and legacy-wave
> rollback parity. Enabling it in prod is still a separate, deliberate **human go/no-go**
> — see the [Enablement gate](#enablement-gate) and the
> [enablement runbook](orchestrator-e2e-runbook.md).

## Model — one orchestrator task per session

The orchestrator REPLACES the legacy many-tasks-per-session model (locked decision
D3). Each session has at most **one** `task_type='orchestrator'` scheduled task
(enforced by the partial unique index `idx_scheduled_tasks_orchestrator_unique`).
That task owns a set of **command rows** in `orchestrator_rows`.

### The row model (`orchestrator_rows`)

| column | meaning |
|---|---|
| `command` | a gsd command (`gsd-plan-phase`, `gsd-execute-phase`, `gsd-audit-fix`, `gap-scan`, `gsd-code-review`, `gsd-verify-work`, `gsd-complete-milestone`, `gsd-ship`, `merge-to-main`) or a free-text **micro-prompt** row |
| `enabled` | row on/off |
| `schedule_rule` | JSONB, reuses the scheduler `ScheduleRule` (cron interval + `active_window` + bounds) — this makes the row *eligible/due* |
| `frequency_label` | `Never` (⇒ disabled), `Once` (⇒ max_runs=1, auto-disables after one run), or a cadence label |
| `micro_prompt` | free text for a custom row, wrapped in the finish→PR→reviewer envelope |
| `sort_order` | row ordering in the UI |
| `last_fired_at` | when the due-scan last DISPATCHED this row — the **cadence state**. A row is due again only once `schedule_rule`'s interval has ELAPSED since this stamp |

The schedule is **eligibility**, not the trigger: when the routine fires, a
controller computes EVERY due row this tick and runs them all (decision D1).

**Cadence advances on dispatch.** `shouldSkipFire()` only answers *"is this rule
eligible at `now`"* (start_at / week+month parity / `active_window`) — for a
minutes/hours/days rule it says "fire" for every `now` past `start_at`. The hub
scheduler pairs it with `scheduled_tasks.next_fire_at`; orchestrator rows use
`last_fired_at`, stamped by `scanAndEnqueueDueCycles` on every row it dispatches
(`markOrchestratorRowsFired`). Without it an `Every 4h` row is DUE on all 1440 daily
60s ticks and the macro prompt is re-injected once a minute (see the 2026-07-10
per-tick re-inject incident). The due-scan additionally **skips any session with an
unsettled (`pending`/`running`) `routine_queue` row**, so a macro turn still in flight
never gets a second cycle stacked behind it.

Two always-on **implicit** rows are NOT in the table: `status-check/decide` (first,
context gathering) and `deploy+log-verify` (terminal, every tick — see
[Verify tail](#verify-tail)).

### Lifecycle stages

`scheduled_tasks.lifecycle_stage` ∈ `{development, beta, production-maintenance}`
(default `development`). Stage **presets** (`hub/src/orchestrator/stage-presets.ts`)
seed default row frequencies — development biases to building (frequent
plan/execute + gap-scan), beta to QC (heavy audit-fix/review/verify),
production-maintenance to maintenance (security-weighted gap-scan, plan/execute
parked). The user overrides any row afterward; overrides persist.

## The queue (`routine_queue`) + per-session lock

`hub/src/orchestrator/queue.ts` — a hub-wide FIFO+priority queue caps concurrent
cycles across ALL sessions at `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` (default 2). A
drain worker (`startRoutineQueueWorker`, interval `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS`,
default 1000ms) claims pending entries up to the cap. A **per-session lock** (the
partial unique index on `(session_id) WHERE status='running'`) guarantees at most
one running cycle per session; a second due-tick for a running session is coalesced,
not stacked. Priority: a `deploy-fix`/`merge-to-main` row outranks `build` work.

### Stale-lock reaper (`hub/src/orchestrator/stale-lock-reaper.ts`)

Separate from `routine_queue`'s DB lock (which already releases each cycle) is an
**in-memory** per-session lock in `SessionQueue` (`hub/src/dispatch/session-queue.ts`):
`inFlight` is set on dispatch and cleared ONLY by `markFinished(sessionId)`. If a
session's CLI turn never completes (dead/unauthed local session), `markFinished` is
never called and the lock is held FOREVER — `runMacroCycle`'s `isRunLive` check then
makes every heartbeat silently `skipped "run live"` indefinitely, with no work and no
alert (verified in prod: wedged ~2 days).

`reapStaleOrchestratorLocks` runs alongside the due-scan tick (`startDueOrchestratorTick`,
same `REMO_ORCHESTRATOR_TICK_INTERVAL_MS` cadence): for every enabled orchestrator task
whose session's in-memory lock age is ≥ `REMO_ORCHESTRATOR_STALE_LOCK_MS` (default 4h),
it `abandon()`s the lock so the next heartbeat can re-inject, appends a `failed`
`routine_run_log` row, and fires a one-shot `failure` notify (cooldown-deduped by
`REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS`, default 1h, so a session that stays wedged
across several ticks doesn't re-page every minute — it still reaps every tick, just
notifies at most once per cooldown window).

## The tick / async model (controller → waves, end-to-end)

This is the Phase-32 wiring that closes the Phase-25 deferral. The hub DRIVES the
waves from the **due rows** directly (it does not wait for the agent to emit RUNLOG
blocks — those are a reconciliation read, see below).

1. **Enqueue tick** (`scanAndEnqueueDueCycles`, interval
   `REMO_ORCHESTRATOR_TICK_INTERVAL_MS`, default 60000ms) scans every enabled
   orchestrator task; for each whose session has ≥1 due row it `enqueueCycle(...)`.
   Started ONLY when the flag is ON.
2. The **drain worker** claims an entry (per-session lock + global cap). The entry
   carries only `session_id`.
3. `makeCycleRunner()`'s runner calls `resolveCycleContext(session_id)`:
   `getSessionById` → `{ user_id, repo_key }`; `getOrchestratorTaskForSession` → the
   one orchestrator task (`id`, `lifecycle_stage`, `timezone`). A stale/foreign entry
   (no session or no task) is a clean no-op.
4. `buildControllerContext(...)` assembles project state + the last N
   `routine_run_log` entries + the **DUE rows** (`computeDueRowsForTask`).
5. `renderControllerPrompt(ctx)` is stamped as the run-log `decision_rationale`
   (context). The DUE ROWS are the authoritative command set:
   `runWavesFromDueRows(dueRows, ctx, makeLiveSeams())`.
   - `planWaves` groups the due commands into dependency-aware waves (independent
     commands parallel; `plan→execute→ship` sequenced). `merge-to-main` is EXCLUDED.
   - Each row's `micro_prompt` is carried onto its `WaveUnit`.
   - The `executeCommand` live seam composes the templated prompt
     (`command-prompts.ts`) and INJECTS it into the bound session via the shared
     dispatch pipeline (`inject.ts` → `hub/src/dispatch/`), through the
     **non-bypassable `dailyCostCapGate`**.
6. `dispatchMergeIfDue(dueRows, ...)` routes a due `merge-to-main` row to the
   off-hours special path.
7. `runVerifyTail(...)` runs the mandatory terminal verify (always, every tick).

**Async boundary:** `executeCommand` returns as soon as the prompt is DISPATCHED (or
refused). The gsd work + PR + reviewer happen ASYNC inside the agent's turn. The
agent reports a `<<UNIT>>` block; the hub reconciles `pr_url`/`reviewer_verdict` into
`routine_run_log` on a LATER tick when `buildControllerContext` re-reads the log. The
run-log row written at dispatch time carries the dispatch outcome with null pr/verdict.

The controller prompt's `<<RUNLOG>>`/`<<DECISION>>` parser
(`parseControllerDecisions` + `writeRunLogFromBlocks`) is the reconciliation path for
agent-reported blocks — it is not the driver.

## Run log (`routine_run_log`)

Per session/repo (decision D4): timestamp, command, decision rationale, outcome,
gap-dimension/agent, PR url, reviewer verdict, deploy-verify result. Fed into the
controller context each tick. **Survives repo resets/worktrees** (it is in the hub
DB, not the working tree).

## Per-unit contract: finish → PR → reviewer

Every non-propose unit MUST, inside the agent turn: finish the work, open a PR on a
per-command branch (NEVER merge to main), dispatch a reviewer subagent to verify that
PR, and report the verdict. Units never merge to main — that is the off-hours command.

## Tiered autonomy — propose-to-chat

Plan, execute, audit-fix, gap-scan, code-review, verify run autonomously.
`gsd-ship` / `gsd-complete-milestone` / `tag` are **propose-tier** (decision D5): the
wave runner routes them to `proposeToChat` (`propose.ts`, reusing the P3
`surfaceProposal` notify senders + `notifications_sent` throttle) for one-tap chat
approval — they are NEVER executed/PR'd/merged by a cycle.

## Off-hours merge to main

`merge-command.ts` — the ONLY auto-merge-to-main path (decision D8). EXCLUDED from
the wave planner. Runs only inside the merge row's `schedule_rule.active_window`
(reusing `isWithinActiveWindow`); outside the window ⇒ a skipped run-log row.
In-window it auto-merges PRs the dispatched reviewer marked PASS (FAIL/uncertain held
+ surfaced to chat). Powerful commands consume an `orchestrator_approvals` marker
before injecting so a re-fired window cannot double-merge.

## Build-Session Autospawn (milestone BSA)

**The gap it closes.** The macro path only INJECTS into ONLINE supervisor-connected
sessions. The owner's real builds run as standalone local `claude` processes invisible
to the hub, so every prod cycle for an offline build target resolves to `no_session`
and `routine_run_log.pr_url` stays NULL forever — the orchestrator never actually
produces a PR. BSA gives the macro path an online, hub-visible build session to drive.

**How — reuse the scheduler launch primitive.** When a due `dev` build task's session
is OFFLINE but its supervisor is online and autospawn is armed, the inject seam
(`maybeAutospawnOffline` in `hub/src/orchestrator/inject.ts`) calls the SAME
battle-tested `launchSessionForUser` / `maybeLaunchOfflineSession` path the scheduler
uses: it spawns a supervisor-hosted (hub-visible) session, reserves a concurrency slot,
and PARKS the macro prompt in grace exactly as the scheduler does. The launched runner
drains the parked prompt on reconnect. The autospawn seam writes ONE
`routine_run_log` row with `command = 'autospawn-launch'` per real spawn (also the
source for the per-day launch cap).

**The full gate AND-chain** (ANY miss ⇒ the legacy `no_session`, i.e. a strict no-op):

```
  autospawn.isBuild === true            (the macro is a BUILD/dev type)
  && isOrchestratorEnabled()            (REMO_ORCHESTRATOR_ENABLED)
  && isAutospawnEnabled()               (REMO_ORCHESTRATOR_AUTOSPAWN — default OFF)
  && isRepoAutospawnAllowed(user, repo) (allowlist NON-EMPTY for this repo)
  && supervisor online for this user
  && NOT over the daily TOKEN cap        (dailyTokenCapGate)
  && NOT over the per-day LAUNCH-count cap
```

Refusal reasons (typed `InjectOutcome`): `not_allowlisted`, `supervisor_offline`,
`over_token_cap`, `launch_cap`; success ⇒ `autospawn_launched` / `autospawn_parked`.

**New env knobs + defaults** (full semantics in [CLAUDE.md](../CLAUDE.md)):

| Env | Default | Purpose |
|---|---|---|
| `REMO_ORCHESTRATOR_AUTOSPAWN` | OFF (`0`) | Arms the autospawn capability. Accepts `1\|true\|yes\|on`. Carries `REMO_ORCHESTRATOR_ENABLED` (both ON). |
| `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` | `50_000_000` (50M) | Non-bypassable daily TOKEN ceiling. Counts **all four buckets: input + output + cache_creation + cache_read** (see below). Non-positive/non-finite ⇒ disabled (fail-open). |
| `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR` | `4` | Per-session orchestrator inject-RATE ceiling (`sessionInjectRateGate`). Non-positive/non-finite ⇒ disabled (fail-open). |
| `REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES` | `20` | Per-day autospawn launch-count cap. Non-positive/non-finite ⇒ disabled. |

### 2026-07 runaway-loop incident — what the caps now enforce

The orchestrator injected a macro prompt into ONE session every 60s, 24/7, for 2 days —
**2,192 turns**, each re-reading a ~1M-token context: **2.83 BILLION `cache_read_input_tokens`**,
which torched the owner's Claude subscription. Nothing stopped it:

- **The daily token cap never tripped.** `getTodayTokenTotal` counted only `input + output`
  (PR #335 called cache-read "free"). Cache-read is *not* free against a **subscription rate
  limit** — only against per-token billing. **Fixed:** the cap now sums
  `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  (same tz-day boundary as `/api/usage/cost`).
- **Nothing bounded the RATE.** **Fixed:** `sessionInjectRateGate`
  (`hub/src/dispatch/gates.ts`) counts this session's injects in the trailing 60 minutes from
  the existing `routine_run_log` (rows whose `outcome` ∈
  `dispatched | queued | autospawn_launched | autospawn_parked` — refusals/skips don't consume
  budget) and refuses at/over `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR` (default **4**) with
  `over_session_inject_rate:<n>>=<cap>`. Rows age out of the rolling window, so it re-opens
  by itself. A legitimate autonomous cycle takes far longer than 15 minutes per unit of work.

Both gates sit in the orchestrator inject gate list ALONGSIDE (never replacing) the threshold
and dollar cost-cap gates: `[thresholdGate, dailyCostCapGate, dailyTokenCapGate,
sessionInjectRateGate]` (`hub/src/orchestrator/inject.ts`, both the online and autospawn paths).

**Repo allowlist.** `orchestrator_autospawn_allowlist` (per-user `repo_ident` =
`github://owner/repo` or `path://<abs>`; idempotent additive DDL, **default EMPTY** so
autospawn drives nothing). DAL: `isRepoAutospawnAllowed` / `listRepoAutospawnAllowlist`
/ `addRepoToAutospawnAllowlist` (`hub/src/db/orchestrator-rows-dal.ts`). Autospawn
fail-closes to `refused:not_allowlisted` for any repo not on the list.

**Non-bypassable daily TOKEN cap — and WHY.** `dailyTokenCapGate`
(`hub/src/dispatch/gates.ts`) counts REAL tokens from `token_usage` over the user's
tz-day (mirroring `getTodayTokenCostUsd`) and blocks at `tokens >= cap`. It is ADDED
ALONGSIDE the dollar `dailyCostCapGate` in the inject gate list (`[thresholdGate,
dailyCostCapGate, dailyTokenCapGate]`), never replacing it — because the **dollar cost
cap is meaningless on a flat-rate Max subscription** (no per-token billing), so a token
count is what actually bounds a runaway autospawn loop. The seam also pre-checks the
token cap BEFORE spawning, so it never launches over the ceiling.

**OFF-by-default + inert until armed.** With `REMO_ORCHESTRATOR_AUTOSPAWN` unset OR the
allowlist empty, the seam is a strict no-op (legacy `no_session`) — merging BSA changes
NO prod behavior. Arming is the owner go/no-go in the
[autospawn flip runbook](orchestrator-autospawn-runbook.md). **Proof:** the e2e test
`hub/test/e2e/orchestrator-autospawn.e2e.test.ts` (real Postgres + stub supervisor,
`REMO_E2E_DB_URL`-gated) drives due build task + offline session + online supervisor →
asserts `session.start` fired, prompt parked, drain delivers, and
`routine_run_log.pr_url` populated on a simulated reply.

## Gap-scan rotation

`gap-rotation.ts` — a dimension wheel (security, performance, accessibility, test
coverage, dead-code/dependency hygiene, error-handling, docs-drift, type-safety).
Each `gap-scan` tick picks the least-recently-run dimension from the run log and maps
it to the right specialist subagent. The chosen dimension is embedded in the prompt
and persisted to `routine_run_log.gap_dimension` so the next tick rotates.

## Verify tail

`verify-tail.ts` (decision D9) — the mandatory terminal step every cycle: forced
redeploy → `/health` → probe real routes (reuses the P5 `deploy-verify-probe`) AND a
Coolify runtime-log error scan, bounded to N=3 fix iterations then surface. No-ops
gracefully (writes a `skipped` run-log row) when `COOLIFY_TOKEN` + `REMO_VERIFY_*`
are unset. Routes default to `/api/sessions,/openapi.json,/docs`.

## Web UI

`web/src/pages/settings/` — the orchestrator is the pinned top "folder" row in
Settings → Connections. One orchestrator task per session: a row table (command,
frequency, micro-prompt), a lifecycle-stage selector, and the controller prompt.
Data-only config; the live controller path is flag-gated.

## Enablement gate

`REMO_ORCHESTRATOR_ENABLED` (default **OFF**) is the single live-path gate.
`registerCycleRunnerIfEnabled()` (called once at boot, `hub/src/index.ts`) is the ONLY
caller of the queue's `setCycleRunner` + the only starter of the enqueue tick. With
the flag OFF: no runner is registered (the drain worker claims nothing), and the
enqueue tick never starts — so NOTHING is registered, enqueued, or injected.

**Real-Postgres proof (DONE):** the OEE milestone added an isolated e2e harness + suite
under `hub/test/e2e/` that drives the REAL orchestrator code against a REAL, disposable
Postgres — queue/lock, due→waves, macro-cycle + sentinels, cost-cap, notify matrix,
verify-tail, and legacy-wave rollback parity. It runs in CI on every PR
(`.woodpecker/qc.yaml` → `bun run orchestrator:e2e` against a `postgres:16` service) and
locally via `bun run orchestrator:e2e` with `REMO_E2E_DB_URL` set.

**Remaining before live enablement:** confirm the verify-tail target envs in prod and
complete the staging-first flip — the full go/no-go checklist lives in the
**[enablement runbook](orchestrator-e2e-runbook.md)**. The prod flag-flip stays a
separate HUMAN decision; it is NOT part of the OEE milestone.

## Legacy task migration

`hub/scripts/migrate-legacy-tasks-to-orchestrator.ts` — a ONE-SHOT (NOT in
schema.sql) that folds legacy `dev`/`qc`/`security`/`log_check` scheduled tasks into
the orchestrator model: one orchestrator task per session + seeded `orchestrator_rows`
(`dev` → plan + execute; `qc` → audit-fix + code-review + verify-work; security/log →
gap-scan). Seeded rows are parked (`frequency_label='Never'`, disabled) so migration
never silently starts firing work. The migrated legacy tasks are DISABLED (not
deleted — reversible). Idempotent + re-runnable; supports `--dry-run`.

```bash
# Report only (writes nothing) — review BEFORE applying:
bun run hub/scripts/migrate-legacy-tasks-to-orchestrator.ts --dry-run
# Apply:
bun run hub/scripts/migrate-legacy-tasks-to-orchestrator.ts
```

Do NOT auto-run against prod — run by hand after reviewing the dry-run output.

## Cross-cutting invariants

- Cost cap non-bypassable (`dailyCostCapGate` always in the inject gate list); BSA adds the
  companion non-bypassable `dailyTokenCapGate` ALONGSIDE it (never replacing the cost cap).
- Autospawn (BSA) is OFF-by-default + empty-allowlist-by-default; plan-first, NEVER auto-merges
  from an autospawned session (merge stays the off-hours window-gated path).
- `schema.sql` is idempotent-only; data backfills are one-shots in `hub/scripts/`.
- Single dispatch pipeline (`hub/src/dispatch/`) — no per-subsystem queue/grace.
- Hub injects TEXT ONLY; the agent owns gh/git/PR/reviewer inside its turn.
- Off-hours merge is the ONLY auto-merge-to-main path.

## Ghost-session reaper (fix/ghost-session-reaper)

A **ghost session** is a `sessions` row stuck `status='online' AND hostname IS NULL` that has a
registered agent WebSocket channel but no genuinely-live/productive CLI behind it. It arises when a
SessionBridge resumes on `/ws/agent` WITHOUT a hostname: the agent-auth path
(`hub/src/ws/agent.ts`) always `registerChannel` + `setSessionStatus('online')` but only persists
`hostname` when the auth frame carries one, so the row is left online with a live phantom channel
that survives hub restarts (the bridge re-auths). Because `getChannel(sessionId) != null`, the
orchestrator inject treats the ghost as online and dispatches into the void; autospawn (which needs
`getChannel == null`) never fires, so no real build session spawns and no PRs are produced.

Two-part fix:

- **Reaper** (`hub/src/ws/ghost-reaper.ts`): a boot-started sweep (`startGhostReaperSweep`, wired in
  `hub/src/index.ts`) enumerates live channels (`listChannelSessionIds` in `ws/registry.ts`), loads
  each session, and classifies a ghost by SHAPE (`status='online' AND hostname IS NULL`, never
  `is_orchestrator=true`) that has held that shape continuously for `GHOST_GRACE_MS`. The grace is
  measured against an in-memory first-seen instant (cached per channel, seeded from `last_activity` on
  first observation), NOT against live `sessions.last_activity` — the supervisor's 10s
  `session_inventory` upsert refreshes `last_activity` to `now()` on every push, so a
  `last_activity`-based grace would never age a supervisor-anchored ghost past the window (verified in
  prod 2026-07-09: reaped once at boot, then re-anchored and immortal). For each ghost it closes the phantom socket
  (`4004 ghost_reaped`), `unregisterChannel`s it, and flips the row `offline` — after which the next
  tick sees `getChannel == null` and autospawns a real session. Fail-open per session. Legit
  supervisor/rootless sessions always carry a hostname, so the signature is low-false-positive.
- **Inject guard** (`hub/src/orchestrator/inject.ts`): the raw `getChannel(sessionId) == null`
  liveness check is replaced by an injectable `isSessionLive(sessionId)` (channel present AND NOT a
  ghost). A ghost therefore routes to `maybeAutospawnOffline` instead of dispatching into the void.

Env: `REMO_GHOST_GRACE_MS` (default 120000), `REMO_GHOST_SWEEP_INTERVAL_MS` (default 60000),
`REMO_GHOST_REAPER_DISABLED` (`1|true|yes|on` ⇒ no-op). Tests: `hub/test/ghost-reaper.test.ts`,
`hub/test/orchestrator-autospawn-inject.test.ts` (ghost → autospawn path).

## Key files

`hub/src/orchestrator/`: `controller.ts` (cycle runner + resolution + enqueue tick),
`queue.ts`, `due-rows.ts`, `waves.ts` (planner), `wave-runner.ts` (seams + per-unit
lifecycle), `inject.ts` (dispatch adapter), `command-prompts.ts`, `command-set.ts`,
`run-log.ts`, `verify-tail.ts`, `merge-command.ts`, `propose.ts`, `gap-rotation.ts`,
`stage-presets.ts`. DAL: `hub/src/db/orchestrator-rows-dal.ts`. Schema:
`hub/src/db/schema.sql` (Phase-21 block). Migration:
`hub/scripts/migrate-legacy-tasks-to-orchestrator.ts`.
