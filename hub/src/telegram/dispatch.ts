/**
 * Phase 12 — Telegram inbound dispatch.
 *
 * Routes a Telegram-sourced text + optional images to a session's agent
 * socket as a `user_message`. Discipline mirrors `scheduler/senders/agent.ts`
 * but does NOT create a `scheduled_task_runs` row — this is user-driven
 * traffic, not a scheduled task. We still go through:
 *
 *   1. Daily cost cap (per-user, per-tz) — same numbers the scheduler enforces.
 *   2. Per-session queue (`session-queue.ts`) — 1 in-flight + 1 waiter, exact
 *      same primitive the scheduler uses. We synthesize a token of shape
 *      `tg:<chatId>:<updateId>` as the queue's runId so Telegram bursts get
 *      serialized identically to scheduled-task bursts.
 *   3. Insert the user-typed message into `messages` so it appears in the
 *      web UI alongside web-typed messages. The Telegram source is recorded
 *      in `telegram_inbound_audit` (chat_id, update_id) — NOT as a string
 *      prefix on the message content.
 *   4. Broadcast to web subscribers, then push `user_message` onto the agent
 *      socket.
 *
 * Cost cap check is replicated locally (not exported from the scheduler) so
 * the Telegram path has no dependency on scheduler-internal helpers.
 */
import type { ServerWebSocket } from "bun";
import { insertMessage } from "../db/dal.ts";
import { sql } from "../db/postgres.ts";
import { sumTodayCostForUser } from "../db/scheduled-tasks-dal.ts";
import { broadcastToSubscribers, getChannel } from "../ws/registry.ts";
import * as queue from "../scheduler/session-queue.ts";

export type DispatchOutcome =
  | { kind: "dispatched" }
  | { kind: "no_session" }
  | { kind: "cost_capped"; resumesAtUtc: string }
  | { kind: "session_busy" }
  | { kind: "agent_offline" }
  | { kind: "failed"; reason: string };

export interface DispatchInput {
  userId: string;
  sessionId: string;
  chatId: number | bigint | string;
  updateId: number | bigint;
  text: string;
  /** base64 data URIs, matches web-client `send_message` shape. */
  images?: string[];
}

/**
 * Returns true when the user has exceeded their daily cost cap.
 * Mirrors `hub/src/scheduler/dispatcher.ts::isOverCostCap` — kept local so
 * the Telegram path doesn't reach into scheduler internals.
 */
export async function isOverCostCap(userId: string): Promise<boolean> {
  const rows = await sql<{ cap: string; tz: string }[]>`
    SELECT daily_cost_cap_usd::text AS cap, COALESCE(timezone, 'UTC') AS tz
      FROM users
     WHERE id = ${userId}
     LIMIT 1
  `;
  const cap = Number(rows[0]?.cap ?? 10);
  if (!Number.isFinite(cap) || cap <= 0) return false;
  const tz = rows[0]?.tz || "UTC";
  const spent = await sumTodayCostForUser(userId, tz);
  return spent >= cap;
}

/** Next UTC midnight as an ISO string — used for the throttle reply text. */
export function nextUtcResetIso(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return d.toISOString();
}

/**
 * Dispatch a Telegram-sourced message to the user's agent session.
 *
 * NOTE: This function does NOT itself reply to Telegram. The caller is
 * responsible for translating the `DispatchOutcome` into a Telegram message
 * (so the webhook handler controls reply throttling and user-facing copy).
 */
export async function dispatchToSession(input: DispatchInput): Promise<DispatchOutcome> {
  if (!input.sessionId) return { kind: "no_session" };

  // (1) Cost cap.
  try {
    if (await isOverCostCap(input.userId)) {
      return { kind: "cost_capped", resumesAtUtc: nextUtcResetIso() };
    }
  } catch (err: any) {
    // A cost-cap query failure must not silently let traffic bypass the cap.
    // Treat as failed so the user gets a generic error rather than a free pass.
    return { kind: "failed", reason: `cost_cap_check_failed: ${err?.message}` };
  }

  // (2) Per-session queue (synthetic token).
  const queueToken = `tg:${input.chatId}:${input.updateId}`;
  const claim = queue.enqueue(input.sessionId, queueToken);
  if (claim === "dropped") return { kind: "session_busy" };
  // 'queued' is fine — the scheduler's idle promotion path will fire it
  // when the in-flight run finishes. For Telegram we don't currently have a
  // promote handler wired (Wave 3 territory), so 'queued' effectively means
  // "we'll send when the slot frees" — but we still need to materialize the
  // message NOW so the user sees it in the web UI and Claude sees it on its
  // next turn. We proceed to send immediately on both 'dispatched' and
  // 'queued' — the queue's job here is just admission control / backpressure.

  // (3) Look up the agent socket. Offline → release the slot and report.
  const channel = getChannel(input.sessionId);
  const sock = (channel?.ws as ServerWebSocket<any> | undefined) ?? null;
  if (!sock) {
    // Free the queue slot so a future dispatch isn't blocked by a phantom.
    queue.abandon(input.sessionId);
    return { kind: "agent_offline" };
  }

  // (4) Build payload + persist + broadcast + send.
  // NOTE: storedContent is the RAW user text (no `[telegram] ` prefix).
  // The telegram source is recorded separately in the `telegram_inbound_audit`
  // row written by the webhook (keyed by chat_id + update_id). When/if a
  // first-class `messages.source` column lands, filtering should switch to
  // that — never re-introduce a string prefix that the web UI has to grep.
  const storedContent = input.text;
  let msg: { id: string; created_at: string };
  try {
    msg = (await insertMessage(input.sessionId, "user", storedContent)) as { id: string; created_at: string };
  } catch (err: any) {
    queue.abandon(input.sessionId);
    return { kind: "failed", reason: `insert_message_failed: ${err?.message}` };
  }

  broadcastToSubscribers(input.sessionId, {
    type: "message",
    session_id: input.sessionId,
    message: msg,
  });

  try {
    sock.send(
      JSON.stringify({
        type: "user_message",
        id: msg.id,
        content: input.text,
        ts: msg.created_at,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      }),
    );
  } catch (err: any) {
    queue.abandon(input.sessionId);
    return { kind: "failed", reason: `agent_send_failed: ${err?.message}` };
  }

  return { kind: "dispatched" };
}
