// hub/src/heal/sweep.ts
//
// PTYCAP-07-06 (SC4, T-07-21, T-07-24): sweep for heal launches stranded by a hub restart. The
// spawn deadline timer in route.ts is process-local, so a restart inside the spawn window would
// leave the event's metadata run pending until the 6h reaper. Event driven, no interval timer: one
// sweep at boot plus ONE follow-up at the spawn deadline (QC r1: a row stranded by a quick restart
// is younger than the staleness guard at boot, and would otherwise wait for the next boot). Every
// row stranded at or before boot is older than the guard by the follow-up, so no heal run can stay
// pending past deadline + the follow-up margin. Flag-gated by the caller AND re-checked here,
// best-effort per row, bounded, idempotent through the sink.

import { healUnifiedEnabled, healSpawnTimeoutMs } from './config.ts';
import { OUTCOME_AUTOSPAWN_STARTING } from './types.ts';
import { sweepOwnerEmails, REAL_OWNER_EMAIL_DEPS, type OwnerEmailDeps } from './owner-email.ts';
import { notifyOnce, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';
import type { HealEvent } from './types.ts';
import type { HealOutcomeExtra, HealEventRow } from '../db/heal-events-dal.ts';
import type { SinkFactory } from './sinks/types.ts';

/** Hard bound per boot, matching listStaleLaunchingHealEvents' LIMIT. */
export const SWEEP_BATCH = 50;

/** Starting = claimed and about to reserve/launch (a crash there strands the lifetime slot). */
const STRANDED = new Set([OUTCOME_AUTOSPAWN_STARTING, 'autospawn_launched', 'autospawn_parked']);

/** Slack after the staleness guard before the one follow-up sweep fires. */
export const FOLLOW_UP_MARGIN_MS = 1000;

export interface SweepDeps {
  list(olderThanMs: number): Promise<HealEventRow[]>;
  reread(id: string): Promise<{ outcome: string | null } | null>;
  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
  makeSink: SinkFactory;
  release(userId: string, repoIdent: string, eventId: string): Promise<void>;
  notify?: NotifyDeps;
  /** Owner-email outbox collaborators (defaults to the real DAL + email sender). */
  ownerEmails?: OwnerEmailDeps;
  /** One-shot timer for the follow-up sweep (unref'd in the real binding). */
  setTimer?(fn: () => void, ms: number): unknown;
}

/** Real collaborators: lazy imports, so a flag-OFF boot loads nothing of this. */
export const REAL_SWEEP_DEPS: SweepDeps = {
  ownerEmails: REAL_OWNER_EMAIL_DEPS,
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

/**
 * The ledger row carries identity, run ids, the bound session id and (for error_capture) the
 * minimal recovery_ctx; that is all a sink needs to terminalize.
 */
function eventFromRow(row: HealEventRow): HealEvent {
  return {
    ...(row.session_id ? { bound_session_id: row.session_id } : {}),
    source: row.source,
    user_id: row.user_id,
    repo_ident: row.repo_ident,
    dedupe_key: row.dedupe_key,
    metadata_run_id: row.metadata_run_id,
    trigger_run_id: row.trigger_run_id,
    prompt: '',
    stored_content: '',
    ctx: row.recovery_ctx ?? {},
  } as unknown as HealEvent;
}

export interface SweepResult {
  swept: number;
  skipped: number;
  failed: number;
}

async function sweepStrandedLaunches(deps: SweepDeps): Promise<SweepResult> {
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
      // Two independent obligations: terminalize the SOURCE run and release the RESERVATION. Both are
      // always attempted (a permanent source failure must not strand the slot, a failed release must
      // not strand the source run). The ledger row is closed ONLY when both are confirmed (QC r2): any
      // failure leaves it selectable for the next sweep with its recoverable outcome intact.
      let sinkError: string | null = null;
      try {
        const sink = await deps.makeSink(event, { eventId: row.id });
        await sink.finalizeTerminal({ kind: 'failed', reason: 'heal_spawn_timeout' });
      } catch (err: any) {
        sinkError = err?.message ?? String(err);
      }
      let releaseError: string | null = null;
      if (row.repo_ident) {
        try {
          await deps.release(row.user_id, row.repo_ident, row.id); // strict + idempotent
        } catch (err: any) {
          releaseError = err?.message ?? String(err);
        }
      }
      if (sinkError || releaseError) {
        result.failed++;
        log(`row ${row.id} kept for retry (source run: ${sinkError ?? 'ok'}; release: ${releaseError ?? 'ok'})`);
        // Same outcome, fresh updated_at: a permanently failing row goes to the back of the queue
        // instead of starving the rest of the bounded batch.
        await deps.setOutcome(row.id, fresh.outcome, {}).catch(() => {});
        continue;
      }
      await deps.setOutcome(row.id, 'failed:spawn_timeout', {});
      if (row.source === 'scheduled_task') {
        // The scheduler default email is the owner notification for a scheduled-task event once its
        // launch outcome was returned; the sweep takes the claim only and never sends a second one.
        await (deps.notify ?? REAL_NOTIFY_DEPS).claim(row.id).catch(() => false);
      } else {
        await notifyOnce(row.id, event, 'spawn_timeout', deps.notify ?? REAL_NOTIFY_DEPS);
      }
      result.swept++;
    } catch (err: any) {
      result.failed++;
      log(`row ${row.id} failed (left for the next boot): ${err?.message ?? err}`);
    }
  }
  if (result.swept || result.failed) log(`boot sweep: ${JSON.stringify(result)}`);
  return result;
}

/**
 * Stranded launches first (a terminalized scheduled_task event's obligation is then due), then the
 * owner-email outbox: every default failure email a crash left undelivered is sent exactly once
 * (lease CAS). Flag OFF: nothing is read or touched.
 */
export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
  if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
  const result = await sweepStrandedLaunches(deps);
  if (!deps.ownerEmails) return result; // injected-deps callers opt in explicitly
  try {
    const sent = await sweepOwnerEmails(2 * healSpawnTimeoutMs(), deps.ownerEmails);
    if (sent) log(`owner email outbox: ${sent} redelivered`);
  } catch (err: any) {
    log(`owner email outbox sweep failed: ${err?.message ?? err}`);
  }
  return result;
}

/**
 * Boot entry: sweep now, then ONE follow-up at the spawn deadline plus the staleness guard so a row
 * stranded by a quick restart (younger than the guard at boot) is swept as soon as it ages in.
 * True no-op when the heal flag is OFF (nothing read, no timer armed).
 */
export async function bootSweepHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
  if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
  const first = await sweepStaleHealLaunches(deps);
  const arm = deps.setTimer ?? defaultSetTimer;
  arm(() => {
    void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));
  }, followUpDelayMs());
  return first;
}

/** Strictly past the staleness guard (2x spawn timeout) so every boot-stranded row qualifies. */
export function followUpDelayMs(): number {
  return 2 * healSpawnTimeoutMs() + FOLLOW_UP_MARGIN_MS;
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void })?.unref?.();
  return handle;
}
