/**
 * Internal hub event bus for PENDING multiple-choice / AskUserQuestion prompts.
 *
 * Mirrors `events/permission-events.ts` exactly. A single event type
 * (`user_question:pending`) is fired from `ws/agent.ts` the moment a runner
 * forwards a `user_question` (AskUserQuestion / elicitation / side_question).
 * The Telegram bridge subscribes and surfaces the question inline with one
 * button per option for any user whose `telegram_default_session_id` matches
 * the emitting session.
 *
 * Why a separate bus (same rationale as permission-events):
 *   - The WS broadcast registry fans only to subscribed browser clients. A
 *     server-side consumer (the Telegram bridge) needs a fanout that doesn't
 *     require a fake WS subscription.
 *   - Keeps `ws/agent.ts` ignorant of cross-cutting consumers.
 *
 * Failure isolation: every listener invocation is guarded so a misbehaving
 * listener can't tear down the WS handler that emitted the event.
 */

import { EventEmitter } from "node:events";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionPendingEvent {
  /** Session that raised the question prompt. */
  sessionId: string;
  /** Owning user of the session (known at emit time in ws/agent.ts). */
  userId: string;
  /** The runner's request id — echoed back in question_response. */
  requestId: string;
  /** The question text shown to the user. */
  question: string;
  /** Choice options (label + optional description). May be empty (free-form). */
  options: QuestionOption[];
  /** When true, the user may pick more than one option. */
  isMultiSelect: boolean;
}

export type QuestionPendingListener = (e: QuestionPendingEvent) => void | Promise<void>;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const EVENT = "user_question:pending";

/** Emit a pending-question event. Listener errors are isolated. */
export function emitQuestionPending(e: QuestionPendingEvent): void {
  const listeners = emitter.listeners(EVENT) as QuestionPendingListener[];
  for (const fn of listeners) {
    try {
      const ret = fn(e);
      if (ret && typeof (ret as Promise<void>).catch === "function") {
        (ret as Promise<void>).catch((err: any) => {
          console.warn(`[question-events] async listener error: ${err?.message ?? err}`);
        });
      }
    } catch (err: any) {
      console.warn(`[question-events] listener threw: ${err?.message ?? err}`);
    }
  }
}

/** Subscribe to pending-question events. Returns an unsubscribe fn. */
export function onQuestionPending(listener: QuestionPendingListener): () => void {
  emitter.on(EVENT, listener as any);
  return () => emitter.off(EVENT, listener as any);
}

/** Test-only — remove every listener. */
export function _resetQuestionEventsForTests(): void {
  emitter.removeAllListeners(EVENT);
}
