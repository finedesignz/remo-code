/**
 * Revanote agent-reply envelope parser.
 *
 * Agents reply naturally to the user prompt, but ALSO embed a machine-
 * readable JSON status between `<<JSON>>` and `<<END>>` markers (matches the
 * legacy `revanote-hook` reference impl):
 *
 *   ...natural language...
 *   <<JSON>>
 *   { "resolved": true, "action_taken": "...", "files_changed": [...] }
 *   <<END>>
 *   ...maybe more prose...
 *
 * Tolerances (in priority order):
 *   1. `<<JSON>>...<<END>>` envelope — preferred, never ambiguous.
 *   2. ```json ... ``` fenced block — fallback when the model forgets the
 *      envelope but still emits structured output.
 *   3. Bare prose — last resort, returns `{ resolved: false, action_taken:
 *      'parse_failed', agent_reply: raw }` so the run can still finalize +
 *      callback with a useful error.
 *
 * Modeled on `scheduler/triage-schema.ts` `parseTriageOutput`.
 */
import { z } from 'zod'

export const RevanoteResult = z.object({
  resolved: z.boolean(),
  action_taken: z.string().default(''),
  agent_reply: z.string().optional(),
  files_changed: z.array(z.string()).default([]),
  deployed: z.boolean().optional(),
  needs_clarification: z.boolean().optional(),
  clarification_question: z.string().optional(),
  // Phase 5 — best-guess-default fix contract (additive).
  assumption: z.string().optional(),
  clarification_reason: z.string().optional(),
})

export type RevanoteResult = z.infer<typeof RevanoteResult>

const ENVELOPE_RE = /<<JSON>>([\s\S]*?)<<END>>/i
const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i

export interface ParseOk {
  ok: true
  value: RevanoteResult
  /** raw natural-language portion (envelope/fence stripped). */
  preface: string
}
export interface ParseFallback {
  ok: false
  reason: 'envelope_missing' | 'invalid_json' | 'schema_invalid'
  detail: string
  value: RevanoteResult
  preface: string
}

export function parseRevanoteOutput(raw: string): ParseOk | ParseFallback {
  const text = (raw ?? '').trim()
  if (!text) {
    return {
      ok: false,
      reason: 'envelope_missing',
      detail: 'empty reply',
      value: { resolved: false, action_taken: 'empty_reply', agent_reply: '', files_changed: [] },
      preface: '',
    }
  }

  const envMatch = text.match(ENVELOPE_RE)
  let jsonText: string | null = null
  let preface = text
  let reason: 'envelope_missing' | 'invalid_json' | 'schema_invalid' | null = null

  if (envMatch) {
    jsonText = envMatch[1].trim()
    preface = text.replace(envMatch[0], '').trim()
  } else {
    const fence = text.match(FENCE_RE)
    if (fence) {
      jsonText = fence[1].trim()
      preface = text.replace(fence[0], '').trim()
    } else {
      reason = 'envelope_missing'
    }
  }

  if (jsonText) {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (err) {
      reason = 'invalid_json'
    }
    if (parsed !== undefined) {
      const r = RevanoteResult.safeParse(parsed)
      if (r.success) {
        return { ok: true, value: { ...r.data, agent_reply: r.data.agent_reply ?? (preface || undefined) }, preface }
      }
      reason = 'schema_invalid'
    }
  }

  // Fallback — emit a synthetic, conservative result so the lifecycle can
  // still finalize and the callback can still fire.
  const fallback: RevanoteResult = {
    resolved: false,
    action_taken: reason ?? 'parse_failed',
    agent_reply: preface || text,
    files_changed: [],
  }
  return {
    ok: false,
    reason: reason ?? 'envelope_missing',
    detail: jsonText ? jsonText.slice(0, 200) : 'no envelope or fenced JSON found',
    value: fallback,
    preface,
  }
}

/**
 * Strip the JSON envelope (and any obvious fenced JSON block) from a piece
 * of assistant text for human display. The web client uses this for the
 * MessageBubble render path.
 */
export function stripRevanoteEnvelope(text: string): string {
  return (text ?? '')
    .replace(ENVELOPE_RE, '')
    .replace(/```json[\s\S]*?```/gi, '')
    .trim()
}
