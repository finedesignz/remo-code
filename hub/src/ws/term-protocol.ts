/**
 * term-protocol.ts — Phase-15 raw-terminal WS frame schema.
 *
 * DELIBERATELY ISOLATED from the structured agent-protocol pipeline
 * (R-PTY-03). This module:
 *   - does NOT import agent-protocol.ts / protocol.ts,
 *   - does NOT reference the RunnerEvent union,
 *   - carries OPAQUE terminal bytes (base64) — the hub relays them
 *     byte-faithfully between /ws/client and /ws/agent and NEVER parses the
 *     payload as a structured event or persists it as a `messages` row.
 *
 * Frames (carried over the EXISTING authenticated WS connections, keyed by
 * session_id, reusing the existing subscribe/ownership authorization):
 *   term.data    agent  -> hub -> client(s)   raw PTY output bytes
 *   term.input   client -> hub -> agent       raw keystrokes
 *   term.resize  client -> hub -> agent       cols/rows
 *   term.attach  client -> hub -> agent       request to (re)attach a PTY view
 *
 * Phase 16 hardens this channel (auth scoping, resize debounce, reattach
 * semantics, binary frames). The spike keeps base64-over-JSON for simplicity.
 */
import { z } from 'zod'

export const TermData = z.object({
  type: z.literal('term.data'),
  session_id: z.string(),
  bytes: z.string(), // base64-encoded raw terminal output
})

export const TermInput = z.object({
  type: z.literal('term.input'),
  session_id: z.string(),
  bytes: z.string(), // base64-encoded raw keystrokes
})

export const TermResize = z.object({
  type: z.literal('term.resize'),
  session_id: z.string(),
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
})

export const TermAttach = z.object({
  type: z.literal('term.attach'),
  session_id: z.string(),
})

// Phase 16 (R-PTY-08): reattach after a reconnect — the host replays the
// session's buffered scrollback, then resumes live `term.data`. `scrollback` is
// an optional opaque base64 blob the HOST may carry on the reply; clients send
// it bare (no payload) to REQUEST replay.
export const TermReattach = z.object({
  type: z.literal('term.reattach'),
  session_id: z.string(),
  scrollback: z.string().optional(), // base64; host→client replay only
})

export const TermFrame = z.discriminatedUnion('type', [
  TermData,
  TermInput,
  TermResize,
  TermAttach,
  TermReattach,
])
export type TermFrameT = z.infer<typeof TermFrame>

/**
 * Per-socket frame-DIRECTION allowlist (Phase 16, NH-2 / R-PTY-33).
 *
 * `term.input` is a client→PTY WRITE — accepted ONLY on /ws/client, NEVER on
 * /ws/agent. /ws/agent terminal frames are OUTPUT-ONLY (`term.data`). This is the
 * mechanism that stops an inventory-valid supervisor socket from injecting input
 * into a human PTY (NH-2). The relay consults these sets BEFORE forwarding.
 */
export const CLIENT_TO_HUB_TERM_TYPES = new Set<TermFrameT['type']>([
  'term.input',
  'term.resize',
  'term.attach',
  'term.reattach',
])
export const AGENT_TO_HUB_TERM_TYPES = new Set<TermFrameT['type']>([
  'term.data',
])
export function isClientToHubTermType(t: string): boolean {
  return CLIENT_TO_HUB_TERM_TYPES.has(t as TermFrameT['type'])
}
export function isAgentToHubTermType(t: string): boolean {
  return AGENT_TO_HUB_TERM_TYPES.has(t as TermFrameT['type'])
}

/** Cheap discriminator: does a parsed JSON object look like a term.* frame?
 *  Used by the WS handlers to short-circuit BEFORE the structured-protocol
 *  safeParse, so term frames never enter the agent-protocol path. */
export function isTermFrameType(parsed: unknown): boolean {
  const t = (parsed as any)?.type
  return typeof t === 'string' && t.startsWith('term.')
}
