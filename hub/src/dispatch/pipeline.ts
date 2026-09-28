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
  /**
   * Optional narration filter. A subsystem's agent turn may emit MULTIPLE
   * assistant_message events before the one that actually carries the result
   * (e.g. revanote agents narrating progress — "Implementer running...")
   * before the final `<<JSON>>...<<END>>` envelope. When present, `onFinalize`
   * is deferred until this returns true for a given message's content; a
   * `false` return leaves the hook active so a later assistant_message on the
   * same session can still finalize it. Omit to preserve today's behaviour
   * (finalize unconditionally on the first assistant_message — scheduler /
   * telegram / error-capture all rely on that one-shot semantics).
   */
  shouldFinalize?(content: string): boolean
}

export type DispatchOutcome =
  | { kind: 'dispatched'; runId: string }
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
   * Spawn-on-error hook (optional, opt-in). When `isOnline` reports false,
   * dispatch calls this — if present — to LAZY-START the offline-but-existing
   * session before parking. Runs AFTER every gate (so cost-cap / threshold /
   * dedupe / rate-limit remain non-bypassable). Returns true iff the session
   * came online in time, in which case dispatch proceeds to send instead of
   * parking; false → existing park/skip behaviour (no leak — see
   * `dispatch/spawn-on-error.ts`). Omit to preserve today's behaviour exactly.
   */
  ensureOnline?: (req: DispatchRequest) => Promise<boolean>
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
  /**
   * Bounded terminal fallback for `shouldFinalize`-gated stores: once the
   * active hook has been alive this long (ms, measured from the finalize hook
   * being armed in `dispatch()`), the NEXT assistant_message finalizes
   * unconditionally even if `shouldFinalize` still returns false. Prevents a
   * session that narrates forever without ever emitting the expected result
   * from hanging the hook indefinitely — it resolves as an honest failure
   * (the store's own `onFinalize`/parse logic decides how to report that).
   * Ignored when `store.shouldFinalize` is absent. Defaults to 20 minutes.
   */
  finalizeTimeoutMs?: number
  /**
   * Hard ceiling (ms) for a `shouldFinalize`-gated hook that never sees its
   * result AND gets no further assistant_message. `finalizeTimeoutMs` only
   * fires when a NEW message arrives, so an agent that says "done" without
   * the envelope and then goes quiet held the session's slot forever, and
   * every later dispatch to that session came back `session_busy`.
   * `reapTimedOutHooks` finalizes such a hook with empty content once it has
   * been armed this long, then promotes the next waiter. Deliberately much
   * longer than `finalizeTimeoutMs`: reaping a hook whose agent is still
   * silently working lets the next prompt interleave with it. Ignored when
   * `store.shouldFinalize` is absent. Defaults to `REMO_DISPATCH_HOOK_MAX_MS`
   * (2h).
   */
  hookMaxMs?: number
}

const DEFAULT_FINALIZE_TIMEOUT_MS = 20 * 60 * 1000

// ── module-owned state ────────────────────────────────────────────────────────

const DEFAULT_MAX_WAITERS = 50
const DEFAULT_HOOK_MAX_MS = 2 * 60 * 60 * 1000

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * The pipeline owns one queue instance — not a global functional module var.
 * Depth: `REMO_DISPATCH_MAX_WAITERS` waiters per session (default 50). The old
 * 1-waiter cap dropped every burst beyond two (a Revanote review with 22
 * comments on one repo lost 20 of them to `session_busy` on every retry).
 */
const queue = new SessionQueue(positiveIntEnv('REMO_DISPATCH_MAX_WAITERS', DEFAULT_MAX_WAITERS))

/** Active finalize hook per session: the next assistant_message lands here. */
interface ActiveHook {
  token: string
  req: DispatchRequest
  deps: PipelineDeps
  startedAt: number
}
const activeBySession = new Map<string, ActiveHook>()

/**
 * Parked waiter context, keyed by `sessionId\0token`. The queue holds only the
 * waiter TOKENS (FIFO order); the pipeline holds each waiter's full
 * {req, deps} so promotion can re-dispatch directly, re-running the gate list
 * (IR-2). This is what kills the global `setOnPromote` seam.
 */
const waiterCtx = new Map<string, { req: DispatchRequest; deps: PipelineDeps }>()
const waiterKey = (sessionId: string, token: string) => `${sessionId}\0${token}`

export function getQueue(): SessionQueue {
  return queue
}

// Test-only reset.
export function _reset(): void {
  queue._reset()
  activeBySession.clear()
  waiterCtx.clear()
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
    // pipeline stashes the full {req, deps} so promotion can re-dispatch it
    // directly through the full gate list when the head finishes (IR-2). A
    // duplicate of the token already in flight has nothing to stash.
    if (queue.currentInFlight(req.sessionId) !== req.token) {
      waiterCtx.set(waiterKey(req.sessionId, req.token), { req, deps })
    }
    return { kind: 'queued' }
  }

  // claim === 'dispatched' → we own the in-flight slot. Proceed to send.

  // 3. Offline park. If the agent isn't online, OPTIONALLY try to lazy-start
  //    the session (spawn-on-error, opt-in via ensureOnline), then re-check;
  //    if still offline, release the slot and park the replay thunk in grace.
  let online = await deps.isOnline(req)
  if (!online && deps.ensureOnline) {
    // Spawn-on-error runs strictly AFTER the gate list above (IR-1: cost-cap /
    // dedupe / rate-limit already passed — we never spawn for a gated repair).
    // It owns its own leak-safe reserve→create→send→release sequence and a
    // per-session in-flight lock; a false return means "couldn't bring it
    // online" → fall through to the normal park.
    try {
      if (await deps.ensureOnline(req)) {
        online = await deps.isOnline(req)
      }
    } catch (err: any) {
      console.error(`[dispatch] ensureOnline failed session=${req.sessionId}: ${err?.message ?? err}`)
    }
  }
  if (!online) {
    // Release the slot we just took. A waiter may have queued behind us while
    // we awaited isOnline/ensureOnline — promote it (never just move it into
    // the in-flight slot: with no finalize hook armed nothing would ever free
    // that slot again, and every later dispatch would be `session_busy`).
    void releaseAndPromote(req.sessionId)
    const key = deps.graceKey ? deps.graceKey(req) : req.sessionId
    getGraceBuffer().register(key, () => deps.replay(req), {
      onExpire: deps.onParkExpire ? () => deps.onParkExpire!(req) : undefined,
    })
    return { kind: 'parked_offline' }
  }

  // 4. Open the run row. Fires EXACTLY when we're truly dispatching — after
  //    gates pass, after the queue head-slot claim, and after the offline park
  //    check — never for a skipped / dropped / queued / parked message. A
  //    QUEUED waiter opens its row only when promotion re-enters dispatch()
  //    (onSessionReply → re-dispatch), so the row is inserted for the message we
  //    actually send, matching the legacy "insert run row when we send" rule.
  //    The store returns the run id (or null → fall back to req.token); this id
  //    is the finalize key threaded through activeBySession so onSessionReply
  //    calls store.onFinalize(<runId>, content) with the real id.
  const openedId = (await deps.store?.open?.(req)) ?? req.token

  // 5. Send the user_message on the agent socket + register the finalize hook
  //    BEFORE the reply can race back. IR-7: the hook only fires via
  //    onSessionReply (agent assistant_message branch).
  activeBySession.set(req.sessionId, { token: openedId, req, deps, startedAt: Date.now() })
  try {
    if (deps.store?.markDispatched) await deps.store.markDispatched(openedId)
    await deps.send(req)
  } catch (err: any) {
    activeBySession.delete(req.sessionId)
    const msg = err?.message ?? String(err)
    if (deps.store) {
      try {
        await deps.store.markFailed(openedId, msg)
      } catch {}
    }
    void releaseAndPromote(req.sessionId)
    return { kind: 'failed', reason: msg }
  }

  return { kind: 'dispatched', runId: openedId }
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

  // IR-7 narration tolerance: a store may defer finalize until a message
  // actually carries its expected result (e.g. revanote's envelope). Buffer
  // narration-only messages — leave the hook active — unless the bounded
  // terminal timeout has elapsed, in which case this message finalizes
  // unconditionally so the hook can never hang forever.
  const shouldFinalize = active.deps.store?.shouldFinalize
  if (shouldFinalize) {
    const timeoutMs = active.deps.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS
    const timedOut = Date.now() - active.startedAt >= timeoutMs
    if (!timedOut && !shouldFinalize(content)) {
      return
    }
  }
  await finalizeAndPromote(sessionId, active, content)
}

/**
 * Hard-ceiling sweep for `shouldFinalize`-gated hooks (see
 * `PipelineDeps.hookMaxMs`). Finalizes, with empty content, every such hook
 * armed at least `hookMaxMs` before `now`, then promotes that session's next
 * waiter. The store's own parse decides how to report the empty result
 * (revanote: `envelope_missing` → resolved:false callback). Returns how many
 * hooks were reaped. Stores without `shouldFinalize` are never touched.
 */
export async function reapTimedOutHooks(now: number = Date.now()): Promise<number> {
  let reaped = 0
  for (const [sessionId, active] of [...activeBySession]) {
    if (!active.deps.store?.shouldFinalize) continue
    const maxMs = active.deps.hookMaxMs ?? positiveIntEnv('REMO_DISPATCH_HOOK_MAX_MS', DEFAULT_HOOK_MAX_MS)
    if (now - active.startedAt < maxMs) continue
    if (activeBySession.get(sessionId) !== active) continue // finalized meanwhile
    console.warn(
      `[dispatch] reaping silent finalize hook session=${sessionId} token=${active.token} ` +
        `age_ms=${now - active.startedAt} (no result envelope, no further messages)`,
    )
    await finalizeAndPromote(sessionId, active, '')
    reaped++
  }
  return reaped
}

/**
 * Release a session's in-flight slot because its run was closed out somewhere
 * ELSE — a reaper finalized the run row, the session's CLI died, a lock was
 * judged wedged. Without this the pipeline kept the finalize hook armed and
 * the queue slot claimed for a run nothing would ever complete, so every later
 * dispatch to that session just queued behind a dead token (or came back
 * `session_busy` once the queue filled) until a hub restart.
 *
 * `opts.token` scopes the release to one run: when given, the slot is freed
 * only if that token is still the one in flight (a newer run that already took
 * the slot is left alone). `opts.markFailed` asks the store to record the run
 * as failed with `reason` — callers that already finalized the row themselves
 * (the scheduler run-reaper) pass false so the row is not written twice.
 *
 * Waiters are never dropped: the oldest one is re-dispatched through the full
 * gate list (IR-2), exactly as after a normal reply. Returns true when a slot
 * was released.
 */
export async function releaseClosedRun(
  sessionId: string,
  reason: string,
  opts: { token?: string; markFailed?: boolean } = {},
): Promise<boolean> {
  // Only an ARMED hook is released. A slot claimed without a hook belongs to a
  // dispatch() still awaiting isOnline/ensureOnline; freeing it here would let
  // a promoted waiter send concurrently with that dispatch.
  const active = activeBySession.get(sessionId)
  if (!active) return false
  if (opts.token !== undefined && active.token !== opts.token && active.req.token !== opts.token) return false
  activeBySession.delete(sessionId)
  if (opts.markFailed !== false && active.deps.store) {
    try {
      await active.deps.store.markFailed(active.token, reason)
    } catch (err: any) {
      console.error(`[dispatch] markFailed on release failed token=${active.token}: ${err?.message ?? err}`)
    }
  }
  console.warn(`[dispatch] released in-flight slot session=${sessionId} token=${active.token} reason=${reason}`)
  await releaseAndPromote(sessionId)
  return true
}

/**
 * `releaseClosedRun` for a caller that knows only the run id (e.g. the
 * scheduler run-reaper, whose rows carry no session id). Finds the session
 * whose active hook or in-flight token is `token` and releases it.
 */
export async function releaseClosedRunByToken(
  token: string,
  reason: string,
  opts: { markFailed?: boolean } = {},
): Promise<boolean> {
  for (const [sessionId, active] of activeBySession) {
    if (active.token === token || active.req.token === token) {
      return releaseClosedRun(sessionId, reason, { ...opts, token })
    }
  }
  return false
}

let hookReaperTimer: ReturnType<typeof setInterval> | null = null

/** Boot-started interval driving `reapTimedOutHooks` (idempotent). */
export function startHookReaper(intervalMs: number = 60_000): void {
  if (hookReaperTimer) return
  hookReaperTimer = setInterval(() => {
    void reapTimedOutHooks().catch((err) =>
      console.error(`[dispatch] hook reaper failed: ${err?.message ?? err}`),
    )
  }, intervalMs)
  hookReaperTimer.unref?.()
}

async function finalizeAndPromote(sessionId: string, active: ActiveHook, content: string): Promise<void> {
  activeBySession.delete(sessionId)

  // Finalize the head-of-queue run.
  if (active.deps.store) {
    try {
      await active.deps.store.onFinalize(active.token, content)
    } catch (err: any) {
      console.error(`[dispatch] onFinalize failed token=${active.token}: ${err?.message ?? err}`)
    }
  }

  await releaseAndPromote(sessionId)
}

/**
 * Free the session's in-flight slot and re-dispatch the oldest waiter (if any)
 * fresh through every gate (IR-2): a user who crossed the cap while queued
 * gets {kind:'skipped'} and is never sent. The slot is released rather than
 * handed to the waiter because dispatch() must claim it itself — the legacy
 * scheduler held it and re-entered enqueue() on the occupied slot, which
 * returned 'queued' and stranded the waiter (never sent).
 *
 * KNOWN await-gap (best-effort ordering): between this release and the
 * re-enqueue inside dispatch() there is an await boundary (the gate checks).
 * A dispatch arriving from ANOTHER source in that window can claim the freed
 * slot ahead of the promoted waiter, which then re-queues at the tail.
 * Cross-source same-session ordering is best-effort; the cost-cap (IR-1) and
 * queue cap invariants still hold.
 *
 * A waiter whose re-dispatch is skipped, parked or fails releases the slot
 * again itself (same path), so the queue keeps draining.
 */
async function releaseAndPromote(sessionId: string): Promise<void> {
  const next = queue.releaseAndTakeNext(sessionId)
  if (!next) return
  const key = waiterKey(sessionId, next)
  const waiter = waiterCtx.get(key)
  waiterCtx.delete(key)
  if (!waiter) {
    // No context (should not happen) — skip it rather than wedge the queue.
    console.error(`[dispatch] promoted waiter has no context session=${sessionId} token=${next}`)
    return releaseAndPromote(sessionId)
  }
  try {
    const out = await dispatch(waiter.req, waiter.deps)
    // A skipped promotion never took the slot; keep draining.
    if (out.kind === 'skipped') await releaseAndPromoteIfIdle(sessionId)
  } catch (err: any) {
    console.error(`[dispatch] promoted re-dispatch failed session=${sessionId} token=${next}: ${err?.message ?? err}`)
  }
}

/** Promote the next waiter only when nothing currently holds the slot. */
async function releaseAndPromoteIfIdle(sessionId: string): Promise<void> {
  if (queue.currentInFlight(sessionId) !== null) return
  if (queue.waiterCount(sessionId) === 0) return
  await releaseAndPromote(sessionId)
}
