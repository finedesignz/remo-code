// hub/src/heal/route.ts
//
// PTYCAP-07-05 (SH-01, SH-02, SH-03, SH-06, D-02, D-03, D-05, D-07, AM-F4-1, AM-F4-3):
// routeHeal is the ONE seam every self-heal source calls. Resolve a target, claim the ledger
// row, dispatch through the shared dispatch() pipeline with the single six-gate chain, and
// terminalize every non-live outcome through the per-event sink.
//
// Never referenced from here: the capacity picker, the supervisor frame sender, the
// online-agent-session lister, the launch function, the orchestrator-enabled predicate.
// 07-06 adds the owner notification (notify.ts) and the governed autospawn branch for an offline
// candidate (governedLaunch with the heal pre-launch governor, one deadline timer, no polling).
// Sources are a later plan (07-07).

import { dispatch, type DispatchRequest, type DispatchOutcome, type PipelineDeps } from '../dispatch/pipeline.ts';
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts';
import { governedLaunch } from '../dispatch/governed-launch.ts';
import { REAL_AUTOSPAWN, type AutospawnDeps } from './autospawn-deps.ts';
import { AUTOSPAWN_LAUNCH_COMMAND } from '../db/orchestrator-rows-dal.ts';
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../dispatch/automation-controls.ts';
import { governedAutomationPtyGate } from '../dispatch/governed-pty.ts';
import { getChannel } from '../ws/registry.ts';
import {
  healUnifiedEnabled,
  healDedupeWindowMs,
  healMaxClaimsPerUserHour,
  healRetentionHours,
  healMaxPerRepoHour,
  healMaxPerTaskDay,
  healSpawnTimeoutMs,
} from './config.ts';
import { buildHealKey } from './counter-key.ts';
import { isCanonicalRepoIdent } from './repo-ident.ts';
import { withScopeContract, asciiPunctuation } from './prompt.ts';
import { resolveHealTarget, type HealTarget } from './resolve.ts';
import {
  parseHealEvent,
  outcomeToString,
  recoveryCtxFor,
  OUTCOME_AUTOSPAWN_STARTING,
  type HealEvent,
  type HealOutcome,
} from './types.ts';
import type { HealSink, HealTerminalOutcome, SinkFactory } from './sinks/types.ts';
import type { ClaimHealArgs, ClaimHealResult, HealOutcomeExtra } from '../db/heal-events-dal.ts';
import { notifyOnceDetailed, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';

export { REAL_AUTOSPAWN, type AutospawnDeps };

const HEAL_ACTOR = 'self-heal';

export interface HealDeps {
  now(): number;
  resolve(event: HealEvent): Promise<HealTarget>;
  claim(args: ClaimHealArgs): Promise<ClaimHealResult>;
  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
  isHealGenerated(runId: string): Promise<boolean>;
  makeSink: SinkFactory;
  dispatch(req: DispatchRequest, deps: PipelineDeps): Promise<DispatchOutcome>;
  isChannelOnline(sessionId: string): boolean;
  /** Session runner type at DISPATCH time (the PTY denial must hold here, not only at resolve time). */
  runnerTypeOf(sessionId: string, userId: string): Promise<string>;
  /** Owner-notification seam (07-06). Defaults to the real claim + email sender. */
  notify?: NotifyDeps;
  /** Governed autospawn collaborators (07-06). Defaults to REAL_AUTOSPAWN. */
  autospawn?: AutospawnDeps;
}

/** Real collaborators. DB-touching ones are lazy so importing this module never loads the DB. */
export const REAL_DEPS: HealDeps = {
  now: () => Date.now(),
  resolve: (event) => resolveHealTarget(event),
  claim: async (args) => (await import('../db/heal-events-dal.ts')).claimHealEvent(args),
  setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
  isHealGenerated: async (runId) => (await import('../db/heal-events-dal.ts')).isHealGenerated(runId),
  // Plan 07-07 creates the sinks index; resolved at call time so this module has no hard edge to it.
  makeSink: async (event, ctx) => {
    const spec = './sinks/index.ts';
    const mod = await import(spec);
    return (mod.makeHealSink as SinkFactory)(event, ctx);
  },
  dispatch,
  isChannelOnline: (sessionId) => getChannel(sessionId) != null,
  runnerTypeOf: async (sessionId, userId) => {
    const { getSession } = await import('../db/dal.ts');
    const s = (await getSession(sessionId, userId)) as { runner_type?: string | null } | null;
    return s?.runner_type ?? 'stream-json';
  },
};

function log(msg: string): void {
  console.error(`[heal] ${msg}`);
}

async function terminalize(sink: HealSink | null, outcome: HealTerminalOutcome): Promise<void> {
  if (!sink) return;
  try {
    await sink.finalizeTerminal(outcome);
  } catch (err: any) {
    log(`finalizeTerminal failed: ${err?.message ?? err}`);
  }
}

async function persist(
  deps: HealDeps,
  id: string | null,
  outcome: HealOutcome,
  extra: HealOutcomeExtra = {},
): Promise<void> {
  if (!id) return;
  try {
    await deps.setOutcome(id, outcomeToString(outcome), extra);
  } catch (err: any) {
    log(`setOutcome failed id=${id}: ${err?.message ?? err}`);
  }
}

/** The single pipeline builder. Exactly one gates literal exists under hub/src/heal. */
function buildPipelineDeps(
  sink: HealSink,
  deps: HealDeps,
  hooks?: Pick<PipelineDeps, 'replay' | 'onParkExpire'>,
): PipelineDeps {
  return {
    // D-07: kill switch, threshold, cost cap, token cap, PTY denial (actor self-heal is never an
    // eligible automation actor, so a pty-interactive target is always refused), session inject
    // rate, lifetime counter.
    gates: [
      automationKillSwitchGate,
      thresholdGate,
      dailyCostCapGate,
      dailyTokenCapGate,
      governedAutomationPtyGate(async (req) => ({
        actor: HEAL_ACTOR,
        runnerType: await deps.runnerTypeOf(req.sessionId, req.userId),
      })),
      sessionInjectRateGate,
      automationLifetimeCounterGate,
    ],
    store: sink,
    isOnline: (req) => deps.isChannelOnline(req.sessionId),
    // A live-path heal turn carries per-event payload that would be stale later: it is never replayed.
    // The autospawn branch supplies its own hooks (replay re-enters dispatch, expiry releases).
    replay: hooks?.replay ?? (async (req) => sink.onParkExpire(req)),
    onParkExpire: hooks?.onParkExpire ?? ((req) => sink.onParkExpire(req)),
    send: (req) => sink.send(req),
  };
}

function errMsg(err: unknown): string {
  return (err as any)?.message ?? String(err);
}

/** Owner-visible reason for a non-dispatch outcome. */
function outcomeReason(o: HealOutcome): string {
  return 'reason' in o ? o.reason : o.kind;
}

/**
 * The single finalization point for non-dispatch outcomes that have a ledger row: persist, terminalize
 * through the sink, THEN notify the owner once (a crash between the writes still dedupes). A
 * notification failure never changes the outcome and never throws.
 */
async function finalizeNonLive(
  deps: HealDeps,
  event: HealEvent,
  eventId: string,
  sink: HealSink | null,
  outcome: HealOutcome,
  extra: HealOutcomeExtra = {},
  sinkOutcome?: HealTerminalOutcome,
  notify = true,
): Promise<HealOutcome> {
  await persist(deps, eventId, outcome, extra);
  await terminalize(sink, sinkOutcome ?? (outcome as HealTerminalOutcome));
  if (!notify) {
    // The owner notification for this event was already settled elsewhere (the scheduler default
    // email, selected when the launch outcome was returned). Take the claim only, never send.
    try {
      await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
    } catch (err) {
      log(`notification slot claim failed id=${eventId}: ${errMsg(err)}`);
    }
    return outcome;
  }
  const n = await notifyOnceDetailed(eventId, event, outcomeReason(outcome), deps.notify ?? REAL_NOTIFY_DEPS);
  // Ownership (claimed) is reported for EVERY non-live outcome, independent of delivery (sent).
  if (outcome.kind === 'no_routable_session') return { ...outcome, notified: n.sent, notifyClaimed: n.claimed };
  if (outcome.kind === 'refused' || outcome.kind === 'failed') return { ...outcome, notifyClaimed: n.claimed };
  return outcome;
}

/** Heal-generated provenance of either run id. Throws on a probe error (caller fails closed). */
async function isHealDerived(event: HealEvent, deps: HealDeps): Promise<boolean> {
  for (const runId of [event.trigger_run_id, event.metadata_run_id]) {
    if (runId && (await deps.isHealGenerated(runId))) return true;
  }
  return false;
}

/** The dispatch request for a resolved target. The ONLY place the lifetime key is attached (AM-F4-3). */
function buildRequest(event: HealEvent, target: { sessionId: string; repoIdent: string }, eventId: string): DispatchRequest {
  return {
    userId: event.user_id,
    sessionId: target.sessionId,
    token: `heal:${eventId}`,
    prompt: withScopeContract(asciiPunctuation(event.prompt)),
    images: event.images,
    counterKey: buildHealKey(event.user_id, target.repoIdent),
  };
}

/**
 * Stamp the lifetime reservation for a heal event released. The only exported place that names
 * the lifetime key, so the boot sweep can free a reservation stranded by a restart.
 */
export async function releaseHealReservation(
  userId: string,
  repoIdent: string,
  eventId: string,
  autospawn: Pick<AutospawnDeps, 'release'> = REAL_AUTOSPAWN,
): Promise<void> {
  await autospawn.release({ counterKey: buildHealKey(userId, repoIdent), token: `heal:${eventId}` });
}

/** Map a pipeline outcome for a request delivered after a spawn into a non-live outcome. */
function mapAfterSpawn(result: DispatchOutcome): HealOutcome {
  switch (result.kind) {
    case 'dropped_busy':
      return { kind: 'refused', reason: 'session_busy' };
    case 'skipped':
      return { kind: 'refused', reason: result.reason };
    case 'failed':
      return { kind: 'failed', reason: result.reason };
    default:
      return { kind: 'failed', reason: 'reconnect_not_online' };
  }
}

/**
 * SH-04: heal an OFFLINE candidate through the shared governed adapter. Gates, the atomic lifetime
 * reservation and the ledger row all run BEFORE the spawn. After a launch the request is parked
 * through the single dispatch pipeline; ONE deadline timer bounds the wait, and the reservation is
 * released on every failure path. Process-local state only: the boot sweep covers a restart.
 */
async function autospawnHeal(
  deps: HealDeps,
  event: HealEvent,
  target: { sessionId: string; repoIdent: string },
  eventId: string,
  sink: HealSink,
): Promise<HealOutcome> {
  const a = deps.autospawn ?? REAL_AUTOSPAWN;
  const req = buildRequest(event, target, eventId);
  const extra = { sessionId: target.sessionId, repoIdent: target.repoIdent };
  // The release is STRICT (QC r2): a failed release must leave the event in a state the boot sweep
  // retries (autospawn_starting / launched / parked), never a terminal outcome that hides the slot.
  let releaseFailed = false;
  const release = async (): Promise<boolean> => {
    try {
      await releaseHealReservation(event.user_id, target.repoIdent, eventId, a);
      return true;
    } catch (err) {
      releaseFailed = true;
      log(`reservation release failed id=${eventId} (left for the sweep): ${errMsg(err)}`);
      return false;
    }
  };
  /** Release could not be confirmed: keep the recoverable outcome; the sweep terminalizes + notifies. */
  const deferToSweep = (why: string): HealOutcome => {
    log(`heal event ${eventId} left for the sweep: ${why}`);
    return { kind: 'failed', reason: 'heal_release_pending' };
  };
  // The scheduler default email is the owner notification for a scheduled-task event once the launch
  // outcome has been returned, so every ASYNC finalizer (deadline, replay) must not send a second.
  const asyncNotify = event.source !== 'scheduled_task';

  let settled = false;
  let timer: unknown = null;
  const disarm = () => {
    if (timer != null) a.clearTimer(timer);
    timer = null;
  };
  const expire = async (ledgerReason: string, sinkReason: string) => {
    if (settled) return;
    settled = true;
    disarm();
    if (!(await release())) return; // outcome stays autospawn_launched/parked: the sweep retries
    await finalizeNonLive(
      deps,
      event,
      eventId,
      sink,
      { kind: 'failed', reason: ledgerReason },
      extra,
      { kind: 'failed', reason: sinkReason },
      asyncNotify,
    );
  };
  /** Outcome of a request that was actually dispatched after the spawn; null = delivered. */
  const afterDispatch = async (result: DispatchOutcome, notify = true): Promise<HealOutcome | null> => {
    if (result.kind === 'dispatched' || result.kind === 'queued') {
      try {
        await deps.setOutcome(eventId, 'dispatched_after_spawn', {
          ...extra,
          dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
        });
      } catch (err) {
        log(`setOutcome failed id=${eventId}: ${errMsg(err)}`); // the turn was delivered; never fail it
      }
      return null;
    }
    if (!(await release())) return deferToSweep('release after post-spawn refusal');
    return finalizeNonLive(deps, event, eventId, sink, mapAfterSpawn(result), extra, undefined, notify);
  };

  const pdeps: PipelineDeps = buildPipelineDeps(sink, deps, {
    // The parked turn can be minutes stale: it re-enters dispatch() and is fully re-gated. A replay
    // after the deadline (settled) delivers nothing.
    replay: async (r) => {
      if (settled) return;
      settled = true;
      disarm();
      try {
        await afterDispatch(await deps.dispatch(r ?? req, pdeps), asyncNotify);
      } catch (err) {
        log(`replay failed id=${eventId}: ${errMsg(err)}`);
        if (!(await release())) return;
        await finalizeNonLive(
          deps, event, eventId, sink, { kind: 'failed', reason: `heal_replay_error: ${errMsg(err)}` }, extra, undefined, asyncNotify,
        );
      }
    },
    onParkExpire: () => expire('grace_expired', 'heal_grace_expired'),
  });

  // Recoverable BEFORE any reservation or spawn: a crash between the lifetime reservation and the
  // 'launched' outcome would otherwise leave a NULL-outcome row the sweep never selects, stranding
  // the reservation forever. Deliberately NOT swallowed: if the ledger cannot record the intent,
  // nothing is reserved or spawned (the outer handler terminalizes as failed).
  await deps.setOutcome(eventId, OUTCOME_AUTOSPAWN_STARTING, extra);

  const launched = await governedLaunch(
    {
      userId: event.user_id,
      sessionId: target.sessionId,
      repoIdent: target.repoIdent,
      tz: await a.tzForUser(event.user_id),
      armed: a.armed(),
      ledger: {
        repoKey: target.repoIdent,
        command: AUTOSPAWN_LAUNCH_COMMAND,
        rationale: () => `self-heal event ${eventId}`,
      },
      preLaunch: {
        checkGates: () => a.checkGates(req, pdeps.gates),
        reserve: () =>
          a.reserve({
            userId: event.user_id,
            sessionId: target.sessionId,
            token: req.token,
            counterKey: req.counterKey as string,
            actor: HEAL_ACTOR,
            enforceRate: true,
          }),
        release,
      },
    },
    a,
  );

  let kind: 'autospawn_launched' | 'autospawn_parked';
  // A refusal / failure after the reservation was taken unwinds through release(); if that release
  // did not land, the slot is still held: do not write a terminal outcome over the recoverable row.
  if ((launched.kind === 'refused' || launched.kind === 'failed') && releaseFailed) {
    return deferToSweep(`launch ${launched.kind}: ${launched.reason}`);
  }
  switch (launched.kind) {
    case 'refused': {
      const outcome: HealOutcome =
        launched.reason === 'disabled'
          ? { kind: 'no_routable_session', reason: 'autospawn_not_armed', notified: false }
          : launched.reason === 'not_allowlisted' || launched.reason === 'supervisor_offline'
            ? { kind: 'no_routable_session', reason: launched.reason, notified: false }
            : { kind: 'refused', reason: launched.reason };
      return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
    }
    case 'failed':
      return finalizeNonLive(deps, event, eventId, sink, { kind: 'failed', reason: launched.reason }, extra);
    case 'in_flight':
      kind = 'autospawn_parked';
      break;
    case 'launched':
      kind = 'autospawn_launched';
      break;
  }

  // Launched (or already in flight): the ledger outcome first so a crash is recoverable by the
  // boot sweep, then ONE deadline timer, then park through the single pipeline.
  await persist(deps, eventId, { kind }, extra);
  if (event.source === 'scheduled_task') {
    // The scheduler's default failure email goes out NOW (the heal returns un-claimed). Take the
    // notification claim on its behalf, with no send, so a later spawn_timeout / grace_expired /
    // boot-sweep notice for this same event loses the claim: one owner notification per event.
    // Determinism if this claim cannot be persisted (QC r2): the default email is STILL the sole
    // owner, because every later heal finalizer for a scheduled_task event (deadline, replay, the
    // boot sweep) is claim-only and never sends. A failed claim here cannot produce a second email.
    try {
      await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
    } catch (err) {
      log(`scheduler notification slot claim failed id=${eventId}: ${errMsg(err)}`);
    }
  }
  timer = a.setTimer(() => void expire('spawn_timeout', 'heal_spawn_timeout'), healSpawnTimeoutMs());
  let result: DispatchOutcome;
  try {
    result = await deps.dispatch(req, pdeps);
  } catch (err) {
    settled = true;
    disarm();
    if (!(await release())) return deferToSweep(`dispatch threw: ${errMsg(err)}`);
    throw err; // D-06: the outer handler terminalizes as failed and notifies once
  }
  if (result.kind === 'parked_offline') return { kind };
  settled = true;
  disarm();
  return (await afterDispatch(result)) ?? { kind };
}

export async function routeHeal(input: unknown, deps: HealDeps = REAL_DEPS): Promise<HealOutcome> {
  let event: HealEvent;
  try {
    event = parseHealEvent(input);
  } catch (err) {
    const outcome: HealOutcome = { kind: 'failed', reason: 'invalid_event' };
    try {
      await terminalize(await deps.makeSink(input as HealEvent, { eventId: null }), outcome);
    } catch (sinkErr) {
      log(`invalid event and no sink: ${errMsg(sinkErr)}`);
    }
    log(`invalid event: ${errMsg(err)}`);
    return outcome;
  }

  if (!healUnifiedEnabled()) return { kind: 'refused', reason: 'heal_disabled' };

  let eventId: string | null = null;
  try {
    const sinkFor = (id: string | null) => deps.makeSink(event, { eventId: id });

    // Recursion guard (AM-F5-3): BEFORE any claim, fail closed.
    let derived: boolean;
    try {
      derived = await isHealDerived(event, deps);
    } catch (err) {
      log(`provenance probe failed (fail closed): ${errMsg(err)}`);
      await terminalize(await sinkFor(null), { kind: 'failed', reason: 'heal_guard_error' });
      return { kind: 'refused', reason: 'heal_guard_error' };
    }
    if (derived) {
      const outcome: HealOutcome = { kind: 'refused', reason: 'heal_provenance' };
      await terminalize(await sinkFor(null), outcome);
      return outcome;
    }

    const target = await deps.resolve(event);
    const repoIdent =
      target.kind !== 'none' ? target.repoIdent : isCanonicalRepoIdent(event.repo_ident) ? event.repo_ident : null;

    const claim = await deps.claim({
      userId: event.user_id,
      source: event.source,
      dedupeKey: event.dedupe_key,
      repoIdent,
      triggerRunId: event.trigger_run_id,
      windowMs: healDedupeWindowMs(),
      maxClaimsPerUserHour: healMaxClaimsPerUserHour(),
      retentionHours: healRetentionHours(),
      // Atomic ceilings (QC r1): counted and inserted in the claim transaction. The repo bound is
      // only meaningful for a routable target (a `none` target dispatches nothing).
      ...(target.kind !== 'none' ? { maxPerRepoHour: healMaxPerRepoHour() } : {}),
      ...(event.source === 'scheduled_task' ? { maxPerTaskDay: healMaxPerTaskDay() } : {}),
      recoveryCtx: recoveryCtxFor(event),
      nowMs: deps.now(),
    });
    if (!claim.ok) {
      // A dropped duplicate / capped event must never leave its run pending (D-05).
      const outcome: HealTerminalOutcome =
        claim.reason === 'duplicate' ? { kind: 'deduped' } : { kind: 'refused', reason: claim.reason };
      await terminalize(await sinkFor(null), outcome);
      return outcome;
    }
    eventId = claim.id;
    const sink = await sinkFor(eventId);

    if (target.kind === 'none') {
      const outcome: HealOutcome = { kind: 'no_routable_session', reason: target.reason, notified: false };
      return finalizeNonLive(deps, event, eventId, sink, outcome, { repoIdent, sessionId: null });
    }

    // Per-repo hourly bound (AM-F4-4): a fresh session cannot be seen by the session-keyed rate gate.
    // Decided atomically by the claim (claimHealEvent); the row is already refused:repo_rate_bound.
    if (claim.repoRateBound) {
      const outcome: HealOutcome = { kind: 'refused', reason: 'repo_rate_bound' };
      return finalizeNonLive(deps, event, eventId, sink, outcome, {
        repoIdent: target.repoIdent,
        sessionId: target.sessionId,
      });
    }

    // SH-04: an offline candidate goes through the governed autospawn branch, never a live dispatch.
    if (target.kind === 'offline_candidate') return await autospawnHeal(deps, event, target, eventId, sink);

    const req = buildRequest(event, target, eventId);
    const result = await deps.dispatch(req, buildPipelineDeps(sink, deps));

    let outcome: HealOutcome;
    switch (result.kind) {
      case 'dispatched':
      case 'queued':
        outcome = { kind: 'dispatched_live' };
        break;
      case 'dropped_busy':
        outcome = { kind: 'refused', reason: 'session_busy' };
        break;
      case 'skipped':
        outcome = { kind: 'refused', reason: result.reason };
        break;
      case 'failed':
        outcome = { kind: 'failed', reason: result.reason };
        break;
      case 'parked_offline':
        outcome = { kind: 'no_routable_session', reason: 'target_went_offline', notified: false };
        break;
    }
    const extra = {
      sessionId: target.sessionId,
      repoIdent: target.repoIdent,
      dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
    };
    if (outcome.kind === 'dispatched_live') {
      await persist(deps, eventId, outcome, extra);
      return outcome;
    }
    return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
  } catch (err) {
    // D-06: any throw terminalizes as failed. There is NO dispatch-anyway branch.
    const outcome: HealOutcome = { kind: 'failed', reason: `heal_route_error: ${errMsg(err)}` };
    log(`route error: ${errMsg(err)}`);
    try {
      const sink = await deps.makeSink(event, { eventId });
      // A ledger row exists: finalize + notify once. Without one there is nothing to claim ownership on.
      if (eventId) return await finalizeNonLive(deps, event, eventId, sink, outcome);
      await terminalize(sink, outcome);
    } catch (sinkErr) {
      log(`no sink to terminalize route error: ${errMsg(sinkErr)}`);
      await persist(deps, eventId, outcome);
    }
    return outcome;
  }
}
