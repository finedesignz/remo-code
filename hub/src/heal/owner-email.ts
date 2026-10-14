// hub/src/heal/owner-email.ts
//
// PTYCAP-07 repair round: delivery of the persisted default owner-email obligation (outbox).
// The obligation is written with the heal claim (heal-events-dal claimHealEvent). Two deliverers,
// one lease CAS between them: the scheduler hook right after the heal hook returns, and the heal
// sweep for anything a crash left undelivered. A send that reports failure drops the lease so the
// next sweep retries; a hub crash mid-send is retried after the lease expires. Never throws.

import type { OwnerEmailClaim } from '../db/heal-events-dal.ts';

export interface OwnerEmailDeps {
  hasObligation(runId: string): Promise<boolean>;
  claimByRun(runId: string): Promise<OwnerEmailClaim | null>;
  list(olderThanMs: number): Promise<OwnerEmailClaim[]>;
  claim(id: string): Promise<OwnerEmailClaim | null>;
  markDelivered(id: string): Promise<void>;
  release(id: string): Promise<void>;
  resolveOwnerEmail(userId: string): Promise<string | null>;
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<boolean>;
}

export const REAL_OWNER_EMAIL_DEPS: OwnerEmailDeps = {
  hasObligation: async (runId) => (await import('../db/heal-events-dal.ts')).hasOwnerEmailObligation(runId),
  claimByRun: async (runId) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDeliveryByRun(runId),
  list: async (ms) => (await import('../db/heal-events-dal.ts')).listPendingOwnerEmails(ms),
  claim: async (id) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDelivery(id),
  markDelivered: async (id) => (await import('../db/heal-events-dal.ts')).markOwnerEmailDelivered(id),
  release: async (id) => (await import('../db/heal-events-dal.ts')).releaseOwnerEmailClaim(id),
  resolveOwnerEmail: async (userId) => {
    const { getUserById } = await import('../db/dal.ts');
    return ((await getUserById(userId)) as { email?: string } | null)?.email ?? null;
  },
  send: async (msg) => (await import('../lib/email.ts')).sendEmail(msg),
};

function log(msg: string): void {
  console.error(`[heal.owner-email] ${msg}`);
}

/** Sends a CLAIMED obligation. True when delivered. */
async function sendClaimed(c: OwnerEmailClaim, deps: OwnerEmailDeps): Promise<boolean> {
  try {
    const to = await deps.resolveOwnerEmail(c.user_id);
    if (!to) {
      log(`no owner address for event ${c.id}; closing without a send`);
      await deps.markDelivered(c.id);
      return false;
    }
    const ok = await deps.send({ to, subject: c.owner_email.subject, text: c.owner_email.text, html: c.owner_email.html });
    if (!ok) {
      log(`send reported failure for event ${c.id}; left for the sweep`);
      await deps.release(c.id).catch(() => {});
      return false;
    }
    await deps.markDelivered(c.id); // a failure here means a re-send after the lease, never a loss
    return true;
  } catch (err: any) {
    log(`delivery failed for event ${c.id}: ${err?.message ?? err}; left for the sweep`);
    await deps.release(c.id).catch(() => {});
    return false;
  }
}

/**
 * Scheduler path. Resolves true when the run's heal event carries an owner-email obligation (the
 * obligation, not the default post-run email, is now the owner notification), whether the send
 * happened here, was already done, or is left for the sweep. False = no obligation, so the caller
 * keeps the legacy default email. Never throws.
 */
export async function deliverOwnerEmailForRun(runId: string, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<boolean> {
  try {
    if (!(await deps.hasObligation(runId))) return false;
  } catch (err: any) {
    log(`obligation probe failed run=${runId}: ${err?.message ?? err}`);
    return false;
  }
  try {
    const claimed = await deps.claimByRun(runId);
    if (claimed) await sendClaimed(claimed, deps);
  } catch (err: any) {
    log(`claim failed run=${runId} (left for the sweep): ${err?.message ?? err}`);
  }
  return true;
}

/** Sweep path: redeliver every obligation a crash left undelivered. Returns the number sent. */
export async function sweepOwnerEmails(olderThanMs: number, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<number> {
  let sent = 0;
  let rows: OwnerEmailClaim[];
  try {
    rows = await deps.list(olderThanMs);
  } catch (err: any) {
    log(`list failed: ${err?.message ?? err}`);
    return 0;
  }
  for (const r of rows) {
    try {
      const c = await deps.claim(r.id);
      if (c && (await sendClaimed(c, deps))) sent++;
    } catch (err: any) {
      log(`sweep claim failed for ${r.id}: ${err?.message ?? err}`);
    }
  }
  return sent;
}
