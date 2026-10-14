// hub/src/heal/sweep.ts
//
// PTYCAP-07-06 (SC4, T-07-21, T-07-24): boot-time sweep for heal launches stranded by a hub
// restart. The spawn deadline timer in route.ts is process-local, so a restart inside the spawn
// window would leave the event's metadata run pending until the 6h reaper. Run ONCE at boot (event
// driven, no interval timer), flag-gated by the caller AND re-checked here, best-effort per row,
// bounded, idempotent through the sink.

import { healUnifiedEnabled, healSpawnTimeoutMs } from './config.ts';
import { notifyOnce, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';
import type { HealEvent } from './types.ts';
import type { HealOutcomeExtra, HealEventRow } from '../db/heal-events-dal.ts';
import type { SinkFactory } from './sinks/types.ts';

/** Hard bound per boot, matching listStaleLaunchingHealEvents' LIMIT. */
export const SWEEP_BATCH = 50;

const STRANDED = new Set(['autospawn_launched', 'autospawn_parked']);

export interface SweepDeps {
  list(olderThanMs: number): Promise<HealEventRow[]>;
  reread(id: string): Promise<{ outcome: string | null } | null>;
  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
  makeSink: SinkFactory;
  release(userId: string, repoIdent: string, eventId: string): Promise<void>;
  notify?: NotifyDeps;
}

/** Real collaborators: lazy imports, so a flag-OFF boot loads nothing of this. */
export const REAL_SWEEP_DEPS: SweepDeps = {
  list: async (olderThanMs) => (await import('../db/heal-events-dal.ts')).listStaleLaunchingHealEvents(olderThanMs),
  reread: async (id) => (await import('../db/heal-events-dal.ts')).getHealEvent(id),
  setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
  makeSink: async (event, ctx) => {
    const spec = './sinks/index.ts';
    const mod = await import(spec);
    return (mod.makeHealSink as SinkFactory)(event, ctx);
  },
  release: async (userId, repoIdent, eventId) =>
    (await import('./route.ts')).releaseHealReservation(userId, repoIdent, eventId),
};

function log(msg: string): void {
  console.error(`[heal.sweep] ${msg}`);
}

/** The ledger row carries only identity and run ids; that is all a sink needs to terminalize. */
function eventFromRow(row: HealEventRow): HealEvent {
  return {
    source: row.source,
    user_id: row.user_id,
    repo_ident: row.repo_ident,
    dedupe_key: row.dedupe_key,
    metadata_run_id: row.metadata_run_id,
    trigger_run_id: row.trigger_run_id,
    prompt: '',
    stored_content: '',
    ctx: {},
  } as unknown as HealEvent;
}

export interface SweepResult {
  swept: number;
  skipped: number;
  failed: number;
}

export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, skipped: 0, failed: 0 };
  if (!healUnifiedEnabled()) return result; // flag OFF: nothing is read, nothing is touched

  let rows: HealEventRow[];
  try {
    rows = (await deps.list(2 * healSpawnTimeoutMs())).slice(0, SWEEP_BATCH);
  } catch (err: any) {
    log(`list failed: ${err?.message ?? err}`);
    return result;
  }

  for (const row of rows) {
    try {
      const fresh = await deps.reread(row.id);
      if (!fresh || !fresh.outcome || !STRANDED.has(fresh.outcome)) {
        result.skipped++; // another writer already moved it on
        continue;
      }
      const event = eventFromRow(row);
      const sink = await deps.makeSink(event, { eventId: row.id });
      await sink.finalizeTerminal({ kind: 'failed', reason: 'heal_spawn_timeout' });
      if (row.repo_ident) await deps.release(row.user_id, row.repo_ident, row.id);
      await deps.setOutcome(row.id, 'failed:spawn_timeout', {});
      await notifyOnce(row.id, event, 'spawn_timeout', deps.notify ?? REAL_NOTIFY_DEPS);
      result.swept++;
    } catch (err: any) {
      result.failed++;
      log(`row ${row.id} failed (left for the next boot): ${err?.message ?? err}`);
    }
  }
  if (result.swept || result.failed) log(`boot sweep: ${JSON.stringify(result)}`);
  return result;
}
