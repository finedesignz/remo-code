<!-- updated: 2026-06-02 -->
# Roadmap

<!-- reconciled 2026-06-02: all v1.0 phases shipped to prod via direct-PR workflow (not GSD lifecycle); statuses + per-phase SUMMARY stubs reconciled to match reality. Milestone archived. -->

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References below to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical. See .planning/phases/09-retire-npm-packages/.


Project: **remo-code**
Owner: jsmithfd@gmail.com
Source of truth for phase ordering, status, and dependencies. The GSD SDK parses this file — keep the `Phase NN: <slug>` heading and the `Status:` / `Goal:` / `Depends on:` / `Requirements:` lines exactly as shown.

---

## Phase 01: merge-self-heal

- Status: Complete
- Started: 2026-05-10
- Completed: 2026-05-22
- Goal: Resolve stale upstream PR #1 (`upstream-fixes`, ~14 days old, 126-file drift vs main). Cherry-pick fixes still valid on current main, drop the rest, close the PR.
- Depends on: []
- Requirements: []
- Phase dir: `.planning/phases/merge-self-heal/`
- Outcome: PR #1 closed with replacement commits. Crypto helpers extracted to `hub/src/lib/crypto.ts`. `hubFetch` added to web. Profile PATCH route shape fixed.

## Phase 02: scheduled-tasks

- Status: Complete
- Started: 2026-05-15
- Completed: 2026-05-23
- Goal: Hub-side cron scheduler that fires user-defined prompts/skills/supervisor commands against one session, one supervisor, or all-of-either, with per-target run history, daily cost cap, offline-grace replay, boot catch-up, and post-run actions (chain / email-via-emails4agents / telegram / web push / webhook with HMAC).
- Depends on: [Phase 01]
- Requirements: []
- Phase dir: `.planning/phases/scheduled-tasks/`
- Outcome: V2 dispatcher shipped at `hub/src/scheduler/`. 41 unit tests + 1 e2e smoke. Docs at `docs/scheduled-tasks.md`. Live in prod. Legacy v0 (`hub/src/scheduler/index.ts`) still wired during transition; follow-up will remove it.

## Phase 03: multichat-grid-view

- Status: Complete
- Goal: Let a user view many Claude Code sessions at once. Desktop: user-named tabs, each holding a configurable set of sessions, rendered as a resizable CSS grid (3×3, 4×3, auto-fit) with live activity in each cell. Mobile: vertical accordion list of sessions; tap-to-expand into a square chat surface with input pinned to the bottom. Tab state persists per user (survives refresh, syncs across devices). URL-routable (`#/grid/:tabId`).
- Depends on: [Phase 02]
- Requirements: [R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13]
- Phase dir: `.planning/phases/03-multichat-grid-view/`
- Plans:
  - `03-PLAN-001-schema-and-api` — wave 1 — schema (`chat_tabs`, `chat_tab_sessions`), DAL, REST endpoints
  - `03-PLAN-002-ws-multi-subscribe` — wave 1 — wire the existing multi-`session_ids` subscribe op end-to-end on the web client; enforce 12-cell cap; add per-connection set membership routing
  - `03-PLAN-003-chat-surface-refactor` — wave 2 — extract `<ChatSurface sessionId density>` with `full` / `cell` / `mobile-expanded` variants, no regression to existing single-chat
  - `03-PLAN-004-desktop-grid-page` — wave 3 — `<GridPage>` route at `#/grid` and `#/grid/:tabId`, tab bar + grid area, resize handles, session picker
  - `03-PLAN-005-mobile-accordion` — wave 3 — `<MobileAccordion>` below `md` breakpoint, square expanded panel, pinned input
  - `03-PLAN-006-polish-and-docs` — wave 4 — nav entry, README, CLAUDE.md, `docs/grid-view.md`, visual regression check

## Phase 04: coolify-dev-supervisor

- Status: Complete
- Goal: Run a lean dev-only remo-code supervisor on a Coolify server (with Claude Code CLI + git) to host self-heal sessions off the local desktop. Supervisor reports CPU/RAM/concurrency budget to hub; hub enforces concurrency + per-user daily cost cap; UI shows budget with override slider. Self-heal errors/tasks routed to this remote supervisor by preference.
- Depends on: [Phase 02]
- Requirements: []
- Phase dir: `.planning/phases/04-coolify-dev-supervisor/`
- Plans:
  - `04-PLAN-001-budget-reporting` — wave 1 — supervisor cgroup detection + `host_resources` WS message
  - `04-PLAN-002-schema-and-migration` — wave 1 — `supervisors` budget columns + `users.preferred_supervisor_id` + persistence handler
  - `04-PLAN-003-hub-concurrency-gate` — wave 2 — atomic `reserveSessionSlot`/`releaseSessionSlot`, wired into all session-creation paths
  - `04-PLAN-005-supervisor-dockerfile` — wave 2 — multi-stage `supervisor/Dockerfile`, non-root, GHCR workflow
  - `04-PLAN-007-worktree-per-session` — wave 2 — shared bare clones + `git worktree add` per session, branch-collision detection
  - `04-PLAN-006-coolify-deploy` — wave 3 — provision Coolify resource (volumes, env, no exposed ports) + runbook
  - `04-PLAN-008-self-heal-routing` — wave 3 — `POST /api/sessions/heal` + `pickSessionTarget` resolution order
  - `04-PLAN-009-cost-cap-hub-wide` — wave 3 — lift scheduler daily cost cap to hub-wide per-user gate
  - `04-PLAN-004-empirical-budget-measurement` — wave 4 — measure per-session RSS on Coolify, tune `MB_PER_SESSION`
  - `04-PLAN-010-web-budget-ui` — wave 4 — supervisor card, override slider, cost HUD, settings sections
  - `04-PLAN-011-tests-and-docs` — wave 4 — end-to-end test + docs (coolify-supervisor.md, README, CLAUDE.md)

## Phase 05: codex-cli-and-rootless-sessions

- Status: Complete
- Goal: Add Codex CLI as an alternative to Claude in the supervisor (user can pick per-session which CLI to spawn), and add a "rootless" session mode where the user can open one Claude session and one Codex session at the machine root (no repo / no project_dir required) — for ad-hoc Q&A outside any project. Also: when supervisor is installed on a new machine/server, ensure the user's persistent instructions/config (CLAUDE.md, AGENTS.md, ~/.codex/instructions.md, agent profile) are retained/seeded so the supervisor behaves identically across hosts.
- Depends on: []
- Requirements: []
- Phase dir: `.planning/phases/05-codex-cli-and-rootless-sessions/`

## Phase 06: supervisor-tray-app

- Status: Complete
- Goal: Convert `supervisor/` from a CLI process with a visible console window into a polished Windows tray app with a small native-feeling settings UI. No visible terminal. Surface sandbox/security controls (allowed folders, `--dangerously-skip-permissions` cap, max concurrent sessions, audit log, restrict-to-git, kill-switch hotkey) in a React + Tailwind settings UI. Coexist with the existing `nssm-installer.ts` service path so headless server installs keep working.
- Depends on: [Phase 02]
- Requirements: [R-06-01, R-06-02, R-06-03, R-06-04, R-06-05, R-06-06, R-06-07, R-06-08, R-06-09, R-06-10, R-06-11, R-06-12]
- Phase dir: `.planning/phases/06-supervisor-tray-app/`
- Plans:
  - `06-PLAN-001-tauri-scaffold` — wave 1 — bootstrap Tauri 2 under `supervisor/tauri/`, wire `tauri-plugin-single-instance` + `tauri-plugin-autostart` + tray + `tauri-plugin-updater` + `tauri-plugin-global-shortcut`, Vite + React + Tailwind UI shell
  - `06-PLAN-002-sidecar-and-process-control` — wave 1 — spawn existing Bun supervisor as Tauri sidecar with `CREATE_NO_WINDOW`; tray icon reflects running/stopped/crashed; auto-restart with backoff; fix WS listener leak + bound stderr buffers; daily 4am sidecar restart; 127.0.0.1:9106 bind mutex; refuse start if NSSM service running
  - `06-PLAN-003-settings-ui` — wave 2 — Settings page React app: allowed folders (add/remove + warn on user-profile / Desktop roots), `--dangerously-skip-permissions` hard cap toggle, max concurrent sessions, audit log toggle, restrict-to-git toggle, kill-switch hotkey display (`Ctrl+Shift+Alt+K`)
  - `06-PLAN-004-config-bridge` — wave 2 — Tauri ↔ Bun supervisor IPC + persist to existing `%APPDATA%\remo-code\supervisor.json`; file-watch + live reload within 2s; bubble validation errors back to UI
  - `06-PLAN-005-protocol-enforcement` — wave 3 — Bun supervisor enforces security toggles in `process-manager.ts`: allowed-folders gate (with `realpath` symlink-escape check), git-only gate, max-concurrent cap, `--dangerously-skip-permissions` hard-strip when cap off, audit JSONL to `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`, surface capability flags via `supervisor.hello`
  - `06-PLAN-006-installer-and-autostart` — wave 3 — MSI installer via Tauri bundler; autostart Run-key on by default; coexist with NSSM (auto-detect existing service + offer one-click migrate to tray mode); uninstall removes autostart + binaries, prompts before deleting config/audit log
  - `06-PLAN-007-docs-and-tests` — wave 4 — README + CLAUDE.md + new `docs/supervisor-tray.md`; Windows tray smoke checklist; Rust unit tests for IPC bridge pure logic; integration test for the sandbox-escape rejection

## Phase 07: titanium-auth-cutover

- Status: Complete
- Mode: standard
- Goal: Every remo-code user login goes through Titanium Licensing (Keygen CE-backed). Existing bcrypt users keep working with zero password resets. Hub verifies Titanium-issued EdDSA JWTs locally via JWKS + Redis blocklist; 2-week dual-auth soak; then legacy `/api/auth/login` and `JWT_SECRET`-signed user tokens removed. Agent `api_keys` stay local (out of scope).
- Depends on: [Phase 06]
- Requirements: [R-AUTH-01, R-AUTH-02, R-AUTH-03, R-AUTH-04, R-AUTH-05, R-AUTH-06, R-AUTH-07, R-AUTH-08, R-AUTH-09]
- Phase dir: `.planning/phases/07-titanium-auth-cutover/`
- Plans:
  - `07-PLAN-001-schema-migration` — wave 1 — additive `users.titanium_user_id TEXT UNIQUE NULL`, drop NOT NULL from `users.password_hash`, optional `mapping_conflicts` table
  - `07-PLAN-002-jwks-verify-and-blocklist` — wave 1 — `jose`-based EdDSA verifier with JWKS cache, Redis blocklist (`titanium:blocklist`) check, warm-cache on `bootstrap()` before port bind
  - `07-PLAN-003-mapping-job` — wave 2 — idempotent one-shot `hub/scripts/map-users-to-titanium.ts` with `--dry-run`; create-if-not-exists in Titanium; never auto-merge collisions; conflict log
  - `07-PLAN-004-dual-auth-middleware` — wave 2 — REST + WS auth handlers detect `alg` and branch between EdDSA (Titanium) verify and legacy HS256 (`JWT_SECRET`) verify; on-first-request linking by email for unlinked rows; email-sync-on-verify
  - `07-PLAN-005-web-login-cutover` — wave 3 — web ships Titanium magic-link flow as the default; "use password" fallback link visible during soak; WS auth payload and REST headers attach Titanium token
  - `07-PLAN-006-cutover-and-cleanup` — wave 4 — after ≥14d green soak: disable `/api/auth/login`, remove `JWT_SECRET` user-token verify code path (gated behind `ALLOW_LEGACY_LOGIN` flag for 1 release), update docs/README/CLAUDE.md

---

<!-- Milestone v-settings-overhaul (2026-05-30): Settings/Connections Overhaul + Grid View + Accent Migration.
     Locked scope: .planning/phases/settings-connections-overhaul/PLAN.md. Requirements: .planning/REQUIREMENTS.md (R-DS/CONN/NUDGE/USAGE/PROFILE/GRID/DOCS).
     Standards: ~/.claude/design-preferences.md (accent=blue, orange CTA-only, never indigo) + ~/.claude/architecture-preferences.md. -->

## Phase 08: design-system-foundation

- Status: Complete
- Mode: standard
- Goal: Blocking design-system foundation everything else consumes. Migrate the app accent from indigo→blue across all primitives + call sites (orange stays CTA-only, never indigo), size `Button` to ≥44px touch targets, add an `InfoTip` tooltip primitive (replacing inline `<p>` descriptions and native `title=`), give `Card` an optional hairline border + `shadow-sm` (flat variant for tables), and add horizontal padding around the logo.
- Depends on: []
- Requirements: [R-DS-01, R-DS-02, R-DS-03, R-DS-04, R-DS-05]
- Phase dir: `.planning/phases/08-design-system-foundation/`

## Phase 09: connections-overhaul

- Status: Complete
- Mode: standard
- Goal: Overhaul the Connections tab. Remove the "Root repo folder paths" card (roots move into the supervisor first-run wizard, which now requires ≥1 root). Delete `OrchestratorTab` and render the orchestrator as a pinned, specially-marked top "folder" row in the repo table with its enable/disable/start/stop as icon buttons + tooltips (`/api/orchestrator` endpoints kept; orchestrator-tab URL redirects to connections). Collapse the duplicated desktop/mobile blocks into one responsive renderer with a consolidated metadata cell, icon-only row actions, and no mobile row-wrap; replace inline descriptions with `InfoTip`.
- Depends on: [Phase 08]
- Requirements: [R-CONN-01, R-CONN-02, R-CONN-03, R-CONN-04, R-CONN-05]
- Phase dir: `.planning/phases/09-connections-overhaul/`

## Phase 10: prompts-removal-and-per-session-nudge

- Status: Complete
- Mode: standard
- Goal: Delete the Prompts tab in its entirety — `PromptsTab.tsx`, the commands card (`CommandsList`/`useCommands`), and the instruction blobs (claude_global_md / codex_agents_md / codex_config_toml), which are handled locally and NOT relocated — and redirect its URL to connections. Make auto-nudge per-session: add nullable `sessions.auto_nudge` (null = inherit `users.auto_nudge_idle_sessions`), a `PATCH /api/sessions/:id` endpoint, dispatch logic that reads per-session value with global fallback, and a small blue per-row toggle in `Sidebar.tsx`.
- Depends on: [Phase 08]
- Requirements: [R-NUDGE-01, R-NUDGE-02, R-NUDGE-03, R-NUDGE-04]
- Phase dir: `.planning/phases/10-prompts-removal-and-per-session-nudge/`

## Phase 11: usage-tab-cleanup

- Status: Complete
- Mode: standard
- Goal: Clean up the Usage tab. Merge the Daily Cost Cap into the thresholds card and rename it to "Claude Usage and Cost Controls" (cap + session% + week% laid out compactly). Show token counts beneath the dollar amount in each Today/Week/Month cost card. Replace threshold/cap helper sentences with tooltips and switch cap + thresholds to auto-save-on-blur (drop Save buttons).
- Depends on: [Phase 08]
- Requirements: [R-USAGE-01, R-USAGE-02, R-USAGE-03]
- Phase dir: `.planning/phases/11-usage-tab-cleanup/`

## Phase 12: profile-and-default-session

- Status: Complete
- Mode: standard
- Goal: Clean up the Profile tab and centralize default-session resolution. Delete the Telegram card + its fetches (keep `/api/telegram/*` endpoints — bot still works). Make the default session = the user's orchestrator session at the root folder wherever a default is resolved with none set (List View auto-select, Telegram default, any `default_session` logic), via one shared helper. Auto-save-on-blur for display name + timezone (drop Save buttons); width → `max-w-7xl`.
- Depends on: [Phase 08]
- Requirements: [R-PROFILE-01, R-PROFILE-02, R-PROFILE-03]
- Phase dir: `.planning/phases/12-profile-and-default-session/`

## Phase 13: grid-view-active-sessions

- Status: Complete
- Mode: standard
- Goal: Make the Grid Default tab equal List View — auto-populating all active sessions (same `useSessions` source, virtual non-editable membership, cap 12 + existing overflow badge). Let users create more tabs and move/assign sessions between them via existing `chat_tab_sessions` CRUD. Add active-cell persistence to the DB (extend `chat_tabs` or a new `user_grid_state` row) so tabs, memberships, and the focused cell survive hub restart / reload / device switch.
- Depends on: [Phase 08]
- Note: Independent of the Connections/Prompts/Usage/Profile work — may run in parallel with Phases 09–12 once Phase 08 lands.
- Requirements: [R-GRID-01, R-GRID-02, R-GRID-03]
- Phase dir: `.planning/phases/13-grid-view-active-sessions/`

## Phase 14: settings-docs-and-polish

- Status: Complete
- Mode: standard
- Goal: Cross-cutting polish + anti-drift docs refresh. Auto-save-on-blur sweep for remaining low-stakes forms (remove redundant Save buttons); `max-w-7xl` width uniformity across all settings tabs; collapse `EmptyState` copy to a single sentence. Refresh architecture docs in the same milestone so they don't drift: web CLAUDE.md/`docs/` (new tab set Connections/Credentials/Usage/Profile — Prompts & Orchestrator GONE; accent=blue; per-session auto-nudge; Grid Default behavior), `.planning/codebase/{ARCHITECTURE,STRUCTURE,CONVENTIONS}.md`, `.planning/phases/12-ui-restructure/12-CONTEXT.md` supersession note, `docs/grid-view.md`, and hub `docs:sync` for any new/changed endpoints.
- Depends on: [Phase 08]
- Requirements: [R-DOCS-01, R-DOCS-02, R-DOCS-03, R-DOCS-04]
- Phase dir: `.planning/phases/14-settings-docs-and-polish/`

---

<!-- Milestone m-interactive-pty-runner (2026-05-31): Interactive-PTY Runner + full rip-and-replace.
     Source spec: .planning/architecture/interactive-pty-runner-SPEC.md (committed 6ef6953).
     Branch: feat/interactive-pty-runner.
     CRITICAL OVERRIDE (user decision, supersedes the spec's "additive / Embed-A keep stream-json chat" text):
       FULL RIP-AND-REPLACE. PTY-ify ALL human sessions (Claude AND Codex). Delete the stream-json
       ChatSurface web UI (web/src ChatSurface, grid conversation surface, activity-event/tool_use bubble
       rendering) ENTIRELY. ONE raw-terminal surface (themed xterm.js) for every human session.
       stream-json survives ONLY as an unattended-automation transport (scheduler / orchestrator-background /
       auto-dev / error-capture) behind the cost cap — NOT a human chat UI.
     Non-negotiable constraints (carry into every phase): NO ANTHROPIC_API_KEY ever passed to a spawned client
       (delete env.ANTHROPIC_API_KEY stays; no API-key fallback — fallback is Codex/Gemini); spawn official
       `claude` only, never reuse/extract OAuth token; only genuine human turns touch the PTY runner (guard
       rejects automation dispatch sources); auth via `claude login` (treat setup-token as suspect);
       interactive `claude` = no -p, no --input-format stream-json; raw-terminal WS isolated from the
       /ws/agent RunnerEvent→agent-protocol pipeline. June-15 billing-classification checks GATE the cutover,
       NOT the build. Requirements: .planning/REQUIREMENTS.md (R-PTY-*).
     PHASE 20 ADDENDUM (2026-05-31, user decisions): the rip (Phase 17) deletes the Telegram bridge's
       structured event source, leaving Telegram non-functional. Phase 20 (telegram-transcript-tail),
       sequenced AFTER Phase 17, rebuilds Telegram on a BACKEND-AGNOSTIC TranscriptSource adapter
       (Claude projects JSONL + Codex rollout JSONL/scrape fallback), with FAIL-CLOSED permission/
       user_question detection keyed by (sessionId,requestId), keystroke injection into the PTY, and a
       single-writer per-session turn lock arbitrating xterm + Telegram. This SUPERSEDES the Telegram
       clauses of R-PTY-11 and R-PTY-24 ("Telegram stays stream-json / on the programmatic pool"):
       transcript-tail is read-only over the human's interactive session, so Telegram does NOT move to
       the programmatic pool. Requirements: R-TG-01..12. -->

## Phase 15: pty-spike-and-compile-derisk

- Status: Planned
- Mode: standard
- Goal: Prove the core PTY mechanic end-to-end and derisk the known blocker. Spawn the genuine *interactive* `claude` TUI (no `-p`, no `--input-format stream-json`) inside a PTY (`node-pty`/ConPTY on Windows) on the supervisor box with `ANTHROPIC_API_KEY` deleted from env; stream raw terminal bytes to a minimal themed xterm.js panel in the web shell over a NEW raw-terminal WS channel (kept isolated from the structured `/ws/agent` RunnerEvent pipeline); accept a typed human turn and render the TUI. **Primary derisk:** `node-pty` is a native addon and does NOT bundle into `bun build --compile` (the Tauri sidecar) — Phase 15 must determine and demonstrate how the PTY host ships in the compiled sidecar (bundle the native module, ship a helper exe, or run the PTY host out-of-band) and document the chosen approach for Phase 16. Not throwaway — this is the seed of the runner. Spike findings written to a SPIKE/RESEARCH artifact that Phase 16 consumes.
- Depends on: []
- Requirements: [R-PTY-01, R-PTY-02, R-PTY-03, R-PTY-04, R-PTY-05]
- Phase dir: `.planning/phases/15-pty-spike-and-compile-derisk/`
- Plans:
  - `15-PLAN-001-pty-spawn-and-canary` — wave 1 — interactive `claude` in node-pty, env-strip, build-time canary (R-PTY-01)
  - `15-PLAN-002-raw-terminal-ws-channel` — wave 2 — isolated term.* frame schema + hub relay + supervisor wiring + isolation/round-trip tests (R-PTY-02, R-PTY-03)
  - `15-PLAN-003-xterm-panel-and-compile-derisk` — wave 3 — themed xterm.js panel + node-pty/bun-compile shipping proof + SPIKE-FINDINGS (R-PTY-04, R-PTY-05)

## Phase 16: hardened-pty-relay-and-mobile-terminal

- Status: Pending
- Mode: standard
- Goal: Productionize the spike into a hardened relay. New `supervisor/src/runners/claude-pty-runner.ts` (interactive `claude` in a PTY, `delete env.ANTHROPIC_API_KEY`, NO RunnerEvent translation — raw bytes only) using the Phase-15 sidecar-shipping approach; tmux-backed persistence so a dropped phone/browser connection reattaches with no lost state; authenticated raw-terminal WS channel (data in/out, resize, reattach/scrollback) relayed `/ws/client` ↔ `/ws/agent`, isolated from the structured agent-protocol; themed xterm.js terminal surface in the React shell (app chrome/sidebar/nav/theme tokens `--bg-primary`/`--text-primary`/blue-accent unchanged) with mobile reconnect/resize/scrollback. A dispatch guard rejects non-interactive/automation sources from the PTY runner (constraint 3). Per-session runner type (PTY-interactive vs stream-json). **Note (superseded by Phase 20):** this phase's original "Telegram-default sessions MUST stay stream-json" (R-PTY-11) holds only until Phase 17 deletes the stream-json human runner; Phase 20 then moves Telegram onto the PTY surface via transcript-tail. The per-session runner-type seam built here is what Phase 20 reuses. Reuses existing opaque-cookie auth + WS infra.
- Depends on: [Phase 15]
- Requirements: [R-PTY-06, R-PTY-07, R-PTY-08, R-PTY-09, R-PTY-10, R-PTY-11]
- Phase dir: `.planning/phases/16-hardened-pty-relay-and-mobile-terminal/`

## Phase 17: codex-pty-runner-and-chatsurface-rip-and-replace

- Status: Pending
- Mode: standard
- Goal: Execute the rip-and-replace OVERRIDE. (a) Add a Codex interactive/PTY runner (`supervisor/src/runners/codex-pty-runner.ts`) so Codex human sessions also run on the raw-terminal surface, reusing the Phase-16 PTY host + raw-terminal WS + tmux. (b) DELETE the stream-json human chat UI entirely from web/src: `ChatSurface` and its `full`/`cell`/`mobile-expanded` variants, the grid/list conversation rendering of structured activity (thinking/text_delta/tool_use/tool_result bubbles), and any now-dead hub agent-protocol→bubble translation that exists ONLY to feed that UI. Route ALL human sessions (Claude AND Codex) to the single themed xterm.js terminal surface. (c) Preserve stream-json end-to-end ONLY for unattended automation transports (Phase 18 owns the routing) — do not delete the runner-side stream-json path, only its human chat UI. Update grid view to host terminal cells (or remove grid conversation rendering) consistent with one terminal surface. Tests (`web/test/no-indigo.test.ts`, baseline) stay green; new tests assert no `ChatSurface`/structured-bubble rendering path remains for human sessions. **EXPLICIT BREAK (not silent): the Telegram bridge's structured event source (`assistant_message:final`/`tool_use` on the hub event bus + the `permission_request`→`onPermissionPending` path) is removed here, leaving Telegram non-functional. Telegram is rebuilt in Phase 20 on transcript-tail.** Phase 17 SHALL leave a code comment / SUMMARY note at each removed Telegram source point pointing to Phase 20, and MUST NOT delete the Telegram bridge module wholesale (Phase 20 re-sources it).
- Depends on: [Phase 16]
- Requirements: [R-PTY-12, R-PTY-13, R-PTY-14, R-PTY-15, R-PTY-16, R-TG-12]
- Phase dir: `.planning/phases/17-codex-pty-runner-and-chatsurface-rip-and-replace/`

## Phase 18: billing-guardrail-dual-bucket-usage

- Status: Pending
- Mode: standard
- Goal: Billing guardrail. Extend the existing usage poll (`supervisor/src/usage/oauth-poll.ts` → hub store `hub/src/usage/store.ts`) to surface BOTH balances — interactive subscription pool AND the post-June-15 programmatic credit pool — broadcast via the existing `subscription_usage` WS path and rendered in the usage strip/tab. Alert + optional hard-halt when programmatic credit is consumed unexpectedly (no silent drain, no surprise hard-stop). This is where unattended automation (scheduler / orchestrator background / auto-dev / error-capture) is explicitly routed onto the stream-json/programmatic path behind the existing non-bypassable `dailyCostCapGate`, with the PTY-runner human guard (Phase 16) ensuring automation never rides the interactive PTY path. NOT an API key anywhere.
- Depends on: [Phase 16]
- Requirements: [R-PTY-17, R-PTY-18, R-PTY-19, R-PTY-20]
- Phase dir: `.planning/phases/18-billing-guardrail-dual-bucket-usage/`

## Phase 19: cutover-gate-and-automation-fallback

- Status: Pending
- Mode: standard
- Goal: June-15 cutover gate + automation fallback wiring. Encode the spec's "Verify after June 15" checks as an explicit, documented cutover GATE (NOT a build blocker): a runbook + a measurement procedure using the Phase-18 dual-bucket poll to confirm (1) a PTY interactive session bills the INTERACTIVE bucket, (2) `setup-token` vs `login` classification, (3) subagents/hooks/MCP bucket attribution, (4) login-credential headless-reclassification risk. Green-light only flips the PTY runner default-on for human sessions after the interactive-bucket result is confirmed. Wire the "If PTY fails" fallback paths (Codex runner — already present; a stubbed/optional future Gemini runner seam) so the human-coding UX can target Codex/Gemini WITHOUT an API key. **Note (superseded by Phase 20):** R-PTY-24's "Telegram stays on the stream-json programmatic pool by structural necessity" no longer holds — Phase 20 sources Telegram from the transcript (read-only over the human's interactive session), so Telegram does NOT consume the programmatic pool. Treat R-PTY-24 as superseded by R-TG-01..12. Final docs sweep: README/CLAUDE.md/`docs/` describing the terminal surface, dual-bucket usage, the cutover gate, and the rip-and-replace.
- Depends on: [Phase 17, Phase 18]
- Requirements: [R-PTY-21, R-PTY-22, R-PTY-23, R-PTY-24, R-PTY-25]
- Phase dir: `.planning/phases/19-cutover-gate-and-automation-fallback/`

## Phase 20: telegram-transcript-tail

- Status: Pending
- Mode: standard
- Goal: Rebuild the Telegram bridge — left non-functional by the Phase-17 rip (its `assistant_message:final`/`tool_use` event source and `permission_request`→`onPermissionPending` path were deleted) — on a **backend-agnostic transcript-tail** source. (a) Define a `TranscriptSource` adapter selected by session `cliKind`: **Claude** → `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`; **Codex** → `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` (undocumented/version-unstable; resolve by `session_meta` id; **terminal-byte-scrape fallback** when absent/unrecognized). Each normalizes to a shared `TranscriptEntry` union; the bridge consumes only the union. Session→file mapping is explicit (project dir + session id captured at PTY spawn), never newest-file guessing. (b) Re-source Telegram outbound (final `assistant_text` + collapsed `tool_use`) from the adapter. (c) **Permission/`user_question`/slash injection (security-sensitive):** detect a pending request from the transcript per backend, keyed by **`(sessionId, requestId)`** (reuse `hub/src/telegram/approvals.ts`); surface via the existing inline tap-to-approve UX; inject the human tap as backend-specific PTY keystroke(s) via the Phase-16 raw-terminal input path (NOT the deleted `permission_response`). **Fail-CLOSED:** any ambiguous/unparseable prompt ⇒ do nothing, never auto-approve; scrape fallback emits no permission prompts. A tap resolves exactly one `(sessionId, requestId)` and is rejected if superseded/expired. (d) **PTY write-arbitration:** single-writer turn lock per session in the hub; xterm + Telegram writers serialized, input QUEUED while held, lock released only on observed `turn_complete`; a non-holder permission/question RESPONSE is allowed. (e) Telegram injection rides the Phase-16 human-only guard (constraint 3) — no auto-nudge/scheduled-via-Telegram. Threat model + tests per task. `docs/telegram-bridge.md` + CLAUDE.md Docs map updated.
- Depends on: [Phase 17]
- Requirements: [R-TG-01, R-TG-02, R-TG-03, R-TG-04, R-TG-05, R-TG-06, R-TG-07, R-TG-08, R-TG-09, R-TG-10, R-TG-11, R-TG-12]
- Phase dir: `.planning/phases/20-telegram-transcript-tail/`
- Plans:
  - `20-PLAN-001-transcript-source-adapters` — wave 1 — `TranscriptSource` interface + `TranscriptEntry` union; Claude projects-JSONL adapter (explicit session→file mapping) + Codex rollout-JSONL adapter with byte-scrape fallback; backend selected by `cliKind`; unknown-record degrade-to-skip (R-TG-01, R-TG-02, R-TG-03)
  - `20-PLAN-002-telegram-output-resourced` — wave 2 — re-source the outbound bridge from the adapter (final assistant text + collapsed tool lines), drop `onAssistantMessageFinal`; per-chat serialization preserved (R-TG-04)
  - `20-PLAN-003-permission-injection-failclosed` — wave 2 — detect pending permission/`user_question` from the transcript keyed by `(sessionId,requestId)`; surface via existing inline UX; inject backend-specific PTY keystrokes; FAIL-CLOSED parse + explicit-confirmation + disambiguation/expiry; threat model (R-TG-05, R-TG-06, R-TG-07, R-TG-08, R-TG-09)
  - `20-PLAN-004-pty-write-arbitration` — wave 3 — single-writer per-session turn lock in the hub; FIFO queue; release on observed `turn_complete`; non-holder response allowed; "who holds the turn" state (R-TG-10)
  - `20-PLAN-005-human-guard-and-docs` — wave 4 — Telegram injection through the Phase-16 human-only guard; `docs/telegram-bridge.md` + CLAUDE.md Docs map; `docs:sync` if endpoints changed (R-TG-11, R-TG-12)

---

<!-- Milestone m-auto-dev-orchestrator (2026-06-06): Session-level Auto-Dev Orchestrator.
     Source spec: .planning/architecture/auto-dev-orchestrator-SPEC.md (10 locked decisions).
     Branch: feat/auto-dev-orchestrator.
     Scope: hub + web ONLY. No supervisor changes. gsd commands execute INSIDE the bound session agent
       (Claude Code), which holds the gsd skills — the hub injects a templated prompt and the agent itself
       spawns parallel Task subagents (locked decision 6). The hub does NOT re-implement orchestration.
     Supersedes the row-level pieces of auto-dev-system-SPEC.md (P1–P5, shipped) by adding a session-level
       orchestration layer on top of the existing dispatch / cost-cap / deploy-verify machinery.
     Non-negotiable invariants (carry into every phase): cost cap non-bypassable (dailyCostCapGate);
       schema.sql idempotent-only (backfills → hub/scripts/ one-shots); single dispatch pipeline
       (hub/src/dispatch/) — no per-subsystem queue/grace; reuse P3 surfaceProposal for propose-to-chat;
       reuse P5 deploy-verify-probe; off-hours merge is the ONLY auto-merge-to-main path.
     Task model is a REPLACE (locked decision 3): one `orchestrator` task per session is THE scheduled-task
       model; legacy many-tasks-per-session + standalone dev/qc tasks migrate into orchestrator rows (Phase 32).
     Requirements: .planning/REQUIREMENTS.md (R-ADO-*). -->

## Phase 21: orchestrator-data-model

- Status: Planned
- Mode: standard
- Goal: Additive, idempotent DDL for the orchestrator task model (locked decisions 3, 4, 10). Extend `scheduled_tasks.task_type` CHECK to include `orchestrator`; add a partial unique index enforcing at most one `orchestrator` row per session (`(session_id) WHERE task_type = 'orchestrator'`); add `scheduled_tasks.lifecycle_stage` (default `development`). Create `orchestrator_rows` (per-command rows: `id, task_id, command, enabled, schedule_rule JSONB reusing ScheduleRule, frequency_label, micro_prompt, sort_order`), `routine_run_log` (timestamp, command, decision rationale, outcome, gap-dimension/agent, PR url, reviewer verdict, deploy-verify result; indexed by `(session_id, created_at)`), and `routine_queue` (`id, session_id, priority, enqueued_at, started_at, status`; per-session advisory lock via partial unique index on `(session_id) WHERE status='running'`). DDL goes in `hub/src/db/schema.sql` (re-runs every boot — idempotent only); any data backfill is a one-shot in `hub/scripts/`. Reuse existing idempotency tables. DAL + Zod types; no behavior wired yet.
- Depends on: []
- Requirements: [R-ADO-01, R-ADO-02, R-ADO-03, R-ADO-04]
- Phase dir: `.planning/phases/21-orchestrator-data-model/`

## Phase 22: global-queue-and-per-session-lock

- Status: Planned
- Mode: standard
- Goal: Hub-wide concurrency control for routine cycles (locked decision 10). A global FIFO queue (`routine_queue`) caps concurrent orchestrator cycles across ALL sessions (configurable, default 2–3) with priority ordering (deploy-fix > build). A drain worker pulls eligible cycles up to the cap; overlapping due-cycles enqueue FIFO+priority. A per-session advisory lock (the `status='running'` partial unique index from Phase 21) guarantees exactly one cycle per session at a time; a second due-tick for a locked session is coalesced, not stacked. No cycle work executes yet — this phase owns enqueue/dequeue/lock/release mechanics + tests only.
- Depends on: [Phase 21]
- Requirements: [R-ADO-05, R-ADO-06, R-ADO-07]
- Phase dir: `.planning/phases/22-global-queue-and-per-session-lock/`

## Phase 23: controller-and-run-log

- Status: Planned
- Mode: standard
- Goal: The per-tick controller core (locked decisions 1, 4). When an orchestrator routine fires (passing the Phase-22 queue+lock), the controller (a) gathers project state — open roadmap phases, last commits, open PRs, deploy status — and reads the last N `routine_run_log` entries; (b) computes the set of DUE command rows for this tick from each row's `schedule_rule` eligibility; (c) assembles the standard controller prompt (SPEC §4 skeleton) with run-log + project-state + due-rows context injected; and (d) parses the agent's structured decision/outcome back into `routine_run_log` writes (mirror the existing `parseControllerDecision`). Always-on implicit rows: `status-check/decide` first, `deploy+log-verify` terminal. Run all DUE rows this tick (not just highest-priority). Run-log survives repo resets/worktrees. Wave fan-out and per-command skill execution land in Phases 24–25.
- Depends on: [Phase 22]
- Requirements: [R-ADO-08, R-ADO-09, R-ADO-10]
- Phase dir: `.planning/phases/23-controller-and-run-log/`

## Phase 24: dependency-aware-wave-execution

- Status: Planned
- Mode: standard
- Goal: Group the DUE commands into dependency-aware waves (locked decision 2): independent commands (audit-fix, gap-scan, code-review on different areas) run as parallel Task subagents inside the agent turn; dependent commands (execute after plan, ship after execute) sequence across waves within the same tick. Parallelism lives INSIDE the agent turn via the templated prompt (locked decision 6) — the hub does not fan out subagents itself. Each unit of work MUST finish → create a PR → dispatch a reviewer subagent to verify that PR, with the reviewer verdict captured to the run log. Do NOT merge to main here (off-hours command, Phase 29 owns that). Encode wave grouping + the finish→PR→reviewer contract into the controller prompt template and the decision parser.
- Depends on: [Phase 23]
- Requirements: [R-ADO-11, R-ADO-12, R-ADO-13]
- Phase dir: `.planning/phases/24-dependency-aware-wave-execution/`

## Phase 25: gsd-command-execution-seam

- Status: Planned
- Mode: standard
- Goal: The execution seam mapping each orchestrator row → a gsd skill invocation inside the bound session agent (locked decision 6). For each due command (`gsd-plan-phase`, `gsd-execute-phase`, `gsd-audit-fix`, `gsd-code-review`, `gsd-verify-work`, plus micro-prompt free-text rows), inject the templated per-command instruction into the bound session's agent turn so the agent runs the corresponding gsd skill. Reuse the entire existing `hub/src/dispatch/` pipeline (gates → queue → grace → finalize) — the cost cap (`dailyCostCapGate`) and `MAX_CHAIN_DEPTH` are non-bypassable and apply to every injected turn. No new dispatch/queue/grace machinery. Micro-prompt rows carry their free text as the turn body with the same frequency semantics.
- Depends on: [Phase 24]
- Requirements: [R-ADO-14, R-ADO-15, R-ADO-16]
- Phase dir: `.planning/phases/25-gsd-command-execution-seam/`

## Phase 26: gap-scan-rotation

- Status: Planned
- Mode: standard
- Goal: The rotating gap-scan command (locked decision 7). A fixed dimension wheel — security · performance · accessibility · test-coverage · dead-code/dependency-hygiene · error-handling · docs-drift · type-safety — where each `gap-scan` tick picks the least-recently-run dimension(s) from `routine_run_log` and maps it to the right specialist agent (Security Engineer, Performance Benchmarker, Accessibility Auditor, Test Results Analyzer, etc.). The chosen dimension + agent are recorded to the run log so the next tick advances the wheel. Rides the Phase-24 wave model (gap-scan is an independent/parallel unit) and the Phase-25 execution seam (it produces a finish→PR→reviewer unit).
- Depends on: [Phase 25]
- Requirements: [R-ADO-17, R-ADO-18]
- Phase dir: `.planning/phases/26-gap-scan-rotation/`

## Phase 27: verify-loop-tail

- Status: Planned
- Mode: standard
- Goal: The terminal deploy/log-verify tail every cycle ends with (locked decision 9). Reuse P5 deploy-verify: forced redeploy → `/health` → probe real routes (`deploy-verify-probe`), AND add a Coolify runtime-log fetch grepped for error/exception/stack patterns. On failure → dispatch a fix agent → re-verify, bounded at N=3 iterations (no cost runaway / infinite loop), then surface to chat. Always appended as the last wave of every tick regardless of which commands were due. Outcome (verify result + iterations + final state) written to the run log.
- Depends on: [Phase 24]
- Requirements: [R-ADO-19, R-ADO-20, R-ADO-21]
- Phase dir: `.planning/phases/27-verify-loop-tail/`

## Phase 28: tiered-autonomy-propose-to-chat

- Status: Planned
- Mode: standard
- Goal: Tiered autonomy gating (locked decision 5). Plan, execute, audit-fix, gap-find, code-review, and deploy-verify run autonomously. `gsd-ship`, `gsd-complete-milestone`, version-tag, and production-merge instead surface a propose-to-chat (Telegram/email) via the existing P3 `surfaceProposal` for one-tap approval — and the controller STOPS that branch rather than completing the ship. Reuse `notifications_sent` for propose throttle. The dedicated off-hours merge command (Phase 29) is the explicit exception to the "propose, don't auto" rule for merge-to-main. Encode the autonomy tier per command into the controller prompt + decision parser so a high-tier command emits a proposal, not an action.
- Depends on: [Phase 25]
- Requirements: [R-ADO-22, R-ADO-23]
- Phase dir: `.planning/phases/28-tiered-autonomy-propose-to-chat/`

## Phase 29: off-hours-merge-to-main

- Status: Planned
- Mode: standard
- Goal: The dedicated off-hours merge-to-main command (locked decision 8) — the ONLY auto-merge-to-main path. Runs only inside a configurable off-hours window (e.g. 01:00–05:00 local, via the row's `schedule_rule` active_window). It auto-merges PRs whose dispatched reviewer marked PASS (reading reviewer verdicts from `routine_run_log`); FAIL/uncertain PRs are held and surfaced to chat (P3 surfaceProposal). Keeps production undisturbed during the day. Idempotent on `github_issue_idempotency`-style guards so a re-fired window doesn't double-merge. Outcome written to the run log.
- Depends on: [Phase 28]
- Requirements: [R-ADO-24, R-ADO-25]
- Phase dir: `.planning/phases/29-off-hours-merge-to-main/`

## Phase 30: lifecycle-stage-presets

- Status: Planned
- Mode: standard
- Goal: Per-session lifecycle stage with per-stage row-frequency presets (locked decision 10). The `lifecycle_stage ∈ {development, beta, production-maintenance}` field (default `development`, from Phase 21) drives an "apply preset" action that fills default row frequencies, each overridable per row afterward: development — frequent decide/plan/execute/gap, lighter review; beta — heavy QC/audit/code-review/verify, lighter build, ship rare (propose); production-maintenance — mostly deploy+log-verify + security gap-scan, ship/merge rare, build on demand. Presets are data (a stage→row-frequency map) applied to `orchestrator_rows`, not hardcoded controller behavior; user overrides persist.
- Depends on: [Phase 23]
- Requirements: [R-ADO-26, R-ADO-27]
- Phase dir: `.planning/phases/30-lifecycle-stage-presets/`

## Phase 31: web-orchestrator-editor

- Status: Planned
- Mode: standard
- Goal: The web UI for the one-orchestrator-task-per-session model (SPEC §5). Settings exposes exactly one orchestrator task per session with: a lifecycle-stage selector (dev/beta/prod-maint) + "apply preset" that fills default row frequencies (overridable); a read-only/expandable view of the drafted standard controller prompt; and a table with one command per row — command name · frequency control reusing `ScheduleRulesBuilder` (cron + day/time + active_window + bounds) with **Never** (⇒ disabled) and **Once** (⇒ max_runs=1 auto-disable) options · enabled toggle · drag sort. "+ Add command" and "+ Add micro-prompt" rows use the same frequency UI. Accent = BLUE (no indigo — CI-guarded by `web/test/no-indigo.test.ts`).
- Depends on: [Phase 23, Phase 30]
- Requirements: [R-ADO-28, R-ADO-29, R-ADO-30]
- Phase dir: `.planning/phases/31-web-orchestrator-editor/`

## Phase 32: legacy-task-migration-and-docs

- Status: Planned
- Mode: standard
- Goal: Fold the legacy task model into the orchestrator model (locked decision 3 — REPLACE) and close docs. A one-shot idempotent backfill in `hub/scripts/` migrates existing many-tasks-per-session scheduled tasks + standalone dev/qc routines into one `orchestrator` row-set per session (with `--dry-run`), deprecating the old `WORKFLOWS.dev/qc` chains as the engine while preserving the ported substrate (shared dispatch, cost cap, deploy-verify, idempotency, notify channels). Docs sweep: new `docs/auto-dev-orchestrator.md`, CLAUDE.md Docs map + cross-cutting invariants, README; `bun run docs:sync` for any new/changed `/api` routes (docs-drift CI enforces). Final QC gate: `bun run check-baseline` green.
- Depends on: [Phase 29, Phase 31]
- Requirements: [R-ADO-31, R-ADO-32, R-ADO-33]
- Phase dir: `.planning/phases/32-legacy-task-migration-and-docs/`
