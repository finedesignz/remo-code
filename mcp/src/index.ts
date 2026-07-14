#!/usr/bin/env bun
/**
 * remo-code MCP server (milestone ASK, Phase 3).
 *
 * Gives Claude Desktop (or any MCP client — e.g. a scheduled completion-check
 * task) a first-class way to ASK the remo-code session that did the work whether
 * something is actually done, and to READ that session's memory + transcript.
 *
 * COST MODEL — read this before wiring a scheduled task:
 *   FREE (zero tokens, zero PTY writes, works for interactive sessions too):
 *     remo_list_sessions · remo_read_memory · remo_read_transcript
 *   PAID (spends tokens on a real CLI turn; bounded by the hub's non-bypassable
 *   daily cost cap, daily token cap and per-key ask-rate ceiling):
 *     remo_ask · remo_get_ask
 *   ⇒ Do the FREE reads FIRST. Escalate to `remo_ask` only when they are
 *     inconclusive. That ordering is the whole point of the read surface.
 *
 * NOTE: this ships INSIDE the remo-code repo (workspace `mcp/`) so it versions
 * with the API it wraps. Promoting it to `mcp-servers/apps/remo-code/` (gateway
 * registration alongside the other servers) is a follow-up.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { api, configFromEnv } from './client.ts'

const cfg = configFromEnv()

const server = new McpServer({ name: 'remo-code', version: '0.1.0' })

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] })
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `remo-code error: ${(err as any)?.message ?? String(err)}` }],
})

server.tool(
  'remo_list_sessions',
  'FREE. List the remo-code sessions on this hub (id, repo_ident, project_dir, runner_type, active). Use this first to resolve "the session for repo X".',
  {},
  async () => {
    try {
      return ok(await api.listSessions(cfg))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'remo_read_transcript',
  'FREE (zero tokens). Last N turns of the session\'s on-disk CLI transcript, read from the supervisor host. Works for interactive (PTY) sessions too. Try this BEFORE remo_ask.',
  {
    session: z.string().describe('Session id, repo_ident (github://owner/repo | path://<abs>), or repo name'),
    tail: z.number().int().min(1).max(200).default(30),
  },
  async ({ session, tail }) => {
    try {
      return ok(await api.readTranscript(cfg, session, tail))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'remo_read_memory',
  "FREE (zero tokens). The session project's memory files (~/.claude/projects/<slug>/memory/*.md). Try this BEFORE remo_ask.",
  { session: z.string() },
  async ({ session }) => {
    try {
      return ok(await api.readMemory(cfg, session))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'remo_state',
  'FREE. Cheap status roll-up for a session: active, runner_type, last assistant message time, open runs.',
  { session: z.string() },
  async ({ session }) => {
    try {
      return ok(await api.state(cfg, session))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'remo_ask',
  'PAID — SPENDS TOKENS. Ask the session a question and get a verified answer. A short-lived CLI in the SAME repo reads the target session\'s transcript + memory, verifies physically (git/tests/gh), and answers. Use ONLY when the free reads (remo_read_memory / remo_read_transcript) are inconclusive. Long-polls up to wait_ms; if it expires, poll remo_get_ask with the returned ask_id.',
  {
    session: z.string(),
    question: z.string().max(8_000),
    context: z.string().max(8_000).optional(),
    wait_ms: z.number().int().min(0).max(120_000).default(90_000),
  },
  async ({ session, question, context, wait_ms }) => {
    try {
      return ok(await api.ask(cfg, session, { question, context, wait_ms }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'remo_get_ask',
  'Poll a previously-created ask (no new tokens). Returns {status, answer, confidence, evidence, reason}. `reason` explains a `skipped` (e.g. over_daily_token_cap, over_ask_rate).',
  { session: z.string(), ask_id: z.string() },
  async ({ session, ask_id }) => {
    try {
      return ok(await api.getAsk(cfg, session, ask_id))
    } catch (err) {
      return fail(err)
    }
  },
)

await server.connect(new StdioServerTransport())
