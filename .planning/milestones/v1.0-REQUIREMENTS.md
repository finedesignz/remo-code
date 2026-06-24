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
