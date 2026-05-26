# Remo Code v2: Streaming Agent Architecture

**Date:** 2026-03-28
**Status:** Historical (Phase 09, 2026-05-26)

> **Note (Phase 09, 2026-05-26):** The `remo-code-agent` npm package and `channel/` plugin described in this spec have been retired. The local CLI runner now lives in `supervisor/src/` and is shipped as a Tauri MSI desktop app. The hub-side streaming protocol over `/ws/agent` is unchanged. See `.planning/phases/09-retire-npm-packages/`.

## Summary

Replace the current channel plugin (MCP server) architecture with a local streaming agent that spawns Claude Code CLI with `--output-format stream-json`. This gives the web UI full visibility into Claude's activity: thinking, tool calls, tool results, and text responses — matching the terminal experience. Also adds file attachments (text + images) in the chat UI.

## Current Architecture (v1)

```
Browser (React SPA)
    ↕ WebSocket /ws/client
Hub Server (Bun + Hono, cloud)
    ↕ WebSocket /ws/channel
Channel Plugin (MCP server, spawned BY Claude Code)
    ↕ stdio (MCP notifications + tools)
Claude Code terminal
```

**Limitations:**
- Plugin only receives user messages and can send replies — no visibility into Claude's thinking, tool calls, or progress
- Claude Code controls the plugin lifecycle (not the other way around)
- No file attachment support
- Can't start/stop Claude sessions from the web UI

## Proposed Architecture (v2)

```
Browser (React SPA)
    ↕ WebSocket /ws/client (enhanced protocol)
Hub Server (Bun + Hono, cloud)
    ↕ WebSocket /ws/agent
Local Agent (Bun, runs on dev machine)
    ↕ subprocess stdin/stdout
Claude Code CLI (--output-format stream-json)
```

**Key change:** The agent spawns and controls Claude Code, instead of the other way around. The agent parses the full JSON stream and relays everything to the hub.

## Components

### 1. Local Agent (`agent/`)

A Bun process that runs on the same machine as Claude Code. Replaces the channel plugin.

**Responsibilities:**
- Connect to hub via WebSocket, authenticate with API key
- Receive user messages (with optional file attachments) from hub
- Spawn Claude Code CLI as subprocess with `--output-format stream-json`
- Parse stream-json events and relay to hub in real-time
- Manage Claude Code process lifecycle (start, stop, restart)
- Report session status (idle, thinking, tool_calling, writing)

**CLI spawn command:**
```bash
claude --output-format stream-json --verbose
```

**Stream-json event types parsed (from Claude Code CLI):**
```
{"type": "assistant", "subtype": "thinking", "content": "..."}
{"type": "assistant", "subtype": "text", "content": "..."}
{"type": "tool_use", "name": "Read", "input": {...}}
{"type": "tool_result", "name": "Read", "content": "..."}
{"type": "result", "content": "...", "cost": {...}}
```

**User input:** Written to Claude's stdin as plain text (or JSON for structured input).

**Session management:**
- Agent auto-registers with the hub on connect (sends project dir, machine hostname)
- Hub creates/reuses a session record
- Agent can manage multiple Claude processes if needed (one per project dir)
- On disconnect, hub marks session offline

**Install & run:**
```bash
# Install globally
bun install -g remo-code-agent

# Run (reads config from ~/.config/remo-code/config.json)
remo-agent

# Or with args
remo-agent --hub-url https://app.remo-code.com --api-key remokey_xxx
```

### 2. Enhanced Hub WebSocket Protocol

New `/ws/agent` endpoint replaces `/ws/channel`. Richer event protocol.

**Agent → Hub (upstream events):**

```typescript
// Authentication
{ type: "auth", api_key: string, sessions: [{ project_dir: string, name: string }] }

// Session lifecycle
{ type: "session_start", session_id: string }
{ type: "session_end", session_id: string }

// Claude activity stream (relayed from stream-json)
{ type: "thinking", session_id: string, content: string }
{ type: "text_delta", session_id: string, content: string }
{ type: "tool_use", session_id: string, tool: string, tool_id: string, input: object }
{ type: "tool_result", session_id: string, tool_id: string, content: string, is_error?: boolean }
{ type: "status", session_id: string, state: "idle" | "thinking" | "tool_calling" | "writing" }

// Final assembled message (for persistence)
{ type: "assistant_message", session_id: string, content: string }
```

**Hub → Agent (downstream):**

```typescript
// Auth response
{ type: "auth_ok" }
{ type: "auth_error", error: string }

// User messages (from browser)
{ type: "user_message", session_id: string, id: string, content: string,
  images?: { media_type: string, data: string }[],
  attachments?: { filename: string, content: string }[] }

// Session control
{ type: "cancel", session_id: string }
{ type: "ping" }
```

**Hub → Client (browser, enhanced):**

All existing events plus new activity events:

```typescript
// Existing
{ type: "auth_ok" }
{ type: "message", session_id: string, message: ChatMessage }
{ type: "session_status", session_id: string, status: string }
{ type: "session_list", sessions: Session[] }

// NEW: Real-time activity stream
{ type: "thinking", session_id: string, content: string }
{ type: "text_delta", session_id: string, content: string }
{ type: "tool_use", session_id: string, tool: string, tool_id: string, input: object }
{ type: "tool_result", session_id: string, tool_id: string, content: string, is_error?: boolean }
{ type: "status", session_id: string, state: "idle" | "thinking" | "tool_calling" | "writing" }
```

The hub relays activity events from agent to subscribed clients. These are ephemeral (not persisted) — only the final `assistant_message` is stored in the DB.

### 3. File Attachments

**Frontend (browser):**
- Two attachment types: text files and images
- Text files: read as UTF-8 via `FileReader.readAsText()`, prepended to message content as `[Attached file: filename]\n<content>`
- Images: read as base64 via `FileReader.readAsDataURL()`, sent in separate `images` array
- Paste (Ctrl+V) and drag-and-drop support for images
- File preview chips before sending (filename + remove button)
- Size limits enforced at frontend:
  - Text files: max 1 MB per file
  - Images: max 10 MB per file
  - Max 5 attachments per message

**WebSocket message (client → hub → agent):**
```json
{
  "type": "send_message",
  "session_id": "...",
  "content": "[Attached file: config.json]\n{\"key\": \"value\"}\n\nPlease review this config",
  "images": [
    { "media_type": "image/png", "data": "base64..." }
  ]
}
```

**Agent → Claude CLI:**
- Text file content is already embedded in the message string — written directly to stdin
- Images: saved to a temp file, then referenced in the message or passed via Claude's image input (TBD based on CLI support for multimodal stdin)

**Persistence:**
- File content embedded in the message record (no separate storage)
- Images stored as base64 in the message content (or a reference if too large)

### 4. Frontend Changes

**New components:**
- `ActivityFeed` — shows thinking, tool calls, results inline in chat (collapsible)
- `ThinkingBlock` — streaming thinking text with blinking cursor
- `ToolUseBlock` — tool name + input (collapsible JSON)
- `ToolResultBlock` — tool output (collapsible)
- `FileAttachmentBar` — preview chips for attached files/images
- `FileDropZone` — drag-and-drop overlay

**Updated components:**
- `ChatPanel` — add attachment button, file input refs, paste/drop handlers, activity feed between messages
- `MessageBubble` — render inline images, show file attachment markers
- `useChat` hook — handle new event types (thinking, text_delta, tool_use, tool_result, status)

**Chat UI behavior:**
- While Claude is responding, show streaming text + activity feed
- Thinking text in a muted collapsible block (like ottolax's ThinkingBlock)
- Tool calls shown as labeled blocks: "Reading file.ts..." → "Done (245 lines)"
- Text delta assembles into the assistant message in real-time
- When response completes, activity feed collapses and the final message is shown
- Cancel button visible during active response

### 5. Unread Messages

Simple feature added to the session list/dropdown.

**Implementation:**
- Track `last_read_at` per session in localStorage (keyed by session_id)
- Compare against latest message `created_at` in each session
- Show unread badge (dot or count) on session items in sidebar and dropdown
- Clear unread when session is selected/viewed
- Optional: browser notification API for messages when tab is not focused

**Data model:**
- No DB changes needed — unread state is client-side only
- `localStorage.getItem('remo-unread-${sessionId}')` = last read timestamp

## Migration Path

### Phase 1: Local Agent + Streaming (replaces channel plugin)
1. Build `agent/` package — CLI spawner, stream-json parser, hub WebSocket client
2. Add `/ws/agent` endpoint to hub with new protocol
3. Hub relays activity events to subscribed browser clients
4. Frontend: add `useActivity` hook, `ThinkingBlock`, `ToolUseBlock` components
5. Deprecate channel plugin (keep for backward compat temporarily)

### Phase 2: File Attachments
1. Frontend: `FileAttachmentBar`, paste/drop handlers, file preview
2. Protocol: add `images` and `attachments` fields to `send_message`
3. Hub: relay attachments to agent
4. Agent: pass file content to Claude stdin, save images as temp files

### Phase 3: Polish
1. Unread messages badge
2. Cancel button (sends `cancel` to agent → agent sends SIGINT to Claude)
3. Session management from web UI (start/stop/restart Claude)
4. Multiple project dirs per agent

## Key Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Agent runtime | Bun (TypeScript) | Consistent with hub/web, shares types |
| Stream format | Claude CLI `--output-format stream-json` | Gives full activity stream, proven in ottolax |
| File storage | Embedded in messages | Simple, no external storage needed, files are context |
| Image format | Base64 in WebSocket | No upload endpoint needed, works with existing WS |
| Unread tracking | Client-side localStorage | No DB migration, no server state needed |
| Activity persistence | Ephemeral (not stored) | Only final message persisted, activity is for live UX |
| Agent distribution | npm/bun global install | Easy to install on any dev machine |

## What This Does NOT Include

- Running Claude Code on the server (agent must run locally on the dev machine)
- Web-based terminal emulator (the web UI is a chat interface, not a terminal)
- Multi-user collaboration on the same session
- OAuth/SSO (keep existing Supabase email auth)
- Billing/quotas (open-source, bring your own API key)

## Open Questions

1. **Claude CLI multimodal stdin:** Does `claude --output-format stream-json` accept images via stdin? If not, images may need to be saved to temp files and referenced in the prompt.
2. **Agent auto-update:** Should the agent self-update, or rely on `bun update -g`?
3. **Multiple agents per user:** Can one user run agents on multiple machines? (Yes, each creates separate sessions — hub handles routing.)
4. **Backward compatibility:** Keep `/ws/channel` for existing channel plugin users during transition?
