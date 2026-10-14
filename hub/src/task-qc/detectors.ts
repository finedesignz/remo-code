/**
 * PTYCAP-08 task-quality detectors: six PURE functions over plain row objects.
 *
 * Purity contract: no database, dispatcher, sender or model import; no Date
 * clock and no environment reads. Callers pass `now` and a config. The only
 * non-builtin dependency is scheduler/cron (pure croner helpers).
 *
 * Column mapping (08-CONTEXT D-07): next fire = next_fire_at, last = last_fire_at,
 * run finish = finished_at, run outcome reason = scheduled_task_runs.error.
 * No detector reads cost: scheduled_task_runs.cost_usd is only populated for
 * runs that accrued model usage, so it cannot rank or attribute anything.
 *
 * FAILING is always a proposal (TQC-04): no output of this module carries a
 * disable or enable fix. fixCandidate is limited to the three SafeFixKind values.
 */
import type {
  AuditTaskInput,
  DetectorConfig,
  DetectorInputs,
  DetectorName,
  EvidencePrimitive,
  Finding,
  RunInput,
  Severity,
  TaskQcScope,
  Timestamp,
} from './types.ts'
import { safeText } from './types.ts'

const DEFAULT_WINDOW = 50
const TERMINAL = new Set(['success', 'failed', 'skipped', 'skipped_quota', 'cancelled'])
/** cancelled is terminal but ignored by every streak rule. */
const COUNTED = new Set(['success', 'failed', 'skipped', 'skipped_quota'])
const INTERNAL_PREFIX = '__internal_'

/** Benign skip reasons (D-09). A task skipping on these forever is working by design. */
const BENIGN_EXACT = new Set([
  'no_errors_detected',
  'orchestrator_due_tick_owned',
  'orchestrator_disabled',
  'replayed_on_reconnect',
])
const BENIGN_PREFIX = ['automation_halted:', 'lifetime_inject_exhausted:']

export function isBenignSkipReason(reason: string | null | undefined): boolean {
  if (reason == null) return false
  const r = reason.trim()
  return BENIGN_EXACT.has(r) || BENIGN_PREFIX.some((p) => r.startsWith(p))
}

/**
 * Reason signature: digit runs collapse to '#' so a skipped_quota reason that
 * embeds a changing utilization figure still groups (auto-default refinement;
 * without it the spec'd skipped_quota arm of SKIP_FOREVER would be unreachable).
 */
export function reasonSignature(error: string | null | undefined): string {
  return safeText(error ?? '').replace(/\d+/g, '#')
}

function toMs(v: Timestamp | undefined): number | null {
  if (v == null) return null
  const ms = v instanceof Date ? v.getTime() : Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString()
}

/** Newest first by started_at, stable tie-break on id. Rows without a stamp sort last. */
function newestFirst(runs: RunInput[]): RunInput[] {
  return [...runs].sort((a, b) => {
    const d = (toMs(b.started_at) ?? -Infinity) - (toMs(a.started_at) ?? -Infinity)
    if (d !== 0 && !Number.isNaN(d)) return d
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** Newest window of runs that are terminal AND counted (cancelled/non-terminal dropped). */
function countedWindow(runs: RunInput[], config: DetectorConfig): RunInput[] {
  const window = newestFirst(runs).slice(0, config.windowSize ?? DEFAULT_WINDOW)
  return window.filter((r) => COUNTED.has(r.status))
}

function base(task: AuditTaskInput, detector: DetectorName, severity: Severity) {
  return {
    detector,
    taskId: task.id,
    taskName: safeText(task.name),
    taskType: safeText(task.task_type, 40),
    severity,
  }
}

/** The audit set (D-03, F2-B7): internal anchors and the auditor's own row are never flagged. */
export function isAuditable(task: AuditTaskInput): boolean {
  if (!task.enabled) return false
  if (task.task_type === 'task_qc' || task.task_type === 'orchestrator') return false
  if (typeof task.name === 'string' && task.name.startsWith(INTERNAL_PREFIX)) return false
  if (task.schedule_kind != null && task.schedule_kind !== 'cron') return false
  return true
}

function tallySignatures(runs: RunInput[]): { sigs: string[]; counts: number[] } {
  const m = new Map<string, number>()
  for (const r of runs) {
    const s = safeText(r.error ?? '')
    m.set(s, (m.get(s) ?? 0) + 1)
  }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5)
  return { sigs: top.map((e) => e[0]), counts: top.map((e) => e[1]) }
}

/** FAILING: the newest N counted runs are all failed. Always a proposal (TQC-04). */
export function detectFailing(task: AuditTaskInput, runs: RunInput[], config: DetectorConfig): Finding | null {
  const n = config.failStreak
  const window = countedWindow(runs, config)
  if (n < 1 || window.length < n) return null
  if (!window.slice(0, n).every((r) => r.status === 'failed')) return null
  let streak = 0
  while (streak < window.length && window[streak]!.status === 'failed') streak++
  const streakRuns = window.slice(0, streak)
  const windowSize = config.windowSize ?? DEFAULT_WINDOW
  const fullWindow = runs.length >= windowSize && streak >= windowSize
  const severity: Severity = streak >= 10 * n || fullWindow ? 'high' : 'warn'
  const { sigs, counts } = tallySignatures(streakRuns)
  return {
    ...base(task, 'FAILING', severity),
    evidence: {
      streak,
      runIds: streakRuns.slice(0, 5).map((r) => safeText(r.id, 64)),
      errorSignatures: sigs,
      errorCounts: counts,
      firstStartedAt: iso(toMs(streakRuns[streakRuns.length - 1]!.started_at)),
      lastStartedAt: iso(toMs(streakRuns[0]!.started_at)),
    },
    proposal: { kind: 'propose_disable', params: { taskId: task.id } },
  }
}

/** SKIP_FOREVER: the newest N counted runs are all skipped with one non-benign reason signature. */
export function detectSkipForever(task: AuditTaskInput, runs: RunInput[], config: DetectorConfig): Finding | null {
  const n = config.failStreak
  const window = countedWindow(runs, config)
  if (n < 1 || window.length < n) return null
  const head = window.slice(0, n)
  if (!head.every((r) => r.status === 'skipped' || r.status === 'skipped_quota')) return null
  const sig = reasonSignature(head[0]!.error)
  if (!head.every((r) => reasonSignature(r.error) === sig)) return null
  if (head.some((r) => isBenignSkipReason(r.error))) return null
  let skipRuns = 0
  while (
    skipRuns < window.length &&
    (window[skipRuns]!.status === 'skipped' || window[skipRuns]!.status === 'skipped_quota') &&
    reasonSignature(window[skipRuns]!.error) === sig
  ) {
    skipRuns++
  }
  const evidence: Record<string, EvidencePrimitive | EvidencePrimitive[]> = {
    skipRuns,
    reason: safeText(head[0]!.error ?? ''),
    reasonSignature: sig,
    runIds: head.slice(0, 5).map((r) => safeText(r.id, 64)),
  }
  return {
    ...base(task, 'SKIP_FOREVER', 'warn'),
    evidence,
    proposal: { kind: 'propose_disable', params: { taskId: task.id } },
  }
}

export type { DetectorInputs, TaskQcScope }
