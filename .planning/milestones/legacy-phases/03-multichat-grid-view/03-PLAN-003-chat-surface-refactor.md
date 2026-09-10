---
plan_id: 03-PLAN-003-chat-surface-refactor
wave: 2
depends_on: [03-PLAN-002-ws-multi-subscribe]
files_modified:
  - web/package.json
  - web/src/components/ChatSurface.tsx
  - web/src/components/ChatPanel.tsx
  - web/src/components/Layout.tsx
  - web/src/lib/raf-batch.ts
  - web/src/hooks/useChatSurface.ts
autonomous: true
requirements: [R05, R11, R12, R13]
---

# Plan 03-003 — Extract `<ChatSurface>` with density variants + RAF coalescing + virtualization

<tasks>

<task id="T1">
<action>Add `@tanstack/react-virtual` to `web/package.json` dependencies (latest stable 3.x). Run `bun install` from `web/`. Sanity import once in a scratch file to verify it resolves under Vite + TS, then delete the scratch. Document the new dep in CLAUDE.md's "Dependencies" section in PLAN-006 (do NOT update CLAUDE.md in this plan — that's PLAN-006's job).</action>
<read_first>
- web/package.json (confirm the exact React 19 version constraint compatibility — @tanstack/react-virtual 3.x supports React 18/19)
</read_first>
<acceptance_criteria>
- `bun install` completes without peer-dep warnings about React
- `import { useVirtualizer } from '@tanstack/react-virtual'` type-checks
- `bun run build:web` (from repo root) succeeds
</acceptance_criteria>
</task>

<task id="T2">
<action>Create `web/src/lib/raf-batch.ts`. Export `createRafBatcher<T>(flush: (batch: T[]) => void)` returning `{ push(item: T): void; cancel(): void }`. Implementation: `push` appends to an internal `pending: T[]`; if no `requestAnimationFrame` is scheduled, schedule one whose callback drains `pending` into `flush` and clears the scheduled-flag. `cancel` calls `cancelAnimationFrame` if scheduled and clears `pending`. No external deps. Pure TS.</action>
<read_first>
- web/src/hooks/useChat.ts (so the batcher matches the kinds of values it'll batch — likely string deltas)
</read_first>
<acceptance_criteria>
- 10 synchronous `push` calls within one tick result in exactly ONE `flush(batch)` call where `batch.length === 10`
- After `cancel()`, no `flush` is invoked
- File has no React imports — pure utility
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `web/src/hooks/useChatSurface.ts`. Owns ONE session's subscription lifecycle for a `<ChatSurface>`: takes `sessionId`, returns `{ messages, activity, status, sendMessage, attach, ... }`. Internally: on mount, asks the shared GridPage-level subscription manager to include this `sessionId` in the connection's subscribed set (or, for `density="full"`, calls `subscribe(sessionId)` directly — back-compat path). On unmount, asks to remove it. Uses `createRafBatcher` to coalesce inbound `text_delta` events — accumulate deltas in a ref, flush once per animation frame via `setMessages` (or whichever state setter holds the streaming assistant message). Initial history: fetched via `GET /api/sessions/messages?ids=<sid>&limit=30` if not provided by parent (the GridPage will pass a `seedMessages` prop to avoid N round-trips).</action>
<read_first>
- web/src/hooks/useChat.ts (the current per-session hook — model the new hook on it but factor out the global-state assumption)
- web/src/hooks/useWebSocket.ts (after PLAN-002 — subscribe API)
- web/src/components/ChatPanel.tsx (understand which events get rendered: thinking, text_delta, tool_use, tool_result, status, assistant_message)
</read_first>
<acceptance_criteria>
- Mounting two `useChatSurface('a')` and `useChatSurface('b')` results in ONE subscribe frame with `session_ids: ['a','b']` (NOT two frames) — verified by stub in T6 or by devtools
- Unmounting `'a'` resends subscribe with `['b']` only
- 60 inbound `text_delta` events in 1s produce ≤ 60 React state updates AND ≥ 50 (i.e. RAF-coalesced, not per-event) — measured by a stubbed setState spy
- Hook works in isolation with no GridPage parent (full density single-chat case)
</acceptance_criteria>
</task>

<task id="T4">
<action>Create `web/src/components/ChatSurface.tsx`. Props: `{ sessionId: string; density: 'full' | 'cell' | 'mobile-expanded'; seedMessages?: Message[]; onActivate?: () => void; className?: string }`. Renders header (session name + status dot + scheduled-task badge slot for PLAN-004), virtualized message list (`@tanstack/react-virtual`), activity feed (thinking/tool blocks below the last message), and input bar with attachment support. Reuses existing primitives: `MessageBubble`, `ThinkingBlock`, `ToolUseBlock`, `ActivityFeed`, `FileAttachmentBar`. Density variants apply Tailwind class differences (font size, padding, header height, input height) and a `compact` flag for the input. The virtualizer wraps the message list for ALL three densities — one implementation.</action>
<read_first>
- web/src/components/ChatPanel.tsx (full file — this is what's being extracted from)
- web/src/components/MessageBubble.tsx, ActivityFeed.tsx, ThinkingBlock.tsx, ToolUseBlock.tsx, FileAttachmentBar.tsx
- web/src/components/SettingsPage.tsx (visual baseline — `bg-secondary/60`, `rounded-xl`, indigo accents)
- @tanstack/react-virtual docs (verify via context7 if API uncertainty — but the API is stable: `useVirtualizer({ count, getScrollElement, estimateSize })`)
</read_first>
<acceptance_criteria>
- The three density variants are visibly distinct: `full` matches today's ChatPanel chrome; `cell` is ~25% smaller in font/padding with a slim header; `mobile-expanded` uses `aspect-ratio: 1/1` with input pinned to the bottom of the panel
- Scrolling the message list is virtualized — DOM contains only visible rows + a small overscan, verified by inspecting node count for a 200-message session
- Streaming an assistant turn shows the in-progress text growing smoothly via RAF coalescing (no per-character React rerenders)
- Component is self-contained; pasting an image and submitting works in all three densities
</acceptance_criteria>
</task>

<task id="T5">
<action>Refactor `web/src/components/ChatPanel.tsx`: keep the file as a thin wrapper that renders `<ChatSurface density="full" sessionId={activeSessionId} />` plus any single-chat-only chrome that doesn't belong inside the surface (e.g. sidebar toggle, breadcrumbs). All message/activity/input logic moves into `<ChatSurface>`. `web/src/components/Layout.tsx` continues to import `ChatPanel` — no change to Layout's API. End result: visiting `#/chat` looks and behaves identically to before.</action>
<read_first>
- web/src/components/ChatPanel.tsx (current file)
- web/src/components/Layout.tsx (how ChatPanel is wired)
</read_first>
<acceptance_criteria>
- `ChatPanel.tsx` shrinks substantially (≥ 70% of its non-wrapping logic moves to `ChatSurface.tsx`)
- Visiting `#/chat` after refactor: send a message, see streaming response, paste an image, submit — all work identically to pre-refactor
- No new props leak through `Layout` → `ChatPanel`
</acceptance_criteria>
</task>

<task id="T6">
<action>Add a tiny dev-only stub at `web/src/components/ChatSurfaceShowcase.tsx` (gated behind `?showcase=1` query param or hash `#/dev/chat-surface`) that mounts three `<ChatSurface>` instances side-by-side at the three densities with a hard-coded fake session for visual inspection. NOT exported in production. Used only as a manual smoke harness during development. Remove before final commit OR leave behind the hash gate — either is acceptable. State the choice in the PR body.</action>
<read_first>
- web/src/App.tsx (route handling, to gate by hash if you choose that route)
</read_first>
<acceptance_criteria>
- Visiting `#/dev/chat-surface` in dev mode renders three densities side-by-side
- Visiting any other route does NOT include the showcase component in the bundle (verify by `bun run build:web` then grep dist for the component name — should be absent if route-gated; allowed if behind a runtime check that doesn't gate the bundle)
- No production code imports the showcase
</acceptance_criteria>
</task>

</tasks>

must_haves:
- `<ChatSurface>` exists with three densities; all three subscribe via the multi-subscribe path
- RAF coalescing is in `useChatSurface`; no hub-side throttling was added (would break scheduled-tasks event-ordering)
- The message list is virtualized via `@tanstack/react-virtual` in all three densities
- `#/chat` behaves IDENTICALLY to pre-refactor (R12 verified manually)
- 12 cells × 5 msg/sec causes no dropped events and no UI freeze (manual measurement — formal R13 test sits in PLAN-006)
