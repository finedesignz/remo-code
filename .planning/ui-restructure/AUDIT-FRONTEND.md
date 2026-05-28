# Frontend Audit — UI Restructure Prep

Scope: `web/src/` as of 2026-05-28, branch `fix/coolify-webhook-unsigned`.
Target nav: Header (Home / Tasks / Settings) + per-page tabs (Home: List/Grid; Tasks: Upcoming/Activity/Schedule; Settings: Connections/Credentials/Prompts/Usage/Profile).

Audit-only. No edits applied.

---

## 1. Component inventory

Usage count = number of other `web/src` files that `import` the module by basename. `0` = dead candidate. `lib/api` is a re-export hub (24) — that's expected.

### `web/src/components/` (46 files)

| File | Lines | Uses | Dead? | Notes / duplicate-of |
|------|------:|-----:|:-----:|----------------------|
| ActivityFeed.tsx | 92 | 1 | | Activity events panel. Used inside ChatPanel. |
| ApiKeyModal.tsx | 159 | 2 | | One of 7 modal implementations. Cf. ConnectModal / CloneHereModal / CreateGithubRepoModal / ErrorSetupModal / SessionPicker / ScheduleEditor. |
| **AppChrome.tsx** | 306 | **0** | **YES** | Dead. TS errors (lines 143/145/146 — calls props that no longer exist on `useSessions`). Was a shared-chrome attempt; superseded by inline header in `Layout.tsx`. **DELETE.** |
| ChatPanel.tsx | 63 | 1 | | Used by Layout. |
| ChatSurface.tsx | 877 | 4 | | Used by Layout, GridPage, MobileAccordion, Showcase. Mature, keep. |
| ChatSurfaceShowcase.tsx | 80 | 1 | | Dev-only route `#/dev/chat-surface`. Keep behind dev guard. |
| ClaudeUsageCard.tsx | 217 | 1 | | Used in SettingsPage Usage tab — fits new Settings → Usage tab. |
| **CloneHereModal.tsx** | 189 | **0** | **likely** | Not imported anywhere. Phase-08 staged file. Confirm wire-up plan or delete. |
| CommandsList.tsx | 114 | 1 | | Used in SettingsPage. Maps to Settings → Prompts (commands subset). |
| **ConnectModal.tsx** | 115 | **0** | **YES** | Not imported. Superseded by `SupervisorPage` connect flow. **DELETE.** |
| CreateGithubRepoModal.tsx | 281 | 1 | | Used by PendingLocalRepoPrompt (which is itself dead — see below). Verify before deleting. |
| CronBuilder.tsx | 491 | 1 | | Used in ScheduleEditor. Keep. |
| ErrorCapturePage.tsx | 253 | 1 | | Currently top-level route `#/error-capture`. Under new nav → Tasks → Activity (or Connections — surfaces only, do not decide here). |
| ErrorDetailDrawer.tsx | 188 | 1 | | Used by ErrorCapturePage. |
| ErrorProjectEditor.tsx | 218 | 1 | | Inline editor in ErrorCapturePage. |
| ErrorSetupModal.tsx | 249 | 1 | | One of 7 modals. |
| FileAttachmentBar.tsx | 56 | 1 | | Used in ChatSurface. |
| Footer.tsx | 21 | 1 | | Used by App.tsx wrapper. |
| GridPage.tsx | 842 | 1 | | Top-level. Under new nav → Home → Grid tab (route param). |
| **LaunchButton.tsx** | 133 | **0** | **YES** | Not imported. TS errors. Phase-08 staged. **DELETE** or wire. |
| Layout.tsx | 407 | 1 | | Chat-view container with own header (sidebar + top bar). Largest source of header chrome — must be split for new shared header. |
| MessageBubble.tsx | 93 | 1 | | Used in ChatSurface. |
| MobileAccordion.tsx | 80 | 2 | | Used in Grid mobile branch. |
| MobileAccordionRow.tsx | 146 | 1 | | Row primitive. |
| MobileAccordionShowcase.tsx | 54 | 1 | | Dev-only route. |
| **PendingLocalRepoPrompt.tsx** | 168 | **0** | **YES** | Not imported. TS errors. Phase-08 staged. **DELETE** or wire. |
| PermissionBlock.tsx | 66 | 1 | | Used in ChatSurface. |
| PostRunActionsEditor.tsx | 327 | 1 | | Used in ScheduleEditor. |
| QuestionBlock.tsx | 103 | 1 | | Used in ChatSurface. |
| **RevanotePage.tsx** | 191 | **0** | **likely** | Not routed in App.tsx. Phase-08 staged. Future home unclear — Settings → Connections (Revanote integration) is the natural slot. Surface only. |
| ScheduleEditor.tsx | 625 | 1 | | Used in SchedulesPage. |
| ScheduleRulesBuilder.tsx | 204 | 1 | | Used in ScheduleEditor. |
| ScheduleRunsDrawer.tsx | 306 | 1 | | Used in SchedulesPage. |
| SchedulesPage.tsx | 481 | 4 | | Currently inside SettingsPage tab. Under new nav → Tasks → Schedule tab. Has its own filter/tab strip. |
| SessionDropdown.tsx | 140 | 6 | | Used in Layout, AppChrome (dead), GridPage, others. Keep. |
| SessionPicker.tsx | 153 | 1 | | One of 7 modals (full-screen picker). |
| SessionTooltip.tsx | 53 | 2 | | Util. |
| **SettingsPage.tsx** | **1242** | 1 | | **God-component.** Owns tabs (profile/supervisor/apikey/commands/instructions/schedules) + Schedules embed + inline forms. Will fragment into 5 new Settings tabs. |
| SetupForm.tsx | 124 | 1 | | First-run wizard. Bypasses Layout — correct. |
| Sidebar.tsx | 286 | 2 | | Used in Layout + dead AppChrome. Only Home → List View needs it under new nav. |
| SupervisorPage.tsx | 833 | 1 | | Connection management. Maps to Settings → Connections. |
| ThinkingBlock.tsx | 46 | 1 | | ChatSurface child. |
| ToolUseBlock.tsx | 77 | 1 | | ChatSurface child. |
| UnreadBadge.tsx | 13 | 2 | | Tiny primitive. |
| UpcomingRunsPanel.tsx | 109 | 1 | | Maps to Tasks → Upcoming tab. |
| UsageStrip.tsx | 115 | 2 | | Header chrome (quota strip). Both Layout + dead AppChrome consume it. Move to new shared Header. |

### `web/src/pages/` (separate dir)
- `Login.tsx`, `AuthCallback.tsx`, `Privacy.tsx`, `Terms.tsx` — all bypass Layout. Correct (no auth context). Confirmed by App.tsx routing.

### `web/src/hooks/` (20 files)

| File | Lines | Uses | Notes |
|------|------:|-----:|-------|
| useActivity.ts | 155 | 7 | Multi-consumer. Keep. |
| useApiKey.ts | 48 | 2 | Used in Settings → Credentials. |
| useAuth.ts | 68 | 1 | Top-level App.tsx only. |
| useBrowserNotifications.ts | 51 | 1 | App.tsx. |
| useChat.ts | 249 | 7 | Multi-consumer. |
| useChatSurface.ts | 284 | 1 | ChatSurface only. |
| useCommands.ts | 90 | 2 | Settings + CommandsList. |
| useErrorProjects.ts | 106 | 3 | Error capture. |
| useErrors.ts | 199 | 1 | Error capture. |
| useErrorSetup.ts | 82 | 1 | Error capture. |
| useLicense.ts | 46 | 2 | Header license badge. |
| usePendingLocalRepos.ts | 116 | 1 | Phase-08, only consumed by dead PendingLocalRepoPrompt. **Dead until wired.** |
| useProfile.ts | 55 | 3 | Profile data. |
| useRepoCreateJob.ts | 123 | 1 | Phase-08, only consumed by dead CreateGithubRepoModal chain. **Dead until wired.** |
| useScheduleRuns.ts | 161 | 1 | ScheduleRunsDrawer. |
| useSchedules.ts | 172 | 7 | Multi-consumer. |
| useSessions.ts | 80 | 17 | Most-used hook. Single source of truth. |
| useSubscriptionUsage.ts | 41 | 1 | UsageStrip. |
| useTheme.ts | 26 | 2 | Layout + dead AppChrome. |
| useWebPushPermission.ts | 35 | 1 | Settings. |
| useWebSocket.ts | 314 | 7 | Multi-consumer. |

### `web/src/lib/` (13 files)

| File | Lines | Uses | Notes |
|------|------:|-----:|-------|
| api.ts | 157 | 24 | Hub-fetch wrapper. Heart of data layer. |
| auth.ts | 127 | 5 | |
| chat-tabs-api.ts | 133 | 2 | Grid tabs. |
| cron-humanize.ts | 83 | 2 | |
| cron.ts | 104 | 3 | |
| format.ts | 24 | 2 | Small util. |
| lastUserMsg.ts | 32 | 3 | |
| raf-batch.ts | 76 | 1 | ChatSurface streaming. |
| **revanote-message.ts** | 27 | **0** | Dead until RevanotePage is wired. |
| schedule-rules.ts | 87 | 2 | |
| scheduled-message.ts | 5 | 1 | Trivial. |
| task-name.ts | 116 | 1 | Auto-name util. |
| task-templates.ts | 246 | 1 | |

---

## 2. DRY consolidation candidates

| Pattern | Current implementations | Files | Proposed primitive | Effort |
|---------|------------------------|-------|--------------------|:------:|
| **Card surface** (`bg-[var(--bg-secondary)] rounded-xl p-5`) | ~30 inline instances across 13 files | SettingsPage (10), SchedulesPage (3), SupervisorPage (3), CommandsList (2), RevanotePage (2), ChatSurface, ClaudeUsageCard, ErrorProjectEditor, SessionDropdown, SessionPicker, UpcomingRunsPanel, AuthCallback, Login | `<Card>` + `<CardHeader>` + `<CardBody>` primitive | **S** |
| **Modal frame** (`fixed inset-0` backdrop + dialog container) | 10 files have backdrop; only 4 set `role="dialog"` | ApiKeyModal, CloneHereModal, ConnectModal (dead), CreateGithubRepoModal, ErrorSetupModal, SessionPicker, ScheduleEditor, SupervisorPage (inline confirm), Layout/AppChrome (overlay variants) | ONE `<Modal title bodyFooter onClose>` primitive with `role="dialog"` + `aria-modal="true"` + focus-trap + escape-to-close + backdrop-click. Each existing modal becomes ~100 lines lighter. | **M** |
| **Tab strip** (horizontal nav with active state) | Inline in SettingsPage (custom `setTab` state + URL hash sync) and GridPage (only file with `role="tab"`). SchedulesPage has filter chips, not full tabs. | SettingsPage, GridPage | ONE `<Tabs items activeId onChange syncHash="tab">` with built-in URL-hash binding + a11y `role="tablist"`/`role="tab"`. New Home/Tasks/Settings each need this. | **S** |
| **Status pill** (color-coded chip — emerald/amber/red) | Repeated ad-hoc: 10 files use emerald, 11 use amber, 21 use red. No shared component. | SettingsPage, SupervisorPage, ChatSurface, Layout, GridPage, SchedulesPage, ErrorCapturePage, ToolUseBlock, ApiKeyModal, PermissionBlock, ClaudeUsageCard, ScheduleRunsDrawer, MessageBubble, FileAttachmentBar, CronBuilder, CommandsList, AuthCallback, Login, Sidebar, AppChrome (dead) | `<StatusPill tone="good"|"warn"|"error"|"neutral"|"info">` with strict tone enum. Eliminates the inconsistency where "active" is sometimes emerald dot, sometimes emerald text, sometimes emerald-400/20 bg+ring. | **S** |
| **Empty state** (icon + heading + sub + optional CTA) | 9 files emit "No X yet" inline | ChatSurface, ScheduleRunsDrawer, SchedulesPage, CommandsList, ErrorDetailDrawer, MobileAccordion, SessionPicker, SupervisorPage | `<EmptyState icon title description action?>` | **S** |
| **Loading state** | 15 files have inline `>Loading<` text; 3 use `animate-spin` SVG; mixed | App.tsx (LoadingScreen), SettingsPage (3), CommandsList, ClaudeUsageCard, ErrorDetailDrawer, etc. | `<LoadingState variant="page"|"inline"|"button">` + `<Skeleton w h>` for list placeholders | **S** |
| **Form field** (label + input + helper + error) | 5 files emit label-input pairs inline. ~17 repeats in SettingsPage alone. | SettingsPage (8), ErrorProjectEditor (5), SupervisorPage (2), ErrorSetupModal, ScheduleEditor | `<Field label helper error><Input/></Field>` + matching `<Textarea>`, `<Select>`, `<Toggle>` | **M** |
| **Primary button** (`bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-2 rounded-lg`) | 32 files repeat this class string (~80 occurrences) | All over | `<Button intent="primary"|"secondary"|"ghost"|"danger" size="sm"|"md"> with disabled state, loading spinner slot | **S** |
| **Drawer** (slide-in panel from right) | ScheduleRunsDrawer, ErrorDetailDrawer, GridPage layout picker | 3 files | `<Drawer side="right" open onClose width>` | **S** |
| **Header chrome** (logo + nav + theme + quota + profile) | Owned by Layout.tsx inline + dead AppChrome.tsx. Pages without it (Settings, Schedules, ErrorCapture, Grid) have no shared header today; AppChrome was intended to bring this but never wired. | Layout (live), AppChrome (dead) | ONE `<AppHeader>` (logo + nav links + theme toggle + UsageStrip + ProfileMenu + license badge). Mounted by a thin `<AppShell>` wrapper around every authenticated route. | **M** |
| **Avatar / ProfileMenu** | Currently inline in Layout AND inline in AppChrome (`ProfileMenu` defined twice — once in each as a local function!) | Layout.tsx, AppChrome.tsx | Extract `<ProfileMenu user signOut onNavigate token>` to its own file | **S** |

---

## 3. Hook reorganization map under new nav

No renames required for the data layer — current hooks already align cleanly. Movement is **mounting location**, not signature.

| Hook | Today | Under new nav |
|------|-------|---------------|
| useAuth, useProfile, useLicense, useTheme | App.tsx + Layout | App shell (mount once at root, pass via context or keep prop-drilled — recommend context for these four to stop the drilling chain). |
| useWebSocket, useSessions | Layout + GridPage + Sidebar | Home + Tasks + Grid all need session list. Promote to a `SessionsContext` mounted at AppShell so Home/Tasks/Settings/Grid share one subscription. |
| useChat, useActivity, useChatSurface | ChatSurface | Stay local — per-cell instances. |
| useSchedules, useScheduleRuns | SettingsPage→Schedules embed | Tasks → Schedule tab + Tasks → Upcoming tab + Tasks → Activity tab all read from `useSchedules`. Mount at Tasks page root, share across its three tabs. |
| useErrorProjects, useErrors, useErrorSetup | ErrorCapturePage | If errors live under Tasks → Activity → reuse there. If under Settings → Connections → mount once there. |
| useApiKey, useCommands, useWebPushPermission | SettingsPage | Stay scoped to Settings tab subtrees. |
| useSubscriptionUsage | UsageStrip | Stays inside header. |
| usePendingLocalRepos, useRepoCreateJob | (dead — only consumed by un-wired Phase-08 components) | Decide: wire as part of Settings → Connections (Supervisor pending repos), or delete with their consumers. |

**Splits / combines to consider:**
- `useChatSurface` is 284 lines — leave as-is, it's tightly scoped.
- `useWebSocket` (314 lines) does both connection management AND event subscription. Splitting would help testability but not required for nav restructure. Defer.

---

## 4. Routing changes needed for new nav

Today (from `App.tsx`):
- HashRouter. `getRoute()` matches `#/`, `#/login`, `#/auth/callback`, `#/settings`, `#/schedules` (legacy → settings?tab=schedules), `#/error-capture`, `#/grid`, `#/grid/:tabId`, `#/privacy`, `#/terms`, `#/dev/chat-surface`, `#/dev/mobile-accordion`.
- Tab param: SettingsPage reads `?tab=<id>` via `readTabFromHash()`. GridPage embeds `:tabId` in path segment. No other page deep-links a tab.

Required for new nav:
1. **Three top-level routes:** `#/home`, `#/tasks`, `#/settings`. Keep `#/grid` and `#/grid/:tabId` (Home → Grid tab can deep-link to them) or fold under `#/home?tab=grid`. Recommend the latter for uniformity.
2. **Per-page tab param** standardized as `?tab=<id>`:
   - `#/home?tab=list` (default) | `?tab=grid`
   - `#/tasks?tab=upcoming` (default) | `?tab=activity` | `?tab=schedule`
   - `#/settings?tab=connections` (default) | `?tab=credentials` | `?tab=prompts` | `?tab=usage` | `?tab=profile`
3. **Legacy redirects** (additive in `getRoute()`):
   - `#/` → `#/home` (or keep `#/` as alias for home)
   - `#/schedules` → `#/tasks?tab=schedule`
   - `#/error-capture` → `#/tasks?tab=activity` (or wherever errors land — surfacing only)
   - `#/settings?tab=supervisor` → `#/settings?tab=connections`
   - `#/settings?tab=apikey` → `#/settings?tab=credentials`
   - `#/settings?tab=commands|instructions` → `#/settings?tab=prompts`
   - `#/settings?tab=schedules` → `#/tasks?tab=schedule`
   - `#/settings?tab=account|profile` → `#/settings?tab=profile`
4. **Tab-param helper** extracted to `lib/route.ts` (one parser shared by Home/Tasks/Settings). Today SettingsPage re-implements it inline; same will be needed in two more places.
5. Pages outside the shell — Login, AuthCallback, SetupForm, Privacy, Terms — remain bypass-Layout. Confirmed correct.

---

## 5. Files to DELETE (dead code)

| File | Reason |
|------|--------|
| `web/src/components/AppChrome.tsx` (306 lines) | 0 imports. TS errors. Superseded design. |
| `web/src/components/ConnectModal.tsx` (115 lines) | 0 imports. Superseded by SupervisorPage flow. |
| `web/src/components/LaunchButton.tsx` (133 lines) | 0 imports. TS errors. Phase-08 unwired. |
| `web/src/components/PendingLocalRepoPrompt.tsx` (168 lines) | 0 imports. TS errors. Phase-08 unwired. |
| `web/src/hooks/usePendingLocalRepos.ts` (116 lines) | Only consumed by dead PendingLocalRepoPrompt. |

**Conditional delete (Phase-08 batch — decide before nav work):**

| File | Reason |
|------|--------|
| `web/src/components/CloneHereModal.tsx` (189) | 0 imports. Wire to Settings → Connections OR delete. |
| `web/src/components/CreateGithubRepoModal.tsx` (281) | Only consumed by dead PendingLocalRepoPrompt. |
| `web/src/components/RevanotePage.tsx` (191) | 0 imports. Wire to Settings → Connections OR delete. |
| `web/src/hooks/useRepoCreateJob.ts` (123) | Same chain. |
| `web/src/lib/revanote-message.ts` (27) | Only consumed by RevanotePage. |

Total guaranteed-dead removal: **6 files, 1,037 lines**. Plus eliminates all 7 TS errors.

---

## 6. Files to CONSOLIDATE

| Target | Rationale |
|--------|-----------|
| `Layout.tsx` (407L) → split into `<AppShell>` + chat-specific `<ChatLayout>` | The header in Layout is the only header in the app; promote it to a shell that wraps all authed routes. `ChatLayout` keeps Sidebar + ChatPanel inside the shell. |
| `SettingsPage.tsx` (1242L) → 5 tab modules + a thin SettingsPage container | God-component. New nav demands a fresh tab split anyway. Each new tab becomes a ~200-line file. |
| `SchedulesPage.tsx` (481L) → Tasks-page tab module + reusable schedule-table component | Becomes one of three Tasks tabs. |
| `UpcomingRunsPanel.tsx` (109L) + `ScheduleRunsDrawer.tsx` (306L) | Both already exist — Tasks → Upcoming + Tasks → Activity tabs reuse them with no API changes. Just remount. |
| `SupervisorPage.tsx` (833L) | Already a self-contained page. Becomes Settings → Connections. Internal sections (`Repos`, `Hosts`, `PendingRepos`) could become 3 sibling components for readability — defer until needed. |
| `ApiKeyModal` + 6 other modals → ONE `<Modal>` primitive | See §2. |
| All ~30 card surfaces → `<Card>` | See §2. |
| All ~80 indigo-600 buttons → `<Button>` | See §2. |

---

## 7. Files to KEEP AS-IS

- `ChatSurface.tsx` (877L) — mature, virtualization-heavy, well-isolated.
- `GridPage.tsx` (842L) — already its own page. Becomes Home → Grid tab body.
- All `MobileAccordion*` — unchanged behavior.
- All `ChatSurface*` block components (Thinking, ToolUse, Question, Permission, MessageBubble, FileAttachmentBar) — internal to ChatSurface.
- All hooks except the two Phase-08 dead ones.
- All `lib/*` except `revanote-message.ts`.
- `pages/Login.tsx`, `pages/AuthCallback.tsx`, `pages/Privacy.tsx`, `pages/Terms.tsx`, `components/SetupForm.tsx` — bypass-Layout pages, correct as-is.
- `CronBuilder.tsx`, `ScheduleEditor.tsx`, `ScheduleRulesBuilder.tsx`, `PostRunActionsEditor.tsx` — schedule sub-editors; transplant whole to Tasks → Schedule tab.

---

## 8. Build status

**TypeScript:** `cd web && bunx tsc --noEmit` → **7 errors, all in 3 dead files:**

```
AppChrome.tsx:143  token prop missing on Sidebar
AppChrome.tsx:145  useSessions has no launchSession (it does — type drift from prop spread)
AppChrome.tsx:146  useSessions has no cloneHere    (same — stale type read)
LaunchButton.tsx:32   CodeSession.local_paths missing
LaunchButton.tsx:38   implicit any
LaunchButton.tsx:81   implicit any
PendingLocalRepoPrompt.tsx:39  useSessions.createGithubRepo missing
```

**All 7 vanish by deleting the 3 dead files (§5).** Build (`bun run build`) not yet run — gated on TS being clean. Re-run after the §5 deletions.

---

## 9. Estimated effort per consolidation

| Item | Effort | Reasoning |
|------|:------:|-----------|
| Delete §5 guaranteed-dead files | **S** | 6 files, zero refs to update. |
| Decide + handle §5 Phase-08 conditional files | **S** | Either delete-with-chain or wire — both small. |
| `<Card>` primitive | **S** | ~50 LOC component + ~30 callsite rewrites (sed-friendly). |
| `<Modal>` primitive + migrate 7 modals | **M** | Each modal already has unique body — but extracting frame/focus-trap/escape handling is ~150 LOC primitive + 7 ~100-line diffs. |
| `<Tabs>` primitive + URL-hash binding | **S** | ~80 LOC. SettingsPage already has the logic; lift it. |
| `<StatusPill>` + sweep all status text | **S** | ~30 LOC; ~50 callsite swaps. |
| `<EmptyState>` | **S** | ~40 LOC; 9 callsite swaps. |
| `<LoadingState>` + `<Skeleton>` | **S** | ~60 LOC. |
| `<Field>` + `<Input>` + `<Textarea>` + `<Select>` + `<Toggle>` | **M** | ~250 LOC across primitives; ~30 form rewrites. |
| `<Button>` primitive | **S** | ~60 LOC; tedious sweep but mechanical. |
| `<Drawer>` | **S** | ~100 LOC; 3 rewrites. |
| `<AppHeader>` + `<AppShell>` + extract `ProfileMenu` | **M** | The structural pivot. Touches App.tsx + Layout.tsx + every new top-level page. |
| Route param helper + redirects | **S** | ~50 LOC in lib/route.ts + App.tsx. |
| Split SettingsPage into 5 tab modules | **L** | 1242 LOC → 5×~200 LOC. Mechanical but high-volume; do AFTER primitives land so each split lands cleaner. |
| Split Layout.tsx into AppShell + ChatLayout | **M** | Header extraction is the bulk. |

**Suggested ordering:**
1. Delete dead files (eliminates TS errors, shrinks surface).
2. Land primitives: Card, Modal, Tabs, StatusPill, EmptyState, LoadingState, Button, Drawer, Field.
3. Extract AppShell + AppHeader; route through it for every authed page.
4. Add new routes + redirects.
5. Split SettingsPage; remount SchedulesPage / UpcomingRunsPanel / ErrorCapturePage / SupervisorPage under new tabs.
6. Sweep ad-hoc Tailwind class strings → primitive components.

---

## Notable footguns surfaced

- **`ProfileMenu` is defined twice** (inline local function in both `Layout.tsx` and `AppChrome.tsx`). When extracting the shared header, dedupe to one file.
- **`licenseDotClass` / `licenseTextClass` helpers are also duplicated** in Layout.tsx and AppChrome.tsx. Move to `lib/license-ui.ts`.
- **`useSessions` return shape drift** is the root cause of the AppChrome/LaunchButton/PendingLocalRepoPrompt TS errors — `launchSession`, `cloneHere`, `createGithubRepo` are not exposed by the current hook. If Phase-08 components are kept, they need a hook surface update, not just compile-fixes.
- **`SettingsPage` already has a homemade hash-tab parser + sync** (`readTabFromHash` + `useEffect` on `tab` + `hashchange` listener). Use it as the reference implementation when building the shared `<Tabs syncHash>` primitive.
- **No `inputClass` regex hits** — there's no consistent input styling because forms inline classes ad-hoc. The new `<Field>`/`<Input>` primitive will be the FIRST consistent input treatment.
