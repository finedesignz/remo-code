// hub/src/orchestrator/gap-rotation.ts
// Phase 26 (auto-dev-orchestrator) — the gap-scan dimension wheel + LRU rotation.
//
// Locked decision D7: `gap-scan` rotates over a FIXED dimension set. Each tick picks
// the least-recently-run dimension(s) from the run log and maps it to the right
// specialist agent. The chosen dimension is recorded to `routine_run_log` so the next
// tick advances the wheel.
//
// Reqs:
//   R-ADO-17 — fixed dimension wheel; select the least-recently-run dimension(s) per the
//              run log; record the chosen dimension so the next tick advances.
//   R-ADO-18 — each dimension maps to the appropriate specialist agent; the agent used is
//              recorded (carried in the prompt + reconciled to the run log).
//
// SCOPE: this module is PURE — no DB, no network, no clock. It reads prior `gap_dimension`
// values OUT of a run-log slice the caller already fetched (newest-first) and returns the
// next dimension(s). Deterministic + unit-testable.

// ── The fixed dimension wheel (SPEC §1 decision 7 — exactly these 8, in order) ──
export const GAP_DIMENSIONS = Object.freeze([
  'security',
  'performance',
  'accessibility',
  'test-coverage',
  'dependency-hygiene',
  'error-handling',
  'docs-drift',
  'type-safety',
] as const)

export type GapDimension = (typeof GAP_DIMENSIONS)[number]

/** True iff `s` is one of the fixed wheel dimensions. */
export function isGapDimension(s: unknown): s is GapDimension {
  return typeof s === 'string' && (GAP_DIMENSIONS as readonly string[]).includes(s)
}

// ── Dimension → specialist agent (R-ADO-18) ─────────────────────────────────────
/**
 * Each dimension maps to the specialist subagent best suited to find that class of gap.
 * The value is the agent TYPE the bound session agent should dispatch as a Task subagent.
 * Every dimension MUST have an entry (enforced by a test).
 */
export const DIMENSION_AGENTS: Readonly<Record<GapDimension, string>> = Object.freeze({
  security: 'Security Engineer',
  performance: 'Performance Benchmarker',
  accessibility: 'Accessibility Auditor',
  'test-coverage': 'Test Results Analyzer',
  // dead-code / dependency-hygiene = SCA / supply-chain lens → Security Engineer.
  'dependency-hygiene': 'Security Engineer',
  'error-handling': 'Backend Architect',
  'docs-drift': 'Technical Writer',
  'type-safety': 'Backend Architect',
})

/** The specialist agent for a dimension (R-ADO-18). */
export function agentForDimension(dim: GapDimension): string {
  return DIMENSION_AGENTS[dim]
}

// ── LRU rotation (R-ADO-17) ─────────────────────────────────────────────────────
/** Minimal shape this module needs from a run-log entry (newest-first slice). */
export interface GapRunLogLike {
  command?: string | null
  gap_dimension?: string | null
}

/**
 * Pick the next `count` least-recently-used gap dimension(s) from the wheel.
 *
 * `recent` is a run-log slice ordered NEWEST-FIRST (as `recentRunLog` returns). We rank
 * each wheel dimension by HOW RECENTLY it was last used: a dimension whose most-recent
 * appearance is at a smaller index (closer to the front) is MORE recently used; one that
 * never appears is the STALEST (least-recently-used) and is preferred.
 *
 * Selection is deterministic:
 *   - primary key: larger "last-seen index" first (never-seen = +Infinity = most stale),
 *   - tie-break: wheel order (so an empty log returns the wheel head first).
 *
 * `count` is clamped to [1, GAP_DIMENSIONS.length]. The returned dimensions are distinct
 * and cover the wheel before repeating (full-cycle coverage falls out of the ranking).
 */
export function nextGapDimensions(
  recent: ReadonlyArray<GapRunLogLike> = [],
  count = 1,
): GapDimension[] {
  const n = Math.max(1, Math.min(count | 0 || 1, GAP_DIMENSIONS.length))

  // Most-recent index per dimension (index into `recent`, newest-first). Lower = more
  // recent. Absent ⇒ +Infinity (never used ⇒ maximally stale ⇒ picked first).
  const lastSeen = new Map<GapDimension, number>()
  for (let i = 0; i < recent.length; i++) {
    const dim = recent[i]?.gap_dimension
    if (isGapDimension(dim) && !lastSeen.has(dim)) {
      lastSeen.set(dim, i) // first hit walking newest-first = most-recent index
    }
  }

  const ranked = GAP_DIMENSIONS.map((dim, wheelIdx) => ({
    dim,
    wheelIdx,
    lastSeen: lastSeen.has(dim) ? (lastSeen.get(dim) as number) : Number.POSITIVE_INFINITY,
  }))

  ranked.sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return b.lastSeen - a.lastSeen // staler (larger idx) first
    return a.wheelIdx - b.wheelIdx // deterministic tie-break by wheel order
  })

  return ranked.slice(0, n).map((r) => r.dim)
}
