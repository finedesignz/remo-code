/**
 * Revanote batch coalescer (feat/revanote-batch-dispatch).
 *
 * Sequential per-annotation dispatch (`dispatcher.ts` `dispatchAnnotationRow`)
 * cannot produce "all comments of one Revanote run fixed in ONE PR": the shared
 * pipeline (`hub/src/dispatch/pipeline.ts` `onSessionReply`) only releases the
 * next queued token once the CURRENT one finalizes
 * (`finalizeAnnotationReply` in `run-lifecycle.ts`), so N comments dispatched
 * one at a time become N separate agent turns / branches / PRs.
 *
 * DECISION LOCKED: coalescing is keyed ONLY on `payload_raw.batch_id` (present
 * on 3/88 sampled prod annotations at design time; where present it correctly
 * grouped a burst). No other grouping key (page_url, received_at proximity,
 * etc.) is invented here — a burst without `batch_id` stays on the single-
 * annotation path unchanged (`dispatcher.ts`'s existing behaviour).
 *
 * Design:
 *   - `dispatcher.ts` short-circuits a batch-carrying annotation BEFORE
 *     building a prompt or calling `dispatch()` — it stays `status='pending'`.
 *   - This module's `sweepBatchDispatch` is a boot-started poll loop
 *     (`startBatchSweep`, default every `REMO_REVANOTE_BATCH_POLL_MS`) that is
 *     FULLY DB-STATE-DRIVEN: every tick re-reads `annotations` for pending,
 *     `batch_id`-carrying rows, groups them by (user_id, batch_id, resolved
 *     target session), and dispatches a group once no NEW arrival has landed
 *     for `REMO_REVANOTE_BATCH_DEBOUNCE_MS` (measured from the group's latest
 *     `received_at`). No per-batch timer state and no buffering of annotation
 *     CONTENT in memory — a hub restart loses nothing: the next tick re-derives
 *     the same due-set straight from the DB.
 *   - A dispatched batch sends ONE prompt (`prompt.ts`
 *     `renderBatchAnnotationPrompt`) covering every member, through the SAME
 *     shared dispatch pipeline + gate list as a single annotation, under ONE
 *     `token` (the batch_id). `inFlightBatches` is the only in-memory state —
 *     small per-in-flight-turn bookkeeping (member annotation/run ids), not an
 *     annotation-content buffer, and lost on restart exactly like the
 *     pipeline's own `activeBySession` hook (no dispatch path survives a hub
 *     restart mid-turn today).
 *   - Finalize re-uses `run-lifecycle.ts` `finalizeAnnotationReply` UNCHANGED,
 *     once per member, by rebuilding a single-annotation envelope string per
 *     item (`result-schema.ts` `envelopeForBatchItem`) — same commit-verify
 *     gate, same DB writes, same callback shape as the non-batched path, for
 *     every member.
 *   - Late arrivals sharing a batch_id AFTER a group has already dispatched
 *     form a NEW group next tick (they're still `pending`, and the dispatched
 *     members are no longer `pending`) — a fresh dispatch, never appended to
 *     an in-flight turn.
 */
import { sql } from '../db/postgres.ts'
import {
  type AnnotationRow,
  type RevanoteMapping,
  updateAnnotationStatus,
  insertAnnotationRun,
} from '../db/revanote-dal.ts'
import { getChannel, broadcastRevanoteEvent, broadcastToSubscribers } from '../ws/registry.ts'
import { insertMessage } from '../db/dal.ts'
import { renderBatchAnnotationPrompt } from './prompt.ts'
import { parseRevanoteBatchOutput, envelopeForBatchItem, ENVELOPE_RE } from './result-schema.ts'
import { finalizeAnnotationReply } from './run-lifecycle.ts'
import { dispatch, type DispatchRequest, type PipelineDeps, type RunStore } from '../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts'
import { ensureSessionOnline } from '../dispatch/spawn-on-error.ts'
import {
  resolveMappingAndSession,
  revanoteBudgetGate,
  getUserTimezone,
  enqueueRejectionCallback,
} from './dispatcher.ts'

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Debounce window from the LATEST arrival of a given batch_id. Default 30s. */
export function batchDebounceMs(): number {
  return positiveIntEnv('REMO_REVANOTE_BATCH_DEBOUNCE_MS', 30_000)
}

/** Sweep cadence. Default 5s (well under the debounce window). */
export function batchPollMs(): number {
  return positiveIntEnv('REMO_REVANOTE_BATCH_POLL_MS', 5_000)
}

/**
 * Separate ceiling for a batch turn's finalize hook (both the narration
 * timeout AND the silent-hook reap ceiling — see `pipeline.ts`
 * `finalizeTimeoutMs`/`hookMaxMs`). A batch turn does N comments' worth of
 * branch/PR/CI/merge/redeploy work in one turn, so it legitimately runs far
 * longer than a single annotation's default 20min `REVANOTE_FINALIZE_TIMEOUT_MS`.
 * Default 2h.
 */
export function batchRunMaxMs(): number {
  return positiveIntEnv('REMO_REVANOTE_BATCH_RUN_MAX_MS', 7_200_000)
}

function batchIdOf(ann: AnnotationRow): string | null {
  const v = (ann.payload_raw as any)?.batch_id
  return typeof v === 'string' ? v : null
}

interface BatchMember {
  annotationId: string
  externalId: string
  runId: string
  startedAt: number
}

interface InFlightBatch {
  userId: string
  sessionId: string
  members: BatchMember[]
}

/**
 * token (batch_id) -> in-flight bookkeeping. Small, per-in-flight-turn ids
 * only (never annotation content) — see module doc comment.
 */
const inFlightBatches = new Map<string, InFlightBatch>()

let sweeping = false

/**
 * Boot-started poll loop entry point. Fully DB-state-driven — see module doc
 * comment. Re-entrancy-guarded so an overlapping tick (a slow prior sweep) is
 * a no-op rather than a duplicate dispatch.
 */
export async function sweepBatchDispatch(now: number = Date.now()): Promise<{ dispatched: number }> {
  if (sweeping) return { dispatched: 0 }
  sweeping = true
  try {
    return await runSweepOnce(now)
  } finally {
    sweeping = false
  }
}

async function runSweepOnce(now: number): Promise<{ dispatched: number }> {
  const rows = await sql<AnnotationRow[]>`
    SELECT * FROM annotations
     WHERE status = 'pending'
       AND payload_raw ? 'batch_id'
     ORDER BY received_at ASC
  `
  if (rows.length === 0) return { dispatched: 0 }

  // Group by (user_id, batch_id).
  const groups = new Map<string, AnnotationRow[]>()
  for (const r of rows) {
    const bid = batchIdOf(r)
    if (!bid) continue
    const key = `${r.user_id}\0${bid}`
    const list = groups.get(key) ?? []
    list.push(r)
    groups.set(key, list)
  }

  const debounce = batchDebounceMs()
  let dispatched = 0

  for (const [key, members] of groups) {
    const userId = key.split('\0')[0]

    // Resolve mapping+session per member. A member that can't resolve a
    // target fails immediately (mirrors the single-dispatch no_target path)
    // and is excluded — a stuck unmappable annotation must never hold the
    // rest of the batch hostage.
    const resolved: Array<{ ann: AnnotationRow; mapping: RevanoteMapping | null; sessionId: string }> = []
    for (const ann of members) {
      const { mapping, sessionId } = await resolveMappingAndSession(userId, ann)
      if (!sessionId) {
        const reason = mapping ? 'session_not_found_for_repo' : 'no_mapping_for_host'
        await updateAnnotationStatus(ann.id, 'failed', { skip_reason: reason, mapping_id: mapping?.id ?? null })
        broadcastRevanoteEvent(userId, { type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason })
        void enqueueRejectionCallback(ann, 'no_target', reason)
        continue
      }
      resolved.push({ ann, mapping, sessionId })
    }
    if (resolved.length === 0) continue

    // Sub-group by resolved target session — "same batch_id + user + target
    // session" per spec. A batch whose members resolve to different sessions
    // (different host/repo) dispatches as separate per-session batches.
    const bySession = new Map<string, typeof resolved>()
    for (const r of resolved) {
      const list = bySession.get(r.sessionId) ?? []
      list.push(r)
      bySession.set(r.sessionId, list)
    }

    for (const [sessionId, group] of bySession) {
      const latest = Math.max(...group.map((g) => new Date(g.ann.received_at as any).getTime()))
      if (now - latest < debounce) continue // still debouncing — a newer arrival extends the window
      await dispatchBatch(userId, sessionId, group)
      dispatched++
    }
  }

  return { dispatched }
}

async function dispatchBatch(
  userId: string,
  sessionId: string,
  group: Array<{ ann: AnnotationRow; mapping: RevanoteMapping | null; sessionId: string }>,
): Promise<void> {
  const anns = group.map((g) => g.ann)
  const batchId = batchIdOf(anns[0])!
  const tz = await getUserTimezone(userId)
  const promptBody = renderBatchAnnotationPrompt({
    items: group.map((g) => ({ annotation: g.ann, mapping: g.mapping })),
  })
  const storedContent = `[revanote: batch of ${anns.length}]\n\n${promptBody}`

  const store: RunStore = {
    async open(_req) {
      const members: BatchMember[] = []
      for (const ann of anns) {
        const run = await insertAnnotationRun({ annotation_id: ann.id, user_id: userId, session_id: sessionId })
        members.push({
          annotationId: ann.id,
          externalId: ann.annotation_id_external,
          runId: run.id,
          startedAt: Date.now(),
        })
      }
      inFlightBatches.set(batchId, { userId, sessionId, members })
      return batchId
    },
    async markSkipped(token, reason) {
      const isBusy = reason === 'session_busy'
      for (const ann of anns) {
        await updateAnnotationStatus(ann.id, 'failed', { skip_reason: reason, session_id: sessionId })
        broadcastRevanoteEvent(userId, { type: 'revanote_skipped', annotation_id: ann.id, skip_reason: reason })
        void enqueueRejectionCallback(ann, isBusy ? 'session_busy' : 'budget_threshold', reason)
      }
      inFlightBatches.delete(token)
    },
    async onFinalize(token, content) {
      await finalizeBatchReply(token, content)
    },
    async markFailed(token, errMsg) {
      const batch = inFlightBatches.get(token)
      for (const m of batch?.members ?? []) {
        await updateAnnotationStatus(m.annotationId, 'failed', { skip_reason: `agent_send_failed: ${errMsg}` })
      }
      inFlightBatches.delete(token)
    },
    shouldFinalize(content) {
      return ENVELOPE_RE.test(content)
    },
  }

  const ceilingMs = batchRunMaxMs()
  const deps: PipelineDeps = {
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate, revanoteBudgetGate(userId, tz)],
    store,
    finalizeTimeoutMs: ceilingMs,
    hookMaxMs: ceilingMs,
    isOnline: (req) => getChannel(req.sessionId) != null,
    ensureOnline: (req) => ensureSessionOnline(req.userId, req.sessionId, { useSessionSkipPermissions: true }),
    replay: async () => {
      await dispatchBatch(userId, sessionId, group)
    },
    onParkExpire: async () => {
      for (const ann of anns) {
        await updateAnnotationStatus(ann.id, 'failed_offline', { skip_reason: 'target_offline_expired' })
        void enqueueRejectionCallback(ann, 'target_offline', 'target_offline_expired')
      }
    },
    send: async (req) => {
      const channel = getChannel(req.sessionId)
      if (!channel) throw new Error('session_offline')
      const msg = await insertMessage(req.sessionId, 'user', storedContent)
      broadcastToSubscribers(req.sessionId, { type: 'message', session_id: req.sessionId, message: msg })
      channel.ws.send(
        JSON.stringify({ type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at }),
      )
    },
  }

  const req: DispatchRequest = { userId, sessionId, token: batchId, prompt: promptBody }
  const outcome = await dispatch(req, deps)

  switch (outcome.kind) {
    case 'dispatched':
      for (const ann of anns) {
        await updateAnnotationStatus(ann.id, 'dispatched', { session_id: sessionId, dispatched_at: new Date() })
        broadcastRevanoteEvent(userId, {
          type: 'revanote_dispatched',
          annotation_id: ann.id,
          run_id: outcome.runId,
          session_id: sessionId,
          dispatched_at: new Date().toISOString(),
        })
      }
      return
    case 'parked_offline':
      for (const ann of anns) {
        await updateAnnotationStatus(ann.id, 'pending', { skip_reason: 'session_offline', session_id: sessionId })
        broadcastRevanoteEvent(userId, {
          type: 'revanote_skipped', annotation_id: ann.id, skip_reason: 'session_offline',
        })
      }
      return
    // 'queued' / 'dropped_busy' / 'skipped' / 'failed' are already fully
    // handled by the pipeline calling store.markSkipped/markFailed above.
    default:
      return
  }
}

/**
 * Finalize a batch turn's reply. Parses the `annotations[]` envelope and
 * re-runs the UNCHANGED single-annotation finalize (`finalizeAnnotationReply`)
 * once per member, by rebuilding a single-item envelope string per annotation.
 * An unparseable batch reply falls every member back through that same
 * function's own single-item parse fallback (`schema_invalid`/
 * `envelope_missing`) by handing it the raw batch content directly.
 */
async function finalizeBatchReply(token: string, content: string): Promise<void> {
  const batch = inFlightBatches.get(token)
  inFlightBatches.delete(token)
  if (!batch) return
  const { userId, sessionId, members } = batch

  const parsed = parseRevanoteBatchOutput(content)
  if (!parsed.ok) {
    await Promise.all(
      members.map((m) =>
        finalizeAnnotationReply({
          sessionId,
          runId: m.runId,
          annotationId: m.annotationId,
          userId,
          startedAt: m.startedAt,
          content,
        }),
      ),
    )
    return
  }

  const byExternalId = new Map(parsed.value.annotations.map((a) => [a.annotation_id, a]))
  await Promise.all(
    members.map((m) => {
      const item = byExternalId.get(m.externalId)
      const envelope = envelopeForBatchItem(
        item ?? { resolved: false, action_taken: 'missing_from_reply', files_changed: [] },
      )
      return finalizeAnnotationReply({
        sessionId,
        runId: m.runId,
        annotationId: m.annotationId,
        userId,
        startedAt: m.startedAt,
        content: envelope,
      })
    }),
  )
}

let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Boot-started sweep (idempotent), mirrors the other reapers in this codebase. */
export function startBatchSweep(intervalMs: number = batchPollMs()): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    void sweepBatchDispatch().catch((err: any) =>
      console.error(`[revanote.batch] sweep failed: ${err?.message ?? err}`),
    )
  }, intervalMs)
  sweepTimer.unref?.()
}

export function stopBatchSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}

/** Test-only reset. */
export function _resetBatchDispatchState(): void {
  inFlightBatches.clear()
}
