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
import { thresholdGate, dailyCostCapGate } from '../dispatch/gates.ts'

export type InjectOutcome =
  | { kind: 'dispatched' }
  | { kind: 'queued' }
  | { kind: 'refused_cost_cap'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'no_session' }
  | { kind: 'failed'; reason: string }

export interface InjectInput {
  userId: string
  sessionId: string
  /** stable token (finalize key) — orchestrator uses `orch:<sessionId>:<command>:<ts>`. */
  token: string
  /** the composed templated prompt (command-prompts.ts). */
  prompt: string
}

/** Injectable seam for tests: lets the seam swap the real `dispatch()` for a spy. */
export interface InjectDeps {
  dispatch: typeof dispatch
  getChannel: typeof getChannel
}

const REAL_DEPS: InjectDeps = { dispatch, getChannel }

/**
 * Inject a templated orchestrator prompt into the bound session via the shared
 * dispatch pipeline. The gate list is `[thresholdGate, dailyCostCapGate]` — the
 * SAME list the scheduler's session adapter uses — so the daily cost cap is
 * non-bypassable (IR-1).
 *
 * Outcome mapping:
 *   - dispatched      → prompt sent on the agent socket (finalize lands later).
 *   - queued          → behind an in-flight turn; promotion re-dispatches.
 *   - refused_cost_cap→ gate blocked on `over_daily_cost_cap` / `programmatic_credit_halt`.
 *   - refused         → gate blocked for another reason (threshold quota).
 *   - no_session      → no agent socket online for this session (we do NOT launch).
 *   - failed          → the send threw.
 *
 * The orchestrator deliberately does NOT park offline / autostart the session
 * (unlike the scheduler): a routine cycle only fires for a session the controller
 * already considers active; an offline session is reported `no_session` and the
 * controller reconciles next tick. This keeps the seam minimal.
 */
export async function injectOrchestratorPrompt(
  input: InjectInput,
  deps: InjectDeps = REAL_DEPS,
): Promise<InjectOutcome> {
  const { userId, sessionId, token, prompt } = input

  // The orchestrator does not launch offline sessions (see doc above).
  if (deps.getChannel(sessionId) == null) return { kind: 'no_session' }

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

  const deployDeps: PipelineDeps = {
    // IR-1: cost-cap non-bypassable. Threshold → cost-cap, identical to the
    // scheduler's session adapter gate list.
    gates: [thresholdGate, dailyCostCapGate],
    store,
    isOnline: (req) => deps.getChannel(req.sessionId) != null,
    // The orchestrator does not park/replay offline turns (see doc). A turn that
    // reaches park is unexpected (we gated on getChannel above) — treat as no-op.
    replay: async () => {},
    send: async (req) => {
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
    },
  }

  const req: DispatchRequest = { userId, sessionId, token, prompt }
  const outcome = await deps.dispatch(req, deployDeps)

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
