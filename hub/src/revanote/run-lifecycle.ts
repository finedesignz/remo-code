/**
 * Annotation-run finalize (Phase 08; Round-2 migration).
 *
 * Round-2: the per-session run registry + queue promotion that this module used
 * to own now live in the shared dispatch pipeline (`hub/src/dispatch/`). The
 * agent ws assistant_message branch calls `dispatch.onSessionReply`, which fires
 * the revanote adapter's `RunStore.onFinalize` hook — and that hook delegates to
 * `finalizeAnnotationReply` below. So this file is now JUST the finalize body
 * (envelope parse → annotation status → merge gate → outbound callback enqueue),
 * with NO session-keyed Map and NO queue-promotion logic.
 *
 * Finalize steps (unchanged from the legacy `onAgentReply`):
 *   1. Finalize the annotation_run row.
 *   2. Parse the agent envelope (`<<JSON>>…<<END>>`).
 *   3. Run the merge gate (additive — legacy single-shot annotations bypass it).
 *   4. Verify a `resolved: true` names a commit that is actually pushed
 *      (commit-verify.ts); otherwise downgrade to resolved:false.
 *   5. Persist resolved/action_taken/files_changed/agent_reply/commit_sha.
 *   6. Mark the annotation row resolved/failed.
 *   7. Enqueue the outbound revanote callback (ALWAYS carries annotation_id).
 */
import {
  updateAnnotationRun,
  updateAnnotationStatus,
  getAnnotationById,
} from '../db/revanote-dal.ts'
import { broadcastRevanoteEvent } from '../ws/registry.ts'
import { parseRevanoteOutput } from './result-schema.ts'
import {
  isPushVerificationRequired,
  loadVerifyContext,
  realGithubGet,
  verifyPushedCommit,
  type VerifyResult,
} from './commit-verify.ts'

export interface FinalizeArgs {
  sessionId: string
  runId: string
  annotationId: string
  userId: string
  /** epoch ms when the run was opened (for duration_ms). */
  startedAt: number
  /** the agent's assistant_message text. */
  content: string
}

/**
 * Verification seam for `resolved: true` (fix/revanote-verify-pushed). Tests
 * swap it; the default checks the named commit on GitHub via the App.
 */
export type ResolveVerifier = (args: {
  userId: string
  sessionId: string
  repoSlug: string | null
  commitSha: string | null
  branch: string | null
  /** When this dispatch was sent: the commit must not predate it (commit_predates_dispatch). */
  dispatchedAt: Date | null
}) => Promise<VerifyResult>

const defaultVerifier: ResolveVerifier = async (args) => {
  // No sha ⇒ nothing to look up; report the precise reason without a DB/API trip.
  if (!(args.commitSha ?? '').trim()) return { ok: false, reason: 'commit_sha_missing' }
  const ctx = await loadVerifyContext({
    userId: args.userId,
    sessionId: args.sessionId,
    repoSlugFallback: args.repoSlug,
  })
  return verifyPushedCommit(
    {
      owner: ctx.owner, repo: ctx.repo, commitSha: args.commitSha, branch: args.branch,
      installationIds: ctx.installationIds, dispatchedAt: args.dispatchedAt,
    },
    realGithubGet,
  )
}

/**
 * Finalize an in-flight annotation run from the agent's reply. Invoked by the
 * revanote adapter's `RunStore.onFinalize` hook (wired into the shared
 * dispatch pipeline). Mirrors the legacy `onAgentReply` body verbatim minus the
 * session-registry lookup + queue promotion (the pipeline does those now).
 */
export async function finalizeAnnotationReply(
  args: FinalizeArgs,
  deps: { verify?: ResolveVerifier } = {},
): Promise<void> {
  const { runId, annotationId, userId, startedAt, content } = args

  const duration = Date.now() - startedAt
  const parsedRaw = parseRevanoteOutput(content)
  // Generation binding, defence in depth behind the RunStore.shouldFinalize
  // hooks: a reply that echoes a DIFFERENT dispatch's id (reachable through the
  // pipeline's terminal-timeout path, which finalizes regardless of
  // shouldFinalize) is never applied to this run -- it finalizes as an honest
  // failure instead of adopting another generation's verdict.
  const foreign = parsedRaw.ok && parsedRaw.value.dispatch_id !== runId
  if (foreign) {
    console.warn(
      `[revanote.lifecycle] dispatch_id mismatch run=${runId} annotation=${annotationId} ` +
        `echoed=${(parsedRaw as any).value.dispatch_id}; reply dropped`,
    )
  }
  const parsed: typeof parsedRaw = foreign
    ? {
        ok: false,
        reason: 'envelope_missing',
        detail: 'dispatch_id_mismatch',
        value: { resolved: false, action_taken: 'dispatch_id_mismatch', agent_reply: '', files_changed: [] },
        preface: parsedRaw.preface,
      }
    : parsedRaw
  const result = parsed.value
  const snippet = content.length > 500 ? content.slice(content.length - 500) : content
  const ann = await getAnnotationById(annotationId, userId).catch((err: any) => {
    console.warn(`[revanote.lifecycle] annotation load failed: ${err?.message ?? err}`)
    return null
  })
  const raw = (ann?.payload_raw ?? {}) as Record<string, any>

  let basePayload: import('./callback.ts').RevanoteCallbackPayload | null = ann
    ? {
        annotation_id: ann.annotation_id_external,
        resolved: result.resolved,
        action_taken: result.action_taken || null,
        agent_reply: result.agent_reply ?? parsed.preface ?? null,
        files_changed: result.files_changed ?? [],
        deployed: result.deployed === true,
        needs_clarification: result.needs_clarification === true,
        clarification_question: result.clarification_question ?? null,
        assumption: result.assumption ?? null,
        clarification_reason: result.clarification_reason ?? null,
        error: parsed.ok ? null : `parse_${parsed.reason}`,
      }
    : null

  // Phase 6: run the merge gate if the inbound payload carried sandbox fields.
  // Gate is additive — legacy single-shot annotations without batch/repo
  // metadata bypass the gate entirely. It runs BEFORE the pushed-commit check
  // because the sandbox path pushes the branch inside the gate.
  if (ann && basePayload) {
    try {
      const batchId: string | null = typeof raw.batch_id === 'string' ? raw.batch_id : null
      const batchSize: number | null = typeof raw.batch_size === 'number' ? raw.batch_size : null
      const repoSlug: string | null = typeof raw.repo_slug === 'string' ? raw.repo_slug : null
      const repoKind: 'github' | 'local_path' | null =
        raw.repo_kind === 'github' || raw.repo_kind === 'local_path' ? raw.repo_kind : null
      // sandbox_dir is set by the dispatcher when it preps the sandbox.
      // Until that wiring lands we tolerate its absence; gate uses repo_slug-derived
      // path as a best-effort, otherwise skip.
      const sandboxDir: string | null = typeof raw.sandbox_dir === 'string' ? raw.sandbox_dir : null

      if (repoSlug && repoKind && sandboxDir) {
        const { runMergeGate, applyGateToCallback, defaultMergeOps } = await import('./merge-gate.ts')
        const installationId: number | undefined = typeof raw.installation_id === 'number' ? raw.installation_id : undefined
        // Risk classification is heuristic-only. The LLM escalator (which used a
        // raw ANTHROPIC_API_KEY Messages call) was removed — this app runs purely
        // on the Claude subscription and never holds an Anthropic API key.
        const outcome = await runMergeGate({
          batchId, batchSize, annotationId: ann.id,
          sandboxDir, repoSlug, repoKind,
          needsClarification: result.needs_clarification === true,
          resolved: result.resolved,
          mergeOps: defaultMergeOps({ installationId }),
          annotationUrl: ann.annotation_url ?? null,
          notifyEmail: typeof raw.org_notify_email === 'string' ? raw.org_notify_email : null,
        })
        basePayload = applyGateToCallback(basePayload, outcome, batchId)
      }
    } catch (gateErr: any) {
      console.warn(`[revanote.lifecycle] merge gate failed (non-fatal): ${gateErr?.message ?? gateErr}`)
    }
  }

  // fix/revanote-verify-pushed — a resolve stands only on a commit the hub can
  // see on the remote. Self-report is advisory; a missing/unpushed commit (or a
  // failed check) downgrades the reply to resolved:false, fail-closed.
  let resolved = basePayload ? basePayload.resolved : result.resolved
  let verifiedSha: string | null = null
  let rejectReason: string | null = null
  if (resolved && isPushVerificationRequired()) {
    let v: VerifyResult
    try {
      v = await (deps.verify ?? defaultVerifier)({
        userId,
        sessionId: args.sessionId,
        repoSlug: typeof raw.repo_slug === 'string' ? raw.repo_slug : null,
        commitSha: result.commit_sha ?? null,
        branch: result.branch ?? null,
        dispatchedAt: ann?.dispatched_at ? new Date(ann.dispatched_at) : new Date(startedAt),
      })
    } catch (err: any) {
      v = { ok: false, reason: 'verify_error', detail: err?.message ?? String(err) }
    }
    if (v.ok) {
      verifiedSha = v.sha
    } else {
      resolved = false
      rejectReason = `unverified_resolve:${v.reason}`
      console.warn(
        `[revanote.lifecycle] rejected resolve annotation=${annotationId} run=${runId} ` +
          `reason=${v.reason}${v.detail ? ` detail=${v.detail}` : ''}`,
      )
    }
  }
  if (basePayload) {
    basePayload.resolved = resolved
    basePayload.commit_sha = verifiedSha
    if (rejectReason) {
      basePayload.deployed = false
      basePayload.error = rejectReason
    }
  }

  // Annotation FIRST, as a CAS on this run's generation (status still
  // 'dispatched' AND current_run_id = this run). A retry that reset + re-claimed
  // the row owns a newer generation; this superseded finalize then loses and
  // writes nothing else (no run success, no broadcast, no callback) -- it can
  // never overwrite the newer dispatch's row.
  const annStatus = resolved ? 'resolved' : 'failed'
  const won = await updateAnnotationStatus(annotationId, annStatus, {
    resolved_at: resolved ? new Date() : null,
    skip_reason: resolved ? null : (rejectReason ?? (result.action_taken || (parsed.ok ? null : parsed.reason) || 'agent_unresolved')),
    if_run_id: runId,
  })
  if (!won) {
    console.warn(
      `[revanote.lifecycle] superseded finalize dropped run=${runId} annotation=${annotationId} ` +
        `(row no longer 'dispatched' under this generation)`,
    )
    await updateAnnotationRun(runId, { status: 'cancelled', finished_at: new Date() })
    return
  }

  await updateAnnotationRun(runId, {
    status: 'success',
    finished_at: new Date(),
    resolved,
    action_taken: result.action_taken || null,
    agent_reply: result.agent_reply ?? parsed.preface ?? null,
    files_changed: result.files_changed,
    deployed: rejectReason ? false : result.deployed === true,
    duration_ms: duration,
    output_snippet: snippet,
    cost_usd: null,
    commit_sha: verifiedSha,
    ...(rejectReason ? { error: rejectReason } : {}),
  })

  broadcastRevanoteEvent(userId, {
    type: 'revanote_resolved',
    annotation_id: annotationId,
    run_id: runId,
    resolved,
    action_taken: result.action_taken ?? null,
    files_changed: result.files_changed ?? [],
    deployed: rejectReason ? false : result.deployed === true,
    commit_sha: verifiedSha,
    ...(rejectReason ? { error: rejectReason } : {}),
    finished_at: new Date().toISOString(),
  })

  // Queue the outbound callback (ALWAYS carries annotation_id — revanote invariant).
  if (ann && basePayload) {
    try {
      const { scheduleImmediateCallback } = await import('./callback.ts')
      await scheduleImmediateCallback(ann, basePayload)
    } catch (err: any) {
      console.warn(`[revanote.lifecycle] callback enqueue failed: ${err?.message ?? err}`)
    }
  }
}
