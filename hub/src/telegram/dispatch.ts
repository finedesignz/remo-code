/**
 * Phase 12 — Telegram inbound dispatch (Round-2 migration — now an adapter over
 * the shared session-dispatch pipeline `hub/src/dispatch/`).
 *
 * Routes a Telegram-sourced text + optional images to a session's agent socket
 * as a `user_message`. Previously this module hand-rolled a LOCAL copy of the
 * daily-cost-cap SQL → per-session queue claim → agent-socket send. All of that
 * now lives behind `dispatch()` in `hub/src/dispatch/pipeline.ts`.
 *
 * Telegram is USER traffic, not a scheduled task, so:
 *   - `store: null` — no run row. The pipeline tolerates a null store (skips
 *     open/markSkipped/onFinalize/markFailed).
 *   - gates threshold → cost-cap → TOKEN-cap → human-only guard. The locally-
 *     replicated `isOverCostCap` copy is GONE; the shared `dailyCostCapGate` is
 *     the single source of truth (IR-1: cost-cap non-bypassable), and
 *     `dailyTokenCapGate` rides alongside it (fix/stop-the-bleed — the dollar cap
 *     is meaningless on a flat-rate Max plan; the token ceiling is the real one).
 *   - `token: tg:<chatId>:<updateId>` — the existing convention (queue token +
 *     dedupe-friendly; the webhook's (chat_id, update_id) audit row is the real
 *     dedupe).
 *   - `send` — persists the user message into `messages`, broadcasts it to web
 *     subscribers, then pushes `user_message` (with `images[]`) onto the agent
 *     socket. Fires exactly once on a real dispatch (or on promotion of a queued
 *     waiter).
 *
 * OUTPUT path is unchanged: Telegram replies are forwarded by the OUTBOUND
 * bridge (`telegram/bridge.ts`, subscribing to the `assistant_message:final`
 * event bus, gated on `telegram_default_session_id === emitting_session_id`),
 * NOT by a finalize hook. There is no run row to finalize, so the pipeline's
 * `onSessionReply` no-ops for telegram (null store) while still promoting any
 * queued same-session waiter.
 *
 * NOTE: This function does NOT itself reply to Telegram. The caller maps the
 * `DispatchOutcome` to a Telegram message (so the webhook controls reply
 * throttling and user-facing copy). On `agent_offline` the message is parked in
 * the shared grace buffer; on agent reconnect the agent-ws drain re-runs the
 * `replay` thunk, delivering the buffered message once (#163 auto-replay).
 */
import type { ServerWebSocket } from "bun";
import { insertMessage } from "../db/dal.ts";
import { broadcastToSubscribers, getChannel } from "../ws/registry.ts";
import {
  dispatch,
  type DispatchRequest,
  type PipelineDeps,
} from "../dispatch/pipeline.ts";
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, humanOnlyPtyGate } from "../dispatch/gates.ts";
import { getSessionRunnerType } from "../db/dal.ts";

export type DispatchOutcome =
  | { kind: "dispatched" }
  | { kind: "no_session" }
  | { kind: "cost_capped"; resumesAtUtc: string }
  | { kind: "session_busy" }
  | { kind: "agent_offline" }
  | { kind: "automation_blocked"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Phase 20 (R-TG-11): the dispatch SOURCE actor. A genuine human Telegram
 * message is `'human'` (the only source that may drive a pty-interactive
 * session). Automation that tries to ride the Telegram inbound path
 * (auto-nudge / scheduled) names itself and is REJECTED by the Phase-16
 * human-only guard before any PTY injection — "robot pressing enter via the
 * interactive entrypoint" is the ToS-risk move (constraint 3).
 */
export type TelegramDispatchSource = "human" | "scheduler" | "orchestrator-background" | "auto-dev" | "error-capture";

export interface DispatchInput {
  userId: string;
  sessionId: string;
  chatId: number | bigint | string;
  updateId: number | bigint;
  text: string;
  /** base64 data URIs, matches web-client `send_message` shape. */
  images?: string[];
  /** Source actor (default 'human'). Automation sources are guard-rejected on a
   *  pty-interactive session. */
  source?: TelegramDispatchSource;
}

/** Next UTC midnight as an ISO string — used for the throttle reply text. */
export function nextUtcResetIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return d.toISOString();
}

/**
 * Convert telegram base64 data URIs (`data:<mime>;base64,<b64>`) to the
 * pipeline's `{ media_type, data }` image shape. The agent-socket frame we send
 * still uses the raw data-URI strings (web-client `send_message` parity), so we
 * keep the originals around for the send; the pipeline `images` field is carried
 * only so a future gate/store could inspect them.
 */
function toPipelineImages(images?: string[]): DispatchRequest["images"] {
  if (!images || images.length === 0) return undefined;
  const out: NonNullable<DispatchRequest["images"]> = [];
  for (const uri of images) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(uri);
    if (m) out.push({ media_type: m[1]!, data: m[2]! });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Dispatch a Telegram-sourced message to the user's agent session through the
 * shared pipeline.
 */
export async function dispatchToSession(input: DispatchInput): Promise<DispatchOutcome> {
  if (!input.sessionId) return { kind: "no_session" };

  // Phase 20: the moment a Telegram user dispatches to a session it is
  // telegram-relevant + about to be live — open its transcript source so the
  // outbound bridge + permission surfacing tail it. Idempotent, best-effort
  // (never blocks the dispatch). No-op when the bridge isn't started. Imported
  // LAZILY so dispatch.ts's module-load graph doesn't pull the bridge's
  // commands→launch→supervisor-registry chain (keeps the dispatch unit test's
  // partial ws/registry mock valid).
  void import("./bridge.ts")
    .then((m) => m.ensureSessionSubscribed(input.sessionId))
    .catch((err: any) => {
      console.warn(`[telegram-dispatch] ensureSessionSubscribed failed session=${input.sessionId}: ${err?.message ?? err}`);
    });

  const token = `tg:${input.chatId}:${input.updateId}`;
  const rawImages = input.images && input.images.length > 0 ? input.images : undefined;

  // `send` persists the user message, broadcasts it to web subscribers, then
  // forwards it on the agent socket. Fires once on a real dispatch / promotion.
  // The agent frame uses the RAW data-URI image strings (web-client parity).
  const send = async (req: DispatchRequest): Promise<void> => {
    const channel = getChannel(req.sessionId);
    const sock = (channel?.ws as ServerWebSocket<any> | undefined) ?? null;
    if (!sock) throw new Error("session_offline");

    // storedContent is the RAW user text (no `[telegram] ` prefix). The telegram
    // source is recorded in `telegram_inbound_log` (chat_id + update_id) by the
    // webhook — never as a string prefix the web UI has to grep.
    const msg = (await insertMessage(req.sessionId, "user", req.prompt)) as {
      id: string;
      created_at: string;
    };

    broadcastToSubscribers(req.sessionId, {
      type: "message",
      session_id: req.sessionId,
      message: msg,
    });

    sock.send(
      JSON.stringify({
        type: "user_message",
        id: msg.id,
        content: req.prompt,
        ts: msg.created_at,
        ...(rawImages ? { images: rawImages } : {}),
      }),
    );
  };

  const source: TelegramDispatchSource = input.source ?? "human";

  // R-TG-11: the Phase-16 human-only guard. A pty-interactive session may be
  // driven ONLY by a genuine human turn; an automation-sourced Telegram-origin
  // dispatch is rejected before any PTY injection. The guard reads the SOURCE
  // actor (here, off the dispatch input — Telegram inbound is server-tagged) +
  // the target session's runner_type. Stream-json sessions are unaffected.
  const guard = humanOnlyPtyGate(async () => ({
    actor: source,
    runnerType: await getSessionRunnerType(input.sessionId, input.userId),
  }));

  const deps: PipelineDeps = {
    // IR-1: cost-cap non-bypassable. IR-2: threshold first, then cost-cap.
    // R-TG-11: human-only PTY guard composed WITH (never replacing) the cost cap.
    gates: [thresholdGate, dailyCostCapGate, dailyTokenCapGate, guard],
    // Telegram is user traffic — no run row.
    store: null,
    isOnline: (req) => getChannel(req.sessionId) != null,
    // Offline replay (#163 auto-replay-after-autoheal): re-dispatch the buffered
    // message once the agent reconnects (agent-ws drain runs this thunk).
    replay: async () => {
      await dispatchToSession(input);
    },
    // No run row → nothing to mark on TTL lapse (onParkExpire omitted). The
    // webhook's buffered-replay + autoheal flow handles the user-facing side.
    send,
  };

  const req: DispatchRequest = {
    userId: input.userId,
    sessionId: input.sessionId,
    token,
    prompt: input.text,
    images: toPipelineImages(input.images),
  };

  let outcome;
  try {
    outcome = await dispatch(req, deps);
  } catch (err: any) {
    return { kind: "failed", reason: `dispatch_failed: ${err?.message ?? err}` };
  }

  switch (outcome.kind) {
    case "dispatched":
    // 'queued' means the message is parked behind one in-flight run and will be
    // sent on promotion (onSessionReply re-dispatches through the full gate
    // list). The message is materialized at send-time, same as a direct
    // dispatch — no user-facing error, so we report it as dispatched.
    case "queued":
      return { kind: "dispatched" };
    case "skipped":
      // R-TG-11: the human-only PTY guard rejection is its own outcome — an
      // automation source tried to drive a pty-interactive session and was
      // blocked (logged; nothing injected). Distinct from the cost/threshold
      // cap so the caller can surface the ToS-safe message + audit it.
      if (outcome.reason.startsWith("automation_blocked_on_pty")) {
        console.warn(
          `[telegram-dispatch] human-only guard rejected source=${source} session=${input.sessionId}: ${outcome.reason}`,
        );
        return { kind: "automation_blocked", reason: outcome.reason };
      }
      // The threshold + daily-cost-cap gates land here; both map to "cost_capped"
      // copy (the user can't send until quota/cap frees). resumesAtUtc is the
      // next UTC midnight (the cost-cap reset boundary).
      return { kind: "cost_capped", resumesAtUtc: nextUtcResetIso() };
    case "dropped_busy":
      return { kind: "session_busy" };
    case "parked_offline":
      // Buffered in grace; agent-ws drain re-runs `replay` on reconnect (#163).
      return { kind: "agent_offline" };
    case "failed":
      return { kind: "failed", reason: outcome.reason };
  }
}
