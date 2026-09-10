/**
 * DAL for the inbound-email work API (milestone WORK / `remo_work`).
 *
 * Sibling of `hub/src/db/ask-dal.ts`. Three concerns, all of them containment:
 *
 *  - `work_repo_allowlist` — audit finding F6. EMPTY by default; a repo that is
 *    not on it can never be driven by an email (403, no dispatch, no spend).
 *  - `work_sites` — the per-site trust record. `auto_publish` DEFAULTS FALSE and
 *    `client_emails` is the sender allowlist. Both are load-bearing security
 *    checks, not conveniences.
 *  - `work_runs` — the audit trail (F9): source email metadata, the FULL prompt,
 *    the commits, the QC evidence, and whether it published.
 *
 * `finalizeWork` is CONDITIONAL (`AND status IN ('queued','dispatched')`) so a
 * late agent reply can never overwrite a reaped row and the reaper can never
 * overwrite a landed result — same discipline as `finalizeAsk` / `finalizeRun`.
 */
import { sql } from './postgres.ts'

// ── Repo allowlist (F6) ──────────────────────────────────────────────────────

/** TRUE iff this user has explicitly allowlisted this repo for email-driven work. */
export async function isRepoWorkAllowed(userId: string, repoIdent: string): Promise<boolean> {
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
      FROM work_repo_allowlist
     WHERE user_id = ${userId} AND repo_ident = ${repoIdent}
  `
  return Number(rows[0]?.n ?? 0) > 0
}

export async function addRepoToWorkAllowlist(userId: string, repoIdent: string): Promise<void> {
  await sql`
    INSERT INTO work_repo_allowlist (user_id, repo_ident)
    VALUES (${userId}, ${repoIdent})
    ON CONFLICT (user_id, repo_ident) DO NOTHING
  `
}

export async function listWorkAllowlist(userId: string): Promise<string[]> {
  const rows = await sql<{ repo_ident: string }[]>`
    SELECT repo_ident FROM work_repo_allowlist WHERE user_id = ${userId} ORDER BY repo_ident
  `
  return rows.map((r) => r.repo_ident)
}

// ── Site trust records ───────────────────────────────────────────────────────

export interface WorkSite {
  id: string
  user_id: string
  repo_ident: string
  site_key: string
  site_dir: string
  client_emails: string[]
  auto_publish: boolean
  /** OPERATOR-configured. Executed by the SUPERVISOR on the hub's order — never by the agent. */
  publish_cmd: string | null
  build_cmd: string | null
  verify_url: string | null
  /** Optional per-branch preview URL. When set, the hub's PRE-publish probe hits the CHANGE. */
  preview_verify_url: string | null
  coolify_app_uuid: string | null
  default_branch: string
}

export async function findWorkSite(
  userId: string,
  repoIdent: string,
  siteKey: string,
): Promise<WorkSite | null> {
  const rows = await sql<WorkSite[]>`
    SELECT id, user_id, repo_ident, site_key, site_dir, client_emails,
           auto_publish, publish_cmd, build_cmd, verify_url, preview_verify_url,
           coolify_app_uuid, default_branch
      FROM work_sites
     WHERE user_id = ${userId} AND repo_ident = ${repoIdent} AND site_key = ${siteKey}
     LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Sender allowlist check. Case-insensitive, whitespace-trimmed; an angle-bracket
 * From header (`Client Name <a@b.com>`) is reduced to its address first, so a
 * display name can never smuggle a match.
 */
export function normalizeEmail(raw: string): string {
  const s = (raw ?? '').trim()
  const angled = s.match(/<([^>]+)>\s*$/)
  return (angled ? angled[1] : s).trim().toLowerCase()
}

export function isKnownSender(site: WorkSite, from: string): boolean {
  const addr = normalizeEmail(from)
  if (!addr) return false
  return (site.client_emails ?? []).some((e) => normalizeEmail(e) === addr)
}

// ── work_runs (F9 audit trail) ───────────────────────────────────────────────

export type WorkStatus =
  | 'queued'
  | 'dispatched'
  /** Agent pushed a branch; the HUB is now running its own diff-scope + build + probe. */
  | 'verifying'
  | 'completed'
  | 'qc_failed'
  | 'needs_human'
  | 'timeout'
  | 'skipped'
  | 'failed'

export interface WorkRun {
  id: string
  user_id: string
  session_id: string
  api_key_id: string | null
  repo_ident: string
  site_key: string
  site_id: string | null
  auto_publish: boolean
  source_kind: string
  source_from: string | null
  source_subject: string | null
  source_message_id: string | null
  request_text: string
  prompt: string
  nonce: string
  status: WorkStatus
  branch: string | null
  hub_qc: unknown | null
  deploy_status: string | null
  summary: string | null
  files_changed: string[] | null
  commit_shas: string[] | null
  qc: unknown | null
  diff_url: string | null
  pr_url: string | null
  preview_url: string | null
  live_url: string | null
  published: boolean
  blocker: string | null
  reason: string | null
  raw_reply: string | null
  created_at: Date
  finished_at: Date | null
}

export async function insertWorkRun(input: {
  userId: string
  sessionId: string
  apiKeyId: string | null
  repoIdent: string
  siteKey: string
  siteId: string
  autoPublish: boolean
  sourceKind: string
  sourceFrom: string | null
  sourceSubject: string | null
  sourceMessageId: string | null
  requestText: string
  prompt: string
  nonce: string
}): Promise<WorkRun> {
  const rows = await sql<WorkRun[]>`
    INSERT INTO work_runs (
      user_id, session_id, api_key_id, repo_ident, site_key, site_id, auto_publish,
      source_kind, source_from, source_subject, source_message_id,
      request_text, prompt, nonce, status
    ) VALUES (
      ${input.userId}, ${input.sessionId}, ${input.apiKeyId}, ${input.repoIdent},
      ${input.siteKey}, ${input.siteId}, ${input.autoPublish},
      ${input.sourceKind}, ${input.sourceFrom}, ${input.sourceSubject}, ${input.sourceMessageId},
      ${input.requestText}, ${input.prompt}, ${input.nonce}, 'queued'
    )
    RETURNING *
  `
  return rows[0]
}

export async function getWorkRun(workId: string, userId: string): Promise<WorkRun | null> {
  const rows = await sql<WorkRun[]>`
    SELECT * FROM work_runs WHERE id = ${workId} AND user_id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}

export async function markWorkDispatched(workId: string): Promise<void> {
  await sql`UPDATE work_runs SET status = 'dispatched' WHERE id = ${workId} AND status = 'queued'`
}

/**
 * Move a row to `verifying` — the agent has replied with a branch and the HUB is now
 * running its own diff-scope check, its own build and its own HTTPS probe. Conditional,
 * so a reaped row is never resurrected.
 */
export async function markWorkVerifying(
  workId: string,
  patch: { branch: string | null; summary: string | null; commit_shas: string[] | null; raw_reply: string | null },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE work_runs
       SET status      = 'verifying',
           branch      = ${patch.branch},
           summary     = ${patch.summary},
           commit_shas = ${patch.commit_shas ? JSON.stringify(patch.commit_shas) : null}::jsonb,
           raw_reply   = ${patch.raw_reply}
     WHERE id = ${workId}
       AND status IN ('queued', 'dispatched')
     RETURNING id
  `
  return rows.length > 0
}

/**
 * Terminal write. CONDITIONAL on the row still being non-terminal ⇒ exactly one
 * winner in a reaper/late-reply race. Returns true iff this call won.
 *
 * `published` is written ONLY by the hub's own publish path (hub/src/work/publish.ts),
 * and it is STILL ANDed with `work_runs.auto_publish` IN SQL as a belt-and-braces
 * backstop: no agent claim, and no future caller mistake, can mark an untrusted site
 * published. `files_changed` is the HUB-OBSERVED diff (from `hub_qc`), not the agent's
 * list. `qc` (agent self-report) is advisory; `hub_qc` is the evidence.
 */
export async function finalizeWork(
  workId: string,
  status: Exclude<WorkStatus, 'queued' | 'dispatched' | 'verifying'>,
  patch: {
    summary?: string | null
    branch?: string | null
    files_changed?: string[] | null
    commit_shas?: string[] | null
    /** Agent self-report. ADVISORY ONLY. */
    qc?: unknown | null
    /** HUB-OBSERVED evidence: diff scope + build + HTTPS probe. */
    hub_qc?: unknown | null
    deploy_status?: string | null
    diff_url?: string | null
    pr_url?: string | null
    preview_url?: string | null
    live_url?: string | null
    published?: boolean
    blocker?: string | null
    reason?: string | null
    raw_reply?: string | null
  } = {},
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE work_runs
       SET status        = ${status},
           summary       = COALESCE(${patch.summary ?? null}, work_runs.summary),
           branch        = COALESCE(${patch.branch ?? null}, work_runs.branch),
           files_changed = ${patch.files_changed ? JSON.stringify(patch.files_changed) : null}::jsonb,
           commit_shas   = COALESCE(${patch.commit_shas ? JSON.stringify(patch.commit_shas) : null}::jsonb, work_runs.commit_shas),
           qc            = ${patch.qc != null ? JSON.stringify(patch.qc) : null}::jsonb,
           hub_qc        = ${patch.hub_qc != null ? JSON.stringify(patch.hub_qc) : null}::jsonb,
           deploy_status = ${patch.deploy_status ?? null},
           diff_url      = ${patch.diff_url ?? null},
           pr_url        = ${patch.pr_url ?? null},
           preview_url   = ${patch.preview_url ?? null},
           live_url      = ${patch.live_url ?? null},
           published     = (${patch.published ?? false} AND work_runs.auto_publish),
           blocker       = ${patch.blocker ?? null},
           reason        = ${patch.reason ?? null},
           raw_reply     = COALESCE(${patch.raw_reply ?? null}, work_runs.raw_reply),
           finished_at   = now()
     WHERE id = ${workId}
       AND status IN ('queued', 'dispatched', 'verifying')
     RETURNING id
  `
  return rows.length > 0
}

/** Non-terminal work items with their age in ms. Drives the reaper. */
export async function loadOpenWorkRuns(): Promise<Array<{ id: string; created_at_ms: number }>> {
  const rows = await sql<{ id: string; created_at_ms: string }[]>`
    SELECT id, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
      FROM work_runs
     WHERE status IN ('queued', 'dispatched', 'verifying')
  `
  return rows.map((r) => ({ id: r.id, created_at_ms: Number(r.created_at_ms) }))
}

/** Count this user's work items in the trailing `minutes` — drives `workRateGate`. */
export async function countWorkRunsForUserSince(userId: string, minutes: number): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
      FROM work_runs
     WHERE user_id = ${userId}
       AND created_at >= now() - (${minutes} || ' minutes')::interval
  `
  return Number(rows[0]?.n ?? 0)
}
