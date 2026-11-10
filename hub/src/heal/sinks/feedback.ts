// hub/src/heal/sinks/feedback.ts
//
// PTYCAP-07-07: feedback has no run table (the message row and the ledger outcome are the
// record). The shared ledger-only sink's send carries the screenshot images when present.
// No ensure-online hook exists here (AM-F1-5).

import type { HealEvent } from '../types.ts';
import { buildLedgerOnlySink, type LedgerSinkDeps } from './shared.ts';
import type { HealSink, SinkContext } from './types.ts';

export function buildFeedbackSink(event: HealEvent, ctx: SinkContext, deps: LedgerSinkDeps = {}): HealSink {
  return buildLedgerOnlySink(event, ctx, deps);
}
