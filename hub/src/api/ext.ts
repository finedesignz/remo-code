/**
 * /api/ext — the EXTERNAL agent surface (milestone ASK).
 *
 * Lets a Claude Desktop scheduled task (or any MCP/HTTP client holding an api_key)
 *   (a) find the remo-code session for a repo,
 *   (b) READ that session's on-disk transcript tail + project memory (FREE — zero
 *       tokens, zero PTY writes, works for pty-interactive sessions too), and
 *   (c) ASK it a question and get an ANSWER back (PAID — spends tokens; escalate
 *       only when the free reads are inconclusive).
 *
 * Auth: `api_keys` + the additive nullable `scopes` column (ext:read / ext:ask).
 * Mounted BEFORE the cookie/JWT catch-all — see the MOUNT-ORDER INVARIANT in
 * hub/src/index.ts and the assertion in hub/test/mount-order.test.ts.
 *
 * The reads proxy to the supervisor's allowlisted READ-ONLY `run_command`s
 * (`session_transcript_tail` / `session_memory`); the path-traversal chokepoint
 * lives on the supervisor (supervisor/src/commands/session-read.ts).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { sql } from '../db/postgres.ts'
import {
  findSupervisorForSession,
  listOnlineSupervisorIdsForUser,
} from '../ws/supervisor-registry.ts'
import { getChannel } from '../ws/registry.ts'
import { runSupervisorReadCommand, parseSnippet } from '../ext/supervisor-read.ts'
import { insertAsk, getAsk, type SessionAsk } from '../db/ask-dal.ts'
import { findAskSession, dispatchAsk } from '../ask/dispatch.ts'
import { renderAskPrompt } from '../ask/prompt.ts'
import {
  isRepoWorkAllowed,
  findWorkSite,
  isKnownSender,
  insertWorkRun,
  getWorkRun,
  type WorkRun,
} from '../db/work-dal.ts'
import { dispatchWork } from '../work/dispatch.ts'
import { renderWorkPrompt } from '../work/prompt.ts'

export const ext = new Hono()

const MAX_WAIT_MS = 120_000

interface SessionRow {
  id: string
  name: string
  project_dir: string | null
  runner_type: string
  status: string
  hostname: string | null
  repo_key: string | null
  github_owner: string | null
  github_repo: string | null
  last_activity: Date | null
}

function repoIdent(s: SessionRow): string | null {
  if (s.github_owner && s.github_repo) return `github://${s.github_owner}/${s.github_repo}`
  if (s.project_dir) return `path://${s.project_dir}`
  return null
}

/** Resolve `:id` — a session id, OR a repo_ident (`github://o/r` | `path://<abs>`). */
async function resolveSession(userId: string, id: string): Promise<SessionRow | null> {
  const rows = await sql<SessionRow[]>`
    SELECT id, name, project_dir, runner_type, status, hostname,
           repo_key, github_owner, github_repo, last_activity
      FROM sessions
     WHERE user_id = ${userId} AND deleted_at IS NULL
     ORDER BY last_activity DESC NULLS LAST
  `
  const direct = rows.find((r) => r.id === id)
  if (direct) return direct
  const want = id.trim()
  return (
    rows.find((r) => repoIdent(r) === want) ??
    rows.find((r) => r.repo_key === want) ??
    // Convenience: bare repo name ("remo-code") matches the github repo or the
    // last path segment — Desktop should not have to memorize UUIDs.
    rows.find(
      (r) =>
        r.github_repo === want ||
        (r.project_dir ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() === want,
    ) ??
    null
  )
}

/** Which supervisor host holds this session's transcript. */
function supervisorForSession(userId: string, sessionId: string): { id: string } | { error: string } {
  const live = findSupervisorForSession(sessionId)
  if (live && live.userId === userId) return { id: live.supervisorId }
  const online = listOnlineSupervisorIdsForUser(userId)
  if (online.length === 1) return { id: online[0] }
  if (online.length === 0) return { error: 'supervisor_offline' }
  return { error: 'supervisor_ambiguous' }
}

// ── Read surface (Phase 1) — zero tokens, zero PTY writes ────────────────────

ext.get('/sessions', async (c) => {
  const userId = c.get('userId') as string
  const rows = await sql<SessionRow[]>`
    SELECT id, name, project_dir, runner_type, status, hostname,
           repo_key, github_owner, github_repo, last_activity
      FROM sessions
     WHERE user_id = ${userId} AND deleted_at IS NULL
     ORDER BY last_activity DESC NULLS LAST
  `
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id,
      name: s.name,
      repo_ident: repoIdent(s),
      project_dir: s.project_dir,
      runner_type: s.runner_type,
      active: getChannel(s.id) != null,
      last_activity: s.last_activity,
    })),
  })
})

ext.get('/sessions/:id/transcript', async (c) => {
  const userId = c.get('userId') as string
  const session = await resolveSession(userId, c.req.param('id'))
  if (!session) return c.json({ error: 'session_not_found' }, 404)
  if (!session.project_dir) return c.json({ error: 'no_project_dir' }, 409)

  const sup = supervisorForSession(userId, session.id)
  if ('error' in sup) return c.json({ error: sup.error }, 503)

  const tailRaw = Number(c.req.query('tail'))
  const tail = Number.isFinite(tailRaw) && tailRaw > 0 ? String(Math.floor(tailRaw)) : '30'

  const res = await runSupervisorReadCommand(sup.id, userId, 'session_transcript_tail', [
    session.project_dir,
    tail,
  ])
  const payload = parseSnippet<{ turns: unknown[]; truncated: boolean }>(res)
  if (!payload) return c.json({ error: res.error ?? 'transcript_unavailable' }, 502)
  return c.json({ session_id: session.id, ...payload })
})

ext.get('/sessions/:id/memory', async (c) => {
  const userId = c.get('userId') as string
  const session = await resolveSession(userId, c.req.param('id'))
  if (!session) return c.json({ error: 'session_not_found' }, 404)
  if (!session.project_dir) return c.json({ error: 'no_project_dir' }, 409)

  const sup = supervisorForSession(userId, session.id)
  if ('error' in sup) return c.json({ error: sup.error }, 503)

  const res = await runSupervisorReadCommand(sup.id, userId, 'session_memory', [session.project_dir])
  const payload = parseSnippet<{ files: unknown[]; truncated: boolean }>(res)
  if (!payload) return c.json({ error: res.error ?? 'memory_unavailable' }, 502)
  return c.json({ session_id: session.id, ...payload })
})

ext.get('/sessions/:id/state', async (c) => {
  const userId = c.get('userId') as string
  const session = await resolveSession(userId, c.req.param('id'))
  if (!session) return c.json({ error: 'session_not_found' }, 404)

  const lastAssistant = await sql<{ created_at: Date }[]>`
    SELECT created_at FROM messages
     WHERE session_id = ${session.id} AND role = 'assistant'
     ORDER BY created_at DESC LIMIT 1
  `
  const openRuns = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM session_runs
     WHERE session_id = ${session.id} AND ended_at IS NULL
  `
  return c.json({
    session_id: session.id,
    repo_ident: repoIdent(session),
    runner_type: session.runner_type,
    active: getChannel(session.id) != null,
    status: session.status,
    last_activity: session.last_activity,
    last_assistant_message_at: lastAssistant[0]?.created_at ?? null,
    open_session_runs: Number(openRuns[0]?.n ?? 0),
  })
})

// ── Ask (Phase 2) — spends tokens, rides every non-bypassable gate ───────────

const AskBody = z.object({
  question: z.string().min(1).max(8_000),
  context: z.string().max(8_000).optional(),
  wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
  include_transcript: z.boolean().optional(),
  include_memory: z.boolean().optional(),
})

function askView(a: SessionAsk) {
  return {
    ask_id: a.id,
    status: a.status,
    answer: a.answer,
    confidence: a.confidence,
    evidence: a.evidence,
    reason: a.reason,
    raw_reply: a.raw_reply,
    created_at: a.created_at,
    answered_at: a.answered_at,
  }
}

ext.post('/sessions/:id/ask', async (c) => {
  const userId = c.get('userId') as string
  const apiKeyId = (c.get('apiKeyId') as string) ?? null

  const target = await resolveSession(userId, c.req.param('id'))
  if (!target) return c.json({ error: 'session_not_found' }, 404)
  if (!target.project_dir) return c.json({ error: 'no_project_dir' }, 409)

  let body: z.infer<typeof AskBody>
  try {
    body = AskBody.parse(await c.req.json())
  } catch (err: any) {
    return c.json({ error: 'bad_request', detail: err?.message }, 400)
  }

  // Resolve the ANSWERING session: a stream-json CLI on the same project_dir. We
  // never write to the human's PTY (see docs/session-ask.md §invariants).
  const askSession = await findAskSession(userId, target.project_dir)
  if (!askSession) {
    return c.json(
      {
        error: 'no_ask_session',
        detail:
          'No stream-json session exists for this project_dir. Create one (or start the ' +
          'orchestrator) — the ask is never routed into a pty-interactive session.',
      },
      409,
    )
  }

  // Free reads first — they become FENCED DATA in the prompt (never instructions).
  let transcript: string | undefined
  let memory: string | undefined
  const sup = supervisorForSession(userId, target.id)
  if (!('error' in sup)) {
    if (body.include_transcript !== false) {
      const r = await runSupervisorReadCommand(sup.id, userId, 'session_transcript_tail', [
        target.project_dir,
        '30',
      ])
      const p = parseSnippet<{ turns: Array<{ role: string; text: string }> }>(r)
      if (p?.turns?.length) {
        transcript = p.turns.map((t) => `[${t.role}] ${t.text}`).join('\n\n')
      }
    }
    if (body.include_memory !== false) {
      const r = await runSupervisorReadCommand(sup.id, userId, 'session_memory', [target.project_dir])
      const p = parseSnippet<{ files: Array<{ name: string; content: string }> }>(r)
      if (p?.files?.length) {
        memory = p.files.map((f) => `### ${f.name}\n${f.content}`).join('\n\n')
      }
    }
  }

  const ask = await insertAsk({
    userId,
    sessionId: askSession.id,
    targetSessionId: target.id,
    apiKeyId,
    question: body.question,
  })

  const prompt = renderAskPrompt({
    askId: ask.id,
    question: body.question,
    context: body.context,
    targetSessionName: target.name,
    projectDir: target.project_dir,
    transcript,
    memory,
  })

  await dispatchAsk({
    askId: ask.id,
    userId,
    apiKeyId,
    askSessionId: askSession.id,
    prompt,
  })

  // Optional long-poll so a Desktop tool call usually gets its answer in ONE call.
  const waitMs = Math.min(body.wait_ms ?? 0, MAX_WAIT_MS)
  const deadline = Date.now() + waitMs
  let current = (await getAsk(ask.id, userId)) ?? ask
  while (waitMs > 0 && Date.now() < deadline) {
    if (current.status !== 'queued' && current.status !== 'dispatched') break
    await new Promise((r) => setTimeout(r, 1_000))
    current = (await getAsk(ask.id, userId)) ?? current
  }

  return c.json({ session_id: askSession.id, ...askView(current) }, 202)
})

ext.get('/sessions/:id/ask/:ask_id', async (c) => {
  const userId = c.get('userId') as string
  const ask = await getAsk(c.req.param('ask_id'), userId)
  if (!ask) return c.json({ error: 'ask_not_found' }, 404)
  return c.json({ session_id: ask.session_id, target_session_id: ask.target_session_id, ...askView(ask) })
})

// ── Work (milestone WORK) — inbound email → repo agent → QC → gated publish ──
//
// THREAT MODEL: `request_text` came from a CLIENT EMAIL. Nobody authenticated it.
// This endpoint points that text at an agent with file-write powers on a repo that
// can publish to a LIVE CLIENT WEBSITE, so the containment is the feature:
//
//   1. REPO ALLOWLIST (F6)  — `work_repo_allowlist` is EMPTY by default. Not on it
//                             ⇒ 403, no row, no dispatch, no spend.
//   2. SITE TRUST RECORD    — the site must exist in `work_sites` (403 otherwise).
//   3. SENDER ALLOWLIST     — `source.from` must match that site's `client_emails`
//                             ⇒ 403 `unknown_sender`. An email from an unknown
//                             address NEVER reaches a session.
//   4. auto_publish         — DEFAULTS FALSE. False ⇒ the prompt forbids publishing
//                             AND `finalizeWork` refuses to record `published=true`.
//   5. GATES                — cost cap · token cap · humanOnlyPty · work rate ·
//                             repo allowlist (again), inside dispatchWork.
//   6. AUDIT (F9)           — every work item persists the source email metadata,
//                             the FULL prompt, the commits, and the QC evidence.

const WorkBody = z.object({
  repo: z.string().min(1),
  site: z.string().min(1),
  request_text: z.string().min(1).max(20_000),
  source: z.object({
    kind: z.literal('email'),
    from: z.string().min(1).max(320),
    subject: z.string().max(2_000).optional(),
    message_id: z.string().max(998).optional(),
  }),
  wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
})

function workView(w: WorkRun) {
  return {
    work_id: w.id,
    status: w.status,
    summary: w.summary,
    /** The branch the agent pushed. Its authority ends here. */
    branch: w.branch,
    /** HUB-OBSERVED (from the branch diff), not the agent's claimed file list. */
    files_changed: w.files_changed ?? [],
    commit_shas: w.commit_shas ?? [],
    /** HUB-OBSERVED evidence: diff-scope check + real build exit code + real HTTPS probe. */
    hub_qc: w.hub_qc ?? null,
    /** The agent's self-report. ADVISORY ONLY — never the basis of a publish decision. */
    agent_self_check: w.qc ?? null,
    diff_url: w.diff_url,
    pr_url: w.pr_url,
    preview_url: w.preview_url,
    /** TRUE only when the HUB itself performed the deploy. */
    published: w.published,
    deploy_status: w.deploy_status,
    live_url: w.live_url,
    blocker: w.blocker,
    reason: w.reason,
    auto_publish: w.auto_publish,
    repo_ident: w.repo_ident,
    site_key: w.site_key,
    created_at: w.created_at,
    finished_at: w.finished_at,
  }
}

ext.post('/work', async (c) => {
  const userId = c.get('userId') as string
  const apiKeyId = (c.get('apiKeyId') as string) ?? null

  let body: z.infer<typeof WorkBody>
  try {
    body = WorkBody.parse(await c.req.json())
  } catch (err: any) {
    return c.json({ error: 'bad_request', detail: err?.message }, 400)
  }

  const target = await resolveSession(userId, body.repo)
  if (!target) return c.json({ error: 'session_not_found' }, 404)
  if (!target.project_dir) return c.json({ error: 'no_project_dir' }, 409)

  const ident = repoIdent(target)
  if (!ident) return c.json({ error: 'no_repo_ident' }, 409)

  // (1) REPO ALLOWLIST — checked BEFORE anything is inserted or dispatched, so a
  // non-allowlisted repo costs exactly zero. The same check rides the gate list.
  if (!(await isRepoWorkAllowed(userId, ident))) {
    return c.json(
      {
        error: 'repo_not_allowlisted',
        detail:
          `Repo ${ident} is not in work_repo_allowlist. Email-driven work drives NOTHING ` +
          'until an operator explicitly opts a repo in.',
      },
      403,
    )
  }

  // (2) SITE TRUST RECORD
  const site = await findWorkSite(userId, ident, body.site)
  if (!site) return c.json({ error: 'unknown_site', detail: `No work_sites row for ${ident}/${body.site}` }, 403)

  // (3) SENDER ALLOWLIST — an unknown sender never reaches a session.
  if (!isKnownSender(site, body.source.from)) {
    return c.json({ error: 'unknown_sender' }, 403)
  }

  // The ANSWERING/WORKING session: a stream-json CLI on the repo's project_dir. We
  // never write to a human's PTY.
  const workSession = await findAskSession(userId, target.project_dir)
  if (!workSession) {
    return c.json(
      {
        error: 'no_work_session',
        detail:
          'No stream-json session exists for this project_dir. Create one — work is never ' +
          'routed into a pty-interactive session.',
      },
      409,
    )
  }

  // Server-generated nonce. The email author has never seen it, so a forged
  // `<<WORK:…>>` envelope inside the body cannot be mistaken for the agent's result
  // (and the fence escapes its `<` characters anyway).
  const nonce = randomBytes(12).toString('hex')

  // The branch the agent must push to. HUB-NAMED (derived from the nonce), so the hub
  // knows exactly which ref to verify and the agent cannot point us at some other branch.
  const branch = `work/${nonce}`

  // NOTE what is NOT passed: `auto_publish`, `publish_cmd`, `coolify_app_uuid`. The agent
  // is not told whether the site auto-publishes and has no publish command — publishing is
  // the hub's alone (hub/src/work/publish.ts). What it does not know, it cannot be talked
  // into.
  const prompt = renderWorkPrompt({
    nonce,
    repoIdent: ident,
    siteKey: site.site_key,
    siteDir: site.site_dir,
    branch,
    requestText: body.request_text,
    from: body.source.from,
    subject: body.source.subject ?? null,
    messageId: body.source.message_id ?? null,
  })

  // (6) AUDIT TRAIL — the FULL prompt is persisted with the row, so "which live-site
  // commits came from an inbound email?" is answerable after the fact.
  const work = await insertWorkRun({
    userId,
    sessionId: workSession.id,
    apiKeyId,
    repoIdent: ident,
    siteKey: site.site_key,
    siteId: site.id,
    autoPublish: site.auto_publish,
    sourceKind: body.source.kind,
    sourceFrom: body.source.from,
    sourceSubject: body.source.subject ?? null,
    sourceMessageId: body.source.message_id ?? null,
    requestText: body.request_text,
    prompt,
    nonce,
  })

  const workSup = supervisorForSession(userId, workSession.id)
  await dispatchWork({
    workId: work.id,
    userId,
    apiKeyId,
    sessionId: workSession.id,
    repoIdent: ident,
    nonce,
    prompt,
    site,
    projectDir: target.project_dir,
    supervisorId: 'error' in workSup ? null : workSup.id,
    branch,
  })

  const waitMs = Math.min(body.wait_ms ?? 0, MAX_WAIT_MS)
  const deadline = Date.now() + waitMs
  let current = (await getWorkRun(work.id, userId)) ?? work
  while (waitMs > 0 && Date.now() < deadline) {
    if (!['queued', 'dispatched', 'verifying'].includes(current.status)) break
    await new Promise((r) => setTimeout(r, 1_000))
    current = (await getWorkRun(work.id, userId)) ?? current
  }

  return c.json({ session_id: workSession.id, ...workView(current) }, 202)
})

ext.get('/work/:work_id', async (c) => {
  const userId = c.get('userId') as string
  const work = await getWorkRun(c.req.param('work_id'), userId)
  if (!work) return c.json({ error: 'work_not_found' }, 404)
  return c.json({ session_id: work.session_id, ...workView(work) })
})
