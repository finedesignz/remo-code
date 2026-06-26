// hub/src/orchestrator/inject.ts
// Phase 25 (auto-dev-orchestrator) — the prompt-INJECTION adapter.
//
// Locked decision D6: the orchestrator rides the SAME shared dispatch pipeline
// (`hub/src/dispatch/`) the scheduler uses — it does NOT fork a new send path.
// This module is the thin orchestrator analogue of the scheduler's
// `sendAgentTask` (hub/src/scheduler/senders/agent.ts): it builds the dispatch
// `deps` (gates [threshold → cost-cap] + the agent-socket send), calls
// `dispatch()`, and maps the pipeline outcome onto a typed result.
//
// Non-negotiable invariants (carried from the scheduler adapter):
//   IR-1  cost cap non-bypassable — `dailyCostCapGate` is ALWAYS in the gate list.
//   The hub injects TEXT ONLY. It NEVER shells gh/git/merge — the agent does the
//   PR + reviewer inside its own turn per the embedded prompt (command-prompts.ts).
//
// The gsd work + PR + reviewer happen ASYNC inside the agent's turn. This adapter
// returns as soon as the prompt is DISPATCHED (or refused) — pr_url/verdict are
// not known synchronously; they are reconciled later (the controller re-reads the
// agent's reported `<<UNIT>>` / run-log on a subsequent tick).

import { insertMessage } from '../db/dal.ts'
import { getChannel, broadcastToSubscribers } from '../ws/registry.ts'
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
  type RunStore,
} from '../dispatch/pipeline.ts'
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, isOverAutospawnDailyLaunchCap } from '../dispatch/gates.ts'
import { isOrchestratorEnabled, isAutospawnEnabled } from './controller.ts'
import {
  isRepoAutospawnAllowed,
  countAutospawnLaunchesToday,
  AUTOSPAWN_LAUNCH_COMMAND,
} from '../db/orchestrator-rows-dal.ts'
import { getTokenCapStatus } from '../dispatch/gates.ts'
import { launchSessionForUser, type LaunchResult } from '../telegram/launch.ts'
import { isSupervisorOnline } from '../ws/supervisor-registry.ts'
import { listSupervisorsForUser } from '../db/supervisor-dal.ts'
import { appendRunLog } from './run-log.ts'
import { getGraceBuffer } from '../dispatch/grace.ts'

export type InjectOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'refused_cost_cap'; reason: string }
  // `reason` carries either a gate reason (threshold/cost) OR a BSA-02 autospawn
  // gate refusal: 'not_allowlisted' | 'over_token_cap' | 'launch_cap' |
  // 'supervisor_offline' | 'autospawn_launch_<reason>'.
  | { kind: 'refused'; reason: string }
  | { kind: 'no_session' }
  | { kind: 'failed'; reason: string }
  // ── BSA-02: autospawn outcomes (only ever returned when the gate-chain is ON) ──
  /** a supervisor-hosted session was spawned; the macro prompt is parked in grace. */
  | { kind: 'autospawn_launched' }
  /** the macro prompt is parked in grace (launch already in flight, or dispatch parked). */
  | { kind: 'autospawn_parked' }

/**
 * BSA-02: per-call autospawn context. ONLY supplied by the macro cycle for a
 * BUILD (dev) macro on an OFFLINE session. Absent ⇒ the seam is a strict no-op and
 * `injectOrchestratorPrompt` keeps its legacy `no_session` opt-out. Its mere
 * presence does NOT arm autospawn — the env gates (`isOrchestratorEnabled() &&
 * isAutospawnEnabled()`) and the allowlist still have to pass.
 */
export interface AutospawnContext {
  /** the macro's build-ness — only `dev` (true) is eligible to autospawn. */
  isBuild: boolean
  /** host-agnostic repo ident (github://owner/repo | path://<abs>) for the allowlist check. */
  repoIdent: string
  /** the user's IANA tz for the per-day token/launch ceilings (defaults to UTC). */
  tz?: string
}

export interface InjectInput {
  userId: string
  sessionId: string
  /** stable token (finalize key) — orchestrator uses `orch:<sessionId>:<command>:<ts>`. */
  token: string
  /** the composed templated prompt (command-prompts.ts). */
  prompt: string
  /** BSA-02: when present + gated ON, an offline build session is autospawned. */
  autospawn?: AutospawnContext
}

/** Injectable seam for tests: lets the seam swap the real `dispatch()` for a spy. */
export interface InjectDeps {
  dispatch: typeof dispatch
  getChannel: typeof getChannel
  // BSA-02 seams (all default to the real adapters; tests swap them).
  isOrchestratorEnabled: typeof isOrchestratorEnabled
  isAutospawnEnabled: typeof isAutospawnEnabled
  isRepoAutospawnAllowed: typeof isRepoAutospawnAllowed
  getTokenCapStatus: typeof getTokenCapStatus
  countAutospawnLaunchesToday: typeof countAutospawnLaunchesToday
  supervisorOnlineForUser: (userId: string, sessionId: string) => Promise<boolean>
  launchSessionForUser: typeof launchSessionForUser
  appendRunLog: typeof appendRunLog
  graceParkPending: (sessionId: string) => boolean
}

/** Is at least one supervisor that could host this user's sessions online? */
async function defaultSupervisorOnlineForUser(userId: string): Promise<boolean> {
  try {
    const sups = (await listSupervisorsForUser(userId)) as Array<{ id: string }>
    return sups.some((s) => isSupervisorOnline(s.id))
  } catch {
    return false
  }
}

const REAL_DEPS: InjectDeps = {
  dispatch,
  getChannel,
  isOrchestratorEnabled,
  isAutospawnEnabled,
  isRepoAutospawnAllowed,
  getTokenCapStatus,
  countAutospawnLaunchesToday,
  supervisorOnlineForUser: (userId) => defaultSupervisorOnlineForUser(userId),
  launchSessionForUser,
  appendRunLog,
  graceParkPending: (sessionId) => {
    try {
      return getGraceBuffer()._pendingCount(sessionId) > 0
    } catch {
      return false
    }
  },
}

/** Build the prompt-delivery `send` closure (shared by the live + park paths). */
function buildSend(prompt: string, token: string, deps: InjectDeps): PipelineDeps['send'] {
  return async (req) => {
    const channel = deps.getChannel(req.sessionId)
    if (!channel) throw new Error('agent_socket_missing')
    const msg = await insertMessage(req.sessionId, 'user', prompt)
    broadcastToSubscribers(req.sessionId, {
      type: 'message',
      session_id: req.sessionId,
      message: msg,
      run_id: token,
    })
    channel.ws.send(
      JSON.stringify({
        type: 'user_message',
        id: msg.id,
        content: prompt,
        ts: msg.created_at,
        run_id: token,
      }),
    )
  }
}

/**
 * Inject a templated orchestrator prompt into the bound session via the shared
 * dispatch pipeline. The gate list is `[thresholdGate, dailyCostCapGate,
 * dailyTokenCapGate]` — the scheduler's session list PLUS the BSA-04
 * non-bypassable daily TOKEN ceiling (ADDED ALONGSIDE the cost cap, never
 * replacing it) so an autospawn-driven turn is token- AND cost-capped (IR-1).
 *
 * BSA-02 — offline build-session AUTOSPAWN (default OFF, true no-op when OFF):
 * when the target session has no live channel, the LEGACY behaviour is
 * `no_session` (the orchestrator does not launch). That opt-out is converted to a
 * GATED OPT-IN: a supervisor-hosted session is spawned (reusing the proven
 * scheduler `launchSessionForUser` primitive — concurrency slot reserved) and the
 * macro prompt is PARKED in grace (exactly as the scheduler does), but ONLY when
 * the FULL AND-chain holds:
 *
 *   input.autospawn?.isBuild === true     (the macro is a BUILD/dev type)
 *   && isOrchestratorEnabled()            (REMO_ORCHESTRATOR_ENABLED)
 *   && isAutospawnEnabled()               (REMO_ORCHESTRATOR_AUTOSPAWN — default OFF)
 *   && isRepoAutospawnAllowed(user, repo) (allowlist NON-EMPTY for this repo)
 *   && supervisor online for this user
 *   && NOT over the daily TOKEN cap
 *   && NOT over the per-day autospawn LAUNCH-count cap
 *
 * ANY gate unsatisfied ⇒ the EXISTING `no_session` behaviour is returned
 * unchanged (so OFF / empty-allowlist / no-autospawn-context is a strict no-op).
 *
 * Outcome mapping:
 *   - dispatched          → prompt sent on the agent socket (finalize lands later).
 *   - queued              → behind an in-flight turn; promotion re-dispatches.
 *   - refused_cost_cap    → gate blocked on `over_daily_cost_cap` / `programmatic_credit_halt`.
 *   - refused             → gate blocked / autospawn gate unsatisfied (typed reason).
 *   - no_session          → offline + autospawn not armed (legacy behaviour).
 *   - autospawn_launched  → a session was spawned; the macro prompt is parked in grace.
 *   - autospawn_parked    → parked in grace (launch already in flight, or dispatch parked).
 *   - failed              → the send/launch threw.
 */
export async function injectOrchestratorPrompt(
  input: InjectInput,
  deps: InjectDeps = REAL_DEPS,
): Promise<InjectOutcome> {
  const { userId, sessionId, token, prompt } = input

  // OFFLINE target. Legacy behaviour is `no_session`. BSA-02 converts this into a
  // GATED opt-in autospawn; ANY gate not satisfied falls back to `no_session`.
  if (deps.getChannel(sessionId) == null) {
    return await maybeAutospawnOffline(input, deps)
  }

  // Minimal RunStore: the orchestrator's run row is the routine_run_log entry
  // written by the wave runner, so this store does NOT insert a scheduled_task_runs
  // row. markSkipped/markFailed/onFinalize are best-effort no-ops here — the
  // pipeline outcome is what the seam maps; reconciliation is later-tick.
  const store: RunStore = {
    async open() {
      return token
    },
    async markSkipped() {},
    async onFinalize() {},
    async markFailed() {},
  }

  const send = buildSend(prompt, token, deps)
  const deployDeps: PipelineDeps = {
    // IR-1: cost-cap non-bypassable. BSA-04: the token cap is ADDED ALONGSIDE it
    // (never replacing). Order: threshold → cost-cap → token-cap.
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate],
    store,
    isOnline: (req) => deps.getChannel(req.sessionId) != null,
    // Online path: park is unexpected (we gated on getChannel above) — no-op.
    replay: async () => {},
    send,
  }

  const req: DispatchRequest = { userId, sessionId, token, prompt }
  const outcome = await deps.dispatch(req, deployDeps)
  return mapDispatchOutcome(outcome)
}

/** Shared dispatch-outcome → InjectOutcome mapping for the ONLINE path. */
function mapDispatchOutcome(outcome: Awaited<ReturnType<typeof dispatch>>): InjectOutcome {
  switch (outcome.kind) {
    case 'dispatched':
      return { kind: 'dispatched' }
    case 'queued':
      return { kind: 'queued' }
    case 'parked_offline':
      // Shouldn't happen (we gated on getChannel); report as no_session for clarity.
      return { kind: 'no_session' }
    case 'dropped_busy':
      return { kind: 'refused', reason: 'session_busy' }
    case 'skipped': {
      const reason = outcome.reason
      const isCostCap =
        reason.startsWith('over_daily_cost_cap') || reason.startsWith('programmatic_credit_halt')
      return isCostCap
        ? { kind: 'refused_cost_cap', reason }
        : { kind: 'refused', reason }
    }
    case 'failed':
      return { kind: 'failed', reason: outcome.reason }
  }
}

/**
 * BSA-02 offline AUTOSPAWN seam. Evaluates the full AND-chain; on ANY miss returns
 * the legacy `{ kind:'no_session' }` (true no-op when OFF / empty allowlist / no
 * autospawn context). When the chain holds, reuses `launchSessionForUser` to spawn
 * a supervisor-hosted session and PARKS the macro prompt in grace (the launched
 * runner drains it on reconnect — same mechanic as the scheduler).
 */
async function maybeAutospawnOffline(
  input: InjectInput,
  deps: InjectDeps,
): Promise<InjectOutcome> {
  const { userId, sessionId, token, prompt, autospawn } = input

  // ── AND-chain — each miss is the legacy no_session (no behaviour change) ──
  if (!autospawn || !autospawn.isBuild) return { kind: 'no_session' }
  if (!deps.isOrchestratorEnabled() || !deps.isAutospawnEnabled()) return { kind: 'no_session' }

  const tz = autospawn.tz || 'UTC'

  // Allowlist (fail-closed: empty allowlist ⇒ false ⇒ refused:not_allowlisted).
  const allowed = await deps.isRepoAutospawnAllowed(userId, autospawn.repoIdent)
  if (!allowed) return { kind: 'refused', reason: 'not_allowlisted' }

  // Supervisor must be online to host the spawned session.
  const supOnline = await deps.supervisorOnlineForUser(userId, sessionId)
  if (!supOnline) return { kind: 'refused', reason: 'supervisor_offline' }

  // BSA-04 token ceiling (non-bypassable, ALONGSIDE cost cap). Pre-launch check so
  // we never SPAWN over the ceiling; the dispatch gate list re-checks per turn.
  const tokenStatus = await deps.getTokenCapStatus(userId, tz)
  if (tokenStatus.over) return { kind: 'refused', reason: 'over_token_cap' }

  // BSA-04 per-day launch-count cap (each spawn is a cost/risk event regardless of
  // tokens). Source: count today's `autospawn-launch` run-log rows (tz-day).
  let launchesToday = 0
  try {
    launchesToday = await deps.countAutospawnLaunchesToday(userId, tz)
  } catch {
    /* best-effort; treat as 0 so a transient read error does not over-block */
  }
  if (isOverAutospawnDailyLaunchCap(launchesToday)) return { kind: 'refused', reason: 'launch_cap' }

  // ── Launch + park ────────────────────────────────────────────────────────────
  // Dedup: a live grace entry means a launch is already in flight for this session
  // (one spawn per grace window) — don't fire a duplicate session.start; the
  // earlier parked prompt already covers delivery on reconnect.
  if (deps.graceParkPending(sessionId)) {
    return { kind: 'autospawn_parked' }
  }

  let launch: LaunchResult
  try {
    launch = await deps.launchSessionForUser({ userId, sessionId })
  } catch (err: any) {
    return { kind: 'failed', reason: `autospawn_launch_threw: ${err?.message ?? String(err)}` }
  }

  if (!launch.ok) {
    // no_online_supervisor (raced offline) maps to supervisor_offline; capacity /
    // other definitive reasons surface as a typed refusal.
    if (launch.reason === 'no_online_supervisor') return { kind: 'refused', reason: 'supervisor_offline' }
    return { kind: 'refused', reason: `autospawn_launch_${launch.reason}` }
  }

  // Ledger row: one `autospawn-launch` run-log entry per real spawn — this is the
  // BSA-04 launch-count cap's source (counted above). Best-effort.
  try {
    await deps.appendRunLog({
      session_id: sessionId,
      repo_key: autospawn.repoIdent,
      command: AUTOSPAWN_LAUNCH_COMMAND,
      decision_rationale: `autospawn build session (run=${launch.runId}, sup=${launch.supervisorId})`,
      outcome: 'launched',
    })
  } catch {
    /* best-effort — the cap is conservative; a missed ledger row only under-counts */
  }

  // Park the macro prompt in grace so the freshly-launched runner receives it on
  // reconnect. The session is still offline (channel null until the runner
  // connects), so dispatch will park; we wire the `replay` thunk to deliver the
  // prompt on drain (the session is online by then).
  const store: RunStore = {
    async open() { return token },
    async markSkipped() {},
    async onFinalize() {},
    async markFailed() {},
  }
  const send = buildSend(prompt, token, deps)
  const deployDeps: PipelineDeps = {
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate],
    store,
    isOnline: (req) => deps.getChannel(req.sessionId) != null,
    // Grace drain (on the launched runner's reconnect) re-runs this: deliver the
    // parked macro prompt to the now-online session.
    replay: async () => {
      try {
        await send({ userId, sessionId, token, prompt })
      } catch (err: any) {
        console.warn(`[orchestrator.inject] autospawn replay failed session=${sessionId}: ${err?.message ?? err}`)
      }
    },
    send,
  }

  const req: DispatchRequest = { userId, sessionId, token, prompt }
  const outcome = await deps.dispatch(req, deployDeps)

  switch (outcome.kind) {
    case 'parked_offline':
      // Expected: session still connecting; the parked replay delivers on drain.
      return { kind: 'autospawn_launched' }
    case 'dispatched':
      // The runner connected fast enough to be online at dispatch — already sent.
      return { kind: 'autospawn_launched' }
    case 'queued':
      return { kind: 'autospawn_parked' }
    case 'dropped_busy':
      return { kind: 'autospawn_parked' }
    case 'skipped': {
      const reason = outcome.reason
      const isCostCap =
        reason.startsWith('over_daily_cost_cap') ||
        reason.startsWith('programmatic_credit_halt') ||
        reason.startsWith('over_daily_token_cap')
      return isCostCap ? { kind: 'refused_cost_cap', reason } : { kind: 'refused', reason }
    }
    case 'failed':
      return { kind: 'failed', reason: outcome.reason }
  }
}
