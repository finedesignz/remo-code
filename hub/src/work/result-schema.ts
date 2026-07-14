/**
 * Work-reply envelope parser (milestone WORK / `remo_work`).
 *
 * DIFFERENT FROM `hub/src/ask/result-schema.ts` IN ONE LOAD-BEARING WAY: the
 * envelope is NONCE'D and there is NO tolerant fallback that can promote arbitrary
 * text into a result.
 *
 *   <<WORK:{nonce}>> { ...json... } <<END:{nonce}>>
 *
 * WHY: an ask's worst case is a wrong answer. A work item's worst case is a change
 * on a LIVE CLIENT WEBSITE. The reply drives `published` / `pr_url` / `live_url`,
 * and the untrusted email body sits in the same conversation — so:
 *
 *   - the nonce is server-generated per work item and appears ONLY in the prompt
 *     (which the email author has never seen);
 *   - only an envelope carrying THAT nonce is accepted (`ENVELOPE_RE` is built from
 *     the nonce, and the nonce is regex-escaped);
 *   - the LAST match wins, so a quoted/echoed earlier envelope cannot pre-empt the
 *     real one;
 *   - a missing/!parsing/!schema-valid envelope is NOT coerced into a success. It
 *     yields `ok:false` and the caller finalizes `needs_human` — fail closed.
 *
 * Belt-and-braces reminder: `published` here is only a CLAIM. `finalizeWork` ANDs
 * it with the site's `auto_publish` flag in SQL, so a claim on an untrusted site is
 * discarded regardless of what the agent says.
 */
import { z } from 'zod'

export const WorkResult = z.object({
  status: z.enum(['completed', 'qc_failed', 'needs_human']),
  summary: z.string().default(''),
  files_changed: z.array(z.string()).default([]),
  commit_shas: z.array(z.string()).default([]),
  qc: z.unknown().nullable().default(null),
  diff_url: z.string().nullable().default(null),
  pr_url: z.string().nullable().default(null),
  preview_url: z.string().nullable().default(null),
  live_url: z.string().nullable().default(null),
  published: z.boolean().default(false),
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
