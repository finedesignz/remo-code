<!-- updated: 2026-05-30 -->
# Requirements

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References below to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical. See .planning/phases/09-retire-npm-packages/.


Project: **remo-code**
Numbered, testable requirements. Each requirement is referenced by phase ROADMAP entries and by PLAN frontmatter `requirements:` arrays. Add new requirements as `RNN` with monotonically increasing numbers — never renumber.

---

## Phase 03 — multichat-grid-view

### R01 — Desktop grid view with user-named tabs
The web app SHALL expose a "Grid" view (route `#/grid` and `#/grid/:tabId`) that renders a user-named set of tabs at the top and a grid of session cells below. Tabs are user-owned, named at creation, renamable inline, and deletable (with confirm). Default URL `#/grid` redirects to the most recently used tab, OR shows a "Create your first tab" empty state if the user has none.

### R02 — Tabs hold user-assigned sets of sessions
Each tab SHALL hold an ordered set of session references chosen by the user from the sessions they own. A session MAY appear in multiple tabs. Adding or removing a session from a tab does not delete the session itself.

### R03 — Grid layouts (3×3, 4×3, auto-fit)
The desktop grid SHALL support three layout modes per tab: `3x3` (9 cells), `4x3` (12 cells), `auto-fit` (CSS grid `repeat(auto-fit, minmax(<sidebarWidth>, 1fr))`). Cell width baseline matches the current sidebar width (≈280px). Layout mode is persisted per tab.

### R04 — Cells resizable and auto-resize on count change
Cells SHALL be resizable by drag handles between adjacent cells. When the number of sessions in a tab changes (add or remove), the grid SHALL auto-resize remaining cells to fill the available area without orphaning blank cells.

### R05 — Live activity in each cell
Each cell SHALL stream live activity for its assigned session — `thinking`, `text_delta`, `tool_use`, `tool_result`, `status`, `assistant_message`. Activity events landing in the browser SHALL be routed to the correct cell by `session_id`. Switching between tabs MUST NOT lose in-flight thinking buffers for cells still in the active tab.

### R06 — Mobile vertical accordion list
Below the Tailwind `md` breakpoint (768px) the grid view SHALL render as a vertical accordion list of sessions belonging to the active tab — one compact row per session, styled like the current `Sidebar` list rows. The grid layout is desktop-only at this breakpoint.

### R07 — Mobile expand to square panel
Tapping an accordion row SHALL expand it inline into a square chat surface whose height equals the viewport width. The input box SHALL be pinned to the bottom of the expanded panel via flex column. Only one row may be expanded at a time. Tapping the expanded row again collapses it.

### R08 — Tab state persisted per user
Tab definitions (name, layout mode, ordered list of session ids, tab order) SHALL persist server-side per `user_id`. Reloading the page or signing in on a different device SHALL restore the same tabs and contents.

### R09 — URL-routable
The active tab SHALL be reflected in the URL hash as `#/grid/:tabId`. Reloading at that URL SHALL restore the same tab. Navigating from `#/chat` to `#/grid` and back MUST NOT break the existing single-chat surface.

### R10 — N-session subscription model on the WS
The web client SHALL drive the existing `ClientSubscribe` op (`hub/src/ws/protocol.ts`) with the full set of session ids currently visible in the active tab. The server SHALL route each activity event only to connections whose subscription set contains that event's `session_id`. The per-connection subscription set SHALL be capped at 12 ids; subscribe calls exceeding 12 SHALL be rejected with a typed error.

### R11 — Shared chat-surface component
The current single-session chat UI in `web/src/components/ChatPanel.tsx` (and its activity feed, input, attachment bar) SHALL be refactored into a self-contained `<ChatSurface sessionId density>` component with three density variants: `full` (current single-chat behavior), `cell` (compact toolbar, smaller fonts, slim input — grid cell), `mobile-expanded` (full-width, square aspect, input pinned bottom). All three variants subscribe to their `sessionId` independently and share the same message/attachment pipeline.

### R12 — No regression to single-chat view
After the refactor, the existing single-chat experience at `#/chat` MUST behave identically to pre-refactor: same message rendering, same activity feed, same input behavior, same attachment paste/drop, same theme, same scroll behavior. Verified by manual smoke and (where possible) by snapshot of the Sidebar + chat layout.

### R13 — Performance budget
The desktop grid SHALL render 12 simultaneous active cells without dropped events at a sustained inbound rate of 5 messages/second per session (60 msg/s total) on a modern laptop. Measured via a synthetic event flood test in `hub/test/` or a dev script.

---

## Phase 06 — supervisor-tray-app

### R-06-01 — No visible console window
When the supervisor runs as a tray app, NO console / terminal / cmd window SHALL be visible to the user — neither on launch, nor on autostart, nor while running. The Bun supervisor process is spawned as a hidden Tauri sidecar with `CREATE_NO_WINDOW`.

### R-06-02 — Windows tray icon with right-click menu
The tray app SHALL display a tray icon in the Windows notification area. Right-click SHALL open a menu with at minimum: **Open Settings**, **Start** / **Stop** (toggled by state), **Status** (shows current state inline), **Restart supervisor**, **Quit**. Left-click opens the Settings window.

### R-06-03 — Settings UI surfaces security/sandbox controls
The Settings UI SHALL expose, at minimum, the following user-editable controls:
- Allowed / sandboxed folders (list with add + remove; advisory warning when adding the user-profile root or Desktop)
- `--dangerously-skip-permissions` HARD CAP (boolean; when OFF, supervisor strips the flag from any session-launch request regardless of what the hub sends)
- Max concurrent sessions (integer, 1–N; enforced in `process-manager.ts`)
- Audit log on/off (append-only JSONL of every session launch to `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`)
- Restrict to git repos (boolean — refuse launching sessions in non-`.git` directories)
- Kill-switch global hotkey (`Ctrl+Shift+Alt+K`, registered via `tauri-plugin-global-shortcut`, terminates all child processes immediately) — display the binding read-only in v1

### R-06-04 — Settings persist and live-reload
Saving in the Settings UI SHALL persist to the existing supervisor JSON config (`%APPDATA%\remo-code\supervisor.json` per `supervisor/src/config.ts`). The running Bun supervisor SHALL detect the file change and reload its in-memory config within 2 seconds without a process restart. Validation errors SHALL bubble back to the UI.

### R-06-05 — Existing nssm-installer service path unaffected
The Tauri tray app SHALL coexist with the legacy `nssm-installer.ts` service install. Running `npx remo-code-supervisor install` MUST still install and start the NSSM service exactly as it does today. The tray app is a NEW entrypoint, not a replacement of the CLI. On first launch the tray app SHALL detect an existing running NSSM service and offer a one-click "switch to tray mode" that uninstalls NSSM, enables Tauri autostart, and reuses the same `supervisor.json`.

### R-06-06 — Auto-start on Windows login
The tray app SHALL register a Windows autostart entry (HKCU `\Software\Microsoft\Windows\CurrentVersion\Run` via `tauri-plugin-autostart`) so it launches automatically when the user logs in. Autostart SHALL be ON by default after first install; the user can disable it from the Settings UI.

### R-06-07 — Single-instance guarantee
Launching the tray app while an instance is already running SHALL focus / show the existing tray app's Settings window instead of spawning a second instance. Implemented via `tauri-plugin-single-instance` (named mutex) for the shell AND the Bun sidecar binds `127.0.0.1:9106` as its own mutex — if either lock fails, the new instance exits immediately. The tray app SHALL refuse to start a sidecar if the NSSM service `RemoCodeSupervisor` is already running.

### R-06-08 — Crash visibility
If the Bun supervisor sidecar dies unexpectedly, the tray icon SHALL change state (distinct color or overlay), and the right-click menu SHALL offer a **Restart supervisor** action. The Settings UI SHALL display the last exit reason (code, signal, stderr tail of last 200 lines) when opened.

### R-06-09 — No breaking changes to the supervisor WS protocol
The Bun supervisor's outbound and inbound WebSocket protocol with the hub (`hub/src/ws/supervisor-protocol.ts`) MUST remain unchanged by this phase EXCEPT for ADDITIVE capability flags on `supervisor.hello` (e.g. `allow_dangerous_skip_permissions: boolean`, `restrict_to_git: boolean`). The hub is otherwise untouched.

### R-06-10 — Update path
The user SHALL be able to update the tray app to a newer version without manually uninstalling and reinstalling. Mechanism: `tauri-plugin-updater` consuming a signed manifest published with each GitHub Release; signed `.msi` deltas. v1 ships unsigned (SmartScreen prompt acknowledged); EV code-signing cert is a future phase. The `remo-code-supervisor` npm package keeps publishing for NSSM/headless users.

### R-06-11 — First-run experience
On first launch (no existing `supervisor.json`), the tray app SHALL open an onboarding flow that asks for: hub URL (default `https://app.remo-code.com`), API key (`olx_` token), and an initial allowed folder. After save, the supervisor sidecar starts and the tray icon goes green.

### R-06-12 — Clean uninstall
Uninstalling via the bundled uninstaller SHALL remove: the app binaries, the autostart Run-key entry, and the tray icon. It SHALL prompt the user before deleting `%APPDATA%\remo-code\supervisor.json` and the `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl` — those are preserved by default.

---

## Phase 07 — titanium-auth-cutover

### R-AUTH-01 — Hub verifies Titanium EdDSA JWTs locally via JWKS
The hub SHALL verify every incoming Titanium-issued JWT locally using JWKS fetched from `${TITANIUM_KEYGEN_API_URL}/v1/accounts/${TITANIUM_ACCOUNT_ID}/.well-known/jwks.json`. Algorithm pinned to EdDSA (Ed25519) — RS*/ES*/HS* tokens claiming to be from Titanium SHALL be rejected. JWKS is cached in-memory with TTL ≥15 minutes; cache MISS on a presented `kid` triggers a single re-fetch (no stampede). Warm-cache fetch SHALL run during hub `bootstrap()` BEFORE the port is bound. Claims verified on every token: `iss == TITANIUM_KEYGEN_API_URL`, `aud` includes `TITANIUM_PRODUCT_ID`, `exp` valid, `nbf` valid, `iat` within ±30s skew, signature against the `kid`-matched key. No call to Titanium on the per-request hot path.

### R-AUTH-02 — Additive DB schema, zero data loss
Schema migration SHALL be additive only: add `users.titanium_user_id TEXT UNIQUE NULL`, drop NOT NULL from `users.password_hash` (column kept nullable). Existing rows SHALL retain their `password_hash` and bcrypt verification SHALL continue to work for any user during the soak. No column is dropped in this phase. `email UNIQUE` constraint preserved. Migration is idempotent (`ALTER TABLE … IF NOT EXISTS` patterns where Postgres supports it; gated migration otherwise).

### R-AUTH-03 — Idempotent mapping job, never auto-merges
A one-shot script `hub/scripts/map-users-to-titanium.ts` SHALL run before the dual-auth release. For each existing `users` row: (a) if no matching Keygen User by email exists, create one and write its UUID into `users.titanium_user_id`; (b) if a matching Keygen User exists AND was created by remo-code (verifiable via admin-API metadata or product scope), link by writing the UUID; (c) if a matching Keygen User exists AND was NOT created by remo-code (collision), `titanium_user_id` is left NULL and the row is appended to a `mapping_conflicts` log (table or file). The job SHALL support `--dry-run` (mandatory flag during first execution) and SHALL be safe to re-run (idempotent). Final output: counts of linked / created / conflicted.

### R-AUTH-04 — 2-week dual-auth soak window
Following the dual-auth release, the hub SHALL accept BOTH (a) Titanium EdDSA-signed JWTs and (b) legacy `JWT_SECRET`-signed HS256 JWTs for at least 14 days. Token type SHALL be detected by inspecting the `alg` header. The web SHALL default to Titanium magic-link login during the soak, with a visible "use password" fallback link routing to the legacy login form. Telemetry SHALL log per-login: token type, success/failure, latency. The soak ends only after ≥14 consecutive days with zero auth-related regressions.

### R-AUTH-05 — Post-soak cutover removes legacy login endpoint
After a successful ≥14d soak, the hub SHALL: (a) disable `/api/auth/login` (404 or 410), (b) remove the `JWT_SECRET`-signed user-token verify code path from REST + WS handlers, (c) remove the legacy login UI from the web (or hide behind `ALLOW_LEGACY_LOGIN` flag). Existing legacy JWTs in browsers SHALL continue to verify until natural expiry (≤7 days) during a brief overlap, OR clients SHALL be force-logged-out at cutover — planner picks based on traffic profile. `JWT_SECRET` env var stays if grep finds non-user-auth uses; otherwise removed.

### R-AUTH-06 — Revocation via Redis blocklist
The hub SHALL maintain a Redis blocklist (`titanium:blocklist` set with `titanium:blocklist:{subject_uuid}` keys) and check it on every token verify, in addition to the EdDSA signature check. A subject present in the blocklist SHALL be refused even if its JWT is technically unexpired. Redis client SHALL be in the hub process. Cache TTL for negative lookups (subject NOT blocked) is allowed to keep hot-path latency low; planner picks a safe default (≤60s).

### R-AUTH-07 — Rollback feature flag for ≥1 release post-cutover
A feature flag env var `ALLOW_LEGACY_LOGIN=true|false` SHALL be present and respected for at least one full release after cutover. When `true`, the bcrypt-verify code path and `/api/auth/login` endpoint are re-enabled. Default is `false` post-cutover. The bcrypt verify code SHALL stay present in the codebase (guarded by the flag) for the entire rollback window. `password_hash` column stays present (nullable) for the same window. Dropping either the flag, the bcrypt code, or the column happens in a follow-up phase — NOT this one.

### R-AUTH-08 — Stable identity by Titanium subject UUID, not email
The persistent identity key SHALL be the Titanium subject UUID (`sub` claim), stored in `users.titanium_user_id`. Email SHALL NOT be the identity key. On every authenticated request, the hub SHALL re-read `email` from the verified JWT claims; if it differs from the stored `users.email`, the hub SHALL update `users.email` keyed by `titanium_user_id`. `users.email UNIQUE` collision on update SHALL be logged and rejected (stale email kept until manual resolution). Brand-new Titanium logins (no matching remo-code row by `titanium_user_id` and no unlinked row matched by email) SHALL auto-create a `users` row keyed by the Titanium UUID with the default role.

### R-AUTH-09 — WS `/ws/client` accepts Titanium tokens with no protocol shape change
The `/ws/client` auth message SHALL accept the Titanium EdDSA JWT in the same shape it currently accepts the legacy JWT (`{ type: "auth", token }`). The verify branch SHALL inspect `alg` and route to either the JWKS-backed EdDSA verifier or the legacy HS256 verifier. Verify SHALL stay local (no Titanium round-trip per connection). Existing 30s heartbeat ping/pong, per-IP connection cap, and per-connection rate limits SHALL remain unchanged.

---

# Milestone `v-settings-overhaul` — Settings/Connections Overhaul + Grid View + Accent Migration

**Source of truth (scope, locked):** `.planning/phases/settings-connections-overhaul/PLAN.md` — do not re-litigate scope.
**Standards:** `~/.claude/design-preferences.md` (updated this session: **app accent = blue; orange = CTA-only; never indigo**) + `~/.claude/architecture-preferences.md`. (User said "architectural-standards.md" — no such file exists; architecture-preferences.md is the standard.)

These requirements use **area-grouped IDs** (R-DS-*, R-CONN-*, R-NUDGE-*, R-USAGE-*, R-PROFILE-*, R-GRID-*, R-DOCS-*) per the milestone brief. Every numbered PLAN item (1–27) maps to exactly one REQ. Phase mapping → Traceability table at end.

## R-DS-* — Design system / accent foundation (Phase 08; PLAN 1–5)

### R-DS-01 — Accent migration indigo→blue
Migrate all `indigo` accent to **blue** across UI primitives + every call site: `ui/{Button,Toggle,Tabs,StatusPill,Card,Field}.tsx`, `Brand.tsx` focus ring, `Sidebar.tsx`, `SupervisorPage.tsx`, all `focus:ring-indigo-*`/`bg-indigo-*`/`text-indigo-*`. Accent = `blue-600/500`, rings `blue-500/30`. Orange remains CTA-only; never indigo.
**Acceptance:** Zero `indigo` in `web/src` (CI grep guard test passes). (PLAN 1)

### R-DS-02 — Button 44px touch targets
`Button` sizing meets ≥44px touch targets: `md` = `px-4 py-2.5`; add a `touch` size; keep compact `sm` for dense desktop rows but ensure ≥44px hit area via mobile padding.
**Acceptance:** All interactive elements ≥44px touch target. (PLAN 2)

### R-DS-03 — InfoTip primitive
New `InfoTip` primitive (Lucide `info`, styled tooltip — NOT native `title=`). Repoint `Field.helper` to render a title-row tip icon instead of a `<p>` description.
**Acceptance:** `InfoTip` exists and is used; no native `title=` left where InfoTip applies. (PLAN 3)

### R-DS-04 — Card border + shadow
`Card` gains optional hairline border `/40` + `shadow-sm` (modern-subtle default; flat variant for table wrappers). Update stale doc comment.
**Acceptance:** Card renders border+shadow by default; flat variant available; doc comment current. (PLAN 4)

### R-DS-05 — Logo horizontal padding
Add `px-3`/`px-4` horizontal padding around `Brand.tsx` `<a>` (and/or AppShell brand wrapper).
**Acceptance:** Logo has visible horizontal breathing room. (PLAN 5)

## R-CONN-* — Connections tab overhaul (Phase 09; PLAN 6–10)

### R-CONN-01 — Remove roots card
Remove the "Root repo folder paths" card (`ConnectionsTab.tsx` RootsEditor 37–213). Roots no longer editable in the web UI.
**Acceptance:** RootsEditor card gone from Connections. (PLAN 6)

### R-CONN-02 — Roots in supervisor first-run wizard
Move root-folder setup into the supervisor first-run wizard (`supervisor/tauri/ui/`): first run prompts hub URL + API key + **root folder** together. Wizard MUST require ≥1 root before completing.
**Acceptance:** Fresh wizard run captures ≥1 root; cannot finish with zero roots. (PLAN 7)

### R-CONN-03 — Orchestrator → pinned top folder row; OrchestratorTab deleted
Remove `OrchestratorTab` from `SettingsPage.tsx` (tab enum + nav + mount). Render a pinned, specially-marked row at the very top of the SupervisorPage table representing the orchestrator (root folder); its enable/disable/start/stop actions move into that row as icon buttons + tooltips. Keep `/api/orchestrator` endpoints. Redirect `#/settings?tab=orchestrator` → `?tab=connections`.
**Acceptance:** Orchestrator controllable from its Connections row; OrchestratorTab gone; orchestrator-tab URL redirects. (PLAN 8)

### R-CONN-04 — Compact single-renderer table, no mobile row-wrap
Single responsive renderer (kill the duplicated desktop/mobile `md:` dual-block). Consolidated metadata cell (`repo · branch · status · last-seen`; path → truncated subline + tooltip). Icon-only row actions w/ tooltips. `divide-y /40`. No mobile row-wrap — horizontal scroll or ellipsis, never wrap. Button sizes per R-DS-02.
**Acceptance:** One renderer; no `md:` dual-block; no row-wrap on mobile widths. (PLAN 9)

### R-CONN-05 — Tooltips replace inline descriptions
Replace inline description text throughout Connections with `InfoTip` (R-DS-03).
**Acceptance:** No inline description paragraphs remain in Connections. (PLAN 10)

## R-NUDGE-* — Prompts removal + per-session auto-nudge (Phase 10; PLAN 11–14)

### R-NUDGE-01 — Per-session auto_nudge column
`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auto_nudge BOOLEAN` (nullable; null = inherit user global). Idempotent DDL in `schema.sql`.
**Acceptance:** Column present, nullable, idempotent on re-boot. (PLAN 11)

### R-NUDGE-02 — Per-session nudge endpoint + dispatch fallback
`PATCH /api/sessions/:id` (or `/api/sessions/:id/auto-nudge`) sets per-session `auto_nudge`. Nudge dispatch reads per-session value, falling back to `users.auto_nudge_idle_sessions` when null.
**Acceptance:** PATCH persists; dispatch honors per-session value with global fallback. (PLAN 12)

### R-NUDGE-03 — Sessions-list row toggle
Small blue auto-nudge switch per row in `Sidebar.tsx`; instant PATCH; tooltip-labeled.
**Acceptance:** Per-row toggle persists and reflects effective state. (PLAN 13)

### R-NUDGE-04 — Delete Prompts tab entirely (incl. instruction blobs + commands)
Remove `PromptsTab.tsx`, the commands card (`CommandsList`/`useCommands`), AND the instruction blobs (claude_global_md / codex_agents_md / codex_config_toml) — instruction files are handled locally, NOT relocated. Drop the tab enum/nav/mount and `/api/instructions` UI wiring (prune hub endpoint if no other callers). Redirect `#/settings?tab=prompts` → `connections`.
**Acceptance:** Prompts tab + blobs + commands gone; instruction blobs NOT moved elsewhere; prompts-tab URL redirects. (PLAN 14)

## R-USAGE-* — Usage tab cleanup (Phase 11; PLAN 15–17)

### R-USAGE-01 — Merge cap into thresholds; rename card
Merge Daily Cost Cap into the thresholds card; rename card to exactly **"Claude Usage and Cost Controls"**. Desktop lays out cap + session% + week% compactly (one row/grid).
**Acceptance:** One merged card with the exact title; cap no longer separate. (PLAN 15)

### R-USAGE-02 — Tokens under dollars
In each cost card (Today/Week/Month) show token count beneath the `$` amount (consume `/api/usage/cost` token data; extend `/api/usage/summary` if needed).
**Acceptance:** Each cost card shows tokens under the dollar figure. (PLAN 16)

### R-USAGE-03 — Tooltips + autosave cap/thresholds
Replace threshold/cap helper sentences with tooltips. Auto-save-on-blur for cap + thresholds (drop Save buttons).
**Acceptance:** Helper sentences → InfoTip; cap+thresholds autosave on blur; Save buttons removed. (PLAN 17)

## R-PROFILE-* — Profile tab + default-session (Phase 12; PLAN 18–20)

### R-PROFILE-01 — Delete Telegram card
Delete the Telegram card (`ProfileTab.tsx:395–557`) + its fetches. Keep `/api/telegram/*` endpoints (bot still works); only the Profile UI is removed.
**Acceptance:** Telegram card gone from Profile; `/api/telegram/*` untouched. (PLAN 18)

### R-PROFILE-02 — Default session = orchestrator
Centralize a "resolve default session" helper that falls back to the user's orchestrator session at the root folder when no explicit default is set. Wire into List View auto-select (`ChatLayout.tsx:100-102`), Telegram default resolution, any `default_session` logic.
**Acceptance:** With no default set, orchestrator is selected everywhere a default is resolved. (PLAN 19)

### R-PROFILE-03 — Autosave name/timezone; width
Auto-save-on-blur for display name + timezone (drop Save buttons); Profile width → `max-w-7xl`.
**Acceptance:** Name+timezone autosave on blur; Save buttons removed; width = `max-w-7xl`. (PLAN 20)

## R-GRID-* — Grid View = active sessions + persistence (Phase 13; PLAN 21–23)

### R-GRID-01 — Default tab = all active sessions
Default tab auto-populates all active sessions (same `useSessions` source as List View), virtual membership (not user-editable), cap 12 + existing overflow badge. Grid Default = List View parity.
**Acceptance:** Default tab mirrors active sessions, capped at 12 with overflow badge. (PLAN 21)

### R-GRID-02 — User tabs: create + move/assign sessions
User can create more tabs and move/assign sessions between tabs (drag or menu) using the existing `chat_tab_sessions` CRUD; explicit DB membership retained for user tabs.
**Acceptance:** Sessions reassignable between user tabs; persists. (PLAN 22)

### R-GRID-03 — Persist tabs + memberships + active-cell across restart
Add active-cell persistence to DB (extend `chat_tabs` or a `user_grid_state` row). Tabs + memberships + focused cell survive hub restart / reload / device switch.
**Acceptance:** After hub restart + reload, tabs, assignments, and active cell reload correctly. (PLAN 23)

## R-DOCS-* — Cross-cutting polish + docs (Phase 14; PLAN 24–27)

### R-DOCS-01 — Autosave sweep
Auto-save-on-blur sweep for remaining low-stakes settings forms; remove redundant Save buttons.
**Acceptance:** Remaining low-stakes forms autosave; redundant Save buttons gone. (PLAN 24)

### R-DOCS-02 — Width uniformity
`max-w-7xl` across all settings tabs.
**Acceptance:** Every settings tab uses `max-w-7xl`. (PLAN 25)

### R-DOCS-03 — EmptyState copy
`EmptyState` copy → single sentence; drop multi-line descriptions.
**Acceptance:** EmptyState descriptions are one sentence. (PLAN 26)

### R-DOCS-04 — Architecture docs refresh (anti-drift)
Update in the same milestone: web CLAUDE.md / `docs/` (new tab set Connections/Credentials/Usage/Profile — Prompts & Orchestrator GONE; accent=blue rule; per-session auto-nudge; Grid Default behavior); `.planning/codebase/{ARCHITECTURE,STRUCTURE,CONVENTIONS}.md`; `.planning/phases/12-ui-restructure/12-CONTEXT.md` supersession note (Orchestrator/Prompts tabs removed; this milestone is the new source of truth); `docs/grid-view.md` (Default tab + persistence); hub `docs:sync` (`/openapi.json` + `docs/api.md`) for any new/changed endpoints.
**Acceptance:** All listed docs reflect the milestone; `docs:sync` in sync; no drift. (PLAN 27)

---

## Traceability — `v-settings-overhaul`

| Requirement | Phase | Status |
|-------------|-------|--------|
| R-DS-01 | Phase 08 | Pending |
| R-DS-02 | Phase 08 | Pending |
| R-DS-03 | Phase 08 | Pending |
| R-DS-04 | Phase 08 | Pending |
| R-DS-05 | Phase 08 | Pending |
| R-CONN-01 | Phase 09 | Pending |
| R-CONN-02 | Phase 09 | Pending |
| R-CONN-03 | Phase 09 | Pending |
| R-CONN-04 | Phase 09 | Pending |
| R-CONN-05 | Phase 09 | Pending |
| R-NUDGE-01 | Phase 10 | Pending |
| R-NUDGE-02 | Phase 10 | Pending |
| R-NUDGE-03 | Phase 10 | Pending |
| R-NUDGE-04 | Phase 10 | Pending |
| R-USAGE-01 | Phase 11 | Pending |
| R-USAGE-02 | Phase 11 | Pending |
| R-USAGE-03 | Phase 11 | Pending |
| R-PROFILE-01 | Phase 12 | Pending |
| R-PROFILE-02 | Phase 12 | Pending |
| R-PROFILE-03 | Phase 12 | Pending |
| R-GRID-01 | Phase 13 | Pending |
| R-GRID-02 | Phase 13 | Pending |
| R-GRID-03 | Phase 13 | Pending |
| R-DOCS-01 | Phase 14 | Pending |
| R-DOCS-02 | Phase 14 | Pending |
| R-DOCS-03 | Phase 14 | Pending |
| R-DOCS-04 | Phase 14 | Pending |

**Coverage:** 27/27 PLAN items mapped to 27 REQs across Phases 08–14. No orphans.

---

## Milestone m-interactive-pty-runner (Phases 15–19)

> Source spec: `.planning/architecture/interactive-pty-runner-SPEC.md`. CRITICAL OVERRIDE in effect:
> FULL RIP-AND-REPLACE — PTY-ify ALL human sessions (Claude AND Codex); delete the stream-json
> ChatSurface human chat UI; stream-json survives only as an unattended-automation transport.
> Non-negotiable: never pass `ANTHROPIC_API_KEY` to a spawned client; no API-key fallback (fallback =
> Codex/Gemini); spawn official `claude` only, never reuse the OAuth token; only human turns touch the
> PTY runner; auth via `claude login`; interactive `claude` has no `-p`/`--input-format stream-json`;
> raw-terminal WS isolated from the `/ws/agent` RunnerEvent pipeline; June-15 checks gate the cutover.

### Phase 15 — pty-spike-and-compile-derisk

#### R-PTY-01 — Interactive claude in a PTY (no programmatic flags)
The supervisor SHALL spawn the genuine interactive `claude` TUI inside a PTY with NO `-p` and NO `--input-format stream-json`/`--output-format stream-json` flags. The spawned process env MUST have `ANTHROPIC_API_KEY` deleted (parity with `claude-runner.ts:94`). A canary test SHALL fail the build if the PTY runner argv contains `-p`, `--print`, or `--input-format`/`--output-format stream-json`, or if `ANTHROPIC_API_KEY` is present in the spawned env.

#### R-PTY-02 — Raw-terminal bytes streamed both directions
The spike SHALL stream raw PTY output bytes to the web client and write raw input bytes from the web client into the PTY, such that a typed human turn renders in the TUI and TUI output renders in xterm.js.

#### R-PTY-03 — Raw-terminal WS channel isolated from the structured pipeline
The raw-terminal transport SHALL be a dedicated channel carrying terminal frames (data/resize/reattach) and MUST NOT emit or depend on the structured `RunnerEvent` union or the `/ws/agent` agent-protocol bubble pipeline. A test SHALL assert no `RunnerEvent` coupling on the terminal path.

#### R-PTY-04 — node-pty / bun-compile shipping approach demonstrated
The spike SHALL determine and demonstrate how the `node-pty` native addon ships when the supervisor sidecar is produced via `bun build --compile` (bundle native module, helper exe, or out-of-band PTY host). The chosen approach SHALL be documented in a SPIKE/RESEARCH artifact consumed by Phase 16, including a working proof the PTY host runs from the compiled sidecar context (or a documented out-of-band launch).

#### R-PTY-05 — Themed xterm.js panel in the existing shell
The spike SHALL render the TUI in an xterm.js panel inside the existing React shell using the app theme tokens (`--bg-primary`/`--text-primary`, blue accent) without altering app chrome (sidebar/nav). `web/test/no-indigo.test.ts` SHALL remain green.

### Phase 16 — hardened-pty-relay-and-mobile-terminal

#### R-PTY-06 — claude-pty-runner module
A new `supervisor/src/runners/claude-pty-runner.ts` SHALL implement the interactive PTY runner (raw bytes only, no RunnerEvent translation), deleting `ANTHROPIC_API_KEY` from the spawned env, using the Phase-15 sidecar-shipping approach.

#### R-PTY-07 — tmux-backed persistence and reattach
The interactive `claude` SHALL run inside tmux so a dropped phone/browser connection can reattach with no lost state. A test/demo SHALL prove tmux reattach survives a dropped connection with scrollback intact.

#### R-PTY-08 — Authenticated raw-terminal relay end-to-end
The raw-terminal WS channel SHALL be authenticated via the existing opaque-cookie session/WS infra and relay frames `/ws/client` to/from `/ws/agent` (data/resize/reattach/scrollback) without coupling to the structured agent-protocol.

#### R-PTY-09 — Mobile terminal: reconnect / resize / scrollback
The xterm.js terminal surface SHALL support reconnect, resize (propagating cols/rows to the PTY), and scrollback on mobile and desktop.

#### R-PTY-10 — Human-only dispatch guard
A guard SHALL reject non-interactive/automation dispatch sources (scheduler, orchestrator background, auto-dev, error-capture) from the PTY runner. A test SHALL assert an automation-sourced dispatch to a PTY session is rejected.

#### R-PTY-11 — Per-session runner type; Telegram stays stream-json
Runner type SHALL be per-session (PTY-interactive vs stream-json) and opt-in per session. A session that is a Telegram default MUST NOT be switched to the PTY runner; a guard SHALL prevent it.

### Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace

#### R-PTY-12 — Codex interactive/PTY runner
A `supervisor/src/runners/codex-pty-runner.ts` SHALL run Codex human sessions on the raw-terminal surface, reusing the Phase-16 PTY host + raw-terminal WS + tmux.

#### R-PTY-13 — Delete the stream-json human chat UI
The web `ChatSurface` (all `full`/`cell`/`mobile-expanded` variants) and the structured activity-bubble rendering (thinking/text_delta/tool_use/tool_result) for human sessions SHALL be removed from `web/src`. A test SHALL assert no `ChatSurface`/structured-bubble render path remains for human sessions.

#### R-PTY-14 — Remove dead agent-protocol bubble translation
Any hub-side agent-protocol-to-bubble translation that exists ONLY to feed the deleted human chat UI SHALL be removed. Translation needed by unattended automation (Phase 18) SHALL be preserved.

#### R-PTY-15 — All human sessions route to the terminal surface
Both Claude and Codex human sessions SHALL render on the single themed xterm.js terminal surface; grid/list views SHALL host terminal cells (or drop conversation rendering) consistent with one surface.

#### R-PTY-16 — stream-json runner path preserved for automation
The runner-side stream-json path SHALL remain intact for unattended automation transports (only its human chat UI is removed). Baseline + `no-indigo` tests stay green.

### Phase 18 — billing-guardrail-dual-bucket-usage

#### R-PTY-17 — Dual-bucket usage poll
`supervisor/src/usage/oauth-poll.ts` to `hub/src/usage/store.ts` SHALL surface BOTH balances (interactive subscription pool AND programmatic credit pool), broadcast via the existing `subscription_usage` WS path. The OAuth token MUST NOT be serialized to the hub (parity with existing behavior).

#### R-PTY-18 — Programmatic-leak alert + optional hard-halt
The system SHALL alert when programmatic credit is consumed unexpectedly and SHALL support an optional hard-halt — no silent drain, no surprise hard-stop.

#### R-PTY-19 — Automation routed to programmatic path behind the cost cap
Unattended automation (scheduler/orchestrator-background/auto-dev/error-capture) SHALL be explicitly routed onto the stream-json/programmatic path behind the existing non-bypassable `dailyCostCapGate`. No API key anywhere.

#### R-PTY-20 — Dual-bucket rendered in usage UI
The usage strip/tab SHALL render both buckets (util% + reset where applicable) without exposing the OAuth token.

### Phase 19 — cutover-gate-and-automation-fallback

#### R-PTY-21 — June-15 cutover gate runbook (not a build blocker)
A documented cutover GATE SHALL encode the spec four "Verify after June 15" checks as a measurement procedure using the Phase-18 dual-bucket poll. Phases 15 to 18 are buildable before June 15; only the default-on cutover is gated.

#### R-PTY-22 — Interactive-bucket confirmation flips default-on
The PTY runner SHALL become the default for human sessions ONLY after measurement confirms a PTY interactive session bills the INTERACTIVE bucket.

#### R-PTY-23 — If-PTY-fails fallback to Codex/Gemini (no API key)
The "If PTY fails" fallback SHALL wire the human-coding UX to the existing Codex runner and provide a stubbed/optional future Gemini runner seam. No code path SHALL fall back to `ANTHROPIC_API_KEY`/API-platform billing.

#### R-PTY-24 — Telegram stays on programmatic pool (documented)
Telegram and any text-only channel SHALL remain on the stream-json programmatic pool by structural necessity; documented, not worked around with an API key.

#### R-PTY-25 — Final docs sweep
README/CLAUDE.md/`docs/` SHALL document the terminal surface, dual-bucket usage, the cutover gate, the rip-and-replace, and the no-API-key invariant; `bun run docs:sync` run if endpoints changed.

**Milestone coverage:** 25 REQs (R-PTY-01..25) mapped across Phases 15–19. No orphans.

---

## Milestone m-interactive-pty-runner — Phase 20 addendum (Telegram on transcript-tail)

> **Why Phase 20 exists.** Phase 17 (rip-and-replace) deletes the stream-json human runner and with
> it the Telegram bridge's structured event source (`assistant_message:final`/`tool_use` on the hub
> event bus, and the `permission_request`→`onPermissionPending` path). After Phase 17 the Telegram
> bridge is non-functional. Phase 20 rebuilds Telegram on a **backend-agnostic transcript-tail**
> source plus a **fail-closed permission/question keystroke-injection** path, sequenced strictly
> AFTER Phase 17.
>
> **Supersedes R-PTY-11 / R-PTY-24 (Telegram-stays-stream-json).** R-PTY-11 ("a Telegram default
> session MUST NOT be switched to the PTY runner") and R-PTY-24 ("Telegram stays on the programmatic
> pool") were written assuming the stream-json human runner survives. It does not. R-PTY-11's
> blanket guard and R-PTY-24's "stream-json pool by structural necessity" are **superseded by
> R-TG-01..R-TG-12 below**: Telegram sessions ARE PTY-interactive sessions whose output is sourced
> from the transcript and whose input is injected as PTY keystrokes. The transcript reader is a
> read-only observer of the human's own interactive subscription session — it adds NO programmatic
> Claude call and therefore does NOT move Telegram onto the programmatic credit pool. The ToS line
> (constraint 3) is preserved: only a genuine human Telegram message injects to the PTY; Telegram is
> never combined with auto-nudge/scheduled prompts to drive the PTY unattended.

### Phase 20 — telegram-transcript-tail

#### R-TG-01 — Backend-agnostic transcript-source adapter
A `TranscriptSource` adapter interface SHALL be defined with at least one implementation per backend.
The adapter is selected by the session's backend (`cliKind: 'claude' | 'codex'`), NOT hardcoded to a
single path. Each adapter resolves the active session's transcript location, tails newly-appended
records, and normalizes them to a shared `TranscriptEntry` union (`assistant_text`, `tool_use`,
`permission_request`, `user_question`, `turn_complete`). Adding a backend SHALL require only a new
adapter, no change to the bridge. A test SHALL assert the bridge consumes only the normalized union
and never a backend-specific shape.

#### R-TG-02 — Claude transcript adapter
The Claude adapter SHALL source records from the Claude Code projects transcript JSONL
(`~/.claude/projects/<project-slug>/<session-uuid>.jsonl`), mapping `assistant`/`tool_use`/result
entries to the normalized union. The session→transcript mapping (which file is THIS remo-code
session) SHALL be resolved explicitly (project-dir slug + session id captured at PTY spawn), never by
guessing the newest file. A test SHALL assert mapping is deterministic given a known project dir +
session id, and that a transcript-format drift (unknown record `type`) degrades to "skip + log",
never a crash and never a misclassification.

#### R-TG-03 — Codex transcript adapter (+ documented fallback)
The Codex adapter SHALL source records from the Codex CLI rollout JSONL
(`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`; each line
`{timestamp, type: session_meta|response_item|turn_context, payload}`), mapping `response_item`
message/function_call payloads to the normalized union. Because this path/format is UNDOCUMENTED and
version-unstable (community-reverse-engineered; see RESEARCH), the adapter SHALL: (a) resolve the
session's rollout file by the `session_meta` id captured at spawn (not newest-file heuristic), and
(b) fall back to a **terminal-byte scrape** mode for Codex when the rollout file is absent or its
schema is unrecognized — surfacing only `assistant_text` and `turn_complete` (NO permission parsing
from scraped bytes; see R-TG-06 fail-closed). A test SHALL assert the unknown-schema path selects the
fallback and never emits a `permission_request` from scraped bytes.

#### R-TG-04 — Telegram output sourced from the selected adapter
The Telegram outbound bridge SHALL forward `assistant_text` (final turn) and collapsed `tool_use`
one-liners sourced from the session's `TranscriptSource` (selected by backend), replacing the deleted
`assistant_message:final` hub-event-bus source. Streaming deltas SHALL NOT be forwarded (parity with
the prior "final only" invariant). A test SHALL assert the bridge no longer imports
`onAssistantMessageFinal` and instead consumes `TranscriptEntry` events.

#### R-TG-05 — Pending permission / user_question detected from the transcript
The system SHALL detect a pending permission/approval or `user_question`/option-select per backend
from the normalized `TranscriptSource` stream (or a structured side-channel if the backend exposes
one). Detection SHALL key each pending request by **`(sessionId, requestId)`** — never `requestId`
alone (reusing the existing `hub/src/telegram/approvals.ts` keying that fixed the multi-user clobber).
A test SHALL assert two concurrent pendings on different sessions with the same synthetic requestId do
not collide.

#### R-TG-06 — Fail-CLOSED permission parsing (security-critical)
Permission/question detection SHALL be fail-CLOSED: if the transcript entry (or scraped bytes) is
ambiguous, partial, or its option set is not parseable into a discrete, enumerated choice, the system
SHALL do NOTHING — emit no Telegram prompt, inject no keystroke, and NEVER auto-approve. An
auto-approval or a default "yes" on parse failure is explicitly forbidden. A test SHALL assert that a
malformed/ambiguous permission entry produces zero injected keystrokes and zero Telegram approval
messages. The Codex terminal-byte-scrape fallback (R-TG-03) SHALL NOT emit permission prompts at all.

#### R-TG-07 — Surface to Telegram via existing inline approval UX
A detected pending permission/question SHALL be surfaced using the existing inline tap-to-approve UX
(`hub/src/telegram/approvals.ts` registry + `sendMessageWithKeyboard`), with one inline button per
enumerated option (Approve/Deny for boolean permissions; one button per discrete choice for
`user_question` option-selects). Authorization SHALL reuse the per-user `(sessionId, requestId)`
binding — a foreign/stale tap finds no entry and is rejected. A test SHALL assert an unauthorized
user's tap is rejected and injects nothing.

#### R-TG-08 — Human response injected as the correct PTY keystroke(s)
On an authorized tap, the system SHALL inject the response into the session's PTY as the literal
keystroke(s) the backend's TUI expects for that pending request (e.g. the option index/arrow+enter or
the approve/deny key), via the Phase-16 raw-terminal input path — NOT via the deleted
`permission_response` agent-protocol message. The keystroke mapping SHALL be per-backend (part of the
adapter). A test SHALL assert the injected bytes match the expected mapping for a known pending shape,
and that injection targets the correct session's PTY only.

#### R-TG-09 — Disambiguation: a tap answers exactly one pending request
A Telegram tap SHALL resolve exactly the `(sessionId, requestId)` it was bound to, then remove that
entry so the decision applies once. If the bound pending no longer exists (already resolved,
TTL-expired, or the TUI advanced past it — detected because the transcript shows the request resolved
or a new turn started), the tap SHALL be rejected with a "no longer pending" notice and inject
nothing. A test SHALL assert a tap on a superseded/expired pending injects nothing.

#### R-TG-10 — PTY write-arbitration: single-writer turn lock per session
Concurrent writers to one tmux-backed PTY (phone/browser xterm AND the Telegram bridge) SHALL be
serialized by a **single-writer turn lock per session** held in the hub. A writer acquires the turn,
injects one human turn (or one permission/question response), and the lock is released only when the
turn is observed COMPLETE — defined as a `turn_complete`/assistant-entry observed in the
`TranscriptSource` (or, for the byte-scrape fallback, the TUI's idle/prompt-ready signal). While held,
other writers' input is QUEUED (FIFO, bounded) and the holder is shown in per-session "who holds the
turn" state. A test SHALL assert: (a) a second writer's input is queued not interleaved, (b) the lock
releases on observed completion, (c) a permission/question response from the non-holder is allowed
(answering a prompt is not a new turn) without breaking the holder's turn.

#### R-TG-11 — Telegram injection obeys the human-only dispatch guard
Telegram injection SHALL pass through the Phase-16 human-only dispatch guard (constraint 3 / R-PTY-10):
a real human Telegram message is an allowed human turn, but Telegram MUST NOT be combined with
auto-nudge or scheduled/automation prompts to drive the PTY unattended. A test SHALL assert an
automation-sourced dispatch tagged as Telegram-origin is rejected by the guard.

#### R-TG-12 — Phase 17 break is explicit, not silent; Phase 20 docs
Phase 17's plan/notes SHALL explicitly state "Telegram bridge event source removed here; rebuilt in
Phase 20 on transcript-tail" so the break is acknowledged, not silent. Phase 20 SHALL update
`docs/telegram-bridge.md` (and CLAUDE.md Docs map) to describe the transcript-tail source, the
per-backend adapters, the fail-closed permission-injection flow, and the write-arbitration turn lock.
`bun run docs:sync` SHALL run if endpoints changed.

**Phase 20 coverage:** 12 REQs (R-TG-01..12). Supersedes the Telegram clauses of R-PTY-11 and
R-PTY-24. No orphans.

---

## Milestone m-interactive-pty-runner — Phase 18 & 19 detail addendum (appended 2026-05-31)

> APPEND-ONLY block authored during the Phase-18/19 detail-planning pass. The parent requirements
> **R-PTY-17..25 already exist above** (Phases 18–19 sections); this addendum does NOT replace them.
> It records the fine-grained sub-requirements + threat IDs derived during detail planning, for
> traceability into the phase PLAN/VALIDATION artifacts. Where a sub-ID elaborates a parent, the parent
> remains authoritative.

### Phase 18 — billing-guardrail-dual-bucket-usage (elaborates R-PTY-17..20)

#### R-PTY-17a — Programmatic bucket is a dollar balance, additive + fail-safe
The second (Agent-SDK programmatic credit) bucket SHALL be carried as a DOLLAR balance
(`{used_usd, limit_usd, resets_at, claimed}`), ADDITIVE to the existing four util% windows on
`UsagePayload` / `usage_report` / `subscription_usage` (optional + nullable — old supervisors/clients
SHALL still validate). When the credit source is absent/pre-claim/unrecognized, the bucket SHALL
degrade to an explicit empty state and SHALL NEVER fabricate a dollar value. The OAuth token SHALL NOT
be serialized to the hub (parity preserved; negatively tested). *(Threats T-18-01 token-leak CRITICAL;
T-18-02 fabricated-number HIGH; T-18-03 non-additive-schema HIGH.)*

#### R-PTY-18a — Leak alert visible; hard-halt opt-in, default-off, humans exempt
The programmatic-leak alert SHALL be surfaced (WS `programmatic_leak_alert` + usage-tab notice), never
suppressed silently. The hard-halt SHALL be OPT-IN, default OFF, and SHALL act ONLY by adding a
predicate at the single existing `dailyCostCapGate` chokepoint (no parallel chokepoint), denying
programmatic/automation dispatch with reason `programmatic_credit_halt`. It SHALL NEVER halt a human
interactive PTY turn, and SHALL NEVER be a surprise (alert precedes the user-configured bound).
*(Threats T-18-04 silent-drain HIGH; T-18-05 surprise-hard-stop CRITICAL.)*

#### R-PTY-19a — Automation-routing regression guard
A guard test SHALL assert every unattended dispatch source (scheduler / orchestrator-background /
auto-dev / error-capture) passes through `dailyCostCapGate` AND is rejected by the Phase-16 human-only
guard if pointed at the PTY surface, and that NO automation path constructs an `ANTHROPIC_API_KEY` env /
API-platform call. *(Threats T-18-06 cap-escape HIGH; T-18-07 automation-on-PTY CRITICAL.)*

#### R-PTY-20a — UI honest empty state + no secret exposure
The usage UI SHALL render the programmatic bucket only from the non-secret WS snapshot (no token
read/rendered), show an explicit empty state when the bucket is unknown/pre-claim, and present the
leak notice + the opt-in hard-halt toggle. Blue accent preserved (`web/test/no-indigo.test.ts` green).
*(Threat T-18-08 secret-exposure HIGH.)*

### Phase 19 — cutover-gate-and-automation-fallback (elaborates R-PTY-21..25)

#### R-PTY-21a — Gate runbook = measurement, not a build blocker
A `docs/cutover-gate-june15.md` runbook + a checklist artifact SHALL encode the four SPEC checks
(PTY-interactive bucket; setup-token vs login; subagents/hooks/MCP residual; login-credential headless
reclassification) as a snapshot→controlled-turn→snapshot→diff measurement using the Phase-18 dual-bucket
poll. The runbook SHALL state it is NOT a build blocker (Phases 15–18 ship before June 15) and that only
the default-on flip is gated. The login-credential reclassification item SHALL be an ONGOING watch.
*(Threat T-19-01 gate-misread MED.)*

#### R-PTY-22a — Fail-safe default backend until gate-confirmed
The default-human-backend selector SHALL default new human sessions to a NON-Claude-PTY backend (Codex)
until a recorded `claude_interactive_confirmed` gate flag is set; the flip to Claude-PTY-default SHALL
be a recorded operator config change, never automatic. *(Threat T-19-02 silent-programmatic-default
CRITICAL.)*

#### R-PTY-23a — Codex-primary fallback, Gemini stub, no API key
The Codex PTY runner SHALL be selectable as a human backend through the same terminal surface using
ChatGPT-subscription sign-in (not an API key). A Gemini runner seam SHALL exist as a stub only
(feature-flagged off / not-implemented, never default-selected). NO runner/fallback path SHALL set
`ANTHROPIC_API_KEY` or construct an API-platform billing call (negatively guarded). *(Threats T-19-03
API-key-creep CRITICAL; T-19-04 gemini-stub-mistaken MED.)*

#### R-PTY-24a / R-PTY-25a — Supersession + docs consistency
The R-PTY-24 supersession (Telegram = read-only transcript observer, NOT on the programmatic pool;
Phase 20 / R-TG-01..12) SHALL be stated explicitly and consistency-tested across SPEC + ROADMAP +
REQUIREMENTS + docs. The final docs sweep (README / CLAUDE.md / `docs/`) SHALL cover the terminal
surface, dual-bucket usage, the cutover gate, the rip-and-replace, the selector + fallback, and the
no-API-key invariant. *(Threat T-19-05 silent-contradiction MED.)*

**Phase 18/19 addendum coverage:** 4 sub-IDs for Phase 18 (R-PTY-17a..20a) + 5 for Phase 19
(R-PTY-21a..25a), all tracing to existing parents R-PTY-17..25. No orphans; no new top-level
requirement introduced.

---

## Milestone m-interactive-pty-runner — Phase 16 & 17 detail addendum (appended 2026-05-31)

> APPEND-ONLY block authored during the Phase-16/17 detail-planning pass. The parent requirements
> **R-PTY-06..16 + R-TG-12 already exist above** (Phase 16/17 sections); this addendum does NOT replace
> them. It records the fine-grained sub-requirements + threat IDs derived during detail planning, for
> traceability into the phase PLAN/VALIDATION artifacts. Where a sub-ID elaborates a parent, the parent
> remains authoritative. (`workflow.plan_review_convergence` was enabled in `.planning/config.json` the
> same session.)

### Phase 16 — hardened-pty-relay-and-mobile-terminal (elaborates R-PTY-06..11)

#### R-PTY-07a — Supervisor-owned persistence + scrollback ring-buffer (cross-platform)
The PTY process SHALL be owned by the supervisor (not scoped to a client WS) so a dropped client does
NOT kill the session, and a bounded output ring-buffer SHALL record recent PTY output for scrollback
replay on reattach. tmux SHALL be used on POSIX where available (survival across supervisor restarts);
on Windows (no native tmux) the supervisor-owned persistent-PTY + ring-buffer is the documented
baseline. A test SHALL assert a simulated disconnect→reattach replays the last-N lines, and an
idle/exited PTY is reaped (no orphan). *(Threats T-16-04 persistence-leak MED; cross-ref 16-PLAN-001.)*

#### R-PTY-08a — Isolated raw-terminal frame schema + authenticated byte-faithful relay
A `hub/src/ws/term-protocol.ts` SHALL define the raw-terminal frame schema
(`term.data`/`term.input`/`term.resize`/`term.attach`/`term.reattach`) OUTSIDE `agent-protocol.ts`,
importing neither it nor the `RunnerEvent` type; the hub relay SHALL be byte-faithful and accept frames
only on an authenticated, subscribed connection. Static + auth tests SHALL assert zero RunnerEvent
coupling and rejection of unauthenticated frames. *(Threats T-16-05 unauth-attach HIGH, T-16-07
coupling-leak MED; cross-ref 16-PLAN-002.)*

#### R-PTY-10a — Human-only gate composes WITH the non-bypassable cost cap
The human-only dispatch gate SHALL be composed into the SINGLE existing dispatch pipeline alongside
`dailyCostCapGate` (no parallel chokepoint, no new uncapped route); it rejects automation sources for
`pty-interactive` sessions and allows genuine human turns. A test SHALL assert per-automation-source
rejection AND that the cost cap still applies. *(Threats T-16-06 automation-on-PTY HIGH, T-16-08
cap-bypass HIGH; cross-ref 16-PLAN-002.)*

#### R-PTY-11a — Per-session runner_type column (idempotent DDL, opt-in)
`sessions.runner_type TEXT NOT NULL DEFAULT 'stream-json'` (∈ {'stream-json','pty-interactive'}) SHALL
be added via `ADD COLUMN IF NOT EXISTS` (idempotent; re-runs safely each boot; NO data backfill in
schema.sql); the API validates the enum, opt-in per session, and a Telegram-default session SHALL NOT
be settable to 'pty-interactive'. *(Cross-ref 16-PLAN-002.)*

### Phase 17 — codex-pty-runner-and-chatsurface-rip-and-replace (elaborates R-PTY-12..16 + R-TG-12)

#### R-PTY-12a — Backend selection seam (Claude/Codex PTY)
For `runner_type='pty-interactive'`, the supervisor SHALL instantiate `codex-pty-runner.ts` when
`cli_kind='codex'` and `claude-pty-runner.ts` when `cli_kind='claude'`; the Codex runner mirrors the
Claude PTY runner (interactive-only, env-clean, raw bytes, no RunnerEvent). A test SHALL assert the
selection + the extended canary covers the Codex runner. *(Threats T-17-01 Codex-programmatic-flag
HIGH, T-17-02 env-hygiene HIGH, T-17-03 automation-on-Codex-PTY HIGH; cross-ref 17-PLAN-001.)*

#### R-PTY-13a — One-way-door deletion gate
The web/hub deletions (R-PTY-13/14) SHALL NOT begin until the Phase-16 VERIFICATION ship-verdict is
PASS (terminal surface proven); a precheck artifact records the gate. A test SHALL assert no
`ChatSurface`/structured-bubble render path remains for human sessions after deletion. *(Threats T-17-04
premature-deletion CRITICAL, T-17-05 shared-chrome-deletion HIGH; cross-ref 17-PLAN-002.)*

#### R-PTY-14a — Automation-translation preservation regression (PRESERVE-on-ambiguity)
After the rip, a regression test SHALL assert automation-shared translation survives — a `usage_event`
still records cost (the non-bypassable cost-cap source) AND a scheduled-style dispatch still finalizes;
the runner-side stream-json path (`claude-runner.ts`/`session-bridge.ts`) is unchanged. Ambiguous
translation paths SHALL be PRESERVED, not deleted. *(Threats T-17-07 delete-automation-translation
CRITICAL, T-17-08 cost-cap-severed CRITICAL; cross-ref 17-PLAN-003.)*

#### R-TG-12a — Explicit Telegram break markers; bridge module retained
Each removed Telegram structured-event source / permission-path site SHALL carry the comment
`// Phase 17 rip: Telegram event source removed here; rebuilt in Phase 20 (transcript-tail).`, and
`hub/src/telegram/bridge.ts` SHALL remain on disk (Phase 20 re-sources it). A grep test SHALL assert the
markers exist and the module is present. *(Threat T-17-09 silent-Telegram-break HIGH; cross-ref
17-PLAN-003.)*

**Phase 16/17 addendum coverage:** 4 sub-IDs for Phase 16 (R-PTY-07a, 08a, 10a, 11a) + 5 for Phase 17
(R-PTY-12a, 13a, 14a, R-TG-12a), all tracing to existing parents R-PTY-06..16 + R-TG-12. No orphans; no
new top-level requirement introduced.

---

## Cycle-2 additions (Phase 15/16)

> APPEND-ONLY block authored during the Cycle-2 GSD replan (adjudicated remediation set
> `.planning/reviews/SYNTHESIS-cycle1.md`, items H1/H2/H3/H6/H7/H10). These elaborate existing parents
> R-PTY-01/06/07/08/10/11 (+ R-PTY-07a/08a/10a/11a) — the parents remain authoritative. Touches Phase 15
> and Phase 16 ONLY. The cross-phase frontmatter-metadata reconciliation (H5) is owned by a separate
> sweep agent and is NOT in scope here. New top-level IDs are namespaced `R-PTY-26..31` to avoid
> renumbering existing requirements.

### Phase 15 — pty-spike-and-compile-derisk (Cycle-2)

#### R-PTY-26 — Behavioral spawn-interception harness (supersedes grep-only for the spawn invariants) — closes H6
The no-`ANTHROPIC_API_KEY` / no-`-p` / no-`--input-format stream-json` / no-`--output-format stream-json`
/ official-`claude`-only invariants SHALL be enforced by a BEHAVIORAL spawn-interception test harness that
intercepts the ACTUAL spawn call (the `node-pty` spawn factory) at runtime and asserts on the real
`{ file, argv, env }` the runner passes — NOT only by static source grep. The harness SHALL be ESTABLISHED
in Phase 15 (the spike seeds it as a mockable, non-runtime-exported `ptySpawn` factory) and is REUSED by
Phases 16/17/19 (Codex runner, fallback). The static grep canary (R-PTY-01) is RETAINED as a cheap
secondary line of defense, not the primary one. A test SHALL assert: production runner spawns file
`claude` with empty Claude argv in PTY mode; the intercepted env has `ANTHROPIC_API_KEY` undefined; the
intercepted argv contains none of the forbidden tokens. *(Threat T-15-05 grep-evasion HIGH — a token
constructed at runtime, aliased, or read from config evades static grep but not argv interception.)*

#### R-PTY-27 — Orphaned-PTY teardown on disconnect / closure / shutdown — closes H7
The PTY child process SHALL be killed (no orphan host process) when its session is torn down, when the
owning client WS disconnects under the spike's connection-scoped lifecycle, AND when the supervisor
process shuts down. The spike SHALL wire `runner.kill()` to these lifecycle events and add a parent-PID
dead-man's-switch so a killed/crashed supervisor does not leave a detached `claude` + `pty` host process.
A test SHALL assert NO surviving child process after a simulated disconnect/teardown. (The
supervisor-OWNED persistence model — where a dropped client does NOT kill the PTY — is introduced in
Phase 16/R-PTY-07a; in Phase 16 the kill-on-teardown applies to session-close/idle-reap/supervisor-exit,
and the tmux-backed path defines an explicit detach-vs-kill policy: client disconnect DETACHES, session
close / idle-reap / supervisor-exit KILLS.) *(Threat T-15-06 / T-16-09 orphan-process leak MED —
zombie `claude` + `pty.exe` hold memory, file locks, and a live OAuth session.)*

### Phase 16 — hardened-pty-relay-and-mobile-terminal (Cycle-2)

#### R-PTY-28 — Server-inferred actor + human-only guard ON THE term.input RELAY path — closes H1
The human-only enforcement (constraint 3 / R-PTY-10) SHALL gate the raw-terminal `term.input`/attach
relay path itself, NOT only the structured `dispatch/pipeline.ts`. The actor SHALL be SERVER-INFERRED
from the connection identity (an authenticated `/ws/client` opaque-cookie connection ⇒ `human`; a
`/ws/agent` api_keys connection ⇒ `agent`), NEVER read from a client-asserted `source`/actor field. Any
`term.input` whose inferred actor is not a genuine human-interactive write SHALL be rejected BEFORE the
byte forward. Implementation routes `term.input` through the SAME `humanOnlyPtyGate` chokepoint (or a
shared guard helper) used by the dispatch pipeline — no second, ungated write route. A NAMED negative
test SHALL assert an automation/agent-originated `term.input` is rejected on the relay path, and that a
client-asserted `source: "human"` field cannot bypass the server-inferred decision. *(Threats T-16-10
relay-bypasses-human-guard HIGH; T-16-11 client-asserted-actor-spoof HIGH.)*

#### R-PTY-29 — Per-session write authorization on term.attach / term.input (no cross-session PTY hijack) — closes H2
Every inbound `term.input`/`term.attach`/`term.reattach` frame SHALL be authorized SERVER-SIDE against
the connection's OWN subscribed/owned session set: the target `session_id` MUST be in
`subscribedSessions` for that connection AND pass a DB-backed `canWriteTerminal(userId, sessionId)`
ownership check. A client-supplied `session_id` for a session the connection does not own/subscribe SHALL
be rejected — NO PTY hijack via a forged `session_id`. A NAMED negative test (`term-relay-auth.test.ts`)
SHALL include cross-session and cross-user hijack cases: user A cannot write to / attach to user B's PTY
session even with a valid session of their own. *(Threat T-16-12 cross-session/cross-user PTY hijack
HIGH — the most load-bearing security seam of the milestone.)*

#### R-PTY-30 — /ws/agent-side inventory authorization for term.* frames — closes H3
On the `/ws/agent` side, the hub SHALL DROP any `term.*` frame for a `session_id` that is NOT in that
supervisor connection's advertised `session_inventory`. A compromised or buggy supervisor SHALL NOT be
able to inject `term.data` for a session it does not host (cross-host injection). A NAMED negative test
SHALL assert a `term.data` from supervisor X for a session hosted by supervisor Y is dropped.
*(Threat T-16-13 cross-host term-frame injection HIGH.)*

#### R-PTY-31 — Persist per-session runner identity (runner_type + backend transcript path/id) for safe resume — closes H10
The per-session `runner_type` ('stream-json'|'pty-interactive') AND the backend PTY/tmux session
identity + backend transcript path/id captured AT PTY SPAWN SHALL be PERSISTED per session (idempotent
DDL, mirroring the existing pattern; NO backfill in schema.sql). On reconnect/supervisor-restart the
resume path SHALL READ the persisted runner mode + identity so a session can never be dual-spawned (two
PTYs for one session) nor mis-routed (stream-json resumed as PTY or vice-versa), and so Phase-20
`TranscriptSource` + R-PTY-29 ownership can key off real persisted data rather than a newest-file guess.
A test SHALL assert: a resume reads the persisted runner mode and re-binds the same backend identity (no
second spawn); a pty-interactive session persisted as such is NOT resumed via the stream-json path.
*(Threats T-16-14 dual-spawn-on-resume HIGH; T-16-15 runner-mode-misroute-on-restart HIGH.)*

**Cycle-2 (Phase 15/16) coverage:** 6 new IDs — R-PTY-26 (H6), R-PTY-27 (H7) in Phase 15;
R-PTY-28 (H1), R-PTY-29 (H2), R-PTY-30 (H3), R-PTY-31 (H10) in Phase 16. All elaborate existing parents
(R-PTY-01/06/07/08/10/11 + the -a addenda); the parents remain authoritative. H5 (frontmatter
reconciliation) intentionally excluded — owned by the H5 sweep agent.
