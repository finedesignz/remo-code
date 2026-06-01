/**
 * Phase 20 — inject keystroke bytes into a session's PTY via the Phase-16
 * raw-terminal input path (R-TG-08).
 *
 * A `term.input` frame (base64 bytes) is sent hub→agent on the session's agent
 * channel — the SAME byte-faithful relay the web xterm uses. This is NOT the
 * deleted `permission_response` agent message: the human's Telegram tap is
 * translated to literal TUI keystrokes (keystroke-map.ts) and written to PTY
 * stdin, driving the live interactive prompt exactly as a local keypress would.
 *
 * Targeting: the frame carries the bound `sessionId`; the relay routes it to
 * ONLY that session's agent channel (no cross-session injection — T-20-07).
 *
 * This module performs the RAW send. The turn-lock arbitration (plan 04) and the
 * human-only guard (plan 05) wrap the caller — a permission RESPONSE is exempt
 * from the turn lock (answering a prompt is not a new turn), and the human-only
 * guard is satisfied because a Telegram tap is a genuine human action routed via
 * the human-only dispatch (plan 05).
 */

import { getChannel } from '../../ws/registry.ts'
import { toBase64 } from './keystroke-map.ts'

export interface InjectResult {
  ok: boolean
  reason?: 'offline' | 'send_failed'
}

/**
 * Write `bytes` (a literal keystroke string) to `sessionId`'s PTY as a
 * `term.input` frame. Returns ok:false with a reason when the session's agent
 * channel is absent (offline) or the send throws. Never targets another session.
 */
export function injectPtyKeystroke(sessionId: string, bytes: string): InjectResult {
  const channel = getChannel(sessionId)
  if (!channel) return { ok: false, reason: 'offline' }
  const frame = {
    type: 'term.input' as const,
    session_id: sessionId,
    bytes: toBase64(bytes),
  }
  try {
    channel.ws.send(JSON.stringify(frame))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'send_failed' }
  }
}
