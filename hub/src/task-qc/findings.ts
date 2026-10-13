/**
 * PTYCAP-08 findings DAL. Idempotent per (user, task, detector, evidence
 * signature, day): a re-run of an unchanged condition inserts no second row.
 * Takes a query runner (the `sql` tag or a transaction) so the writer can insert
 * inside its own transaction. INSERT only: no UPDATE, no dispatcher import.
 */
import { createHash } from 'node:crypto'

export const DETECTORS = ['FAILING', 'SKIP_FOREVER', 'NEVER_FIRED', 'MISCONFIGURED', 'DEAD_SESSION', 'OPTIMIZE', 'ENGINE'] as const
export const SEVERITIES = ['info', 'warn', 'high'] as const
export const DISPOSITIONS = ['auto_fixed', 'proposed', 'skipped_in_flight'] as const
export type Detector = (typeof DETECTORS)[number]
export type Severity = (typeof SEVERITIES)[number]
export type Disposition = (typeof DISPOSITIONS)[number]

/** Query runner: the postgres `sql` tag or a transaction handed out by sql.begin. */
export type QueryRunner = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<any[]>

/** JSON with object keys sorted at every depth, so key order never changes a hash. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`
}

export function evidenceSig(detector: string, evidence: unknown): string {
  return createHash('sha256').update(`${detector}\n${stableStringify(evidence)}`).digest('hex')
}

export interface FindingInput {
  userId: string
  taskId: string
  detector: Detector
  severity?: Severity
  disposition: Disposition
  fixKind?: string | null
  before?: unknown
  after?: unknown
  rollbackSql?: string | null
  evidence: unknown
  /** YYYY-MM-DD in the owner's timezone (see userDay) */
  day: string
  /** override the derived signature (claimEngineFailure uses a constant) */
  sig?: string
}

const json = (v: unknown) => (v === undefined || v === null ? null : stableStringify(v))

export async function insertFinding(q: QueryRunner, f: FindingInput): Promise<{ inserted: true; id: string } | { inserted: false }> {
  if (!(DETECTORS as readonly string[]).includes(f.detector)) throw new Error(`task_qc: unknown detector ${String(f.detector)}`)
  if (!(DISPOSITIONS as readonly string[]).includes(f.disposition)) throw new Error(`task_qc: unknown disposition ${String(f.disposition)}`)
  const severity = f.severity ?? 'info'
  if (!(SEVERITIES as readonly string[]).includes(severity)) throw new Error(`task_qc: unknown severity ${String(severity)}`)
  const sig = f.sig ?? evidenceSig(f.detector, f.evidence)
  const rows = await q`
    INSERT INTO task_qc_findings
      (user_id, task_id, detector, severity, disposition, fix_kind, before_json, after_json, rollback_sql, evidence, evidence_sig, day)
    VALUES
      (${f.userId}, ${f.taskId}, ${f.detector}, ${severity}, ${f.disposition}, ${f.fixKind ?? null},
       ${json(f.before)}::jsonb, ${json(f.after)}::jsonb, ${f.rollbackSql ?? null},
       ${json(f.evidence) ?? '{}'}::jsonb, ${sig}, ${f.day})
    ON CONFLICT (user_id, task_id, detector, evidence_sig, day) DO NOTHING RETURNING id`
  const id = rows[0]?.id
  return id != null ? { inserted: true, id: String(id) } : { inserted: false }
}

const ENGINE_FAILURE_SIG = 'engine_failure'

/** One ENGINE row per (user, task, UTC day): true only for the first caller of that day. */
export async function claimEngineFailure(
  q: QueryRunner,
  a: { userId: string; taskId: string; utcDay: string },
): Promise<boolean> {
  const r = await insertFinding(q, {
    userId: a.userId,
    taskId: a.taskId,
    detector: 'ENGINE',
    severity: 'high',
    disposition: 'proposed',
    evidence: { reason: 'engine_failure' },
    day: a.utcDay,
    sig: ENGINE_FAILURE_SIG,
  })
  return r.inserted
}

/** Calendar date (YYYY-MM-DD) in `timezone`; invalid timezone falls back to UTC. */
export function userDay(timezone: string, now: Date = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try {
    return fmt(timezone)
  } catch {
    return fmt('UTC')
  }
}
