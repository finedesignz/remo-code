// hub/src/orchestrator/waves.ts
// Phase 24 (auto-dev-orchestrator) — PURE dependency-aware wave PLANNER.
// Locked decision D2: DUE commands are grouped into dependency waves. Independent
// commands (audit-fix, gap-scan, code-review) collapse into the earliest wave and
// run as parallel units; dependent commands (plan→execute→ship) sequence across
// waves within the same tick. Intra-wave order uses the priority notion
// (deploy-fix > build) carried from the Phase-22 queue.
//
// Reqs:
//   R-ADO-11 — dependency-aware wave grouping (independent parallel; dependent sequenced).
//   R-ADO-13 — units never merge to main here (merge-to-main is the off-hours Phase-29
//              command and is EXCLUDED from the planner entirely).
//
// This module is DETERMINISTIC and DB-free: same input command set → same plan.
// It does NOT execute anything (that is wave-runner.ts) and does NOT inject any
// prompt (that is the Phase-25 seam). It only computes the topological wave layout.

import { CyclePriority } from './queue.ts';

// ── Static dependency map among gsd commands (D2) ────────────────────────────
/**
 * `COMMAND_DEPS[c]` = the commands that MUST complete in an earlier wave before
 * `c` may run. Anything not listed (or listed with `[]`) is independent and
 * collapses into the earliest wave.
 *
 * Chain: plan → execute → ship. Independent: audit-fix, gap-scan, code-review.
 * EXCLUDED: merge-to-main (Phase-29 off-hours; never planned here).
 */
export const COMMAND_DEPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  plan: [],
  execute: ['plan'],
  ship: ['execute'],
  // independents (explicit for clarity; absence would behave identically)
  'audit-fix': [],
  'gap-scan': [],
  'code-review': [],
  'complete-milestone': ['execute'],
  tag: ['execute'],
});

/** Commands that the off-hours Phase-29 path owns — EXCLUDED from this planner. */
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set(['merge-to-main']);

/**
 * High-tier commands that PROPOSE-to-chat instead of executing (D5 / Phase 28).
 * They still participate in the wave topology (e.g. `ship` depends on `execute`)
 * so ordering is faithful, but the runner routes them to `proposeToChat`.
 */
export const PROPOSE_COMMANDS: ReadonlySet<string> = new Set([
  'ship',
  'complete-milestone',
  'tag',
]);

// ── Caps (sane bounds; mirror queue's parsePositiveInt discipline) ───────────
export const MAX_WAVES = 16;
export const MAX_UNITS_PER_WAVE = 32;

// ── Priority (deploy-fix > build) for intra-wave ordering (D2) ───────────────
/**
 * Intra-wave ordering priority. `deploy-fix`-class work outranks ordinary build
 * work when several units share a wave — same notion the Phase-22 queue uses for
 * cross-cycle contention (CyclePriority.DEPLOY_FIX > BUILD). Higher drains first.
 */
export function commandPriority(command: string): number {
  if (command === 'deploy-fix') return CyclePriority.DEPLOY_FIX;
  return CyclePriority.BUILD;
}

// ── Plan types ───────────────────────────────────────────────────────────────
export interface WaveUnit {
  command: string;
  /** True ⇒ propose-to-chat (do not execute); see PROPOSE_COMMANDS. */
  propose: boolean;
  /** Intra-wave ordering priority (higher first). */
  priority: number;
}

export interface WavePlan {
  /** Ordered waves; each inner array is a set of units safe to run in parallel. */
  waves: WaveUnit[][];
  /** Commands dropped (excluded/off-hours or unknown-with-missing-deps). */
  dropped: string[];
}

// ── Planner ──────────────────────────────────────────────────────────────────
/**
 * Group `commands` into dependency-ordered waves.
 *
 * Algorithm (deterministic topological levelization, Kahn-style by depth):
 *   1. De-dupe + drop EXCLUDED commands (merge-to-main → off-hours).
 *   2. Each command's WAVE INDEX = 1 + max(wave index of its in-set deps), or 0
 *      if it has no deps that are also present this tick. A dep NOT present this
 *      tick imposes no ordering (we only sequence relative to commands that are
 *      actually due — a `ship` due without `execute` due runs in wave 0).
 *   3. Independent commands → wave 0 (collapse). Dependents follow their depth.
 *   4. Intra-wave: sort by priority DESC, then stable original-input order.
 *   5. Cap waves at MAX_WAVES and units/wave at MAX_UNITS_PER_WAVE (defensive).
 *
 * PURE: no DB, no clock, no side effects.
 */
export function planWaves(commands: string[]): WavePlan {
  const dropped: string[] = [];

  // 1. De-dupe (preserve first-seen order) + drop excluded.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of commands) {
    const cmd = (c ?? '').trim();
    if (!cmd) continue;
    if (EXCLUDED_COMMANDS.has(cmd)) {
      dropped.push(cmd);
      continue;
    }
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    ordered.push(cmd);
  }

  const present = new Set(ordered);
  const inputIndex = new Map(ordered.map((c, i) => [c, i] as const));

  // 2. Memoized wave-index computation over PRESENT deps only. Cycle-safe via a
  //    visiting set (a back-edge contributes no depth — fail-open to wave 0).
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();

  function waveIndexOf(cmd: string): number {
    const cached = depthCache.get(cmd);
    if (cached !== undefined) return cached;
    if (visiting.has(cmd)) return 0; // cycle guard
    visiting.add(cmd);

    const deps = COMMAND_DEPS[cmd] ?? [];
    let idx = 0;
    for (const d of deps) {
      if (!present.has(d)) continue; // dep not due this tick → no ordering
      idx = Math.max(idx, waveIndexOf(d) + 1);
    }
    visiting.delete(cmd);
    depthCache.set(cmd, idx);
    return idx;
  }

  // 3. Bucket by wave index.
  const buckets = new Map<number, WaveUnit[]>();
  for (const cmd of ordered) {
    const idx = Math.min(waveIndexOf(cmd), MAX_WAVES - 1);
    const unit: WaveUnit = {
      command: cmd,
      propose: PROPOSE_COMMANDS.has(cmd),
      priority: commandPriority(cmd),
    };
    const bucket = buckets.get(idx) ?? [];
    bucket.push(unit);
    buckets.set(idx, bucket);
  }

  // 4 + 5. Emit contiguous waves in index order; sort each + cap.
  const waves: WaveUnit[][] = [];
  const indices = [...buckets.keys()].sort((a, b) => a - b);
  for (const i of indices) {
    const units = buckets.get(i)!;
    units.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority; // priority DESC
      return (inputIndex.get(a.command) ?? 0) - (inputIndex.get(b.command) ?? 0); // stable
    });
    waves.push(units.slice(0, MAX_UNITS_PER_WAVE));
  }

  return { waves, dropped };
}
