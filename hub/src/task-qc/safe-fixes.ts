/**
 * PTYCAP-08 safe-fix writer (TQC-03, TQC-04, TQC-06). The ONLY module in the
 * task-qc tree that mutates scheduled_tasks, and only through the three fixed
 * UPDATE templates below. Each template writes an INPUT column the dispatcher
 * reads at fire time (timezone, payload, session_id/target_id), never a derived
 * mirror: recompute_next_run_at is deliberately not a fix kind (next_fire_at
 * mirrors the live registry, so a database-only rewrite would mask an unarmed
 * job). No template names the on/off switch column; a static guard test fails CI
 * if one ever does.
 *
 * Dependencies: findings.ts, detectors.ts (isAuditable), scheduler/cron.ts and
 * types only. No registry, dispatcher, dispatch pipeline or sender import: the
 * open-run check reads the database, never the in-memory in-flight map.
 */
import { isValidTimezone } from '../scheduler/cron.ts'
import { isAuditable } from './detectors.ts'
import { randomUUID } from 'node:crypto'
import { evidenceSig, insertFinding, type QueryRunner } from './findings.ts'
import type { AuditTaskInput, Finding, Proposal, SafeFixKind } from './types.ts'

// ---------------------------------------------------------------------------
// Frozen allowlist (D-15). A plain frozen Set still accepts add() and
// Set.prototype.add.call(), so this is a read-only structure over a closure-held
// frozen array: the mutators throw and there is no internal slot to reach.
// ---------------------------------------------------------------------------
const KINDS: readonly SafeFixKind[] = Object.freeze(['normalize_timezone', 'backfill_payload_from_sibling', 'rebind_dead_session'] as const)

function immutable(): never {
  throw new Error('safe_fixes_immutable')
}

export const SAFE_FIXES: ReadonlySet<SafeFixKind> = Object.freeze({
  has: (k: unknown) => typeof k === 'string' && (KINDS as readonly string[]).includes(k),
  get size() {
    return KINDS.length
  },
  add: immutable,
  delete: immutable,
  clear: immutable,
  values: () => KINDS[Symbol.iterator](),
  keys: () => KINDS[Symbol.iterator](),
  entries: () => KINDS.map((k) => [k, k] as [SafeFixKind, SafeFixKind])[Symbol.iterator](),
  forEach: (cb: (v: SafeFixKind, k: SafeFixKind, s: unknown) => void) => KINDS.forEach((k) => cb(k, k, SAFE_FIXES)),
  [Symbol.iterator]: () => KINDS[Symbol.iterator](),
}) as unknown as ReadonlySet<SafeFixKind>

export class UnlistedFixKindError extends Error {
  readonly code = 'unlisted_fix_kind'
  constructor(kind: unknown) {
    super(`task_qc: unlisted_fix_kind ${typeof kind === 'string' ? JSON.stringify(kind) : typeof kind}`)
    this.name = 'UnlistedFixKindError'
  }
}

// ---------------------------------------------------------------------------
// Fix arguments and results
// ---------------------------------------------------------------------------
export type SafeFix =
  | { kind: 'normalize_timezone'; timezone: string }
  | { kind: 'backfill_payload_from_sibling'; applicationUuid: string }
  | { kind: 'rebind_dead_session'; oldSessionId: string; newSessionId: string }

export interface ApplyContext {
  userId: string
  taskId: string
  /** YYYY-MM-DD in the owner's timezone (findings.userDay) */
  day: string
  finding: Finding
}

/** The database client: a query runner that can open a transaction. */
export type TxDb = QueryRunner & { begin<T>(fn: (tx: QueryRunner) => Promise<T>): Promise<T> }

export type ApplyResult =
  | {
      status: 'applied'
      fixKind: SafeFixKind
      rowsWritten: 2
      before: Record<string, unknown>
      after: Record<string, unknown>
      rollbackSql: string
    }
  | {
      status: 'skipped_in_flight'
      fixKind: SafeFixKind
      rowsWritten: 1
      proposal: { reason: 'in_flight'; kind: Proposal['kind']; params: Proposal['params'] }
    }
  | { status: 'refused_not_auditable'; fixKind: SafeFixKind; rowsWritten: 0 }
  | { status: 'noop_changed'; fixKind: SafeFixKind; rowsWritten: 0 }

// ---------------------------------------------------------------------------
// sqlLiteral: the one literal quoter for rollback text (T-08-20). Standard
// conforming strings are assumed (the postgres default), so backslashes pass
// through unchanged and only the single quote is doubled.
// ---------------------------------------------------------------------------
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('sqlLiteral: non-finite number')
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') {
    if (v.includes('\u0000')) throw new Error('sqlLiteral: NUL byte in string')
    return `'${v.replace(/'/g, "''")}'`
  }
  if (typeof v === 'object') {
    const text = JSON.stringify(v)
    // JSON.stringify escapes a NUL as backslash-u0000, which postgres jsonb rejects.
    if (text.includes('\\u0000')) throw new Error('sqlLiteral: NUL byte in json')
    return `'${text.replace(/'/g, "''")}'::jsonb`
  }
  throw new Error(`sqlLiteral: unsupported ${typeof v}`)
}

/**
 * Guarded rollback text for one applied fix: fixed template per kind, column
 * names never taken from data, every value through sqlLiteral, and a WHERE that
 * no-ops if the row changed since the fix. Stored for a human; never executed.
 */
export function buildRollbackSql(
  kind: SafeFixKind,
  taskId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const id = sqlLiteral(taskId)
  switch (kind) {
    case 'normalize_timezone':
      return `UPDATE scheduled_tasks SET timezone = ${sqlLiteral(before.timezone)} WHERE id = ${id} AND timezone IS NOT DISTINCT FROM ${sqlLiteral(after.timezone)}`
    case 'backfill_payload_from_sibling': {
      const guard = `payload->>'application_uuid' IS NOT DISTINCT FROM ${sqlLiteral(after.application_uuid)}`
      return before.application_uuid == null
        ? `UPDATE scheduled_tasks SET payload = payload - 'application_uuid' WHERE id = ${id} AND ${guard}`
        : `UPDATE scheduled_tasks SET payload = payload || jsonb_build_object('application_uuid', ${sqlLiteral(before.application_uuid)}::text) WHERE id = ${id} AND ${guard}`
    }
    case 'rebind_dead_session':
      return `UPDATE scheduled_tasks SET session_id = ${sqlLiteral(before.session_id)}, target_id = ${sqlLiteral(before.target_id)} WHERE id = ${id} AND session_id IS NOT DISTINCT FROM ${sqlLiteral(after.session_id)} AND target_id IS NOT DISTINCT FROM ${sqlLiteral(after.target_id)}`
    default:
      throw new UnlistedFixKindError(kind)
  }
}

// ---------------------------------------------------------------------------
// The only data-modifying SQL in the QC module: three fixed UPDATE templates
// with fixed column lists. Every value is a bound parameter.
// ---------------------------------------------------------------------------
const updateTimezone = (q: QueryRunner, id: string, userId: string, timezone: string) => q`
  UPDATE scheduled_tasks SET timezone = ${timezone}, updated_at = now()
  WHERE id = ${id} AND user_id = ${userId}
  RETURNING timezone`

const updatePayload = (q: QueryRunner, id: string, userId: string, uuid: string) => q`
  UPDATE scheduled_tasks SET payload = payload || jsonb_build_object('application_uuid', ${uuid}::text), updated_at = now()
  WHERE id = ${id} AND user_id = ${userId}
  RETURNING payload`

const updateSession = (q: QueryRunner, id: string, userId: string, oldId: string, newId: string) => q`
  UPDATE scheduled_tasks SET
    session_id = CASE WHEN session_id = ${oldId} THEN ${newId} ELSE session_id END,
    target_id = CASE WHEN target_id = ${oldId} THEN ${newId} ELSE target_id END,
    updated_at = now()
  WHERE id = ${id} AND user_id = ${userId}
  RETURNING session_id, target_id`

/**
 * Apply one allowlisted fix in ONE transaction. The kind check is the first
 * statement and runs before the runner is touched.
 */
export async function applyFix(db: TxDb, fix: SafeFix, ctx: ApplyContext): Promise<ApplyResult> {
  const kind = (fix as { kind?: unknown } | null | undefined)?.kind
  if (typeof kind !== 'string' || !SAFE_FIXES.has(kind as SafeFixKind)) throw new UnlistedFixKindError(kind)
  return applyListedFix(db, fix, ctx)
}

async function applyListedFix(db: TxDb, fix: SafeFix, ctx: ApplyContext): Promise<ApplyResult> {
  const kind = fix.kind
  assertFixArguments(fix)
  return db.begin(async (tx) => {
    // 1. row lock, scoped by id AND owner; serialises every writer for this task
    const rows = await tx`
      SELECT id, user_id, name, task_type, enabled, schedule_kind, timezone, payload, session_id, target_kind, target_id
      FROM scheduled_tasks WHERE id = ${ctx.taskId} AND user_id = ${ctx.userId} FOR UPDATE`
    const row = rows[0]
    // 2. write-time audit-set re-check (F2-B7): never trust the finding
    if (!row || !isAuditable(row as AuditTaskInput)) return { status: 'refused_not_auditable', fixKind: kind, rowsWritten: 0 }
    // 3. precondition re-check against the locked row
    if (!preconditionHolds(fix, row)) return { status: 'noop_changed', fixKind: kind, rowsWritten: 0 }
    // 4. in-flight refusal (D-16): database truth only
    const sid: string | null = row.target_id ?? row.session_id ?? null
    const own = await tx`
      SELECT 1 AS open FROM scheduled_task_runs
      WHERE task_id = ${ctx.taskId} AND status IN ('running','pending','in_flight') AND finished_at IS NULL AND completed_at IS NULL
      LIMIT 1`
    const shared =
      own.length === 0 && sid != null
        ? await tx`
          SELECT 1 AS open FROM scheduled_task_runs
          WHERE session_id = ${sid} AND status IN ('running','pending','in_flight') AND finished_at IS NULL AND completed_at IS NULL
          LIMIT 1`
        : []
    if (own.length > 0 || shared.length > 0) {
      const scope = own.length > 0 ? 'own_run' : 'shared_session'
      const evidence = { ...ctx.finding.evidence, in_flight: scope }
      await insertFinding(tx, {
        userId: ctx.userId,
        taskId: ctx.taskId,
        detector: ctx.finding.detector,
        severity: ctx.finding.severity,
        disposition: 'skipped_in_flight',
        fixKind: kind,
        evidence,
        day: ctx.day,
        sig: evidenceSig(ctx.finding.detector, { evidence, disposition: 'skipped_in_flight', fix: kind }),
      })
      return {
        status: 'skipped_in_flight',
        fixKind: kind,
        rowsWritten: 1,
        proposal: { reason: 'in_flight', kind: ctx.finding.proposal.kind, params: { ...ctx.finding.proposal.params } },
      }
    }
    // 5. the single fixed UPDATE, then 6. the audit row in the same transaction
    let before: Record<string, unknown>
    let after: Record<string, unknown>
    let ret: any
    if (fix.kind === 'normalize_timezone') {
      ret = (await updateTimezone(tx, ctx.taskId, ctx.userId, fix.timezone))[0]
      before = { timezone: row.timezone }
      after = { timezone: ret?.timezone }
    } else if (fix.kind === 'backfill_payload_from_sibling') {
      ret = (await updatePayload(tx, ctx.taskId, ctx.userId, fix.applicationUuid))[0]
      const prev = row.payload?.application_uuid
      before = { application_uuid: prev == null ? null : prev }
      after = { application_uuid: ret?.payload?.application_uuid }
    } else {
      ret = (await updateSession(tx, ctx.taskId, ctx.userId, fix.oldSessionId, fix.newSessionId))[0]
      before = { session_id: row.session_id ?? null, target_id: row.target_id ?? null }
      after = { session_id: ret?.session_id ?? null, target_id: ret?.target_id ?? null }
    }
    if (!ret) throw new Error('task_qc: fix UPDATE matched no row')
    const rollbackSql = buildRollbackSql(kind, ctx.taskId, before, after)
    const audit = await insertFinding(tx, {
      userId: ctx.userId,
      taskId: ctx.taskId,
      detector: ctx.finding.detector,
      severity: ctx.finding.severity,
      disposition: 'auto_fixed',
      fixKind: kind,
      before,
      after,
      rollbackSql,
      evidence: ctx.finding.evidence,
      day: ctx.day,
      // one audit row per applied write: never swallowed by an earlier same-day row
      sig: evidenceSig('FIX', { kind, before, after, nonce: randomUUID() }),
    })
    if (!audit.inserted) throw new Error('task_qc: audit row not inserted; fix rolled back')
    return { status: 'applied', fixKind: kind, rowsWritten: 2, before, after, rollbackSql }
  })
}

/** Argument shape checks that need no database; run before the transaction opens. */
function assertFixArguments(fix: SafeFix): void {
  const bad = (m: string) => new Error(`task_qc: invalid fix arguments (${m})`)
  const str = (v: unknown) => typeof v === 'string' && v.length > 0
  if (fix.kind === 'normalize_timezone') {
    if (!str(fix.timezone) || !isValidTimezone(fix.timezone)) throw bad('timezone')
  } else if (fix.kind === 'backfill_payload_from_sibling') {
    if (!str(fix.applicationUuid)) throw bad('applicationUuid')
  } else if (!str(fix.oldSessionId) || !str(fix.newSessionId) || fix.oldSessionId === fix.newSessionId) {
    throw bad('session ids')
  }
}

function preconditionHolds(fix: SafeFix, row: any): boolean {
  if (fix.kind === 'normalize_timezone') return typeof row.timezone !== 'string' || !isValidTimezone(row.timezone)
  if (fix.kind === 'backfill_payload_from_sibling') {
    if (row.task_type !== 'log_check' && row.task_type !== 'log_pull') return false
    const cur = row.payload && typeof row.payload === 'object' ? row.payload.application_uuid : undefined
    return !(typeof cur === 'string' && cur.trim() !== '')
  }
  return row.session_id === fix.oldSessionId || row.target_id === fix.oldSessionId
}
