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
 *   3. Persist resolved/action_taken/files_changed/agent_reply.
 *   4. Mark the annotation row resolved/failed.
 *   5. Run the merge gate (additive — legacy single-shot annotations bypass it).
 *   6. Enqueue the outbound revanote callback (ALWAYS carries annotation_id).
 */
import {
  updateAnnotationRun,
  updateAnnotationStatus,
  getAnnotationById,
} from '../db/revanote-dal.ts'
import { broadcastRevanoteEvent } from '../ws/registry.ts'
import { parseRevanoteOutput } from './result-schema.ts'

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
 * Finalize an in-flight annotation run from the agent's reply. Invoked by the
 * revanote adapter's `RunStore.onFinalize` hook (wired into the shared
 * dispatch pipeline). Mirrors the legacy `onAgentReply` body verbatim minus the
 * session-registry lookup + queue promotion (the pipeline does those now).
 */
export async function finalizeAnnotationReply(args: FinalizeArgs): Promise<void> {
  const { runId, annotationId, userId, startedAt, content } = args

  const duration = Date.now() - startedAt
  const parsed = parseRevanoteOutput(content)
  const result = parsed.value
  const snippet = content.length > 500 ? content.slice(content.length - 500) : content

  await updateAnnotationRun(runId, {
    status: 'success',
    finished_at: new Date(),
    resolved: result.resolved,
    action_taken: result.action_taken || null,
    agent_reply: result.agent_reply ?? parsed.preface ?? null,
    files_changed: result.files_changed,
    deployed: result.deployed === true,
    duration_ms: duration,
    output_snippet: snippet,
    cost_usd: null,
  })

  const annStatus = result.resolved ? 'resolved' : 'failed'
  await updateAnnotationStatus(annotationId, annStatus, {
    resolved_at: result.resolved ? new Date() : null,
    skip_reason: result.resolved ? null : (result.action_taken || parsed.reason || 'agent_unresolved'),
  })

  broadcastRevanoteEvent(userId, {
    type: 'revanote_resolved',
    annotation_id: annotationId,
    run_id: runId,
    resolved: result.resolved,
    action_taken: result.action_taken ?? null,
    files_changed: result.files_changed ?? [],
    deployed: result.deployed === true,
    finished_at: new Date().toISOString(),
  })

  // Queue the outbound callback (ALWAYS carries annotation_id — revanote invariant).
  try {
    const ann = await getAnnotationById(annotationId, userId)
    if (ann) {
      const { scheduleImmediateCallback } = await import('./callback.ts')
      let basePayload: import('./callback.ts').RevanoteCallbackPayload = {
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

      // Phase 6: run the merge gate if the inbound payload carried sandbox fields.
      // Gate is additive — legacy single-shot annotations without batch/repo
      // metadata bypass the gate entirely.
      try {
        const raw = (ann.payload_raw ?? {}) as Record<string, any>
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

      await scheduleImmediateCallback(ann, basePayload)
    }
  } catch (err: any) {
    console.warn(`[revanote.lifecycle] callback enqueue failed: ${err?.message ?? err}`)
  }
}
