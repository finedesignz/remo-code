/**
 * Work dispatcher (milestone WORK / `remo_work`) — a thin adapter over the shared
 * `hub/src/dispatch/pipeline.ts`, exactly like `hub/src/ask/dispatch.ts`.
 *
 * Like the ask, the prompt goes to a STREAM-JSON session bound to the repo's
 * `project_dir` — never to a human's PTY. The actor is SERVER-INFERRED
 * (`external-work`), never client-assertable, so `humanOnlyPtyGate` cannot be
 * talked out of rejecting a pty-interactive row.
 *
 * GATE LIST (non-negotiable — see the cross-cutting invariant in CLAUDE.md):
 *   thresholdGate · dailyCostCapGate · dailyTokenCapGate · humanOnlyPtyGate ·
 *   workRateGate · workRepoAllowlistGate
 *
 * `dailyCostCapGate` + `dailyTokenCapGate` are scanned by
 * hub/test/token-cap-coverage.test.ts, which hard-fails CI if a dispatch path omits
 * them. `workRepoAllowlistGate` is the F6 fix, duplicated here as defence-in-depth:
 * the route already 403s a non-allowlisted repo before spending anything.
 */
import { sql } from '../db/postgres.ts'
import { insertMessage } from '../db/dal.ts'
import { getChannel, broadcastToSubscribers } from '../ws/registry.ts'
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../dispatch/pipeline.ts'
import {
  thresholdGate,
  dailyCostCapGate,
  dailyTokenCapGate,
  humanOnlyPtyGate,
  workRateGate,
  workRepoAllowlistGate,
} from '../dispatch/gates.ts'
import { EXT_WORK_ACTOR } from '../auth/ext-api-key-middleware.ts'
import { finalizeWork, markWorkDispatched } from '../db/work-dal.ts'
import { parseWorkOutput } from './result-schema.ts'

export type WorkDispatchOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface DispatchWorkInput {
  workId: string
  userId: string
  apiKeyId: string | null
  sessionId: string
  repoIdent: string
  nonce: string
  prompt: string
}

/**
 * Map the agent's parsed result onto a terminal `work_runs` row.
 *
 * FAIL CLOSED on every uncertainty:
 *   - no/!valid envelope ⇒ `needs_human` + `blocker:'unparseable_reply'`. The reply
 *     is NEVER coerced into a success (an ask can fall back to prose; a work item
 *     that can publish to a live site cannot).
 *   - `published` is only ever a CLAIM. `finalizeWork` ANDs it with the row's
 *     `auto_publish` IN SQL, so a claim on an untrusted site is discarded.
 */
export async function finalizeWorkFromReply(
  workId: string,
  nonce: string,
  reply: string,
): Promise<void> {
  const parsed = parseWorkOutput(reply, nonce)
  const raw = (reply ?? '').slice(0, 20_000)

  if (!parsed.ok || !parsed.value) {
    await finalizeWork(workId, 'needs_human', {
      blocker: 'unparseable_reply',
      reason: `envelope:${parsed.reason ?? 'unknown'}`,
      raw_reply: raw,
    })
    return
  }

  const v = parsed.value
  const status = v.status === 'completed' ? 'completed' : v.status // completed|qc_failed|needs_human
  await finalizeWork(workId, status, {
    summary: v.summary,
    files_changed: v.files_changed,
    commit_shas: v.commit_shas,
    qc: v.qc ?? null,
    diff_url: v.diff_url,
    pr_url: v.pr_url,
    preview_url: v.preview_url,
    live_url: v.live_url,
    published: v.published,
    blocker: v.blocker,
    raw_reply: raw,
  })
}

/**
 * Dispatch a work item. Never throws — every outcome lands on the `work_runs` row
 * so the poll endpoint can explain WHY (over_daily_token_cap / over_work_rate /
 * repo_not_allowlisted / automation_blocked_on_pty:external-work / session_offline).
 */
export async function dispatchWork(input: DispatchWorkInput): Promise<WorkDispatchOutcome> {
  const { workId, userId, apiKeyId, sessionId, repoIdent, nonce, prompt } = input

  const store: RunStore = {
    // The work row already exists (the route inserted it so the caller gets an id
    // immediately), so the pipeline's finalize key IS the work id.
    async open() {
      return workId
    },
    async markSkipped(_token, reason) {
      await finalizeWork(workId, 'skipped', { reason })
    },
    async markDispatched() {
      await markWorkDispatched(workId)
    },
    async onFinalize(_token, replyContent) {
      await finalizeWorkFromReply(workId, nonce, replyContent)
    },
    async markFailed(_token, error) {
      await finalizeWork(workId, 'failed', { reason: `agent_send_failed: ${error}` })
    },
  }

  const deps: PipelineDeps = {
    // NON-NEGOTIABLE. dailyCostCapGate + dailyTokenCapGate are non-bypassable
    // (IR-1 / BSA-04; scanned by hub/test/token-cap-coverage.test.ts).
    gates: [
      thresholdGate,
      dailyCostCapGate,
      dailyTokenCapGate,
      humanOnlyPtyGate(async (req) => {
        const rows = await sql<{ runner_type: string }[]>`
          SELECT runner_type FROM sessions WHERE id = ${req.sessionId} LIMIT 1
        `
        // SERVER-INFERRED actor — never client-asserted.
        return { actor: EXT_WORK_ACTOR, runnerType: rows[0]?.runner_type ?? 'stream-json' }
      }),
      workRateGate(userId),
      workRepoAllowlistGate(userId, repoIdent),
    ],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    ensureOnline: async (req) => {
      try {
        const { launchSessionForUser } = await import('../telegram/launch.ts')
        const res = await launchSessionForUser({ userId: req.userId, sessionId: req.sessionId })
        if (!res.ok) return false
        const deadline = Date.now() + 25_000
        while (Date.now() < deadline) {
          if (getChannel(req.sessionId) != null) return true
          await new Promise((r) => setTimeout(r, 500))
        }
        return false
      } catch (err: any) {
        console.warn(`[work] ensureOnline failed session=${req.sessionId}: ${err?.message ?? err}`)
        return false
      }
    },
    replay: async () => {
      await dispatchWork(input)
    },
    onParkExpire: async () => {
      await finalizeWork(workId, 'skipped', { reason: 'session_offline' })
    },
    async send(req) {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('agent channel disappeared')
      const msg = await insertMessage(req.sessionId, 'user', req.prompt)
      broadcastToSubscribers(req.sessionId, {
        type: 'message',
        session_id: req.sessionId,
        message: msg,
      })
      channel.ws.send(
        JSON.stringify({
          type: 'user_message',
          id: msg.id,
          content: req.prompt,
          ts: msg.created_at,
        }),
      )
    },
  }

  const req: DispatchRequest = { userId, sessionId, token: workId, prompt }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
      return { kind: 'dispatched' }
    case 'queued':
      return { kind: 'queued' }
    case 'parked_offline':
      // Stays 'queued' in the DB; the grace replay re-dispatches on reconnect and
      // the reaper times it out if the agent never comes back.
      return { kind: 'queued' }
    case 'dropped_busy':
      return { kind: 'skipped', reason: 'session_busy' }
    case 'skipped':
      return { kind: 'skipped', reason: outcome.reason }
    case 'failed':
      return { kind: 'failed', reason: outcome.reason }
  }
}
