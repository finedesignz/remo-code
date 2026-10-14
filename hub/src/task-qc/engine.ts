/**
 * PTYCAP-08 task-quality engine. Deterministic: no model, no dispatch, no
 * pipeline, no sender. runTaskQcPass is a pure entry (userId + narrowing scope
 * + injected dependencies): detect with the six detectors over one bounded read
 * layer, plan each fix with the pure planner, apply ONLY planned allowlisted
 * fixes through the safe-fix writer, and record every non-applied finding as a
 * proposal (one `proposed` row per finding, idempotent per day).
 *
 * Report-only by default: unless REMO_TASK_QC_AUTOFIX is on (and ENABLED), every
 * would-be fix is a proposal carrying evidence.would_fix and the pass issues no
 * UPDATE scheduled_tasks. Nothing ever disables a task: FAILING is always a
 * propose_disable proposal. Blast radius is bounded by TASK_QC_BOUNDS (lowerable
 * only): audited tasks, history rows per task, fixes per pass, rows written per
 * run and a wall-clock deadline (F1-A3). The scope can only NARROW (F1-A4).
 */
import { sql } from '../db/postgres.ts'
import { runDetectors } from './detectors.ts'
import { evidenceSig, insertFinding, isDeadlineError, makeDeadlineArmer, userDay, type QueryRunner } from './findings.ts'
import { clampBounds, isTaskQcAutofixEnabled, taskQcFailStreak, type TaskQcBounds } from './flags.ts'
import { loadAuditInputs, loadLiveSessionCandidates, loadSiblingUuids, type ReadDb } from './load.ts'
import { planFix, type PlanContext, type PlanResult } from './fix-plans.ts'
import { applyFix, type TxDb } from './safe-fixes.ts'
import type { AuditTaskInput, DetectorName, Evidence, Finding, TaskQcOrigin, TaskQcResult, TaskQcScope } from './types.ts'

/** Every detector the engine runs. */
export const WIRED_DETECTORS: readonly DetectorName[] = [
  'FAILING',
  'SKIP_FOREVER',
  'NEVER_FIRED',
  'MISCONFIGURED',
  'DEAD_SESSION',
  'OPTIMIZE',
]

/** The database client: the postgres.js tag with both begin overloads. */
export type EngineDb = QueryRunner & { begin: TxDb['begin'] & ReadDb['begin'] }

export interface TaskQcDeps {
  now?: Date
  q?: EngineDb
  /** can only lower a bound (clampBounds) */
  bounds?: Partial<TaskQcBounds>
  /** test override of REMO_TASK_QC_AUTOFIX; the flag is otherwise read at call time */
  autofix?: boolean
  failStreak?: number
  /** consulted immediately before the first write; REQUIRED when auto-fix is on (D-21) */
  haltCheck?: () => Promise<{ halted: boolean }>
  clock?: () => number
  resolveAppUuid?: (task: AuditTaskInput, userId: string) => Promise<string | null>
}

export interface TaskQcPassArgs {
  userId: string
  /** narrowing only: unknown keys are ignored, it can never widen the audit set */
  scope?: TaskQcScope
  origin: TaskQcOrigin
  deps?: TaskQcDeps
}

type Applied = TaskQcResult['applied'][number]

const withParams = (f: Finding, params: Finding['proposal']['params']): Finding => ({
  ...f,
  proposal: { kind: f.proposal.kind, params: { ...f.proposal.params, ...params } },
})

export async function runTaskQcPass(args: TaskQcPassArgs): Promise<TaskQcResult> {
  const deps = args.deps ?? {}
  const { userId } = args
  const autofix = deps.autofix ?? isTaskQcAutofixEnabled()
  // Writing without a kill-switch re-check is a programming error: fail before any read or write.
  if (autofix && typeof deps.haltCheck !== 'function') throw new Error('halt_check_required')

  const q: EngineDb = deps.q ?? (sql as unknown as EngineDb)
  const now = deps.now ?? new Date()
  const clock = deps.clock ?? Date.now
  const bounds = clampBounds(deps.bounds)
  const deadline = clock() + bounds.passTimeoutMs
  // every QC transaction arms the time LEFT as its statement_timeout, so the database cancels a
  // statement blocked past the deadline (F1-A3); a cancellation is treated as the deadline passing
  const arm = makeDeadlineArmer(deadline, clock)
  const inTx = <T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> =>
    q.begin(async (tx: QueryRunner) => {
      await arm(tx)
      return fn(tx)
    })

  // Scope can only narrow: read exactly two keys, ignore everything else.
  const requested = args.scope?.detectors
  const detectors = Array.isArray(requested) ? WIRED_DETECTORS.filter((d) => requested.includes(d)) : [...WIRED_DETECTORS]
  const rawIds = args.scope?.taskIds
  const taskIds = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string') : undefined
  if (detectors.length === 0 || (taskIds && taskIds.length === 0)) {
    return { findings: [], applied: [], proposals: [], truncated: false }
  }
  const scope: TaskQcScope = { taskIds, detectors }

  const loaded = await loadAuditInputs({
    userId,
    scope,
    bounds,
    deadline,
    clock,
    runner: q,
    now,
    lock: autofix,
    resolveAppUuid: deps.resolveAppUuid,
  })
  let truncated = loaded.truncated

  const detected = runDetectors(
    { tasks: loaded.tasks, runsByTask: loaded.runsByTask, sessionsById: loaded.sessionsById, now },
    { failStreak: deps.failStreak ?? taskQcFailStreak() },
    scope,
  )

  // ---- plan (reads only) ---------------------------------------------------
  const tasksById = new Map(loaded.tasks.map((t) => [t.id, t]))
  const steps: Array<{ f: Finding; plan: PlanResult | { kind: 'deadline' } }> = []
  for (const f of detected) {
    if (clock() >= deadline) {
      truncated = true
      steps.push({ f, plan: { kind: 'deadline' } })
      continue
    }
    const task = tasksById.get(f.taskId)!
    const ctx: PlanContext = { autofix, taskTimezone: task.timezone, userTimezone: loaded.userTimezone }
    try {
      if (autofix && f.fixCandidate === 'backfill_payload_from_sibling') {
        ctx.siblingApplicationUuids = await inTx((tx) => loadSiblingUuids(tx, userId, task))
      } else if (autofix && f.fixCandidate === 'rebind_dead_session') {
        const sid = typeof f.evidence.sessionId === 'string' ? f.evidence.sessionId : ''
        const dead = loaded.sessionsById[sid] ?? null
        ctx.deadSessionRepoKey = dead?.repo_key ?? null
        ctx.liveSessionIds = await inTx((tx) => loadLiveSessionCandidates(tx, userId, dead ? { id: sid, repo_key: dead.repo_key } : null))
      }
    } catch (err) {
      if (!isDeadlineError(err)) throw err
      truncated = true
      steps.push({ f, plan: { kind: 'deadline' } })
      continue
    }
    steps.push({ f, plan: planFix(f, ctx) })
  }

  // ---- apply + record (writes) ----------------------------------------------
  const day = userDay(loaded.userTimezone, now)
  const findings: Finding[] = []
  const applied: Applied[] = []
  const proposals: Finding[] = []
  let rowsWritten = 0
  let fixAttempts = 0
  let halted = false
  let haltChecked = false

  /** null = writes allowed; else the reason this finding stays a proposal. */
  const gate = async (): Promise<'halted_read_only' | 'deadline' | null> => {
    if (!haltChecked) {
      haltChecked = true
      if (deps.haltCheck) halted = (await deps.haltCheck()).halted === true
    }
    if (halted) return 'halted_read_only'
    if (clock() >= deadline) {
      truncated = true
      return 'deadline'
    }
    return null
  }
  const unpersisted = (f: Finding, reason: string): void => {
    proposals.push(withParams(f, { reason, persisted: false }))
  }

  /** Persist `f` as one proposed row; a same-day conflict is already reported and not re-listed. */
  const recordProposal = async (f: Finding, reason?: string): Promise<void> => {
    const blocked = await gate()
    if (blocked) return unpersisted(f, blocked)
    if (rowsWritten + 1 > bounds.maxRowsWrittenPerRun) {
      truncated = true
      return unpersisted(f, 'rows_budget_exhausted')
    }
    let res: Awaited<ReturnType<typeof insertFinding>>
    try {
      res = await inTx((tx) =>
        insertFinding(tx, {
          userId,
          taskId: f.taskId,
          detector: f.detector,
          severity: f.severity,
          disposition: 'proposed',
          evidence: f.evidence,
          sig: evidenceSig(f.detector, f.evidence),
          day,
        }),
      )
    } catch (err) {
      if (!isDeadlineError(err)) throw err
      truncated = true
      return unpersisted(f, 'deadline')
    }
    rowsWritten++
    if (res.inserted) proposals.push(reason ? withParams(f, { reason }) : f)
  }

  for (const { f, plan } of steps) {
    if (plan.kind === 'deadline') {
      findings.push(f)
      unpersisted(f, 'deadline')
      continue
    }
    if (plan.kind === 'proposal') {
      const evidence: Evidence =
        plan.reason === 'autofix_off' && f.fixCandidate ? { ...f.evidence, would_fix: f.fixCandidate } : f.evidence
      const pf: Finding = { ...f, evidence, proposal: plan.proposal }
      findings.push(pf)
      await recordProposal(pf)
      continue
    }

    findings.push(f)
    if (fixAttempts >= bounds.maxAutoFixesPerPass) {
      await recordProposal(withParams(f, { would_fix: plan.fix.kind }), 'fix_cap_reached')
      continue
    }
    const blocked = await gate()
    if (blocked) {
      unpersisted(f, blocked)
      continue
    }
    if (rowsWritten + 2 > bounds.maxRowsWrittenPerRun) {
      truncated = true
      unpersisted(f, 'rows_budget_exhausted')
      continue
    }
    fixAttempts++
    let res: Awaited<ReturnType<typeof applyFix>>
    try {
      res = await applyFix(q, plan.fix, { userId, taskId: f.taskId, day, finding: f, armTimeout: arm })
    } catch (err) {
      // the fix transaction rolled back whole: nothing was written for this finding
      if (!isDeadlineError(err)) throw err
      truncated = true
      unpersisted(f, 'deadline')
      continue
    }
    rowsWritten += res.rowsWritten
    if (res.status === 'applied') {
      applied.push({ finding: f, fix: res.fixKind, taskId: f.taskId, before: res.before, after: res.after, rollbackSql: res.rollbackSql })
    } else if (res.status === 'skipped_in_flight') {
      // the writer already persisted the skipped_in_flight row
      proposals.push(withParams(f, { reason: 'in_flight' }))
    } else {
      await recordProposal(f, 'changed')
    }
  }

  return { findings, applied, proposals, truncated }
}
