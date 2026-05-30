# Chat / Assistant UI — Reusable Architecture Spec

> **Source of truth** for the remo-code chat surface and the **canonical chat/assistant UI pattern** for every other app the team builds. This doc maps the real implementation (file:line evidence) and defines the **transport-agnostic seam** that makes the surface portable.
>
> Companion global pointer: `~/.claude/architecture-preferences.md` → "Canonical Chat / Assistant UI". That file establishes this as the default; this file is the implementation-grounded spec.

All paths below are relative to the repo root (`web/`, `hub/`) unless absolute.

---

## 1. Overview + when to use

`<ChatSurface>` is a **self-contained chat surface for ONE agent session**. It renders a full conversational UI with live agent feedback and a rich input composer, and it owns (optionally) its own data lifecycle. Use it whenever an app shows a **conversation with an AI agent** and you want any of:

- **Streaming feedback** — live thinking, streaming text, tool-use / tool-result, status, all updating in real time.
- **Rich response rendering** — markdown (GFM, sanitized), collapsible thinking blocks, collapsible tool-call blocks, code blocks, tables.
- **Inline permission approve/deny** and **inline question answer** round-trips with the agent.
- **Attachments** — paste image, drag-drop, and a file-picker button; images become base64 data URIs, text files inline into the message.
- **Microphone / voice input** — record → transcribe (Whisper) → insert into the composer.
- **Slash commands / skills** — a `/` menu populated from the host's command catalog.
- **CSS-variable theming** + three **density** variants (`full`, `cell`, `mobile-expanded`).

It is built for the Claude-Code `stream-json` event model but **the rendering + composer core is transport-agnostic** — see §4. The remo-code transport (`/ws/client`) is just one adapter.

Density variants (`web/src/components/ChatSurface.tsx:23-25`):
- `full` — the single-chat page chrome (the `ChatPanel` look).
- `cell` — compact grid cell (smaller fonts, slim input, ≤30 initial msgs).
- `mobile-expanded` — square (`aspect-ratio: 1/1`), input pinned to bottom, `100dvh` cap.

---

## 2. Component tree + responsibilities

```
ChatLayout.tsx ............ page shell: sidebar, session list, header, wires hooks → ChatPanel (full mode)
  └─ ChatPanel.tsx ........ thin wrapper: parent-owned <ChatSurface density="full">
       └─ ChatSurface.tsx . THE embeddable entry point (input composer, mic, attachments,
                            virtualized list, density). Self-owned OR parent-owned data.
            ├─ FileAttachmentBar.tsx . attachment chips above the composer
            ├─ MessageBubble.tsx ..... one persisted message (markdown render)
            └─ ActivityFeed.tsx ...... ephemeral live activity for the active turn
                 ├─ ThinkingBlock.tsx ...... collapsible "Thinking…" block
                 ├─ ToolUseBlock.tsx ....... collapsible tool call + result
                 ├─ PermissionBlock.tsx .... inline Allow / Deny
                 └─ QuestionBlock.tsx ...... inline free-text answer

GridPage.tsx ............. renders many <ChatSurface density="cell"> (multichat, up to 12)
ChatSurfaceShowcase.tsx .. dev showcase of all 3 densities (route #/dev/chat-surface) — canonical usage example
```

### `ChatSurface` — the single embeddable entry point

File: `web/src/components/ChatSurface.tsx`. Owns: input composer, slash menu, attachments, mic/voice, virtualized message list (`@tanstack/react-virtual` for **all** densities, `:33-34`), auto-scroll + "↓ N new" badge, density styling, and (in self-owned mode) the data lifecycle via `useChatSurface`.

**Dual data ownership** — the key reuse lever (`:27-34`, `:49-77`):

- **Parent-owned** (`OwnedDataProps`, `:49-57`): caller passes `messages`, `loading`, `activity`, `onSend`, `onPermissionRespond`, `onQuestionRespond`. Surface is purely presentational. Used by `ChatPanel` for `density="full"`.
- **Self-owned** (`SelfOwnedDataProps`, `:63-75`): caller passes the `useWebSocket` tuple — `subscribe`, `send`, `connectionId`, optional `seedMessages`. Surface subscribes itself via `useChatSurface(sessionId)` (`:181-185`). Used by `GridPage` cells + the mobile-expanded variant.

Props union: `export type ChatSurfaceProps = BaseProps & (OwnedDataProps | SelfOwnedDataProps)` (`:77`).

`BaseProps` (`:36-47`): `sessionId`, `density`, `wsConnected?`, `online?`, `token?`, `className?`, `onActivate?` (focus/click — used by GridPage to mark active cell), `onCancel?` (parent-owned Stop handler).

Cancel is unified (`:160-170`): parent-owned routes through `onCancel`; self-owned fires `{ type: 'cancel', session_id }` directly via `send`.

Limits (`:79-81`): `MAX_FILES = 5`, `MAX_TEXT_SIZE = 1 MB`, `MAX_IMAGE_SIZE = 10 MB`.

### `ChatPanel` — full-mode wrapper

File: `web/src/components/ChatPanel.tsx`. Thin adapter that renders `<ChatSurface density="full" …>` with parent-owned props supplied by `ChatLayout`. Exists so the page chrome owns the global `useChat` + `useActivity` data while the surface stays presentational.

### `ChatLayout` — page shell

File: `web/src/components/ChatLayout.tsx`. Owns the sidebar/session list, header, mobile `SessionDropdown`, and wires the data hooks (`:51-55`): `useSessions`, `useChat`, `useActivity`. Defines the global response handlers (`:58-72`):
- `handlePermissionRespond` → `send({ type:'permission_response', session_id, request_id, approved })`
- `handleCancel` → `send({ type:'cancel', session_id })`
- `handleQuestionRespond` → `send({ type:'question_response', … })`

This is **remo-code app chrome**, not part of the portable surface.

### `MessageBubble` — one persisted message

File: `web/src/components/MessageBubble.tsx`. Renders a single `ChatMessage`. Markdown via **`react-markdown`** with `remark-gfm` (tables/strikethrough/task-lists) and `rehype-sanitize` (XSS-safe) (`:1-3`, `:101-112`). Custom renderers: links open in a new tab with `rel="noopener noreferrer"` (`:105-107`); tables get a horizontal-scroll wrapper (`:108-110`). Prose styling is all CSS-variable driven (code → `--code-bg`, borders → `--border-color`). Strips remo-code-specific message envelopes (`parseScheduledPrefix`, `parseRevanotePrefix`, `:5-6`) — **app-specific, see §8**. Shows timestamp + interrupted status (`:115-117`).

### `ActivityFeed` — ephemeral live activity

File: `web/src/components/ActivityFeed.tsx`. Renders the **current turn's** ephemeral activity from `ActivityState`, in order (`:38-62`):
1. `ThinkingBlock` (when `thinkingText`),
2. each `ToolUseBlock` (`activity.toolCalls`),
3. `PermissionBlock` (when `pendingPermission`),
4. `QuestionBlock` (when `pendingQuestion`),
5. streaming text (live markdown of `activity.streamingText` + a blinking cursor while `status === 'writing'`, `:66-76`).

It renders only while `activity.status !== 'idle'` or a block is pending (`:16`). The **final** assistant text persists as a `MessageBubble`; everything in `ActivityFeed` is transient (see §5.3). `ActivityFeed` is mounted as the **last virtual row** of the list (`ChatSurface`, after the messages) so live activity scrolls inline beneath history.

### `ThinkingBlock`, `ToolUseBlock`, `PermissionBlock`, `QuestionBlock`

- `ThinkingBlock.tsx` — collapsible. 100-char preview when collapsed (`:13`); amber pulsing dot while streaming, blinking caret in expanded body (`:22-26`, `:40`). Returns `null` on empty content.
- `ToolUseBlock.tsx` — collapsible. Header shows tool name (mono), status icon (spinner / green check / red ✕ via `is_error`, `:19-45`). Expanded shows `input` JSON (truncated 500 chars) + `result` (truncated 1000 chars) (`:62-71`).
- `PermissionBlock.tsx` — amber card; shows `tool_name` + `tool_input` (pretty JSON, truncated 1000, `:17-40`). **Allow / Deny** buttons call `onRespond(request_id, approved)` then lock to "Response sent" (`:9-15`, `:43-60`).
- `QuestionBlock.tsx` — inline free-text answer → `onRespond(request_id, answer)`.

### `FileAttachmentBar`

File: `web/src/components/FileAttachmentBar.tsx`. Pure presentational chip row above the composer. One chip per `AttachedFile` (`{ file, type }`): icon (image vs text), name, KB size, remove ✕ → `onRemove(index)`. Returns `null` when empty. Exports `AttachedFile`.

### `ChatSurfaceShowcase` — canonical usage example

File: `web/src/components/ChatSurfaceShowcase.tsx`. Gated behind `#/dev/chat-surface`. Renders all three densities side-by-side using `useWebSocket(token)` and a fake `sessionId`. This is the **copy-paste reference** for embedding the surface (self-owned mode):

```tsx
const { connected, connectionId, send, subscribe } = useWebSocket(token)
<ChatSurface
  density="full"            // | "cell" | "mobile-expanded"
  sessionId={fakeId}
  subscribe={subscribe}
  send={send}
  connectionId={connectionId}
  token={token}
  wsConnected={connected}
/>
```

---

## 3. State & hooks

All hooks live in `web/src/hooks/`.

### `useChatSurface(args)` — `useChatSurface.ts`

The per-session data engine for **self-owned** surfaces. Wire-compatible with the global `useChat` + `useActivity` pair (returns the same shapes, `:11-13`).

**Args** (`UseChatSurfaceArgs`, `:24-34`):
```ts
{
  sessionId: string | null
  token: string
  subscribe: (handler: (msg: any) => void) => () => void   // ← transport seam
  send: (msg: object) => void                              // ← transport seam
  connectionId: number                                      // bumps on reconnect → re-subscribe
  seedMessages?: ChatMessage[]   // pre-fetched (e.g. GridPage bulk fetch); honored only at mount (:89)
  historyLimit?: number          // default 30 (Phase-03 locked: cells must not pull full history, :15-17)
}
```

**Returns:** `{ messages, loading, activity, sendMessage, respondPermission, respondQuestion }`.

**Responsibilities:**
- Fetch initial history (`GET …?limit=historyLimit`) unless `seedMessages` given (`:64-91`).
- On subscribe: `send({ type:'subscribe', session_ids:[sessionId] })` (`:97`).
- **`text_delta` RAF-coalescing** (`:99-118`): deltas accumulate in a `createRafBatcher`, flushed **once per animation frame** as a single `setMessages` (grouped by `message_id`, appended to the matching placeholder). Hub-side throttling is **forbidden** — it would break the scheduled-tasks event-ordering contract (`:19-21`).
- `type:'message'` → upsert by `message.id` (`:124-132`).
- Builds the `ActivityState` (thinking / streamingText / toolCalls / pendingPermission / pendingQuestion) from the live event stream — same logic as `useActivity`.

### `useActivity(activeSessionId, subscribe)` — `useActivity.ts`

Builds **ephemeral** `ActivityState` for the global/full path from the live event stream (`:54-154`). Event handling:
- `status` → `activity.status` (`:67-81`)
- `thinking` → append to `thinkingText` (`:84-86`)
- `text_delta` → append to `streamingText` (`:89-92`)
- `tool_use` → push `{ tool, tool_id, input, done:false }` (`:94-…`)
- `tool_result` → match `tool_id`, set `result`/`is_error`/`done:true`
- `permission_request` → `pendingPermission`; `user_question` → `pendingQuestion`
- `agent_log` → `agentLogs`

**Resets to `INITIAL_STATE` on session switch** (`:147-151`). Uses a `stateRef` + `setActivity({…stateRef.current})` so rapid events don't drop updates.

**`ActivityState` shape** (`:46-52`): `{ status, thinkingText, streamingText, toolCalls, pendingPermission, pendingQuestion, agentLogs }`. Event/type exports at `:3-7` (`ThinkingEvent`, `TextDeltaEvent`, `ToolUseEvent`, `ToolResultEvent`, `StatusEvent`, …).

### `useChat(token, activeSessionId, subscribe, send, connectionId)` — `useChat.ts`

The **persisted-message** store for the global/full path (`:30-…`). Holds `messages`, `loading`, `unreadCounts` (localStorage-backed, `:39`). Key behaviors:
- Refetch on tab visibility/focus and on **WS reconnect** (`connectionId` change, `:117-123`) to backfill `text_delta` events missed while disconnected.
- `type:'message'` → insert/update; bumps `unreadCounts` for non-active sessions that are streaming (`:163-170`).
- `type:'text_delta'` → append delta to the matching placeholder bubble (`:202-…`) — the bubble is already persisted, so a hub restart preserves partial text.
- `type:'send_refused'` → synthesize a transient `⚠ <reason>` assistant bubble in the active session so the user sees **why** a send was dropped (offline/quota) (`:177-…`).

Returns `{ messages, loading, sendMessage, unreadCounts }`.

### `useWebSocket(token)` — `useWebSocket.ts` (the remo-code transport)

The **remo-code-specific** WS adapter. Provides the `subscribe`/`send`/`connectionId`/`connected`/`online` tuple every surface consumes. This is the concrete implementation of the §4 transport seam. Responsibilities:
- Connect to `/ws/client`, auth via `__Host-remo_sid` cookie (empty `{type:'auth'}`) or bearer `token` (soak path) (`:133-138`).
- `connectionId` bumps on each successful auth → consumers re-subscribe (`:77-78`).
- **Offline durability**: persists user-originated payloads (`send_message`/`permission_response`/`question_response`/`cancel`) to localStorage (`PENDING`/`INFLIGHT`, `:32-37`); replays in-flight (un-ACK'd) messages on reconnect to survive half-open sockets (`:88-96`).
- **CSRF**: WS messages that mutate state carry `csrf_token` (cookie echo) (`:6-11`).
- Heartbeat (`ping`/`pong`); no auto-reconnect on terminal close codes (e.g. stale JWT → 4001, `:13-15`).
- `online` reflects `navigator.onLine` for an accurate "Offline" vs "Reconnecting…" banner (`:73-76`).

`subscribe(handler)` registers a handler in a `Set` and returns an unsubscribe (`:81`). **This is the only file an adapting app must replace.**

### `useCommands(token)` — `useCommands.ts`

Powers the slash menu. Fetches `GET /api/commands` → `{ commands: CommandRow[] }`. `CommandRow`: `{ id, supervisor_id, kind:'command'|'skill', name, description, source, path, synced_at }`. Helpers: `groupCommands` (Built-in / User / Plugin:<name> / Skills groups), `filterCommands(rows, q)` (name/description/source substring), `sortByName`. The **command catalog endpoint is app-specific**; the menu UI is portable (see §5.6).

---

## 4. Transport contract — the reuse seam

**This is the heart of portability.** The surface never knows about WebSockets, cookies, or sessions. It interacts with the host through exactly **two function props** plus a reconnect signal:

```ts
interface ChatTransport {
  /** Subscribe to the live event stream for the current session.
   *  Returns an unsubscribe fn. Host MAY pre-filter by session_id (events
   *  also carry session_id; the surface re-checks and ignores mismatches). */
  subscribe: (handler: (event: ChatEvent) => void) => () => void

  /** Send a client→host message (fire-and-forget; host handles delivery/queueing). */
  send: (msg: ClientMessage) => void

  /** Monotonic counter that increments on every (re)connect. Surface uses it
   *  to re-subscribe + backfill missed events after a reconnect. */
  connectionId: number
}
```

### Inbound events the surface consumes (`ChatEvent`)

Every event carries `session_id`. The surface/hooks branch on `type`:

| `type` | Payload | Consumed by | Effect |
|---|---|---|---|
| `message` | `{ message: ChatMessage }` | useChat/useChatSurface | upsert persisted bubble |
| `text_delta` | `{ message_id, content }` | useChat/useChatSurface | RAF-coalesced append to placeholder |
| `thinking` | `{ content }` | useActivity | append `thinkingText` |
| `tool_use` | `{ tool, tool_id, input }` | useActivity | push tool call (spinner) |
| `tool_result` | `{ tool_id, content, is_error? }` | useActivity | resolve tool call |
| `status` | `{ state }` (`idle`/`thinking`/`writing`/…) | useActivity | drive status indicator |
| `permission_request` | `{ request_id, tool_name, tool_input }` | useActivity | show `PermissionBlock` |
| `user_question` | `{ request_id, … }` | useActivity | show `QuestionBlock` |
| `agent_log` | `{ … }` | useActivity | append `agentLogs` |
| `send_refused` | `{ session_id, reason }` | useChat | synthesize ⚠ bubble |

`ChatEvent` shapes are mirrored in `web/src/hooks/useActivity.ts:3-7` (consumer side) and validated on the hub in `hub/src/ws/protocol.ts` (producer side).

### Outbound messages the surface emits (`ClientMessage`)

Validated server-side in `hub/src/ws/protocol.ts` (the `ClientInbound` union):

| `type` | Schema (hub) | Emitted when |
|---|---|---|
| `subscribe` | `{ session_id? \| session_ids?[] }` (`ClientSubscribe`) | hook mounts / reconnects |
| `send_message` | `{ session_id, content(1..1e6 trimmed), id(uuid), images?[{media_type,data≤10MB}]≤5 }` (`ClientSendMessage`) | user submits |
| `permission_response` | `{ session_id, request_id, approved, csrf_token? }` (`ClientPermissionResponse`) | Allow/Deny |
| `question_response` | `{ session_id, request_id, answer, csrf_token? }` (`ClientQuestionResponse`) | answer submitted |
| `cancel` | `{ session_id }` | Stop button |

### How remo-code satisfies the seam

`useWebSocket(token)` (§3) returns `{ subscribe, send, connectionId, connected, online }` over `/ws/client` with opaque-cookie auth, CSRF echo, offline queue, and heartbeat. The whole transport is **one file**.

### What another app implements

Implement a hook returning the same `{ subscribe, send, connectionId }` tuple over **any** transport:

- **REST + SSE** (the house default per architecture-preferences): `send` = `POST /chat/:id/message`; `subscribe` = an `EventSource('/chat/:id/stream')` whose `onmessage` parses `ChatEvent` and fans out to handlers; `connectionId` bumps in `EventSource.onopen`. Map permission/question responses to small `POST` routes.
- **socket.io**: `send` = `socket.emit(msg.type, msg)`; `subscribe` = register `socket.onAny`; `connectionId` bumps on `connect`.
- **Claude Agent SDK stream (in-process)**: drive the surface directly from an SDK async iterator — translate SDK stream events into `ChatEvent`s in a `subscribe` shim; `send` pushes a user turn into the SDK loop. No server needed for a desktop/Tauri single-user app.

As long as the adapter emits the `ChatEvent` shapes and accepts the `ClientMessage` shapes, the entire rendering + composer + attachment + mic + slash + permission stack works unchanged.

---

## 5. Feature specs

### 5.1 Attachments

**Behavior:** three entry points — paste image, drag-drop, file-button — accumulate into `attachedFiles: AttachedFile[]` (chip row via `FileAttachmentBar`); on submit, images go out as base64 data URIs and text files inline into message content.

**Components/hooks:** `ChatSurface.tsx` (`addFiles`/`handleDrop`/`handleDragOver`/`handleRemoveFile`, `fileToBase64`, `readFileAsText`, `classifyFile`), `FileAttachmentBar.tsx`.

**Data contract:**
- `classifyFile(file)` → `'image'` (`type` starts `image/`) | `'text'` (text MIME or known code/text extension allow-list) | `null` (rejected). (`ChatSurface.tsx`, `classifyFile`.)
- `addFiles` caps at `MAX_FILES=5`, drops oversized files silently (`type==='text' && size>1MB` or `type==='image' && size>10MB`) (`ChatSurface.tsx`, addFiles size guard).
- On submit (`handleSubmit`): text files → `content += "[Attached file: <name>]\n<text>\n\n"`; images → `fileToBase64` → `{ media_type, data }` pushed to `images[]`. `fileToBase64` reads a data-URL and splits header/payload (`media_type = header.split(':')[1].split(';')[0]`). If only images and no text, content defaults to `"[Image attached]"`. Then `onSend(content, images)`.
- Wire cap: `ClientSendMessage.images` ≤ 5, each `data` ≤ `10_000_000` base64 chars (~7.5 MB raw) (`hub/src/ws/protocol.ts`).

**Edge cases:** oversized/over-count/unclassifiable files are dropped without an error toast (intentional — keep composer quiet); draft text persists to localStorage per session and is cleared on send.

**Reuse notes:** fully portable — depends only on `onSend(content, images)`. The `[Attached file: …]` inlining convention is a UI choice; the host just receives content + base64 images.

### 5.2 Mic / Voice

**Behavior:** press mic → record audio → on stop, POST the blob to the hub → Whisper transcription → transcript **inserted into the composer** (not auto-sent). Voice is meaningful only in `full` density but the wiring is identical across densities.

**Components/hooks:** `ChatSurface.tsx` voice block — state `recording`/`transcribing`/`recError`/`recElapsed`; refs `mediaRecRef`/`mediaStreamRef`/`audioChunksRef`/`recCancelledRef`/`recTimerRef`/`recHardStopRef`; fns `startRecording`/`stopRecording`/`cleanupRecording`/`transcribeBlob`.

**Capture/encode flow** (`startRecording`):
1. `navigator.mediaDevices.getUserMedia({ audio: true })`.
2. Prefer `audio/webm;codecs=opus`, fall back to `audio/webm`, then default.
3. `MediaRecorder` collects chunks via `ondataavailable`; a `REC_MAX_MS` hard-stop timer caps duration; an elapsed timer drives the UI.
4. `onstop` → assemble `Blob` (skipped if cancelled) → `transcribeBlob`.

**Transcription** (`transcribeBlob` → `hub/src/api/transcribe.ts`):
- `POST {hubUrl}/api/transcribe`, `multipart/form-data` field `audio`, `Authorization: Bearer <token>`, `X-CSRF-Token` (cookie echo), `credentials: 'include'`.
- Hub forwards to OpenAI `https://api.openai.com/v1/audio/transcriptions`, model `OPENAI_TRANSCRIBE_MODEL || 'whisper-1'`. Limits: empty → 400, `> MAX_AUDIO_SIZE` (25 MB) → 413.
- Response `{ text }` → trimmed → appended to composer input (space-joined), textarea refocused. Empty → "No speech detected".

**UI states:** idle mic icon → red pulsing stop icon while recording (with elapsed) → transcribing spinner → error text (`recError`). Permission denial maps `NotAllowedError` → "Microphone permission denied"; other failures → "Microphone unavailable" / "Network error during transcription".

**Edge cases:** cancel path discards chunks; `cleanupRecording` always clears timers + stops the media stream tracks (also on unmount); slash menu is suppressed while recording.

**Reuse notes:** the client recorder is 100% portable. The **only coupling is the `/api/transcribe` endpoint** — a host app must provide an equivalent (any Whisper-compatible transcription proxy) and the surface keeps the OpenAI key server-side. For a Tauri/desktop app, swap the `fetch` for a local transcription command.

### 5.3 Streaming activity feed

**Behavior:** during an agent turn, thinking → tool calls → streaming text appear live and inline beneath history; when the turn finishes, the final assistant text persists as a normal `MessageBubble` and the ephemeral activity clears.

**Components/hooks:** `useActivity` / `useChatSurface` (state machine), `ActivityFeed` + its child blocks (render).

**Data contract:** the `ChatEvent` stream in §4 drives `ActivityState`. `ActivityFeed` renders only while `status !== 'idle'` or a block is pending. The feed is the **last virtual row** of the list so it scrolls with history.

**Persistence boundary (locked invariant):** activity events (thinking, tool use, deltas-as-activity) are **ephemeral**; only the final `assistant_message` is persisted to Postgres. `text_delta` deltas are also appended to the **persisted** placeholder bubble (`useChat`/`useChatSurface`) so a hub restart preserves partial text. `text_delta` is **RAF-coalesced client-side**; hub-side throttling is forbidden (event-ordering contract with scheduled-tasks).

**Edge cases:** session switch resets `ActivityState` to `INITIAL_STATE`; reconnect (`connectionId` bump) triggers a history refetch to backfill missed deltas.

**Reuse notes:** fully portable. A host only needs to emit the event `type`s; the state machine + render are transport-agnostic.

### 5.4 Response rendering (markdown / thinking / tools)

**Behavior:** assistant messages render as sanitized GFM markdown; thinking and tool calls render as collapsible blocks; code/tables get dedicated styling.

**Components:** `MessageBubble` (persisted), `ActivityFeed` streaming text (live), `ThinkingBlock`, `ToolUseBlock`.

**Data contract / libs:** `react-markdown@^9` + `remark-gfm@^4` + `rehype-sanitize@^6`. Links → new tab; tables → scroll wrapper. Prose styling driven by CSS vars + a `.prose` ruleset in `web/src/index.css` (h1–h4 sizes, blockquote, hr, tables with zebra rows via `color-mix`). Code blocks: `--code-bg` background, emerald inline code. (No syntax-highlighter dependency — styling only; add `rehype-highlight`/Shiki if token coloring is wanted.)

**Edge cases:** content is sanitized (XSS-safe) before render; tool input/result are truncated (500 / 1000 chars) in the collapsed/expanded views to bound DOM.

**Reuse notes:** portable. Keep `rehype-sanitize` — these blocks render untrusted agent/tool output.

### 5.5 Inline permissions

**Behavior:** when the agent requests a tool permission, an inline amber card shows the tool + arguments with **Allow / Deny**; responding sends a `permission_response` and locks the card.

**Components/hooks:** `PermissionBlock` (render + buttons), `ActivityFeed` (mounts it from `activity.pendingPermission`), the host's `onPermissionRespond(request_id, approved)`.

**Data contract:** in `permission_request { request_id, tool_name, tool_input }`; out `permission_response { session_id, request_id, approved, csrf_token? }` (`hub/src/ws/protocol.ts` `ClientPermissionResponse`). `QuestionBlock` mirrors this with `question_response { …, answer }`.

**Edge cases:** the card locks to "Response sent" after one click (no double-submit); a stale/duplicate request with an already-answered `request_id` is a no-op host-side.

**Reuse notes:** portable. Host wires `onPermissionRespond`/`onQuestionRespond` to its transport's send.

### 5.6 Slash commands

**Behavior:** typing `/` opens a filtered menu of commands/skills; arrow keys navigate, Tab/Enter applies (inserts `/<name> ` and positions the caret), Escape dismisses.

**Components/hooks:** `ChatSurface.tsx` (`slashItems`/`slashIdx`/`slashOpen`/`slashSuppressedRef`, `applySlash`, key handling in `handleKeyDown`), `useCommands(token)` + `groupCommands`/`filterCommands`.

**Data contract:** the menu opens only for a bare slash token (`/^\/[\w.:-]*$/`). `applySlash(item)` rewrites input to `"/<name> <rest>"` and sets the caret to `name.length + 2`. Items come from `GET /api/commands` via `useCommands`. `SlashItem` = `{ kind:'command'|'skill', name, description, source }`.

**Edge cases:** menu is suppressed (`slashSuppressedRef`) after applying, after Escape, and while recording; Enter without the menu open submits.

**Reuse notes:** the menu UX is portable; the **command catalog source is app-specific** — replace `GET /api/commands` (or pass a static `SlashItem[]`).

---

## 6. Theming & density

### CSS custom-property token set

Defined in `web/src/index.css`. Tokens live on `:root` and are overridden by `.light` / `.dark` classes (set on a root element). Full set (`.light` / `.dark`):

| Token | Role | Light | Dark |
|---|---|---|---|
| `--bg-primary` | page/app bg | `#ffffff` | `#0f172a` |
| `--bg-secondary` | panel/surface bg | `#f8fafc` | `#1e293b` |
| `--bg-tertiary` | block/chip bg | `#f1f5f9` | `#334155` |
| `--bg-input` | composer bg | `#ffffff` | `#1e293b` |
| `--border-color` | borders | `#e2e8f0` | `#334155` |
| `--text-primary` | body text | `#0f172a` | `#e2e8f0` |
| `--text-secondary` | secondary text | `#475569` | `#94a3b8` |
| `--text-muted` | muted/meta text | `#94a3b8` | `#64748b` |
| `--text-on-accent` | text on accent | `#ffffff` | `#ffffff` |
| `--code-bg` | code block bg | `#f1f5f9` | `#0f172a` |
| `--scrollbar-thumb` / `--scrollbar-hover` | chat scrollbar | `#cbd5e1`/`#94a3b8` | `#334155`/`#475569` |

Accent is Tailwind **indigo** (used directly in classes for user bubbles / the streaming cursor / active states). Status colors: amber (thinking/pending/recording), emerald (success/inline-code), red (errors/deny). Safe-area helpers (`.safe-top`/`.safe-bottom`/`.safe-x`) and `textarea { field-sizing: content }` (auto-grow) also live in `index.css`.

**To re-theme:** redefine the `--*` tokens for your brand under `.light`/`.dark` (or `:root` + `[data-theme]`). Most chrome follows automatically; for a non-indigo accent, the few hard-coded `indigo-*`/`emerald-*`/`amber-*` Tailwind classes in the blocks should be promoted to tokens (`--accent`, `--success`, `--warning`) during extraction (see §7).

### Density variants

`densityClasses` in `ChatSurface.tsx` is a per-density bundle of Tailwind class strings + numbers: `root`, `list`, `rowGap` (px, virtualizer gap), `estimateRow` (px, virtualizer estimate), `bubbleSize`, `inputPad`, `textarea`, `sendBtn`, `btnSquare` (matches textarea height so attach/mic/send/stop align), `iconSize`, `showHeader`, `emptyText`. The three keys: `full`, `cell`, `mobile-expanded` (the last gets `aspectRatio:'1/1'` + `maxHeight:'100dvh'` via `rootStyle`). All three densities virtualize.

---

## 7. Reuse / extraction guide

### (a) Portable copy-set (transport-agnostic core)

Copy these as-is — they depend only on the §4 seam (`subscribe`/`send`/`connectionId`) + `token` + an `onSend`-style callback:

```
web/src/components/ChatSurface.tsx
web/src/components/FileAttachmentBar.tsx
web/src/components/MessageBubble.tsx        (strip the scheduled/revanote prefix parsing — §8)
web/src/components/ActivityFeed.tsx
web/src/components/ThinkingBlock.tsx
web/src/components/ToolUseBlock.tsx
web/src/components/PermissionBlock.tsx
web/src/components/QuestionBlock.tsx
web/src/hooks/useChatSurface.ts
web/src/hooks/useActivity.ts                (owns ActivityState + ChatEvent types)
web/src/lib/raf-batch.ts                    (createRafBatcher)
web/src/index.css                           (the token set + .prose + scrollbar rules)
```

Reference usage: `ChatSurfaceShowcase.tsx`.

### (b) Transport adapter to implement

Provide a hook returning `{ subscribe, send, connectionId }` (+ optional `connected`/`online`) over your transport — the only piece you write. remo-code's `useWebSocket.ts` is the WS reference; for the house default, write `useChatSSE` (POST send + `EventSource` subscribe). See §4 for REST+SSE / socket.io / Agent-SDK shims.

### (c) Dependencies

```
react ^19, react-dom ^19
react-markdown ^9   remark-gfm ^4   rehype-sanitize ^6
@tanstack/react-virtual ^3
tailwindcss ^4   (+ the index.css token layer)
```

No other runtime deps for the chat core (`croner`/`cronstrue` in remo-code's web package are scheduler-only, not chat).

### (d) Recommended shared package path

Promote the core into the shared GitHub Packages libs already designated in `architecture-preferences.md`:

- **`cc-stream-core`** (`@scope/...`, zero React) — the `ChatEvent` / `ClientMessage` Zod schemas + `RunnerEvent`/`CliEvent` unions + the stream-json parser. Both ends import this (kills the supervisor↔hub hand-mirrored type drift).
- **`cc-stream-react`** (depends on `cc-stream-core`) — `ChatSurface` + all sibling blocks + `useChatSurface` + `useActivity` + `raf-batch` + the token CSS layer. Ships **no transport** — the consuming app injects its `{ subscribe, send, connectionId }` adapter. During extraction, promote the hard-coded `indigo/emerald/amber` Tailwind classes in the blocks to `--accent`/`--success`/`--warning` tokens so accent is themeable.

**Stays app-specific** (do NOT package): `ChatLayout`, `ChatPanel` (or ship a trivial generic `ChatPanel`), `useWebSocket` (remo-code transport), `useCommands` + `/api/commands`, `/api/transcribe`, message-envelope parsers (`scheduled-message`, `revanote-message`), session/sidebar/auth chrome.

---

## 8. Known couplings & caveats

- **Auth** — the surface takes a `token` prop and remo-code's transport uses opaque-cookie sessions + CSRF echo. Auth is **separable**: a host injects its own token/transport. (Per global rule 16, new apps use Titanium for identity.)
- **Transport** — `useWebSocket.ts` (`/ws/client`, offline queue, reconnect/backoff, CSRF) is remo-code-specific. Replace per §4. `connectionId`-driven re-subscribe + reconnect backfill must be preserved in any adapter or live deltas are lost after a reconnect.
- **Session model + supervisor** — `sessionId` maps to a remo-code session backed by a local Claude/Codex CLI via the supervisor. A host substitutes its own session identity; the surface only needs a stable `sessionId` + the event stream.
- **App-specific endpoints** — `/api/commands` (slash catalog) and `/api/transcribe` (Whisper proxy) must be provided or stubbed.
- **Message envelopes** — `MessageBubble` parses remo-code-only prefixes (scheduled-task, Revanote). Strip these (`web/src/lib/{scheduled-message,revanote-message}.ts`) when extracting.
- **History-fetch contract** — `useChatSurface` does a one-shot `GET …?limit=30` and honors `seedMessages` only at mount (Phase-03 cell-history decision). A host's adapter supplies the history fetch shape (`ChatMessage[]`).
- **No syntax highlighting** — code blocks are styled, not tokenized. Add `rehype-highlight`/Shiki if needed.
- **Accent hard-coding** — indigo/emerald/amber are inline Tailwind classes in the blocks; not yet tokenized (see §7d).
