---
plan_id: 03-PLAN-004-desktop-grid-page
wave: 3
depends_on: [03-PLAN-001-schema-and-api, 03-PLAN-003-chat-surface-refactor]
files_modified:
  - web/src/App.tsx
  - web/src/components/GridPage.tsx
  - web/src/components/GridTabBar.tsx
  - web/src/components/GridCell.tsx
  - web/src/components/CellHeader.tsx
  - web/src/components/SessionPicker.tsx
  - web/src/hooks/useChatTabs.ts
  - web/src/hooks/useSessionQueueState.ts
autonomous: true
requirements: [R01, R02, R03, R04, R05, R08, R09, R10]
---

# Plan 03-004 — Desktop grid page (`#/grid` / `#/grid/:tabId`)

<tasks>

<task id="T1">
<action>Extend `web/src/App.tsx`: add `'grid'` to the `Route` union; extend `getRoute()` to return `'grid'` for any hash starting with `#/grid`; parse the optional `:tabId` segment (`#/grid/abc-123`). Add a render branch that mounts `<GridPage token={token} activeTabId={tabId} />` for that route. Add a Grid View nav link to the existing nav surface (wherever Schedules/Settings links live — match indigo accent styling per `web/src/components/SettingsPage.tsx`).</action>
<read_first>
- web/src/App.tsx (full file)
- web/src/components/Layout.tsx (find the nav element)
</read_first>
<acceptance_criteria>
- Visiting `#/grid` mounts `<GridPage>` with `activeTabId === undefined`
- Visiting `#/grid/abc-123` mounts `<GridPage>` with `activeTabId === 'abc-123'`
- Hash changes between `#/chat`, `#/grid`, `#/settings`, `#/schedules` all work without remount-thrash of unrelated routes
- The new nav link visually matches existing nav items
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `web/src/hooks/useChatTabs.ts` — CRUD hook over `/api/chat-tabs`. Surface: `{ tabs, loading, error, createTab, renameTab, deleteTab, reorderTabs, setLayout, addSessionToTab, removeSessionFromTab, reorderTabSessions, refresh }`. Uses the existing `hubFetch` helper from `web/src/lib/api.ts`. State lives in the hook (not global) — `GridPage` is the sole consumer. Optimistic updates for renames and reorders.</action>
<read_first>
- web/src/lib/api.ts (hubFetch usage)
- web/src/hooks/useSessions.ts (a comparable CRUD hook to model after)
</read_first>
<acceptance_criteria>
- Hook compiles and consumes `hubFetch` for all server calls
- Optimistic rename rolls back on server error
- `refresh()` re-fetches and replaces state
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `web/src/components/GridPage.tsx`. Layout: `<GridTabBar>` at top, grid area below filling the rest of the viewport. State: `activeTabId` (synced to URL hash), `activeCellId` (the session_id of the currently focused cell — initialized from `sessionStorage.getItem('grid:lastActiveCell:'+tabId)`, persisted on change to sessionStorage, NOT URL), `subscribedIds: Set<string>` derived from the active tab's sessions (drives the WS subscribe call). On `activeTabId` change, fetch initial history for ALL of that tab's sessions via `GET /api/sessions/messages?ids=...&limit=30` (one round-trip), pass the result down as `seedMessages` prop to each `<ChatSurface>`. Empty states: "Create your first tab" (no tabs at all) and "This tab has no sessions yet — add some" (tab exists, empty). Both use the `bg-secondary/60 rounded-xl` baseline. Below `md` breakpoint, render `<MobileAccordion>` instead of the grid (MobileAccordion ships in PLAN-005).</action>
<read_first>
- web/src/components/SettingsPage.tsx (visual baseline)
- web/src/components/Sidebar.tsx (existing session row style)
- web/src/hooks/useChatTabs.ts (after T2)
</read_first>
<acceptance_criteria>
- Switching tabs triggers exactly ONE history fetch (`GET /api/sessions/messages?ids=...`) and exactly ONE WS subscribe frame with the new tab's full set
- `activeCellId` survives a tab switch and back (sessionStorage)
- `activeCellId` is NOT in the URL hash
- Empty states render with the canonical card style
- Below 768px width, the grid is not shown — accordion takes over
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `web/src/components/GridTabBar.tsx`. Horizontal list of tab chips (active one styled `bg-indigo-600/20 ring-1 ring-indigo-500/30`, inactive `bg-[var(--bg-secondary)]/60`). Inline rename on double-click (or via overflow menu) — input swaps in, blur or Enter commits, Escape cancels. Up/down arrow buttons in overflow menu for reorder. Trailing "+" button to create a new tab (modal asks for name + initial layout). Per-tab overflow menu: rename, change layout (`3x3` / `4x3` / `auto-fit`), reorder, delete (confirm dialog).</action>
<read_first>
- web/src/components/SchedulesPage.tsx (any pattern for modal + inline edit)
- web/src/components/SettingsPage.tsx (modal/dialog primitives if they exist)
</read_first>
<acceptance_criteria>
- Tab create flow: click "+", name modal opens, submit creates server-side tab, URL updates to `#/grid/<newId>`, tab chip appears active
- Inline rename commits on Enter, reverts on Escape
- Reorder via up/down updates server position and persists across refresh
- Delete asks "Delete tab 'X'?" before calling the API
</acceptance_criteria>
</task>

<task id="T5">
<action>Create `web/src/components/GridCell.tsx`. A frame that hosts ONE `<ChatSurface density="cell">` plus a `<CellHeader>` (T6). Props: `{ sessionId, isActive, onActivate, seedMessages }`. Click anywhere inside the cell sets it as the active cell. Cell uses `rounded-xl bg-[var(--bg-secondary)]/60`, no heavy border; active cell adds `ring-1 ring-indigo-500/30`. Resize handles: thin (4px) draggable strips on the right and bottom edges; drag adjusts `grid-template-columns` / `grid-template-rows` of the parent. The grid uses CSS grid: `display: grid; grid-template-columns: repeat(N, 1fr)` for `3x3` and `4x3` modes (`N=3` and `N=4` respectively, `auto-fit` uses `repeat(auto-fit, minmax(280px, 1fr))`). Cell count cap: 12 per tab. Cells beyond 12 in a tab are not rendered; show a "12-cell cap reached, hidden N more" footer.</action>
<read_first>
- web/src/components/SettingsPage.tsx
- web/src/components/ChatSurface.tsx (after PLAN-003)
</read_first>
<acceptance_criteria>
- Adding/removing a session from a tab auto-resizes the grid (no orphaned blank cells)
- Resize drag visibly resizes adjacent cells; release commits the new size to local React state (persistence is deferred per CONTEXT)
- Clicking inside a cell makes it the active cell (ring appears, sessionStorage updates)
- 13th session in a tab triggers the cap footer; first 12 still render
</acceptance_criteria>
</task>

<task id="T6">
<action>Create `web/src/components/CellHeader.tsx`. Renders: session name (truncate), status dot (online/offline/thinking colors per existing convention), scheduled-task queue badge (small amber dot for "waiting", indigo spinner for "in-flight"; tooltip shows task name; absent when no task is queued or in-flight), overflow menu (remove from tab, open in single-chat view at `#/chat?session=<id>`). The queue badge data comes from `useSessionQueueState(sessionId)` (T7).</action>
<read_first>
- web/src/components/Sidebar.tsx (current status-dot styling)
- docs/scheduled-tasks.md (queue model)
- hub/src/scheduler/session-queue.ts (queue state shape)
</read_first>
<acceptance_criteria>
- Status dot color matches existing Sidebar dot
- Badge appears only when a scheduled task is queued or running for that session
- Hovering the badge shows the task name in a small tooltip
- Overflow menu actions work (remove from tab calls `DELETE /api/chat-tabs/:id/sessions/:sid`; open-in-single-chat navigates the hash)
</acceptance_criteria>
</task>

<task id="T7">
<action>Create `web/src/hooks/useSessionQueueState.ts`. Returns `{ status: 'idle' | 'waiting' | 'running'; taskName?: string }` for a given `sessionId`. Subscribes to existing scheduled-run WS events (`scheduled_run_started`, `scheduled_run_progress`, `scheduled_run_finished` per `docs/scheduled-tasks.md`) and tracks per-session state. If the queue state is not exposed via WS today, add a tiny REST poll fallback to `GET /api/scheduled-task-runs?session_id=...&active=1` (every 5s) — but PREFER WS-derived state. Confirm by reading `hub/src/scheduler/session-queue.ts` and the existing scheduled-run WS broadcast code.</action>
<read_first>
- docs/scheduled-tasks.md (WS event names)
- hub/src/scheduler/session-queue.ts
- hub/src/api/scheduled-task-runs.ts (existing REST shape)
- web/src/hooks/useScheduleRuns.ts (existing WS subscription pattern)
</read_first>
<acceptance_criteria>
- Hook returns `'running'` within 1s of a scheduled run starting for the watched session
- Hook returns `'waiting'` when a run is queued behind an in-flight one for the same session
- Hook returns `'idle'` when no run is queued/running
- Polling fallback is used ONLY if WS events are insufficient (justify in code comment)
</acceptance_criteria>
</task>

<task id="T8">
<action>Create `web/src/components/SessionPicker.tsx`. Modal triggered from a per-tab "+ Add sessions" button. Lists the user's sessions (online + offline, paginated if many — but realistically a user has dozens at most), with multi-select. Already-in-this-tab sessions are pre-checked and disabled. Submit calls `POST /api/chat-tabs/:id/sessions` for each newly checked session (or a single bulk call if the API supports it — current shape is one-at-a-time per PLAN-001). Submit closes the modal and the grid re-renders with the new cells.</action>
<read_first>
- web/src/hooks/useSessions.ts
- web/src/components/SettingsPage.tsx (modal pattern)
</read_first>
<acceptance_criteria>
- Modal opens on click; lists all user sessions; already-in-tab sessions are visibly disabled
- Selecting 3 new sessions and submitting results in 3 server calls and 3 new cells visible
- Modal closes on submit or on backdrop click / Escape
</acceptance_criteria>
</task>

<task id="T9">
<action>Implement active-cell-aware paste/drop handling. In `GridPage`, scope the document-level `paste` and `drop` handlers added today by `<ChatSurface>`: BEFORE delegating to a cell's handler, check `document.activeElement` — if it's inside a `<ChatSurface>` other than the active cell, do nothing (let that cell handle it). If it's outside all surfaces (e.g. user clicked a tab chip then pasted), route the paste to the active cell. Implementation: walk up from `document.activeElement` to find the nearest `[data-chat-surface-cell-id]` ancestor; that wins. Otherwise, fall back to `activeCellId`.</action>
<read_first>
- web/src/components/ChatPanel.tsx (current paste handler logic to understand the existing event listener)
- web/src/components/ChatSurface.tsx (the new component — add `data-chat-surface-cell-id={sessionId}` to its root)
</read_first>
<acceptance_criteria>
- Typing in cell A's input and pressing Ctrl+V pastes into cell A (not the active cell if different)
- Pasting an image while focus is in the tab bar pastes into the active cell
- Removing the active cell falls back to the first cell as active
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `<GridPage>` mounts at `#/grid` and `#/grid/:tabId`, with hash-sync of the active tab id
- Switching tabs is ONE history fetch and ONE WS subscribe frame
- Active cell is tracked in `sessionStorage` (not URL), and paste/drop routes to it correctly
- Each `<CellHeader>` shows the scheduled-task queue badge when applicable
- Empty states and visual baseline match `SettingsPage.tsx`
- No new dependencies were added in this plan (`@tanstack/react-virtual` was added in PLAN-003)
