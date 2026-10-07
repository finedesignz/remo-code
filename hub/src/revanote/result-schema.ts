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
  // `.nullable()` alongside `.optional()`: an agent that made no assumption /
  // needs no clarification may emit an explicit `null` for the unused key
  // rather than omitting it. Every consumer already normalizes via `?? null`
  // or `=== true`, so null is treated identically to absent end-to-end (05-QC
  // BLOCKER 3 — without this, a genuinely successful fix gets parsed as
  // schema_invalid and reported to revanote as `failed`).
  agent_reply: z.string().optional().nullable(),
  files_changed: z.array(z.string()).default([]),
  deployed: z.boolean().optional().nullable(),
  // Gate for `resolved: true` (see commit-verify.ts) — the pushed commit SHA
  // the agent claims made the fix. Required for resolved to be trusted;
  // missing/unverifiable ⇒ finalizeAnnotationReply downgrades to resolved=false.
  commit_sha: z.string().optional().nullable(),
  // Advisory only (not gated) — the live URL the agent claims to have
  // re-fetched to confirm the deploy. See prompt.ts.
  deploy_url: z.string().optional().nullable(),
  needs_clarification: z.boolean().optional().nullable(),
  clarification_question: z.string().optional().nullable(),
  // Phase 5 — best-guess-default fix contract (additive).
  assumption: z.string().optional().nullable(),
  clarification_reason: z.string().optional().nullable(),
  // The branch the agent pushed (commit_sha is declared above); the hub
  // verifies the commit on the remote (see commit-verify.ts).
  branch: z.string().optional().nullable(),
})

export type RevanoteResult = z.infer<typeof RevanoteResult>

export const ENVELOPE_RE = /<<JSON>>([\s\S]*?)<<END>>/i
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

// ── Batch envelope (feat/revanote-batch-dispatch) ───────────────────────────
//
// A batch-dispatched turn covers N annotations in one session turn, so the
// envelope carries one entry per annotation instead of a single result. Each
// entry is keyed by the annotation's EXTERNAL id (`annotation_id_external` —
// the id revanote itself knows and the one every other callback path already
// echoes back), so the reply can be routed to the right annotation without
// leaking internal DB ids into the prompt.
export const RevanoteBatchItem = RevanoteResult.extend({
  annotation_id: z.string().min(1),
})
export type RevanoteBatchItem = z.infer<typeof RevanoteBatchItem>

export const RevanoteBatchResult = z.object({
  annotations: z.array(RevanoteBatchItem).min(1),
})
export type RevanoteBatchResult = z.infer<typeof RevanoteBatchResult>

export interface ParseBatchOk {
  ok: true
  value: RevanoteBatchResult
}
export interface ParseBatchFallback {
  ok: false
  reason: 'envelope_missing' | 'invalid_json' | 'schema_invalid'
  detail: string
}

/**
 * Parse a batch reply's `<<JSON>>{"annotations":[...]}<<END>>` envelope.
 * Tolerates the same envelope/fence shapes as `parseRevanoteOutput`, but does
 * NOT synthesize a fallback value — an unparseable batch reply has no single
 * sensible per-annotation fallback, so the caller (`batch-dispatch.ts`) falls
 * every member back through `parseRevanoteOutput`'s own single-item fallback
 * (`schema_invalid`/`envelope_missing`) instead, exactly mirroring what a
 * single (non-batched) unparseable reply already does.
 */
export function parseRevanoteBatchOutput(raw: string): ParseBatchOk | ParseBatchFallback {
  const text = (raw ?? '').trim()
  if (!text) return { ok: false, reason: 'envelope_missing', detail: 'empty reply' }

  const envMatch = text.match(ENVELOPE_RE)
  let jsonText: string | null = null
  if (envMatch) {
    jsonText = envMatch[1].trim()
  } else {
    const fence = text.match(FENCE_RE)
    if (fence) jsonText = fence[1].trim()
  }
  if (!jsonText) return { ok: false, reason: 'envelope_missing', detail: 'no envelope or fenced JSON found' }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (err: any) {
    return { ok: false, reason: 'invalid_json', detail: err?.message ?? 'invalid JSON' }
  }
  const r = RevanoteBatchResult.safeParse(parsed)
  if (!r.success) {
    return { ok: false, reason: 'schema_invalid', detail: jsonText.slice(0, 200) }
  }
  return { ok: true, value: r.data }
}

/**
 * Rebuild a single-annotation `<<JSON>>...<<END>>` envelope string from one
 * batch-item result, so the existing single-annotation finalize path
 * (`run-lifecycle.ts` `finalizeAnnotationReply`) can be reused verbatim per
 * batch member — same commit-verify gate, same DB writes, same callback shape.
 */
export function envelopeForBatchItem(item: Omit<RevanoteBatchItem, 'annotation_id'>): string {
  return `<<JSON>>\n${JSON.stringify(item)}\n<<END>>`
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
