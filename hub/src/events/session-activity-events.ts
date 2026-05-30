/**
 * Internal hub event bus for SESSION ACTIVITY (tool-use one-liners).
 *
 * Mirrors `events/assistant-events.ts` + `events/permission-events.ts`: a
 * read-only fanout for server-side consumers. The Telegram outbound bridge
 * subscribes and folds these into the editable "working…" message it maintains
 * per (chat, session) while a turn is in flight. The final assistant text still
 * arrives via the separate `assistant_message:final` bus.
 *
 * Scope (kept deliberately tiny):
 *   - `tool_use` only. `thinking` and raw `text_delta` are NEVER emitted here —
 *     the bridge collapses tool calls to one-liners and shows the final text in
 *     full; intermediate token noise is intentionally dropped.
 *
 * This is NOT a dispatch path. Dispatch (inbound user→session) lives in
 * `hub/src/dispatch/`. This bus is outbound-only and side-effect free for the
 * emitter — listener errors are isolated so a bridge throw can't tear down the
 * WS handler in `ws/agent.ts`.
 */

import { EventEmitter } from "node:events";

export interface SessionActivityEvent {
  /** Session that produced the activity. */
  sessionId: string;
  /** Owning user of the session (known at emit time in ws/agent.ts). */
  userId: string;
  /** Activity kind. Only "tool_use" is emitted today. */
  kind: "tool_use";
  /** Tool name (e.g. "Edit", "Bash", "Read"). */
  toolName: string;
  /** Best-effort one-line target (file path / command / url); may be empty. */
  detail?: string;
}

export type SessionActivityListener = (e: SessionActivityEvent) => void | Promise<void>;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const EVENT = "session_activity";

/** Emit a session-activity event. Listener errors are isolated. */
export function emitSessionActivity(e: SessionActivityEvent): void {
  const listeners = emitter.listeners(EVENT) as SessionActivityListener[];
  for (const fn of listeners) {
    try {
      const ret = fn(e);
      if (ret && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch((err: any) => {
          console.warn(`[session-activity-events] async listener error: ${err?.message ?? err}`);
        });
      }
    } catch (err: any) {
      console.warn(`[session-activity-events] listener threw: ${err?.message ?? err}`);
    }
  }
}

/** Subscribe to session-activity events. Returns an unsubscribe fn. */
export function onSessionActivity(listener: SessionActivityListener): () => void {
  emitter.on(EVENT, listener as any);
  return () => emitter.off(EVENT, listener as any);
}

/** Test-only — remove every listener. */
export function _resetSessionActivityEventsForTests(): void {
  emitter.removeAllListeners(EVENT);
}
