// hub/src/heal/route.ts
//
// PTYCAP-07-05 (SH-01, SH-02, SH-03, SH-06, D-02, D-03, D-05, D-07, AM-F4-1, AM-F4-3):
// routeHeal is the ONE seam every self-heal source calls. Resolve a target, claim the ledger
// row, dispatch through the shared dispatch() pipeline with the single six-gate chain, and
// terminalize every non-live outcome through the per-event sink.
//
// Never referenced from here: the capacity picker, the supervisor frame sender, the
// online-agent-session lister, the launch function, the orchestrator-enabled predicate.
// Autospawn, notifications and sources are later plans (07-06, 07-07).

import { dispatch, type DispatchRequest, type DispatchOutcome, type PipelineDeps } from '../dispatch/pipeline.ts';
import { thresholdGate, dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts';
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../dispatch/automation-controls.ts';
import { getChannel } from '../ws/registry.ts';
import {
  healUnifiedEnabled,
  healDedupeWindowMs,
  healMaxClaimsPerUserHour,
  healRetentionHours,
  healMaxPerRepoHour,
} from './config.ts';
import { buildHealKey } from './counter-key.ts';
import { isCanonicalRepoIdent } from './repo-ident.ts';
import { withScopeContract, asciiPunctuation } from './prompt.ts';
import { resolveHealTarget, type HealTarget } from './resolve.ts';
import { parseHealEvent, outcomeToString, type HealEvent, type HealOutcome } from './types.ts';
import type { HealSink, HealTerminalOutcome, SinkFactory } from './sinks/types.ts';
import type { ClaimHealArgs, ClaimHealResult, HealOutcomeExtra } from '../db/heal-events-dal.ts';

export interface HealDeps {
  now(): number;
  resolve(event: HealEvent): Promise<HealTarget>;
  claim(args: ClaimHealArgs): Promise<ClaimHealResult>;
  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
  isHealGenerated(runId: string): Promise<boolean>;
  countRepoDispatches(userId: string, repoIdent: string): Promise<number>;
  makeSink: SinkFactory;
  dispatch(req: DispatchRequest, deps: PipelineDeps): Promise<DispatchOutcome>;
  isChannelOnline(sessionId: string): boolean;
}

/** Real collaborators. DB-touching ones are lazy so importing this module never loads the DB. */
export const REAL_DEPS: HealDeps = {
  now: () => Date.now(),
  resolve: (event) => resolveHealTarget(event),
  claim: async (args) => (await import('../db/heal-events-dal.ts')).claimHealEvent(args),
  setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
  isHealGenerated: async (runId) => (await import('../db/heal-events-dal.ts')).isHealGenerated(runId),
  countRepoDispatches: async (userId, repoIdent) =>
    (await import('../db/heal-events-dal.ts')).countRepoDispatchesLastHour(userId, repoIdent),
  // Plan 07-07 creates the sinks index; resolved at call time so this module has no hard edge to it.
  makeSink: async (event, ctx) => {
    const spec = './sinks/index.ts';
    const mod = await import(spec);
    return (mod.makeHealSink as SinkFactory)(event, ctx);
  },
  dispatch,
  isChannelOnline: (sessionId) => getChannel(sessionId) != null,
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
function buildPipelineDeps(sink: HealSink, deps: HealDeps): PipelineDeps {
  return {
    // D-07: kill switch, threshold, cost cap, token cap, session inject rate, lifetime counter.
    gates: [
      automationKillSwitchGate,
      thresholdGate,
      dailyCostCapGate,
      dailyTokenCapGate,
      sessionInjectRateGate,
      automationLifetimeCounterGate,
    ],
    store: sink,
    isOnline: (req) => deps.isChannelOnline(req.sessionId),
    // A heal turn carries per-event payload that would be stale later: it is never replayed.
    replay: async (req) => sink.onParkExpire(req),
    onParkExpire: (req) => sink.onParkExpire(req),
    send: (req) => sink.send(req),
  };
}

function errMsg(err: unknown): string {
  return (err as any)?.message ?? String(err);
}

/** Heal-generated provenance of either run id. Throws on a probe error (caller fails closed). */
async function isHealDerived(event: HealEvent, deps: HealDeps): Promise<boolean> {
  for (const runId of [event.trigger_run_id, event.metadata_run_id]) {
    if (runId && (await deps.isHealGenerated(runId))) return true;
  }
  return false;
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

    if (target.kind !== 'routable_live') {
      const outcome: HealOutcome = {
        kind: 'no_routable_session',
        reason: target.kind === 'none' ? target.reason : 'session_offline',
        notified: false,
      };
      await persist(deps, eventId, outcome, { repoIdent, sessionId: target.kind === 'none' ? null : target.sessionId });
      await terminalize(sink, outcome);
      return outcome;
    }

    // Per-repo hourly bound (AM-F4-4): a fresh session cannot be seen by the session-keyed rate gate.
    if ((await deps.countRepoDispatches(event.user_id, target.repoIdent)) >= healMaxPerRepoHour()) {
      const outcome: HealOutcome = { kind: 'refused', reason: 'repo_rate_bound' };
      await persist(deps, eventId, outcome, { repoIdent: target.repoIdent, sessionId: target.sessionId });
      await terminalize(sink, outcome);
      return outcome;
    }

    const req: DispatchRequest = {
      userId: event.user_id,
      sessionId: target.sessionId,
      token: `heal:${eventId}`,
      prompt: withScopeContract(asciiPunctuation(event.prompt)),
      images: event.images,
      // AM-F4-3: the ONLY place the lifetime key is attached; derived from the owned session.
      counterKey: buildHealKey(event.user_id, target.repoIdent),
    };
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
    await persist(deps, eventId, outcome, {
      sessionId: target.sessionId,
      repoIdent: target.repoIdent,
      dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
    });
    if (outcome.kind !== 'dispatched_live') await terminalize(sink, outcome as HealTerminalOutcome);
    return outcome;
  } catch (err) {
    // D-06: any throw terminalizes as failed. There is NO dispatch-anyway branch.
    const outcome: HealOutcome = { kind: 'failed', reason: `heal_route_error: ${errMsg(err)}` };
    log(`route error: ${errMsg(err)}`);
    await persist(deps, eventId, outcome);
    try {
      await terminalize(await deps.makeSink(event, { eventId }), outcome);
    } catch (sinkErr) {
      log(`no sink to terminalize route error: ${errMsg(sinkErr)}`);
    }
    return outcome;
  }
}
