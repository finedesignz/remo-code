// hub/src/heal/notify.ts
//
// PTYCAP-07-06 (SH-05, D-05, AM-F3-2, T-07-22/T-07-23): the single owner notification for an
// un-routable, refused or failed heal event.
//
// Guarantee: exactly ONE SEND ATTEMPT per ledger row, NOT exactly-once delivery. Ownership is a
// conditional UPDATE on the ledger row (claimHealNotification): the caller that wins the claim
// makes one send attempt through the injected seam; a lost claim sends nothing; a send that
// returns false or throws is logged and NEVER retried (the claim stays set - no outbox). It
// never throws: a notification failure must not change a routing outcome.

import { asciiPunctuation } from './prompt.ts';

export interface NotifyEvent {
  user_id: string;
  source: string;
  dedupe_key: string;
  repo_ident: string | null;
  notify_summary?: string;
}

export interface NotifyDeps {
  /** True exactly once per event id (conditional UPDATE on the ledger row). */
  claim(eventId: string): Promise<boolean>;
  /** The owner address, or null when none resolves. */
  resolveOwnerEmail(userId: string): Promise<string | null>;
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<boolean>;
}

/** Real seam: lazy imports so importing this module never loads the DB. */
export const REAL_NOTIFY_DEPS: NotifyDeps = {
  claim: async (id) => (await import('../db/heal-events-dal.ts')).claimHealNotification(id),
  resolveOwnerEmail: async (userId) => {
    const { getUserById } = await import('../db/dal.ts');
    const user = (await getUserById(userId)) as { email?: string } | null;
    return user?.email ?? null;
  },
  send: async (msg) => (await import('../lib/email.ts')).sendEmail(msg),
};

function log(msg: string): void {
  console.error(`[heal.notify] ${msg}`);
}

/** ASCII-only, single-line, length-capped. Untrusted text never reaches the body unbounded. */
function clean(text: string, max: number): string {
  return asciiPunctuation(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, max);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildNotification(event: NotifyEvent, reason: string): { subject: string; text: string; html: string } {
  const repo = event.repo_ident ? clean(event.repo_ident, 200) : 'unknown repo';
  const why = clean(reason, 200);
  const lines = [
    `Self-heal could not act on a failure for ${repo}.`,
    `Reason: ${why}`,
    `Source: ${clean(event.source, 40)}`,
    `Dedupe key: ${clean(event.dedupe_key, 200)}`,
  ];
  if (event.notify_summary) lines.push(`Summary: ${clean(event.notify_summary, 500)}`);
  return {
    subject: `[heal] ${repo}: ${why}`.slice(0, 300),
    text: lines.join('\n'),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
  };
}

/** Returns true only when the single send attempt reported success. */
export async function notifyOnce(
  eventId: string,
  event: NotifyEvent,
  reason: string,
  deps: NotifyDeps = REAL_NOTIFY_DEPS,
): Promise<boolean> {
  try {
    if (!(await deps.claim(eventId))) return false; // lost claim: someone else owns the attempt
    const to = await deps.resolveOwnerEmail(event.user_id);
    if (!to) {
      log(`no owner address for event ${eventId}; not sent`);
      return false;
    }
    const ok = await deps.send({ to, ...buildNotification(event, reason) });
    if (!ok) log(`send reported failure for event ${eventId}; not retried`);
    return ok === true;
  } catch (err: any) {
    log(`notify failed for event ${eventId}: ${err?.message ?? err}; not retried`);
    return false;
  }
}
