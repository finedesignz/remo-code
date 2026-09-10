# Codebase Structure

**Analysis Date:** 2026-07-12

## Monorepo Layout

Bun workspace — `workspaces: ["hub", "web", "supervisor", "supervisor/tauri/ui"]`. One `bun.lock` at the root; each workspace has its own `package.json`.

## Directory Layout

```
remo-code/
├── hub/                          # Backend: Bun + Hono, port 3040. The only network service.
│   ├── src/
│   │   ├── index.ts              # Composition root — mount order, WS upgrades, boot sweeps
│   │   ├── config.ts             # Typed env parse (fatal on missing required)
│   │   ├── session.ts            # Opaque cookie sessions
│   │   ├── csrf.ts               # Double-submit CSRF
│   │   ├── license-gate.ts       # Titanium license_status middleware (+ exclusion list)
│   │   ├── titanium-client.ts    # JWKS-cached EdDSA verify + license validate
│   │   │
│   │   ├── dispatch/             # ★ SHARED INBOUND PIPELINE — every subsystem rides this
│   │   │   ├── pipeline.ts       #   dispatch() / onSessionReply() — gates→queue→grace→finalize
│   │   │   ├── gates.ts          #   cost cap, token cap, inject-rate, concurrency, human-only-PTY
│   │   │   ├── session-queue.ts  #   1 in-flight + 1 waiter per session_id
│   │   │   ├── grace.ts          #   offline-supervisor buffer + replay
│   │   │   └── spawn-on-error.ts #   autospawn seam (offline session, online supervisor)
│   │   ├── webhooks/intake.ts    # ★ SHARED PUBLIC-WEBHOOK GATE (raw body → HMAC → skew → IP)
│   │   │
│   │   ├── api/                  # REST, one file per resource (~40 routers)
│   │   │   │                     #   public (pre-auth): sentry-intake, coolify-webhook,
│   │   │   │                     #   revanote-webhook, feedback-webhook, telegram-webhook,
│   │   │   │                     #   webhooks-titanium, well-known
│   │   │   │                     #   authed: sessions, messages, api-keys, scheduled-tasks,
│   │   │   │                     #   scheduled-task-runs, orchestrator, orchestrator-tasks,
│   │   │   │                     #   repo-groups, chat-tabs, usage, supervisors, github,
│   │   │   │                     #   errors/error-*, feedback-keys, revanote-*, telegram,
│   │   │   │                     #   profile, account, auth, admin, setup, transcribe,
│   │   │   │                     #   commands, instructions, introspect, tasks, plugin
│   │   │   ├── client-config.ts  #   → drives PTY-vs-ChatSurface surface choice in the SPA
│   │   │   └── _openapi.ts       #   OpenAPI 3.1 assembly (bun run docs:sync)
│   │   │
│   │   ├── ws/                   # Realtime
│   │   │   ├── client.ts         #   /ws/client — browser (subscribe ≤12, chat + activity)
│   │   │   ├── agent.ts          #   /ws/agent — supervisor (api_key auth, stream-json relay)
│   │   │   ├── protocol.ts       #   Zod: client msgs · agent-protocol.ts · supervisor-protocol.ts
│   │   │   ├── term-protocol.ts  #   raw PTY byte pipe
│   │   │   ├── registry.ts · supervisor-registry.ts   #   live channel maps
│   │   │   ├── ghost-reaper.ts   #   ★ reaps online+hostname-NULL phantom channels
│   │   │   ├── idle-teardown.ts  #   0 subscribers → shutdown after grace
│   │   │   └── pending-prompts.ts · send-dedupe.ts · origin-guard.ts
│   │   │
│   │   ├── scheduler/            # Cron scheduler
│   │   │   ├── registry.ts · cron.ts · dispatcher.ts · targets.ts · catchup.ts
│   │   │   ├── run-reaper.ts     #   ★ finalizes runs stuck 'pending'
│   │   │   ├── senders/          #   agent · supervisor · coolify · triage · teab
│   │   │   ├── post-run/         #   dispatcher + email/telegram/webpush/webhook/
│   │   │   │                     #   github-issue/deploy-verify/propose-notify/aggregator
│   │   │   ├── context/ · prompts/ · task-templates.ts · workflows.ts
│   │   │   └── *-schema.ts       #   Zod result schemas (qc, triage, controller)
│   │   │
│   │   ├── orchestrator/         # Auto-dev orchestrator (REMO_ORCHESTRATOR_ENABLED, default OFF)
│   │   │   ├── controller.ts     #   env gates, due-scan tick, registerCycleRunnerIfEnabled()
│   │   │   ├── macro-cycle.ts    #   ★ DEFAULT path — runMacroCycle + reconcileSentinels
│   │   │   ├── task-macros.ts    #   macro_task_type → one autonomous prompt
│   │   │   ├── sentinels.ts      #   <<STATE>> / <<NOTIFY>> / <<GATE>> parsing
│   │   │   ├── inject.ts         #   gated inject (4 gates) or autospawn-park
│   │   │   ├── queue.ts          #   global routine_queue + drain worker
│   │   │   ├── stale-lock-reaper.ts  # ★ releases wedged SessionQueue locks
│   │   │   ├── waves.ts · wave-runner.ts · command-set.ts · command-prompts.ts
│   │   │   │                     #   LEGACY micro-row path — REMO_ORCHESTRATOR_LEGACY_WAVES=1 only
│   │   │   ├── due-rows.ts · stage-detect.ts · stage-presets.ts · gap-rotation.ts
│   │   │   ├── notify.ts · run-log.ts · verify-tail.ts · merge-command.ts
│   │   │   └── propose.ts · seed-prompt.ts · auto-launch.ts · orphan-resume.ts
│   │   │
│   │   ├── error-capture/        # Sentry-style intake → fingerprint → gates → dispatch
│   │   │   └── setup/            #   SDK auto-install (detect · snippet · coolify-env)
│   │   ├── revanote/             # Annotation webhook → sandbox → risk → CI/merge gate → callback
│   │   ├── feedback/dispatcher.ts# Public per-app end-user feedback → bound session
│   │   ├── telegram/             # Bridge, commands, approvals, turn-lock
│   │   │   └── transcript/       #   PTY-era tail: claude/codex adapters, permission-detector,
│   │   │                         #   keystroke-map, pty-inject (REMO_TELEGRAM_TRANSCRIPT_TAIL)
│   │   ├── usage/                # store.ts (in-mem quota snapshot) · pricing.ts (fallback only)
│   │   │                         # threshold.ts · programmatic-leak.ts
│   │   ├── sessions/             # budget · routing · repo-routing · coolify-app-repo
│   │   ├── events/               # assistant / permission / question / session-activity buses
│   │   ├── observability/        # logger · als · metrics · orchestrator-metrics · cap-alert
│   │   ├── auth/                 # middleware · jwt · password · reauth · require-admin · github-app
│   │   ├── db/                   # postgres.ts · schema.sql (RE-RUNS EVERY BOOT) · migrate.ts
│   │   │                         # dal.ts + per-domain DALs (token-usage, orchestrator-rows,
│   │   │                         # scheduled-tasks, error-capture, revanote, feedback,
│   │   │                         # repo-groups, chat-tabs, supervisor)
│   │   └── middleware/ · lib/ · utils/ · runners/resume-binding.ts
│   ├── test/                     # Bun test; QC gate runs each file in its own process
│   └── scripts/                  # ★ ONE-SHOT backfills live here, never in schema.sql
│
├── web/                          # React 19 + Vite + Tailwind 4 SPA (hash router)
│   ├── src/
│   │   ├── main.tsx · App.tsx    # entry + hash router (legacy hash redirects kept forever)
│   │   ├── pages/
│   │   │   ├── HomePage.tsx      #   Tabs: List | Grid
│   │   │   ├── TasksPage.tsx     #   Tabs: Upcoming | Activity | Schedule | Orchestrator
│   │   │   │                     #     → web/src/pages/tasks/{Upcoming,Activity,Schedule,Orchestrator}Tab.tsx
│   │   │   ├── SettingsPage.tsx  #   Exactly 4 tabs → web/src/pages/settings/
│   │   │   │                     #     ConnectionsTab (orchestrator = pinned top row) ·
│   │   │   │                     #     CredentialsTab · UsageTab · ProfileTab
│   │   │   └── ActivityPage · Login · AuthCallback · Privacy · Terms
│   │   ├── components/
│   │   │   ├── TerminalSurface.tsx    # ★ PROD human surface (xterm.js over raw PTY)
│   │   │   ├── ChatSurface.tsx        #   stream-json surface — FALLBACK, deletion gated
│   │   │   ├── ChatLayout.tsx · ChatPanel.tsx · Sidebar.tsx · GridPage.tsx
│   │   │   ├── MessageBubble · ThinkingBlock · ToolUseBlock · PermissionBlock ·
│   │   │   │   QuestionBlock · ActivityFeed · UsageStrip · ClaudeUsageCard
│   │   │   ├── SchedulesPage · ScheduleEditor · CronBuilder · ScheduleRulesBuilder ·
│   │   │   │   PostRunActionsEditor · ScheduleRunsDrawer · UpcomingRunsPanel ·
│   │   │   │   AutoDevActivityPanel · TeabRepoPicker
│   │   │   ├── groups/           #   GroupSection · GroupsManager · RepoGroupChips
│   │   │   ├── orchestrator/     #   FrequencyControl
│   │   │   └── ui/               #   primitives: AppShell · Tabs · Button · Card · Modal ·
│   │   │                         #   Drawer · Field · StatusPill · Toggle · EmptyState …
│   │   ├── hooks/                # useChat · useTerminalSession · useWebSocket · useSessions ·
│   │   │                         # useClientConfig (PTY-vs-chat) · useOrchestrator · useSchedules ·
│   │   │                         # useAuth · useLicense · useSubscriptionUsage · useRepoGroups …
│   │   └── lib/                  # api · auth · term-ws · raf-batch · cron · repo-ident ·
│   │                             # gsd-templates · task-templates · session-list · push
│   └── test/                     # incl. no-indigo.test.ts (accent guard)
│
├── supervisor/                   # Local Tauri tray app — one per dev host, ships as signed MSI
│   ├── src/                      # Bun TS sidecar (compiled by `bun build --compile`)
│   │   ├── index.ts              #   `run` / `scan` subcommands; the Tauri sidecar calls `run`
│   │   ├── hub-client.ts         #   /ws/agent connection + reconnect
│   │   ├── process-manager.ts    #   per-session CLI lifecycle + concurrency counter
│   │   ├── runners/
│   │   │   ├── backend-selector.ts   # ★ fail-safe: humans → PTY backends ONLY
│   │   │   ├── claude-pty-bridge.ts · claude-pty-runner.ts · codex-pty-runner.ts ·
│   │   │   │   gemini-pty-runner.ts  #   interactive TUI path (no API key, no stream-json)
│   │   │   ├── claude-runner.ts      #   legacy stream-json — UNATTENDED AUTOMATION ONLY
│   │   │   ├── env-sanitize.ts       # ★ credential scrub on every spawn env
│   │   │   ├── pty-persistence.ts · runner-factory.ts · session-bridge.ts · types.ts
│   │   │   └── session-breadcrumb.ts · teab-breadcrumb.ts
│   │   ├── commands/             #   allowlisted run_command handlers: teab-run,
│   │   │                         #   error-setup-probe, error-setup-apply
│   │   ├── usage/oauth-poll.ts   #   5-min quota poll (OAuth token NEVER leaves the host)
│   │   ├── git-ops · git-introspect · git-push-driver · repo-scanner · commands-scanner
│   │   └── config.ts · sandbox.ts · audit.ts · safe-logging.ts · status-server.ts · version.ts
│   ├── tauri/
│   │   ├── src-tauri/src/        #   Rust shell
│   │   │   ├── main.rs · lib.rs  #     app bootstrap
│   │   │   ├── pty_host.rs       #   ★ ConPTY host — spawns the genuine TUI, per-conn sub ids
│   │   │   ├── sidecar.rs        #     Bun sidecar lifecycle (reap orphans → preflight → spawn)
│   │   │   ├── tray.rs · first_run.rs · config_cmds.rs · runtime_cmds.rs
│   │   │   └── nssm.rs · legacy_cleanup.rs · mutex_probe.rs · pty_spike.rs
│   │   ├── ui/                   #   React settings/first-run wizard UI (own workspace)
│   │   └── scripts/build-and-update.ps1 · signing/ · UPDATER-SETUP.md
│   └── test/                     # guard tests: no-legacy-agent-spawn,
│                                 # no-api-key-no-streamjson-pty, no-apikey-fallback-guard,
│                                 # default-backend-selector
│
├── docs/                         # Source of truth per subsystem — update in the SAME commit
│                                 # openapi.json + api.md are generated (bun run docs:sync)
├── .planning/                    # GSD artifacts (this file, ROADMAP, milestone specs)
├── .woodpecker/                  # CI-first: qc.yaml · docs-drift.yaml · post-deploy-smoke.yaml
├── .github/workflows/            # ONLY platform-locked jobs (Windows/macOS/signing)
├── tools/                        # regression-baseline.json · cutover-deletion-gate.mjs
├── Dockerfile                    # hub multi-stage → Coolify (app.remo-code.com)
└── CLAUDE.md
```

## Directory Purposes

**`hub/src/dispatch/`** — the load-bearing middle. Any code path that makes an agent do work goes through it. Contains no domain knowledge.

**`hub/src/orchestrator/`** — two implementations coexist: the macro path (`macro-cycle.ts` + `task-macros.ts` + `sentinels.ts`, DEFAULT) and the legacy wave path (`waves.ts` + `command-set.ts`, rollback-only behind `REMO_ORCHESTRATOR_LEGACY_WAVES=1`). Never extend the legacy one.

**`supervisor/src/runners/`** — two transports coexist: PTY runners (human) and `claude-runner.ts` stream-json (automation only). `backend-selector.ts` is the fail-safe seam between them.

**`hub/scripts/`** — one-shot data backfills. `schema.sql` re-runs on every boot, so nothing mutating may live there.

## Key File Locations

**Entry points:** `hub/src/index.ts` · `web/src/main.tsx` · `supervisor/src/index.ts` · `supervisor/tauri/src-tauri/src/main.rs`

**Configuration:** `hub/src/config.ts` · `web/.env` (`VITE_HUB_URL`) · `%LOCALAPPDATA%\remo-code-supervisor\config.json` (written by the first-run wizard)

**Core logic:** `hub/src/dispatch/pipeline.ts` (the spine) · `hub/src/dispatch/gates.ts` (the caps) · `hub/src/orchestrator/macro-cycle.ts` · `supervisor/src/runners/backend-selector.ts` · `supervisor/tauri/src-tauri/src/pty_host.rs`

**Schema:** `hub/src/db/schema.sql` — idempotent DDL ONLY.

**Testing:** `hub/test/`, `web/test/`, `supervisor/test/`. Baseline gate: `bun run check-baseline` (per-file isolation; `tools/regression-baseline.json`).

## Naming Conventions

**Files:** kebab-case TS (`macro-cycle.ts`, `ghost-reaper.ts`); PascalCase `.tsx` components; DALs suffixed `-dal.ts`; Zod schemas suffixed `-schema.ts`; Rust `snake_case.rs`; tests `*.test.ts(x)` under `test/`.

**Directories:** one lowercase dir per hub subsystem. Cross-subsystem shared code belongs in `dispatch/`, `webhooks/`, `lib/`, or `events/` — never inside a sibling subsystem.

## Where to Add New Code

**New inbound subsystem (anything that makes an agent do work):**
- Intake route → `hub/src/api/<name>-webhook.ts`, mounted BEFORE the `/api/*` auth catch-all in `hub/src/index.ts`, using `hub/src/webhooks/intake.ts`.
- Pipeline → `hub/src/<name>/dispatcher.ts`, calling `dispatch()` from `hub/src/dispatch/pipeline.ts` with `gates: [thresholdGate, dailyCostCapGate, …]`. **Never** build your own queue/grace/finalize. Minimal reference: `hub/src/feedback/dispatcher.ts`.
- DAL → `hub/src/db/<name>-dal.ts`; tables → `hub/src/db/schema.sql` (idempotent DDL only).
- Docs → `docs/<name>.md` + a row in the CLAUDE.md docs map, same commit.

**New REST route:** `hub/src/api/<resource>.ts` → mount in `index.ts` → register in `_openapi.ts` → `bun run docs:sync` (docs-drift CI fails otherwise).

**New scheduled-task type:** sender in `hub/src/scheduler/senders/` + `task_type` in the scheduler schema + a post-run path if it needs one.

**New orchestrator behavior:** extend `task-macros.ts` (the macro prompt) and/or `sentinels.ts`. Do NOT extend `waves.ts` / `command-set.ts`.

**New supervisor capability:** handler in `supervisor/src/commands/` + register in `commands/index.ts` + schema in `hub/src/ws/supervisor-protocol.ts`. **Requires a new signed MSI to reach installed hosts** — release-gate it.

**New web page/tab:** page under `web/src/pages/`, tab module under `web/src/pages/<page>/`, primitives from `web/src/components/ui/`. Accent = blue (orange is CTA-only; indigo is CI-banned by `web/test/no-indigo.test.ts`).

**Shared helper:** `hub/src/lib/` or `web/src/lib/`.

## Special Directories

| Directory | Contains | Generated | Committed |
|---|---|---|---|
| `docs/openapi.json`, `docs/api.md` | OpenAPI surface | Yes (`bun run docs:sync`) | Yes (drift-checked in CI) |
| `tools/regression-baseline.json` | Test baseline for the QC gate | Yes | Yes |
| `.planning/` | GSD roadmap, phases, codebase map | No | Yes |
| `supervisor/tauri/signing/` | MSI signing config | No | Keys NOT committed |
| `web/dist/`, `supervisor/tauri/target/` | Build output | Yes | No |

---

*Structure analysis: 2026-07-12*
