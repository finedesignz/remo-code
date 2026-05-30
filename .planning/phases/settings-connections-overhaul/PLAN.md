# Plan — Settings/Connections Overhaul + Grid View + Accent Migration

**Status:** DRAFT for approval → then execute via GSD (`/gsd-new-milestone` or `/gsd-plan-phase`).
**Scope:** web SPA (most), hub (schema + a few endpoints), supervisor Tauri (first-run wizard).
**Standards:** `~/.claude/design-preferences.md` + `~/.claude/architecture-preferences.md` (note: user said "architectural-standards.md" — no such file exists; architecture-preferences.md is the standard). design-preferences.md updated this session: **app accent = blue; orange = CTA-only; never indigo.**

Source analysis: surface map + design audit (this session). Key existing facts:
- Orchestrator session = `sessions.is_orchestrator=true`, unique partial index per user, `project_dir = supervisor.roots[0]`. Tab at `web/src/pages/settings/OrchestratorTab.tsx`, API `hub/src/api/orchestrator.ts`.
- Roots: `PATCH /api/supervisors/:id/roots`; supervisor config `roots[]` in `%LOCALAPPDATA%\remo-code-supervisor\config.json` (`supervisor/src/config.ts`).
- Auto-nudge: GLOBAL today — `users.auto_nudge_idle_sessions`, `PATCH /api/users/me/prompts`. No per-session column yet.
- Grid View: **already DB-backed** — `chat_tabs` + `chat_tab_sessions` tables, `/api/chat-tabs` CRUD. Bug = no Default tab auto-populating active sessions; active-cell only in sessionStorage. WS `subscribe` cap = 12 (`SUBSCRIBE_MAX`).
- Telegram card: `ProfileTab.tsx:395-557`, self-contained, safe to delete. `users.telegram_default_session_id` drives Telegram default.
- Logo: `web/src/components/ui/Brand.tsx` `<a>` has no horizontal padding.

---

## Decisions (locked)
- **App accent → blue** (`blue-600/500`, `blue-500/30` rings). Orange reserved for primary CTAs only. Migrate ALL indigo.
- **Auto-nudge → per-session.** Add nullable `sessions.auto_nudge` (bool); fall back to user global when null. Toggle lives on each sessions-list row.
- **Default session → orchestrator.** When user has no explicit default, the default session is the orchestrator at the root folder.
- **Grid Default tab** = virtual, auto-membership = all active sessions (same source as List View), not user-editable membership; capped at 12 with existing overflow badge. User-created tabs keep explicit DB membership.
- **Connections table** = single responsive renderer (kill the duplicated desktop/mobile blocks), consolidated cell, icon-only actions w/ tooltips, no mobile row-wrap.

---

## PHASE 1 — Design-system foundation (accent + primitives) [web]
Blocking; everything else consumes it.
1. **Accent migration indigo→blue** across primitives + all call sites: `ui/{Button,Toggle,Tabs,StatusPill,Card,Field}.tsx`, `Brand.tsx` focus ring, `Sidebar.tsx`, `SupervisorPage.tsx`, every `focus:ring-indigo-*`, `bg-indigo-*`, `text-indigo-*`. Grep-driven; zero indigo left (add a CI grep guard test).
2. **`Button` sizing → 44px touch targets** (`md: px-4 py-2.5`, add `touch` size); keep a compact `sm` for dense desktop rows but ensure ≥44px hit area via padding on mobile.
3. **New `InfoTip` primitive** (Lucide `info`, styled tooltip — not native `title=`). Repoint `Field.helper` to render a title-row tip icon instead of a `<p>` description.
4. **`Card`**: optional hairline border `/40` + `shadow-sm` (modern-subtle default; flat variant for table wrappers). Update stale doc comment.
5. **Logo spacing**: add `px-3`/`px-4` horizontal padding around Brand `<a>` (and/or AppShell brand wrapper).

## PHASE 2 — Connections tab overhaul [web + supervisor]
6. **Remove the "Root repo folder paths" card** (`ConnectionsTab.tsx` RootsEditor 37-213). Roots no longer editable here.
7. **Move root-folder setup into the supervisor first-run wizard** (`supervisor/tauri/ui/` Security/Roots pages): first run prompts hub URL + API key + **root folder** together. Config already supports `roots[]` — wizard just needs the field on the onboarding path + a "first root" prompt. (If a user has zero roots, hub still can't launch orchestrator — wizard must require ≥1 root.)
8. **Orchestrator → special top folder row** in the Connections repo list. Remove `OrchestratorTab` from SettingsPage tabs (`SettingsPage.tsx` tab enum + nav + mount). Render a pinned, specially-marked row at the very top of the SupervisorPage table representing the orchestrator (root folder); its enable/disable/start/stop actions move into that row (icon buttons + tooltips). Keep `/api/orchestrator` endpoints; just relocate the UI. Redirect `#/settings?tab=orchestrator` → `#/settings?tab=connections`.
9. **Compact the repo table**: single responsive renderer, consolidated metadata cell (`repo · branch · status · last-seen`; path → truncated subline + tooltip), icon-only row actions w/ tooltips, `divide-y /40`, no `md:` dual-block, **no mobile row-wrap** (horizontal scroll or ellipsis, never wrap). Button sizes per Phase 1.
10. **Tooltips replace inline descriptions** throughout Connections (InfoTip).

## PHASE 3 — Delete Prompts tab; per-session auto-nudge [web + hub]
11. **Schema**: `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auto_nudge BOOLEAN` (nullable; null = inherit user global). Idempotent DDL in schema.sql.
12. **Endpoint**: `PATCH /api/sessions/:id` (or new `/api/sessions/:id/auto-nudge`) to set per-session `auto_nudge`. Nudge dispatch logic reads per-session value, falling back to `users.auto_nudge_idle_sessions`.
13. **Sessions list row toggle**: small auto-nudge switch per row in `Sidebar.tsx` (blue, instant PATCH, tooltip-labeled).
14. **Delete Prompts tab entirely**: remove `PromptsTab.tsx`, the commands card (`CommandsList`/`useCommands`), AND the instruction blobs (claude_global_md / codex_agents_md / codex_config_toml) — instruction files are handled locally, not via the web UI. Drop the tab enum/nav/mount and the related `/api/instructions` UI wiring (leave hub endpoint if other callers exist; otherwise prune). Redirect `#/settings?tab=prompts`→`connections`.

## PHASE 4 — Usage tab cleanup [web + hub]
15. **Merge** Daily Cost Cap into the thresholds card; **rename** card → **"Claude Usage and Cost Controls"**. Desktop: cap + session% + week% laid out compactly (one row/grid).
16. **Tokens under dollars**: in each cost card (Today/Week/Month) show token count beneath the `$` amount (consume `/api/usage/cost` token data; extend `/api/usage/summary` if needed).
17. **Tooltips** replace the threshold/cap helper sentences. Auto-save-on-blur for cap + thresholds (drop Save buttons).

## PHASE 5 — Profile tab + default-session [web + hub]
18. **Delete Telegram card** (`ProfileTab.tsx:395-557`) + its fetches. Keep `/api/telegram/*` endpoints (bot still works); just remove the Profile UI. (Telegram default-session management, if still needed, surfaces elsewhere or via bot.)
19. **Default session = orchestrator**: where the app picks a default session with none set (List View auto-select `ChatLayout.tsx:100-102`, Telegram default resolution, any `default_session` logic), fall back to the user's orchestrator session at the root folder. Centralize the "resolve default session" helper.
20. Auto-save-on-blur for display name + timezone (drop Save buttons); width → `max-w-7xl`.

## PHASE 6 — Grid View = active sessions + persistence [web + hub]
21. **Default tab auto-populates** all active sessions (same `useSessions` source as List View), virtual membership, cap 12 + existing overflow badge. Grid Default = List View parity.
22. **User tabs**: create more tabs, **move/assign sessions between tabs** (drag or menu) — uses existing `chat_tab_sessions` CRUD. 
23. **Persist across restart**: tabs + memberships already DB-backed (good). Add **active-cell persistence** to DB (extend `chat_tabs` or a `user_grid_state` row) so the focused cell survives reload/device. Verify Grid tabs + assignments reload correctly after hub restart.

## PHASE 7 — Cross-cutting polish + docs [web + docs]
24. **Auto-save-on-blur** sweep for remaining low-stakes forms; remove redundant Save buttons.
25. **Width uniformity** `max-w-7xl` across all settings tabs.
26. **EmptyState** copy → single sentence; drop multi-line descriptions.
27. **Architecture docs refresh (anti-drift)** — update in same milestone:
    - `web` CLAUDE.md / `docs/` — new Settings tab set (Connections/Credentials/Usage/Profile — Prompts & Orchestrator GONE), accent=blue rule, per-session auto-nudge, Grid Default-tab behavior.
    - `.planning/codebase/{ARCHITECTURE,STRUCTURE,CONVENTIONS}.md` — reflect removed tabs/components, new schema columns, default-session=orchestrator.
    - `.planning/phases/12-ui-restructure/12-CONTEXT.md` — supersession note (Orchestrator/Prompts tabs removed; this milestone is the new source of truth).
    - `docs/grid-view.md` — Default tab + persistence.
    - `hub` `docs:sync` for any new/changed endpoints (`/openapi.json` + `docs/api.md`).

---

## Acceptance / QC (per phase, gsd-verifier)
- `bun run build:web` clean; `cd hub && bun test` green; `bun run check-baseline` (fail_max 0); `bun run docs:sync` in sync.
- Zero `indigo` in web/src (grep guard). All interactive elements ≥44px touch target. No native `title=` left where InfoTip applies. No mobile row-wrap in Connections table.
- Behavior smoke: Orchestrator controllable from its Connections row; Prompts/Orchestrator tabs 404→redirect; per-session auto-nudge persists; Usage card renamed + tokens shown + cap merged; Telegram card gone; Grid Default tab shows all active sessions and survives reload; logo has breathing room.
- Post-merge: Coolify redeploy + HTTPS smoke (rule 14 / feedback_https_url_smoke).

## Open items to confirm during exec (defaults chosen, not blocking)
- Active-cell persistence storage → extend `chat_tabs` vs new `user_grid_state` (pick simplest at build time).
- Accent shade → **blue-600/500** (vs green) — going blue unless you say green.

## Out of scope
- Mobile Tauri client (paused). Hub-deepening Round 2 dispatch refactor (separate track — coordinate, don't collide on `hub/src/{scheduler,error-capture,...}`).
