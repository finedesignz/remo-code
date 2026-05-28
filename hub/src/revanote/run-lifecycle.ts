/**
 * Annotation-run lifecycle (Phase 08).
 *
 * Mirrors `error-capture/run-lifecycle.ts`. When the dispatcher ships a
 * prompt to a Claude session it registers `(sessionId → run_id, annotation_id)`
 * here. The agent ws assistant_message handler calls `onAgentReply` to:
 *   1. Finalize the annotation_run row.
 *   2. Parse the agent envelope (`<<JSON>>…<<END>>`).
 *   3. Persist resolved/action_taken/files_changed/agent_reply.
 *   4. Mark the annotation row resolved/failed.
 *   5. Enqueue the outbound revanote callback.
 *   6. Promote any session-queue waiter.
 */
import {
  updateAnnotationRun,
  updateAnnotationStatus,
  getAnnotationById,
} from '../db/revanote-dal.ts'
import { broadcastRevanoteEvent } from '../ws/registry.ts'
import * as queue from '../scheduler/session-queue.ts'
import { parseRevanoteOutput } from './result-schema.ts'

interface Active {
  runId: string
  annotationId: string
  userId: string
  callbackUrl: string
  startedAt: number
}

const bySession = new Map<string, Active>()

export function registerAnnotationRunForSession(
  sessionId: string,
  runId: string,
  annotationId: string,
  userId: string,
  callbackUrl: string,
): void {
  bySession.set(sessionId, {
    runId, annotationId, userId, callbackUrl, startedAt: Date.now(),
  })
}

export function annotationRunActiveForSession(sessionId: string): boolean {
  return bySession.has(sessionId)
}

export function getActiveAnnotationRun(sessionId: string): Active | undefined {
  return bySession.get(sessionId)
}

export async function onAgentReply(sessionId: string, content: string): Promise<void> {
  const active = bySession.get(sessionId)
  if (!active) return
  bySession.delete(sessionId)

  const duration = Date.now() - active.startedAt
  const parsed = parseRevanoteOutput(content)
  const result = parsed.value
  const snippet = content.length > 500 ? content.slice(content.length - 500) : content

  await updateAnnotationRun(active.runId, {
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
  await updateAnnotationStatus(active.annotationId, annStatus, {
    resolved_at: result.resolved ? new Date() : null,
    skip_reason: result.resolved ? null : (result.action_taken || parsed.reason || 'agent_unresolved'),
  })

  broadcastRevanoteEvent(active.userId, {
    type: 'revanote_resolved',
    annotation_id: active.annotationId,
    run_id: active.runId,
    resolved: result.resolved,
    action_taken: result.action_taken ?? null,
    files_changed: result.files_changed ?? [],
    deployed: result.deployed === true,
    finished_at: new Date().toISOString(),
  })

  // Queue the outbound callback.
  try {
    const ann = await getAnnotationById(active.annotationId, active.userId)
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
          const { createLlmEscalator } = await import('./llm-escalator.ts')
          const installationId: number | undefined = typeof raw.installation_id === 'number' ? raw.installation_id : undefined
          const outcome = await runMergeGate({
            batchId, batchSize, annotationId: ann.id,
            sandboxDir, repoSlug, repoKind,
            needsClarification: result.needs_clarification === true,
            resolved: result.resolved,
            mergeOps: defaultMergeOps({ installationId }),
            llm: createLlmEscalator(),
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

  // Promote any waiter.
  const promoted = queue.markFinished(sessionId)
  if (promoted) {
    void import('./dispatcher.ts').then((m) =>
      m.dispatchPendingAnnotation(promoted).catch((err) =>
        console.error(`[revanote.lifecycle] promote dispatch failed run=${promoted}: ${err?.message ?? err}`),
      ),
    )
  }
}

export async function onAgentError(sessionId: string, errorMsg: string): Promise<void> {
  const active = bySession.get(sessionId)
  if (!active) return
  bySession.delete(sessionId)

  const duration = Date.now() - active.startedAt
  await updateAnnotationRun(active.runId, {
    status: 'failed', error: errorMsg, finished_at: new Date(), duration_ms: duration,
  })
  await updateAnnotationStatus(active.annotationId, 'failed', { skip_reason: errorMsg })

  broadcastRevanoteEvent(active.userId, {
    type: 'revanote_resolved',
    annotation_id: active.annotationId,
    run_id: active.runId,
    resolved: false,
    action_taken: 'agent_error',
    files_changed: [],
    deployed: false,
    finished_at: new Date().toISOString(),
  })

  try {
    const ann = await getAnnotationById(active.annotationId, active.userId)
    if (ann) {
      const { scheduleImmediateCallback } = await import('./callback.ts')
      await scheduleImmediateCallback(ann, {
        annotation_id: ann.annotation_id_external,
        resolved: false,
        action_taken: 'agent_error',
        agent_reply: null,
        files_changed: [],
        deployed: false,
        error: errorMsg,
      })
    }
  } catch {}

  const promoted = queue.markFinished(sessionId)
  if (promoted) {
    void import('./dispatcher.ts').then((m) =>
      m.dispatchPendingAnnotation(promoted).catch(() => {}),
    )
  }
}

// Test helper.
export function _reset(): void { bySession.clear() }
