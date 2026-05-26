# Streaming Agent Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Note (Phase 09, 2026-05-26):** This plan is historical. The `agent/` workspace and `channel/` plugin it describes have been retired. The CLI streaming runner is now in `supervisor/src/` and ships as a Tauri MSI desktop app. The `/ws/agent` protocol is unchanged. See `.planning/phases/09-retire-npm-packages/`.

**Goal:** Replace the channel plugin with a local streaming agent that spawns Claude Code CLI, giving the web UI full visibility into Claude's activity (thinking, tool calls, text), plus file attachments and unread messages.

**Architecture:** Local agent spawns `claude -p --output-format stream-json --verbose`, parses the JSON event stream, and relays events to the hub via WebSocket. The hub broadcasts activity events to subscribed browser clients. Frontend renders thinking blocks, tool call indicators, and streaming text.

**Tech Stack:** Bun (TypeScript), Hono (hub), React 19 + Tailwind CSS 4 (web), WebSocket, Claude Code CLI

---

## File Structure

### New Files
```
agent/                          # New workspace package
├── package.json                # Dependencies: ws (or native Bun WS)
├── tsconfig.json               # TypeScript config
├── src/
│   ├── index.ts                # Entry point: parse args, load config, start agent
│   ├── config.ts               # Load config from ~/.config/remo-code/config.json + CLI args
│   ├── hub-client.ts           # WebSocket client to hub (auth, send, receive, reconnect)
│   ├── claude-runner.ts        # Spawn claude CLI, parse stream-json, emit typed events
│   └── types.ts                # Shared types for agent events
│
hub/src/ws/
├── agent.ts                    # NEW: WebSocket handler for agent connections (replaces channel.ts)
├── agent-protocol.ts           # NEW: Zod schemas for agent WebSocket messages
│
web/src/
├── hooks/useActivity.ts        # NEW: Hook for real-time activity events (thinking, tool use, text delta)
├── components/
│   ├── ActivityFeed.tsx         # NEW: Container for activity blocks during response
│   ├── ThinkingBlock.tsx        # NEW: Collapsible thinking text with streaming cursor
│   ├── ToolUseBlock.tsx         # NEW: Tool call display (name + status)
│   ├── FileAttachmentBar.tsx    # NEW: File preview chips before sending
│   └── UnreadBadge.tsx          # NEW: Unread dot/count indicator
```

### Modified Files
```
package.json                    # Add "agent" to workspaces
hub/src/index.ts                # Add /ws/agent endpoint
hub/src/ws/registry.ts          # Add agent registry (alongside existing channel registry)
hub/src/ws/client.ts            # Forward activity events from agent to subscribed clients
hub/src/ws/protocol.ts          # Add agent message schemas, add images/attachments to send_message
web/src/hooks/useChat.ts        # Handle new event types, streaming text assembly
web/src/hooks/useWebSocket.ts   # Pass through new event types
web/src/components/ChatPanel.tsx # Activity feed, file attachments, cancel button
web/src/components/MessageBubble.tsx # Inline images, file markers
web/src/components/Sidebar.tsx  # Unread badges
web/src/components/SessionDropdown.tsx # Unread badges
```

---

### Task 1: Agent Package Scaffold

**Files:**
- Create: `agent/package.json`
- Create: `agent/tsconfig.json`
- Create: `agent/src/types.ts`
- Create: `agent/src/config.ts`
- Modify: `package.json` (add agent to workspaces)

- [ ] **Step 1: Create agent/package.json**

```json
{
  "name": "remo-code-agent",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "remo-agent": "./src/index.ts"
  },
  "scripts": {
    "start": "bun src/index.ts",
    "dev": "bun --watch src/index.ts"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Create agent/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["bun-types"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create agent/src/types.ts**

Define the typed events that flow between agent, hub, and browser:

```typescript
// Events the agent sends TO the hub (parsed from Claude CLI stream-json)
export type AgentToHub =
  | { type: 'auth'; api_key: string; project_dir: string; hostname: string }
  | { type: 'thinking'; session_id: string; content: string }
  | { type: 'text_delta'; session_id: string; content: string }
  | { type: 'tool_use'; session_id: string; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; session_id: string; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; session_id: string; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; session_id: string; content: string }
  | { type: 'pong' }

// Events the hub sends TO the agent
export type HubToAgent =
  | { type: 'auth_ok'; session_id: string }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; session_id: string; id: string; content: string;
      images?: Array<{ media_type: string; data: string }>;
      attachments?: Array<{ filename: string; content: string }> }
  | { type: 'cancel'; session_id: string }
  | { type: 'ping' }

// Claude CLI stream-json event shapes (subset we care about)
export interface CliInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  tools: string[]
}

export interface CliAssistantEvent {
  type: 'assistant'
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
  }
  session_id: string
}

export interface CliToolResultEvent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  session_id: string
}

export interface CliResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  result: string
  duration_ms: number
  total_cost_usd: number
  session_id: string
}

export type CliEvent = CliInitEvent | CliAssistantEvent | CliToolResultEvent | CliResultEvent | { type: string; [key: string]: unknown }
```

- [ ] **Step 4: Create agent/src/config.ts**

```typescript
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface AgentConfig {
  hubUrl: string
  apiKey: string
  projectDir: string
}

const CONFIG_PATH = join(homedir(), '.config', 'remo-code', 'config.json')

export function loadConfig(): AgentConfig {
  const args = parseArgs(process.argv.slice(2))

  // CLI args take priority
  let hubUrl = args['--hub-url'] || process.env.REMO_HUB_URL || ''
  let apiKey = args['--api-key'] || process.env.REMO_API_KEY || ''

  // Fall back to config file
  if ((!hubUrl || !apiKey) && existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      hubUrl = hubUrl || file.hub_url || ''
      apiKey = apiKey || file.api_key || ''
    } catch {}
  }

  if (!hubUrl || !apiKey) {
    console.error('Missing hub_url or api_key. Provide via:')
    console.error('  --hub-url and --api-key flags')
    console.error('  REMO_HUB_URL and REMO_API_KEY env vars')
    console.error(`  ${CONFIG_PATH}`)
    process.exit(1)
  }

  const projectDir = args['--project-dir'] || process.cwd()

  return { hubUrl, apiKey, projectDir }
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i].includes('=')) {
      const [key, ...rest] = argv[i].split('=')
      result[key] = rest.join('=')
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i]] = argv[i + 1]
      i++
    }
  }
  return result
}
```

- [ ] **Step 5: Add agent to root workspaces**

In `package.json`, change:
```json
"workspaces": ["hub", "channel", "web"]
```
to:
```json
"workspaces": ["hub", "channel", "web", "agent"]
```

- [ ] **Step 6: Run `bun install` from root to link workspace**

Run: `bun install`
Expected: No errors, agent/ workspace linked.

- [ ] **Step 7: Commit**

```bash
git add agent/ package.json bun.lockb
git commit -m "feat(agent): scaffold agent package with types and config"
```

---

### Task 2: Claude CLI Runner

**Files:**
- Create: `agent/src/claude-runner.ts`

- [ ] **Step 1: Implement ClaudeRunner class**

```typescript
import { spawn, type Subprocess } from 'bun'
import type { CliEvent } from './types'

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; content: string }
  | { type: 'result'; cost: number; duration_ms: number }
  | { type: 'error'; message: string }

export class ClaudeRunner {
  private proc: Subprocess | null = null
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  /**
   * Send a user message to Claude and stream back parsed events.
   * Each call spawns a new `claude -p` process (stateless).
   */
  async *run(message: string): AsyncGenerator<RunnerEvent> {
    this.proc = spawn({
      cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
      cwd: this.projectDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // Write user message to stdin and close
    const writer = this.proc.stdin.getWriter()
    await writer.write(new TextEncoder().encode(message))
    await writer.close()

    yield { type: 'status', state: 'thinking' }

    // Read stdout line by line, parse JSON events
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue
          let event: CliEvent
          try {
            event = JSON.parse(line)
          } catch {
            continue // skip malformed lines
          }

          for (const parsed of this.parseEvent(event)) {
            if (parsed.type === 'text_delta') fullText += parsed.content
            yield parsed
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event: CliEvent = JSON.parse(buffer)
          for (const parsed of this.parseEvent(event)) {
            if (parsed.type === 'text_delta') fullText += parsed.content
            yield parsed
          }
        } catch {}
      }

      // Emit final assembled message
      if (fullText) {
        yield { type: 'assistant_message', content: fullText }
      }
    } finally {
      yield { type: 'status', state: 'idle' }
      this.proc = null
    }
  }

  /** Cancel the running process */
  cancel() {
    if (this.proc) {
      this.proc.kill('SIGINT')
    }
  }

  private *parseEvent(event: CliEvent): Generator<RunnerEvent> {
    if (event.type === 'assistant' && 'message' in event) {
      const msg = (event as any).message
      if (!msg?.content) return
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          yield { type: 'status', state: 'writing' }
          yield { type: 'text_delta', content: block.text }
        }
        if (block.type === 'thinking' && block.thinking) {
          yield { type: 'status', state: 'thinking' }
          yield { type: 'thinking', content: block.thinking }
        }
        if (block.type === 'tool_use') {
          yield { type: 'status', state: 'tool_calling' }
          yield { type: 'tool_use', tool: block.name, tool_id: block.id, input: block.input }
        }
      }
    }

    if (event.type === 'tool_result') {
      const tr = event as any
      yield { type: 'tool_result', tool_id: tr.tool_use_id, content: tr.content || '', is_error: tr.is_error }
    }

    if (event.type === 'result') {
      const r = event as any
      yield { type: 'result', cost: r.total_cost_usd || 0, duration_ms: r.duration_ms || 0 }
    }
  }
}
```

- [ ] **Step 2: Test the runner manually**

Run: `cd agent && bun -e "import {ClaudeRunner} from './src/claude-runner'; const r = new ClaudeRunner(process.cwd()); for await (const e of r.run('say hello in 3 words')) console.log(JSON.stringify(e))"`
Expected: See thinking, text_delta, assistant_message, status events in sequence.

- [ ] **Step 3: Commit**

```bash
git add agent/src/claude-runner.ts
git commit -m "feat(agent): Claude CLI runner with stream-json parsing"
```

---

### Task 3: Hub WebSocket Client (Agent Side)

**Files:**
- Create: `agent/src/hub-client.ts`

- [ ] **Step 1: Implement HubClient**

```typescript
import type { AgentToHub, HubToAgent } from './types'

type MessageHandler = (msg: HubToAgent) => void

export class HubClient {
  private ws: WebSocket | null = null
  private hubUrl: string
  private apiKey: string
  private projectDir: string
  private hostname: string
  private sessionId: string | null = null
  private onMessage: MessageHandler
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private authenticated = false

  constructor(
    hubUrl: string,
    apiKey: string,
    projectDir: string,
    onMessage: MessageHandler,
  ) {
    this.hubUrl = hubUrl
    this.apiKey = apiKey
    this.projectDir = projectDir.replace(/\\/g, '/')
    this.hostname = require('os').hostname()
    this.onMessage = onMessage
  }

  get sessionIdValue() { return this.sessionId }

  connect() {
    const wsUrl = this.hubUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/agent'
    console.log(`[hub-client] connecting to ${wsUrl}`)

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      console.log('[hub-client] connected, authenticating...')
      this.send({
        type: 'auth',
        api_key: this.apiKey,
        project_dir: this.projectDir,
        hostname: this.hostname,
      })
    }

    this.ws.onmessage = (event) => {
      let msg: HubToAgent
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data))
      } catch { return }

      if (msg.type === 'auth_ok') {
        this.authenticated = true
        this.sessionId = (msg as any).session_id
        console.log(`[hub-client] authenticated, session=${this.sessionId}`)
      }

      if (msg.type === 'auth_error') {
        console.error(`[hub-client] auth failed: ${msg.error}`)
        this.ws?.close()
        return
      }

      if (msg.type === 'ping') {
        this.send({ type: 'pong' })
        return
      }

      this.onMessage(msg)
    }

    this.ws.onclose = () => {
      console.log('[hub-client] disconnected, reconnecting in 5s...')
      this.authenticated = false
      this.reconnectTimer = setTimeout(() => this.connect(), 5000)
    }

    this.ws.onerror = (err) => {
      console.error('[hub-client] error:', err)
    }
  }

  send(msg: AgentToHub) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent/src/hub-client.ts
git commit -m "feat(agent): hub WebSocket client with auto-reconnect"
```

---

### Task 4: Agent Entry Point

**Files:**
- Create: `agent/src/index.ts`

- [ ] **Step 1: Wire together config, hub client, and Claude runner**

```typescript
#!/usr/bin/env bun
import { loadConfig } from './config'
import { HubClient } from './hub-client'
import { ClaudeRunner } from './claude-runner'
import type { HubToAgent } from './types'

const config = loadConfig()
console.log(`[remo-agent] project: ${config.projectDir}`)
console.log(`[remo-agent] hub: ${config.hubUrl}`)

const runner = new ClaudeRunner(config.projectDir)

function handleMessage(msg: HubToAgent) {
  if (msg.type === 'user_message') {
    handleUserMessage(msg)
  }
  if (msg.type === 'cancel') {
    runner.cancel()
  }
}

const hub = new HubClient(config.hubUrl, config.apiKey, config.projectDir, handleMessage)
hub.connect()

async function handleUserMessage(msg: Extract<HubToAgent, { type: 'user_message' }>) {
  const sessionId = hub.sessionIdValue
  if (!sessionId) return

  // Build the prompt: prepend file attachments, append user message
  let prompt = ''
  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      prompt += `[Attached file: ${att.filename}]\n${att.content}\n\n`
    }
  }
  prompt += msg.content

  // TODO: handle images (save to temp file, reference in prompt) — Phase 2

  try {
    for await (const event of runner.run(prompt)) {
      if (event.type === 'result') continue // internal, don't relay
      hub.send({ ...event, session_id: sessionId } as any)
    }
  } catch (err: any) {
    console.error('[remo-agent] runner error:', err.message)
    hub.send({ type: 'status', session_id: sessionId, state: 'idle' })
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('[remo-agent] shutting down...')
  runner.cancel()
  hub.close()
  process.exit(0)
})

console.log('[remo-agent] ready, waiting for messages...')
```

- [ ] **Step 2: Test locally (won't connect to hub yet — hub endpoint doesn't exist)**

Run: `cd agent && bun src/index.ts --hub-url https://app.remo-code.com --api-key remokey_xxx`
Expected: Connects to hub, gets 404 or connection refused on /ws/agent (endpoint not built yet). No crash.

- [ ] **Step 3: Commit**

```bash
git add agent/src/index.ts
git commit -m "feat(agent): entry point wiring config, hub client, and runner"
```

---

### Task 5: Hub Agent WebSocket Endpoint

**Files:**
- Create: `hub/src/ws/agent-protocol.ts`
- Create: `hub/src/ws/agent.ts`
- Modify: `hub/src/ws/registry.ts`
- Modify: `hub/src/index.ts`

- [ ] **Step 1: Create agent-protocol.ts with Zod schemas**

```typescript
import { z } from 'zod'

export const AgentAuth = z.object({
  type: z.literal('auth'),
  api_key: z.string().min(1),
  project_dir: z.string().min(1),
  hostname: z.string().optional(),
})

export const AgentThinking = z.object({
  type: z.literal('thinking'),
  session_id: z.string(),
  content: z.string(),
})

export const AgentTextDelta = z.object({
  type: z.literal('text_delta'),
  session_id: z.string(),
  content: z.string(),
})

export const AgentToolUse = z.object({
  type: z.literal('tool_use'),
  session_id: z.string(),
  tool: z.string(),
  tool_id: z.string(),
  input: z.unknown(),
})

export const AgentToolResult = z.object({
  type: z.literal('tool_result'),
  session_id: z.string(),
  tool_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
})

export const AgentStatus = z.object({
  type: z.literal('status'),
  session_id: z.string(),
  state: z.enum(['idle', 'thinking', 'tool_calling', 'writing']),
})

export const AgentAssistantMessage = z.object({
  type: z.literal('assistant_message'),
  session_id: z.string(),
  content: z.string().min(1).max(65536),
})

export const AgentInbound = z.discriminatedUnion('type', [
  AgentAuth,
  AgentThinking,
  AgentTextDelta,
  AgentToolUse,
  AgentToolResult,
  AgentStatus,
  AgentAssistantMessage,
  z.object({ type: z.literal('pong') }),
])

export type AgentInboundType = z.infer<typeof AgentInbound>
```

- [ ] **Step 2: Create agent.ts WebSocket handler**

```typescript
import type { ServerWebSocket } from 'bun'
import { AgentInbound } from './agent-protocol'
import { verifyApiKey, createPluginSession } from '../db/dal'
import { hashToken } from './channel'
import { generateToken } from '../utils/token'
import { registerChannel, unregisterChannel, broadcastToSubscribers, broadcastToUser } from './registry'
import { setSessionStatus, insertMessage } from '../db/dal'

export interface AgentWsData {
  authenticated: boolean
  sessionId: string | null
  userId: string | null
  authTimer: ReturnType<typeof setTimeout> | null
  heartbeatTimer: ReturnType<typeof setInterval> | null
  messageCount: number
  windowStart: number
}

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const RATE_LIMIT = { max: 120, windowMs: 10_000 }

export function createAgentWsData(): AgentWsData {
  return {
    authenticated: false,
    sessionId: null,
    userId: null,
    authTimer: null,
    heartbeatTimer: null,
    messageCount: 0,
    windowStart: Date.now(),
  }
}

export function handleAgentOpen(ws: ServerWebSocket<AgentWsData>) {
  console.log('[agent] connection opened')
  ws.data.authTimer = setTimeout(() => {
    if (!ws.data.authenticated) {
      console.log('[agent] auth timeout, closing')
      ws.close(4000, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
}

export async function handleAgentMessage(ws: ServerWebSocket<AgentWsData>, raw: string) {
  // Rate limiting
  const now = Date.now()
  if (now - ws.data.windowStart > RATE_LIMIT.windowMs) {
    ws.data.messageCount = 0
    ws.data.windowStart = now
  }
  if (++ws.data.messageCount > RATE_LIMIT.max) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    console.error('[agent] JSON parse error:', e.message)
    return
  }

  const result = AgentInbound.safeParse(parsed)
  if (!result.success) return
  const msg = result.data

  // --- Auth ---
  if (msg.type === 'auth') {
    const apiKeyRecord = await verifyApiKey(msg.api_key)
    if (!apiKeyRecord) {
      ws.send(JSON.stringify({ type: 'auth_error', error: 'invalid api key' }))
      ws.close(4001, 'auth failed')
      return
    }

    const userId = apiKeyRecord.user_id
    const projectDir = msg.project_dir.replace(/\\/g, '/')

    // Create a session for this agent connection
    const rawToken = generateToken('remo_')
    const tokenHash = await hashToken(rawToken)
    const session = await createPluginSession(userId, projectDir, tokenHash)

    ws.data.authenticated = true
    ws.data.sessionId = session.id
    ws.data.userId = userId
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer)

    console.log(`[agent] authenticated session=${session.id} user=${userId} project=${projectDir}`)
    registerChannel(session.id, userId, ws as any)
    await setSessionStatus(session.id, 'online')

    ws.send(JSON.stringify({ type: 'auth_ok', session_id: session.id }))

    // Start heartbeat
    ws.data.heartbeatTimer = setInterval(() => {
      ws.send(JSON.stringify({ type: 'ping' }))
    }, HEARTBEAT_INTERVAL_MS)

    // Notify browser clients of new session
    const { listSessions } = await import('../db/dal')
    const { supabaseForUser } = await import('../db/supabase')
    // We can't get user JWT here, but we can broadcast via admin
    broadcastToUser(userId, { type: 'session_list', sessions: await listSessionsForUser(userId) })
    return
  }

  if (!ws.data.authenticated || !ws.data.sessionId) return
  const { sessionId } = ws.data

  // --- Activity events: relay to subscribed browser clients ---
  if (msg.type === 'thinking' || msg.type === 'text_delta' || msg.type === 'tool_use' || msg.type === 'tool_result') {
    broadcastToSubscribers(sessionId, { ...msg })
  }

  // --- Status updates ---
  if (msg.type === 'status') {
    const dbStatus = msg.state === 'idle' ? 'online' : 'thinking'
    await setSessionStatus(sessionId, dbStatus)
    broadcastToSubscribers(sessionId, msg)
    broadcastToUser(ws.data.userId!, { type: 'session_status', session_id: sessionId, status: dbStatus })
  }

  // --- Final assistant message: persist and broadcast ---
  if (msg.type === 'assistant_message') {
    console.log(`[agent] assistant_message session=${sessionId} len=${msg.content.length}`)
    const message = await insertMessage(sessionId, 'assistant', msg.content)
    broadcastToSubscribers(sessionId, {
      type: 'message',
      session_id: sessionId,
      message,
    })
  }

  if (msg.type === 'pong') return // heartbeat response
}

export async function handleAgentClose(ws: ServerWebSocket<AgentWsData>) {
  console.log(`[agent] closed session=${ws.data.sessionId}`)
  if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
  if (ws.data.heartbeatTimer) clearInterval(ws.data.heartbeatTimer)

  if (ws.data.sessionId) {
    unregisterChannel(ws.data.sessionId)
    await setSessionStatus(ws.data.sessionId, 'offline')

    if (ws.data.userId) {
      broadcastToUser(ws.data.userId, {
        type: 'session_status',
        session_id: ws.data.sessionId,
        status: 'offline',
      })
    }
  }
}

// Helper: list sessions using admin client
async function listSessionsForUser(userId: string) {
  const { supabaseAdmin } = await import('../db/supabase')
  const { data } = await supabaseAdmin
    .from('sessions')
    .select('id, name, project_dir, status, last_activity, created_at')
    .eq('user_id', userId)
    .order('last_activity', { ascending: false, nullsFirst: false })
  return data || []
}
```

- [ ] **Step 3: Add /ws/agent endpoint to hub/src/index.ts**

Add after the existing `/ws/channel` WebSocket upgrade block:

```typescript
import { createAgentWsData, handleAgentOpen, handleAgentMessage, handleAgentClose } from './ws/agent'

// In the Bun.serve websocket handlers, add a path check:
// In the fetch handler, add:
if (url.pathname === '/ws/agent') {
  const upgraded = server.upgrade(req, { data: { ...createAgentWsData(), path: '/ws/agent' } })
  if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
  return undefined as any
}
```

In the WebSocket message/open/close handlers, route based on `ws.data.path`:

```typescript
// In the websocket config:
open(ws) {
  if (ws.data.path === '/ws/agent') return handleAgentOpen(ws)
  if (ws.data.path === '/ws/channel') return handleChannelOpen(ws)
  handleClientOpen(ws)
},
message(ws, raw) {
  const data = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
  if (ws.data.path === '/ws/agent') return handleAgentMessage(ws, data)
  if (ws.data.path === '/ws/channel') return handleChannelMessage(ws, data)
  handleClientMessage(ws, data)
},
close(ws) {
  if (ws.data.path === '/ws/agent') return handleAgentClose(ws)
  if (ws.data.path === '/ws/channel') return handleChannelClose(ws)
  handleClientClose(ws)
},
```

- [ ] **Step 4: Update client.ts to forward user messages to agent connections**

The existing `send_message` handler in `client.ts` already calls `getChannel(session_id)` and forwards. Since the agent registers in the same channel registry via `registerChannel()`, this should work without changes. But we need to add `images` and `attachments` to the forwarded message.

In `hub/src/ws/client.ts`, update the `send_message` handler:

```typescript
if (msg.type === 'send_message') {
  // ... existing validation and message storage ...

  const channel = getChannel(msg.session_id)
  if (channel) {
    console.log(`[client] forwarding to channel session=${msg.session_id}`)
    channel.ws.send(JSON.stringify({
      type: 'user_message',
      id: message.id,
      content: msg.content,
      ts: message.created_at,
      images: (msg as any).images,
      attachments: (msg as any).attachments,
    }))
  } else {
    console.log(`[client] no channel connected for session=${msg.session_id}`)
  }
}
```

- [ ] **Step 5: Update protocol.ts to add images/attachments to ClientSendMessage**

```typescript
export const ClientSendMessage = z.object({
  type: z.literal('send_message'),
  session_id: z.string().min(1).max(256),
  content: z.string().min(1).max(65536),
  id: z.string().uuid(),
  images: z.array(z.object({
    media_type: z.string(),
    data: z.string(),
  })).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    content: z.string(),
  })).optional(),
})
```

- [ ] **Step 6: Build hub to verify no TypeScript errors**

Run: `cd hub && bun build src/index.ts --target bun --outdir dist 2>&1 || echo "check errors"`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git add hub/src/ws/agent-protocol.ts hub/src/ws/agent.ts hub/src/ws/client.ts hub/src/ws/protocol.ts hub/src/index.ts
git commit -m "feat(hub): add /ws/agent endpoint with activity event relay"
```

---

### Task 6: Frontend Activity Hook and Components

**Files:**
- Create: `web/src/hooks/useActivity.ts`
- Create: `web/src/components/ThinkingBlock.tsx`
- Create: `web/src/components/ToolUseBlock.tsx`
- Create: `web/src/components/ActivityFeed.tsx`

- [ ] **Step 1: Create useActivity hook**

```typescript
import { useState, useEffect, useCallback, useRef } from 'react'

export interface ThinkingEvent { type: 'thinking'; content: string }
export interface TextDeltaEvent { type: 'text_delta'; content: string }
export interface ToolUseEvent { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
export interface ToolResultEvent { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
export interface StatusEvent { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }

export type ActivityEvent = ThinkingEvent | TextDeltaEvent | ToolUseEvent | ToolResultEvent | StatusEvent

export interface ActivityState {
  status: 'idle' | 'thinking' | 'tool_calling' | 'writing'
  thinkingText: string
  streamingText: string
  toolCalls: Array<{
    tool: string
    tool_id: string
    input: unknown
    result?: string
    is_error?: boolean
    done: boolean
  }>
}

const INITIAL_STATE: ActivityState = {
  status: 'idle',
  thinkingText: '',
  streamingText: '',
  toolCalls: [],
}

export function useActivity(
  activeSessionId: string | null,
  subscribe: (handler: (msg: any) => void) => () => void,
) {
  const [activity, setActivity] = useState<ActivityState>(INITIAL_STATE)
  const stateRef = useRef(INITIAL_STATE)

  useEffect(() => {
    if (!activeSessionId) return

    const unsub = subscribe((msg: any) => {
      if (msg.session_id !== activeSessionId) return

      if (msg.type === 'status') {
        const state = msg.state as ActivityState['status']
        if (state === 'idle') {
          // Reset on idle
          stateRef.current = INITIAL_STATE
          setActivity(INITIAL_STATE)
        } else {
          stateRef.current = { ...stateRef.current, status: state }
          setActivity({ ...stateRef.current })
        }
      }

      if (msg.type === 'thinking') {
        stateRef.current = { ...stateRef.current, thinkingText: stateRef.current.thinkingText + msg.content }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'text_delta') {
        stateRef.current = { ...stateRef.current, streamingText: stateRef.current.streamingText + msg.content }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'tool_use') {
        const call = { tool: msg.tool, tool_id: msg.tool_id, input: msg.input, done: false }
        stateRef.current = { ...stateRef.current, toolCalls: [...stateRef.current.toolCalls, call] }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'tool_result') {
        const calls = stateRef.current.toolCalls.map(tc =>
          tc.tool_id === msg.tool_id
            ? { ...tc, result: msg.content, is_error: msg.is_error, done: true }
            : tc
        )
        stateRef.current = { ...stateRef.current, toolCalls: calls }
        setActivity({ ...stateRef.current })
      }
    })

    return unsub
  }, [activeSessionId, subscribe])

  // Reset when switching sessions
  useEffect(() => {
    stateRef.current = INITIAL_STATE
    setActivity(INITIAL_STATE)
  }, [activeSessionId])

  return activity
}
```

- [ ] **Step 2: Create ThinkingBlock component**

```tsx
import { useState } from 'react'

interface Props {
  content: string
  isStreaming: boolean
}

export function ThinkingBlock({ content, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (!content) return null

  const preview = content.length > 100 ? content.slice(0, 100) + '...' : content

  return (
    <div className="rounded-lg bg-[var(--bg-tertiary)]/50 border border-[var(--border-color)] text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <span className="shrink-0">
          {isStreaming ? (
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          ) : (
            <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
          )}
        </span>
        <span className="font-medium">Thinking</span>
        <span className="text-[var(--text-muted)] truncate flex-1">{!expanded && preview}</span>
        <span className="shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-[var(--text-secondary)] whitespace-pre-wrap break-words">
          {content}
          {isStreaming && <span className="inline-block w-1 h-3 bg-amber-400 ml-0.5 animate-pulse" />}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create ToolUseBlock component**

```tsx
import { useState } from 'react'

interface ToolCall {
  tool: string
  tool_id: string
  input: unknown
  result?: string
  is_error?: boolean
  done: boolean
}

interface Props {
  toolCall: ToolCall
}

export function ToolUseBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false)

  const statusIcon = toolCall.done
    ? toolCall.is_error
      ? '✕'
      : '✓'
    : '⟳'

  const statusColor = toolCall.done
    ? toolCall.is_error
      ? 'text-red-400'
      : 'text-emerald-400'
    : 'text-amber-400 animate-spin'

  return (
    <div className="rounded-lg bg-[var(--bg-tertiary)]/50 border border-[var(--border-color)] text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <span className={`shrink-0 font-mono ${statusColor}`}>{statusIcon}</span>
        <span className="font-medium font-mono">{toolCall.tool}</span>
        {toolCall.done && !toolCall.is_error && (
          <span className="text-[var(--text-muted)]">Done</span>
        )}
        {toolCall.is_error && (
          <span className="text-red-400">Error</span>
        )}
        <span className="ml-auto shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          <pre className="text-[var(--text-muted)] overflow-x-auto text-[10px]">
            {JSON.stringify(toolCall.input, null, 2)?.slice(0, 500)}
          </pre>
          {toolCall.result && (
            <pre className={`overflow-x-auto text-[10px] ${toolCall.is_error ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
              {toolCall.result.slice(0, 1000)}
              {toolCall.result.length > 1000 && '...'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create ActivityFeed container**

```tsx
import type { ActivityState } from '../hooks/useActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolUseBlock } from './ToolUseBlock'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

interface Props {
  activity: ActivityState
}

export function ActivityFeed({ activity }: Props) {
  if (activity.status === 'idle') return null

  return (
    <div className="flex justify-start animate-msg-in">
      <div className="max-w-[80%] space-y-2 w-full">
        {/* Thinking */}
        {activity.thinkingText && (
          <ThinkingBlock
            content={activity.thinkingText}
            isStreaming={activity.status === 'thinking'}
          />
        )}

        {/* Tool calls */}
        {activity.toolCalls.map(tc => (
          <ToolUseBlock key={tc.tool_id} toolCall={tc} />
        ))}

        {/* Streaming text */}
        {activity.streamingText && (
          <div className="rounded-xl px-4 py-2.5 text-sm bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)]">
            <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-slate-900 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-emerald-300 [&_a]:text-indigo-400 break-words">
              <Markdown rehypePlugins={[rehypeSanitize]}>
                {activity.streamingText}
              </Markdown>
              {activity.status === 'writing' && (
                <span className="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 animate-pulse" />
              )}
            </div>
          </div>
        )}

        {/* Status indicator when no text yet */}
        {!activity.streamingText && !activity.thinkingText && activity.toolCalls.length === 0 && (
          <div className="bg-[var(--bg-tertiary)]/70 rounded-xl px-4 py-3 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            <span className="text-xs text-slate-400 ml-2">Claude is working...</span>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useActivity.ts web/src/components/ThinkingBlock.tsx web/src/components/ToolUseBlock.tsx web/src/components/ActivityFeed.tsx
git commit -m "feat(web): activity feed with thinking blocks, tool calls, streaming text"
```

---

### Task 7: Integrate Activity Feed into ChatPanel and Layout

**Files:**
- Modify: `web/src/components/ChatPanel.tsx`
- Modify: `web/src/components/Layout.tsx`

- [ ] **Step 1: Update Layout.tsx to create useActivity and pass to ChatPanel**

Add import and hook:
```typescript
import { useActivity } from '../hooks/useActivity'
```

Inside the Layout function, after the useChat call:
```typescript
const activity = useActivity(activeSessionId, subscribe)
```

Pass to ChatPanel:
```tsx
<ChatPanel
  messages={messages}
  loading={chatLoading}
  onSend={sendMessage}
  activeSessionId={activeSessionId}
  sessionStatus={activeSession?.status}
  activity={activity}
/>
```

- [ ] **Step 2: Update ChatPanel to show ActivityFeed and cancel button**

Add imports:
```typescript
import { ActivityFeed } from './ActivityFeed'
import type { ActivityState } from '../hooks/useActivity'
```

Add `activity` to Props:
```typescript
interface Props {
  // ... existing ...
  activity: ActivityState
}
```

In the render, after the messages list and before the typing indicator, add:
```tsx
{/* Activity feed (live streaming from agent) */}
<ActivityFeed activity={activity} />
```

Remove the old typing indicator (the `isThinking` bounce dots) since ActivityFeed handles this now.

- [ ] **Step 3: Build to verify**

Run: `cd web && bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ChatPanel.tsx web/src/components/Layout.tsx
git commit -m "feat(web): integrate activity feed into chat panel"
```

---

### Task 8: File Attachments in ChatPanel

**Files:**
- Create: `web/src/components/FileAttachmentBar.tsx`
- Modify: `web/src/components/ChatPanel.tsx`

- [ ] **Step 1: Create FileAttachmentBar**

```tsx
interface AttachedFile {
  file: File
  type: 'text' | 'image'
}

interface Props {
  files: AttachedFile[]
  onRemove: (index: number) => void
}

export function FileAttachmentBar({ files, onRemove }: Props) {
  if (files.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 px-4 pt-2">
      {files.map((f, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)] max-w-[200px]"
        >
          <span className="shrink-0">
            {f.type === 'image' ? '🖼' : '📄'}
          </span>
          <span className="truncate">{f.file.name}</span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {(f.file.size / 1024).toFixed(0)}KB
          </span>
          <button
            onClick={() => onRemove(i)}
            className="shrink-0 ml-1 text-[var(--text-muted)] hover:text-red-400 transition-colors"
            aria-label={`Remove ${f.file.name}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

export type { AttachedFile }
```

- [ ] **Step 2: Update ChatPanel with file attachment support**

Add to ChatPanel:
- `fileInputRef` and `imageInputRef` refs
- `attachedFiles` state (array of `AttachedFile`)
- `handlePaste` for Ctrl+V image paste
- `handleDrop` for drag-and-drop
- File attachment button in the input row
- Updated `handleSubmit` to read files and include in message

Key additions to the submit handler:
```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault()
  if ((!input.trim() && attachedFiles.length === 0) || !activeSessionId) return

  let content = ''
  const images: Array<{ media_type: string; data: string }> = []

  // Process text files
  for (const f of attachedFiles) {
    if (f.type === 'text') {
      const text = await readFileAsText(f.file)
      content += `[Attached file: ${f.file.name}]\n${text}\n\n`
    } else if (f.type === 'image') {
      const img = await fileToBase64(f.file)
      images.push(img)
    }
  }

  content += input.trim()
  onSend(content, images.length > 0 ? images : undefined)
  setInput('')
  setAttachedFiles([])
}
```

Size limits enforced on file add:
- Text files: max 1 MB
- Images: max 10 MB
- Max 5 total

- [ ] **Step 3: Update sendMessage in useChat to accept images**

```typescript
// In useChat.ts, update sendMessage:
const sendMessage = useCallback((content: string, images?: Array<{ media_type: string; data: string }>) => {
  if (!activeSessionId) return
  const id = crypto.randomUUID()
  const msg: any = { type: 'send_message', session_id: activeSessionId, content, id }
  if (images?.length) msg.images = images
  send(msg)
  // Optimistic add
  setMessages(prev => [...prev, {
    id,
    session_id: activeSessionId,
    role: 'user' as const,
    content,
    created_at: new Date().toISOString(),
  }])
}, [activeSessionId, send])
```

- [ ] **Step 4: Build and verify**

Run: `cd web && bun run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/FileAttachmentBar.tsx web/src/components/ChatPanel.tsx web/src/hooks/useChat.ts
git commit -m "feat(web): file attachments with paste, drop, and size limits"
```

---

### Task 9: Unread Messages

**Files:**
- Create: `web/src/components/UnreadBadge.tsx`
- Modify: `web/src/hooks/useChat.ts`
- Modify: `web/src/components/Sidebar.tsx`
- Modify: `web/src/components/SessionDropdown.tsx`

- [ ] **Step 1: Create UnreadBadge**

```tsx
interface Props {
  count: number
}

export function UnreadBadge({ count }: Props) {
  if (count <= 0) return null
  return (
    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-indigo-600 text-white text-[10px] font-bold">
      {count > 99 ? '99+' : count}
    </span>
  )
}
```

- [ ] **Step 2: Add unread tracking to useChat**

Track `lastReadAt` per session in localStorage. When a message arrives for a non-active session, increment unread. When a session becomes active, clear unread.

Add to useChat return value: `unreadCounts: Record<string, number>` and `markRead: (sessionId: string) => void`.

- [ ] **Step 3: Add UnreadBadge to Sidebar and SessionDropdown**

Pass `unreadCounts` down from Layout to Sidebar and SessionDropdown. Show badge next to session name when count > 0.

- [ ] **Step 4: Build and verify**

Run: `cd web && bun run build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/UnreadBadge.tsx web/src/hooks/useChat.ts web/src/components/Sidebar.tsx web/src/components/SessionDropdown.tsx
git commit -m "feat(web): unread message badges on sessions"
```

---

### Task 10: Integration Test and Deploy

**Files:**
- Modify: none (testing + deploy)

- [ ] **Step 1: Build web**

Run: `cd web && bun run build`
Expected: Clean build.

- [ ] **Step 2: Test agent locally**

Run:
```bash
cd agent && bun src/index.ts --hub-url https://app.remo-code.com --api-key remokey_xxx --project-dir /tmp/test
```
Expected: Agent connects, authenticates, gets session_id. Console shows `[hub-client] authenticated`.

- [ ] **Step 3: Send a test message from web UI**

Open app.remo-code.com, select the agent's session, send a message.
Expected: Agent receives `user_message`, spawns Claude CLI, streams events back. Browser shows activity feed with thinking/tool calls/text.

- [ ] **Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: remo-code v2 — streaming agent with activity feed, file attachments, unread badges"
```

- [ ] **Step 5: Push and deploy**

```bash
git push origin main
```

Trigger Coolify deploy:
```bash
curl -s -H "Authorization: Bearer <coolify-token>" "https://coolify.titaniumlabs.us/api/v1/deploy?uuid=zewfc6g9dw3c4h88z2jd2o4g&force=true"
```

- [ ] **Step 6: Verify production**

1. Run agent locally: `cd agent && bun src/index.ts --hub-url https://app.remo-code.com --api-key remokey_xxx`
2. Open app.remo-code.com on phone
3. Send message, verify activity feed shows thinking, tool calls, streaming text
4. Attach a file, verify it's included in the message
5. Check unread badge when switching sessions
