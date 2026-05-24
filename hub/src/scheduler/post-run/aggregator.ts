/**
 * Fan-out aggregator (W2/T8.7).
 *
 * For tasks with target_kind in ('all_agents','all_supervisors'), the
 * dispatcher inserts N child runs (one per resolved target). We don't want
 * to fire post-run actions per child (notification spam). Instead, this
 * aggregator collects child outcomes for a single parent fire and fires
 * post-run actions ONCE with an aggregate status.
 *
 * Aggregate status mapping:
 *   - all children success → success
 *   - mixed                → failed (template vars include partial counts)
 *   - all failed           → failed
 *
 * Timeout: 5 minutes per bucket. After timeout we fire with whatever we
 * have. Buckets are in-memory only — restart drops pending aggregates
 * (documented limitation).
 */
import type { ScheduledTask, RunStatus } from '../../db/scheduled-tasks-dal.ts'

interface ChildResult { status: RunStatus; error: string | null }

interface Bucket {
  taskId: string
  userId: string
  expected: number
  results: ChildResult[]
  createdAt: number
  fired: boolean
}

const buckets = new Map<string, Bucket>()
const BUCKET_TIMEOUT_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 30_000

export function register(
  parentFireId: string, taskId: string, userId: string, expected: number,
): void {
  buckets.set(parentFireId, {
    taskId, userId, expected, results: [], createdAt: Date.now(), fired: false,
  })
}

export async function report(
  parentFireId: string,
  task: ScheduledTask,
  result: ChildResult,
  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
): Promise<void> {
  const b = buckets.get(parentFireId)
  if (!b || b.fired) return
  b.results.push(result)
  if (b.results.length >= b.expected) {
    await fireAggregate(parentFireId, b, task, extra)
  }
}

function aggregateStatus(results: ChildResult[]): RunStatus {
  if (results.length === 0) return 'failed'
  const successes = results.filter((r) => r.status === 'success').length
  if (successes === results.length) return 'success'
  return 'failed'
}

async function fireAggregate(
  parentFireId: string, b: Bucket, task: ScheduledTask,
  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
): Promise<void> {
  b.fired = true
  buckets.delete(parentFireId)
  const status = aggregateStatus(b.results)
  const successes = b.results.filter((r) => r.status === 'success').length
  const failures = b.results.filter((r) => r.status === 'failed').length
  try {
    const { fireWithContext } = await import('./dispatcher.ts')
    await fireWithContext({
      task,
      runId: parentFireId,
      status,
      error: failures > 0 ? `aggregate: ${failures}/${b.results.length} children failed` : null,
      cost_usd: extra.cost_usd,
      duration_ms: extra.duration_ms,
      output_snippet: extra.output_snippet,
      parentFireId: null,
      chainDepth: 0,
      aggregate: { total: b.results.length, successes, failures },
    })
  } catch (err: any) {
    console.error(`[aggregator] fire failed task=${task.id}: ${err?.message}`)
  }
}

setInterval(async () => {
  const now = Date.now()
  for (const [pid, b] of buckets) {
    if (b.fired) continue
    if (now - b.createdAt < BUCKET_TIMEOUT_MS) continue
    try {
      const { getTaskById } = await import('../../db/scheduled-tasks-dal.ts')
      const task = await getTaskById(b.taskId)
      if (!task) { buckets.delete(pid); continue }
      await fireAggregate(pid, b, task, { cost_usd: null, duration_ms: null, output_snippet: null })
    } catch (err: any) {
      console.error(`[aggregator] sweep fire failed task=${b.taskId}: ${err?.message}`)
      buckets.delete(pid)
    }
  }
}, SWEEP_INTERVAL_MS)
