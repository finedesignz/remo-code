// hub/src/heal/sinks/scheduled-task.ts
//
// PTYCAP-07-07: scheduled-task heals keep no run table and never create a scheduled run (the
// trigger run is already terminal), so there is nothing here that could recurse.

import type { HealEvent } from '../types.ts';
import { buildLedgerOnlySink, type LedgerSinkDeps } from './shared.ts';
import type { HealSink, SinkContext } from './types.ts';

export function buildScheduledTaskSink(event: HealEvent, ctx: SinkContext, deps: LedgerSinkDeps = {}): HealSink {
  return buildLedgerOnlySink(event, ctx, deps);
}
