---
phase_id: 03-multichat-grid-view
phase_number: 03
status: pending
owner: jsmithfd@gmail.com
created: 2026-05-24
requirements: [R01, R02, R03, R04, R05, R06, R07, R08, R09, R10, R11, R12, R13]
depends_on: [Phase 02]
---

# Phase 03 — Multichat Grid View

<domain>
A user-facing view that lets a single remo-code user observe and interact with many of their Claude Code sessions simultaneously. Desktop: a tab bar at the top (user-named tabs), and a CSS-grid of session cells below; each cell is a self-contained chat surface streaming live activity. Mobile: a vertical accordion list of the active tab's sessions, with a square inline expand for a single chat at a time. Backed by two new Postgres tables, one new web component family (`<ChatSurface>` + `<GridPage>` + `<MobileAccordion>`), a refactor of the existing chat surface, and an end-to-end wire-up of the multi-`session_ids` subscribe op that already exists in the WS protocol schema but is not yet driven by the client.
</domain>

<decisions>
- **Persistence:** Relational tables — `chat_tabs (id, user_id, name, layout, position, created_at, updated_at)` and `chat_tab_sessions (tab_id, session_id, position, created_at)` with composite PK `(tab_id, session_id)`. NOT a JSON blob. All queries scoped by `user_id` via join.
- **DB cascade:** `chat_tabs.user_id` → `users(id) ON DELETE CASCADE`. `chat_tab_sessions.tab_id` → `chat_tabs(id) ON DELETE CASCADE`. `chat_tab_sessions.session_id` → `sessions(id) ON DELETE CASCADE`. Deleting a user, tab, or session cleans up downstream rows automatically.
- **Routing:** Hash-based, extending existing `getRoute()` in `web/src/App.tsx`. Routes: `#/grid` (redirects to most recent tab, or "create your first tab" empty state) and `#/grid/:tabId`. Reloading at `#/grid/:tabId` restores the tab.
- **WS subscribe op:** OVERLOAD the existing `subscribe` op in `hub/src/ws/protocol.ts`. Accept BOTH `session_id: string` (legacy single) AND `session_ids: string[]` (multi). Back-compat preserved. DO NOT add a new `subscribe_many` op. The schema already supports `session_ids: z.array(z.string()).max(100)`; this phase wires it end-to-end on the client and tightens the cap.
- **Per-connection subscription cap:** 12 active session_ids per client connection. Subscribe calls exceeding 12 are rejected with `{ type: 'subscribe_error', error: 'too_many_sessions', max: 12 }`. The hub already holds a connection state object — extend it to carry a `Set<sessionId>` and route activity events by set membership.
- **Initial history per cell:** Cap at 30 messages on first mount (vs the existing single-view default which can be larger). New endpoint: `GET /api/sessions/messages?ids=a,b,c&limit=30` returning `{ [sessionId]: Message[] }` — one round-trip per tab activation, not N round-trips.
- **Shared chat-surface component:** Refactor `web/src/components/ChatPanel.tsx` into a new `web/src/components/ChatSurface.tsx` with three densities: `full` (drop-in for existing single-chat at `#/chat`), `cell` (compact grid cell), `mobile-expanded` (square, input pinned bottom). Each instance owns its own session subscription lifecycle. Same message pipeline, same attachment pipeline, same markdown renderer, same activity feed primitives.
- **RAF coalescing for streaming text:** `<ChatSurface>` (especially `density="cell"`) MUST coalesce inbound `text_delta` events via `requestAnimationFrame` — accumulate deltas in a ref, flush ONE React state update per frame. Hub-side throttling is FORBIDDEN; it would break the scheduled-tasks event-ordering contract documented in `docs/scheduled-tasks.md`.
- **Virtualization:** The message list inside `<ChatSurface>` MUST be virtualized with `@tanstack/react-virtual` for ALL densities (single virtualization implementation across `full`, `cell`, `mobile-expanded`). `@tanstack/react-virtual` is NOT currently in `web/package.json` — add it as a new dep in PLAN-003. This is required to hit R13 (12 cells × 5 msg/sec).
- **Mobile detection:** CSS-first via Tailwind `md:` breakpoint (768px). Below `md`, `<GridPage>` renders `<MobileAccordion>` instead of the grid regardless of route. Grid layout is desktop-only.
- **Mobile expand sizing:** Expanded panel uses `aspect-ratio: 1 / 1` with `max-height: 100dvh`. NEVER `100vh` — iOS Safari's `vh` includes the keyboard area and collapses the layout when the input is focused. Use `100dvh` / `100svh` (dynamic / small viewport height) per spec.
- **Accordion unmount on collapse:** When a mobile accordion row collapses, the `<ChatSurface>` inside MUST be unmounted (not just hidden via CSS). Only one `<ChatSurface>` is mounted at a time on mobile. Subscription drops with it; on re-expand, re-subscribe + refetch last 30. Render cost on a phone is the driver, not WS load.
- **Active cell tracking:** `<GridPage>` tracks an `activeCellId` per tab in component state + `sessionStorage` (NOT URL — too noisy). Paste/drop attachment handlers target the active cell. The global document-level paste handler is scoped so it does NOT fire when `document.activeElement` is inside a different cell's input (otherwise typing in cell A would intercept paste meant for cell B).
- **Scheduled-task queue badge per cell:** Each cell header shows a small badge when the cell's session has a scheduled task in-flight or waiting in the per-session queue. References the queue model in `hub/src/scheduler/session-queue.ts` and the docs in `docs/scheduled-tasks.md`. Tiny indicator — amber dot for waiting, indigo spinner for in-flight; tooltip with task name.
- **Cell ordering:** Integer `position` column on `chat_tab_sessions`. Reordering rewrites positions in a single transaction (gap-free re-sequence). Tab ordering: integer `position` column on `chat_tabs`.
- **Styling:** Match `web/src/components/SettingsPage.tsx` baseline. Tab bar: `bg-[var(--bg-secondary)]/60` chips with `rounded-lg`, active chip `bg-indigo-600/20 ring-1 ring-indigo-500/30`. Cell frame: `rounded-xl bg-[var(--bg-secondary)]/60`, no heavy border. Resize handles: 4px invisible hot zone with `hover:bg-indigo-500/30` reveal. Per user's global frontend conventions (CLAUDE.md).
- **No new deps beyond `@tanstack/react-virtual`.** No `react-resizable-panels`, no `react-grid-layout`. Use native CSS grid + a thin custom drag-handle component.
</decisions>

<canonical_refs>
- `CLAUDE.md` (project)
- `~/.claude/CLAUDE.md` (user global — frontend/CSS conventions, port map, auth-via-Titanium etc.)
- `docs/scheduled-tasks.md` (queue model + event-ordering contract)
- `hub/src/db/schema.sql` (migration patterns, idempotent ADD COLUMN style)
- `hub/src/ws/protocol.ts` (ClientSubscribe schema — `session_ids: z.array().max(100)` is already there)
- `hub/src/ws/client.ts` (per-connection state, subscribe handler, broadcast routing)
- `hub/src/ws/registry.ts` (`broadcastToSubscribers`, `broadcastToUser`)
- `hub/src/scheduler/session-queue.ts` (session-queue state for cell badge)
- `hub/src/api/sessions.ts` (REST patterns for new tab endpoints)
- `hub/src/db/dal.ts` (DAL patterns — all queries scoped by `user_id`)
- `web/src/App.tsx` (hash-based router, route enum)
- `web/src/components/Layout.tsx` (wires the active-session pointer into ChatPanel today)
- `web/src/components/ChatPanel.tsx` (the surface being refactored)
- `web/src/components/Sidebar.tsx` (accordion row visual baseline)
- `web/src/components/SettingsPage.tsx` (canonical visual reference per user CLAUDE.md)
- `web/src/components/ActivityFeed.tsx`, `MessageBubble.tsx`, `ThinkingBlock.tsx`, `ToolUseBlock.tsx`, `FileAttachmentBar.tsx` (reused inside `<ChatSurface>`)
- `web/src/hooks/useWebSocket.ts`, `useChat.ts`, `useSessions.ts` (subscription + message hooks)
- `.planning/codebase/CONVENTIONS.md` (file org, naming, ws-schema-then-handler order)
- `.planning/codebase/CONCERNS.md` (per-IP WS cap = 20, ChatPanel size, no web test harness)
</canonical_refs>

<specifics>
- New tables: `chat_tabs`, `chat_tab_sessions` per the locked schema. Add via `CREATE TABLE IF NOT EXISTS` in `hub/src/db/schema.sql`.
- New DAL file: `hub/src/db/chat-tabs-dal.ts`.
- New API router: `hub/src/api/chat-tabs.ts` mounted at `/api/chat-tabs` in `hub/src/index.ts` AFTER the JWT `authMiddleware` block.
- New API handler in `hub/src/api/sessions.ts`: `GET /api/sessions/messages?ids=...&limit=30` returning `{ [sessionId]: Message[] }`. Cap `ids` length at 12; reject otherwise.
- WS subscribe overload in `hub/src/ws/protocol.ts`: `ClientSubscribe = z.object({ type: 'subscribe', session_id?: string, session_ids?: string[] }).refine(d => !!d.session_id || !!d.session_ids)`. Cap `session_ids` at 12 in the validator. Backward-compatible normalization happens in the handler.
- WS subscribe error: add `HubToClient` variant `{ type: 'subscribe_error', error: 'too_many_sessions' | 'invalid', max?: number }`.
- Per-connection state: extend the existing client-WS state to hold `subscribed: Set<string>`. Activity events check membership.
- New web components: `web/src/components/ChatSurface.tsx`, `web/src/components/GridPage.tsx`, `web/src/components/MobileAccordion.tsx`, `web/src/components/GridTabBar.tsx`, `web/src/components/SessionPicker.tsx`, `web/src/components/GridCell.tsx`, `web/src/components/CellHeader.tsx`.
- New web hook: `web/src/hooks/useChatTabs.ts` (CRUD + reorder over `/api/chat-tabs`).
- New web lib: `web/src/lib/raf-batch.ts` (one tiny utility for the RAF coalescer).
- New dep in `web/package.json`: `@tanstack/react-virtual` (latest 3.x).
- Route addition in `web/src/App.tsx`: extend `Route` union to include `'grid'`, extend `getRoute()` to parse `#/grid` and `#/grid/:tabId`, add `<GridPage>` render branch.
- Nav entry: add Grid View link to existing nav (matches indigo accent style, sits alongside Schedules and Settings).
</specifics>

<deferred>
The following are explicitly out of scope for Phase 03 and will be queued as separate phase candidates:
- Per-cell resize size persistence (cells resize at runtime but layout snapshot is not saved per-tab; only `layout` mode is)
- Cross-user tab sharing (collaboration)
- Per-cell mute / notification suppression
- "Pop out cell to new window" (multi-window orchestration)
- Drag-and-reorder cells across tabs (within-tab reorder uses up/down buttons in v1)
- Drag-and-reorder cells within a tab via DnD (up/down buttons in v1; full DnD later)
- Infinite scroll within cells (initial 30 + load-more button; true infinite scroll later)
- Mobile tab picker (mobile v1 always shows accordion for "the current tab"; tab switching on mobile is via the desktop view or deferred until users ask)
- Cross-tab session search
- Tab templates / preset layouts
- Keyboard shortcuts for tab and cell navigation (cmd-1..9 etc.)
- Web-side automated test harness (still no Vitest / Playwright — out of scope, manual smoke is the gate)
</deferred>

<scope_fence>
**In scope:**
- The exact features in R01–R13.
- The 6 plans listed in `ROADMAP.md` Phase 03.
- New deps: `@tanstack/react-virtual` only.

**Out of scope (will reject during execution):**
- Modifying scheduled-tasks behavior beyond reading queue state for the cell badge.
- Modifying the agent (`agent/`) or channel (`channel/`) packages.
- Changing the per-IP WS connection cap (20) — grid uses ONE connection regardless of cell count.
- Replacing the existing hash router with react-router.
- Adding any other UI library / CSS framework / state-management lib.
- Rewriting `ChatPanel.tsx` features. The refactor extracts; it does not redesign.

**Claude's discretion (explicit license, no need to ask):**
- Exact drag-handle UX (visual width, hover affordance, snap-to-grid behavior).
- Tab-creation flow — inline rename input vs modal — pick what matches `SettingsPage.tsx`.
- Empty-state copy and illustration (or absence of one).
- Exact cell header layout (session name + status dot + optional task badge + overflow menu).
- Whether the initial-history fetch happens at GridPage mount or per-cell mount (must be one round trip per tab activation — implementation detail).
- Animation timing for accordion expand/collapse (CSS transition; pick a tasteful duration).
</scope_fence>
