// hub/src/corch/gsdc-derive.ts
//
// CORCH-04 (CORCH-R1.15): pure candidate derivation from a gsd-console project board. No I/O, no clock.
// The board JSON is untrusted data: this module only reads structure (column membership, phase number)
// and copies title/goal text into a work item, where it stays data (the prompt fences it, CORCH-R1.12).

import { createHash } from 'node:crypto'
import { z } from 'zod'

const Phase = z.object({
  number: z.string().min(1).max(40),
  name: z.string().max(2000).nullable().optional(),
  goal: z.string().max(20000).nullable().optional(),
})

/** Hard bounds on what one board may make the hub derive (QC R3): identity strings and phase counts. */
export const MAX_PHASES_PER_COLUMN = 1000
export const MAX_MILESTONE_CHARS = 100
const Phases = z.array(Phase).max(MAX_PHASES_PER_COLUMN)

/** The slice of GET /api/board/projects/{id} that derivation reads. Extra fields are ignored. */
export const BoardDetail = z.object({
  position: z
    .object({ milestone: z.object({ version: z.string().nullable(), heading: z.string() }).nullable() })
    .nullable()
    .optional(),
  snapshot: z.object({ state: z.string(), stale: z.boolean() }).nullable(),
  columns: z
    .object({
      done: Phases,
      current: Phases,
      backlog: Phases,
      pending: Phases,
    })
    .nullable(),
})
export type BoardDetail = z.infer<typeof BoardDetail>

/** The slice of a fleet summary (snapshot / project frame entry) that the skip rules read. */
export const BoardSummary = z.object({
  id: z.string().min(1).max(100),
  slug: z.string().min(1).max(200),
  stale: z.boolean(),
  divergent: z.boolean(),
  active_runs: z.number().int().nonnegative(),
})
export type BoardSummary = z.infer<typeof BoardSummary>

export interface Candidate {
  sourceRef: string
  title: string
  body: string
}

export type Derivation =
  | { kind: 'skip'; reason: 'active_runs' | 'stale' | 'divergent' | 'snapshot_not_ready' }
  | {
      kind: 'apply'
      /** The phase to queue, or null when nothing is eligible (everything done / only backlog). */
      candidate: Candidate | null
      /** source_refs of every phase the console reports done (queued items matching one are cancelled). */
      doneRefs: string[]
    }

/** Numeric dotted comparison: "2" < "10", "3.1" < "3.2". Non-numeric segments compare as strings after numbers. */
export function comparePhaseNumbers(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function milestoneOf(b: BoardDetail): string {
  const m = b.position?.milestone
  const raw = m ? (m.version ?? m.heading).trim() : ''
  if (!raw) return 'none'
  if (raw.length <= MAX_MILESTONE_CHARS) return raw
  // Over-long identity: keep a readable prefix plus a hash of the whole string, so two different milestones
  // that share a long prefix can never collide on source_ref.
  return `${raw.slice(0, MAX_MILESTONE_CHARS - 17)}#${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

export function sourceRefOf(slug: string, milestone: string, phaseNumber: string): string {
  return `${slug}:${milestone}:${phaseNumber}`
}

/**
 * Candidate = the `current` phase, else the lowest-numbered `pending` phase; `backlog` is never a candidate.
 * Skipped entirely (no upsert AND no cancellation) while the project has active runs, is stale or divergent,
 * or its snapshot is not ready: the console is then not authoritative about the board.
 */
export function deriveCandidate(slug: string, summary: BoardSummary, board: BoardDetail): Derivation {
  if (summary.active_runs > 0) return { kind: 'skip', reason: 'active_runs' }
  if (summary.stale) return { kind: 'skip', reason: 'stale' }
  if (summary.divergent) return { kind: 'skip', reason: 'divergent' }
  if (!board.snapshot || board.snapshot.state !== 'ready' || board.snapshot.stale || !board.columns) {
    return { kind: 'skip', reason: 'snapshot_not_ready' }
  }
  const milestone = milestoneOf(board)
  const doneRefs = board.columns.done.map((p) => sourceRefOf(slug, milestone, p.number))
  const pending = [...board.columns.pending].sort((a, b) => comparePhaseNumbers(a.number, b.number))
  const phase = board.columns.current[0] ?? pending[0] ?? null
  if (!phase) return { kind: 'apply', candidate: null, doneRefs }
  const name = (phase.name ?? '').trim()
  return {
    kind: 'apply',
    candidate: {
      sourceRef: sourceRefOf(slug, milestone, phase.number),
      title: `Phase ${phase.number}${name ? `: ${name}` : ''}`.slice(0, 200),
      body: (phase.goal ?? '').slice(0, 4000),
    },
    doneRefs,
  }
}
