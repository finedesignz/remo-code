#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

// -- State Management --

const STATE_DIR = join(homedir(), '.claude', 'channels', 'remo-code')
const STATE_FILE = join(STATE_DIR, 'state.json')
const ENV_FILE = join(STATE_DIR, '.env')

interface SessionCache {
  session_id: string
  token: string
  name: string
}

interface PluginState {
  hub_url: string
  api_key: string
  sessions: Record<string, SessionCache>
}

function loadState(): PluginState | null {
  // Try state.json first
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PluginState
    if (state.hub_url && state.api_key) return state
  } catch {}

  // Fall back to .env for backward compatibility
  try {
    chmodSync(ENV_FILE, 0o600)
    const env: Record<string, string> = {}
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) env[m[1]] = m[2]
    }
    if (env.HUB_URL && env.HUB_TOKEN) {
      const projectDir = process.cwd()
      const sessionId = env.SESSION_ID || basename(projectDir)
      return {
        hub_url: env.HUB_URL,
        api_key: '', // no API key in legacy mode
        sessions: {
          [projectDir]: { session_id: sessionId, token: env.HUB_TOKEN, name: basename(projectDir) },
        },
      }
    }
  } catch {}

  return null
}

function saveState(state: PluginState) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  try { chmodSync(STATE_FILE, 0o600) } catch {}
}

// -- Load config --

const state = loadState()
if (!state) {
  process.stderr.write(
    'remo-code: No configuration found.\n' +
    'Generate an API key at https://app.remo-code.com, then run:\n' +
    '  /remo-code:configure <api_key>\n'
  )
  process.exit(1)
}

// Determine the actual project directory.
// The plugin runs with --cwd pointing to the channel/ subdirectory,
// so process.cwd() is wrong. We walk up to find the git root, or
// use CLAUDE_PROJECT_DIR if set by Claude Code.
function findProjectDir(): string {
  // Check env var first (future Claude Code versions may set this)
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR

  // Walk up from cwd looking for .git (project root indicator)
  let dir = process.cwd()
  const { root } = require('path').parse(dir)
  while (dir !== root) {
    if (existsSync(join(dir, '.git'))) return dir
    dir = join(dir, '..')
    dir = require('path').resolve(dir)
  }

  // Fallback: if cwd basename is a known plugin subdir, go up one level
  const cwd = process.cwd()
  const base = basename(cwd)
  if (base === 'channel' || base === 'plugin') {
    return require('path').resolve(join(cwd, '..'))
  }

  return cwd
}

const PROJECT_DIR = findProjectDir()

// -- Auto-register session via API key --

async function ensureSession(): Promise<SessionCache> {
  const cached = state!.sessions[PROJECT_DIR]
  if (cached) return cached

  if (!state!.api_key) {
    process.stderr.write('remo-code: no API key configured, cannot auto-register\n')
    process.exit(1)
  }

  process.stderr.write('remo-code: auto-registering session...\n')

  const res = await fetch(`${state!.hub_url}/api/plugin/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state!.api_key}`,
    },
    body: JSON.stringify({ project_dir: PROJECT_DIR }),
  })

  if (res.status === 401) {
    process.stderr.write(
      'remo-code: API key is invalid or revoked.\n' +
      'Generate a new key at https://app.remo-code.com, then run:\n' +
      '  /remo-code:configure <new_api_key>\n'
    )
    process.exit(1)
  }

  if (!res.ok) {
    const text = await res.text()
    process.stderr.write(`remo-code: registration failed (${res.status}): ${text}\n`)
    process.exit(1)
  }

  const data = await res.json() as { session_id: string; token: string; name: string }
  const session: SessionCache = { session_id: data.session_id, token: data.token, name: data.name }
  state!.sessions[PROJECT_DIR] = session
  saveState(state!)

  process.stderr.write(`remo-code: registered session "${data.name}" (${data.session_id})\n`)
  return session
}

async function reRegister(): Promise<SessionCache | null> {
  if (!state!.api_key) return null

  // Clear cached token for this project
  delete state!.sessions[PROJECT_DIR]
  saveState(state!)

  try {
    return await ensureSession()
  } catch (err: any) {
    process.stderr.write(`remo-code: re-registration failed: ${err.message}\n`)
    return null
  }
}

// -- MCP Server --

const mcp = new Server(
  { name: 'remo-code', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'The sender reads a web UI, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their browser.',
      '',
      'Messages from the web arrive as <channel source="remo-code" chat_id="..." message_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back.',
      'Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments.',
      'Use react to add emoji reactions, and edit_message to update a message you previously sent.',
      '',
      'IMPORTANT: The user cannot see your terminal output. When working on a task that takes more than a few seconds:',
      '1. Send a brief reply immediately acknowledging what you will do (e.g. "Looking into that..." or "Let me check the logs.")',
      '2. As you work, send progress updates via reply every 30-60 seconds for longer tasks (e.g. "Found the issue in auth.ts, fixing now..." or "Tests passing, deploying...")',
      '3. Send a final reply with the result or answer.',
      'This keeps the user informed since they cannot see your work in progress.',
    ].join('\n'),
  },
)

// -- Tools --

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to the web UI. Pass chat_id from the inbound message. The text appears in the user\'s browser.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'Chat/session ID from the inbound message' },
          text: { type: 'string', description: 'The message to send' },
          reply_to: { type: 'string', description: 'Message ID to thread under (optional)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach (optional)' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'Add an emoji reaction to a message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a message the bot previously sent',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'reply': {
        sendToHub({
          type: 'assistant_message',
          id: crypto.randomUUID(),
          content: String(args.text || ''),
          ts: new Date().toISOString(),
        })
        return { content: [{ type: 'text' as const, text: 'sent' }] }
      }
      case 'react': {
        return { content: [{ type: 'text' as const, text: `reacted ${args.emoji}` }] }
      }
      case 'edit_message': {
        sendToHub({
          type: 'assistant_message',
          id: String(args.message_id),
          content: String(args.text || ''),
          ts: new Date().toISOString(),
        })
        return { content: [{ type: 'text' as const, text: 'edited' }] }
      }
      default:
        return { content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err: any) {
    return { content: [{ type: 'text' as const, text: `failed: ${err.message}` }], isError: true }
  }
})

// -- WebSocket to Hub --

let ws: WebSocket | null = null
let currentSession: SessionCache | null = null
const RECONNECT_DELAY_MS = 5_000

async function connectToHub() {
  if (!currentSession) {
    currentSession = await ensureSession()
  }

  const wsUrl = state!.hub_url.replace(/^http/, 'ws') + '/ws/channel'
  process.stderr.write(`remo-code: connecting to ${wsUrl}\n`)

  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    process.stderr.write('remo-code: connected, authenticating...\n')
    ws!.send(JSON.stringify({
      type: 'auth',
      session_id: currentSession!.session_id,
      token: currentSession!.token,
    }))
  }

  ws.onmessage = async (event) => {
    let msg: any
    try { msg = JSON.parse(String(event.data)) } catch { return }

    if (msg.type === 'auth_ok') {
      process.stderr.write(`remo-code: authenticated as "${currentSession!.name}"\n`)
      sendToHub({ type: 'status', status: 'idle' })
    }

    if (msg.type === 'auth_error') {
      process.stderr.write(`remo-code: auth failed — ${msg.error}\n`)
      // Don't close here — onclose will handle re-registration
    }

    if (msg.type === 'user_message') {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            chat_id: currentSession!.session_id,
            message_id: msg.id,
            user: 'web',
            ts: msg.ts,
          },
        },
      })
    }

    if (msg.type === 'ping') {
      ws?.send(JSON.stringify({ type: 'pong' }))
    }
  }

  ws.onclose = (event) => {
    ws = null

    if (event.code === 4001 || event.code === 4004) {
      // Auth failed or token rotated — re-register via API key
      process.stderr.write(`remo-code: token invalid (${event.code}), re-registering...\n`)
      currentSession = null
      setTimeout(async () => {
        const newSession = await reRegister()
        if (newSession) {
          currentSession = newSession
          connectToHub()
        } else {
          process.stderr.write('remo-code: could not re-register, will retry in 30s\n')
          setTimeout(connectToHub, 30_000)
        }
      }, 1_000)
    } else {
      // Network issue — simple reconnect with cached token
      process.stderr.write('remo-code: disconnected, reconnecting in 5s...\n')
      setTimeout(connectToHub, RECONNECT_DELAY_MS)
    }
  }

  ws.onerror = () => {
    process.stderr.write('remo-code: ws error\n')
  }
}

function sendToHub(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// -- Start --

await mcp.connect(new StdioServerTransport())
connectToHub()
