<!-- refreshed: 2026-07-12 -->
# Architecture

**Analysis Date:** 2026-07-12

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Browser SPA — `web/` (React 19 + Vite + Tailwind 4, hash router)           │
│                                                                             │
│  Human surface is SELECTED AT RUNTIME by `GET /api/client-config`:          │
│    pty_interactive=true  → `TerminalSurface.tsx`  (xterm.js over raw PTY)   │
│    pty_interactive=false → `ChatSurface.tsx`      (stream-json bubbles)     │
│  Prod = PTY (REMO_PTY_INTERACTIVE ON since 2026-06-04). ChatSurface KEPT    │
│  as fallback; deletion gated by `tools/cutover-deletion-gate.mjs`.          │
│                                                                             │
│  Routes: #/ Home (List|Grid) · #/tasks (Upcoming|Activity|Schedule|         │
│          Orchestrator) · #/settings (Connections|Credentials|Usage|Profile) │
└──────────┬────────────────────────┬─────────────────────────┬───────────────┘
           │ REST /api/*            │ WS /ws/client           │ WS /ws/term
           │ (opaque cookie)        │ (chat + activity)       │ (raw PTY bytes)
           ▼                        ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  HUB — `hub/` (Bun + Hono, ONE process, port 3040)                          │
│  Composition root: `hub/src/index.ts` (716 lines: mount order + boot)       │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ INBOUND SUBSYSTEMS (each has its own intake + prompt, NO own queue)   │  │
│  │  scheduler/ · error-capture/ · revanote/ · feedback/ · telegram/ ·    │  │
│  │  orchestrator/ · api/messages (human chat)                            │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │ ALL of them call…                            │
│                              ▼                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ SHARED DISPATCH PIPELINE — `hub/src/dispatch/`                        │  │
│  │   pipeline.ts  dispatch(req, deps) / onSessionReply(sessionId, text)  │  │
│  │   gates.ts     thresholdGate → dailyCostCapGate → dailyTokenCapGate   │  │
│  │                → sessionInjectRateGate → concurrencyGate →            │  │
│  │                humanOnlyPtyGate → (subsystem budget gates)            │  │
│  │   session-queue.ts  1 in-flight + 1 waiter per session_id            │  │
│  │   grace.ts     offline supervisor → buffer, replay on reconnect       │  │
│  │   spawn-on-error.ts  autospawn seam for offline-but-supervised repos  │  │
│  │   → finalize: run row closed on `assistant_message:final`             │  │
│  └───────────────────────────┬───────────────────────────────────────────┘  │
│                              │                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ BACKGROUND SWEEPS (all boot-started in index.ts, all env-disableable) │  │
│  │   ws/ghost-reaper.ts        online+hostname-NULL phantom agent chans  │  │
│  │   scheduler/run-reaper.ts   scheduled_task_runs stuck 'pending'       │  │
│  │   orchestrator/stale-lock-reaper.ts  SessionQueue lock never released │  │
│  │   ws/idle-teardown.ts       0 subscribers → shutdown after grace      │  │
│  │   scheduler/registry.ts     croner tick · orchestrator/queue.ts drain │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  Data: PostgreSQL (Coolify). `db/postgres.ts` + `db/schema.sql` (re-run on  │
│  EVERY boot — idempotent DDL only) + per-domain DALs.                       │
└──────────┬──────────────────────────────────────────────────────────────────┘
           │ WS /ws/agent  (api_key + project_dir + hostname)
           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  SUPERVISOR — `supervisor/` (Tauri tray app, one per dev host, MSI)         │
│  Bun sidecar `supervisor/src/index.ts` (compiled) + Rust shell              │
│  `supervisor/tauri/src-tauri/src/` (lib.rs, tray.rs, sidecar.rs, pty_host.rs)│
│                                                                             │
│  runners/backend-selector.ts decides per session:                           │
│    HUMAN turn      → claude-pty | codex-pty | gemini-pty  (raw ConPTY)      │
│    AUTOMATION turn → claude-runner.ts (stream-json, API-key-free)           │
└──────────┬──────────────────────────────┬───────────────────────────────────┘
           │ raw PTY bytes (Rust ConPTY)   │ stdin/stdout stream-json (Bun)
           ▼                               ▼
   `claude` / `codex` interactive TUI      `claude --input-format stream-json
   (argv allowlist-of-one, NO API key)      --output-format stream-json --verbose`
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Hub composition root | Mount order (webhooks BEFORE auth), WS upgrades, boot sweeps | `hub/src/index.ts` |
| Shared dispatch | The ONE inbound path: gates → queue → grace → finalize | `hub/src/dispatch/pipeline.ts` |
| Gate library | Cost cap, token cap, inject-rate, concurrency, human-only-PTY | `hub/src/dispatch/gates.ts` |
| Shared webhook intake | Raw-body → constant-time compare → HMAC → skew → IP allowlist | `hub/src/webhooks/intake.ts` |
| WS — client | Browser auth, subscribe set (≤12), broadcast | `hub/src/ws/client.ts` |
| WS — agent | Supervisor auth, stream-json relay, message coalesce+persist | `hub/src/ws/agent.ts` |
| WS — terminal | Raw PTY byte pipe browser↔supervisor | `hub/src/ws/term-protocol.ts` |
| Scheduler | Croner tick → targets → sender → run row | `hub/src/scheduler/dispatcher.ts`, `registry.ts` |
| Scheduler senders | agent / supervisor / coolify / triage / **teab** | `hub/src/scheduler/senders/*.ts` |
| Orchestrator (macro, DEFAULT) | Resolve `macro_task_type` → one autonomous prompt; reconcile sentinels; re-inject | `hub/src/orchestrator/macro-cycle.ts`, `task-macros.ts`, `sentinels.ts` |
| Orchestrator (legacy waves) | Per-micro-command-row waves — rollback only | `hub/src/orchestrator/waves.ts`, `wave-runner.ts` |
| Orchestrator control plane | Env gating, due-scan tick, cycle-runner registration | `hub/src/orchestrator/controller.ts` |
| Orchestrator inject seam | Gate → dispatch OR autospawn-park | `hub/src/orchestrator/inject.ts` |
| Routine queue | Global cross-session cycle queue + drain worker | `hub/src/orchestrator/queue.ts` |
| Supervisor runtime | WS to hub, per-session CLI lifecycle, command registry | `supervisor/src/index.ts`, `hub-client.ts`, `process-manager.ts` |
| Backend selector | Fail-safe human→PTY-only backend choice | `supervisor/src/runners/backend-selector.ts` |
| PTY host (Rust) | Spawns the genuine TUI on a ConPTY; per-conn subscriber ids | `supervisor/tauri/src-tauri/src/pty_host.rs` |
| Env sanitizer | Denylist + credential-class regex scrub of every spawn env | `supervisor/src/runners/env-sanitize.ts` |

## Pattern Overview

**Overall:** layered monolith hub (single Bun event loop) + thin per-host desktop sidecar + SPA. The hub is the only network service; both web and supervisor speak to it.

**Key Characteristics:**
- **One dispatch pipeline, many intakes.** The round-2 collapse is COMPLETE — scheduler, error-capture, revanote, feedback, telegram, orchestrator, and human chat all call `dispatch()` from `hub/src/dispatch/pipeline.ts` and pass a `gates: DispatchGate[]` array. There is no per-subsystem queue/grace/finalize anymore.
- **Two CLI transports, one supervisor.** Human turns get a *raw interactive TUI* over a Rust ConPTY (no API key, no stream-json). Automation turns get stream-json. The selector (`backend-selector.ts`) never routes a human to the stream-json runner.
- **Everything dangerous is env-gated OFF by default** (`REMO_ORCHESTRATOR_ENABLED`, `REMO_ORCHESTRATOR_AUTOSPAWN`, `REMO_TELEGRAM_TRANSCRIPT_TAIL`, `REMO_ORCHESTRATOR_LEGACY_WAVES`).
- **Every long-lived in-memory invariant has a reaper.** Ghost channels, pending runs, and queue locks all wedge silently; each has a boot-started sweep with its own interval/threshold/disable env.
- WebSocket-first for realtime; no polling, no SSE.

## Layers

**`web/` (presentation):** `web/src/` — pages, `components/ui/` primitives, feature components, hooks, `lib/`. Talks to hub REST + WS only.

**`hub/api/` (HTTP):** one file per resource. Public webhooks (`sentry-intake`, `coolify-webhook`, `revanote-webhook`, `feedback-webhook`, `telegram-webhook`, `webhooks-titanium`) mount BEFORE the `/api/*` auth catch-all; license gate mounts after auth.

**`hub/ws/` (realtime):** `/ws/client` (browser chat+activity), `/ws/agent` (supervisor stream-json), terminal byte pipe (`term-protocol.ts`). All Zod-validated (`protocol.ts`, `agent-protocol.ts`, `supervisor-protocol.ts`).

**`hub/dispatch/` + `hub/webhooks/` (shared deep modules):** the load-bearing middle. Every inbound subsystem rides them. Do NOT hand-roll a parallel queue.

**`hub/{scheduler,orchestrator,error-capture,revanote,feedback,telegram,usage,sessions}/` (domain):** each owns its intake, prompt building, and DAL slice — and nothing else.

**`hub/db/` (data):** postgres.js pool + `schema.sql` applied by `db/migrate.ts` on every boot.

**`supervisor/` (host runtime):** `supervisor/src/` Bun sidecar; `supervisor/tauri/src-tauri/` Rust shell (tray, sidecar lifecycle, ConPTY, first-run wizard); `supervisor/tauri/ui/` React settings UI.

## Data Flow

### Universal inbound dispatch (the spine)

1. An intake produces a `DispatchRequest` (`hub/src/dispatch/pipeline.ts:36`) — session, prompt, actor, run store.
2. `dispatch()` runs the supplied gate array in order (`gates.ts`). Any gate rejection short-circuits and is recorded, never bypassed.
3. Passing requests enter the per-session `SessionQueue` (`dispatch/session-queue.ts` — 1 in-flight + 1 waiter).
4. If the target session's supervisor is OFFLINE → `grace.ts` buffers; reconnect replays (`scheduler/catchup.ts`). Orchestrator inject can instead autospawn (`dispatch/spawn-on-error.ts` + `orchestrator/inject.ts`).
5. Prompt ships down `/ws/agent`; the supervisor runs the CLI turn.
6. `assistant_message:final` on the internal event bus (`hub/src/events/assistant-events.ts`) → `onSessionReply()` finalizes the run row → post-run action chain fires (`scheduler/post-run/dispatcher.ts`).

### Human PTY turn (prod default)

1. SPA reads `GET /api/client-config` → `pty_interactive: true` → mounts `TerminalSurface.tsx` (`web/src/hooks/useTerminalSession.ts`, `web/src/lib/term-ws.ts`).
2. Keystrokes → hub terminal WS → supervisor `ClaudePtyBridge` (`supervisor/src/runners/claude-pty-bridge.ts`).
3. Rust `pty_host.rs` spawns the genuine `claude`/`codex` TUI on a ConPTY with an **argv allowlist-of-one** (only the optional operator-blessed `--dangerously-skip-permissions`). Env is scrubbed by `env-sanitize.ts`.
4. Raw bytes stream back to xterm.js. `pty-persistence.ts` keeps the process alive across reconnects; per-conn subscriber ids prevent the doubled-keystroke leak.

### Auto-dev orchestrator (macro path — DEFAULT since TMAC)

1. `registerCycleRunnerIfEnabled()` (`orchestrator/controller.ts`, called once from `index.ts`) is a **no-op unless `REMO_ORCHESTRATOR_ENABLED`**. When off, nothing is registered, enqueued, or injected.
2. Due-scan tick (`REMO_ORCHESTRATOR_TICK_INTERVAL_MS`, default 60s) reads DUE `orchestrator_rows` (`due-rows.ts`) → enqueues on the global `routine_queue` (`queue.ts`).
3. Drain worker claims a cycle → `runMacroCycle()` (`macro-cycle.ts`):
   - Resolve `scheduled_tasks.macro_task_type` → ONE autonomous macro prompt (`task-macros.ts`).
   - Reconcile the PRIOR reply's `<<STATE>>` / `<<NOTIFY>>` / `<<GATE>>` sentinels (`sentinels.ts`) into `routine_run_log`; fan out stage-gated notifications (`notify.ts`).
   - HALT if a mandatory gate for the current `lifecycle_stage` is open; else re-inject via `inject.ts`.
4. `inject.ts` gate array is `[thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate]` — the strictest in the codebase.
5. Verify-tail (`verify-tail.ts`) probes the deployed app when `REMO_VERIFY_*` is set.
6. Legacy per-micro-command wave path (`waves.ts`, `wave-runner.ts`) survives ONLY behind `REMO_ORCHESTRATOR_LEGACY_WAVES=1`; a guard test enforces the macro default.

### Scheduled task run

1. Croner tick (`scheduler/registry.ts`) → `dispatcher.ts` → `targets.ts` resolves `target_kind`.
2. Sender: `senders/agent.ts` (CLI prompt), `supervisor.ts` (host command), `coolify.ts` (`log_check`), `triage.ts` (deploy-failure synth), `teab.ts` (`teab run --repo …` + hub-driven poll-to-terminal).
3. Run row → shared dispatch → finalize → post-run chain (email by default, telegram, webpush, webhook, github-issue, deploy-verify).
4. A run whose CLI turn never completes is finalized `failed`/`run_timeout` by `scheduler/run-reaper.ts` — with `only_if_active` conditional updates so a raced run is never double-finalized.

### Reapers

| Reaper | Wedge it fixes | Knobs |
|---|---|---|
| `ws/ghost-reaper.ts` | `sessions` row `online` + `hostname IS NULL` with a phantom agent channel — fools the inject liveness check | `REMO_GHOST_GRACE_MS` (120s), `REMO_GHOST_SWEEP_INTERVAL_MS` (60s), `REMO_GHOST_REAPER_DISABLED` |
| `scheduler/run-reaper.ts` | `scheduled_task_runs` stuck `pending` forever | `REMO_RUN_MAX_MS` (6h), `REMO_RUN_REAPER_INTERVAL_MS` (5m), `REMO_RUN_REAPER_DISABLED` |
| `orchestrator/stale-lock-reaper.ts` | in-memory `SessionQueue` lock held forever → `"skipped (run live)"` forever | `REMO_ORCHESTRATOR_STALE_LOCK_MS` (4h), `REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS` (1h) |
| `ws/idle-teardown.ts` | orphan CLI processes with zero subscribers | `REMO_SESSION_IDLE_GRACE_SECONDS` (4h; `0` disables) |

## Key Abstractions

**`DispatchGate` (hub):** `{ name, check(req) → allow | reject(reason) }`. Composable, ordered, non-bypassable. `hub/src/dispatch/pipeline.ts:47`, implementations in `gates.ts`.

**`CliRunner` / `RunnerEvent` (supervisor):** uniform interface over Claude/Codex/Gemini, PTY and stream-json alike. `supervisor/src/runners/types.ts`, `runner-factory.ts`.

**Sentinels (orchestrator):** `<<STATE>>` / `<<NOTIFY>>` / `<<GATE>>` blocks the agent emits in its reply; parsed by `sentinels.ts`, the only channel by which an autonomous cycle reports progress and requests a halt.

**Internal event bus:** `hub/src/events/{assistant,permission,question,session-activity}-events.ts` — decouples WS finalization from run-lifecycle, telegram, and post-run consumers. Fires only on FINAL messages, never on deltas.

## Entry Points

- **Hub:** `hub/src/index.ts` — `Bun.serve` + Hono; runs migrations, starts scheduler registry, routine-queue worker, telegram bridge, revanote callback worker, and all three reaper sweeps in-process.
- **Web:** `web/src/main.tsx` → `web/src/App.tsx` (hash router; legacy hash redirects kept FOREVER — scheduled-task emails link to them).
- **Supervisor:** `supervisor/src/index.ts` (`run` subcommand invoked by the Tauri sidecar) and `supervisor/tauri/src-tauri/src/main.rs` → `lib.rs`.

## Architectural Constraints

- **Single Bun event loop on the hub.** No worker threads. Every sweep and the croner tick share it.
- **`schema.sql` re-runs IN FULL on every boot.** Idempotent DDL ONLY. Data backfills go in `hub/scripts/` one-shots — an inline backfill re-fires destructively on every deploy.
- **Subscribe set capped at 12** (`hub/src/ws/protocol.ts`), matching the grid view.
- **Exactly one orchestrator session per user** (`idx_sessions_orchestrator_unique`). Never set `orchestrator_enabled=false` without also setting `orchestrator_disabled_explicitly=true` — the boot backfill re-enables it otherwise.
- **Supervisor capabilities are MSI-release-gated.** `teab_run`, PTY, and the OAuth usage poll only exist on installed hosts running a new enough signed MSI (PTY ≥0.9.0, usage poll ≥0.7.0, TEAB ≥ its release).
- **Circular-dep carve-outs:** `/api/profile/license`, `/api/auth/*`, `/healthz`, public webhooks, and `/ws/agent` are auth-gated but never license-gated.

## Cross-Cutting Invariants (do not violate)

### The cost cap AND the token cap are non-bypassable

Every inbound user→session dispatch passes `dailyCostCapGate` (`hub/src/dispatch/gates.ts:122`, real accumulated `token_usage` cost for the user's tz-day). The orchestrator inject path ADDS `dailyTokenCapGate` (default 50M tokens/day) and `sessionInjectRateGate` (default 4 injects/hr/session).

**The token cap counts ALL FOUR buckets — `input + output + cache_creation + cache_read`** (`getTodayTokenTotal`, `hub/src/db/token-usage-dal.ts`). Cache-read is NOT free against a subscription rate limit: an I/O-only cap let a wedged tick loop burn 2.83B cache-read tokens in two days. The dollar cost cap alone is meaningless on a flat-rate Max subscription — that is WHY the token cap exists alongside it, not instead of it.

### No provider API key on the human PTY path — EVER

The interactive terminal spawns the GENUINE `claude`/`codex` TUI with an argv **allowlist-of-one** (only the optional operator-blessed `--dangerously-skip-permissions`, itself gated by supervisor config). Forbidden forever on this path: `-p`/`--print`, `--input-format`, `--output-format`, `stream-json`, and any `ANTHROPIC_API_KEY`. Every spawn env goes through `supervisor/src/runners/env-sanitize.ts`. Fallback on failure is a **backend swap** (Codex via ChatGPT sign-in), never the API. Enforced by `supervisor/test/{no-api-key-no-streamjson-pty,no-apikey-fallback-guard,default-backend-selector}.test.ts`.

### Public webhooks read the raw body BEFORE JSON parse

Constant-time secret compare, HMAC over `${ts}.${rawBody}`, reject >5min skew, IP allowlist, audit row. Webhooks mount BEFORE the `/api/*` auth catch-all. Enforced by `hub/test/mount-order.test.ts`. Use `hub/src/webhooks/intake.ts` — do not re-derive.

### Don't hand-roll dispatch/queue/grace

The per-subsystem copies are deleted. Use `hub/src/dispatch/`. A new subsystem contributes an *intake* and a *gate array*, nothing more.

### Automation must not drive the human PTY

`humanOnlyPtyGate` (`gates.ts:331`) rejects any `AUTOMATION_ACTORS` member targeting a PTY-backed runner. This is why the "memory before killing" breadcrumb (`supervisor/src/runners/session-breadcrumb.ts`) exists — the hub is forbidden from injecting a pre-kill agent turn.

## Anti-Patterns

### Adding a subsystem-local queue or cost check

**What happens:** a new intake calls the WS registry directly, or does its own `SELECT sum(cost)`.
**Why it's wrong:** it silently bypasses the cost/token caps — the exact failure mode that killed the owner's subscription.
**Do this instead:** call `dispatch()` with a `gates` array (see `hub/src/feedback/dispatcher.ts:130` for the minimal example).

### Excluding cache tokens from a token count

**What happens:** summing only `input + output` because cache reads "are cheap."
**Why it's wrong:** cache-read counts fully against subscription rate limits. PR #335 made this mistake; #342 fixed it.
**Do this instead:** `getTodayTokenTotal` in `hub/src/db/token-usage-dal.ts` — all four buckets.

### Backfilling data in `schema.sql`

**What happens:** an `UPDATE`/`INSERT … SELECT` added next to the DDL.
**Why it's wrong:** `schema.sql` re-runs in full on every hub boot, so the backfill re-fires on every deploy.
**Do this instead:** a one-shot script in `hub/scripts/` (e.g. `migrate-orchestrator-macro-task-type.ts`).

### Coupling the Telegram tail to the PTY flag

**What happens:** gating transcript-tail on `REMO_PTY_INTERACTIVE`.
**Why it's wrong:** transcript-tail reads on-disk CLI transcripts that do not exist inside the hub container.
**Do this instead:** the independent `REMO_TELEGRAM_TRANSCRIPT_TAIL` (keep OFF in prod); Telegram outbound uses the host-agnostic event bus.

### Server-side throttling of stream deltas

**What happens:** coalescing `text_delta` in the hub.
**Why it's wrong:** breaks `assistant_message:final` ordering and run finalization.
**Do this instead:** RAF-coalesce web-side (`web/src/lib/raf-batch.ts`).

## Error Handling

**Strategy:** never leak internals; never let a side-effect fail a parent run.

- Global Hono handler returns `{error:'internal error'}` 500 (`hub/src/index.ts`).
- Webhooks return generic 200 on dedupe/skip so project state isn't probeable.
- Post-run action failures are log-only.
- WS auth failures close after a 5s timeout with a generic code.
- Reapers are fail-open: a bad env value falls back to the default rather than disabling the sweep.

## Cross-Cutting Concerns

**Logging:** `hub/src/observability/logger.ts` + ALS request context (`als.ts`); metrics in `metrics.ts` / `orchestrator-metrics.ts` / `http-metrics.ts`; hub self-capture (`self-capture.ts`). Supervisor tees to a rotating file (`supervisor/src/observability/logger.ts`) and redacts via `safe-logging.ts`.
**Validation:** Zod at every boundary — WS protocols, scheduler payloads, post-run action schema, triage/QC/controller result schemas, revanote payload.
**Auth:** Titanium magic-link → opaque cookie sessions (`hub/src/session.ts`) + CSRF double-submit (`csrf.ts`); legacy bcrypt behind `ALLOW_LEGACY_LOGIN`; `/ws/agent` keyed by `api_keys` (SHA-256), never by user license.
**Security headers:** `middleware/security-headers.ts` mounted first.
**Rate limits:** 20 WS conns/IP, per-conn message rate, per-route REST limits (`middleware/rate-limit.ts`).
**OpenAPI:** `hub/src/api/_openapi.ts` → `bun run docs:sync`; docs-drift CI fails a stale PR.

---

*Architecture analysis: 2026-07-12*
