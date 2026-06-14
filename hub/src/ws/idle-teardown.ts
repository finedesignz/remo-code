/**
 * Bug B (2026-05-28) — kill the agent's runner when the UI walks away.
 *
 * Tracks the live subscriber count per session_id across every connected web
 * client. When the count drops to 0 we start a grace timer (config:
 * `REMO_SESSION_IDLE_GRACE_SECONDS`, default 300s); if no new subscriber
 * arrives in that window we send `{type:'shutdown', reason:'idle_no_subscribers'}`
 * to the session's owning agent channel. The SessionBridge handles `shutdown`
 * by calling `stopGracefully()` on the runner (SIGINT → SIGKILL after 3s).
 *
 * Counts are derived from `subscribeClient` calls so the bookkeeping piggybacks
 * on the existing per-connection subscription set replacement. Callers must:
 *   - call `recomputeSubscriberCount(sessionId)` whenever a connection's
 *     subscription set changes OR when a connection closes (set-empty);
 *   - pass the user id of the connection so we never tear down a session for
 *     the wrong user (defense in depth — the channel is keyed by session_id
 *     so cross-user leakage is impossible today, but this stays robust under
 *     future ws-multiplexing changes).
 */
import { getChannel } from './registry.ts'
import { config } from '../config.ts'
import { hasPendingPrompt } from './pending-prompts.ts'

interface PendingTeardown {
  sessionId: string
  timer: ReturnType<typeof setTimeout>
  scheduledAt: number
}

/** session_id -> { count of distinct client connections subscribed }. */
const subscriberCounts = new Map<string, number>()
/** session_id -> pending teardown timer when count is 0. */
const pendingTeardowns = new Map<string, PendingTeardown>()

/**
 * orchestrator-autolaunch: session ids known to be the user's orchestrator.
 * The orchestrator is the always-available Telegram brain and is NOT a WS
 * subscriber — exempting it from idle-no-subscribers teardown prevents an
 * auto-launch ↔ teardown respawn churn. Populated by `launchOrchestrator`
 * (and orphan-resume relaunch) when an orchestrator session is launched, and
 * checked synchronously here so the hot teardown path stays free of DB I/O.
 */
const orchestratorSessionIds = new Set<string>()
export function markOrchestratorSession(sessionId: string) {
  orchestratorSessionIds.add(sessionId)
}
export function unmarkOrchestratorSession(sessionId: string) {
  orchestratorSessionIds.delete(sessionId)
}
export function isOrchestratorSession(sessionId: string): boolean {
  return orchestratorSessionIds.has(sessionId)
}

/**
 * Read-only accessors for tests + monitoring.
 */
export function getSubscriberCount(sessionId: string): number {
  return subscriberCounts.get(sessionId) ?? 0
}
export function isTeardownScheduled(sessionId: string): boolean {
  return pendingTeardowns.has(sessionId)
}
/** Visible for tests — wipe in-memory state. */
export function _resetIdleTeardownStateForTests() {
  for (const { timer } of pendingTeardowns.values()) clearTimeout(timer)
  pendingTeardowns.clear()
  subscriberCounts.clear()
}

/**
 * Re-derive the subscriber count for a single session from the registry's
 * client set. `currentCount` is supplied by the caller (the client.ts
 * subscribe handler iterates clients anyway) — keeping the caller authoritative
 * avoids a circular import on `registry.ts`'s private set.
 *
 *   - count > 0 → cancel any pending teardown.
 *   - count = 0 → schedule a teardown (or refresh an existing schedule).
 */
export function noteSubscriberCount(sessionId: string, count: number) {
  if (count < 0) count = 0
  subscriberCounts.set(sessionId, count)
  if (count > 0) {
    const pending = pendingTeardowns.get(sessionId)
    if (pending) {
      clearTimeout(pending.timer)
      pendingTeardowns.delete(sessionId)
    }
    return
  }
  // count === 0 — schedule teardown if not already pending.
  if (pendingTeardowns.has(sessionId)) return
  const graceMs = config.sessionIdleGraceSeconds * 1000
  if (graceMs <= 0) return // disabled
  const timer = setTimeout(() => {
    pendingTeardowns.delete(sessionId)
    // Re-check current count — a subscribe may have raced our scheduled timer.
    const current = subscriberCounts.get(sessionId) ?? 0
    if (current > 0) return
    teardownSession(sessionId)
  }, graceMs)
  // Allow the process to exit cleanly during tests / shutdown.
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  pendingTeardowns.set(sessionId, {
    sessionId,
    timer,
    scheduledAt: Date.now(),
  })
}

/**
 * Send `shutdown` to the SessionBridge for this session_id. The bridge runs
 * inside the supervisor process (per-run-id WS) and reacts by calling
 * `runner.stopGracefully()` → SIGINT then SIGKILL after 3s if still alive.
 * Best-effort: closes/replaced sockets are silently ignored.
 */
function teardownSession(sessionId: string) {
  // orchestrator-autolaunch: the orchestrator stays live while the supervisor
  // is online (always-available Telegram brain, NOT a WS subscriber). Exempt it
  // from idle-no-subscribers teardown so auto-launch + idle-teardown don't form
  // a respawn churn loop. Checked synchronously against the in-memory set.
  if (isOrchestratorSession(sessionId)) {
    console.log(`[idle-teardown] skip orchestrator session=${sessionId} (exempt)`)
    return
  }
  // Second exemption: a session BLOCKED on a pending interactive prompt
  // (permission_request / user_question) is waiting on the user — killing it
  // would drop the prompt + the in-flight turn. Telegram-driven sessions have
  // no persistent WS subscriber, so without this they'd be torn down mid-prompt.
  if (hasPendingPrompt(sessionId)) {
    console.log(`[idle-teardown] skip session=${sessionId} (pending prompt)`)
    return
  }
  const channel = getChannel(sessionId)
  if (!channel) {
    // No live agent channel for this session; nothing to stop. The next
    // supervisor session_inventory will not include it, so the UI flips
    // `active` to false naturally.
    return
  }
  try {
    channel.ws.send(JSON.stringify({
      type: 'shutdown',
      reason: 'idle_no_subscribers',
    }))
    console.log(`[idle-teardown] sent shutdown to session=${sessionId} (idle_no_subscribers)`)
  } catch (err: any) {
    console.warn(`[idle-teardown] shutdown send failed session=${sessionId}: ${err?.message}`)
  }
}

/**
 * Test-only helper — force the timer to fire synchronously. Not exported via
 * the index — imported directly by the test file.
 */
export function _forceTeardownNowForTests(sessionId: string) {
  const pending = pendingTeardowns.get(sessionId)
  if (!pending) return
  clearTimeout(pending.timer)
  pendingTeardowns.delete(sessionId)
  teardownSession(sessionId)
}
