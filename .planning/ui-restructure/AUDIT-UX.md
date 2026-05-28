# UI Restructure Audit — Nav Reorg + Design System Drift

**Audit date:** 2026-05-28
**Branch audited:** `fix/coolify-webhook-unsigned` (working tree state)
**Auditor:** ArchitectUX (audit-only, no code edits)
**Target structure (ground truth):**
- Header: logo + 3 menu items (Home / Tasks / Settings) + theme toggle + quota + profile menu
- Home: tabs `List View | Grid View`
- Tasks: tabs `Upcoming | Activity | Schedule`
- Settings: tabs `Connections | Credentials | Prompts | Usage | Profile`

---

## 1. Current navigation map

Source of truth: `web/src/App.tsx` lines 22–65, `Layout.tsx` lines 297–402, `SettingsPage.tsx` lines 26–77, `Sidebar.tsx` lines 16–174.

| Hash route | Component | Nested tabs / sub-routes | Owns own header? |
|---|---|---|---|
| `#/` (chat) | `Layout` → `Sidebar` + `ChatPanel` | none (sidebar = sessions list) | yes — `Layout.tsx:219` |
| `#/grid` | `GridPage` | grid tabs (multichat layouts, NOT navigation) `GridPage.tsx:583` | yes — bespoke tab strip; no shared header |
| `#/grid/:tabId` | `GridPage` | same as above | yes |
| `#/settings` | `SettingsPage` | 6 vertical tabs: `supervisor`, `schedules`, `commands`, `profile`, `instructions`, `apikey` `SettingsPage.tsx:70-77` | yes — `SettingsPage.tsx:211` |
| `#/settings?tab=…` | `SettingsPage` | same | yes |
| `#/schedules` | redirected to `#/settings?tab=schedules` `App.tsx:54-57` | n/a | n/a |
| `#/supervisor` | redirected to `#/settings?tab=supervisor` `App.tsx:48-51` | n/a | n/a |
| `#/error-capture` | `ErrorCapturePage` | none (drawer for detail) | yes — `ErrorCapturePage.tsx:60` |
| `#/login` | `Login` page | none | yes (own chrome) |
| `#/auth/callback` | `AuthCallback` page | none | yes (own chrome) |
| `#/privacy`, `#/terms` | `Privacy`, `Terms` | none | yes (own chrome) |
| `#/dev/chat-surface`, `#/dev/mobile-accordion` | dev showcases | none | yes |

**Routes that DON'T appear in App.tsx but exist in components:** `RevanotePage.tsx` (`web/src/components/RevanotePage.tsx`) accepts `onBack` and renders a back-arrow header but is NOT wired into `App.tsx` route enum — it is dead-code-routed (orphan). Listed in the user-provided spec but not mountable today.

**Profile menu items** (`Layout.tsx:377-397`, duplicated in `AppChrome.tsx:280-300`):
- Chat → `#/`
- Grid → `#/grid`
- Schedules → `#/settings?tab=schedules`
- Errors → `#/error-capture`
- Profile → `#/settings?tab=profile`
- Settings → `#/settings`
- Manage account in Titanium (external)
- Logout

**Sidebar nav buttons** (`Sidebar.tsx:74-174`): Grid, Schedules, Error Capture, Settings, Supervisor — five separate first-class entry points, all of which the new design folds into Tasks/Settings.

**Existing tab consumers (TWO separate tab patterns):**
1. **Settings vertical tab nav** (`SettingsPage.tsx:253-268`) — desktop sticky vertical list, mobile `<select>` dropdown (`SettingsPage.tsx:227-246`). Style: `bg-indigo-600/20 ring-1 ring-indigo-500/30` active state.
2. **Grid tab bar** (`GridPage.tsx:582-676`) — horizontal scrollable, `role="tablist"`, chip style. Same active style as Settings but horizontal.

No shared tab primitive exists. Tasks page would be a THIRD tab implementation.

---

## 2. Header DRY violations

Severity legend: **HIGH** = blocks the restructure; **MED** = duplication that the restructure must collapse; **LOW** = cosmetic but should land in the same PR.

1. **HIGH — `AppChrome.tsx` is a dead-but-fully-implemented duplicate of `Layout.tsx`.**
   - `web/src/components/AppChrome.tsx` (306 lines) is not imported anywhere in `App.tsx`. It exports the exact `ProfileMenu` (lines 200–305) and license-dot helpers (lines 14–33) that `Layout.tsx` also defines (lines 18–37, 297–402). Two copies of the same menu drift independently.
   - Action: either adopt `AppChrome` as the single shared chrome for the new 3-route header, or delete it. Cannot leave both.

2. **HIGH — every non-chat route renders its own bespoke header with a back-arrow instead of consuming a shared chrome.**
   - `SettingsPage.tsx:211-222` — back-arrow + "Settings" title, no theme toggle, no quota, no profile menu.
   - `SchedulesPage.tsx:74-99` — back-arrow + "Schedules" title, no theme toggle, no quota, no profile menu.
   - `ErrorCapturePage.tsx:60` — back-arrow + title.
   - `SupervisorPage.tsx:597-600` — back-arrow + title (when not embedded).
   - `RevanotePage.tsx:111` — back-arrow + title.
   - `GridPage.tsx:582` — no back-arrow; renders tab bar directly. Inconsistent.
   - Net effect: theme toggle + quota + profile menu only render on `#/` (chat). The new spec requires them on every page → ALL five back-arrow headers must be removed and replaced by the shared `AppChrome` header.

3. **HIGH — `ProfileMenu` defined twice (Layout.tsx:297-402 + AppChrome.tsx:200-305).** Identical except for the `firstName` derivation. Any change to menu items (e.g. swap to Home/Tasks/Settings) must be made in both. Choose one home.

4. **MED — `licenseDotClass` + `licenseTextClass` helpers duplicated** (Layout.tsx:18-37, AppChrome.tsx:14-33). Lift to `web/src/lib/license.ts`.

5. **MED — `UsageStrip` (the "quota" chip) is only mounted in `Layout.tsx:274` and `AppChrome.tsx:184`.** It's wired correctly via `subscribe`, but currently only the chat route renders it because only chat uses `Layout`. New design needs it on every page → must move into shared chrome.

6. **MED — back-arrow icon SVG is inlined 5 times** (Settings, Schedules, ErrorCapture, Supervisor, Revanote). Should be an `<Icon name="back">` or just deleted once the shared chrome replaces the per-page headers.

7. **LOW — `Footer.tsx` is rendered at App.tsx:190 OUTSIDE the routed area** (good — keep this pattern). But there's no equivalent shared HEADER mount; instead each route reimplements one. Asymmetric.

8. **LOW — Login + AuthCallback + Privacy + Terms intentionally bypass `Layout`.** That's correct (no session, no nav). Confirm new chrome's auth-gate (App.tsx:135-142) still excludes these. No code change, but documented as intentional.

---

## 3. Design system drift

Reference: `~/.claude/design-preferences.md` (rule 15) + the canonical guide in `CLAUDE.md` "Frontend / CSS Conventions".

1. **MED — `rounded-2xl` on modals violates "rounded-xl cards/dialogs" rule.** Found in:
   - `ApiKeyModal.tsx:39` — `rounded-2xl shadow-2xl`
   - `ConnectModal.tsx:35` — `rounded-2xl shadow-2xl`
   - `ScheduleEditor.tsx:280` — `rounded-2xl shadow-2xl`
   All should be `rounded-xl` per design rules. Other modals are already correct (`CloneHereModal.tsx:102`, `CreateGithubRepoModal.tsx:123`, `ErrorSetupModal.tsx:71`, `ErrorProjectEditor.tsx:82` all use `rounded-xl`).

2. **MED — heavy `shadow-2xl` on modals violates "no drop shadows" rule.** Same files as #1 plus `ErrorDetailDrawer.tsx:74`, `ScheduleRunsDrawer.tsx:58`. Design says contrast IS the separation; downgrade to `shadow-xl` at most (and ideally just `ring-1`).

3. **LOW — `shadow-lg` on the "scroll to bottom" pill** (`ChatSurface.tsx:718`) — acceptable on a floating action element; keep but flag.

4. **PASS — no custom hex in component files.** All `#xxxxxx` matches are in `web/src/index.css:20-46` (the design-token definitions, which is correct).

5. **PASS — no `bg-gradient-*` anywhere.** Clean.

6. **PASS — accent color discipline is good.** `bg-indigo-600 hover:bg-indigo-500` is used uniformly for primary buttons (`SettingsPage.tsx:122`, `:184`; `GridPage.tsx:718`; etc.). Active tab states correctly use `bg-indigo-600/20 ring-1 ring-indigo-500/30` (`SettingsPage.tsx:260`, `GridPage.tsx:605`).

7. **PASS — card padding `p-5` and input/button `px-3 py-2` discipline is consistent** across `SettingsPage`, `ScheduleEditor`, `ErrorProjectEditor`, etc.

8. **LOW — `bg-[var(--bg-tertiary)]/40` vs `/50` inconsistency.** Hover state varies: `/40` in `Layout.tsx:185, 261`, `/50` in most other places. Pick one (`/40` per the global design rule "hover: bg-[var(--bg-tertiary)]/40").

9. **LOW — 1px solid borders used on header chrome** — design rule says "reserve borders for active state, modals, header separators." The five duplicate page headers (#2 above) all add `border-b border-[var(--border-color)]` which IS the allowed exception. After consolidation, only the shared chrome will carry it. Acceptable.

10. **LOW — `text-emerald-300` in `SettingsPage.tsx:169` for inline `<code>`** — should use `text-emerald-400` per "400 tint for solid icons" rule. Trivial.

---

## 4. Mobile parity gaps

1. **HIGH — current mobile nav relies on the Sidebar drawer + the in-Settings `<select>`.** New design requires a 3-item top nav on every page. Mobile must show Home/Tasks/Settings as either a top tab strip OR a hamburger that opens the same 3 items. Today, the sidebar drawer (`Layout.tsx:191-215`) mixes session list + nav buttons; under the new design, "Sessions" is content (lives inside Home → List View), not nav. The sidebar will lose its "Grid / Schedules / Error Capture / Settings / Supervisor" buttons entirely.

2. **MED — `SettingsPage.tsx:227-246` mobile `<select>` will need to be re-keyed** to the new 5 tabs (`connections | credentials | prompts | usage | profile`). Touch target is ≥44 px today (`py-2` + `text-sm` ≈ 38 px) — bump to `py-2.5` or `py-3` for the new build to clear WCAG.

3. **MED — Tasks page does not exist yet.** It needs a tab strip that works at narrow widths (Upcoming/Activity/Schedule). The Grid tab bar pattern (`GridPage.tsx:582-676`) is horizontal-scroll which is fine, but Settings uses a dropdown on mobile. Decide ONE mobile-tab pattern (recommend dropdown ≤ 3 tabs would feel heavy; horizontal chip strip is better at 3 items).

4. **MED — `Layout.tsx:224-242` mobile dropdown is the `SessionDropdown`** (a session-selector, not a route-selector). Under the new design, that dropdown belongs inside the Home → List View tab body, NOT in the global header. The header stays uniform across pages.

5. **LOW — `100dvh` is used correctly** (`App.tsx:145`). No `vh` regressions found.

6. **LOW — `Footer.tsx` renders on every route including mobile chat** — verify it doesn't eat keyboard-up space on iOS Safari after the restructure.

---

## 5. State management implications for the new nav

Hooks audited: `useAuth`, `useProfile`, `useSessions`, `useSchedules`, `useScheduleRuns`, `useApiKey`, `useLicense`, `useTheme`, `useChat`, `useWebSocket`, `useActivity`, `useCommands`, `useErrorProjects`, `useErrors`, `useErrorSetup`, `useBrowserNotifications`, `useSubscriptionUsage`, `useWebPushPermission`, `useChatSurface`, `usePendingLocalRepos`, `useRepoCreateJob`.

**No change required:**
- `useAuth`, `useProfile`, `useLicense`, `useTheme` — already route-agnostic, lift cleanly into shared chrome.
- `useWebSocket` — already mounted per-route via `SchedulesRoute` / `ErrorCaptureRoute` / `NotificationsBridge`. Under the new design, mount ONCE in shared chrome and pass `subscribe`/`send` down. Today's mount-per-route pattern is fine but redundant.
- `useSessions` — used by `Layout` (chat) and `AppChrome` (nav). Lifts into shared chrome; Home → List View consumes it.
- `useChat`, `useActivity` — chat-specific. Stay inside Home → List View body.

**Reorganize:**
- `useSchedules` + `useScheduleRuns` — currently bound to `#/schedules` (which now redirects to `#/settings?tab=schedules`). Under the new design they move to Tasks page (Upcoming + Activity + Schedule tabs all consume these). Pull them up to a `TasksPage` parent so all three tabs share one fetched list.
- `useApiKey` — currently inside `SettingsPage` "API Key" tab. Moves to Settings → Credentials.
- `useCommands` — currently inside `SettingsPage` "Commands" tab. Merges into Settings → Prompts (per spec).
- `useSubscriptionUsage` — used by `UsageStrip` (header chip) + `ClaudeUsageCard` (Settings). Under the new design, BOTH need it: header chip (`UsageStrip`) on every page AND Settings → Usage tab body. Already correctly memoized via `subscribe` — no change needed beyond ensuring single mount.
- `useErrorProjects` / `useErrors` / `useErrorSetup` — `ErrorCapturePage` is missing from the new spec entirely. **Open question for ProjectManager:** does Error Capture get folded into Tasks (Activity)? Or disappear from the nav and only surface via deep link from a Sentry-dispatched session message? Currently a top-level route with no home.

**Hash-routing assumptions to break:**
- `App.tsx:48-57` — legacy redirects from `#/supervisor` and `#/schedules` to `#/settings?tab=…`. With the new tab structure (Connections/Credentials/Prompts/Usage/Profile), the `?tab=supervisor` and `?tab=schedules` deep links need to remap:
  - `?tab=supervisor` → `#/settings?tab=connections`
  - `?tab=schedules` → `#/tasks?tab=schedule`
  - `?tab=commands` → `#/settings?tab=prompts`
  - `?tab=instructions` → `#/settings?tab=prompts`
  - `?tab=apikey` → `#/settings?tab=credentials`
  - `?tab=profile` → `#/settings?tab=profile` (unchanged)
- `Layout.tsx:167-169` (`handleShowConnect` → `#/settings?tab=supervisor`) — update target to `?tab=connections`.
- Sidebar nav buttons `Sidebar.tsx:74-174` — Grid/Schedules/ErrorCapture/Settings/Supervisor all change behaviour or disappear (see §4).

---

## 6. Cross-cutting DRY issues

### 6.1 Card patterns
`bg-[var(--bg-secondary)]/60 rounded-xl p-5` is the canonical settings card. Used uniformly in `SettingsPage.tsx:99, 159, 166`, `ScheduleEditor.tsx`, `ErrorProjectEditor.tsx`. **No `<Card>` primitive exists** — each card is hand-written. With 5 Settings tabs and 3 Tasks tabs each containing 2–6 cards, this is the right moment to extract `<SurfaceCard>` and `<SurfaceCardHeader>`. Saves ~40 LOC per tab.

### 6.2 Tab strip patterns (THREE different implementations)
1. Settings vertical (`SettingsPage.tsx:253-268`) — desktop sticky vertical nav.
2. Settings mobile (`SettingsPage.tsx:231-242`) — `<select>` dropdown.
3. Grid horizontal (`GridPage.tsx:582-676`) — full keyboard-nav `role="tablist"`, scroll-snap, rename support.

The new design needs a 4th — Tasks page (3 tabs) and possibly Home page (2 tabs). Extract a shared `<TabStrip>` primitive with two variants (`horizontal-chips` for top-of-page, `vertical-list` for sidebar). Match GridPage's keyboard nav (ARIA-correct, arrow keys, Home/End).

### 6.3 Modal patterns (consistent but unfactored)
Six modals: `ApiKeyModal`, `ConnectModal`, `ScheduleEditor`, `CloneHereModal`, `CreateGithubRepoModal`, `ErrorSetupModal`, `ErrorProjectEditor`. All re-implement `fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center` + Escape handler + outside-click close. **No `<Modal>` primitive.** Each modal also chooses its own radius (`rounded-xl` vs `rounded-2xl`) and shadow (`shadow-xl` vs `shadow-2xl`) — see §3.1 + §3.2. Worth extracting.

### 6.4 Drawer patterns (TWO copies)
`ErrorDetailDrawer.tsx:74` and `ScheduleRunsDrawer.tsx:58` are near-identical right-side drawers (`w-full max-w-xl bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] shadow-2xl overflow-y-auto`). Extract `<RightDrawer>`.

### 6.5 Form patterns
Input + label + helper-text pattern is consistent across `SettingsPage.tsx:103-117`, `ScheduleEditor`, `ErrorProjectEditor`. Already-uniform shape:
```
<label className="block text-xs text-[var(--text-muted)] mb-1.5">…</label>
<input className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm …" />
```
Worth a `<Field>` wrapper but lower priority than card/modal/drawer.

### 6.6 Toggle / switch pattern
`SettingsPage.tsx:130-154` (auto-nudge toggle) is hand-rolled. The "Prompts" tab needs the same shape. Extract `<Switch>` primitive.

### 6.7 Empty + loading states
Loading: `App.tsx:36-40` (LoadingScreen) is one pattern. Per-page loading is inline ("Loading..." text, no spinner). Empty: `SchedulesPage`, `ErrorCapturePage`, and `Sidebar` each render their own empty-state copy. No shared `<EmptyState>`. Low priority but worth a primitive.

### 6.8 Error display
Inline error text (`text-red-400` + small copy) appears in `SettingsPage AvatarUploader`, `ScheduleEditor`, `ApiKeyModal`. Consistent visually, no primitive. Acceptable for now.

---

## 7. Risks to the proposed restructure

1. **HIGH — Scheduled-task `{{run_url}}` template (`hub/src/scheduler/post-run/template.ts`, env `REMO_PUBLIC_URL`) embeds `#/schedules` or `#/settings?tab=schedules` in notification emails / GitHub issues / Telegram pushes.** Confirm exact format — if it points at the schedules route, moving Schedules to Tasks (`#/tasks?tab=schedule`) breaks every notification link that was sent before the cutover.
   - **Mitigation:** keep `#/settings?tab=schedules` AND `#/schedules` as a 302-equivalent redirect in `App.tsx:48-57` for ≥30 days; just remap them to the new `#/tasks?tab=schedule` instead of dropping.

2. **MED — Error Capture has no home in the new spec.** `web/src/components/ErrorCapturePage.tsx` and the entire `hub/src/error-capture/` module are first-class features. Either:
   - Add a 4th top-nav slot for Errors,
   - Fold Errors into Tasks → Activity (mixed feed of scheduled-task runs + error-dispatched runs),
   - Or accept that Errors becomes a "deep link only" page (reachable from email notifications, no top-nav entry).
   Confirm with user before implementation.

3. **MED — Revanote** (`RevanotePage.tsx`) is an orphan component (built, not routed). If the restructure is the moment to ship it, decide its home. Otherwise delete the file in the same PR.

4. **MED — Supervisor tab's "Connect" button (`Layout.tsx:167-169`, `Sidebar.tsx:174`) hardcodes `#/settings?tab=supervisor`.** Every such hardcoded hash needs an inventory pass before rename to `?tab=connections`. Grep candidates:
   - `Layout.tsx:168`
   - `Sidebar.tsx:174`
   - `App.tsx:49`
   - Any docs in `/docs/`, `/.planning/`, or hub-side templates.

5. **LOW — `App.tsx:121-123` mounts `AuthCallback` outside the chrome unconditionally.** Confirmed safe — magic-link callback runs without session. New chrome should respect the same `route === 'auth-callback'` early-return.

6. **LOW — `licenseRequired` banner (`App.tsx:147`) is positioned `fixed top-0 inset-x-0 z-[100]`.** Under the new chrome it overlaps the persistent 3-item header. Add top-offset (`top-[42px]` to match header height) or restyle as a header-internal inline banner.

7. **LOW — `getGridTabId()` (`App.tsx:67-71`) parses `#/grid/:tabId`.** Under the new Home page, Grid View is a tab; tab IDs would live at `#/?view=grid&tab=:tabId` (or similar). Don't break existing grid tab deep links — preserve `#/grid/:tabId` as a redirect to `#/?view=grid&tab=:tabId`.

8. **LOW — `localStorage` keys that survive the restructure:** `remo:sidebar-collapsed`, `remo:auto-nudge`, `grid:lastActiveCell:<tabId>`. None of these break — they're storage, not routes. List for thoroughness.

---

## Recommended ordering for the restructure phase

1. Extract primitives FIRST: `<SurfaceCard>`, `<TabStrip>` (horizontal + vertical variants), `<Modal>`, `<RightDrawer>`, `<Switch>`. ~1 day of work that pays back across every other step.
2. Adopt or delete `AppChrome.tsx`. Single shared chrome. (BLOCKER for the rest.)
3. Build new `<HomePage>` with `<TabStrip>` (List View | Grid View) — port `Layout`'s sidebar+chat into List View, port `GridPage` into Grid View.
4. Build new `<TasksPage>` (Upcoming | Activity | Schedule) — port `SchedulesPage` into Schedule tab; create Upcoming + Activity tabs from `useScheduleRuns`.
5. Rebuild `<SettingsPage>` with 5 new tabs — re-bucket existing cards from the 6 current tabs.
6. Wire hash redirects (legacy → new) in `App.tsx:43-65`.
7. Delete orphans: `RevanotePage.tsx` (if no home), inline `ProfileMenu` (if `AppChrome` won), back-arrow per-page headers, duplicate license helpers.
8. QC: confirm `{{run_url}}` template links still resolve; confirm mobile touch targets; confirm theme toggle + quota + profile menu render on EVERY page.

---

**End of audit.** No code changes were made.
