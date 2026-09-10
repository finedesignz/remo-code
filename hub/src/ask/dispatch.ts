/**
 * Ask dispatcher (milestone ASK, Phase 2) — a thin adapter over the shared
 * `hub/src/dispatch/pipeline.ts`, exactly like `hub/src/revanote/dispatcher.ts`.
 *
 * THE KEY MOVE: we never write to the human's PTY. The ask is dispatched to a
 * STREAM-JSON "ask session" bound to the SAME `project_dir` as the target session —
 * a separate, fresh CLI in the same repo (same CLAUDE.md, same memory, same git
 * state). It reads the target's transcript + memory as DATA (injected into the
 * prompt by the caller) and verifies physically with its own tools. The reply comes
 * back through the EXISTING `assistant_message → onSessionReply → RunStore.onFinalize`
 * path. Zero new transport, zero gate relaxation.
 *
 * `humanOnlyPtyGate` STAYS in the gate list: the actor is server-inferred
 * `external-ask` (automation), so if the resolved answering session were somehow a
 * pty-interactive row the ask is REJECTED (`automation_blocked_on_pty:external-ask`),
 * never silently redirected. The redirect to a stream-json session is an explicit
 * resolution step that happens BEFORE dispatch, not a gate bypass.
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
  askRateGate,
} from '../dispatch/gates.ts'
import { EXT_ACTOR } from '../auth/ext-api-key-middleware.ts'
import { finalizeAsk, markAskDispatched } from '../db/ask-dal.ts'
import { parseAskOutput } from './result-schema.ts'
import { askNonce } from './prompt.ts'

export interface AskSessionRow {
  id: string
  name: string
  project_dir: string | null
  runner_type: string
  status: string
  hostname: string | null
  is_orchestrator: boolean
}

/**
 * Resolve the session that will ANSWER: a stream-json session on the target's
 * `project_dir`. Prefers an already-online one. Returns null when the repo has no
 * stream-json session at all (the caller then decides whether to create one).
 */
export async function findAskSession(
  userId: string,
  projectDir: string,
): Promise<AskSessionRow | null> {
  const rows = await sql<AskSessionRow[]>`
    SELECT id, name, project_dir, runner_type, status, hostname, is_orchestrator
      FROM sessions
     WHERE user_id = ${userId}
       AND project_dir = ${projectDir}
       AND deleted_at IS NULL
       AND runner_type = 'stream-json'
       -- NEVER route automation into the orchestrator session: it is exempt from the
       -- git-push-credential scrub (scrubGitPush: !isOrchestratorSession), so an ask/work
       -- prompt landing there would run WITH a live push credential, bypassing the
       -- agent-proposes/hub-disposes invariant. (findWorkSession reuses this resolver.)
       AND is_orchestrator = false
     ORDER BY (status = 'online') DESC, last_activity DESC NULLS LAST
     LIMIT 1
  `
  return rows[0] ?? null
}

export type AskDispatchOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

/**
 * Dispatch an ask. Never throws — every outcome is written to the `session_asks`
 * row so the poll endpoint can explain WHY (cost_capped / token_capped /
 * over_ask_rate / automation_blocked_on_pty:external-ask / session_offline).
 */
export async function dispatchAsk(input: {
  askId: string
  userId: string
  apiKeyId: string | null
  askSessionId: string
  prompt: string
}): Promise<AskDispatchOutcome> {
  const { askId, userId, apiKeyId, askSessionId, prompt } = input

  const store: RunStore = {
    // The ask row already exists (inserted by the route so the caller gets an id
    // immediately), so the pipeline's finalize key IS the ask id.
    async open() {
      return askId
    },
    async markSkipped(_token, reason) {
      await finalizeAsk(askId, 'skipped', { reason })
    },
    async markDispatched() {
      await markAskDispatched(askId)
    },
    async onFinalize(_token, replyContent) {
      // Nonce-scoped parse: an envelope forged inside the injected (untrusted)
      // transcript/memory cannot know this ask's nonce, so it can never win.
      const parsed = parseAskOutput(replyContent, askNonce(askId))
      await finalizeAsk(askId, 'answered', {
        answer: parsed.value.answer,
        confidence: parsed.value.confidence,
        evidence: parsed.value.evidence,
        raw_reply: replyContent.slice(0, 20_000),
        reason: parsed.ok ? null : `parse_fallback:${parsed.reason}`,
      })
    },
    async markFailed(_token, error) {
      await finalizeAsk(askId, 'failed', { reason: `agent_send_failed: ${error}` })
    },
  }

  const deps: PipelineDeps = {
    // NON-NEGOTIABLE gate list. dailyCostCapGate + dailyTokenCapGate are
    // non-bypassable (IR-1 / BSA-04, scanned by hub/test/token-cap-coverage.test.ts).
    // humanOnlyPtyGate keeps automation off any pty-interactive row. askRateGate
    // bounds a looping external caller.
    gates: [
      thresholdGate,
      dailyCostCapGate,
      dailyTokenCapGate,
      humanOnlyPtyGate(async (req) => {
        const rows = await sql<{ runner_type: string }[]>`
          SELECT runner_type FROM sessions WHERE id = ${req.sessionId} LIMIT 1
        `
        // The actor is SERVER-INFERRED from the api_key — never client-asserted.
        return { actor: EXT_ACTOR, runnerType: rows[0]?.runner_type ?? 'stream-json' }
      }),
      askRateGate(apiKeyId),
    ],
    store,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Offline ask session: bring it up with the SAME canonical launch primitive the
    // orchestrator autospawn uses, then re-check. Runs strictly AFTER every gate.
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
        console.warn(`[ask] ensureOnline failed session=${req.sessionId}: ${err?.message ?? err}`)
        return false
      }
    },
    replay: async () => {
      // The grace replay re-sends the SAME prompt once the agent reconnects.
      await dispatchAsk(input)
    },
    onParkExpire: async () => {
      await finalizeAsk(askId, 'skipped', { reason: 'session_offline' })
    },
    send: async (req) => {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('session_offline')
      const msg = await insertMessage(req.sessionId, 'user', req.prompt)
      broadcastToSubscribers(req.sessionId, {
        type: 'message', session_id: req.sessionId, message: msg,
      })
      channel.ws.send(
        JSON.stringify({ type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at }),
      )
    },
  }

  const req: DispatchRequest = { userId, sessionId: askSessionId, token: askId, prompt }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
      return { kind: 'dispatched' }
    case 'queued':
      return { kind: 'queued' }
    case 'parked_offline':
      // Stays 'queued' in the DB; the grace replay re-dispatches on reconnect, and
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
