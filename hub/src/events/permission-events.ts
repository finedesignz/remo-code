/**
 * Internal hub event bus for PENDING permission/approval prompts.
 *
 * Mirrors `events/assistant-events.ts`: a single event type
 * (`permission_request:pending`) fired from `ws/agent.ts` the moment a runner
 * forwards a `permission_request`. The Telegram bridge subscribes and surfaces
 * the prompt inline with Approve/Deny buttons for any user whose
 * `telegram_default_session_id` matches the emitting session.
 *
 * Why a separate bus (same rationale as assistant-events):
 *   - The WS broadcast registry fans only to subscribed browser clients. A
 *     server-side consumer (the Telegram bridge) needs a fanout that doesn't
 *     require a fake WS subscription.
 *   - Keeps `ws/agent.ts` ignorant of cross-cutting consumers.
 *
 * Failure isolation: every listener invocation is guarded so a misbehaving
 * listener can't tear down the WS handler that emitted the event.
 */

import { EventEmitter } from "node:events";

export interface PermissionPendingEvent {
  /** Session that raised the permission prompt. */
  sessionId: string;
  /** Owning user of the session (known at emit time in ws/agent.ts). */
  userId: string;
  /** The runner's permission request id — echoed back in permission_response. */
  requestId: string;
  /** Tool the agent wants to use (e.g. "Bash", "Write"). */
  toolName: string;
  /** Raw tool input (unknown shape); rendered best-effort for the prompt text. */
  toolInput?: unknown;
}

export type PermissionPendingListener = (e: PermissionPendingEvent) => void | Promise<void>;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const EVENT = "permission_request:pending";

/** Emit a pending-permission event. Listener errors are isolated. */
export function emitPermissionPending(e: PermissionPendingEvent): void {
  const listeners = emitter.listeners(EVENT) as PermissionPendingListener[];
  for (const fn of listeners) {
    try {
      const ret = fn(e);
      if (ret && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch((err: any) => {
          console.warn(`[permission-events] async listener error: ${err?.message ?? err}`);
        });
      }
    } catch (err: any) {
      console.warn(`[permission-events] listener threw: ${err?.message ?? err}`);
    }
  }
}

/** Subscribe to pending-permission events. Returns an unsubscribe fn. */
export function onPermissionPending(listener: PermissionPendingListener): () => void {
  emitter.on(EVENT, listener as any);
  return () => emitter.off(EVENT, listener as any);
}

/** Test-only — remove every listener. */
export function _resetPermissionEventsForTests(): void {
  emitter.removeAllListeners(EVENT);
}
