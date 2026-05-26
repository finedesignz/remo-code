<!-- updated: 2026-05-24 -->
# Requirements

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
