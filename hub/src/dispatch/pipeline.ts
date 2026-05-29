/**
 * Session-dispatch pipeline — the deep module (Phase 1, C1).
 *
 * One call ships a prompt to a session through every gate + the per-session
 * queue + the offline-grace buffer, sends the `user_message` on the agent
 * socket on dispatch, and registers the finalize hook. The caller supplies
 * adapters for the parts that legitimately vary (gates, run-row persistence,
 * the offline replay thunk, the agent-socket send); everything else — gate
 * ordering, queue claim, offline park, finalize-and-promote, re-dispatch — lives
 * behind this seam.
 *
 * Public interface (depth check — small interface, large behaviour):
 *   - dispatch(req, deps)            → DispatchOutcome
 *   - onSessionReply(sessionId, text) → finalize active hook, promote, re-dispatch
 *
 * Invariants (from the plan risk register):
 *   IR-1  Cost-cap non-bypassable: a cost-capped user returns
 *         {kind:'skipped'} and the send fn is NEVER called.
 *   IR-2  Gate ordering: gates run in array order, first block wins; the
 *         promotion path RE-RUNS the gate list before re-dispatch, so a user
 *         who crossed the cap while queued gets skipped.
 *   IR-7  The finalize hook fires only via onSessionReply (wired to the agent
 *         assistant_message branch), never on thinking/text_delta.
 *
 * NOTE (deviation from the PLAN.md interface sketch): `PipelineDeps` carries an
 * explicit `send(req)` adapter. The plan prose says dispatch "sends the
 * user_message on the agent socket on dispatch" but the sketched `PipelineDeps`
 * omitted the send fn. Resolving the agent socket + building the wire frame +
 * persisting the chat message is subsystem-specific (scheduler persists a
 * `messages` row with run_id; telegram does not), so it is an adapter, not
 * baked into the module. This keeps the seam honest.
 */
import { getGraceBuffer } from './grace.ts'
import { SessionQueue } from './session-queue.ts'

export interface DispatchRequest {
  userId: string
  sessionId: string
  /** stable id used as the queue token + finalize key (runId, errorId, 'tg:<chat>:<update>') */
  token: string
  prompt: string
  images?: Array<{ media_type: string; data: string }>
  attachments?: Array<{ filename: string; content: string }>
}

/** Pluggable pre-send gates, evaluated in order. First block wins. */
export interface DispatchGate {
  name: string
  check(req: DispatchRequest): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** Subsystem persistence + finalize behaviour. Null store = telegram (no run row). */
export interface RunStore {
  /** persist a run row, return its id (or null to use req.token) */
  open?(req: DispatchRequest): Promise<string | null>
  markSkipped(token: string, reason: string): Promise<void>
  markDispatched?(token: string): Promise<void>
  /** called when the agent's next assistant_message lands on this session */
  onFinalize(token: string, content: string): Promise<void>
  markFailed(token: string, error: string): Promise<void>
}

export type DispatchOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'dropped_busy' }
  | { kind: 'parked_offline' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export interface PipelineDeps {
  gates: DispatchGate[] // [threshold, costCap, ...subsystem-specific]
  store: RunStore | null
  /** offline replay thunk, parked in grace and re-run on reconnect */
  replay: (req: DispatchRequest) => Promise<void>
  /**
   * true when the target agent/session is online and ready to receive a send.
   * When false, dispatch parks the replay thunk in grace → `parked_offline`.
   */
  isOnline: (req: DispatchRequest) => boolean | Promise<boolean>
  /**
   * Ship the `user_message` to the agent socket. Resolves the socket, builds
   * the wire frame, persists chat history as the subsystem requires. Called
   * exactly once on a successful claim (after all gates pass + queue admits).
   * Throwing here finalizes the run as failed.
   */
  send: (req: DispatchRequest) => Promise<void>
  /**
   * Optional grace target key override. Defaults to `req.sessionId`. Scheduler
   * parks supervisor-targeted runs under the supervisorId.
   */
  graceKey?: (req: DispatchRequest) => string
  /**
   * Optional expire side-effect for a parked-offline request whose grace TTL
   * lapses before the agent reconnects. Reproduces the legacy expire-mark
   * (scheduler: updateRunStatus(skipped,'target_offline'); error-capture:
   * updateErrorDispatchStatus(skipped,'target_offline_expired'); revanote:
   * updateAnnotationStatus('failed_offline',...)). Undefined for telegram (no
   * run row → nothing to mark). Errors are swallowed by the grace buffer.
   */
  onParkExpire?: (req: DispatchRequest) => Promise<void>
}

// ── module-owned state ────────────────────────────────────────────────────────

/** The pipeline owns one queue instance — not a global functional module var. */
const queue = new SessionQueue()

/** Active finalize hook per session: the next assistant_message lands here. */
interface ActiveHook {
  token: string
  req: DispatchRequest
  deps: PipelineDeps
  startedAt: number
}
const activeBySession = new Map<string, ActiveHook>()

/**
 * Parked waiter context per session. The queue holds only the waiter TOKEN
 * (string — required by the back-compat shim's functional API); the pipeline
 * holds the full {req, deps} so promotion can re-dispatch directly, re-running
 * the gate list (IR-2). Keyed by sessionId because the queue admits exactly one
 * waiter per session. This is what kills the global `setOnPromote` seam.
 */
const waiterBySession = new Map<string, { req: DispatchRequest; deps: PipelineDeps }>()

export function getQueue(): SessionQueue {
  return queue
}

// Test-only reset.
export function _reset(): void {
  queue._reset()
  activeBySession.clear()
  waiterBySession.clear()
}

// ── core ────────────────────────────────────────────────────────────────────

/**
 * Run the gate list in order. First block wins. Returns the blocking reason or
 * null when every gate passes.
 */
async function runGates(req: DispatchRequest, gates: DispatchGate[]): Promise<string | null> {
  for (const gate of gates) {
    const result = await gate.check(req)
    if (!result.ok) return result.reason
  }
  return null
}

/**
 * The deep dispatch. Gates → queue claim → offline park → send → register
 * finalize hook. Returns a discriminated outcome the caller maps to its own
 * status vocabulary.
 */
export async function dispatch(req: DispatchRequest, deps: PipelineDeps): Promise<DispatchOutcome> {
  // 1. Gates (threshold → cost-cap → ...). First block wins. IR-1 / IR-2.
  const blocked = await runGates(req, deps.gates)
  if (blocked) {
    if (deps.store) {
      try {
        await deps.store.markSkipped(req.token, blocked)
      } catch (err: any) {
        console.error(`[dispatch] markSkipped failed token=${req.token}: ${err?.message ?? err}`)
      }
    }
    return { kind: 'skipped', reason: blocked }
  }

  // 2. Queue claim. dispatched (head) / queued (1 waiter) / dropped (busy).
  const claim = queue.enqueue(req.sessionId, req.token)
  if (claim === 'dropped') {
    if (deps.store) {
      try {
        await deps.store.markSkipped(req.token, 'session_busy')
      } catch {}
    }
    return { kind: 'dropped_busy' }
  }
  if (claim === 'queued') {
    // Parked behind the in-flight run. The queue holds the waiter token; the
    // pipeline stashes the full {req, deps} so onSessionReply can re-dispatch
    // it directly through the full gate list when the head finishes (IR-2).
    waiterBySession.set(req.sessionId, { req, deps })
    return { kind: 'queued' }
  }

  // claim === 'dispatched' → we own the in-flight slot. Proceed to send.

  // 3. Offline park. If the agent isn't online, release the slot and park the
  //    replay thunk in grace; drained on reconnect.
  const online = await deps.isOnline(req)
  if (!online) {
    queue.markFinished(req.sessionId) // release the slot we just took
    const key = deps.graceKey ? deps.graceKey(req) : req.sessionId
    getGraceBuffer().register(key, () => deps.replay(req), {
      onExpire: deps.onParkExpire ? () => deps.onParkExpire!(req) : undefined,
    })
    return { kind: 'parked_offline' }
  }

  // 4. Send the user_message on the agent socket + register the finalize hook
  //    BEFORE the reply can race back. IR-7: the hook only fires via
  //    onSessionReply (agent assistant_message branch).
  activeBySession.set(req.sessionId, { token: req.token, req, deps, startedAt: Date.now() })
  try {
    if (deps.store?.markDispatched) await deps.store.markDispatched(req.token)
    await deps.send(req)
  } catch (err: any) {
    activeBySession.delete(req.sessionId)
    queue.markFinished(req.sessionId)
    const msg = err?.message ?? String(err)
    if (deps.store) {
      try {
        await deps.store.markFailed(req.token, msg)
      } catch {}
    }
    return { kind: 'failed', reason: msg }
  }

  return { kind: 'dispatched' }
}

/**
 * Called from the agent ws assistant_message branch (the single fan-in point
 * replacing the per-subsystem run-lifecycle `onAgentReply` mirrors).
 *
 * Looks up the active finalize hook for `sessionId`, runs `store.onFinalize`,
 * then promotes the queue waiter and re-dispatches it through the FULL gate
 * list again (IR-2 — a user who crossed the cap while queued is skipped).
 */
export async function onSessionReply(sessionId: string, content: string): Promise<void> {
  const active = activeBySession.get(sessionId)
  if (!active) return
  activeBySession.delete(sessionId)

  // Finalize the head-of-queue run.
  if (active.deps.store) {
    try {
      await active.deps.store.onFinalize(active.token, content)
    } catch (err: any) {
      console.error(`[dispatch] onFinalize failed token=${active.token}: ${err?.message ?? err}`)
    }
  }

  // Promote the waiter (if any). The queue advances the head slot; the pipeline
  // holds the waiter's {req, deps} so we re-dispatch DIRECTLY — no global
  // callback seam. The full gate list is re-evaluated (IR-2): a user who
  // crossed the cap while queued gets {kind:'skipped'} and is never sent.
  const promotedToken = queue.markFinished(sessionId)
  if (!promotedToken) {
    waiterBySession.delete(sessionId)
    return
  }

  const waiter = waiterBySession.get(sessionId)
  waiterBySession.delete(sessionId)
  if (!waiter) return

  // markFinished already moved the promoted token into the in-flight slot, so
  // re-running dispatch() would see the slot occupied and queue/drop. We
  // INTENTIONALLY release the slot here, then re-dispatch the promoted waiter
  // fresh through every gate (IR-2). Do NOT "fix" this back to keeping the slot
  // held — the legacy scheduler held it and then re-entered enqueue() on the
  // already-occupied slot, which returned 'queued' and stranded the waiter
  // (never sent). The release-then-redispatch is the deliberate correction.
  //
  // KNOWN await-gap (best-effort ordering): between this release and the
  // re-enqueue inside dispatch() there is an await boundary (the gate checks).
  // A 3rd same-session dispatch arriving from ANOTHER source in that window can
  // claim the freed slot ahead of the promoted waiter, reordering it. This is
  // accepted: cross-source same-session ordering is best-effort, the cost-cap
  // (IR-1) and queue cap (1 in-flight + 1 waiter) invariants still hold, and the
  // displaced waiter simply re-queues. A strict hand-off would require an
  // atomic promote-and-redispatch lock that the single-in-flight model doesn't
  // warrant.
  queue.markFinished(sessionId)
  try {
    await dispatch(waiter.req, waiter.deps)
  } catch (err: any) {
    console.error(`[dispatch] promoted re-dispatch failed session=${sessionId} token=${promotedToken}: ${err?.message ?? err}`)
  }
}
