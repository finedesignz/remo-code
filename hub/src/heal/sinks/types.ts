// hub/src/heal/sinks/types.ts
//
// PTYCAP-07-05 (D-05, D-06): the per-event sink contract. A sink is created per event by an
// injected factory and owns the source-specific run bookkeeping (the event's metadata or
// trigger rows). routeHeal talks to it only through this interface.

import type { RunStore, DispatchRequest } from '../../dispatch/pipeline.ts';
import type { HealEvent, HealOutcome } from '../types.ts';

/** Outcomes that need the sink to terminalize the event's run rows. */
export type HealTerminalOutcome = Extract<
  HealOutcome,
  { kind: 'no_routable_session' | 'refused' | 'failed' | 'deduped' }
>;

export interface HealSink extends RunStore {
  /** Ship the heal turn to the live session (called once by the pipeline on a claim). */
  send(req: DispatchRequest): Promise<void>;
  /**
   * Terminalize the event's metadata / trigger rows for no_routable_session, refused, failed
   * and deduped. IDEMPOTENT: first writer wins, a terminal row is never overwritten (the
   * pipeline's gate-time markSkipped may already have finalized it).
   */
  finalizeTerminal(outcome: HealTerminalOutcome): Promise<void>;
  /** Parked-offline request whose grace lapsed: a heal turn is never replayed later. */
  onParkExpire(req: DispatchRequest): Promise<void>;
}

export interface SinkContext {
  /** The heal_events ledger id; null when the claim itself did not happen / failed. */
  eventId: string | null;
}

export type SinkFactory = (event: HealEvent, ctx: SinkContext) => HealSink | Promise<HealSink>;
