# CLAUDE.md

Guidance for Claude Code working in this repo. **Durable rules + a map only.** Deep
per-subsystem and per-phase detail lives in `docs/` (context-mode indexed, read on
demand) — see the Docs map below. Full historical rollups: [docs/claude-architecture-notes.md](docs/claude-architecture-notes.md).

## Preferences (global, not duplicated here)

- UI/UX (color, spacing, font, layout, theme) → `~/.claude/design-preferences.md`
- Stack / components / data-flow / persistence → `~/.claude/architecture-preferences.md`
- Ports / Coolify / infra → `~/.claude/infrastructure.md`

Read those before any design or architecture decision. Never restate their contents here.

## Workflow: always use git worktrees for new features

**Mandatory.** New feature/phase/non-trivial refactor → create a worktree off `origin/main`
and do ALL work there. Never build on the primary checkout — parallel sessions wipe
uncommitted/untracked files when they switch branches or `git clean`.

```bash
cd C:/Users/artic/GitHub/remo-code
git fetch origin
git worktree add ../remo-code-feat-<slug> -b feat/<slug> origin/main
cd ../remo-code-feat-<slug>          # all work, commits, .planning/ docs happen here
```

PR `feat/<slug>` → `main`. After merge: `git worktree remove ../remo-code-feat-<slug> && git branch -D feat/<slug>`.
Exceptions: trivial single-file bugfixes, doc edits.

## What This Is

Web app to chat with Claude Code / Codex sessions remotely from any browser or phone.
A local supervisor spawns the CLI with `--input-format stream-json --output-format
stream-json`, giving the web UI full visibility into thinking, tool calls, and streaming
text. Also ships scheduled tasks, error capture, grid view, an orchestrator session, a
Telegram bridge, and Revanote annotation intake (see Docs map).

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono, port 3040)
    ↕ WebSocket /ws/agent
Remo Code Supervisor desktop app (Tauri MSI, one per host)
    ↕ subprocess stdin/stdout (stream-json)
Claude Code CLI / Codex CLI (one persistent process per session)
```

Three packages in a Bun workspace:
- **hub/** — Bun + Hono HTTP/WS server. Titanium magic-link + opaque-cookie auth, session
  management, relays messages + activity events between web clients and supervisors. Serves
  the built SPA as static files in prod.
- **web/** — React 19 + Vite + Tailwind CSS 4 SPA. WebSocket to hub for real-time chat.
- **supervisor/** — Local tray app. `supervisor/src/` is Bun TS source; `supervisor/tauri/`
  compiles it via `bun build --compile` into a sidecar binary + Windows MSI. One per host.
  Connects to `/ws/agent` with an API key, spawns Claude/Codex CLIs on demand, relays
  stream-json events to the hub.

## Commands

```bash
bun install                                  # deps (repo root)
bun run dev:hub                              # hub server (3040)
bun run dev:web                              # web dev server (5173)
bun run build:web                            # build web for prod
bun run check-baseline                       # QC gate (per-file test isolation; tools/regression-baseline.json)
bun run docs:sync                            # regenerate docs/openapi.json + docs/api.md
cd supervisor/tauri && cargo tauri build     # build supervisor MSI
```

Legacy `npx remo-code-agent` / `claude-remote` is retired (2026-05-26) — install the Tauri
Supervisor MSI from https://github.com/finedesignz/remo-code/releases/latest. The legacy spawn
path is hard-disabled in the supervisor (Phase 09): `session.start` finalizes as
`stopped`/`legacy_agent_spawn_disabled` instead of respawn-looping; backoff caps at
`MAX_RESTART_COUNT=10`. Canary test `supervisor/test/no-legacy-agent-spawn.test.ts` fails the
build if the retired package name or `--append-system-prompt` reappears.

## Local Supervisor (only supported connection)

`supervisor/src/index.ts`, compiled into the Tauri sidecar, runs as a tray app on the dev
machine. Connects to `/ws/agent` with an API key; hosts one CLI subprocess per active session
(spawned lazily on first user message), kept alive between messages for full conversation memory.

- **Session resume** by matching `project_dir` — restart reconnects with full history.
- **Session inventory push** (supervisor ≥0.5.7): `session_inventory` every 10s, hub stores it
  in `hub/src/ws/supervisor-registry.ts` and folds it into `GET /api/sessions`'s `active` flag.
- **Idle teardown** (`hub/src/ws/idle-teardown.ts`): subscriber count → 0 starts a
  `REMO_SESSION_IDLE_GRACE_SECONDS` timer → `shutdown`/`idle_no_subscribers`. Orchestrator
  session is exempt. On `shutdown` receipt the supervisor writes a fail-open "memory before
  killing" breadcrumb (`supervisor/src/runners/session-breadcrumb.ts` →
  `%LOCALAPPDATA%\remo-code-supervisor\session-breadcrumbs\<sessionId>.json`) recording
  why/when the live process was reaped. Transcript itself is never lost (resume-by-`project_dir`);
  the human-only PTY invariant forbids the hub injecting an agent turn pre-kill, so this is the
  only invariant-safe place to persist the breadcrumb.
- **Config:** `%LOCALAPPDATA%\remo-code-supervisor\config.json` (Tauri first-run wizard).

## Database

**PostgreSQL** (self-hosted, on Coolify). Schema in `hub/src/db/schema.sql` — idempotent DDL
only; **it re-runs in full every hub boot**, so data backfills MUST be one-shot scripts in
`hub/scripts/`, never inline in schema.sql. Core tables: `users` (identity + Titanium
`license_status` mirror; legacy `password_hash` behind `ALLOW_LEGACY_LOGIN`), `auth_sessions`
(opaque cookie sessions), `sessions`, `messages`, `api_keys`. All queries scoped by `user_id`.
Subsystem tables are documented in their respective `docs/*.md`.

## Settings UI (web)

`web/src/pages/SettingsPage.tsx` mounts exactly four tabs (`web/src/pages/settings/`):
**Connections · Credentials · Usage · Profile**. The old **Prompts** and **Orchestrator**
tabs are gone (milestone v-settings-overhaul, 2026-05) — both routes redirect to Connections.

- **Connections** — single responsive repo table; the orchestrator is a pinned special top
  "folder" row (enable/disable/start/stop in-row), not its own tab. Root-folder paths are no
  longer edited here — root setup lives in the supervisor first-run wizard (hub URL + API key
  + ≥1 root).
- **Usage** — single "Claude Usage and Cost Controls" card (thresholds + daily cost cap merged);
  token counts under the `$` figures; autosave.
- **Profile** — display name + timezone (autosave); no Telegram card (the hub `/api/telegram/*`
  bridge still runs — see telegram-bridge.md). Default session falls back to the orchestrator
  when none is set.
- **Accent = blue** (orange is CTA-only; never indigo — enforced by `web/test/no-indigo.test.ts`).
  Rationale + tokens live in `~/.claude/design-preferences.md`; do not restate here.
- **Per-session auto-nudge:** nullable `sessions.auto_nudge` overrides the user global
  (`users.auto_nudge_idle_sessions`); effective = `session.auto_nudge ?? globalDefault`.
  `PATCH /api/sessions/:id/auto-nudge`; per-row toggle in the sidebar; nudge dispatch is
  client-side in `ChatLayout`.

## WebSocket Protocol

`/ws/agent` (supervisor) and `/ws/client` (browser). All messages Zod-validated in
`hub/src/ws/protocol.ts` + `agent-protocol.ts`.

- **`/ws/agent`** — auth `{ api_key, project_dir, hostname }` (SHA-256 hash); supervisor sends
  `thinking`/`text_delta`/`tool_use`/`tool_result`/`status`/`assistant_message`; hub sends
  `user_message`/`cancel`/`ping`; 30s heartbeat. Keyed by `api_keys`, **never** user license.
- **`/ws/client`** — auth `{ token }` (opaque session cookie; legacy JWT only when
  `ALLOW_LEGACY_LOGIN=true`); client sends `send_message`/`subscribe`; hub sends
  `message`/`session_status`/`session_list` + activity events.
- Both: 5s auth timeout, 20 conns/IP, per-conn rate limits. `subscribe` accepts single
  `session_id` or multi `session_ids` (cap 12, for grid view).

## Key Design Decisions

- Persistent CLI process per session; resume by `project_dir`.
- Activity events (thinking, tool use) are ephemeral — only the final `assistant_message` persists.
- File attachments: text inlined into message content; images as base64 data URIs.
- Theme via CSS custom properties (`--bg-primary`, `--text-primary`, …).
- Session tokens: `remo_` prefix + 32 random bytes (base64url), stored as SHA-256 hashes.
- Subscription quota (4 windows: `five_hour`, `seven_day`, + Max-only `seven_day_opus` /
  `seven_day_oauth_apps`) polled by the **supervisor** (`supervisor/src/usage/oauth-poll.ts`,
  5-min interval), not the hub — OAuth token stays in `~/.claude/.credentials.json` on the dev
  machine and is **never** serialized to the hub; only the parsed util%/`resets_at` windows are.
  Hub keeps an in-memory snapshot (`hub/src/usage/store.ts`), rebroadcasts via WS
  `subscription_usage`; web renders util + Opus pill + reset countdown (`UsageStrip`/`UsageTab`).
  The poll ships only with the supervisor MSI (≥0.7.0).

## Environment Variables

- **hub/.env:** `DATABASE_URL`, `JWT_SECRET` (min 32), `PORT` (3040), `HUB_ALLOWED_ORIGINS`.
  Titanium / Telegram / mobile / scheduler envs are documented in the relevant `docs/*.md`.
- **web/.env:** `VITE_HUB_URL`.
- **Supervisor:** Tauri wizard → `%LOCALAPPDATA%\remo-code-supervisor\config.json`.
- **Optional:** `REMO_SESSION_IDLE_GRACE_SECONDS` (default 14400 = 4h; `0` disables idle teardown),
  `REMO_ORCHESTRATOR_AUTOLAUNCH` (`false` disables auto-launch), `TITANIUM_BYPASS` (currently
  `true` in prod — see docs/auth.md), `COOLIFY_TOKEN`, `E4A_*`.
- **Ghost-session reaper** (`hub/src/ws/ghost-reaper.ts`): a boot-started sweep that reaps
  **ghost sessions** — a `sessions` row stuck `status='online' AND hostname IS NULL` with a live
  phantom agent channel but no genuinely-live CLI behind it (a hostname-less `/ws/agent` re-auth;
  see the agent-auth path in `hub/src/ws/agent.ts`). A ghost fools the orchestrator inject's
  `getChannel != null` liveness check, so it dispatches into the void and autospawn never fires.
  The sweep closes the phantom socket (`4004 ghost_reaped`), unregisters the channel, and flips the
  row `offline` so the next tick autospawns a real session. Never reaps `is_orchestrator=true`.
  Knobs: **`REMO_GHOST_GRACE_MS`** (default **120000** = 2min; non-positive/non-finite ⇒ default) —
  min age of the online+hostname-NULL signature before it's a ghost; **`REMO_GHOST_SWEEP_INTERVAL_MS`**
  (default **60000**) — sweep cadence; **`REMO_GHOST_REAPER_DISABLED`** (accepts `1|true|yes|on`) —
  escape hatch making the sweep a no-op. Companion inject-side guard: `injectOrchestratorPrompt`
  routes ghosts to `maybeAutospawnOffline` via an `isSessionLive` check (channel present AND NOT a
  ghost) instead of the raw `getChannel != null`.
- **`REMO_ORCHESTRATOR_ENABLED`** (default **OFF** / `'0'`; accepts `1|true|yes|on`): gates the
  **auto-dev orchestrator** live cycle path (Phases 21–32). When OFF,
  `registerCycleRunnerIfEnabled()` (the ONLY caller of the Phase-22 queue `setCycleRunner`) is a
  no-op, so the routine-queue drain worker (`hub/src/orchestrator/queue.ts`) claims nothing AND
  the due-scan enqueue tick never starts — nothing is registered/enqueued/injected; prod stays
  fully dormant on the e2e-unproven queue. `registerCycleRunnerIfEnabled()` is called once at boot
  (`hub/src/index.ts`). Companion knobs: `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` (default 2, global
  concurrent-cycle cap), `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS` (default 1000, drain interval),
  `REMO_ORCHESTRATOR_TICK_INTERVAL_MS` (default 60000, Phase-32 due-scan enqueue interval),
  `REMO_ORCHESTRATOR_STALE_LOCK_MS` (default 14_400_000 = 4h — the stale-lock reaper's threshold;
  fixes a wedge where a session whose CLI turn never completes holds the in-memory `SessionQueue`
  lock forever, silently skip-forever-ing `"run live"`) and `REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS`
  (default 3_600_000 = 1h — min gap between repeat reap notifies for the same session; see
  `hub/src/orchestrator/stale-lock-reaper.ts`). The
  Phase-32 controller→wave wiring drives dependency-aware waves directly from each tick's DUE rows
  (`hub/src/orchestrator/controller.ts` `makeCycleRunner`→`runWavesFromDueRows`). **Milestone TMAC
  (2026-06-08): the cycle-runner now defaults to the resume-heartbeat MACRO path** — `useMacroPath()`
  routes each tick through `runMacroCycle` (resolve `scheduled_tasks.macro_task_type` → one autonomous
  macro prompt via `task-macros.ts`, reconcile the prior reply's `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>`
  sentinels via `sentinels.ts` into `routine_run_log` + stage-gated `notify.ts` fan-out, halt on an open
  mandatory gate per `lifecycle_stage`, else re-inject — cost-capped). The legacy per-micro-command-row
  wave path and its **`REMO_ORCHESTRATOR_LEGACY_WAVES`** rollback flag are **DELETED** — the macro path
  is the ONLY cycle path, guarded by `hub/test/orchestrator-macro-path-guard.test.ts`. Verify-tail target
  envs (no-op when unset): `REMO_VERIFY_APP_UUID`, `REMO_VERIFY_BASE_URL`, `REMO_VERIFY_ROUTES`
  (default `/api/sessions,/openapi.json,/docs`), plus `COOLIFY_TOKEN`. Off-hours merge-to-main runs
  ONLY inside the merge row's `schedule_rule.active_window` (no separate env). Full architecture:
  [docs/auto-dev-orchestrator.md](docs/auto-dev-orchestrator.md).
- **`REMO_ORCHESTRATOR_AUTOSPAWN`** (default **OFF** / `'0'`; accepts `1|true|yes|on`; milestone BSA):
  gates the **build-session autospawn** capability — when a due `dev` build task's session is OFFLINE but
  its supervisor is online, the inject seam (`hub/src/orchestrator/inject.ts`) spawns a hub-visible
  supervisor-hosted session (reusing the scheduler `launchSessionForUser` primitive) and parks the macro
  prompt in grace, so the orchestrator can take an allowlisted repo due→PR. `isAutospawnEnabled()`
  (`hub/src/orchestrator/controller.ts`) carries `REMO_ORCHESTRATOR_ENABLED` (BOTH must be ON). True no-op
  when OFF / empty allowlist. Companions: **`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP`** (default **50_000_000**
  = 50M tokens/day; non-positive/non-finite ⇒ disabled/fail-open) — the **non-bypassable daily TOKEN
  ceiling** (`dailyTokenCapGate`, `hub/src/dispatch/gates.ts`), added ALONGSIDE the dollar cost cap because
  the cost cap is meaningless on a flat-rate Max subscription. **The token cap counts ALL FOUR buckets —
  `input + output + cache_creation + cache_read`** (`getTodayTokenTotal`, `hub/src/db/token-usage-dal.ts`).
  Cache-read is NOT free against a subscription rate limit: PR #335 excluded it, and the 2026-07 wedged
  tick-loop burned **2.83B cache-read tokens in 2 days** without ever tripping the I/O-only cap.
  **`REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR`** (default **4**; non-positive/non-finite ⇒ disabled) — the
  **per-session inject-RATE ceiling** (`sessionInjectRateGate`), counting this session's injects in the
  trailing 60min from `routine_run_log` (outcome ∈ dispatched|queued|autospawn_launched|autospawn_parked);
  it makes a 1,440-turns/day tick loop impossible. And **`REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES`**
  (default **20**; non-positive/non-finite ⇒ disabled) — the per-day autospawn launch-count cap. Repo
  allowlist table **`orchestrator_autospawn_allowlist`** (per-user `repo_ident`; default EMPTY ⇒ drives
  nothing; `isRepoAutospawnAllowed`/`addRepoToAutospawnAllowlist` in `orchestrator-rows-dal.ts`). Flip
  runbook: [docs/orchestrator-autospawn-runbook.md](docs/orchestrator-autospawn-runbook.md).
- **`REMO_PTY_INTERACTIVE`** (prod: **ON** since the 2026-06-04 cutover): drives the **web**
  default human surface — `GET /api/client-config` returns `pty_interactive`, and the SPA renders
  `TerminalSurface` (interactive `claude`/`codex` TUI over the Rust ConPTY) instead of the
  stream-json `ChatSurface`. The supervisor reads its OWN `REMO_PTY_INTERACTIVE` (process env) to
  route human turns through `selectHumanPtyRunner` → `ClaudePtyBridge` (Rust `pty_host.rs`).
  Requires supervisor ≥ v0.9.0 (the Rust-ConPTY wiring; older MSIs break on this flag). Backend
  selection gated by `claude_interactive_confirmed` (supervisor config.json / `REMO_CLAUDE_INTERACTIVE_CONFIRMED=1`)
  — operator-overridden to Claude-PTY now; **re-verify June-15 billing** (`docs/cutover-gate-june15.md`).
- **`REMO_TELEGRAM_TRANSCRIPT_TAIL`** (default OFF — **keep OFF in Coolify**): independently gates
  the Telegram outbound transcript-tail source. DECOUPLED from `REMO_PTY_INTERACTIVE` (#247) because
  transcript-tail reads on-disk CLI transcripts that don't exist in the hub container; with it OFF,
  Telegram outbound uses the host-agnostic stream-json event-bus. ChatSurface is **kept** as fallback
  (deletion still gated on the device attestation in [docs/cutover-gate-june15.md](docs/cutover-gate-june15.md)).
- **Session-run leak backstop** (`hub/src/sessions/stale-run-reaper.ts`, fix/stop-the-bleed):
  boot-started sweep that closes OPEN `session_runs` rows **that nothing live backs** —
  `exit_reason='no_live_backing'`. `hub/src/sessions/budget.ts` derives the supervisor concurrency cap
  from `COUNT(session_runs WHERE ended_at IS NULL)`, so ANY leaked open run permanently eats a slot and
  eventually every launch 429s `at_capacity` (the "Start ▶ silently does nothing" wedge). The KNOWN
  leak — NULL-`session_id` rows that `finalizeOrphanedRunsForSupervisor` could never match, because
  SQL `NULL = ANY(...)` is NULL so `NOT (...)` is never TRUE — is fixed in the reconciler itself
  (`session_id IS NULL OR NOT (session_id = ANY(...))`); this sweep closes the whole CLASS (rows whose
  supervisor never pushes inventory again are invisible to the reconciler). **The predicate is POSITIVE
  KNOWLEDGE, SCOPED PER SUPERVISOR** — never age, never a global `UPDATE`. The sweep runs only for
  supervisors that are CONNECTED **and have pushed `session_inventory` at least once since boot**
  (`getInventoriedSupervisors()`); for those, and only those, "absent from your inventory" proves the
  session is gone. **Zero such supervisors ⇒ the sweep is a NO-OP** (a hub that just restarted knows
  nothing and must reap nothing — an empty live-set means "I don't know", not "nothing is alive"). A
  DISCONNECTED supervisor's runs are closed by `finalizeOpenRunsForSupervisor` on socket close, not here.
  NULL-`session_id` rows are attributed by their (NOT NULL) `supervisor_id`, so they are reaped by their
  owning supervisor's sweep. Age survives only as a grace within a supervisor's scope. A run a supervisor
  reports as live is NEVER closed here, however old (age alone cannot tell a leaked row from a legitimate
  7h TEAB build; force-closing one would free its slot while the CLI kept running). Knobs:
  **`REMO_SESSION_RUN_MAX_MS`** (grace, default **86400000** = 24h; clamped to a 60s floor **inside the
  DAL**, `SESSION_RUN_MIN_AGE_FLOOR_MS`, so no caller can turn it into a fleet-wide force-close),
  **`REMO_SESSION_RUN_REAPER_INTERVAL_MS`** (default **900000**), **`REMO_SESSION_RUN_REAPER_DISABLED`**
  (`1|true|yes|on`).
- **Supervisor spawn circuit-breaker self-heal** (`supervisor/src/process-manager.ts`,
  fix/stop-the-bleed): the breaker used to latch OPEN forever — no cooldown, no probe, no hub signal
  (prod 2026-07-07→11: zero CLI spawns for four days while the hub reported healthy). It now
  half-opens after a cooldown (5min, exponential to 30min, max 5 probes). **Half-open spawns nothing** —
  it ADMITS the next genuine hub-dispatched start as the probe (so the probe is cost/token-gated by
  construction; the supervisor never replays a prompt outside `dispatch()`). The breaker closes only
  once that probe has **SURVIVED** a 30s health window — spawning is not health (a startup crash-looper
  spawns every time); a probe that spawns then dies RE-OPENS the breaker and consumes a probe. It
  REPORTS state to the hub in the `session_inventory`
  frame (`circuit_breakers[]` → `hub/src/ws/supervisor-registry.ts` → `GET /api/supervisors`, plus a
  loud hub log on every new trip). `circuit_open` is a per-run start-rejection reason
  (`SUPERVISOR_START_REJECT_REASONS`), never a supervisor-wide `stopped`.
- **Stale-run reaper** (`hub/src/scheduler/run-reaper.ts`): boot-started sweep that finalizes
  `scheduled_task_runs` stuck `status='pending'` (a dispatched run whose CLI turn never completed —
  nothing else finalizes it) as `failed`/`run_timeout` via the shared `finalizeRun`, so post-run
  actions + the email summary behave normally. Knobs: **`REMO_RUN_MAX_MS`** (default **21600000** =
  6h; non-positive/non-finite ⇒ default) — max pending age; **`REMO_RUN_REAPER_INTERVAL_MS`**
  (default **300000**) — sweep cadence; **`REMO_RUN_REAPER_DISABLED`** (`1|true|yes|on`) — no-op
  escape hatch. Finalizes with `only_if_active` (conditional `UPDATE … AND status IN
  ('pending','in_flight')`) — and so do the two finalizers that can complete AFTER a reap (TEAB's
  poll loop, the agent sender's reply path) — so a raced run is never double-finalized / its post-run
  chain never re-fires. **Ceiling coupling:** `REMO_TEAB_MAX_RUN_MS` (6h) == `REMO_RUN_MAX_MS` (6h) by
  default, so `task_type='teab'` rows use a per-row reap ceiling of
  `max(REMO_RUN_MAX_MS, REMO_TEAB_MAX_RUN_MS)` — a TEAB build is never reaped inside its own poll
  window (raising the TEAB knob raises the reaper's teab ceiling automatically).
  Companion knob (fix/sched-failures): **`REMO_TRIAGE_TIMEOUT_MS`** (default **900000** = 15min;
  non-positive/non-finite ⇒ default; read at sweep time) — max age of a pending supervisor-picked
  triage turn (`hub/src/scheduler/senders/triage.ts`) before it's finalized `failed`/`triage_timeout`.
  Replaces a hardcoded 5min that was shorter than a real Coolify triage turn and falsely failed
  healthy runs.
  Companion fix: `log_check` with no resolvable Coolify app now finalizes **`skipped`**, not `failed`
  (uuid resolved from `payload` → session `repo_key` → `coolify_app_repo`). NOTE `skipped` still
  matches `on:'failure'` post-run chains (`post-run/dispatcher.ts` matches failed|skipped|cancelled) —
  the change buys a truthful status, not chain suppression. See
  [docs/scheduled-tasks.md](docs/scheduled-tasks.md).
- **TEAB task knobs** (milestone TEAB; see [docs/teab-tasks.md](docs/teab-tasks.md)). Hub-side:
  **`REMO_TEAB_POLL_INTERVAL_MS`** (default **30000** = 30s) — `teab_status` poll cadence for the
  hub-driven poll-to-terminal loop; **`REMO_TEAB_MAX_RUN_MS`** (default **21600000** = 6h) — hard
  ceiling after which an in-flight TEAB run is finalized as `teab_run_timeout`. Both read at
  poll-start (non-positive/non-finite ⇒ default). Supervisor-side (process env): **`TEAB_BIN`**
  (override the `teab` binary name/path), **`TEAB_CLAUDE_BIN`** / **`TEAB_GUARD_HOOK_PATH`** (TEAB's
  own claude-binary / D3 guard-hook knobs). The supervisor `teab_run`/`teab_status` capability ships
  ONLY with a new signed MSI (≥ the TEAB release) — release-gated.

## Docs map — subsystems & phases

Each doc is the source of truth; **update it in the same commit** as a behavior change.
Cross-cutting prose + all historical phase rollups: [docs/claude-architecture-notes.md](docs/claude-architecture-notes.md).

| Subsystem / phase | Doc | One-liner |
|---|---|---|
| Scheduled tasks | [scheduled-tasks.md](docs/scheduled-tasks.md) | Hub cron scheduler (`hub/src/scheduler/`); fan-out, cost-cap, post-run actions, Phase-11 workflows. **Milestone once:** `schedule_kind='once'` + `run_at` — one-time tasks fire exactly once then self-finalize (no re-arm), reusing the whole dispatch/finalize/post-run pipeline; `/api/ext/work` enqueues each item as a gated `task_type='work'` one-time task (`/api/ext/ask` still on its own path, TODO). Contract tests: `hub/test/scheduler.test.ts`, `hub/test/once-tasks.test.ts`, `hub/test/once-work-sender.test.ts`. |
| Error capture | [error-capture.md](docs/error-capture.md) | Sentry-style intake (`hub/src/error-capture/`) → dispatch into repo-bound session; SDK auto-install for 4 stacks. |
| Feedback intake (Option A) | [feedback-intake.md](docs/feedback-intake.md) | Public per-app end-user feedback (`POST /api/feedback/:token`, `feedback_keys`) → screenshot+comment dispatched into bound session via shared pipeline. Embeddable `feedback-widget.js`. Bounded by per-token/per-IP rate limit + non-bypassable cost cap. NOT Revanote. |
| Repo grouping | [repo-grouping.md](docs/repo-grouping.md) | Per-user, many-to-many repo groups (`/api/repo-groups`; `repo_groups`/`repo_group_members`/`user_repo_group_state`). Grouped + collapsible Connections table + sidebar; `repo_ident` = `github://owner/repo` or `path://<abs>`. Shared collapse state; a repo in N groups renders under each; trailing Ungrouped section. |
| Grid view | [grid-view.md](docs/grid-view.md) | Multichat grid `#/grid` (up to 12 sessions); `ChatSurface` densities, `@tanstack/react-virtual`. Virtual **Default tab** (`__default__`) auto-shows all active sessions; sessions move between user tabs; active tab+cell persist in `user_grid_state` (`GET/PATCH /api/chat-tabs/grid-state`). |
| Chat UI architecture | [chat-ui-architecture.md](docs/chat-ui-architecture.md) | Reusable `ChatSurface` spec: component tree, hooks, the transport-adapter seam (portable core vs remo-code WS), attachments/mic/streaming/permissions/slash, theming. Canonical chat-UI pattern for all apps. |
| Codex + rootless | [codex-and-rootless.md](docs/codex-and-rootless.md) | Phase 05 — Codex CLI runner, rootless ambient sessions, instructions sync. |
| Coolify self-heal | [coolify-webhook-migration.md](docs/coolify-webhook-migration.md) | Phase 06 — Coolify webhook → triage run → optional `github_issue`. |
| Auth (Titanium) | [auth.md](docs/auth.md) | Phase 07 — magic-link + opaque cookie sessions + license gate. `TITANIUM_BYPASS` active in prod. |
| Revanote | [revanote.md](docs/revanote.md) | Phase 08 — visual-annotation webhook → session → `<<JSON>>` callback (retry curve). |
| Orchestrator session | [claude-architecture-notes.md](docs/claude-architecture-notes.md) | Auto-launching root-folder coordinator session; exactly one open per user. |
| Telegram bridge | [telegram-bridge.md](docs/telegram-bridge.md) | Phase 12 → **Phase 20 transcript-tail**: bidirectional Telegram ↔ session re-sourced from each backend's on-disk transcript (Claude projects JSONL / Codex rollout JSONL + scrape fallback) after the Phase-17 stream-json rip; fail-closed permission/`user_question` keystroke-injection keyed by `(sessionId,requestId)`; per-session PTY write-arbitration turn lock; human-only guard (no automation drives the PTY); no API key. |
| Mobile Tauri client | [mobile-client.md](docs/mobile-client.md) · [phase-12-pause-state.md](docs/phase-12-pause-state.md) | Phase 12 — iOS/Android WebView shell + deep-link auth. **Paused 2026-05-28.** |
| Shared dispatch + intake | [claude-architecture-notes.md](docs/claude-architecture-notes.md) | `hub/src/dispatch/` (gates→queue→grace→finalize) + `hub/src/webhooks/intake.ts`. All inbound subsystems ride these. |
| Usage cost ledger | [usage-cost.md](docs/usage-cost.md) | P2 — per-turn token+cost capture (`usage_event`) → `token_usage` + `token_usage_daily` → `GET /api/usage/cost`. SDK `total_cost_usd` authoritative; `hub/src/usage/pricing.ts` is fallback only. Cost is a list-price ESTIMATE. Cap (P3) unaffected. Needs supervisor ≥0.8.0. |
| PTY terminal surface + cutover gate | [usage-cost.md](docs/usage-cost.md) · [cutover-gate-june15.md](docs/cutover-gate-june15.md) | Phases 15–19 — universal raw-terminal (PTY) human path (interactive `claude`/`codex` TUI, raw bytes, NO stream-json, NO API key). Phase-18 dual-bucket usage (interactive vs programmatic). Phase-19 fail-safe default-backend selector (`supervisor/src/runners/backend-selector.ts`), Codex/Gemini-stub fallback + shared `env-sanitize.ts`, and the June-15 cutover gate (`tools/cutover-deletion-gate.mjs`). Cutover flip + ChatSurface deletion are GATED (pending runbook + on-device attestations). |
| Auto-dev orchestrator | [auto-dev-orchestrator.md](docs/auto-dev-orchestrator.md) · [.planning/architecture/auto-dev-task-prompts-SPEC.md](.planning/architecture/auto-dev-task-prompts-SPEC.md) | Phases 21–32 — session-level auto-dev: one `orchestrator` task per session + `orchestrator_rows`; global `routine_queue` + per-session lock; verify-tail. **Flag-gated OFF** (`REMO_ORCHESTRATOR_ENABLED`). **Milestone TMAC (2026-06-08): macro path is the default** — a task carries one `macro_task_type` (dev complete; maintenance/security/brainstorming stubs) resolved to ONE autonomous macro prompt (`task-macros.ts`); resume-heartbeat controller (`runMacroCycle`) reconciles `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>` sentinels (`sentinels.ts`) → `routine_run_log` + stage-gated `notify.ts` fan-out, halt on mandatory gate. Legacy micro-row wave path + its `REMO_ORCHESTRATOR_LEGACY_WAVES` rollback flag DELETED (guard test asserts they stay gone). Migrations: `hub/scripts/migrate-legacy-tasks-to-orchestrator.ts`, `migrate-orchestrator-macro-task-type.ts`. |
| Session-Ask API | [session-ask.md](docs/session-ask.md) | Milestone ASK — external agent surface `/api/ext` (api_key + additive nullable `api_keys.scopes`: `ext:read`/`ext:ask`). FREE reads of a session's transcript tail + memory via READ-ONLY supervisor commands `session_transcript_tail`/`session_memory` (works for PTY sessions; **needs a new signed supervisor release**). PAID `POST /api/ext/sessions/:id/ask` answered by a stream-json ask-session on the target's `project_dir` — the human's PTY is NEVER written to; actor is server-inferred `external-ask`, so `humanOnlyPtyGate` rejects a PTY target. Gates: threshold → cost cap → **token cap** → human-only-PTY → `askRateGate` (`REMO_ASK_MAX_PER_HOUR`, default 10). `session_asks` + reaper (`REMO_ASK_MAX_MS`, 15min). MCP server in `mcp/`. Phase 4 (PTY-native ask) owner-gated, NOT shipped. |
| Inbound-email work (`remo_work`) | [remo-work.md](docs/remo-work.md) | Milestone WORK — `POST /api/ext/work` (+ `GET /api/ext/work/:id`): an inbound CLIENT EMAIL → the repo's stream-json session. **THE AGENT PROPOSES, THE HUB DISPOSES**: the agent's authority ends at a pushed `work/<nonce>` branch (no deploy credentials in its env — `scrubDeployCredentials` in `supervisor/src/runners/env-sanitize.ts`; it is not even TOLD whether the site auto-publishes). The HUB then verifies the branch DIFF touches only `work_sites.site_dir` (`work_diff_scope` — this, not the prompt, is the boundary), runs the build itself (`work_build`, real exit code), probes the site over real HTTPS, and performs the merge + Coolify deploy ITSELF (`hub/src/work/publish.ts` `mayPublish` = auto_publish AND diff-scope AND build AND 2xx). `published=true` is only ever written on a hub-performed deploy. Entry gates (default-EMPTY): `work_repo_allowlist` (audit F6 ⇒ 403, no spend), `work_sites.client_emails` sender allowlist (⇒ 403 `unknown_sender`). Audit trail `work_runs` (F9: source email + FULL prompt + branch + commit SHAs + `hub_qc` evidence + deploy_status). Dispatch gates: threshold → cost cap → **token cap** → human-only-PTY (actor `external-work`) → `workRateGate` (`REMO_WORK_MAX_PER_HOUR`, 4) → `workRepoAllowlistGate`. Scope `ext:work`. Reaper `REMO_WORK_MAX_MS` (45min). **New supervisor MSI REQUIRED** (`work_diff_scope`/`work_build`/`work_publish`). MCP: `remo_work`/`remo_get_work`. |
| API docs | [api.md](docs/api.md) · `/openapi.json` · `/docs` | OpenAPI 3.1 assembled in `hub/src/api/_openapi.ts`; run `bun run docs:sync` after route changes (docs-drift CI enforces). |
| TEAB tasks | [teab-tasks.md](docs/teab-tasks.md) · [.planning/TEAB-MILESTONE.md](.planning/TEAB-MILESTONE.md) | Milestone TEAB — `task_type:'teab'` scheduled task runs `teab run --repo <X>` on the supervisor host (allowlisted `teab_run`/`teab_status` commands; preflight fails closed; NO bypassPermissions / NO programmatic claude flags). Hub-driven background poll-to-terminal (idle-teardown-safe) → `finalizeRun` → post-run actions; cost/token cap unchanged. Columns `teab_repo_ident`/`teab_last_status`. **A new signed supervisor MSI is REQUIRED** for `teab_run` to exist on installed hosts. |

## Cross-cutting invariants (do not violate)

- **Untrusted inbound text NEVER reaches production trust — and the PROMPT is not the control.**
  An inbound client email (`/api/ext/work`) is the least-authenticated input in the system and it
  points an agent with file-write powers at a LIVE CLIENT WEBSITE. Every gate is CODE, not prose:
  (1) `work_repo_allowlist` EMPTY by default ⇒ 403 before any row/dispatch/spend (audit F6);
  (2) `work_sites.client_emails` sender allowlist ⇒ an unknown `source.from` never reaches a session;
  (3) the work session's env has NO deploy credential (`sanitizeSpawnEnv(..., {scrubDeployCredentials:true})`
  in `supervisor/src/runners/claude-runner.ts`) — an injected agent has nothing to deploy WITH;
  (4) the HUB verifies the branch DIFF stays under `work_sites.site_dir`, runs the BUILD, and probes
  HTTPS ITSELF (`hub/src/work/verify.ts`) — the agent's self-report is advisory metadata and gates
  nothing; (5) the HUB performs the publish (`hub/src/work/publish.ts` `mayPublish`: `auto_publish`
  DEFAULT FALSE **AND** hub diff-scope **AND** hub build **AND** hub 2xx), and `published=true` is
  written only on a deploy the hub performed. Never move a gate back into the prompt, never let an
  agent claim drive `published`, and never add a hosting provider without adding its credential to
  `DEPLOY_KEY_DENYLIST`. See [docs/remo-work.md](docs/remo-work.md) §1 (code-enforced vs advisory).
- **Cost cap is non-bypassable.** Every inbound user→session dispatch flows through the shared
  `dailyCostCapGate` in `hub/src/dispatch/gates.ts` (single source of truth — `isOverCostCap`).
  P3a: the cap counts REAL accumulated token cost for today (user tz), summed from `token_usage`
  via `getTodayTokenCostUsd` (same tz-day boundary as `/api/usage/cost`). **Manual / interactive
  chat IS now capped** — not just scheduled runs. `token_usage` is the single source (it records
  every `usage_event`, including scheduled runs), so scheduled-run cost is not double-counted.
  **The companion non-bypassable daily TOKEN cap** (`dailyTokenCapGate`, default 50M tokens/day) rides
  ALONGSIDE the cost cap on **EVERY** dispatch gate list — orchestrator inject, scheduler agent +
  triage, error-capture, feedback, revanote, telegram (fix/stop-the-bleed; it previously rode ONLY the
  inject path, leaving every other path bounded solely by a dollar cap that is meaningless on a
  flat-rate Max subscription). The token cap never replaces the cost cap. Enforced by
  `hub/test/token-cap-coverage.test.ts` (bracket-balanced scan of every `gates: [...]` in `hub/src`; an
  unparseable list hard-fails CI); proven to actually FIRE by `hub/test/token-cap-gate-fires.test.ts` +
  `hub/test/e2e/orchestrator-tokencap.e2e.test.ts` (cache-read alone trips it — the 2026-07 incident
  shape). **The token cap FAILS CLOSED**: a non-positive / unparseable
  `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` no longer disables the ceiling — it falls back to the 50M default
  AND the hub **refuses to boot** (`assertTokenCapConfig()` in `hub/src/index.ts`). The ONLY way to run
  with no ceiling is the explicit **`REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED=1`** (boots with a loud
  warning). A typo'd `0` must never silently become an unbounded spend path.
- **Untrusted inbound payloads are FENCED as data and every machine-triggered dispatch carries
  the scope contract; machine self-heal is propose-only (PR) unless an explicit per-key trust
  flag says otherwise.** One shared module — `hub/src/dispatch/untrusted.ts` (`fenceUntrusted`
  escapes every `<` so a payload can't close its own fence, and truncates with an explicit
  `[truncated]` marker; `SCOPE_CONTRACT` = data-not-instructions + minimal change + no unrelated
  files/deps/CI + stop-rather-than-guess + propose-only). Used by error-capture, revanote,
  feedback and Coolify triage prompt builders. A machine path NEVER instructs the agent to push
  to main / merge / deploy: revanote's `deploy_strategy='direct'` and `auto_merge` are inert
  unless `revanote_app_mappings.trusted = true` (default FALSE). Machine-triggered spawns force
  `dangerously_skip_permissions: false` (`dispatch/spawn-on-error.ts`, `scheduler/senders/triage.ts`)
  regardless of the session-row default. Every self-heal gate list carries `sessionInjectRateGate`
  alongside the cost + token caps — a report flood cannot buy N turns/hour.
- **Public webhooks: raw body BEFORE JSON parse**, constant-time secret compare, HMAC over
  `${ts}.${rawBody}`, reject >5min skew. Webhooks mount BEFORE the `/api/*` auth catch-all;
  license gate after auth; `/ws/agent` keyed by `api_keys`. `hub/test/mount-order.test.ts` enforces.
- **Don't hand-roll per-subsystem dispatch/queue/grace.** Round-2 collapse is complete — use
  `hub/src/dispatch/` (the old `scheduler/session-queue.ts` shim is deleted).
- **One-time tasks are `scheduled_tasks`, not a parallel queue (milestone once).** A
  `schedule_kind='once'` row fires exactly once at `run_at` then self-finalizes; it reuses the
  SAME dispatch pipeline, gates, `finalizeRun`, post-run actions, and email summary as a cron
  task. `/api/ext/work` (and, later, `/ask`) creates a GATED one-time task as its queue entry —
  the trust checks (repo allowlist · site · sender) run at CREATE (403 before any row/spend) and
  `dispatchWork`'s non-bypassable gate list runs again at RUN. No scheduling path may reach a
  repo/site that direct dispatch couldn't. See docs/scheduled-tasks.md §one-time.
- **No provider API key on the human PTY path — EVER.** The interactive terminal surface spawns the
  GENUINE `claude`/`codex` TUI with an ALLOWLIST-OF-ONE argv — empty except for the optional
  operator-blessed `--dangerously-skip-permissions` (a PERMISSION flag, gated by config
  `allowDangerousSkipPermissions`; same ceiling as the stream-json runner). The forbidden programmatic
  tokens stay forbidden: no `-p`/`--print`/`--input-format`/`--output-format`/`stream-json`, no API key.
  The bridge threads it as the spawn-frame `dangerously_skip_permissions` field; `pty_host.rs` turns it
  into the sole argv token. It routes every spawn env through the shared `supervisor/src/runners/env-sanitize.ts` (named denylist +
  anchored credential-class patterns; scrubs inherited vars + setup-token). Fallback is a backend-CLI swap
  (Codex via ChatGPT sign-in, stubbed Gemini), never the API. The fail-safe default-backend selector
  (`backend-selector.ts`) resolves human sessions to `claude-pty`/`codex-pty` only — never the legacy
  stream-json runner — and defaults to `codex-pty` until the June-15 cutover gate confirms interactive
  billing. The stream-json path is PRESERVED for unattended automation only, behind the cost cap.
  Cutover flip + ChatSurface deletion are GATED on `tools/cutover-deletion-gate.mjs` (Phase-16 on-device
  attestations). Enforced by `supervisor/test/{no-api-key-no-streamjson-pty,no-apikey-fallback-guard,default-backend-selector}.test.ts`.
- **API keys are scoped; `agent` IS the host-spawn credential.** `api_keys.scopes` (TEXT[],
  NULLABLE — NULL/empty = legacy full access, zero migration) gates: `agent` (`/ws/agent` both
  roles + `/api/plugin/*`), `ext:read`, `ext:ask` (`/api/ext/*`). An external consumer gets an
  `ext:*`-only key and can never spawn a CLI on a host. **`ext:work` (live-site publish via
  `POST /api/ext/work`) is EXPLICIT-only** — the gate uses `hasExplicitScope`, so a legacy/NULL
  key (incl. the supervisor's own `purpose='supervisor'` spawn key) does NOT satisfy it and can
  no longer publish to a client site; `ext:read`/`ext:ask` stay NULL-permissive by design. **`/api/api-keys` is cookie-auth ONLY —
  an api key must NEVER be able to mint an api key.** N keys per user; only `purpose='supervisor'`
  and `purpose='orchestrator'` stay at-most-one-active (partial unique indexes). Helpers:
  `hub/src/auth/scopes.ts`; enforced by `hub/test/api-keys-scopes.test.ts`. See docs/auth.md.
- **schema.sql re-runs every boot** — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- **Orchestrator:** exactly one open per user (`idx_sessions_orchestrator_unique`); never set
  `orchestrator_enabled=false` without also setting `orchestrator_disabled_explicitly=true`
  (the boot backfill re-enables otherwise). Detail in the architecture-notes archive.

## Deployment / Releases

- **Hub:** Docker multi-stage (`Dockerfile`) on Coolify at `app.remo-code.com`, port 3040.
  The supervisor runs locally on the dev machine — **not** deployed.
- **Supervisor:** per-user NSIS installer (UAC-free auto-update; `installMode: currentUser`,
  `auto_update` defaults ON since v0.13.0). Push a `supervisor-v*.*.*` tag →
  `.github/workflows/release-supervisor.yml` builds + signs the `-setup.exe` + publishes a
  Release with `latest.json` for the auto-updater. Local:
  `pwsh -File supervisor/tauri/scripts/build-and-update.ps1`. Key setup: `supervisor/tauri/UPDATER-SETUP.md`.

## CI (Woodpecker-first)

CI/PR-checks/smoke run on **Woodpecker** (`.woodpecker/*.yaml`, one pipeline per file) —
GitHub Actions is reserved for what Woodpecker's `linux/amd64` runner can't do.

- **Woodpecker:** `qc.yaml` (PR-gate: typecheck + `check-baseline` + `migration-verify` +
  orchestrator Postgres-e2e), `docs-drift.yaml` (PR docs-sync drift), `post-deploy-smoke.yaml`
  (push-to-main prod HTTPS smoke after the Coolify rollout).
- **GitHub Actions (platform-locked, keep here):** `release-supervisor.yml` (windows-latest +
  signed MSI/`latest.json`, TAURI signing secrets), `release-mobile.yml` (Windows MSI/NSIS +
  Android APK), `mobile-ios-build.yml` (macOS + Apple toolchain), `mobile-shell-typecheck.yml`
  (paused, manual-only). The mobile workflows are dormant (Phase 12 paused).

When adding a check, default to a new `.woodpecker/*.yaml` pipeline; only reach for GHA if it
needs Windows/macOS or signing secrets.

## PR Hygiene

Periodically `gh pr list` — review open PRs for conflicts, stale branches, or already-applied
changes; flag any to close or merge.
