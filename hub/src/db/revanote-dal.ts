/**
 * Revanote integration DAL (Phase 08).
 *
 * Mirrors the shape of `error-capture-dal.ts` and the
 * `*CoolifyWebhookSecret` helpers in `dal.ts`. All inserts/queries are
 * user-scoped via explicit WHERE user_id (no global RLS substitute).
 */
import { sql } from './postgres.ts'

// ── Types ────────────────────────────────────────────────────────────────────

export type AnnotationStatus =
  | 'pending'
  | 'dispatched'
  | 'resolved'
  | 'failed'
  | 'failed_offline'

export type AnnotationRunStatus = 'in_flight' | 'success' | 'failed' | 'cancelled'

export type DeployStrategy = 'pr' | 'direct' | 'none'

export interface RevanoteMapping {
  id: string
  user_id: string
  hostname_pattern: string
  repo_path: string
  supervisor_id: string | null
  deploy_strategy: DeployStrategy
  auto_merge: boolean
  /**
   * Operator trust flag (default false). Only a TRUSTED mapping may act on
   * `deploy_strategy='direct'` / `auto_merge=true`; an untrusted mapping is forced
   * propose-only (PR) in `renderAnnotationPrompt`, whatever the payload says.
   */
  trusted: boolean
  enabled: boolean
  auto_created: boolean
  created_at: string
  updated_at: string
}

export interface AnnotationRow {
  id: string
  user_id: string
  annotation_id_external: string
  page_url: string
  annotation_url: string | null
  screenshot_url: string | null
  x: number | null
  y: number | null
  element_selector: string | null
  comment: string
  replies_json: unknown
  callback_url: string
  mapping_id: string | null
  session_id: string | null
  status: AnnotationStatus
  skip_reason: string | null
  source_ip: string | null
  payload_raw: any
  received_at: string
  dispatched_at: string | null
  resolved_at: string | null
}

export interface AnnotationRunRow {
  id: string
  annotation_id: string
  user_id: string
  session_id: string | null
  status: AnnotationRunStatus
  resolved: boolean | null
  action_taken: string | null
  agent_reply: string | null
  files_changed: unknown
  deployed: boolean
  error: string | null
  cost_usd: string | null
  duration_ms: number | null
  output_snippet: string | null
  started_at: string
  finished_at: string | null
}

export interface CallbackAttemptRow {
  id: string
  annotation_id: string
  attempt_no: number
  http_status: number | null
  error: string | null
  attempted_at: string | null
  next_retry_at: string | null
  delivered: boolean
  dead: boolean
  payload_json: any
  created_at: string
}

// ── Secret + status (mirrors coolify-webhook helpers) ───────────────────────

export async function getUserRevanoteWebhookSecret(userId: string): Promise<string | null> {
  const rows = await sql<{ revanote_webhook_secret: string | null }[]>`
    SELECT revanote_webhook_secret FROM users WHERE id = ${userId}
  `
  return rows[0]?.revanote_webhook_secret ?? null
}

export async function rotateUserRevanoteWebhookSecret(userId: string): Promise<string> {
  const rows = await sql<{ revanote_webhook_secret: string }[]>`
    UPDATE users
       SET revanote_webhook_secret = gen_random_uuid()::text,
           updated_at = now()
     WHERE id = ${userId}
    RETURNING revanote_webhook_secret
  `
  const secret = rows[0]?.revanote_webhook_secret
  if (!secret) throw new Error('rotate_failed: user not found')
  return secret
}

export async function getUserRevanoteWebhookStatus(
  userId: string,
): Promise<{ configured: boolean; budget_pct: number }> {
  const rows = await sql<{ configured: boolean; pct: number | null }[]>`
    SELECT (revanote_webhook_secret IS NOT NULL) AS configured,
           revanote_budget_pct AS pct
      FROM users
     WHERE id = ${userId}
  `
  return {
    configured: !!rows[0]?.configured,
    budget_pct: rows[0]?.pct ?? 60,
  }
}

export async function setUserRevanoteBudgetPct(
  userId: string,
  pct: number | null,
): Promise<number> {
  await sql`
    UPDATE users
       SET revanote_budget_pct = ${pct},
           updated_at = now()
     WHERE id = ${userId}
  `
  return pct ?? 60
}

// ── Webhook attempt audit log (capped 100/user) ──────────────────────────────

export interface RevanoteAttemptStatus {
  status:
    | 'success'
    | 'auth_failed'
    | 'hmac_failed'
    | 'ip_rejected'
    | 'bad_payload'
    | 'rate_limited'
    | 'duplicate'
}

export async function recordRevanoteWebhookAttempt(opts: {
  user_id: string
  source_ip: string | null
  event_type: string | null
  status: RevanoteAttemptStatus['status']
  reason: string | null
  raw_body_preview: string | null
}): Promise<void> {
  await sql`
    INSERT INTO revanote_webhook_attempts
      (user_id, source_ip, event_type, status, reason, raw_body_preview)
    VALUES
      (${opts.user_id}, ${opts.source_ip}, ${opts.event_type}, ${opts.status},
       ${opts.reason}, ${opts.raw_body_preview})
  `
  // Trim oldest beyond 100.
  await sql`
    DELETE FROM revanote_webhook_attempts
     WHERE user_id = ${opts.user_id}
       AND id NOT IN (
         SELECT id FROM revanote_webhook_attempts
          WHERE user_id = ${opts.user_id}
          ORDER BY received_at DESC
          LIMIT 100
       )
  `
}

export async function listRevanoteWebhookAttempts(
  userId: string,
  limit: number,
): Promise<Array<{
  id: string
  received_at: string
  source_ip: string | null
  event_type: string | null
  status: string
  reason: string | null
  raw_body_preview: string | null
}>> {
  const rows = await sql<any[]>`
    SELECT id, received_at, source_ip, event_type, status, reason, raw_body_preview
      FROM revanote_webhook_attempts
     WHERE user_id = ${userId}
     ORDER BY received_at DESC
     LIMIT ${limit}
  `
  return rows
}

// ── Mappings CRUD + resolver ────────────────────────────────────────────────

export async function listRevanoteMappings(userId: string): Promise<RevanoteMapping[]> {
  const rows = await sql<RevanoteMapping[]>`
    SELECT * FROM revanote_app_mappings
     WHERE user_id = ${userId}
     ORDER BY updated_at DESC
  `
  return rows
}

export async function createRevanoteMapping(opts: {
  user_id: string
  hostname_pattern: string
  repo_path: string
  supervisor_id?: string | null
  deploy_strategy?: DeployStrategy
  auto_merge?: boolean
  enabled?: boolean
  auto_created?: boolean
}): Promise<RevanoteMapping> {
  const rows = await sql<RevanoteMapping[]>`
    INSERT INTO revanote_app_mappings
      (user_id, hostname_pattern, repo_path, supervisor_id, deploy_strategy,
       auto_merge, enabled, auto_created)
    VALUES
      (${opts.user_id}, ${opts.hostname_pattern}, ${opts.repo_path},
       ${opts.supervisor_id ?? null}, ${opts.deploy_strategy ?? 'pr'},
       ${opts.auto_merge ?? false}, ${opts.enabled ?? true},
       ${opts.auto_created ?? false})
    RETURNING *
  `
  return rows[0]
}

export async function updateRevanoteMapping(
  id: string,
  userId: string,
  patch: Partial<{
    hostname_pattern: string
    repo_path: string
    supervisor_id: string | null
    deploy_strategy: DeployStrategy
    auto_merge: boolean
    enabled: boolean
  }>,
): Promise<RevanoteMapping | null> {
  // Whitelisted field-by-field update (no dynamic SQL).
  if (patch.hostname_pattern !== undefined) {
    await sql`UPDATE revanote_app_mappings SET hostname_pattern = ${patch.hostname_pattern}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  if (patch.repo_path !== undefined) {
    await sql`UPDATE revanote_app_mappings SET repo_path = ${patch.repo_path}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  if (patch.supervisor_id !== undefined) {
    await sql`UPDATE revanote_app_mappings SET supervisor_id = ${patch.supervisor_id}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  if (patch.deploy_strategy !== undefined) {
    await sql`UPDATE revanote_app_mappings SET deploy_strategy = ${patch.deploy_strategy}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  if (patch.auto_merge !== undefined) {
    await sql`UPDATE revanote_app_mappings SET auto_merge = ${patch.auto_merge}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  if (patch.enabled !== undefined) {
    await sql`UPDATE revanote_app_mappings SET enabled = ${patch.enabled}, updated_at = now() WHERE id = ${id} AND user_id = ${userId}`
  }
  // Also clear auto_created flag the first time a user touches a row.
  await sql`UPDATE revanote_app_mappings SET auto_created = false WHERE id = ${id} AND user_id = ${userId} AND auto_created = true`
  const rows = await sql<RevanoteMapping[]>`SELECT * FROM revanote_app_mappings WHERE id = ${id} AND user_id = ${userId}`
  return rows[0] ?? null
}

export async function deleteRevanoteMapping(id: string, userId: string): Promise<boolean> {
  const rows = await sql`DELETE FROM revanote_app_mappings WHERE id = ${id} AND user_id = ${userId} RETURNING id`
  return rows.length > 0
}

/**
 * Resolve the best-matching mapping for a hostname. Most-specific-pattern
 * wins. Tie-break: most-recently-updated row.
 *
 * Specificity scoring (higher = more specific):
 *   - literal match (no glob): 1000
 *   - glob match (`*.foo.com`): 100 + label count
 *   - all-globs (`*`): 1
 */
function matchesPattern(pattern: string, host: string): { ok: boolean; specificity: number } {
  const p = pattern.toLowerCase().trim()
  const h = host.toLowerCase().trim()
  if (p === h) return { ok: true, specificity: 1000 }
  if (p === '*') return { ok: true, specificity: 1 }
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".foo.com"
    if (h.endsWith(suffix) && h.length > suffix.length) {
      return { ok: true, specificity: 100 + suffix.split('.').filter(Boolean).length }
    }
  }
  return { ok: false, specificity: 0 }
}

export async function resolveRevanoteMappingForHost(
  userId: string,
  host: string,
): Promise<RevanoteMapping | null> {
  const rows = await listRevanoteMappings(userId)
  let best: { row: RevanoteMapping; score: number } | null = null
  for (const r of rows) {
    if (!r.enabled) continue
    const m = matchesPattern(r.hostname_pattern, host)
    if (!m.ok) continue
    if (!best || m.specificity > best.score) best = { row: r, score: m.specificity }
    // Tie-break by updated_at (rows already ordered DESC).
  }
  return best?.row ?? null
}

// ── Annotations ──────────────────────────────────────────────────────────────

export async function insertAnnotation(opts: {
  user_id: string
  annotation_id_external: string
  page_url: string
  annotation_url: string | null
  screenshot_url: string | null
  x: number | null
  y: number | null
  element_selector: string | null
  comment: string
  replies_json: unknown
  callback_url: string
  mapping_id: string | null
  source_ip: string | null
  payload_raw: any
}): Promise<AnnotationRow> {
  const rows = await sql<AnnotationRow[]>`
    INSERT INTO annotations
      (user_id, annotation_id_external, page_url, annotation_url,
       screenshot_url, x, y, element_selector, comment, replies_json,
       callback_url, mapping_id, source_ip, payload_raw)
    VALUES
      (${opts.user_id}, ${opts.annotation_id_external}, ${opts.page_url},
       ${opts.annotation_url}, ${opts.screenshot_url}, ${opts.x}, ${opts.y},
       ${opts.element_selector}, ${opts.comment},
       ${sql.json(opts.replies_json as any)},
       ${opts.callback_url}, ${opts.mapping_id}, ${opts.source_ip},
       ${sql.json(opts.payload_raw)})
    ON CONFLICT (user_id, annotation_id_external) DO UPDATE
       SET callback_url = EXCLUDED.callback_url,
           payload_raw = CASE
             WHEN EXCLUDED.payload_raw ? 'fix_contract' THEN EXCLUDED.payload_raw
             WHEN annotations.payload_raw ? 'fix_contract'
               THEN jsonb_set(EXCLUDED.payload_raw, '{fix_contract}', annotations.payload_raw -> 'fix_contract')
             ELSE EXCLUDED.payload_raw
           END
    RETURNING *
  `
  return rows[0]
}

export async function getAnnotationById(
  id: string,
  userId: string,
): Promise<AnnotationRow | null> {
  const rows = await sql<AnnotationRow[]>`
    SELECT * FROM annotations WHERE id = ${id} AND user_id = ${userId}
  `
  return rows[0] ?? null
}

export async function listAnnotations(
  userId: string,
  opts: { limit?: number; status?: AnnotationStatus | null } = {},
): Promise<AnnotationRow[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  if (opts.status) {
    return await sql<AnnotationRow[]>`
      SELECT * FROM annotations
       WHERE user_id = ${userId} AND status = ${opts.status}
       ORDER BY received_at DESC
       LIMIT ${limit}
    `
  }
  return await sql<AnnotationRow[]>`
    SELECT * FROM annotations
     WHERE user_id = ${userId}
     ORDER BY received_at DESC
     LIMIT ${limit}
  `
}

export async function updateAnnotationStatus(
  id: string,
  status: AnnotationStatus,
  opts: {
    skip_reason?: string | null
    session_id?: string | null
    mapping_id?: string | null
    dispatched_at?: Date | null
    resolved_at?: Date | null
  } = {},
): Promise<void> {
  await sql`
    UPDATE annotations
       SET status = ${status},
           skip_reason = COALESCE(${opts.skip_reason ?? null}, skip_reason),
           session_id = COALESCE(${opts.session_id ?? null}, session_id),
           mapping_id = COALESCE(${opts.mapping_id ?? null}, mapping_id),
           dispatched_at = COALESCE(${opts.dispatched_at ?? null}, dispatched_at),
           resolved_at = COALESCE(${opts.resolved_at ?? null}, resolved_at)
     WHERE id = ${id}
  `
}

// ── Annotation runs ──────────────────────────────────────────────────────────

export async function insertAnnotationRun(opts: {
  annotation_id: string
  user_id: string
  session_id: string | null
}): Promise<AnnotationRunRow> {
  const rows = await sql<AnnotationRunRow[]>`
    INSERT INTO annotation_runs (annotation_id, user_id, session_id, status)
    VALUES (${opts.annotation_id}, ${opts.user_id}, ${opts.session_id}, 'in_flight')
    RETURNING *
  `
  return rows[0]
}

export async function updateAnnotationRun(
  id: string,
  patch: Partial<{
    status: AnnotationRunStatus
    resolved: boolean | null
    action_taken: string | null
    agent_reply: string | null
    files_changed: unknown
    deployed: boolean
    error: string | null
    cost_usd: number | null
    duration_ms: number | null
    output_snippet: string | null
    finished_at: Date | null
  }>,
): Promise<AnnotationRunRow | null> {
  // Field-by-field whitelist updates — same pattern as updateRevanoteMapping.
  if (patch.status !== undefined) {
    await sql`UPDATE annotation_runs SET status = ${patch.status} WHERE id = ${id}`
  }
  if (patch.resolved !== undefined) {
    await sql`UPDATE annotation_runs SET resolved = ${patch.resolved} WHERE id = ${id}`
  }
  if (patch.action_taken !== undefined) {
    await sql`UPDATE annotation_runs SET action_taken = ${patch.action_taken} WHERE id = ${id}`
  }
  if (patch.agent_reply !== undefined) {
    await sql`UPDATE annotation_runs SET agent_reply = ${patch.agent_reply} WHERE id = ${id}`
  }
  if (patch.files_changed !== undefined) {
    await sql`UPDATE annotation_runs SET files_changed = ${sql.json(patch.files_changed as any)} WHERE id = ${id}`
  }
  if (patch.deployed !== undefined) {
    await sql`UPDATE annotation_runs SET deployed = ${patch.deployed} WHERE id = ${id}`
  }
  if (patch.error !== undefined) {
    await sql`UPDATE annotation_runs SET error = ${patch.error} WHERE id = ${id}`
  }
  if (patch.cost_usd !== undefined) {
    await sql`UPDATE annotation_runs SET cost_usd = ${patch.cost_usd} WHERE id = ${id}`
  }
  if (patch.duration_ms !== undefined) {
    await sql`UPDATE annotation_runs SET duration_ms = ${patch.duration_ms} WHERE id = ${id}`
  }
  if (patch.output_snippet !== undefined) {
    await sql`UPDATE annotation_runs SET output_snippet = ${patch.output_snippet} WHERE id = ${id}`
  }
  if (patch.finished_at !== undefined) {
    await sql`UPDATE annotation_runs SET finished_at = ${patch.finished_at} WHERE id = ${id}`
  }
  const rows = await sql<AnnotationRunRow[]>`SELECT * FROM annotation_runs WHERE id = ${id}`
  return rows[0] ?? null
}

export async function listAnnotationRuns(
  annotationId: string,
  userId: string,
): Promise<AnnotationRunRow[]> {
  return await sql<AnnotationRunRow[]>`
    SELECT * FROM annotation_runs
     WHERE annotation_id = ${annotationId} AND user_id = ${userId}
     ORDER BY started_at DESC
  `
}

// ── Callback queue ───────────────────────────────────────────────────────────

export async function enqueueCallbackAttempt(opts: {
  annotation_id: string
  payload_json: any
  next_retry_at: Date | null
}): Promise<CallbackAttemptRow> {
  const rows = await sql<CallbackAttemptRow[]>`
    INSERT INTO revanote_callback_attempts
      (annotation_id, attempt_no, next_retry_at, payload_json)
    VALUES
      (${opts.annotation_id}, 0, ${opts.next_retry_at}, ${sql.json(opts.payload_json)})
    RETURNING *
  `
  return rows[0]
}

/**
 * Claim due callback attempts. Uses `FOR UPDATE SKIP LOCKED` so multiple
 * workers on a single hub (or hot reloads) cannot dispatch the same row twice.
 * Returns up to `limit` rows with `next_retry_at` cleared (caller must
 * re-set it on failure or mark delivered/dead on terminal outcome).
 */
export async function claimDueCallbackAttempts(
  limit: number,
): Promise<CallbackAttemptRow[]> {
  const rows = await sql<CallbackAttemptRow[]>`
    WITH due AS (
      SELECT id FROM revanote_callback_attempts
       WHERE next_retry_at IS NOT NULL AND next_retry_at <= now()
       ORDER BY next_retry_at ASC
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    UPDATE revanote_callback_attempts
       SET next_retry_at = NULL, attempted_at = now()
     WHERE id IN (SELECT id FROM due)
    RETURNING *
  `
  return rows
}

export async function updateCallbackAttempt(
  id: string,
  patch: Partial<{
    attempt_no: number
    http_status: number | null
    error: string | null
    next_retry_at: Date | null
    delivered: boolean
    dead: boolean
  }>,
): Promise<void> {
  if (patch.attempt_no !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET attempt_no = ${patch.attempt_no} WHERE id = ${id}`
  }
  if (patch.http_status !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET http_status = ${patch.http_status} WHERE id = ${id}`
  }
  if (patch.error !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET error = ${patch.error} WHERE id = ${id}`
  }
  if (patch.next_retry_at !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET next_retry_at = ${patch.next_retry_at} WHERE id = ${id}`
  }
  if (patch.delivered !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET delivered = ${patch.delivered} WHERE id = ${id}`
  }
  if (patch.dead !== undefined) {
    await sql`UPDATE revanote_callback_attempts SET dead = ${patch.dead} WHERE id = ${id}`
  }
}

// ── Cost-cap helpers ─────────────────────────────────────────────────────────

/**
 * Sum revanote-attributed cost for today (user's local timezone).
 * Used by the revanote dispatcher's per-source budget gate.
 */
export async function sumTodayAnnotationCostForUser(
  userId: string,
  timezone: string,
): Promise<number> {
  const rows = await sql<{ total: string | null }[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM annotation_runs
     WHERE user_id = ${userId}
       AND started_at AT TIME ZONE ${timezone} >= date_trunc('day', now() AT TIME ZONE ${timezone})
  `
  return Number(rows[0]?.total ?? 0)
}

// ── Helpers re-used by the postgres driver -----------------------------------
// Note: `sql.json()` is the bun-postgres `postgres` driver helper for JSONB
// values. If you swap drivers, this needs to switch to `JSON.stringify()` +
// raw string parameterization.
