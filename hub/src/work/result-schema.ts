/**
 * Work-reply envelope parser (milestone WORK / `remo_work`).
 *
 * THE AGENT PROPOSES. Its reply can say ONE thing: "I pushed branch X with commits Y".
 * There is no `published` field, no `live_url` field and no QC verdict field, because
 * publishing and QC are the HUB's, performed by the hub, on hub-observed facts. A reply
 * therefore cannot assert anything about production — not even dishonestly.
 *
 * The envelope is NONCE'D and there is NO tolerant fallback:
 *   - the nonce is server-generated per work item and appears ONLY in the prompt (which
 *     the email author has never seen);
 *   - only an envelope carrying THAT nonce is accepted (regex built from the nonce);
 *   - the LAST match wins, so a quoted/echoed earlier envelope cannot pre-empt the real
 *     one;
 *   - missing / unparseable / schema-invalid ⇒ `ok:false`, and the caller finalizes
 *     `needs_human`. An unparseable reply is never coerced into a success.
 */
import { z } from 'zod'

export const WorkResult = z.object({
  /** `proposed` = a branch was pushed. `needs_human` = stopped, nothing to review. */
  status: z.enum(['proposed', 'needs_human']),
  summary: z.string().default(''),
  branch: z.string().nullable().default(null),
  commit_shas: z.array(z.string()).default([]),
  /** ADVISORY. The hub re-derives the real file list from the branch diff. */
  files_changed: z.array(z.string()).default([]),
  /** ADVISORY metadata only. Never the basis of a publish decision. */
  self_check: z.unknown().nullable().default(null),
  blocker: z.string().nullable().default(null),
})

export type WorkResult = z.infer<typeof WorkResult>

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface WorkParse {
  ok: boolean
  reason?: 'envelope_missing' | 'invalid_json' | 'schema_invalid'
  value: WorkResult | null
}

/** Parse an agent reply against THIS work item's nonce. Fails closed. */
export function parseWorkOutput(raw: string, nonce: string): WorkParse {
  const text = (raw ?? '').trim()
  if (!text || !nonce) return { ok: false, reason: 'envelope_missing', value: null }

  const n = escapeRe(nonce)
  const re = new RegExp(`<<WORK:${n}>>([\\s\\S]*?)<<END:${n}>>`, 'g')

  // LAST match wins — a quoted/echoed envelope earlier in the reply cannot pre-empt
  // the agent's real, final one.
  let jsonText: string | null = null
  for (const m of text.matchAll(re)) jsonText = m[1].trim()
  if (jsonText == null) return { ok: false, reason: 'envelope_missing', value: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, reason: 'invalid_json', value: null }
  }

  const r = WorkResult.safeParse(parsed)
  if (!r.success) return { ok: false, reason: 'schema_invalid', value: null }
  return { ok: true, value: r.data }
}
