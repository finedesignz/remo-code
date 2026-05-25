# Grid View

User-facing multichat view that lets a single remo-code user observe and
interact with up to 12 of their Claude Code sessions simultaneously.
Desktop: a tab bar at the top (user-named tabs) and a CSS-grid of session
cells below — each cell is a self-contained chat surface streaming live
activity. Mobile: a vertical accordion of the active tab's sessions with a
single inline square expand at a time.

> **Status:** shipped in Phase 03 (`feat/multichat-grid-view`).
> Routes: `#/grid`, `#/grid/:tabId`.

---

## Overview

The grid is one WebSocket connection per browser. The hub already holds a
`Set<sessionId>` per client connection and broadcasts activity by set
membership — the grid wires the multi-subscribe op end-to-end on the
client and tightens the per-connection cap to 12.

Tabs and tab membership are persisted relationally (two new tables, both
scoped by `user_id`). Each tab carries a `layout` mode (`3x3`, `4x3`, or
`auto-fit`) and an integer `position` for tab-bar ordering. Cell ordering
inside a tab is a separate integer `position` on the membership row.

Streaming text inside each cell is RAF-coalesced (one React state update
per frame); message lists are virtualized with `@tanstack/react-virtual`.
This is what makes 12 cells × 5 msg/sec feasible.

## Architecture

```
                ┌──────────────────────────────────┐
                │  Web UI (GridPage / Accordion)   │
                └────────────────┬─────────────────┘
                                 │ REST + WS (1 socket)
                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Hub                                                    │
   │  ┌─────────────────┐  ┌───────────────────────────────┐ │
   │  │ REST routers    │  │ ws/                           │ │
   │  │  /api/chat-tabs │  │  protocol.ts  (Zod schemas)   │ │
   │  │  /api/sessions/ │  │  client.ts    (subscribe op)  │ │
   │  │   messages      │  │  registry.ts  (per-conn Set)  │ │
   │  └─────────────────┘  └───────────────────────────────┘ │
   │  ┌─────────────────────────────────────────────────────┐│
   │  │ db/chat-tabs-dal.ts (CRUD + reorder + batch fetch) ││
   │  └─────────────────────────────────────────────────────┘│
   └─────────────────────────────────────────────────────────┘
                                 │ broadcastToSubscribers(sessionId)
                                 ▼
                       fan-out to all connections
                       whose Set contains sessionId
```

### Module map

| File                                          | Role                                                                  |
|-----------------------------------------------|-----------------------------------------------------------------------|
| `web/src/components/GridPage.tsx`             | Top-level desktop view. Tab bar, layout picker, CSS grid, picker.     |
| `web/src/components/ChatSurface.tsx`          | The chat surface — three densities (`full`, `cell`, `mobile-expanded`). Owns subscribe lifecycle. |
| `web/src/components/MobileAccordion.tsx`      | Mobile branch — vertical rows, one expanded at a time, unmount on collapse. |
| `web/src/components/MobileAccordionRow.tsx`   | Row UI + the conditional `<ChatSurface density="mobile-expanded">` mount. |
| `web/src/components/SessionPicker.tsx`        | Add/remove sessions from the active tab.                              |
| `web/src/lib/chat-tabs-api.ts`                | Typed `/api/chat-tabs/*` + batch-messages wrappers.                   |
| `web/src/lib/raf-batch.ts`                    | RAF coalescer used by `ChatSurface` for `text_delta`.                 |
| `hub/src/api/chat-tabs.ts`                    | REST router — CRUD, membership, bulk reorder.                         |
| `hub/src/api/sessions.ts`                     | `GET /api/sessions/messages?ids=…&limit=30` (12-id cap).              |
| `hub/src/db/chat-tabs-dal.ts`                 | All queries scoped by `user_id` via join.                             |
| `hub/src/ws/protocol.ts`                      | `ClientSubscribe` overload + `subscribe_error` variant.               |
| `hub/src/ws/client.ts`                        | Subscribe handler — applies 12-cap, mutates per-connection Set.       |
| `hub/src/ws/registry.ts`                      | `broadcastToSubscribers` — set-membership routing.                    |

## Persistence schema

Defined in `hub/src/db/schema.sql` as idempotent `CREATE TABLE IF NOT
EXISTS` statements. All queries are user-scoped via a join on `chat_tabs`.

### `chat_tabs`

| Column        | Type                          | Notes                                  |
|---------------|-------------------------------|----------------------------------------|
| `id`          | `text primary key`            | Random ID (`tab_…`).                   |
| `user_id`     | `text not null`               | FK → `users(id) on delete cascade`.    |
| `name`        | `text not null`               | User-given. Rename via PATCH.          |
| `layout`      | `text not null default '3x3'` | One of `3x3`, `4x3`, `auto-fit`.       |
| `position`    | `integer not null default 0`  | Tab-bar order. Rewritten on reorder.   |
| `created_at`  | `timestamptz default now()`   |                                        |
| `updated_at`  | `timestamptz default now()`   | Bumped on every mutation.              |

### `chat_tab_sessions`

| Column        | Type                          | Notes                                                          |
|---------------|-------------------------------|----------------------------------------------------------------|
| `tab_id`      | `text not null`               | FK → `chat_tabs(id) on delete cascade`.                        |
| `session_id`  | `text not null`               | FK → `sessions(id) on delete cascade`. Disappears when session is removed. |
| `position`    | `integer not null default 0`  | Cell order inside the tab. Rewritten on reorder.               |
| `created_at`  | `timestamptz default now()`   |                                                                |
|               | `primary key (tab_id, session_id)` | Composite. Prevents duplicate membership.                 |

Deleting a user, a tab, or a session cleans up downstream rows
automatically — there is no app-level cascade code.

## WS subscribe overload

The existing `subscribe` op in `hub/src/ws/protocol.ts` is overloaded —
the schema already had `session_ids: z.array(z.string()).max(100)`; the
grid wires it end-to-end on the client and tightens the cap to 12 in the
validator. Back-compat is preserved: single-session callers send the
legacy shape, multi-session callers send the new shape, never both.

```ts
// legacy (single)
{ type: 'subscribe', session_id: 'sess_abc' }

// new (multi)
{ type: 'subscribe', session_ids: ['sess_a', 'sess_b', 'sess_c'] }
```

The hub holds a `Set<string>` on the per-connection state. Each
`subscribe` REPLACES the set (it does not merge). Activity events
(`thinking`, `text_delta`, `tool_use`, `tool_result`, `assistant_message`,
`status`) route through `broadcastToSubscribers(sessionId)` which checks
set membership.

If the client sends a `session_ids` array of length > 12, the hub replies
with:

```ts
{ type: 'subscribe_error', error: 'too_many_sessions', max: 12 }
```

…and leaves the existing set untouched. The 12-cap was chosen to bound
both client memory (12 virtualized message lists) and the per-IP
connection budget (`maxConnectionsPerIp = 20`) — the grid intentionally
uses one socket per browser regardless of cell count.

## Initial-history endpoint

```
GET /api/sessions/messages?ids=a,b,c&limit=30
→ 200 { "sess_a": Message[], "sess_b": Message[], "sess_c": Message[] }
```

One round-trip per tab activation, not N round-trips. `ids` length is
capped at 12 (server returns 400 otherwise). `limit` defaults to 30 and
is hard-capped at 100. Used exclusively by `GridPage` to seed all cells
of a tab on activation; each `ChatSurface` then takes over via its own
WS subscription.

On any error, individual cells fall back to the existing
`/api/messages/:sessionId` endpoint per-cell — degradation is graceful,
just slower.

## Breakpoint behavior

CSS-first via Tailwind `md:` breakpoint (768px). `GridPage` renders TWO
siblings:

```tsx
<div className="hidden md:flex flex-col flex-1 min-h-0">
  {/* desktop tab bar + CSS grid */}
</div>
<div className="md:hidden flex-1 min-h-0">
  <MobileAccordion ... />
</div>
```

No JS viewport detection. The browser hides one or the other based on
viewport width.

### Why `100dvh` / `100svh`, not `100vh`

`MobileAccordionRow` sizes the expanded chat as `aspect-ratio: 1/1` with
`max-height: 100dvh`. Never `100vh` — iOS Safari's `vh` includes the
keyboard area and collapses the layout when the textarea is focused.
`100dvh` (dynamic) shrinks with the keyboard; `100svh` (small viewport)
is the most conservative bound. Both are honored across the grid and
accordion.

### Unmount on collapse

When a mobile accordion row collapses, its `<ChatSurface>` UNMOUNTS — not
just `hidden`. Only one ChatSurface is in the React tree on mobile. Its
WS subscription drops; on re-expand it resubscribes and refetches the
last 30. Render cost on a phone is the driver, not WS load.

## Performance design

### RAF coalescing

`<ChatSurface>` (all densities, but especially `cell`) MUST coalesce
inbound `text_delta` events via `requestAnimationFrame`. Raw deltas
accumulate in a ref; one React state update flushes per frame. The
coalescer lives in `web/src/lib/raf-batch.ts`.

Hub-side throttling is **forbidden** — it would break the
scheduled-tasks event-ordering contract documented in
[docs/scheduled-tasks.md](scheduled-tasks.md). The hub forwards every
event verbatim; coalescing is purely a render-time optimization.

### Virtualization

The message list inside `ChatSurface` is virtualized with
`@tanstack/react-virtual` for ALL densities. One implementation, three
densities — no per-density fork. This is what makes 12 cells × 5
msg/sec feasible: scroll-rendering is bounded by viewport, not history
length.

### One socket regardless of cell count

The grid uses ONE WebSocket per browser. Per-IP cap stays at 20. The
hub's `broadcastToSubscribers(sessionId)` is O(connections-subscribed-to-sessionId),
not O(cells).

## Active-cell tracking

`GridPage` tracks an `activeCellId` per tab in component state +
`sessionStorage` (`grid:lastActiveCell:<tabId>`), NOT URL — too noisy.
The first visible cell becomes active on tab open.

Paste/drop attachment handlers are scoped by the active cell:

- Each cell root carries `data-chat-surface-cell-id="<sessionId>"`.
- `ChatSurface` handles paste on its own textarea + drop on its own root
  — when focus is inside a cell, that cell handles it.
- A `GridPage`-level document paste handler covers the remaining case
  (focus is outside all cells, e.g. on the tab chip or page background)
  — it synthesizes a paste event into the active cell's textarea so the
  attachment lands in the right cell.

The scoping rule: if `document.activeElement.closest('[data-chat-surface-cell-id]')`
matches ANY cell, the global handler bails and lets the cell handle it.

## Accessibility & keyboard

The grid is a WAI-ARIA tabs + grid widget:

- **Tab bar** — `role="tablist"`. Each chip is `role="tab"` with
  `aria-selected`, `aria-controls="grid-tab-panel"`, and a roving
  `tabIndex` (only the active chip is 0). Arrow keys move focus, Home/End
  jump to ends, Enter/Space activate, **F2** or **double-click** starts
  inline rename. Enter commits, Escape cancels, blur commits.
- **Grid** — `role="grid"` with `aria-label` carrying the visible count
  vs. total. Each cell is `role="gridcell"` with `aria-selected` for the
  active cell.
- **Layout picker** — `role="listbox"` with `role="option"` children and
  `aria-selected` on the current layout.
- **Tab bar overflow** — `overflow-x-auto` with `scroll-snap-type:
  x_proximity` so a long tab row scrolls cleanly without wrapping.

### Tab delete confirmation

The native confirm dialog now includes the count of session bindings that
will be unbound (`"removes N session bindings"`) and warns when the user
is about to delete their only remaining tab. **Last-tab protection:** if
the user does delete the only tab, the page immediately creates a fresh
empty tab and routes to it so the user is never left in an empty-state
route with no active tab.

### Unread indicator (inactive cells)

Each cell tracks a per-session unread counter. It increments when a
server-emitted assistant `message` event arrives for a visible cell that
is **not** the currently-active cell. `text_delta` does NOT count — the
goal is "one ding per reply," not one per token. Activating the cell
clears its counter.

A page-level `role="status" aria-live="polite"` region announces only the
total unread count (e.g. `"3 unread messages across cells"`), never the
message content. Screen readers stay quiet during high-frequency streams
but still surface the fact that background work has progressed.

## Scheduled-task queue badge per cell

Each cell header has a slot for a small badge when the cell's session has
a scheduled task in-flight or waiting in the per-session queue:

- **Amber dot** — task waiting in the queue.
- **Indigo spinner** — task in-flight.
- **Tooltip** — task name.

Wired against the per-session queue state in
`hub/src/scheduler/session-queue.ts`. See
[docs/scheduled-tasks.md](scheduled-tasks.md) for the queue model.

> **In-flight:** the wire-up hook is stubbed in `GridCell` with a `TODO`
> comment pending `useSessionQueueState` (see PLAN-004 T7). The badge
> renders nothing until the hook ships; rest of the grid is unaffected.

## Deferred items

Out of scope for Phase 03 — queued as separate phase candidates:

- Per-cell resize size persistence (cells resize at runtime but layout
  snapshot is not saved per-tab; only the `layout` mode is).
- Cross-user tab sharing (collaboration).
- Per-cell mute / notification suppression.
- "Pop out cell to new window" (multi-window orchestration).
- Drag-and-reorder cells within a tab via DnD (up/down buttons in v1).
- Drag-and-reorder cells across tabs.
- Infinite scroll within cells (initial 30 + load-more button in v1).
- Mobile tab picker (mobile v1 always shows the current tab's
  accordion; switch tabs from desktop until users ask).
- Cross-tab session search.
- Tab templates / preset layouts.
- Keyboard shortcuts for tab and cell navigation (cmd-1..9 etc.).
- Web-side automated test harness (still no Vitest / Playwright — manual
  smoke is the gate).

---

See also: [CLAUDE.md](../CLAUDE.md) (project guidance),
[docs/scheduled-tasks.md](scheduled-tasks.md) (scheduler architecture and
per-session queue model).
