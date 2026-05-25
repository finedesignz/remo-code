/**
 * Triage result schema (Phase 06, plan 006).
 *
 * Structured-output JSON shape that `task_kind: 'triage'` runs must emit.
 * The dispatcher stores the validated JSON in `scheduled_task_runs.output_snippet`.
 * On parse/validation failure, the run is marked failed with reason `triage_parse_error`.
 */
import { z } from 'zod'

export const TriageResult = z.object({
  error_type: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  root_cause: z.string().min(1),
  suggested_fix: z.string().min(1),
  confidence: z.number().min(0).max(1),
  affected_files: z.array(z.string()).optional(),
})

export type TriageResult = z.infer<typeof TriageResult>

/**
 * Parse raw assistant output into a TriageResult.
 * Tolerates a leading/trailing ```json ... ``` fence; rejects bare prose,
 * non-JSON, and JSON that fails schema validation.
 */
export function parseTriageOutput(
  raw: string,
):
  | { ok: true; value: TriageResult }
  | { ok: false; error: 'triage_parse_error'; detail: string } {
  let text = (raw ?? '').trim()

  // Strip ```json ... ``` or ``` ... ``` fence if present.
  const fence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fence) text = fence[1].trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      error: 'triage_parse_error',
      detail: `invalid JSON: ${(err as Error).message}`,
    }
  }

  const r = TriageResult.safeParse(parsed)
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, error: 'triage_parse_error', detail }
  }
  return { ok: true, value: r.data }
}
