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
