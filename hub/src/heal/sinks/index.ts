// hub/src/heal/sinks/index.ts
//
// PTYCAP-07-07 (SH-01, SH-06): the static source -> sink map. Sink modules are loaded lazily so
// importing this file never loads the DB. An unknown source cannot be constructed.

import type { HealEvent, HealSource } from '../types.ts';
import type { CoolifyDeps } from './coolify.ts';
import type { ErrorCaptureDeps } from './error-capture.ts';
import type { LedgerSinkDeps } from './shared.ts';
import type { HealSink, SinkContext } from './types.ts';

/** Per-source collaborator overrides; production passes none. */
export interface SinkDeps {
  coolify?: CoolifyDeps;
  errorCapture?: ErrorCaptureDeps;
  ledger?: LedgerSinkDeps;
}

type Builder = (event: HealEvent, ctx: SinkContext, deps: SinkDeps) => Promise<HealSink>;

const SINKS: Record<HealSource, Builder> = {
  coolify_deploy: async (event, ctx, deps) => (await import('./coolify.ts')).buildCoolifySink(event, ctx, deps.coolify),
  scheduled_task: async (event, ctx, deps) => (await import('./scheduled-task.ts')).buildScheduledTaskSink(event, ctx, deps.ledger),
  error_capture: async (event, ctx, deps) => (await import('./error-capture.ts')).buildErrorCaptureSink(event, ctx, deps.errorCapture),
  feedback: async (event, ctx, deps) => (await import('./feedback.ts')).buildFeedbackSink(event, ctx, deps.ledger),
};

export async function sinkFor(event: HealEvent, ctx: SinkContext, deps: SinkDeps = {}): Promise<HealSink> {
  const build = Object.prototype.hasOwnProperty.call(SINKS, event.source) ? SINKS[event.source] : undefined;
  if (!build) throw new Error(`unknown_heal_source: ${String((event as { source?: unknown }).source)}`);
  return build(event, ctx, deps);
}

/** The SinkFactory route.ts resolves at call time. */
export const makeHealSink = (event: HealEvent, ctx: SinkContext): Promise<HealSink> => sinkFor(event, ctx);
