#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, chmodSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// -- Config --

const STATE_DIR = join(homedir(), '.claude', 'channels', 'hub')
const ENV_FILE = join(STATE_DIR, '.env')

// Load env from state dir
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const HUB_URL = process.env.HUB_URL
const HUB_TOKEN = process.env.HUB_TOKEN
const SESSION_ID = process.env.SESSION_ID || require('path').basename(process.cwd())

if (!HUB_URL || !HUB_TOKEN) {
  process.stderr.write(
    'hub channel: HUB_URL and HUB_TOKEN required.\n' +
    'Run /hub:configure <hub_url> <token> or set them in ' + ENV_FILE + '\n'
  )
  process.exit(1)
}

// -- MCP Server --

const mcp = new Server(
  { name: 'hub', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'The sender reads a web UI, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their browser.',
      '',
      'Messages from the web arrive as <channel source="hub" chat_id="..." message_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back.',
      'Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
      '',
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments.',
      'Use react to add emoji reactions, and edit_message to update a message you previously sent.',
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
        const text = String(args.text || '')
        sendToHub({
          type: 'assistant_message',
          id: crypto.randomUUID(),
          content: text,
          ts: new Date().toISOString(),
        })
        return { content: [{ type: 'text' as const, text: 'sent' }] }
      }

      case 'react': {
        // Reactions are currently a no-op on the hub side — acknowledged silently
        return { content: [{ type: 'text' as const, text: `reacted ${args.emoji}` }] }
      }

      case 'edit_message': {
        // Edit support — send as assistant_message with same ID for now
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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const RECONNECT_DELAY_MS = 5_000

function connectToHub() {
  const wsUrl = HUB_URL!.replace(/^http/, 'ws') + '/ws/channel'
  process.stderr.write(`hub channel: connecting to ${wsUrl}\n`)

  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    process.stderr.write('hub channel: connected, authenticating...\n')
    ws!.send(JSON.stringify({
      type: 'auth',
      session_id: SESSION_ID,
      token: HUB_TOKEN,
    }))
  }

  ws.onmessage = async (event) => {
    let msg: any
    try { msg = JSON.parse(String(event.data)) } catch { return }

    if (msg.type === 'auth_ok') {
      process.stderr.write('hub channel: authenticated\n')
      // Send status
      sendToHub({ type: 'status', status: 'idle' })
    }

    if (msg.type === 'auth_error') {
      process.stderr.write(`hub channel: auth failed — ${msg.error}\n`)
      ws?.close()
    }

    if (msg.type === 'user_message') {
      // Push into Claude Code session
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.content,
          meta: {
            chat_id: SESSION_ID,
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

  ws.onclose = () => {
    process.stderr.write('hub channel: disconnected, reconnecting in 5s...\n')
    ws = null
    reconnectTimer = setTimeout(connectToHub, RECONNECT_DELAY_MS)
  }

  ws.onerror = (err) => {
    process.stderr.write(`hub channel: ws error\n`)
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
