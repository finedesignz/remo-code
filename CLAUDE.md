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
  wave path is preserved behind **`REMO_ORCHESTRATOR_LEGACY_WAVES=1`** (rollback only) and guarded by
  `hub/test/orchestrator-macro-path-guard.test.ts`. Verify-tail target
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
| Scheduled tasks | [scheduled-tasks.md](docs/scheduled-tasks.md) | Hub cron scheduler (`hub/src/scheduler/`); fan-out, cost-cap, post-run actions, Phase-11 workflows. Contract test: `hub/test/scheduler.test.ts`. |
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
| Auto-dev orchestrator | [auto-dev-orchestrator.md](docs/auto-dev-orchestrator.md) · [.planning/architecture/auto-dev-task-prompts-SPEC.md](.planning/architecture/auto-dev-task-prompts-SPEC.md) | Phases 21–32 — session-level auto-dev: one `orchestrator` task per session + `orchestrator_rows`; global `routine_queue` + per-session lock; verify-tail. **Flag-gated OFF** (`REMO_ORCHESTRATOR_ENABLED`). **Milestone TMAC (2026-06-08): macro path is the default** — a task carries one `macro_task_type` (dev complete; maintenance/security/brainstorming stubs) resolved to ONE autonomous macro prompt (`task-macros.ts`); resume-heartbeat controller (`runMacroCycle`) reconciles `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>` sentinels (`sentinels.ts`) → `routine_run_log` + stage-gated `notify.ts` fan-out, halt on mandatory gate. Legacy micro-row wave path KEPT behind `REMO_ORCHESTRATOR_LEGACY_WAVES=1` (rollback) + guard test. Migrations: `hub/scripts/migrate-legacy-tasks-to-orchestrator.ts`, `migrate-orchestrator-macro-task-type.ts`. |
| API docs | [api.md](docs/api.md) · `/openapi.json` · `/docs` | OpenAPI 3.1 assembled in `hub/src/api/_openapi.ts`; run `bun run docs:sync` after route changes (docs-drift CI enforces). |
| TEAB tasks | [teab-tasks.md](docs/teab-tasks.md) · [.planning/TEAB-MILESTONE.md](.planning/TEAB-MILESTONE.md) | Milestone TEAB — `task_type:'teab'` scheduled task runs `teab run --repo <X>` on the supervisor host (allowlisted `teab_run`/`teab_status` commands; preflight fails closed; NO bypassPermissions / NO programmatic claude flags). Hub-driven background poll-to-terminal (idle-teardown-safe) → `finalizeRun` → post-run actions; cost/token cap unchanged. Columns `teab_repo_ident`/`teab_last_status`. **A new signed supervisor MSI is REQUIRED** for `teab_run` to exist on installed hosts. |

## Cross-cutting invariants (do not violate)

- **Cost cap is non-bypassable.** Every inbound user→session dispatch flows through the shared
  `dailyCostCapGate` in `hub/src/dispatch/gates.ts` (single source of truth — `isOverCostCap`).
  P3a: the cap counts REAL accumulated token cost for today (user tz), summed from `token_usage`
  via `getTodayTokenCostUsd` (same tz-day boundary as `/api/usage/cost`). **Manual / interactive
  chat IS now capped** — not just scheduled runs. `token_usage` is the single source (it records
  every `usage_event`, including scheduled runs), so scheduled-run cost is not double-counted.
  **BSA (orchestrator inject path) adds a companion non-bypassable daily TOKEN cap** (`dailyTokenCapGate`,
  default 50M tokens/day) ALONGSIDE the cost cap — `inject.ts` gate list is `[thresholdGate,
  dailyCostCapGate, dailyTokenCapGate]`; the token cap never replaces the cost cap, and the dollar cost
  cap is meaningless on a flat-rate Max subscription.
- **Public webhooks: raw body BEFORE JSON parse**, constant-time secret compare, HMAC over
  `${ts}.${rawBody}`, reject >5min skew. Webhooks mount BEFORE the `/api/*` auth catch-all;
  license gate after auth; `/ws/agent` keyed by `api_keys`. `hub/test/mount-order.test.ts` enforces.
- **Don't hand-roll per-subsystem dispatch/queue/grace.** Round-2 collapse is complete — use
  `hub/src/dispatch/` (the old `scheduler/session-queue.ts` shim is deleted).
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
- **schema.sql re-runs every boot** — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- **Orchestrator:** exactly one open per user (`idx_sessions_orchestrator_unique`); never set
  `orchestrator_enabled=false` without also setting `orchestrator_disabled_explicitly=true`
  (the boot backfill re-enables otherwise). Detail in the architecture-notes archive.

## Deployment / Releases

- **Hub:** Docker multi-stage (`Dockerfile`) on Coolify at `app.remo-code.com`, port 3040.
  The supervisor runs locally on the dev machine — **not** deployed.
- **Supervisor:** push a `supervisor-v*.*.*` tag → `.github/workflows/release-supervisor.yml`
  builds + signs the MSI + publishes a Release with `latest.json` for the auto-updater. Local:
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
