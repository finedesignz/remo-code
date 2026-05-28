/**
 * Phase 12 Wave 3 — internal hub event bus for FINAL assistant messages.
 *
 * Carries one event type only — `assistant_message:final` — fired AFTER the
 * agent's `assistant_message` event has been persisted. Streaming
 * `text_delta` / `thinking` / `tool_use` / `tool_result` are NEVER emitted on
 * this bus. The Telegram outbound bridge (the only current subscriber) only
 * wants the final, fully-assembled text.
 *
 * Why a separate bus instead of piggy-backing on the WS broadcast registry:
 *   1. The WS registry fans events to subscribed browser clients only. Server-
 *      side consumers (Telegram bridge, future Slack/Discord bridges) need a
 *      different fanout path that doesn't require a fake WS subscription.
 *   2. Keeps the WS layer ignorant of cross-cutting consumers. The bridge can
 *      be removed/added without touching `ws/agent.ts` again.
 *
 * Failure isolation: every listener invocation is wrapped in try/catch. A
 * misbehaving listener (throw, unhandled rejection) MUST NOT crash the WS
 * handler that emitted the event. Errors are console.warn'd.
 */

import { EventEmitter } from "node:events";

export interface AssistantMessageFinalEvent {
  /** Session that produced the message. */
  sessionId: string;
  /** Owning user of the session (already known at emit time). */
  userId: string;
  /** Fully assembled final text (post-finalize / post-insert). */
  text: string;
  /** DB id of the persisted assistant message, if known. */
  messageId?: string;
}

export type AssistantMessageFinalListener = (e: AssistantMessageFinalEvent) => void | Promise<void>;

// Single global emitter. Bun reloads do NOT create a new emitter (the module
// is cached); the `startTelegramBridge` started-flag handles double-subscribe
// guarding on top.
const emitter = new EventEmitter();
emitter.setMaxListeners(50); // generous — many internal consumers possible

const EVENT = "assistant_message:final";

/**
 * Emit a final assistant-message event. Safe to call from anywhere on the
 * server — listener errors are isolated.
 */
export function emitAssistantMessageFinal(e: AssistantMessageFinalEvent): void {
  // Snapshot listeners and invoke each guarded individually so one bad
  // listener can't poison the rest. EventEmitter's default behavior would
  // bubble a throw out of `emit()` into the caller (ws/agent.ts), which
  // would tear down the WS message handler. We never want that.
  const listeners = emitter.listeners(EVENT) as AssistantMessageFinalListener[];
  for (const fn of listeners) {
    try {
      const ret = fn(e);
      if (ret && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch((err: any) => {
          console.warn(`[assistant-events] async listener error: ${err?.message ?? err}`);
        });
      }
    } catch (err: any) {
      console.warn(`[assistant-events] listener threw: ${err?.message ?? err}`);
    }
  }
}

/** Subscribe to final assistant messages. Returns an unsubscribe fn. */
export function onAssistantMessageFinal(listener: AssistantMessageFinalListener): () => void {
  emitter.on(EVENT, listener as any);
  return () => emitter.off(EVENT, listener as any);
}

/** Test-only — remove every listener (used by bun:test mocks). */
export function _resetAssistantEventsForTests(): void {
  emitter.removeAllListeners(EVENT);
}
