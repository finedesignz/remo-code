/**
 * Ask-reply envelope parser (milestone ASK, Phase 2).
 *
 * Modeled 1:1 on `hub/src/revanote/result-schema.ts`. The ask prompt tells the CLI
 * to end its reply with:
 *
 *   <<ASK>>
 *   { "answer": "...", "done": true, "confidence": "high",
 *     "evidence": ["PR #412 merged", "CI green"] }
 *   <<END>>
 *
 * Tolerances (priority order): envelope → ```json fence → bare prose (the raw text
 * becomes the answer at `confidence:'low'`), so an external caller ALWAYS gets an
 * answer even when the model forgets the envelope.
 */
import { z } from 'zod'

export const AskResult = z.object({
  answer: z.string(),
  done: z.boolean().optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  evidence: z.array(z.string()).default([]),
})

export type AskResult = z.infer<typeof AskResult>

const ENVELOPE_RE = /<<ASK>>([\s\S]*?)<<END>>/i
const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i

export interface AskParse {
  ok: boolean
  reason?: 'envelope_missing' | 'invalid_json' | 'schema_invalid'
  value: AskResult
}

export function parseAskOutput(raw: string): AskParse {
  const text = (raw ?? '').trim()
  if (!text) {
    return {
      ok: false,
      reason: 'envelope_missing',
      value: { answer: '', confidence: 'low', evidence: [] },
    }
  }

  let jsonText: string | null = null
  let preface = text
  let reason: AskParse['reason']

  const env = text.match(ENVELOPE_RE)
  if (env) {
    jsonText = env[1].trim()
    preface = text.replace(env[0], '').trim()
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
    } catch {
      reason = 'invalid_json'
    }
    if (parsed !== undefined) {
      const r = AskResult.safeParse(parsed)
      if (r.success) return { ok: true, value: r.data }
      reason = 'schema_invalid'
    }
  }

  // Bare-prose fallback: the whole reply IS the answer, at low confidence.
  return {
    ok: false,
    reason: reason ?? 'envelope_missing',
    value: { answer: preface || text, confidence: 'low', evidence: [] },
  }
}
