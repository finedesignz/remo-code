/**
 * PTYCAP-08 task-quality auditor: shared types. Leaf module, zero imports.
 * Detectors (detectors.ts) are pure over these plain row shapes; the engine
 * (a later plan) loads the rows and supplies the resolved/derived fields.
 */

export type DetectorName =
  | 'FAILING'
  | 'SKIP_FOREVER'
  | 'NEVER_FIRED'
  | 'MISCONFIGURED'
  | 'DEAD_SESSION'
  | 'OPTIMIZE'

export type Severity = 'info' | 'warn' | 'high'
export type Disposition = 'auto_fixed' | 'proposed' | 'skipped_in_flight'

/** The only fixes an engine may ever apply on its own (TQC-04). */
export type SafeFixKind = 'normalize_timezone' | 'backfill_payload_from_sibling' | 'rebind_dead_session'

/**
 * Enumerated proposal kinds: a descriptor for a human or a later layer, never
 * SQL. There is deliberately no enable/disable write kind: propose_disable is a
 * human decision, reregister_job is a PATCH {enabled:true} through the route.
 */
export type ProposalKind =
  | 'propose_disable'
  | 'reregister_job'
  | 'fix_cron'
  | 'fix_timezone'
  | 'fix_payload'
  | 'set_teab_repo'
  | 'rebind_session'
  | 'review_cadence'
  | 'review_prompt_size'
  | 'merge_duplicates'

export type EvidencePrimitive = string | number | boolean | null
export type EvidenceValue = EvidencePrimitive | EvidencePrimitive[]
export type Evidence = Record<string, EvidenceValue>

export interface Proposal {
  kind: ProposalKind
  params: Record<string, EvidencePrimitive>
}

export interface Finding {
  detector: DetectorName
  taskId: string
  taskName: string
  taskType: string
  severity: Severity
  evidence: Evidence
  proposal: Proposal
  fixCandidate?: SafeFixKind
}

export type Timestamp = string | Date | null

export interface AuditTaskInput {
  id: string
  user_id: string
  name: string
  task_type: string
  enabled: boolean
  schedule_kind?: string | null
  cron_expr?: string | null
  cron_expression?: string | null
  timezone: string
  created_at: Timestamp
  last_fire_at?: Timestamp
  next_fire_at?: Timestamp
  target_kind?: string | null
  target_id?: string | null
  session_id?: string | null
  prompt?: string | null
  payload?: Record<string, unknown> | null
  teab_repo_ident?: string | null
  /** log_check/log_pull: the engine's result of the sender's resolver. undefined = not computed. */
  resolvedAppUuid?: string | null
}

export interface RunInput {
  id: string
  task_id: string
  status: string
  error?: string | null
  started_at: Timestamp
  finished_at?: Timestamp
  output_snippet?: string | null
}

export interface SessionInput {
  id: string
  status: string
  deleted_at?: Timestamp
  last_activity?: Timestamp
  created_at?: Timestamp
  /** used by the engine to find live replacement candidates; detectors ignore it */
  repo_key?: string | null
}

export interface DetectorInputs {
  tasks: AuditTaskInput[]
  /** Runs keyed by task id, any order (detectors sort). */
  runsByTask: Record<string, RunInput[]>
  /** Sessions keyed by session id; absent or null = row missing. */
  sessionsById: Record<string, SessionInput | null>
  now: Date
}

export interface DetectorConfig {
  failStreak: number
  /** History window per task (rows). Defaults to 50, the engine's frozen bound. */
  windowSize?: number
}

export interface TaskQcScope {
  taskIds?: string[]
  detectors?: DetectorName[]
}

export type TaskQcOrigin = 'schedule' | 'run_now'

export interface TaskQcResult {
  findings: Finding[]
  applied: Array<{
    finding: Finding
    fix: SafeFixKind
    taskId: string
    before: Record<string, unknown>
    after: Record<string, unknown>
    rollbackSql: string
  }>
  proposals: Finding[]
  truncated: boolean
}

/**
 * Control chars stripped, every non-ASCII char folded to '?', whitespace
 * collapsed, truncated to max. Every free-text value goes through this at
 * construction so nothing downstream ever holds raw text.
 */
export function safeText(value: unknown, max = 120): string {
  if (value == null) return ''
  const s = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\x20-\x7e]/gu, '?')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, max) : s
}
