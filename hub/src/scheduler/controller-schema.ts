/**
 * Dev-controller decision schema (auto-dev P2).
 *
 * The `dev_controller` step (and a bare `dev` root, which renders the same
 * controller prompt) emits a `<<DECISION ... DECISION>>` block at the end of its
 * turn. The post-run router parses it and chains the appropriate next workflow
 * step. Mirrors the `parseTriageOutput` convention in `triage-schema.ts`.
 *
 * Robustness: tolerant of surrounding prose, missing keys, and a missing block.
 * A missing/unparseable block falls back to `continue` so a bare `dev` still
 * does something safe (resume work) rather than stalling.
 */
import { z } from 'zod'

export const ControllerAction = z.enum([
  'bootstrap',
  'continue',
  'ship',
  'plan',
  'propose',
])
export type ControllerAction = z.infer<typeof ControllerAction>

export interface ControllerDecision {
  action: ControllerAction
  reason: string
  next_goal: string
  roadmap: string | null
}

// Open marker `<<DECISION`, body, then a closing `DECISION` (bare, as the spec
// artifact emits) or `DECISION>>`. Closing is matched at a line boundary so the
// word "DECISION" inside the body/prose doesn't terminate the block early.
// Open marker `<<DECISION`, body, then a closing `DECISION` (bare, as the spec
// artifact emits) or `DECISION>>`. Closing is matched at a line boundary so the
// word "DECISION" inside the body/prose doesn't terminate the block early.
const BLOCK_RE = /<<DECISION\b([\s\S]*?)(?:^|\n)\s*DECISION(?:>>)?(?:\s|$)/i

/**
 * Match the full `<<DECISION … DECISION>>` block (including markers) within a
 * larger reply. Used by the agent sender to preserve the block in the run's
 * output_snippet (the default head-truncation would otherwise drop it). Returns
 * the matched block text, or null when no block is present.
 */
export function extractDecisionBlock(raw: string): string | null {
  const m = (raw ?? '').match(/<<DECISION\b[\s\S]*?(?:^|\n)\s*DECISION(?:>>)?(?:\s|$)/i)
  return m ? m[0].trimEnd() : null
}

/**
 * Parse the controller's `<<DECISION ... DECISION>>` block.
 *
 * Returns `{ ok: true, value }` on a recognized block, else
 * `{ ok: false, fallback }` with the safe `continue` fallback decision (a bare
 * dev should still resume rather than stall on a malformed/absent block).
 */
export function parseControllerDecision(
  raw: string,
):
  | { ok: true; value: ControllerDecision }
  | { ok: false; reason: string; fallback: ControllerDecision } {
  const fallback: ControllerDecision = {
    action: 'continue',
    reason: 'controller_decision_unparseable_fallback',
    next_goal: 'Continue where you left off.',
    roadmap: null,
  }

  const text = raw ?? ''
  const m = text.match(BLOCK_RE)
  if (!m) return { ok: false, reason: 'no_decision_block', fallback }

  const body = m[1]
  const fields: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const val = line.slice(idx + 1).trim()
    if (key) fields[key] = val
  }

  const actionRaw = (fields.action ?? '').toLowerCase()
  const action = ControllerAction.safeParse(actionRaw)
  if (!action.success) {
    return { ok: false, reason: `invalid_action:${actionRaw || '(empty)'}`, fallback }
  }

  const roadmap = fields.roadmap && fields.roadmap.length > 0 ? fields.roadmap : null

  return {
    ok: true,
    value: {
      action: action.data,
      reason: fields.reason ?? '',
      next_goal: fields.next_goal ?? '',
      roadmap,
    },
  }
}

/**
 * Map a controller action to the chained next-step kind, or `null` for actions
 * that must NOT chain (`propose` — human-in-the-loop, surfaced to chat in P3).
 */
export function nextStepForAction(action: ControllerAction): string | null {
  switch (action) {
    case 'bootstrap':
    case 'plan':
      return 'dev_plan'
    case 'continue':
      return 'dev_execute'
    case 'ship':
      return 'dev_ship'
    case 'propose':
      return null
  }
}
