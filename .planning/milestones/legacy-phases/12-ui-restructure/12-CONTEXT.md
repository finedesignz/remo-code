# Phase 12 — UI Restructure + DRY Pass

> **⚠️ SUPERSEDED (2026-05-30, milestone v-settings-overhaul).** The Settings structure
> below is historical. The **Orchestrator** and **Prompts** tabs have since been **removed**
> (orchestrator is now a pinned top row in the Connections table; Prompts handled locally).
> Current Settings tabs = **Connections · Credentials · Usage · Profile**, app accent =
> **blue** (not indigo). For the authoritative Settings/Connections/Grid structure, see
> `.planning/phases/settings-connections-overhaul/PLAN.md` + `.planning/codebase/STRUCTURE.md`.

**Branch:** `feat/ui-restructure-and-dry-pass` (worktree: `C:/Users/artic/GitHub/remo-code-ui-restructure`, off `origin/main` @ `5d4c9a9`)
**Date:** 2026-05-28
**Inputs:** `.planning/ui-restructure/AUDIT-UX.md`, `AUDIT-FRONTEND.md`, `AUDIT-BACKEND.md`
**Goal:** Restructure top-level nav to Home / Tasks / Settings, ship 10 shared primitives, fragment the 1242-LOC SettingsPage, purge ~1037 LOC of dead Phase-08 files, add the backend deltas the new pages consume, preserve every existing deep link via redirects.

---

## 1. Locked nav decisions (from user spec — ground truth)

### Header (every authed page, no breadcrumbs)
- Logo
- Home link
- Tasks link
- Settings link
- Theme toggle
- Quota chip (`UsageStrip`)
- Profile menu (avatar → license badge → manage account → logout)

Mounted ONCE by `<AppShell>`. Login / AuthCallback / Privacy / Terms / SetupForm bypass the shell.

### Home page (`#/home`, default `#/`)
Tabs: `List View` (default) | `Grid View`.
- **List View** = current Layout's Sidebar + ChatPanel (sessions list left, active chat right).
- **Grid View** = current GridPage *minus* its own header — only the layout picker + tab strip + cells. Refresh button placed next to the "+" button on the per-cell controls per user spec.

### Tasks page (`#/tasks`)
Tabs: `Upcoming` (default) | `Activity` | `Schedule`.
- **Upcoming** — list of `scheduled_tasks` with `next_fire_at` in the next 24h, sorted ascending.
- **Activity** — paginated runs across ALL tasks (status chips, cost, duration, dispatched session).
- **Schedule** — CRUD list of `scheduled_tasks` grouped by repo (`sessions.project_dir` derived; `supervisor` and `all_sessions` targets group under "All sessions" / `<hostname>`).

### Settings page (`#/settings`)
Tabs: `Connections` (default) | `Credentials` | `Prompts` | `Usage` | `Profile`.
- **Connections** — supervisor list (per-host status, version, last-seen) + **root repo folder path field** (PATCH supervisor roots) + pending-local-repo list (wires the orphan Phase-08 `usePendingLocalRepos`).
- **Credentials** — API keys (CRUD) + Coolify webhook card + Revanote webhook card + GitHub OAuth status.
- **Prompts** — auto-nudge switch (server-persisted) + commands & skills picker (from supervisor sync) + instruction blobs editor (existing `PUT /api/instructions`).
- **Usage** — thresholds (session % + week %), daily cost cap, today/7d/30d cost rollup, Claude window snapshot.
- **Profile** — display name, email, avatar, timezone, web-push toggle, manage-account link, logout.

---

## 2. Component primitives to extract (10)

All under `web/src/components/ui/` (new dir). Each gets its own file + a focused test where behavior is non-trivial.

| Primitive | File | Responsibilities | Replaces |
|---|---|---|---|
| `Card` | `ui/Card.tsx` | `bg-[var(--bg-secondary)]/60 rounded-xl p-5` + optional `<CardHeader>` | ~30 hand-written cards |
| `Modal` | `ui/Modal.tsx` | `role="dialog"` + `aria-modal` + focus-trap + escape-to-close + backdrop click + `rounded-xl shadow-xl` (NO `shadow-2xl`) | 7 modal frames |
| `Tabs` | `ui/Tabs.tsx` | `role="tablist"`/`role="tab"`, arrow-key nav (Home/End/Left/Right), URL-hash sync via `syncHash="tab"`, horizontal-chip + vertical-list variants | SettingsPage vertical, SettingsPage mobile `<select>`, GridPage horizontal |
| `Button` | `ui/Button.tsx` | `intent="primary" \| "secondary" \| "ghost" \| "danger"`, `size="sm" \| "md"`, loading slot, disabled | ~80 inline indigo-600 buttons |
| `Field` | `ui/Field.tsx` | label + helper + error + `<Input>` / `<Textarea>` / `<Select>` / `<Toggle>` | ~17 inline label-input pairs |
| `StatusPill` | `ui/StatusPill.tsx` | `tone="good" \| "warn" \| "error" \| "neutral" \| "info"` — strict enum | ~42 ad-hoc emerald/amber/red status chips |
| `EmptyState` | `ui/EmptyState.tsx` | icon + title + description + optional CTA | 9 inline "No X yet" copies |
| `LoadingState` | `ui/LoadingState.tsx` | `variant="page" \| "inline" \| "button"` + sibling `<Skeleton>` | 15+ inline "Loading…" |
| `Drawer` | `ui/Drawer.tsx` | right-side panel + escape + backdrop + `ring-1` (no `shadow-2xl`) | ErrorDetailDrawer, ScheduleRunsDrawer, GridPage picker |
| `AppShell` + `AppHeader` | `ui/AppShell.tsx`, `ui/AppHeader.tsx` | shared chrome: header + footer + license banner offset + auth gating wrapper. Also extracts `ProfileMenu` to `ui/ProfileMenu.tsx` and license helpers to `lib/license-ui.ts` | Layout.tsx inline header + dead AppChrome.tsx |

**Design discipline (per `~/.claude/design-preferences.md` and CLAUDE.md):**
- `rounded-xl` for cards/dialogs, `rounded-lg` for inputs/buttons/list items, `rounded` for chips. NEVER `rounded-2xl` or higher.
- `shadow-xl` max (on the SHELL or floating actions only) — NO `shadow-2xl`, no drop shadows on plain cards.
- Hover: `hover:bg-[var(--bg-tertiary)]/40` — pick ONE level (40), eliminate `/50` drift.
- Accent: `bg-indigo-600 hover:bg-indigo-500` for primary; `bg-indigo-600/20 ring-1 ring-indigo-500/30` for active tab.
- Status: `emerald`/`amber`/`red`/`gray` 400 tint for solid; `/20 + ring` for soft bg. No custom hex outside `index.css`.

---

## 3. Files to DELETE (purge, ~1037 LOC)

Guaranteed dead — 0 imports, TS errors. Delete in wave 1 before primitives so TS is clean during refactor:

| File | LOC | Reason |
|---|---:|---|
| `web/src/components/AppChrome.tsx` | 306 | 0 imports; TS errors line 143/145/146; duplicate of Layout header |
| `web/src/components/ConnectModal.tsx` | 115 | 0 imports; superseded by SupervisorPage flow |
| `web/src/components/LaunchButton.tsx` | 133 | 0 imports; TS errors |
| `web/src/components/PendingLocalRepoPrompt.tsx` | 168 | 0 imports; TS error |
| `web/src/hooks/usePendingLocalRepos.ts` | 116 | Only consumed by dead PendingLocalRepoPrompt |
| `web/src/components/CloneHereModal.tsx` | 189 | 0 imports; Phase-08 unwired |

**Decision:** RevanotePage / CreateGithubRepoModal / useRepoCreateJob / revanote-message.ts are NOT deleted this phase — Revanote wiring lives in Settings → Connections (per user spec). They get adopted in wave 4 (route them into Connections; replace homemade frame with `<Modal>` primitive).

**Net:** 6 files / 1037 LOC removed, eliminating all 7 web TS errors. `usePendingLocalRepos` regretfully gone — Phase-08 pending-repo UX gets a fresh wire-up via Connections tab in wave 4 using existing `pending_local_repos` DAL.

---

## 4. SettingsPage god-component fragmentation

`web/src/components/SettingsPage.tsx` (1242 LOC) explodes into:

- `web/src/components/settings/SettingsPage.tsx` (~80 LOC) — thin container that mounts `<AppShell>` + `<Tabs>` and routes to one of 5 tab modules.
- `web/src/components/settings/ConnectionsTab.tsx` — port of `SupervisorPage.tsx` (833 LOC retained as-is, just rendered inside the tab) + new `<RootsField>` (PATCH `/api/supervisors/:id/roots`) + pending-repo list. **No SupervisorPage rewrite this phase.**
- `web/src/components/settings/CredentialsTab.tsx` — `ApiKeyModal` + Coolify card + Revanote card + GitHub card. Uses `<Card>` + `<Modal>` primitives.
- `web/src/components/settings/PromptsTab.tsx` — auto-nudge `<Toggle>` + `CommandsList` + instruction blob editors (move existing inputs from old `instructions` tab).
- `web/src/components/settings/UsageTab.tsx` — `ClaudeUsageCard` + new cost-rollup section (consumes `GET /api/usage/summary`) + threshold sliders.
- `web/src/components/settings/ProfileTab.tsx` — existing profile section (display name, avatar, timezone, web push, logout).

---

## 5. Top-level page additions

- `web/src/components/HomePage.tsx` — `<AppShell>` + `<Tabs items=[list,grid]>`. Bodies: `<ChatLayout>` (extracted from `Layout.tsx`) + `<GridView>` (extracted body of `GridPage.tsx`, header stripped).
- `web/src/components/TasksPage.tsx` — `<AppShell>` + `<Tabs items=[upcoming,activity,schedule]>`. Bodies: `UpcomingRunsPanel` (existing), new `ActivityFeed` consumer of `/api/tasks/activity`, `SchedulesPage` (existing 481 LOC, body only — header stripped) grouped by repo.
- `web/src/components/SettingsPage.tsx` — replaced by container in §4.

`Layout.tsx` is split into `ChatLayout.tsx` (sidebar + chat panel, no header) + the chrome bits absorbed into `AppShell`/`AppHeader`.

---

## 6. Backend deltas

### 6.1 Schema migrations (additive only, idempotent)

```sql
-- Supervisor persistence + roots (replaces in-memory supervisor-registry for DB-backed source of truth)
CREATE TABLE IF NOT EXISTS supervisors (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id   TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  hostname     TEXT,
  roots        TEXT[] NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  version      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supervisors_user ON supervisors(user_id);

-- User UI preferences as JSON blob (avoid one-column-per-toggle churn)
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Optional partial index for in-flight Activity tab (skip if PR shows no hot-path; keep migration idempotent)
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_in_flight
  ON scheduled_task_runs(user_id, started_at DESC)
  WHERE finished_at IS NULL AND status IN ('running','pending','in_flight');
```

NO drops. NO NOT NULL adds on existing columns. NO data backfill.

### 6.2 New REST endpoints (license-gated except where noted)

All under `/api/*` with OpenAPI schemas added via `createRoute` in `hub/src/api/_openapi.ts`.

| METHOD | Path | Purpose |
|---|---|---|
| `GET`  | `/api/supervisors` | List user's supervisors with status, roots, version, last_seen. |
| `PATCH`| `/api/supervisors/:id/roots` | Update roots (max 16, ≤512 chars, absolute paths, reject `..`/NUL). Persist + WS push to running supervisor + emit `supervisor.roots_changed` to other client tabs. CSRF required, NO `requireRecentAuth`. |
| `GET`  | `/api/supervisors/:id/commands` | Read cached commands/skills list (from last `supervisor.commands_sync`). |
| `GET`  | `/api/tasks/upcoming` | `?within=24h\|7d` `?limit=1..100` — `scheduled_tasks` with `next_fire_at`. |
| `GET`  | `/api/tasks/activity` | Paginated runs across user. `?status?` `?since?` `?limit=1..200` `?cursor?` keyset on `(user_id, started_at)`. |
| `GET`  | `/api/account/webhooks` | Unified `{ coolify, revanote, github }` summary. |
| `POST` | `/api/account/revanote-webhook-secret/rotate` | Rotate Revanote webhook secret (parity with Coolify). CSRF + `requireRecentAuth`. |
| `GET`  | `/api/usage/summary` | `{ today_usd, week_usd, month_usd, daily_cap_usd, claude_window }`. 60s in-memory cache per-user. |
| `PATCH`| `/api/profile/preferences` | Persist `auto_nudge` (and future toggles) into `users.preferences` JSONB. CSRF only. |

### 6.3 WS protocol additions (in `hub/src/ws/protocol.ts` + `agent-protocol.ts`)

| Direction | Type | Payload |
|---|---|---|
| Hub → Supervisor | `supervisor.set_roots` | `{ type, roots: string[], req_id }` |
| Supervisor → Hub | `supervisor.set_roots_ack` | `{ type, req_id, ok, applied_roots, error? }` |
| Hub → Client (broadcast within user's connections) | `supervisor.roots_changed` | `{ type, supervisor_id, roots }` |

Supervisor side: handle `supervisor.set_roots` → write `roots` to config (`%LOCALAPPDATA%\remo-code-supervisor\config.json`, UTF-8 NO BOM via `[System.IO.File]::WriteAllText` from Rust / Bun.write JSON) → re-scan → emit ack. Older supervisors (no handler) → hub timeouts gracefully; on next `auth_ok`, hub re-pushes from DB.

---

## 7. Deep-link redirect map (in `web/src/App.tsx` `getRoute()`)

Both hash routes AND path routes (the latter for `{{run_url}}` and bookmarks):

| Old | New |
|---|---|
| `#/` | `#/home?tab=list` (alias kept) |
| `#/grid` | `#/home?tab=grid` (preserve `#/grid/:tabId` → `#/home?tab=grid&grid_tab=:tabId`) |
| `#/schedules` | `#/tasks?tab=schedule` |
| `#/settings?tab=schedules` | `#/tasks?tab=schedule` |
| `#/settings?tab=supervisor` | `#/settings?tab=connections` |
| `#/settings?tab=apikey` | `#/settings?tab=credentials` |
| `#/settings?tab=commands` | `#/settings?tab=prompts` |
| `#/settings?tab=instructions` | `#/settings?tab=prompts` |
| `#/settings?tab=account` | `#/settings?tab=profile` |
| `#/error-capture` | `#/tasks?tab=activity` (errors surface in run history; deep links from emails resolve to the dispatched run) |
| `#/revanote` | `#/settings?tab=connections` |
| **Path** `/schedules/runs/:id` (sent by `{{run_url}}` template) | hash redirect to `#/tasks?tab=activity&run=:id` |
| **Path** `/schedules` (bookmarks) | hash redirect to `#/tasks?tab=schedule` |

`{{run_url}}` template format (`hub/src/scheduler/post-run/dispatcher.ts:125`) is **NOT changed** — it still emits `${REMO_PUBLIC_URL}/schedules/runs/${runId}`. The SPA intercepts that pathname and rewrites to the new hash route. This is non-breaking for every notification sent before the cutover.

---

## 8. Auth implications (per Phase 07 invariants)

- All new `/api/*` endpoints are license-gated EXCEPT `/api/supervisors/:id/roots` PATCH which IS license-gated (mutation) but does NOT require `requireRecentAuth`. The exclusion list (`/api/auth/*`, `/api/profile`, `/api/profile/license`, `/healthz`, the sentry intake, the coolify webhook, the titanium webhook, `/ws/agent`) is unchanged this phase.
- `POST /api/account/revanote-webhook-secret/rotate` matches Coolify rotate — CSRF + `requireRecentAuth`.
- `PATCH /api/profile/preferences` — CSRF only, no step-up.
- CSRF: double-submit cookie + `X-CSRF-Token` header already exists (`hub/src/csrf.ts`). **Bearer-token requests bypass CSRF already** — reuse, do not add a second bypass.
- WS `supervisor.set_roots` validates that the supervisor connection's `apiKeyId.userId === requestingUserId` before forwarding (existing `supervisor-registry` already keys by user — reuse, do not bypass).

---

## 9. Hook reorganization map (no signature changes)

| Hook | Today | Under new nav |
|---|---|---|
| `useAuth`, `useProfile`, `useLicense`, `useTheme` | App.tsx + Layout | App shell — context-provide once. |
| `useWebSocket`, `useSessions` | Layout + GridPage + Sidebar | App shell — `SessionsContext` shared by Home/Tasks/Settings. |
| `useChat`, `useActivity`, `useChatSurface` | ChatSurface | unchanged (per-cell local). |
| `useSchedules`, `useScheduleRuns` | SettingsPage embed | `TasksPage` parent — shared across its 3 tabs. |
| `useApiKey`, `useCommands`, `useWebPushPermission` | SettingsPage | Settings tab subtrees. |
| `useSubscriptionUsage` | UsageStrip | unchanged (in header). |
| `useErrorProjects`, `useErrors`, `useErrorSetup` | ErrorCapturePage | Used only by Activity tab's error-derived rows; mount inside `TasksPage`. |
| `useRepoCreateJob` | (dead — only Phase-08 modal) | Adopted by `ConnectionsTab` via `<CreateGithubRepoModal>` after Modal primitive lands. |
| `usePendingLocalRepos` | DELETED in wave 1 | Re-implemented inside `ConnectionsTab` directly against existing DAL once primitives exist. |

---

## 10. Acceptance criteria

Build / test:
- `cd hub && bun test` — all green (no regressions; new endpoint tests added).
- `cd web && bunx tsc --noEmit` — **zero errors** (the 7 current errors all vanish via wave-1 deletes).
- `cd web && bun run build` — clean.
- `cd hub && bun run docs:sync` — `docs/openapi.json` + `docs/api.md` in sync with the new endpoints.

Behavior:
- Hard-refresh on every top-level route renders the shared header (logo + Home + Tasks + Settings + theme + quota + profile menu).
- All 13 legacy deep links from §7 resolve (manual smoke + a `lib/route.test.ts` unit test that exercises the redirect map).
- `{{run_url}}` template links sent BEFORE the cutover still land on the Activity tab via path-redirect.
- Supervisor `roots` field on Connections tab: PATCH → ack within 2s → roots appear in the supervisor's `config.json` → scan refires.
- Mobile (<768px): top nav fits, Tabs strip horizontally-scrollable but visible, no `100vh` regressions (use `100dvh`).
- Old supervisors that don't speak `supervisor.set_roots` produce a UI warning ("update supervisor to v0.6.0+"); hub doesn't crash on missing ack.

Quality gates:
- Single shared chrome (zero per-page back-arrow headers remain).
- No `rounded-2xl`, no `shadow-2xl`, no custom hex outside `web/src/index.css`.
- No new tab-strip implementations; every tab strip in the app uses `<Tabs>`.
- All modals use `<Modal>` (focus trap, ARIA, esc).

---

## 11. Phasing (5 waves)

Wave boundary = build green + tests pass.

**Wave 1 — Foundation purge + primitives** (no behavior change)
1. Delete the 6 files listed in §3.
2. Build 10 primitives in `web/src/components/ui/`.
3. Extract `ProfileMenu` to its own file; extract `licenseDotClass`/`licenseTextClass` to `lib/license-ui.ts`.
4. Add `web/src/lib/route.ts` with the tab-param parser/writer shared by Home/Tasks/Settings.

**Wave 2 — Backend deltas** (independent of UI)
5. Schema migration (§6.1).
6. `GET /api/supervisors`, `PATCH /api/supervisors/:id/roots`, `GET /api/supervisors/:id/commands`.
7. WS `supervisor.set_roots` round-trip (hub + supervisor handler).
8. `GET /api/tasks/upcoming`, `GET /api/tasks/activity`, `GET /api/usage/summary`, `GET /api/account/webhooks`.
9. `PATCH /api/profile/preferences`, `POST /api/account/revanote-webhook-secret/rotate`.
10. Tests for each (in `hub/test/`). `bun run docs:sync` commit.

**Wave 3 — New top-level pages** (consume waves 1+2)
11. `AppShell` + `AppHeader` wired in `App.tsx`. Layout split into `ChatLayout`.
12. `HomePage` + tabs body wiring (`ChatLayout` + `GridView`).
13. `TasksPage` + 3 tabs wiring (consume new endpoints).
14. `SettingsPage` container (5 tab routes; bodies are stubs that import wave-4 modules).

**Wave 4 — Tab content migration + redirects** (move existing components in)
15. Move `SupervisorPage` body into `ConnectionsTab`, add `<RootsField>` + pending-repo list.
16. Move `ApiKeyModal` + webhook cards into `CredentialsTab` (re-skin to `<Card>` + `<Modal>`).
17. Move `CommandsList` + instruction editor into `PromptsTab` + add server-persisted `<Toggle>` for auto-nudge.
18. Move `ClaudeUsageCard` + thresholds + cost rollup into `UsageTab`.
19. Move existing profile section into `ProfileTab`.
20. Deep-link redirects in `App.tsx` + path-redirect for `/schedules/runs/:id` and `/schedules`.

**Wave 5 — Fragment SettingsPage god-component + ad-hoc class purge**
21. Delete the old `SettingsPage.tsx` (now superseded by the container + 5 tab modules).
22. Sweep ad-hoc Tailwind class strings → primitive components (Card, Button, Field, Status, EmptyState, LoadingState).
23. Adopt Revanote: route into Connections, re-skin with primitives.
24. Final mobile parity pass + accessibility check (ARIA roles, keyboard nav).

---

## 12. Hard rules (carry through every wave)

- Worktree-only edits (`C:/Users/artic/GitHub/remo-code-ui-restructure`). Never touch canonical.
- Additive schema only (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`, partial indexes). No drops, no NOT NULL adds.
- License-gate exclusion list unchanged.
- CSRF: reuse existing bearer bypass; do not add a second one.
- UTF-8 no BOM for all file writes (Bun.write is safe; Rust uses explicit `UTF8Encoding($false)`).
- Notifications via emails4agents only (no SES/SendGrid).
- Design tokens from `~/.claude/design-preferences.md`; no ad-hoc colors, no `rounded-2xl`+, no `shadow-2xl`+.
- Tests in same PR as code.
- Per-wave QC via `gsd-verifier` before next wave starts.
- No security gate disabled anywhere (license, CSRF, requireRecentAuth retained).
- If a GSD subagent dies with claude-mem hook noise, re-dispatch with "ignore claude-mem hook noise" guidance.

---

## 13. Out of scope

- Multi-supervisor-per-user UI (DB supports it after §6.1; UI defers to a later phase).
- Per-supervisor scan settings (`max_depth`, `ignore_globs`) — supervisor has them in `config.ts`, but exposing in web UI is a separate phase.
- Splitting `useWebSocket` into connection + subscription modules (defer; tightly coupled but works).
- Rewriting `ChatSurface.tsx` (mature, virtualized, leave it).
