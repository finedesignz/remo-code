// hub/src/heal/sinks/shared.ts
//
// PTYCAP-07-07: helpers shared by the per-source heal sinks. Collaborators are injected with
// lazy real defaults so a sink is testable without module mocking and importing this file never
// loads the DB.

import type { DispatchRequest } from '../../dispatch/pipeline.ts';
import type { HealEvent } from '../types.ts';
import type { HealSink, SinkContext } from './types.ts';

export interface AgentChannel {
  ws: { send(data: string): void };
}

export interface SendDeps {
  getChannel(sessionId: string): AgentChannel | null | undefined | Promise<AgentChannel | null | undefined>;
  insertMessage(sessionId: string, role: string, content: string): Promise<{ id: string; created_at: unknown }>;
  broadcastToSubscribers(sessionId: string, message: object): unknown;
}

export const REAL_SEND_DEPS: SendDeps = {
  getChannel: async (sessionId) => (await import('../../ws/registry.ts')).getChannel(sessionId) as AgentChannel | undefined,
  insertMessage: async (sessionId, role, content) => (await import('../../db/dal.ts')).insertMessage(sessionId, role, content) as unknown as { id: string; created_at: unknown },
  broadcastToSubscribers: async (sessionId, message) => (await import('../../ws/registry.ts')).broadcastToSubscribers(sessionId, message),
};

export interface SendOptions {
  /** What the chat history shows (the framed form); the agent receives req.prompt. */
  storedContent: string;
  images?: Array<{ media_type: string; data: string }>;
  /** Added to the broadcast and the frame only when supplied. */
  runId?: string;
  broadcast?: boolean;
  /** Error thrown when the agent channel is gone (default session_offline). */
  offlineError?: string;
}

/** Persist the user message, optionally fan it out to subscribers, and write the user_message frame. */
export async function sendUserMessage(req: DispatchRequest, opts: SendOptions, deps: SendDeps = REAL_SEND_DEPS): Promise<void> {
  const channel = await deps.getChannel(req.sessionId);
  if (!channel) throw new Error(opts.offlineError ?? 'session_offline');
  const msg = await deps.insertMessage(req.sessionId, 'user', opts.storedContent);
  if (opts.broadcast) {
    await deps.broadcastToSubscribers(req.sessionId, {
      type: 'message',
      session_id: req.sessionId,
      message: msg,
      ...(opts.runId ? { run_id: opts.runId } : {}),
    });
  }
  const images = opts.images ?? req.images;
  const frame: Record<string, unknown> = { type: 'user_message', id: msg.id, content: req.prompt, ts: msg.created_at };
  if (opts.runId) frame.run_id = opts.runId;
  if (images?.length) frame.images = images;
  channel.ws.send(JSON.stringify(frame));
}

export interface LedgerSinkDeps {
  send?: SendDeps;
  /**
   * Optional observer for sink callbacks. The ledger has no detail column; the outcome string the
   * route persists is the record, so there is no default writer.
   */
  recordDetail?: (eventId: string | null, detail: string) => unknown;
}

/**
 * A sink for sources with no run table (scheduled_task, feedback): the dispatch token is
 * `heal:{eventId}` and the ledger row is the record. Nothing here can create a child run.
 */
export function buildLedgerOnlySink(event: HealEvent, ctx: SinkContext, deps: LedgerSinkDeps = {}): HealSink {
  const note = async (detail: string) => {
    try {
      await deps.recordDetail?.(ctx.eventId, detail);
    } catch {
      /* observer only */
    }
  };
  return {
    async open(req) {
      return req.token;
    },
    async markSkipped(_token, reason) {
      await note(`skipped:${reason}`);
    },
    async onFinalize() {
      await note('finalized');
    },
    async markFailed(_token, error) {
      await note(`failed:${error}`);
    },
    send: (req) => sendUserMessage(req, { storedContent: event.stored_content }, deps.send),
    async finalizeTerminal() {},
    async onParkExpire() {
      await note('park_expired');
    },
  };
}
