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
import { runSupervisorReadCommand, parseSnippet } from '../ext/supervisor-read.ts'
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
import { finalizeWork, markWorkDispatched, markWorkVerifying, type WorkSite } from '../db/work-dal.ts'
import { runHubQc } from './verify.ts'
import { publishWork } from './publish.ts'
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
  /** Everything the HUB needs to verify + (maybe) publish WITHOUT asking the agent. */
  site: WorkSite
  projectDir: string
  supervisorId: string | null
  branch: string
}

export interface ReplyDeps {
  pushBranch: (input: {
    supervisorId: string
    userId: string
    projectDir: string
    branch: string
  }) => Promise<{ ok: boolean; head_sha: string | null; error?: string }>
  runHubQc: typeof runHubQc
  publishWork: typeof publishWork
  finalizeWork: typeof finalizeWork
  markWorkVerifying: typeof markWorkVerifying
}

/**
 * Push the agent's LOCAL work branch to origin via the supervisor (option (a): the agent
 * has no push credential). The hub's diff-scope + build read `origin/<branch>`, so the
 * push must happen first.
 */
async function pushBranchViaSupervisor(input: {
  supervisorId: string
  userId: string
  projectDir: string
  branch: string
}): Promise<{ ok: boolean; head_sha: string | null; error?: string }> {
  const res = await runSupervisorReadCommand(
    input.supervisorId,
    input.userId,
    'work_push_branch' as any,
    [input.projectDir, input.branch],
    60_000,
  )
  const p = parseSnippet<{ head_sha: string }>(res)
  if (!p) return { ok: false, head_sha: null, error: res.error ?? 'push_failed' }
  return { ok: true, head_sha: p.head_sha ?? null }
}

/**
 * THE REPLY IS A PROPOSAL, NOT A RESULT. On the agent's reply the hub:
 *   1. parses the nonce'd envelope (fails closed — an unparseable reply is `needs_human`,
 *      never a success);
 *   2. runs ITS OWN QC (`runHubQc`): real branch diff vs `site_dir`, real build exit code,
 *      real HTTPS probe. The agent's `self_check` is stored as advisory metadata and is
 *      never consulted;
 *   3. publishes ONLY via `publishWork`, which requires site.auto_publish AND all three
 *      hub-observed checks. On a non-auto_publish site NO deploy call is made at all and
 *      the human gets the branch to review.
 */
export async function finalizeWorkFromReply(
  input: DispatchWorkInput,
  reply: string,
  deps?: Partial<ReplyDeps>,
): Promise<void> {
  const d: ReplyDeps = {
    pushBranch: pushBranchViaSupervisor,
    runHubQc,
    publishWork,
    finalizeWork,
    markWorkVerifying,
    ...deps,
  }
  const { workId, nonce, site, projectDir, supervisorId } = input
  const parsed = parseWorkOutput(reply, nonce)
  const raw = (reply ?? '').slice(0, 20_000)

  if (!parsed.ok || !parsed.value) {
    await d.finalizeWork(workId, 'needs_human', {
      blocker: 'unparseable_reply',
      reason: `envelope:${parsed.reason ?? 'unknown'}`,
      raw_reply: raw,
    })
    return
  }

  const v = parsed.value
  if (v.status === 'needs_human') {
    await d.finalizeWork(workId, 'needs_human', {
      summary: v.summary,
      blocker: v.blocker ?? 'agent_stopped',
      qc: v.self_check ?? null,
      raw_reply: raw,
    })
    return
  }

  // The agent claims a pushed branch. We trust NOTHING about it except its name — and we
  // only accept the branch WE named (a reply naming someone else's branch is rejected).
  if (v.branch !== input.branch) {
    await d.finalizeWork(workId, 'needs_human', {
      summary: v.summary,
      blocker: 'branch_mismatch',
      reason: `expected ${input.branch}, agent reported ${v.branch ?? 'none'}`,
      qc: v.self_check ?? null,
      raw_reply: raw,
    })
    return
  }

  await d.markWorkVerifying(workId, {
    branch: input.branch,
    summary: v.summary,
    commit_shas: v.commit_shas,
    raw_reply: raw,
  })

  if (!supervisorId) {
    await d.finalizeWork(workId, 'needs_human', {
      blocker: 'supervisor_offline',
      reason: 'hub QC needs the supervisor host to read the branch diff + run the build',
      qc: v.self_check ?? null,
    })
    return
  }

  // ── HUB PUSHES THE BRANCH (option (a) — the agent has no push credential) ────
  const pushed = await d.pushBranch({ supervisorId, userId: input.userId, projectDir, branch: input.branch })
  if (!pushed.ok || !pushed.head_sha) {
    await d.finalizeWork(workId, 'needs_human', {
      summary: v.summary,
      blocker: 'branch_push_failed',
      reason: pushed.error ?? 'push_failed',
      qc: v.self_check ?? null,
    })
    return
  }

  // ── HUB-OBSERVED QC ────────────────────────────────────────────────────────
  const hubQc = await d.runHubQc({
    supervisorId,
    userId: input.userId,
    projectDir,
    branch: input.branch,
    defaultBranch: site.default_branch ?? 'main',
    siteDir: site.site_dir,
    buildCmd: site.build_cmd,
    verifyUrl: site.verify_url,
    previewVerifyUrl: site.preview_verify_url,
  })

  if (!hubQc.ok) {
    const strayed = hubQc.failure === 'diff_out_of_scope'
    await d.finalizeWork(workId, strayed ? 'needs_human' : 'qc_failed', {
      summary: v.summary,
      files_changed: hubQc.diff_scope.files,
      qc: v.self_check ?? null,
      hub_qc: hubQc,
      blocker: strayed ? 'diff_out_of_scope' : null,
      reason: hubQc.failure ?? 'qc_failed',
      deploy_status: 'not_published',
      published: false,
    })
    return
  }

  // ── HUB PUBLISH DECISION (the agent has no vote) ───────────────────────────
  // The publish pins hubQc.diff_scope.head_sha — the EXACT SHA QC verified — and aborts if
  // origin/<branch> has moved since (TOCTOU guard, P0 #1).
  const pub = await d.publishWork({
    supervisorId,
    userId: input.userId,
    projectDir,
    branch: input.branch,
    site,
    qc: hubQc,
  })

  await d.finalizeWork(workId, 'completed', {
    summary: v.summary,
    files_changed: hubQc.diff_scope.files,
    commit_shas: v.commit_shas,
    qc: v.self_check ?? null,
    hub_qc: hubQc,
    deploy_status: pub.deploy_status,
    published: pub.published,
    live_url: pub.live_url,
    preview_url: site.preview_verify_url,
    reason: pub.error ?? null,
    blocker: pub.deploy_status === 'live_probe_failed' ? 'live_probe_failed' : null,
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
      await finalizeWorkFromReply(input, replyContent)
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
