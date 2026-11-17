codex
I’ll inspect `git show HEAD`, then trace the outbox claim/delivery/sweep paths and the flag-OFF branch. I’ll report only reproducible major defects.
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n -i \"PTYCAP-07|owner_email|heal_events|heal sweep|healFailedRunHook|unified\" C:\\Users\\artic\\.codex\\memories\\MEMORY.md" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status --short; git show --stat --oneline --decorate HEAD; git show --format=fuller --no-ext-diff --find-renames HEAD' in C:\Users\artic\GitHub\remo-code-ptycap07
 exited 1 in 661ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.

 succeeded in 958ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
84787dd (HEAD -> phase-ptycap-07-self-heal-routing) fix(heal): persist scheduled-task owner-email obligation with the heal claim; sweep redelivers (outbox)
 hub/src/db/heal-events-dal.ts            | 118 ++++++++++++-
 hub/src/db/schema.sql                    |   8 +
 hub/src/heal/owner-email.ts              | 105 ++++++++++++
 hub/src/heal/route.ts                    |  17 ++
 hub/src/heal/sources/scheduled-task.ts   |  20 +++
 hub/src/heal/sweep.ts                    |  24 ++-
 hub/src/heal/types.ts                    |   2 +
 hub/src/scheduler/dispatcher.ts          |  11 +-
 hub/src/scheduler/post-run/dispatcher.ts |   7 +
 hub/test/heal-owner-email-outbox.test.ts | 278 +++++++++++++++++++++++++++++++
 10 files changed, 586 insertions(+), 4 deletions(-)
commit 84787dd2064fc3f44e3d58e5000e90f4261853ad
Author:     Michael <articulatedesigns@gmail.com>
AuthorDate: Tue Oct 13 20:04:48 2026 -0700
Commit:     Michael <articulatedesigns@gmail.com>
CommitDate: Tue Oct 13 20:04:48 2026 -0700

    fix(heal): persist scheduled-task owner-email obligation with the heal claim; sweep redelivers (outbox)
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

diff --git a/hub/src/db/heal-events-dal.ts b/hub/src/db/heal-events-dal.ts
index 461a6b9..f9f20bc 100644
--- a/hub/src/db/heal-events-dal.ts
+++ b/hub/src/db/heal-events-dal.ts
@@ -60,10 +60,21 @@ export interface ClaimHealArgs {
   maxPerTaskDay?: number
   /** Minimal validated source context a boot/follow-up sweep needs to terminalize the event. */
   recoveryCtx?: Record<string, unknown> | null
+  /**
+   * Pending default owner-email obligation (scheduled_task only), persisted in the SAME transaction
+   * as the claim so a crash after the claim can never lose it. Delivered once via the lease CAS below.
+   */
+  ownerEmail?: OwnerEmailPayload | null
   /** Injectable clock (tests); defaults to Date.now(). */
   nowMs?: number
 }
 
+export interface OwnerEmailPayload {
+  subject: string
+  text: string
+  html: string
+}
+
 export type ClaimHealResult =
   | { ok: true; id: string; repoRateBound?: true }
   | { ok: false; reason: 'duplicate' | 'user_claim_cap' | 'task_day_cap' }
@@ -85,6 +96,9 @@ export interface HealEventRow {
   outcome: string | null
   notification_claimed_at: string | Date | null
   recovery_ctx?: Record<string, unknown> | null
+  owner_email?: OwnerEmailPayload | null
+  owner_email_claimed_at?: string | Date | null
+  owner_email_delivered_at?: string | Date | null
   created_at: string | Date
   updated_at: string | Date
 }
@@ -187,10 +201,10 @@ export async function claimHealEvent(args: ClaimHealArgs, exec: HealExec = sql):
 
     // (d) INSERT; the unique indexes are the backstop - an empty return means duplicate.
     const inserted = await tx`
-      INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, outcome, recovery_ctx, created_at, updated_at)
+      INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, outcome, recovery_ctx, owner_email, created_at, updated_at)
       VALUES (${args.userId}, ${args.source}, ${args.repoIdent ?? null}, ${args.dedupeKey}, ${bucket},
               ${args.triggerRunId ?? null}, ${preOutcome}, ${args.recoveryCtx ? JSON.stringify(args.recoveryCtx) : null}::jsonb,
-              ${createdAt}, ${createdAt})
+              ${args.ownerEmail ? JSON.stringify(args.ownerEmail) : null}::jsonb, ${createdAt}, ${createdAt})
       ON CONFLICT DO NOTHING
       RETURNING id
     `
@@ -297,3 +311,103 @@ export async function listStaleLaunchingHealEvents(
   `
   return rows as HealEventRow[]
 }
+
+// --- Owner-email outbox (PTYCAP-07 repair round) ---------------------------------------------
+// The obligation (owner_email) is written in the claim transaction. Delivery is a LEASE CAS:
+// owner_email_claimed_at is stamped by the one caller that may send (a stale lease, i.e. a crash
+// mid-send, can be re-taken), owner_email_delivered_at is the terminal flag stamped after the send.
+// At-least-once across a crash in the narrow send->mark window, never zero, never concurrent.
+
+export const OWNER_EMAIL_LEASE_MS = 5 * 60_000
+
+export interface OwnerEmailClaim {
+  id: string
+  user_id: string
+  owner_email: OwnerEmailPayload
+}
+
+/** True when this run's heal event carries an undelivered-or-delivered obligation (a row exists). */
+export async function hasOwnerEmailObligation(runId: string, exec: HealExec = sql): Promise<boolean> {
+  const rows = await exec`
+    SELECT 1 AS one FROM heal_events
+    WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} AND owner_email IS NOT NULL
+    LIMIT 1
+  `
+  return rows.length > 0
+}
+
+/** Lease CAS by event id. Yields the payload to the ONE caller allowed to send, else null. */
+export async function claimOwnerEmailDelivery(
+  id: string,
+  leaseMs: number = OWNER_EMAIL_LEASE_MS,
+  exec: HealExec = sql,
+  nowMs: number = Date.now(),
+): Promise<OwnerEmailClaim | null> {
+  const staleBefore = new Date(nowMs - leaseMs)
+  const rows = await exec`
+    UPDATE heal_events SET owner_email_claimed_at = ${new Date(nowMs)}
+    WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
+      AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${staleBefore})
+    RETURNING id, user_id, owner_email
+  `
+  return rows.length > 0 ? (rows[0] as OwnerEmailClaim) : null
+}
+
+export async function claimOwnerEmailDeliveryByRun(
+  runId: string,
+  leaseMs: number = OWNER_EMAIL_LEASE_MS,
+  exec: HealExec = sql,
+  nowMs: number = Date.now(),
+): Promise<OwnerEmailClaim | null> {
+  const found = await exec`
+    SELECT id FROM heal_events WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} LIMIT 1
+  `
+  if (found.length === 0) return null
+  return claimOwnerEmailDelivery(found[0].id as string, leaseMs, exec, nowMs)
+}
+
+/** Terminal flag. Idempotent. */
+export async function markOwnerEmailDelivered(id: string, exec: HealExec = sql): Promise<void> {
+  await exec`
+    UPDATE heal_events SET owner_email_delivered_at = now(), updated_at = now()
+    WHERE id = ${id} AND owner_email_delivered_at IS NULL
+  `
+}
+
+/** Failed send: drop the lease so the next sweep retries without waiting out the lease. */
+export async function releaseOwnerEmailClaim(id: string, exec: HealExec = sql): Promise<void> {
+  await exec`
+    UPDATE heal_events SET owner_email_claimed_at = NULL
+    WHERE id = ${id} AND owner_email_delivered_at IS NULL
+  `
+}
+
+/** Best-effort: add the heal outcome reason to a still-undelivered obligation. */
+export async function appendOwnerEmailReason(id: string, reason: string, exec: HealExec = sql): Promise<void> {
+  const line = `Self-heal outcome: ${reason}`.replace(/[^ -~]/g, '?').slice(0, 200)
+  await exec`
+    UPDATE heal_events SET owner_email = jsonb_set(
+      jsonb_set(owner_email, '{text}', to_jsonb((owner_email->>'text') || E'
+' || ${line}::text)),
+      '{html}', to_jsonb((owner_email->>'html') || '<p>' || replace(replace(${line}::text, '&', '&amp;'), '<', '&lt;') || '</p>'))
+    WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
+  `
+}
+
+/** Undelivered obligations older than the guard whose lease is free or stale. Bounded. */
+export async function listPendingOwnerEmails(
+  olderThanMs: number,
+  exec: HealExec = sql,
+  nowMs: number = Date.now(),
+  leaseMs: number = OWNER_EMAIL_LEASE_MS,
+): Promise<OwnerEmailClaim[]> {
+  const rows = await exec`
+    SELECT id, user_id, owner_email FROM heal_events
+    WHERE owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
+      AND created_at < ${new Date(nowMs - olderThanMs)}
+      AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${new Date(nowMs - leaseMs)})
+    ORDER BY created_at
+    LIMIT 50
+  `
+  return rows as OwnerEmailClaim[]
+}
diff --git a/hub/src/db/schema.sql b/hub/src/db/schema.sql
index 6540ca2..46f0d5a 100644
--- a/hub/src/db/schema.sql
+++ b/hub/src/db/schema.sql
@@ -1685,6 +1685,14 @@ CREATE TABLE IF NOT EXISTS heal_events (
 -- PTYCAP-07 QC r1: minimal validated source context (e.g. error_id/project_id) so the stale-launch
 -- sweep can rebuild the per-event sink. Additive, nullable, never backfilled.
 ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS recovery_ctx JSONB;
+-- PTYCAP-07 repair: durable default owner-email obligation (scheduled_task only), written in the
+-- claim transaction; delivered once via a lease CAS, terminal flag owner_email_delivered_at.
+-- Additive, nullable, never backfilled.
+ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email JSONB;
+ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email_claimed_at TIMESTAMPTZ;
+ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email_delivered_at TIMESTAMPTZ;
+CREATE INDEX IF NOT EXISTS idx_heal_events_owner_email_pending
+  ON heal_events(created_at) WHERE owner_email IS NOT NULL AND owner_email_delivered_at IS NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_events_bucket
   ON heal_events(user_id, source, dedupe_key, window_bucket);
 -- A run can trigger at most one heal event, ever.
diff --git a/hub/src/heal/owner-email.ts b/hub/src/heal/owner-email.ts
new file mode 100644
index 0000000..28cb872
--- /dev/null
+++ b/hub/src/heal/owner-email.ts
@@ -0,0 +1,105 @@
+// hub/src/heal/owner-email.ts
+//
+// PTYCAP-07 repair round: delivery of the persisted default owner-email obligation (outbox).
+// The obligation is written with the heal claim (heal-events-dal claimHealEvent). Two deliverers,
+// one lease CAS between them: the scheduler hook right after the heal hook returns, and the heal
+// sweep for anything a crash left undelivered. A send that reports failure drops the lease so the
+// next sweep retries; a hub crash mid-send is retried after the lease expires. Never throws.
+
+import type { OwnerEmailClaim } from '../db/heal-events-dal.ts';
+
+export interface OwnerEmailDeps {
+  hasObligation(runId: string): Promise<boolean>;
+  claimByRun(runId: string): Promise<OwnerEmailClaim | null>;
+  list(olderThanMs: number): Promise<OwnerEmailClaim[]>;
+  claim(id: string): Promise<OwnerEmailClaim | null>;
+  markDelivered(id: string): Promise<void>;
+  release(id: string): Promise<void>;
+  resolveOwnerEmail(userId: string): Promise<string | null>;
+  send(msg: { to: string; subject: string; html: string; text: string }): Promise<boolean>;
+}
+
+export const REAL_OWNER_EMAIL_DEPS: OwnerEmailDeps = {
+  hasObligation: async (runId) => (await import('../db/heal-events-dal.ts')).hasOwnerEmailObligation(runId),
+  claimByRun: async (runId) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDeliveryByRun(runId),
+  list: async (ms) => (await import('../db/heal-events-dal.ts')).listPendingOwnerEmails(ms),
+  claim: async (id) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDelivery(id),
+  markDelivered: async (id) => (await import('../db/heal-events-dal.ts')).markOwnerEmailDelivered(id),
+  release: async (id) => (await import('../db/heal-events-dal.ts')).releaseOwnerEmailClaim(id),
+  resolveOwnerEmail: async (userId) => {
+    const { getUserById } = await import('../db/dal.ts');
+    return ((await getUserById(userId)) as { email?: string } | null)?.email ?? null;
+  },
+  send: async (msg) => (await import('../lib/email.ts')).sendEmail(msg),
+};
+
+function log(msg: string): void {
+  console.error(`[heal.owner-email] ${msg}`);
+}
+
+/** Sends a CLAIMED obligation. True when delivered. */
+async function sendClaimed(c: OwnerEmailClaim, deps: OwnerEmailDeps): Promise<boolean> {
+  try {
+    const to = await deps.resolveOwnerEmail(c.user_id);
+    if (!to) {
+      log(`no owner address for event ${c.id}; closing without a send`);
+      await deps.markDelivered(c.id);
+      return false;
+    }
+    const ok = await deps.send({ to, subject: c.owner_email.subject, text: c.owner_email.text, html: c.owner_email.html });
+    if (!ok) {
+      log(`send reported failure for event ${c.id}; left for the sweep`);
+      await deps.release(c.id).catch(() => {});
+      return false;
+    }
+    await deps.markDelivered(c.id); // a failure here means a re-send after the lease, never a loss
+    return true;
+  } catch (err: any) {
+    log(`delivery failed for event ${c.id}: ${err?.message ?? err}; left for the sweep`);
+    await deps.release(c.id).catch(() => {});
+    return false;
+  }
+}
+
+/**
+ * Scheduler path. Resolves true when the run's heal event carries an owner-email obligation (the
+ * obligation, not the default post-run email, is now the owner notification), whether the send
+ * happened here, was already done, or is left for the sweep. False = no obligation, so the caller
+ * keeps the legacy default email. Never throws.
+ */
+export async function deliverOwnerEmailForRun(runId: string, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<boolean> {
+  try {
+    if (!(await deps.hasObligation(runId))) return false;
+  } catch (err: any) {
+    log(`obligation probe failed run=${runId}: ${err?.message ?? err}`);
+    return false;
+  }
+  try {
+    const claimed = await deps.claimByRun(runId);
+    if (claimed) await sendClaimed(claimed, deps);
+  } catch (err: any) {
+    log(`claim failed run=${runId} (left for the sweep): ${err?.message ?? err}`);
+  }
+  return true;
+}
+
+/** Sweep path: redeliver every obligation a crash left undelivered. Returns the number sent. */
+export async function sweepOwnerEmails(olderThanMs: number, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<number> {
+  let sent = 0;
+  let rows: OwnerEmailClaim[];
+  try {
+    rows = await deps.list(olderThanMs);
+  } catch (err: any) {
+    log(`list failed: ${err?.message ?? err}`);
+    return 0;
+  }
+  for (const r of rows) {
+    try {
+      const c = await deps.claim(r.id);
+      if (c && (await sendClaimed(c, deps))) sent++;
+    } catch (err: any) {
+      log(`sweep claim failed for ${r.id}: ${err?.message ?? err}`);
+    }
+  }
+  return sent;
+}
diff --git a/hub/src/heal/route.ts b/hub/src/heal/route.ts
index 4885cc3..b3c4ffa 100644
--- a/hub/src/heal/route.ts
+++ b/hub/src/heal/route.ts
@@ -63,8 +63,13 @@ export interface HealDeps {
   notify?: NotifyDeps;
   /** Governed autospawn collaborators (07-06). Defaults to REAL_AUTOSPAWN. */
   autospawn?: AutospawnDeps;
+  /** Adds the heal outcome to a still-undelivered owner-email obligation (best-effort). */
+  appendOwnerEmailReason?(eventId: string, reason: string): Promise<void>;
 }
 
+const REAL_APPEND_REASON = async (eventId: string, reason: string): Promise<void> =>
+  (await import('../db/heal-events-dal.ts')).appendOwnerEmailReason(eventId, reason);
+
 /** Real collaborators. DB-touching ones are lazy so importing this module never loads the DB. */
 export const REAL_DEPS: HealDeps = {
   now: () => Date.now(),
@@ -172,6 +177,17 @@ async function finalizeNonLive(
 ): Promise<HealOutcome> {
   await persist(deps, eventId, outcome, extra);
   await terminalize(sink, sinkOutcome ?? (outcome as HealTerminalOutcome));
+  // Outbox (repair round): a scheduled_task event carrying a persisted owner-email obligation is
+  // notified by THAT obligation (scheduler sends it, the sweep redelivers it after a crash). Heal
+  // adds its outcome to the obligation and never sends a second, ownerless email.
+  if (event.source === 'scheduled_task' && event.owner_email) {
+    try {
+      await (deps.appendOwnerEmailReason ?? REAL_APPEND_REASON)(eventId, outcomeReason(outcome));
+    } catch (err) {
+      log(`owner email reason append failed id=${eventId}: ${errMsg(err)}`);
+    }
+    notify = false;
+  }
   if (!notify) {
     // The owner notification for this event was already settled elsewhere (the scheduler default
     // email, selected when the launch outcome was returned). Take the claim only, never send.
@@ -480,6 +496,7 @@ export async function routeHeal(input: unknown, deps: HealDeps = REAL_DEPS): Pro
       ...(target.kind !== 'none' ? { maxPerRepoHour: healMaxPerRepoHour() } : {}),
       ...(event.source === 'scheduled_task' ? { maxPerTaskDay: healMaxPerTaskDay() } : {}),
       recoveryCtx: recoveryCtxFor(event),
+      ...(event.source === 'scheduled_task' && event.owner_email ? { ownerEmail: event.owner_email } : {}),
       nowMs: deps.now(),
     });
     if (!claim.ok) {
diff --git a/hub/src/heal/sources/scheduled-task.ts b/hub/src/heal/sources/scheduled-task.ts
index 5b41d31..ad1e3ce 100644
--- a/hub/src/heal/sources/scheduled-task.ts
+++ b/hub/src/heal/sources/scheduled-task.ts
@@ -20,6 +20,7 @@ import { healMaxPerTaskDay } from '../config.ts';
 import { isInternalScheduledTask } from '../internal-task.ts';
 import { canonicalRepoIdent, type RepoIdentSession } from '../repo-ident.ts';
 import type { HealOutcome } from '../types.ts';
+import { buildNotification } from '../notify.ts';
 
 export interface HealableTask {
   id: string;
@@ -34,6 +35,11 @@ export interface FailedRunInput {
   status: string;
   error: string | null | undefined;
   task: HealableTask;
+  /**
+   * True when the scheduler's default failure email applies to this run. The pending email is then
+   * persisted with the heal claim (outbox) so it survives a crash before the scheduler sends it.
+   */
+  persistOwnerEmail?: boolean;
 }
 
 export interface ScheduledSourceDeps {
@@ -111,6 +117,19 @@ export async function healFailedScheduledRun(
     fenceUntrusted('untrusted_task_failure', [`Task: ${name}`, `Run: ${runId}`, `Error: ${error ?? '(none)'}`].join('\n'), 4000),
   ].join('\n');
 
+  const ownerEmail = input.persistOwnerEmail
+    ? buildNotification(
+        {
+          user_id: task.user_id,
+          source: 'scheduled_task',
+          dedupe_key: `task:${task.id}`,
+          repo_ident: repoIdent,
+          notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`,
+        },
+        'scheduled task failed',
+      )
+    : null;
+
   const outcome = await deps.routeHeal({
     source: 'scheduled_task',
     user_id: task.user_id,
@@ -121,6 +140,7 @@ export async function healFailedScheduledRun(
     trigger_run_id: runId,
     dedupe_key: `task:${task.id}:${signature}`,
     bound_session_id: task.session_id,
+    ...(ownerEmail ? { owner_email: ownerEmail } : {}),
     notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`.slice(0, 500),
     ctx: { task_id: task.id, task_name: name, error_signature: normalized },
   });
diff --git a/hub/src/heal/sweep.ts b/hub/src/heal/sweep.ts
index c9befca..95985d0 100644
--- a/hub/src/heal/sweep.ts
+++ b/hub/src/heal/sweep.ts
@@ -11,6 +11,7 @@
 
 import { healUnifiedEnabled, healSpawnTimeoutMs } from './config.ts';
 import { OUTCOME_AUTOSPAWN_STARTING } from './types.ts';
+import { sweepOwnerEmails, REAL_OWNER_EMAIL_DEPS, type OwnerEmailDeps } from './owner-email.ts';
 import { notifyOnce, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';
 import type { HealEvent } from './types.ts';
 import type { HealOutcomeExtra, HealEventRow } from '../db/heal-events-dal.ts';
@@ -32,12 +33,15 @@ export interface SweepDeps {
   makeSink: SinkFactory;
   release(userId: string, repoIdent: string, eventId: string): Promise<void>;
   notify?: NotifyDeps;
+  /** Owner-email outbox collaborators (defaults to the real DAL + email sender). */
+  ownerEmails?: OwnerEmailDeps;
   /** One-shot timer for the follow-up sweep (unref'd in the real binding). */
   setTimer?(fn: () => void, ms: number): unknown;
 }
 
 /** Real collaborators: lazy imports, so a flag-OFF boot loads nothing of this. */
 export const REAL_SWEEP_DEPS: SweepDeps = {
+  ownerEmails: REAL_OWNER_EMAIL_DEPS,
   list: async (olderThanMs) => (await import('../db/heal-events-dal.ts')).listStaleLaunchingHealEvents(olderThanMs),
   reread: async (id) => (await import('../db/heal-events-dal.ts')).getHealEvent(id),
   setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
@@ -79,7 +83,7 @@ export interface SweepResult {
   failed: number;
 }
 
-export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
+async function sweepStrandedLaunches(deps: SweepDeps): Promise<SweepResult> {
   const result: SweepResult = { swept: 0, skipped: 0, failed: 0 };
   if (!healUnifiedEnabled()) return result; // flag OFF: nothing is read, nothing is touched
 
@@ -144,6 +148,24 @@ export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS):
   return result;
 }
 
+/**
+ * Stranded launches first (a terminalized scheduled_task event's obligation is then due), then the
+ * owner-email outbox: every default failure email a crash left undelivered is sent exactly once
+ * (lease CAS). Flag OFF: nothing is read or touched.
+ */
+export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
+  if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
+  const result = await sweepStrandedLaunches(deps);
+  if (!deps.ownerEmails) return result; // injected-deps callers opt in explicitly
+  try {
+    const sent = await sweepOwnerEmails(2 * healSpawnTimeoutMs(), deps.ownerEmails);
+    if (sent) log(`owner email outbox: ${sent} redelivered`);
+  } catch (err: any) {
+    log(`owner email outbox sweep failed: ${err?.message ?? err}`);
+  }
+  return result;
+}
+
 /**
  * Boot entry: sweep now, then ONE follow-up at the spawn deadline plus the staleness guard so a row
  * stranded by a quick restart (younger than the guard at boot) is swept as soon as it ages in.
diff --git a/hub/src/heal/types.ts b/hub/src/heal/types.ts
index a033e93..d255758 100644
--- a/hub/src/heal/types.ts
+++ b/hub/src/heal/types.ts
@@ -42,6 +42,8 @@ const scheduledTask = z
     source: z.literal('scheduled_task'),
     dedupe_key: z.string().startsWith('task:'),
     bound_session_id: nonEmpty,
+    /** Pending default owner email, persisted with the claim (outbox). Absent = heal sends its own. */
+    owner_email: z.object({ subject: nonEmpty, text: nonEmpty, html: nonEmpty }).optional(),
     ctx: z.object({ task_id: nonEmpty, task_name: z.string(), error_signature: z.string() }),
   })
   .strict();
diff --git a/hub/src/scheduler/dispatcher.ts b/hub/src/scheduler/dispatcher.ts
index 7946b9a..d4c1afc 100644
--- a/hub/src/scheduler/dispatcher.ts
+++ b/hub/src/scheduler/dispatcher.ts
@@ -836,7 +836,16 @@ async function healFailedRunHook(
     const { healUnifiedEnabled } = await import('../heal/config.ts')
     if (!healUnifiedEnabled()) return false
     const { healFailedScheduledRun } = await import('../heal/sources/scheduled-task.ts')
-    return await healFailedScheduledRun({ runId, status: 'failed', error, task })
+    // Outbox: when the default failure email applies, it is persisted with the heal claim and sent
+    // from here, so a crash between the claim and the send cannot lose it (the sweep redelivers).
+    const { defaultFailureEmailApplies } = await import('./post-run/dispatcher.ts')
+    const persistOwnerEmail = await defaultFailureEmailApplies(task).catch(() => false)
+    const healOwns = await healFailedScheduledRun({ runId, status: 'failed', error, task, persistOwnerEmail })
+    if (persistOwnerEmail) {
+      const { deliverOwnerEmailForRun } = await import('../heal/owner-email.ts')
+      if (await deliverOwnerEmailForRun(runId)) return true
+    }
+    return healOwns
   } catch (err: any) {
     log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
     return false
diff --git a/hub/src/scheduler/post-run/dispatcher.ts b/hub/src/scheduler/post-run/dispatcher.ts
index d4d0f16..182af49 100644
--- a/hub/src/scheduler/post-run/dispatcher.ts
+++ b/hub/src/scheduler/post-run/dispatcher.ts
@@ -301,6 +301,13 @@ export async function handleInternalTriageRun(args: AfterRunArgs): Promise<void>
   )
 }
 
+/** True when the default failure email would be built for a failed root run of this task. */
+export async function defaultFailureEmailApplies(task: ScheduledTask): Promise<boolean> {
+  const parsed = validatePostRunActions(await listActionsForTask(task.id))
+  if (!parsed.ok) return false // fireWithContext returns before any action when the set is invalid
+  return buildDefaultEmailActions(task, 0, parsed.value, { status: 'failed', output_snippet: null }).length > 0
+}
+
 export async function fireWithContext(args: FireCtxArgs): Promise<void> {
   // Awaited (errors contained) so the AAF forward + fallback email finish inside the
   // post-run lifecycle instead of being orphaned when the caller releases.
diff --git a/hub/test/heal-owner-email-outbox.test.ts b/hub/test/heal-owner-email-outbox.test.ts
new file mode 100644
index 0000000..e33e709
--- /dev/null
+++ b/hub/test/heal-owner-email-outbox.test.ts
@@ -0,0 +1,278 @@
+/**
+ * PTYCAP-07 repair round (QC round3-codex MAJOR #1): the default owner email for a scheduled-task
+ * heal event is a durable obligation persisted WITH the heal claim. Crash between the claim and the
+ * scheduler send -> the heal sweep sends exactly one; the normal path sends exactly one.
+ * DB-free: an in-memory outbox mirrors the lease-CAS semantics of the DAL (SQL pinned separately).
+ */
+process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
+
+import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
+import { routeHeal, type HealDeps } from '../src/heal/route.ts'
+import { healFailedScheduledRun, type ScheduledSourceDeps } from '../src/heal/sources/scheduled-task.ts'
+import { deliverOwnerEmailForRun, sweepOwnerEmails, type OwnerEmailDeps } from '../src/heal/owner-email.ts'
+import { sweepStaleHealLaunches, type SweepDeps } from '../src/heal/sweep.ts'
+import { claimHealEvent, claimOwnerEmailDelivery, listPendingOwnerEmails } from '../src/db/heal-events-dal.ts'
+
+const savedFlag = process.env.REMO_HEAL_UNIFIED
+beforeEach(() => {
+  process.env.REMO_HEAL_UNIFIED = '1'
+})
+afterAll(() => {
+  if (savedFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
+  else process.env.REMO_HEAL_UNIFIED = savedFlag
+})
+
+const REPO = 'github://acme/web'
+const TASK = { id: 't1', name: 'Nightly', user_id: 'u1', session_id: 's1', is_internal: false }
+
+interface Row {
+  id: string
+  user_id: string
+  trigger_run_id: string
+  owner_email: { subject: string; text: string; html: string }
+  claimed_at: number | null
+  delivered: boolean
+}
+
+/** In-memory outbox with the same CAS rules as the SQL. */
+function world() {
+  const rows: Row[] = []
+  const sends: Array<{ to: string; subject: string }> = []
+  const heal = { sends: 0 }
+  let clock = 1_000_000
+  let sendOk = true
+  const LEASE = 300_000
+  const outbox: OwnerEmailDeps = {
+    hasObligation: async (runId) => rows.some((r) => r.trigger_run_id === runId),
+    claimByRun: async (runId) => {
+      const r = rows.find((x) => x.trigger_run_id === runId)
+      return r ? take(r) : null
+    },
+    list: async () => rows.filter((r) => !r.delivered && (r.claimed_at == null || r.claimed_at < clock - LEASE)).map((r) => ({ id: r.id, user_id: r.user_id, owner_email: r.owner_email })),
+    claim: async (id) => {
+      const r = rows.find((x) => x.id === id)
+      return r ? take(r) : null
+    },
+    markDelivered: async (id) => {
+      rows.find((x) => x.id === id)!.delivered = true
+    },
+    release: async (id) => {
+      rows.find((x) => x.id === id)!.claimed_at = null
+    },
+    resolveOwnerEmail: async () => 'owner@example.com',
+    send: async (m) => {
+      if (!sendOk) return false
+      sends.push({ to: m.to, subject: m.subject })
+      return true
+    },
+  }
+  function take(r: Row) {
+    if (r.delivered || (r.claimed_at != null && r.claimed_at >= clock - LEASE)) return null
+    r.claimed_at = clock
+    return { id: r.id, user_id: r.user_id, owner_email: r.owner_email }
+  }
+  const healDeps: HealDeps = {
+    now: () => clock,
+    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
+    claim: async (args) => {
+      // the obligation is stored in the SAME step as the claim
+      const id = `ev${rows.length + 1}`
+      rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
+      return { ok: true, id }
+    },
+    setOutcome: async () => {},
+    isHealGenerated: async () => false,
+    makeSink: () => ({ finalizeTerminal: async () => {}, onParkExpire: async () => {} }) as any,
+    dispatch: async () => ({ kind: 'dispatched', runId: 'r1' }) as any,
+    runnerTypeOf: async () => 'stream-json',
+    isChannelOnline: () => true,
+    notify: { claim: async () => true, resolveOwnerEmail: async () => 'owner@example.com', send: async () => { heal.sends++; return true } },
+  }
+  const sourceDeps: ScheduledSourceDeps = {
+    isHealGenerated: async () => false,
+    getSession: async () => ({ repo_key: REPO, agent_session_id: null, runner_type: 'stream-json' }) as any,
+    countTaskClaimsToday: async () => 0,
+    routeHeal: (event) => routeHeal(event, healDeps),
+  }
+  return {
+    rows, sends, heal, outbox, sourceDeps,
+    setSendOk: (v: boolean) => { sendOk = v },
+    advance: (ms: number) => { clock += ms },
+  }
+}
+
+const fail = (w: ReturnType<typeof world>, runId: string) =>
+  healFailedScheduledRun({ runId, status: 'failed', error: 'boom', task: TASK, persistOwnerEmail: true }, w.sourceDeps)
+
+describe('owner-email outbox: persisted with the heal claim', () => {
+  test('the claim carries the obligation; no email has been sent yet', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    expect(w.rows).toHaveLength(1)
+    expect(w.rows[0]!.owner_email.subject).toMatch(/\[heal\]/)
+    expect(w.rows[0]!.owner_email.text).toContain('run1')
+    expect(w.sends).toHaveLength(0)
+    expect(w.heal.sends).toBe(0)
+  })
+
+  test('without persistOwnerEmail nothing is persisted (legacy default email path)', async () => {
+    const w = world()
+    await healFailedScheduledRun({ runId: 'run1', status: 'failed', error: 'boom', task: TASK }, w.sourceDeps)
+    expect(w.rows[0]!.owner_email).toBeUndefined()
+  })
+})
+
+describe('owner-email outbox: crash between claim and send', () => {
+  test('sweep sends exactly one email; a second sweep sends none', async () => {
+    const w = world()
+    await fail(w, 'run1') // claim + obligation persisted, then the hub "crashes": no deliverOwnerEmailForRun
+    w.advance(10 * 60_000)
+    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
+    expect(w.sends).toHaveLength(1)
+    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(0)
+    expect(w.sends).toHaveLength(1)
+    expect(w.heal.sends).toBe(0)
+  })
+
+  test('the real sweep entry point runs the outbox pass', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    const deps: SweepDeps = {
+      list: async () => [],
+      reread: async () => null,
+      setOutcome: async () => {},
+      makeSink: (() => ({})) as any,
+      release: async () => {},
+      ownerEmails: w.outbox,
+    }
+    w.advance(10 * 60_000)
+    await sweepStaleHealLaunches(deps)
+    expect(w.sends).toHaveLength(1)
+  })
+
+  test('a send that failed is retried by the sweep (still exactly one delivered)', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    w.setSendOk(false)
+    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true)
+    expect(w.sends).toHaveLength(0)
+    w.setSendOk(true)
+    w.advance(10 * 60_000)
+    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
+    expect(w.sends).toHaveLength(1)
+  })
+
+  test('a crash mid-send (lease held) is not re-sent inside the lease, only after it expires', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    await w.outbox.claimByRun('run1') // claimed, then crashed before send/mark
+    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
+    w.advance(10 * 60_000)
+    expect(await sweepOwnerEmails(0, w.outbox)).toBe(1)
+    expect(w.sends).toHaveLength(1)
+  })
+})
+
+describe('owner-email outbox: normal path', () => {
+  test('scheduler delivery sends exactly one; the sweep afterwards sends none; default email suppressed', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true) // true => suppressDefaultFailureEmail
+    expect(w.sends).toHaveLength(1)
+    w.advance(10 * 60_000)
+    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
+    expect(w.sends).toHaveLength(1)
+    expect(w.heal.sends).toBe(0)
+  })
+
+  test('scheduler and sweep racing: one delivers', async () => {
+    const w = world()
+    await fail(w, 'run1')
+    w.advance(10 * 60_000)
+    await Promise.all([deliverOwnerEmailForRun('run1', w.outbox), sweepOwnerEmails(0, w.outbox)])
+    expect(w.sends).toHaveLength(1)
+  })
+
+  test('no obligation (opted out / no event) => false, caller keeps legacy default email', async () => {
+    const w = world()
+    expect(await deliverOwnerEmailForRun('nope', w.outbox)).toBe(false)
+    expect(w.sends).toHaveLength(0)
+  })
+})
+
+describe('owner-email outbox: non-live heal outcome does not add a second, ownerless email', () => {
+  test('no_routable_session with an obligation: heal sends nothing itself', async () => {
+    const w = world()
+    const noTarget = { ...w.sourceDeps, routeHeal: (e: unknown) => routeHeal(e, { ...hd(w), resolve: async () => ({ kind: 'none', reason: 'no_session' }) as any }) }
+    await healFailedScheduledRun({ runId: 'run2', status: 'failed', error: 'x', task: TASK, persistOwnerEmail: true }, noTarget)
+    expect(w.heal.sends).toBe(0)
+    expect(await deliverOwnerEmailForRun('run2', w.outbox)).toBe(true)
+    expect(w.sends).toHaveLength(1)
+  })
+})
+
+function hd(w: ReturnType<typeof world>): HealDeps {
+  // rebuild the same deps the world uses (route only needs the claim to register the obligation)
+  return {
+    now: () => 1_000_000,
+    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
+    claim: async (args) => {
+      const id = `ev${w.rows.length + 1}`
+      w.rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
+      return { ok: true, id }
+    },
+    setOutcome: async () => {},
+    isHealGenerated: async () => false,
+    makeSink: () => ({ finalizeTerminal: async () => {}, onParkExpire: async () => {} }) as any,
+    dispatch: async () => ({ kind: 'dispatched', runId: 'r1' }) as any,
+    runnerTypeOf: async () => 'stream-json',
+    isChannelOnline: () => true,
+    notify: { claim: async () => true, resolveOwnerEmail: async () => 'owner@example.com', send: async () => { w.heal.sends++; return true } },
+    appendOwnerEmailReason: async () => {},
+  }
+}
+
+describe('owner-email outbox: SQL pins (fake executor)', () => {
+  function fake(responder: (text: string) => unknown[] = () => []) {
+    const calls: Array<{ text: string; values: unknown[] }> = []
+    const tag = (s: TemplateStringsArray, ...v: unknown[]) => {
+      const text = s.join('?')
+      calls.push({ text, values: v })
+      return Promise.resolve(responder(text))
+    }
+    const exec: any = Object.assign(tag, { begin: async (fn: (tx: any) => Promise<unknown>) => fn(tag) })
+    return { exec, calls }
+  }
+
+  test('claimHealEvent INSERT writes owner_email in the same transaction', async () => {
+    const { exec, calls } = fake((t) => (/INSERT INTO heal_events/.test(t) ? [{ id: 'ev1' }] : /count\(\*\)/i.test(t) ? [{ n: '0' }] : []))
+    const r = await claimHealEvent(
+      {
+        userId: 'u1', source: 'scheduled_task', dedupeKey: 'task:t1:abc', repoIdent: REPO, triggerRunId: 'run1',
+        windowMs: 3_600_000, maxClaimsPerUserHour: 10, retentionHours: 48,
+        ownerEmail: { subject: 's', text: 't', html: 'h' }, nowMs: 1_000_000,
+      },
+      exec,
+    )
+    expect(r.ok).toBe(true)
+    const ins = calls.find((c) => /INSERT INTO heal_events/.test(c.text))!
+    expect(ins.text).toContain('owner_email')
+    expect(ins.values).toContain(JSON.stringify({ subject: 's', text: 't', html: 'h' }))
+  })
+
+  test('delivery is a lease CAS on the delivered flag', async () => {
+    const { exec, calls } = fake(() => [])
+    expect(await claimOwnerEmailDelivery('ev1', 300_000, exec, 1_000_000)).toBeNull()
+    const t = calls[0]!.text
+    expect(t).toMatch(/UPDATE heal_events SET owner_email_claimed_at/)
+    expect(t).toMatch(/owner_email_delivered_at IS NULL/)
+    expect(t).toMatch(/owner_email_claimed_at IS NULL OR owner_email_claimed_at </)
+    expect(t).toMatch(/RETURNING/)
+  })
+
+  test('the sweep list selects only undelivered obligations', async () => {
+    const { exec, calls } = fake(() => [])
+    await listPendingOwnerEmails(60_000, exec, 1_000_000)
+    expect(calls[0]!.text).toMatch(/owner_email IS NOT NULL AND owner_email_delivered_at IS NULL/)
+  })
+})

codex
The commit adds the intended transactionally persisted obligation and an idempotent schema migration. I’m now checking the surrounding scheduler control flow, because suppression/ownership mismatches are where either double-send or zero-send failures can hide.
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 10 "healFailedRunHook|suppressDefaultFailureEmail|fireWithContext|defaultFailureEmailApplies|buildDefaultEmailActions|listActionsForTask" hub/src/scheduler/dispatcher.ts hub/src/scheduler/post-run/dispatcher.ts' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 8 "sweepStaleHealLaunches|startHealSweep|boot.*sweep|ownerEmails|heal.*sweep" hub/src hub/test' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n -C 8 \"finalizeNonLive\\(|notifyOnce\\(|owner_email|ClaimHealArgs|claimHealEvent\" hub/src/heal hub/src/db/heal-events-dal.ts" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 6 "CREATE TABLE IF NOT EXISTS heal_events|ALTER TABLE heal_events|trigger_run_id|idx_heal_events_trigger" hub/src/db/schema.sql hub/src/db/heal-events-dal.ts' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 702ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/scheduler/dispatcher.ts-803-    output_snippet: fields.output_snippet ?? null,
hub/src/scheduler/dispatcher.ts-804-  })
hub/src/scheduler/dispatcher.ts-805-
hub/src/scheduler/dispatcher.ts-806-  const task = ctx?.taskId
hub/src/scheduler/dispatcher.ts-807-    ? await getTaskById(ctx.taskId)
hub/src/scheduler/dispatcher.ts-808-    : updated?.task_id ? await getTaskById(updated.task_id) : null
hub/src/scheduler/dispatcher.ts-809-  if (task) {
hub/src/scheduler/dispatcher.ts-810-    // PTYCAP-07-08 (AM-F5-2): heal hook BETWEEN the terminal UPDATE and post-run processing.
hub/src/scheduler/dispatcher.ts-811-    // Inert (returns false, imports nothing) unless the run failed AND REMO_HEAL_UNIFIED is ON.
hub/src/scheduler/dispatcher.ts-812-    const healOwnsNotification = status === 'failed'
hub/src/scheduler/dispatcher.ts:813:      ? await healFailedRunHook(task, runId, error ?? null)
hub/src/scheduler/dispatcher.ts-814-      : false
hub/src/scheduler/dispatcher.ts-815-    await onRunFinalized(task, runId, status, error ?? null, {
hub/src/scheduler/dispatcher.ts-816-      cost_usd: costUsd,
hub/src/scheduler/dispatcher.ts-817-      duration_ms: dur,
hub/src/scheduler/dispatcher.ts-818-      output_snippet: fields.output_snippet ?? null,
hub/src/scheduler/dispatcher.ts-819-      parentFireId: ctx?.parentFireId ?? null,
hub/src/scheduler/dispatcher.ts-820-      chainDepth: ctx?.chainDepth ?? 0,
hub/src/scheduler/dispatcher.ts:821:      ...(healOwnsNotification ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler/dispatcher.ts-822-    })
hub/src/scheduler/dispatcher.ts-823-  }
hub/src/scheduler/dispatcher.ts-824-}
hub/src/scheduler/dispatcher.ts-825-
hub/src/scheduler/dispatcher.ts-826-/**
hub/src/scheduler/dispatcher.ts-827- * Never throws into finalizeRun. Resolves true only when the heal path claimed and sent the one
hub/src/scheduler/dispatcher.ts-828- * owner notification; any error resolves false so the normal failure email proceeds.
hub/src/scheduler/dispatcher.ts-829- */
hub/src/scheduler/dispatcher.ts:830:async function healFailedRunHook(
hub/src/scheduler/dispatcher.ts-831-  task: ScheduledTask,
hub/src/scheduler/dispatcher.ts-832-  runId: string,
hub/src/scheduler/dispatcher.ts-833-  error: string | null,
hub/src/scheduler/dispatcher.ts-834-): Promise<boolean> {
hub/src/scheduler/dispatcher.ts-835-  try {
hub/src/scheduler/dispatcher.ts-836-    const { healUnifiedEnabled } = await import('../heal/config.ts')
hub/src/scheduler/dispatcher.ts-837-    if (!healUnifiedEnabled()) return false
hub/src/scheduler/dispatcher.ts-838-    const { healFailedScheduledRun } = await import('../heal/sources/scheduled-task.ts')
hub/src/scheduler/dispatcher.ts-839-    // Outbox: when the default failure email applies, it is persisted with the heal claim and sent
hub/src/scheduler/dispatcher.ts-840-    // from here, so a crash between the claim and the send cannot lose it (the sweep redelivers).
hub/src/scheduler/dispatcher.ts:841:    const { defaultFailureEmailApplies } = await import('./post-run/dispatcher.ts')
hub/src/scheduler/dispatcher.ts:842:    const persistOwnerEmail = await defaultFailureEmailApplies(task).catch(() => false)
hub/src/scheduler/dispatcher.ts-843-    const healOwns = await healFailedScheduledRun({ runId, status: 'failed', error, task, persistOwnerEmail })
hub/src/scheduler/dispatcher.ts-844-    if (persistOwnerEmail) {
hub/src/scheduler/dispatcher.ts-845-      const { deliverOwnerEmailForRun } = await import('../heal/owner-email.ts')
hub/src/scheduler/dispatcher.ts-846-      if (await deliverOwnerEmailForRun(runId)) return true
hub/src/scheduler/dispatcher.ts-847-    }
hub/src/scheduler/dispatcher.ts-848-    return healOwns
hub/src/scheduler/dispatcher.ts-849-  } catch (err: any) {
hub/src/scheduler/dispatcher.ts-850-    log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler/dispatcher.ts-851-    return false
hub/src/scheduler/dispatcher.ts-852-  }
hub/src/scheduler/dispatcher.ts-853-}
hub/src/scheduler/dispatcher.ts-854-
hub/src/scheduler/dispatcher.ts-855-interface PostRunPayload {
hub/src/scheduler/dispatcher.ts-856-  cost_usd: number | null
hub/src/scheduler/dispatcher.ts-857-  duration_ms: number | null
hub/src/scheduler/dispatcher.ts-858-  output_snippet: string | null
hub/src/scheduler/dispatcher.ts-859-  parentFireId?: string | null
hub/src/scheduler/dispatcher.ts-860-  chainDepth: number
hub/src/scheduler/dispatcher.ts-861-  /** PTYCAP-07-08: the heal path already notified the owner of this failure. */
hub/src/scheduler/dispatcher.ts:862:  suppressDefaultFailureEmail?: boolean
hub/src/scheduler/dispatcher.ts-863-}
hub/src/scheduler/dispatcher.ts-864-
hub/src/scheduler/dispatcher.ts-865-async function onRunFinalized(
hub/src/scheduler/dispatcher.ts-866-  task: ScheduledTask,
hub/src/scheduler/dispatcher.ts-867-  runId: string,
hub/src/scheduler/dispatcher.ts-868-  status: RunStatus,
hub/src/scheduler/dispatcher.ts-869-  error: string | null,
hub/src/scheduler/dispatcher.ts-870-  extra: PostRunPayload = { cost_usd: null, duration_ms: null, output_snippet: null, chainDepth: 0 },
hub/src/scheduler/dispatcher.ts-871-): Promise<void> {
hub/src/scheduler/dispatcher.ts-872-  try {
--
hub/src/scheduler/dispatcher.ts-874-    await afterRun({
hub/src/scheduler/dispatcher.ts-875-      task,
hub/src/scheduler/dispatcher.ts-876-      runId,
hub/src/scheduler/dispatcher.ts-877-      status,
hub/src/scheduler/dispatcher.ts-878-      error,
hub/src/scheduler/dispatcher.ts-879-      cost_usd: extra.cost_usd,
hub/src/scheduler/dispatcher.ts-880-      duration_ms: extra.duration_ms,
hub/src/scheduler/dispatcher.ts-881-      output_snippet: extra.output_snippet,
hub/src/scheduler/dispatcher.ts-882-      parentFireId: extra.parentFireId ?? null,
hub/src/scheduler/dispatcher.ts-883-      chainDepth: extra.chainDepth,
hub/src/scheduler/dispatcher.ts:884:      ...(extra.suppressDefaultFailureEmail ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler/dispatcher.ts-885-    })
hub/src/scheduler/dispatcher.ts-886-  } catch (err: any) {
hub/src/scheduler/dispatcher.ts-887-    log.error('scheduler.dispatcher.post_run_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler/dispatcher.ts-888-  }
hub/src/scheduler/dispatcher.ts-889-}
hub/src/scheduler/dispatcher.ts-890-
hub/src/scheduler/dispatcher.ts-891-export async function cancelRun(runId: string, userId: string): Promise<boolean> {
hub/src/scheduler/dispatcher.ts-892-  const ctx = inFlightByRun.get(runId)
hub/src/scheduler/dispatcher.ts-893-  if (ctx && ctx.userId !== userId) return false
hub/src/scheduler/dispatcher.ts-894-  if (ctx?.target?.agentSocket) {
--
hub/src/scheduler/post-run/dispatcher.ts-6- *   - check the `on` condition against the run status (incl. cost_exceeded
hub/src/scheduler/post-run/dispatcher.ts-7- *     when error === 'daily_cost_cap')
hub/src/scheduler/post-run/dispatcher.ts-8- *   - apply delay_seconds via setTimeout (timers tracked for shutdown)
hub/src/scheduler/post-run/dispatcher.ts-9- *   - route to the right executor under ./
hub/src/scheduler/post-run/dispatcher.ts-10- *
hub/src/scheduler/post-run/dispatcher.ts-11- * For fan-out parent fires (target_kind === 'all_*'): instead of firing
hub/src/scheduler/post-run/dispatcher.ts-12- * actions per child finalize, route through the aggregator (T8.7) which
hub/src/scheduler/post-run/dispatcher.ts-13- * collects all child results and fires actions ONCE with an aggregate.
hub/src/scheduler/post-run/dispatcher.ts-14- */
hub/src/scheduler/post-run/dispatcher.ts-15-import type { ScheduledTask, RunStatus } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts:16:import { listActionsForTask } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-17-import { validatePostRunActions, type PostRunAction } from './schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-18-import { executeChain } from './chain.ts'
hub/src/scheduler/post-run/dispatcher.ts-19-import { getTaskById } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-20-import { parseControllerDecision, nextStepForAction } from '../controller-schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-21-import { parseQcFindings, findingHash } from '../qc-schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-22-import { isTerminalSummary } from '../summary-line.ts'
hub/src/scheduler/post-run/dispatcher.ts-23-import { hasVerifiedFinding, recordVerifiedFinding } from '../../db/dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-24-import { findQcReviewSnippetForRun, getRun } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-25-import { executeEmail } from './email.ts'
hub/src/scheduler/post-run/dispatcher.ts-26-import { executeTelegram } from './telegram.ts'
--
hub/src/scheduler/post-run/dispatcher.ts-70- * internal task still emails (belt-and-suspenders alongside the best-effort
hub/src/scheduler/post-run/dispatcher.ts-71- * AgentAutofix forward in `handleInternalTriageRun` below), and none of this
hub/src/scheduler/post-run/dispatcher.ts-72- * touches user-created tasks. A `success` triage run carrying an actionable
hub/src/scheduler/post-run/dispatcher.ts-73- * finding is forwarded to AgentAutofix by `handleInternalTriageRun`. A `success`
hub/src/scheduler/post-run/dispatcher.ts-74- * internal-task run still reaches the owner's inbox in exactly two cases: the
hub/src/scheduler/post-run/dispatcher.ts-75- * triage finding is `high`/`critical` (`isHighSeverityTriageFinding` — it is about
hub/src/scheduler/post-run/dispatcher.ts-76- * the owner's own failing app, and the AAF forward lands in the hub's self-capture
hub/src/scheduler/post-run/dispatcher.ts-77- * inbox, not the user's repo), or a low/medium finding's AAF forward itself fails
hub/src/scheduler/post-run/dispatcher.ts-78- * (see `handleInternalTriageRun`).
hub/src/scheduler/post-run/dispatcher.ts-79- */
hub/src/scheduler/post-run/dispatcher.ts:80:export function buildDefaultEmailActions(
hub/src/scheduler/post-run/dispatcher.ts-81-  task: ScheduledTask,
hub/src/scheduler/post-run/dispatcher.ts-82-  chainDepth: number,
hub/src/scheduler/post-run/dispatcher.ts-83-  actions: PostRunAction[],
hub/src/scheduler/post-run/dispatcher.ts-84-  outcome?: { status: RunStatus; output_snippet: string | null },
hub/src/scheduler/post-run/dispatcher.ts:85:  opts?: { suppressDefaultFailureEmail?: boolean },
hub/src/scheduler/post-run/dispatcher.ts-86-): PostRunAction[] {
hub/src/scheduler/post-run/dispatcher.ts-87-  // PTYCAP-07-08 (AM-F5-2): the heal path already sent the one owner notification for this failure.
hub/src/scheduler/post-run/dispatcher.ts:88:  if (opts?.suppressDefaultFailureEmail && outcome?.status === 'failed') return []
hub/src/scheduler/post-run/dispatcher.ts-89-  if (chainDepth !== 0 && !isFailedOrBlocked(outcome)) return []
hub/src/scheduler/post-run/dispatcher.ts-90-  if ((task as any).email_summary === false) return []
hub/src/scheduler/post-run/dispatcher.ts-91-  if (actions.some((a) => a.type === 'notify_email')) return []
hub/src/scheduler/post-run/dispatcher.ts-92-  if (
hub/src/scheduler/post-run/dispatcher.ts-93-    task.name?.startsWith('__internal_') &&
hub/src/scheduler/post-run/dispatcher.ts-94-    !isFailedOrBlocked(outcome) &&
hub/src/scheduler/post-run/dispatcher.ts-95-    !isHighSeverityTriageFinding(task, outcome)
hub/src/scheduler/post-run/dispatcher.ts-96-  ) return []
hub/src/scheduler/post-run/dispatcher.ts-97-  return [
hub/src/scheduler/post-run/dispatcher.ts-98-    {
--
hub/src/scheduler/post-run/dispatcher.ts-156-  task: ScheduledTask
hub/src/scheduler/post-run/dispatcher.ts-157-  runId: string
hub/src/scheduler/post-run/dispatcher.ts-158-  status: RunStatus
hub/src/scheduler/post-run/dispatcher.ts-159-  error: string | null
hub/src/scheduler/post-run/dispatcher.ts-160-  cost_usd: number | null
hub/src/scheduler/post-run/dispatcher.ts-161-  duration_ms: number | null
hub/src/scheduler/post-run/dispatcher.ts-162-  output_snippet: string | null
hub/src/scheduler/post-run/dispatcher.ts-163-  parentFireId: string | null
hub/src/scheduler/post-run/dispatcher.ts-164-  chainDepth: number
hub/src/scheduler/post-run/dispatcher.ts-165-  /** PTYCAP-07-08: set only when the heal path owns the failure notification. */
hub/src/scheduler/post-run/dispatcher.ts:166:  suppressDefaultFailureEmail?: boolean
hub/src/scheduler/post-run/dispatcher.ts-167-}
hub/src/scheduler/post-run/dispatcher.ts-168-
hub/src/scheduler/post-run/dispatcher.ts-169-export async function afterRun(args: AfterRunArgs): Promise<void> {
hub/src/scheduler/post-run/dispatcher.ts-170-  if (args.parentFireId) {
hub/src/scheduler/post-run/dispatcher.ts-171-    await aggregatorReport(
hub/src/scheduler/post-run/dispatcher.ts-172-      args.parentFireId,
hub/src/scheduler/post-run/dispatcher.ts-173-      args.task,
hub/src/scheduler/post-run/dispatcher.ts-174-      { status: args.status, error: args.error },
hub/src/scheduler/post-run/dispatcher.ts-175-      {
hub/src/scheduler/post-run/dispatcher.ts-176-        cost_usd: args.cost_usd,
hub/src/scheduler/post-run/dispatcher.ts-177-        duration_ms: args.duration_ms,
hub/src/scheduler/post-run/dispatcher.ts-178-        output_snippet: args.output_snippet,
hub/src/scheduler/post-run/dispatcher.ts-179-      },
hub/src/scheduler/post-run/dispatcher.ts-180-    )
hub/src/scheduler/post-run/dispatcher.ts-181-    return
hub/src/scheduler/post-run/dispatcher.ts-182-  }
hub/src/scheduler/post-run/dispatcher.ts:183:  await fireWithContext(args)
hub/src/scheduler/post-run/dispatcher.ts-184-}
hub/src/scheduler/post-run/dispatcher.ts-185-
hub/src/scheduler/post-run/dispatcher.ts-186-interface FireCtxArgs extends AfterRunArgs {
hub/src/scheduler/post-run/dispatcher.ts-187-  aggregate?: { total: number; successes: number; failures: number }
hub/src/scheduler/post-run/dispatcher.ts-188-}
hub/src/scheduler/post-run/dispatcher.ts-189-
hub/src/scheduler/post-run/dispatcher.ts-190-/**
hub/src/scheduler/post-run/dispatcher.ts-191- * Resolve the REAL Coolify `deployment_uuid` a `__internal_triage` run was
hub/src/scheduler/post-run/dispatcher.ts-192- * dispatched for. The webhook (api/coolify-webhook.ts) dispatches triage with
hub/src/scheduler/post-run/dispatcher.ts-193- * `triggeredByRunId` = the deployment metadata run, which `insertDeploymentRun`
--
hub/src/scheduler/post-run/dispatcher.ts-217- * `__internal_triage` run handling (fix/triage-task-email-noise). The FINDING
hub/src/scheduler/post-run/dispatcher.ts-218- * must reach AgentAutofix regardless of run status (low/medium never the owner's inbox)
hub/src/scheduler/post-run/dispatcher.ts-219- * — a triage run that finalizes `success` can still describe a real failed
hub/src/scheduler/post-run/dispatcher.ts-220- * deployment (the model's own JSON `error_type`/`severity` is independent of
hub/src/scheduler/post-run/dispatcher.ts-221- * the scheduler's run status), and the previous cut (PR #496) only forwarded
hub/src/scheduler/post-run/dispatcher.ts-222- * on run FAILURE, silently dropping every such success-status finding.
hub/src/scheduler/post-run/dispatcher.ts-223- *
hub/src/scheduler/post-run/dispatcher.ts-224- * FAILURE/BLOCKED: unchanged from the prior cut — best-effort forward through
hub/src/scheduler/post-run/dispatcher.ts-225- * the hub's existing aggregated self-error reporter (dedup/throttle/aggregation
hub/src/scheduler/post-run/dispatcher.ts-226- * built in; this task's failures ARE hub self-errors — the hub's own scheduled
hub/src/scheduler/post-run/dispatcher.ts:227: * triage against its own Coolify config) plus the owner email `buildDefaultEmailActions`
hub/src/scheduler/post-run/dispatcher.ts-228- * still fires for a failed/blocked internal task.
hub/src/scheduler/post-run/dispatcher.ts-229- *
hub/src/scheduler/post-run/dispatcher.ts-230- * SUCCESS with a parseable finding: forward it to AAF, deduped per REAL
hub/src/scheduler/post-run/dispatcher.ts-231- * Coolify `deployment_uuid` (`resolveTriageDeploymentUuid` → `claimTriageFindingForward`).
hub/src/scheduler/post-run/dispatcher.ts-232- * When no uuid is recoverable there is no dedup — the finding is delivered.
hub/src/scheduler/post-run/dispatcher.ts-233- * A low-severity finding is tagged in the title so it's visibly deprioritized
hub/src/scheduler/post-run/dispatcher.ts-234- * without being dropped. low/medium findings get NO owner email
hub/src/scheduler/post-run/dispatcher.ts:235: * (`buildDefaultEmailActions` suppresses them); high/critical findings ARE
hub/src/scheduler/post-run/dispatcher.ts:236: * emailed by `buildDefaultEmailActions` (`isHighSeverityTriageFinding`), so this
hub/src/scheduler/post-run/dispatcher.ts-237- * function never double-sends them. Only a FAILED AAF forward of a low/medium
hub/src/scheduler/post-run/dispatcher.ts-238- * finding falls back to a (scrubbed) owner email, once per deployment — the
hub/src/scheduler/post-run/dispatcher.ts-239- * dedup claim is consumed up front, so a repeat after a failed forward does not
hub/src/scheduler/post-run/dispatcher.ts-240- * retry the email; this is a best-effort escape hatch, not the primary path.
hub/src/scheduler/post-run/dispatcher.ts-241- */
hub/src/scheduler/post-run/dispatcher.ts-242-export async function handleInternalTriageRun(args: AfterRunArgs): Promise<void> {
hub/src/scheduler/post-run/dispatcher.ts-243-  if (args.chainDepth !== 0) return
hub/src/scheduler/post-run/dispatcher.ts-244-  if (args.task.name !== INTERNAL_TRIAGE_TASK_NAME) return
hub/src/scheduler/post-run/dispatcher.ts-245-
hub/src/scheduler/post-run/dispatcher.ts-246-  if (isFailedOrBlocked({ status: args.status, output_snippet: args.output_snippet })) {
--
hub/src/scheduler/post-run/dispatcher.ts-276-    `Run: ${runUrl}`
hub/src/scheduler/post-run/dispatcher.ts-277-
hub/src/scheduler/post-run/dispatcher.ts-278-  const sent = await reportTriageFindingToAgentautofix({
hub/src/scheduler/post-run/dispatcher.ts-279-    fingerprint: `internal-triage-finding:${deploymentKey}`,
hub/src/scheduler/post-run/dispatcher.ts-280-    errorType: `triage_finding:${finding.error_type}`,
hub/src/scheduler/post-run/dispatcher.ts-281-    errorValue: body,
hub/src/scheduler/post-run/dispatcher.ts-282-    source: 'scheduler/post-run/dispatcher:__internal_triage',
hub/src/scheduler/post-run/dispatcher.ts-283-  })
hub/src/scheduler/post-run/dispatcher.ts-284-  if (sent) return
hub/src/scheduler/post-run/dispatcher.ts-285-  // high/critical already reached the owner via the default email
hub/src/scheduler/post-run/dispatcher.ts:286:  // (buildDefaultEmailActions → isHighSeverityTriageFinding); don't double-send.
hub/src/scheduler/post-run/dispatcher.ts-287-  if (finding.severity === 'high' || finding.severity === 'critical') return
hub/src/scheduler/post-run/dispatcher.ts-288-
hub/src/scheduler/post-run/dispatcher.ts-289-  // AAF forward failed — never drop the finding silently. Scrubbed exactly like
hub/src/scheduler/post-run/dispatcher.ts-290-  // the AAF comment it substitutes for (model output can echo tokens/DSNs).
hub/src/scheduler/post-run/dispatcher.ts-291-  await executeEmail(
hub/src/scheduler/post-run/dispatcher.ts-292-    {
hub/src/scheduler/post-run/dispatcher.ts-293-      type: 'notify_email',
hub/src/scheduler/post-run/dispatcher.ts-294-      on: 'always',
hub/src/scheduler/post-run/dispatcher.ts-295-      config: {
hub/src/scheduler/post-run/dispatcher.ts-296-        subject: scrub(`Remo internal triage finding [AAF forward failed] - ${severityTag}${finding.error_type}`).slice(0, 200),
hub/src/scheduler/post-run/dispatcher.ts-297-        body: scrub(body),
hub/src/scheduler/post-run/dispatcher.ts-298-      },
hub/src/scheduler/post-run/dispatcher.ts-299-    } as PostRunAction,
hub/src/scheduler/post-run/dispatcher.ts-300-    { userId: args.task.user_id, templateVars: {} },
hub/src/scheduler/post-run/dispatcher.ts-301-  )
hub/src/scheduler/post-run/dispatcher.ts-302-}
hub/src/scheduler/post-run/dispatcher.ts-303-
hub/src/scheduler/post-run/dispatcher.ts-304-/** True when the default failure email would be built for a failed root run of this task. */
hub/src/scheduler/post-run/dispatcher.ts:305:export async function defaultFailureEmailApplies(task: ScheduledTask): Promise<boolean> {
hub/src/scheduler/post-run/dispatcher.ts:306:  const parsed = validatePostRunActions(await listActionsForTask(task.id))
hub/src/scheduler/post-run/dispatcher.ts:307:  if (!parsed.ok) return false // fireWithContext returns before any action when the set is invalid
hub/src/scheduler/post-run/dispatcher.ts:308:  return buildDefaultEmailActions(task, 0, parsed.value, { status: 'failed', output_snippet: null }).length > 0
hub/src/scheduler/post-run/dispatcher.ts-309-}
hub/src/scheduler/post-run/dispatcher.ts-310-
hub/src/scheduler/post-run/dispatcher.ts:311:export async function fireWithContext(args: FireCtxArgs): Promise<void> {
hub/src/scheduler/post-run/dispatcher.ts-312-  // Awaited (errors contained) so the AAF forward + fallback email finish inside the
hub/src/scheduler/post-run/dispatcher.ts-313-  // post-run lifecycle instead of being orphaned when the caller releases.
hub/src/scheduler/post-run/dispatcher.ts-314-  await handleInternalTriageRun(args).catch((err: any) => {
hub/src/scheduler/post-run/dispatcher.ts-315-    console.error('[post-run.dispatcher] internal triage handling failed', err?.message ?? err)
hub/src/scheduler/post-run/dispatcher.ts-316-  })
hub/src/scheduler/post-run/dispatcher.ts:317:  const actionsRaw = await listActionsForTask(args.task.id)
hub/src/scheduler/post-run/dispatcher.ts-318-  const parsed = validatePostRunActions(actionsRaw)
hub/src/scheduler/post-run/dispatcher.ts-319-  if (!parsed.ok) {
hub/src/scheduler/post-run/dispatcher.ts-320-    console.warn(
hub/src/scheduler/post-run/dispatcher.ts-321-      `[post-run.dispatcher] task=${args.task.id} actions invalid: ${parsed.errors.join('; ')}`,
hub/src/scheduler/post-run/dispatcher.ts-322-    )
hub/src/scheduler/post-run/dispatcher.ts-323-    return
hub/src/scheduler/post-run/dispatcher.ts-324-  }
hub/src/scheduler/post-run/dispatcher.ts-325-  // Default-on run-summary email: fold a synthesized notify_email into the fired
hub/src/scheduler/post-run/dispatcher.ts-326-  // set for eligible ROOT runs (chainDepth===0, not opted out, no custom email).
hub/src/scheduler/post-run/dispatcher.ts:327:  // The fan-out aggregate path also calls fireWithContext with chainDepth 0, so
hub/src/scheduler/post-run/dispatcher.ts-328-  // this yields exactly ONE default email per fired context.
hub/src/scheduler/post-run/dispatcher.ts-329-  const actions = [
hub/src/scheduler/post-run/dispatcher.ts-330-    ...parsed.value,
hub/src/scheduler/post-run/dispatcher.ts:331:    ...buildDefaultEmailActions(args.task, args.chainDepth, parsed.value, {
hub/src/scheduler/post-run/dispatcher.ts-332-      status: args.status,
hub/src/scheduler/post-run/dispatcher.ts-333-      output_snippet: args.output_snippet,
hub/src/scheduler/post-run/dispatcher.ts:334:    }, { suppressDefaultFailureEmail: args.suppressDefaultFailureEmail }),
hub/src/scheduler/post-run/dispatcher.ts-335-  ]
hub/src/scheduler/post-run/dispatcher.ts-336-  if (actions.length === 0) return
hub/src/scheduler/post-run/dispatcher.ts-337-
hub/src/scheduler/post-run/dispatcher.ts-338-  if (args.chainDepth >= MAX_CHAIN_DEPTH) {
hub/src/scheduler/post-run/dispatcher.ts-339-    console.warn(
hub/src/scheduler/post-run/dispatcher.ts-340-      `[post-run.dispatcher] task=${args.task.id} chain_depth_exceeded depth=${args.chainDepth}`,
hub/src/scheduler/post-run/dispatcher.ts-341-    )
hub/src/scheduler/post-run/dispatcher.ts-342-    return
hub/src/scheduler/post-run/dispatcher.ts-343-  }
hub/src/scheduler/post-run/dispatcher.ts-344-

 succeeded in 728ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src\dispatch\automation-controls.ts-433-  } catch (err: any) {
hub/src\dispatch\automation-controls.ts-434-    console.warn(`[automation-controls] lifetime page failed: ${err?.message ?? err}`)
hub/src\dispatch\automation-controls.ts-435-  }
hub/src\dispatch\automation-controls.ts-436-  return outcome
hub/src\dispatch\automation-controls.ts-437-}
hub/src\dispatch\automation-controls.ts-438-
hub/src\dispatch\automation-controls.ts-439-/**
hub/src\dispatch\automation-controls.ts-440- * Strict release: stamps released_at while null and THROWS on a database error, so a caller that
hub/src\dispatch\automation-controls.ts:441: * owes a retry (the heal sweep / route) can tell "released" from "still reserved". Idempotent: a
hub/src\dispatch\automation-controls.ts-442- * row that never reserved, or is already released, matches nothing and resolves.
hub/src\dispatch\automation-controls.ts-443- */
hub/src\dispatch\automation-controls.ts-444-export async function releaseInjectStrict(args: { counterKey: string; token: string }): Promise<void> {
hub/src\dispatch\automation-controls.ts-445-  await sql`
hub/src\dispatch\automation-controls.ts-446-    UPDATE automation_inject_ledger SET released_at = now()
hub/src\dispatch\automation-controls.ts-447-    WHERE counter_key = ${args.counterKey} AND token = ${args.token}
hub/src\dispatch\automation-controls.ts-448-      AND kind = 'inject' AND released_at IS NULL
hub/src\dispatch\automation-controls.ts-449-  `
--
hub/src\index.ts-808-    // wedge every launch with `at_capacity`. No-op when REMO_SESSION_RUN_REAPER_DISABLED.
hub/src\index.ts-809-    startStaleRunReaperSweep()
hub/src\index.ts-810-    // Milestone once — DURABLE tick source of truth for one-time tasks. Fires any
hub/src\index.ts-811-    // `schedule_kind='once'` row that is due (run_at<=now) and still enabled, so an
hub/src\index.ts-812-    // immediate/one-time task dispatches even if the registry's setTimeout(0)
hub/src\index.ts-813-    // latency-optimization is lost (restart / thrown fire / swallowed register).
hub/src\index.ts-814-    // claimOnceTask keeps it exactly-once. No-op when REMO_ONCE_SWEEP_DISABLED.
hub/src\index.ts-815-    startOnceDueSweep()
hub/src\index.ts:816:    // PTYCAP-07-06 — boot-time sweep: terminalizes heal autospawn launches stranded by a
hub/src\index.ts-817-    // restart (the spawn-deadline timer is process-local) so the 6h reaper is never their
hub/src\index.ts-818-    // backstop. Event-driven (once at boot plus one follow-up at the deadline, no interval); flag-OFF boot loads nothing of it.
hub/src\index.ts-819-    if (healUnifiedEnabled()) {
hub/src\index.ts:820:      void import('./heal/sweep.ts')
hub/src\index.ts-821-        .then((m) => m.bootSweepHealLaunches())
hub/src\index.ts:822:        .catch((err) => console.error('[startup] heal boot sweep failed:', err?.message ?? err))
hub/src\index.ts-823-    }
hub/src\index.ts-824-    console.log('[startup] reset sessions/messages/runs; scheduler ready')
hub/src\index.ts-825-  })
hub/src\index.ts-826-  .catch((err) => {
hub/src\index.ts-827-    console.error('[startup] migration/init error:', err.message)
hub/src\index.ts-828-  })
hub/src\index.ts-829-
hub/src\index.ts-830-// Graceful shutdown — pause cron jobs and clear pending post-run timers.
--
hub/src\db\heal-events-dal.ts-53-   * has repoRateBound: true (the router then terminalizes and notifies as it always has).
hub/src\db\heal-events-dal.ts-54-   */
hub/src\db\heal-events-dal.ts-55-  maxPerRepoHour?: number
hub/src\db\heal-events-dal.ts-56-  /**
hub/src\db\heal-events-dal.ts-57-   * Per-task daily ceiling for `task:<taskId>:<sig>` dedupe keys. Omit to skip it. At the ceiling
hub/src\db\heal-events-dal.ts-58-   * the claim is refused task_day_cap (no row).
hub/src\db\heal-events-dal.ts-59-   */
hub/src\db\heal-events-dal.ts-60-  maxPerTaskDay?: number
hub/src\db\heal-events-dal.ts:61:  /** Minimal validated source context a boot/follow-up sweep needs to terminalize the event. */
hub/src\db\heal-events-dal.ts-62-  recoveryCtx?: Record<string, unknown> | null
hub/src\db\heal-events-dal.ts-63-  /**
hub/src\db\heal-events-dal.ts-64-   * Pending default owner-email obligation (scheduled_task only), persisted in the SAME transaction
hub/src\db\heal-events-dal.ts-65-   * as the claim so a crash after the claim can never lose it. Delivered once via the lease CAS below.
hub/src\db\heal-events-dal.ts-66-   */
hub/src\db\heal-events-dal.ts-67-  ownerEmail?: OwnerEmailPayload | null
hub/src\db\heal-events-dal.ts-68-  /** Injectable clock (tests); defaults to Date.now(). */
hub/src\db\heal-events-dal.ts-69-  nowMs?: number
--
hub/src\heal\route.ts-222-    prompt: withScopeContract(asciiPunctuation(event.prompt)),
hub/src\heal\route.ts-223-    images: event.images,
hub/src\heal\route.ts-224-    counterKey: buildHealKey(event.user_id, target.repoIdent),
hub/src\heal\route.ts-225-  };
hub/src\heal\route.ts-226-}
hub/src\heal\route.ts-227-
hub/src\heal\route.ts-228-/**
hub/src\heal\route.ts-229- * Stamp the lifetime reservation for a heal event released. The only exported place that names
hub/src\heal\route.ts:230: * the lifetime key, so the boot sweep can free a reservation stranded by a restart.
hub/src\heal\route.ts-231- */
hub/src\heal\route.ts-232-export async function releaseHealReservation(
hub/src\heal\route.ts-233-  userId: string,
hub/src\heal\route.ts-234-  repoIdent: string,
hub/src\heal\route.ts-235-  eventId: string,
hub/src\heal\route.ts-236-  autospawn: Pick<AutospawnDeps, 'release'> = REAL_AUTOSPAWN,
hub/src\heal\route.ts-237-): Promise<void> {
hub/src\heal\route.ts-238-  await autospawn.release({ counterKey: buildHealKey(userId, repoIdent), token: `heal:${eventId}` });
--
hub/src\heal\route.ts-251-      return { kind: 'failed', reason: 'reconnect_not_online' };
hub/src\heal\route.ts-252-  }
hub/src\heal\route.ts-253-}
hub/src\heal\route.ts-254-
hub/src\heal\route.ts-255-/**
hub/src\heal\route.ts-256- * SH-04: heal an OFFLINE candidate through the shared governed adapter. Gates, the atomic lifetime
hub/src\heal\route.ts-257- * reservation and the ledger row all run BEFORE the spawn. After a launch the request is parked
hub/src\heal\route.ts-258- * through the single dispatch pipeline; ONE deadline timer bounds the wait, and the reservation is
hub/src\heal\route.ts:259: * released on every failure path. Process-local state only: the boot sweep covers a restart.
hub/src\heal\route.ts-260- */
hub/src\heal\route.ts-261-async function autospawnHeal(
hub/src\heal\route.ts-262-  deps: HealDeps,
hub/src\heal\route.ts-263-  event: HealEvent,
hub/src\heal\route.ts-264-  target: { sessionId: string; repoIdent: string },
hub/src\heal\route.ts-265-  eventId: string,
hub/src\heal\route.ts-266-  sink: HealSink,
hub/src\heal\route.ts-267-): Promise<HealOutcome> {
hub/src\heal\route.ts-268-  const a = deps.autospawn ?? REAL_AUTOSPAWN;
hub/src\heal\route.ts-269-  const req = buildRequest(event, target, eventId);
hub/src\heal\route.ts-270-  const extra = { sessionId: target.sessionId, repoIdent: target.repoIdent };
hub/src\heal\route.ts:271:  // The release is STRICT (QC r2): a failed release must leave the event in a state the boot sweep
hub/src\heal\route.ts-272-  // retries (autospawn_starting / launched / parked), never a terminal outcome that hides the slot.
hub/src\heal\route.ts-273-  let releaseFailed = false;
hub/src\heal\route.ts-274-  const release = async (): Promise<boolean> => {
hub/src\heal\route.ts-275-    try {
hub/src\heal\route.ts-276-      await releaseHealReservation(event.user_id, target.repoIdent, eventId, a);
hub/src\heal\route.ts-277-      return true;
hub/src\heal\route.ts-278-    } catch (err) {
hub/src\heal\route.ts-279-      releaseFailed = true;
hub/src\heal\route.ts-280-      log(`reservation release failed id=${eventId} (left for the sweep): ${errMsg(err)}`);
hub/src\heal\route.ts-281-      return false;
hub/src\heal\route.ts-282-    }
hub/src\heal\route.ts-283-  };
hub/src\heal\route.ts-284-  /** Release could not be confirmed: keep the recoverable outcome; the sweep terminalizes + notifies. */
hub/src\heal\route.ts-285-  const deferToSweep = (why: string): HealOutcome => {
hub/src\heal\route.ts:286:    log(`heal event ${eventId} left for the sweep: ${why}`);
hub/src\heal\route.ts-287-    return { kind: 'failed', reason: 'heal_release_pending' };
hub/src\heal\route.ts-288-  };
hub/src\heal\route.ts-289-  // The scheduler default email is the owner notification for a scheduled-task event once the launch
hub/src\heal\route.ts-290-  // outcome has been returned, so every ASYNC finalizer (deadline, replay) must not send a second.
hub/src\heal\route.ts-291-  const asyncNotify = event.source !== 'scheduled_task';
hub/src\heal\route.ts-292-
hub/src\heal\route.ts-293-  let settled = false;
hub/src\heal\route.ts-294-  let timer: unknown = null;
--
hub/src\heal\route.ts-406-      kind = 'autospawn_parked';
hub/src\heal\route.ts-407-      break;
hub/src\heal\route.ts-408-    case 'launched':
hub/src\heal\route.ts-409-      kind = 'autospawn_launched';
hub/src\heal\route.ts-410-      break;
hub/src\heal\route.ts-411-  }
hub/src\heal\route.ts-412-
hub/src\heal\route.ts-413-  // Launched (or already in flight): the ledger outcome first so a crash is recoverable by the
hub/src\heal\route.ts:414:  // boot sweep, then ONE deadline timer, then park through the single pipeline.
hub/src\heal\route.ts-415-  await persist(deps, eventId, { kind }, extra);
hub/src\heal\route.ts-416-  if (event.source === 'scheduled_task') {
hub/src\heal\route.ts-417-    // The scheduler's default failure email goes out NOW (the heal returns un-claimed). Take the
hub/src\heal\route.ts-418-    // notification claim on its behalf, with no send, so a later spawn_timeout / grace_expired /
hub/src\heal\route.ts:419:    // boot-sweep notice for this same event loses the claim: one owner notification per event.
hub/src\heal\route.ts-420-    // Determinism if this claim cannot be persisted (QC r2): the default email is STILL the sole
hub/src\heal\route.ts-421-    // owner, because every later heal finalizer for a scheduled_task event (deadline, replay, the
hub/src\heal\route.ts:422:    // boot sweep) is claim-only and never sends. A failed claim here cannot produce a second email.
hub/src\heal\route.ts-423-    try {
hub/src\heal\route.ts-424-      await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
hub/src\heal\route.ts-425-    } catch (err) {
hub/src\heal\route.ts-426-      log(`scheduler notification slot claim failed id=${eventId}: ${errMsg(err)}`);
hub/src\heal\route.ts-427-    }
hub/src\heal\route.ts-428-  }
hub/src\heal\route.ts-429-  timer = a.setTimer(() => void expire('spawn_timeout', 'heal_spawn_timeout'), healSpawnTimeoutMs());
hub/src\heal\route.ts-430-  let result: DispatchOutcome;
--
hub/src\heal\sweep.ts:1:// hub/src/heal/sweep.ts
hub/src\heal\sweep.ts-2-//
hub/src\heal\sweep.ts-3-// PTYCAP-07-06 (SC4, T-07-21, T-07-24): sweep for heal launches stranded by a hub restart. The
hub/src\heal\sweep.ts-4-// spawn deadline timer in route.ts is process-local, so a restart inside the spawn window would
hub/src\heal\sweep.ts-5-// leave the event's metadata run pending until the 6h reaper. Event driven, no interval timer: one
hub/src\heal\sweep.ts-6-// sweep at boot plus ONE follow-up at the spawn deadline (QC r1: a row stranded by a quick restart
hub/src\heal\sweep.ts-7-// is younger than the staleness guard at boot, and would otherwise wait for the next boot). Every
hub/src\heal\sweep.ts-8-// row stranded at or before boot is older than the guard by the follow-up, so no heal run can stay
hub/src\heal\sweep.ts-9-// pending past deadline + the follow-up margin. Flag-gated by the caller AND re-checked here,
--
hub/src\heal\sweep.ts-29-export interface SweepDeps {
hub/src\heal\sweep.ts-30-  list(olderThanMs: number): Promise<HealEventRow[]>;
hub/src\heal\sweep.ts-31-  reread(id: string): Promise<{ outcome: string | null } | null>;
hub/src\heal\sweep.ts-32-  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
hub/src\heal\sweep.ts-33-  makeSink: SinkFactory;
hub/src\heal\sweep.ts-34-  release(userId: string, repoIdent: string, eventId: string): Promise<void>;
hub/src\heal\sweep.ts-35-  notify?: NotifyDeps;
hub/src\heal\sweep.ts-36-  /** Owner-email outbox collaborators (defaults to the real DAL + email sender). */
hub/src\heal\sweep.ts:37:  ownerEmails?: OwnerEmailDeps;
hub/src\heal\sweep.ts-38-  /** One-shot timer for the follow-up sweep (unref'd in the real binding). */
hub/src\heal\sweep.ts-39-  setTimer?(fn: () => void, ms: number): unknown;
hub/src\heal\sweep.ts-40-}
hub/src\heal\sweep.ts-41-
hub/src\heal\sweep.ts-42-/** Real collaborators: lazy imports, so a flag-OFF boot loads nothing of this. */
hub/src\heal\sweep.ts-43-export const REAL_SWEEP_DEPS: SweepDeps = {
hub/src\heal\sweep.ts:44:  ownerEmails: REAL_OWNER_EMAIL_DEPS,
hub/src\heal\sweep.ts-45-  list: async (olderThanMs) => (await import('../db/heal-events-dal.ts')).listStaleLaunchingHealEvents(olderThanMs),
hub/src\heal\sweep.ts-46-  reread: async (id) => (await import('../db/heal-events-dal.ts')).getHealEvent(id),
hub/src\heal\sweep.ts-47-  setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
hub/src\heal\sweep.ts-48-  makeSink: async (event, ctx) => {
hub/src\heal\sweep.ts-49-    const spec = './sinks/index.ts';
hub/src\heal\sweep.ts-50-    const mod = await import(spec);
hub/src\heal\sweep.ts-51-    return (mod.makeHealSink as SinkFactory)(event, ctx);
hub/src\heal\sweep.ts-52-  },
hub/src\heal\sweep.ts-53-  release: async (userId, repoIdent, eventId) =>
hub/src\heal\sweep.ts-54-    (await import('./route.ts')).releaseHealReservation(userId, repoIdent, eventId),
hub/src\heal\sweep.ts-55-};
hub/src\heal\sweep.ts-56-
hub/src\heal\sweep.ts-57-function log(msg: string): void {
hub/src\heal\sweep.ts:58:  console.error(`[heal.sweep] ${msg}`);
hub/src\heal\sweep.ts-59-}
hub/src\heal\sweep.ts-60-
hub/src\heal\sweep.ts-61-/**
hub/src\heal\sweep.ts-62- * The ledger row carries identity, run ids, the bound session id and (for error_capture) the
hub/src\heal\sweep.ts-63- * minimal recovery_ctx; that is all a sink needs to terminalize.
hub/src\heal\sweep.ts-64- */
hub/src\heal\sweep.ts-65-function eventFromRow(row: HealEventRow): HealEvent {
hub/src\heal\sweep.ts-66-  return {
--
hub/src\heal\sweep.ts-139-        await notifyOnce(row.id, event, 'spawn_timeout', deps.notify ?? REAL_NOTIFY_DEPS);
hub/src\heal\sweep.ts-140-      }
hub/src\heal\sweep.ts-141-      result.swept++;
hub/src\heal\sweep.ts-142-    } catch (err: any) {
hub/src\heal\sweep.ts-143-      result.failed++;
hub/src\heal\sweep.ts-144-      log(`row ${row.id} failed (left for the next boot): ${err?.message ?? err}`);
hub/src\heal\sweep.ts-145-    }
hub/src\heal\sweep.ts-146-  }
hub/src\heal\sweep.ts:147:  if (result.swept || result.failed) log(`boot sweep: ${JSON.stringify(result)}`);
hub/src\heal\sweep.ts-148-  return result;
hub/src\heal\sweep.ts-149-}
hub/src\heal\sweep.ts-150-
hub/src\heal\sweep.ts-151-/**
hub/src\heal\sweep.ts-152- * Stranded launches first (a terminalized scheduled_task event's obligation is then due), then the
hub/src\heal\sweep.ts-153- * owner-email outbox: every default failure email a crash left undelivered is sent exactly once
hub/src\heal\sweep.ts-154- * (lease CAS). Flag OFF: nothing is read or touched.
hub/src\heal\sweep.ts-155- */
hub/src\heal\sweep.ts:156:export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
hub/src\heal\sweep.ts-157-  if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
hub/src\heal\sweep.ts-158-  const result = await sweepStrandedLaunches(deps);
hub/src\heal\sweep.ts:159:  if (!deps.ownerEmails) return result; // injected-deps callers opt in explicitly
hub/src\heal\sweep.ts-160-  try {
hub/src\heal\sweep.ts:161:    const sent = await sweepOwnerEmails(2 * healSpawnTimeoutMs(), deps.ownerEmails);
hub/src\heal\sweep.ts-162-    if (sent) log(`owner email outbox: ${sent} redelivered`);
hub/src\heal\sweep.ts-163-  } catch (err: any) {
hub/src\heal\sweep.ts-164-    log(`owner email outbox sweep failed: ${err?.message ?? err}`);
hub/src\heal\sweep.ts-165-  }
hub/src\heal\sweep.ts-166-  return result;
hub/src\heal\sweep.ts-167-}
hub/src\heal\sweep.ts-168-
hub/src\heal\sweep.ts-169-/**
hub/src\heal\sweep.ts-170- * Boot entry: sweep now, then ONE follow-up at the spawn deadline plus the staleness guard so a row
hub/src\heal\sweep.ts-171- * stranded by a quick restart (younger than the guard at boot) is swept as soon as it ages in.
hub/src\heal\sweep.ts-172- * True no-op when the heal flag is OFF (nothing read, no timer armed).
hub/src\heal\sweep.ts-173- */
hub/src\heal\sweep.ts-174-export async function bootSweepHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
hub/src\heal\sweep.ts-175-  if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
hub/src\heal\sweep.ts:176:  const first = await sweepStaleHealLaunches(deps);
hub/src\heal\sweep.ts-177-  const arm = deps.setTimer ?? defaultSetTimer;
hub/src\heal\sweep.ts-178-  arm(() => {
hub/src\heal\sweep.ts:179:    void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));
hub/src\heal\sweep.ts-180-  }, followUpDelayMs());
hub/src\heal\sweep.ts-181-  return first;
hub/src\heal\sweep.ts-182-}
hub/src\heal\sweep.ts-183-
hub/src\heal\sweep.ts-184-/** Strictly past the staleness guard (2x spawn timeout) so every boot-stranded row qualifies. */
hub/src\heal\sweep.ts-185-export function followUpDelayMs(): number {
hub/src\heal\sweep.ts-186-  return 2 * healSpawnTimeoutMs() + FOLLOW_UP_MARGIN_MS;
hub/src\heal\sweep.ts-187-}
--
hub/src\scheduler\once-due-sweep.ts-1-/**
hub/src\scheduler\once-due-sweep.ts-2- * Once-due sweep (milestone once) — the DURABLE, tick-based source of truth for
hub/src\scheduler\once-due-sweep.ts:3: * immediate/one-time tasks. Mirrors the shape of the other boot-started sweeps
hub/src\scheduler\once-due-sweep.ts-4- * (run-reaper / work-reaper): a periodic `setInterval` that queries DUE
hub/src\scheduler\once-due-sweep.ts-5- * `schedule_kind='once'` rows (`run_at <= now AND enabled = true`) and fires each
hub/src\scheduler\once-due-sweep.ts-6- * via `dispatcher.fire`.
hub/src\scheduler\once-due-sweep.ts-7- *
hub/src\scheduler\once-due-sweep.ts-8- * WHY THIS EXISTS (ai-review finding #2 — silent accept-never-dispatch):
hub/src\scheduler\once-due-sweep.ts-9- * The registry arms an immediate once task with `setTimeout(0)` for low latency,
hub/src\scheduler\once-due-sweep.ts-10- * but a timer is NOT durable — if the process dies between create and the
hub/src\scheduler\once-due-sweep.ts-11- * callback, or the fire throws before `claimOnceTask`, or a route swallows a
--
hub/test\heal-owner-email-outbox.test.ts-1-/**
hub/test\heal-owner-email-outbox.test.ts-2- * PTYCAP-07 repair round (QC round3-codex MAJOR #1): the default owner email for a scheduled-task
hub/test\heal-owner-email-outbox.test.ts-3- * heal event is a durable obligation persisted WITH the heal claim. Crash between the claim and the
hub/test\heal-owner-email-outbox.test.ts:4: * scheduler send -> the heal sweep sends exactly one; the normal path sends exactly one.
hub/test\heal-owner-email-outbox.test.ts-5- * DB-free: an in-memory outbox mirrors the lease-CAS semantics of the DAL (SQL pinned separately).
hub/test\heal-owner-email-outbox.test.ts-6- */
hub/test\heal-owner-email-outbox.test.ts-7-process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
hub/test\heal-owner-email-outbox.test.ts-8-
hub/test\heal-owner-email-outbox.test.ts-9-import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
hub/test\heal-owner-email-outbox.test.ts-10-import { routeHeal, type HealDeps } from '../src/heal/route.ts'
hub/test\heal-owner-email-outbox.test.ts-11-import { healFailedScheduledRun, type ScheduledSourceDeps } from '../src/heal/sources/scheduled-task.ts'
hub/test\heal-owner-email-outbox.test.ts-12-import { deliverOwnerEmailForRun, sweepOwnerEmails, type OwnerEmailDeps } from '../src/heal/owner-email.ts'
hub/test\heal-owner-email-outbox.test.ts:13:import { sweepStaleHealLaunches, type SweepDeps } from '../src/heal/sweep.ts'
hub/test\heal-owner-email-outbox.test.ts-14-import { claimHealEvent, claimOwnerEmailDelivery, listPendingOwnerEmails } from '../src/db/heal-events-dal.ts'
hub/test\heal-owner-email-outbox.test.ts-15-
hub/test\heal-owner-email-outbox.test.ts-16-const savedFlag = process.env.REMO_HEAL_UNIFIED
hub/test\heal-owner-email-outbox.test.ts-17-beforeEach(() => {
hub/test\heal-owner-email-outbox.test.ts-18-  process.env.REMO_HEAL_UNIFIED = '1'
hub/test\heal-owner-email-outbox.test.ts-19-})
hub/test\heal-owner-email-outbox.test.ts-20-afterAll(() => {
hub/test\heal-owner-email-outbox.test.ts-21-  if (savedFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
--
hub/test\heal-owner-email-outbox.test.ts-138-    const w = world()
hub/test\heal-owner-email-outbox.test.ts-139-    await fail(w, 'run1')
hub/test\heal-owner-email-outbox.test.ts-140-    const deps: SweepDeps = {
hub/test\heal-owner-email-outbox.test.ts-141-      list: async () => [],
hub/test\heal-owner-email-outbox.test.ts-142-      reread: async () => null,
hub/test\heal-owner-email-outbox.test.ts-143-      setOutcome: async () => {},
hub/test\heal-owner-email-outbox.test.ts-144-      makeSink: (() => ({})) as any,
hub/test\heal-owner-email-outbox.test.ts-145-      release: async () => {},
hub/test\heal-owner-email-outbox.test.ts:146:      ownerEmails: w.outbox,
hub/test\heal-owner-email-outbox.test.ts-147-    }
hub/test\heal-owner-email-outbox.test.ts-148-    w.advance(10 * 60_000)
hub/test\heal-owner-email-outbox.test.ts:149:    await sweepStaleHealLaunches(deps)
hub/test\heal-owner-email-outbox.test.ts-150-    expect(w.sends).toHaveLength(1)
hub/test\heal-owner-email-outbox.test.ts-151-  })
hub/test\heal-owner-email-outbox.test.ts-152-
hub/test\heal-owner-email-outbox.test.ts-153-  test('a send that failed is retried by the sweep (still exactly one delivered)', async () => {
hub/test\heal-owner-email-outbox.test.ts-154-    const w = world()
hub/test\heal-owner-email-outbox.test.ts-155-    await fail(w, 'run1')
hub/test\heal-owner-email-outbox.test.ts-156-    w.setSendOk(false)
hub/test\heal-owner-email-outbox.test.ts-157-    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true)
--
hub/test\heal-sweep.test.ts-1-/**
hub/test\heal-sweep.test.ts:2: * PTYCAP-07-06 Task 3 -- boot sweep for heal launches stranded by a hub restart (SC4, T-07-21,
hub/test\heal-sweep.test.ts-3- * T-07-24). DB-free: every collaborator is injected.
hub/test\heal-sweep.test.ts-4- */
hub/test\heal-sweep.test.ts-5-import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
hub/test\heal-sweep.test.ts-6-import { readFileSync } from 'node:fs'
hub/test\heal-sweep.test.ts-7-import { join } from 'node:path'
hub/test\heal-sweep.test.ts-8-import {
hub/test\heal-sweep.test.ts:9:  sweepStaleHealLaunches,
hub/test\heal-sweep.test.ts-10-  bootSweepHealLaunches,
hub/test\heal-sweep.test.ts-11-  followUpDelayMs,
hub/test\heal-sweep.test.ts-12-  SWEEP_BATCH,
hub/test\heal-sweep.test.ts-13-  type SweepDeps,
hub/test\heal-sweep.test.ts:14:} from '../src/heal/sweep.ts'
hub/test\heal-sweep.test.ts-15-import { OUTCOME_AUTOSPAWN_STARTING } from '../src/heal/types.ts'
hub/test\heal-sweep.test.ts-16-import type { HealEventRow } from '../src/db/heal-events-dal.ts'
hub/test\heal-sweep.test.ts-17-import type { HealTerminalOutcome } from '../src/heal/sinks/types.ts'
hub/test\heal-sweep.test.ts-18-
hub/test\heal-sweep.test.ts-19-const savedFlag = process.env.REMO_HEAL_UNIFIED
hub/test\heal-sweep.test.ts-20-const savedTimeout = process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
hub/test\heal-sweep.test.ts-21-beforeEach(() => {
hub/test\heal-sweep.test.ts-22-  process.env.REMO_HEAL_UNIFIED = '1'
--
hub/test\heal-sweep.test.ts-91-        return true
hub/test\heal-sweep.test.ts-92-      },
hub/test\heal-sweep.test.ts-93-    },
hub/test\heal-sweep.test.ts-94-    ...over,
hub/test\heal-sweep.test.ts-95-  }
hub/test\heal-sweep.test.ts-96-  return { deps, rec }
hub/test\heal-sweep.test.ts-97-}
hub/test\heal-sweep.test.ts-98-
hub/test\heal-sweep.test.ts:99:describe('sweepStaleHealLaunches', () => {
hub/test\heal-sweep.test.ts-100-  test('terminalizes each stranded launch, releases its reservation, writes the ledger outcome and notifies once', async () => {
hub/test\heal-sweep.test.ts-101-    const { deps, rec } = mk([row('a'), row('b')])
hub/test\heal-sweep.test.ts:102:    const res = await sweepStaleHealLaunches(deps)
hub/test\heal-sweep.test.ts-103-    expect(res).toEqual({ swept: 2, skipped: 0, failed: 0 })
hub/test\heal-sweep.test.ts-104-    expect(rec.terminal).toEqual([
hub/test\heal-sweep.test.ts-105-      ['a', { kind: 'failed', reason: 'heal_spawn_timeout' }],
hub/test\heal-sweep.test.ts-106-      ['b', { kind: 'failed', reason: 'heal_spawn_timeout' }],
hub/test\heal-sweep.test.ts-107-    ])
hub/test\heal-sweep.test.ts-108-    expect(rec.released).toEqual([
hub/test\heal-sweep.test.ts-109-      ['u1', 'github://acme/web', 'a'],
hub/test\heal-sweep.test.ts-110-      ['u1', 'github://acme/web', 'b'],
--
hub/test\heal-sweep.test.ts-113-      ['a', 'failed:spawn_timeout'],
hub/test\heal-sweep.test.ts-114-      ['b', 'failed:spawn_timeout'],
hub/test\heal-sweep.test.ts-115-    ])
hub/test\heal-sweep.test.ts-116-    expect(rec.sends.length).toBe(2)
hub/test\heal-sweep.test.ts-117-  })
hub/test\heal-sweep.test.ts-118-
hub/test\heal-sweep.test.ts-119-  test('selects rows older than twice the spawn timeout', async () => {
hub/test\heal-sweep.test.ts-120-    const { deps, rec } = mk([])
hub/test\heal-sweep.test.ts:121:    await sweepStaleHealLaunches(deps)
hub/test\heal-sweep.test.ts-122-    expect(rec.listArgs).toEqual([50_000])
hub/test\heal-sweep.test.ts-123-    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '1000'
hub/test\heal-sweep.test.ts:124:    await sweepStaleHealLaunches(deps)
hub/test\heal-sweep.test.ts-125-    expect(rec.listArgs[1]).toBe(2000)
hub/test\heal-sweep.test.ts-126-  })
hub/test\heal-sweep.test.ts-127-
hub/test\heal-sweep.test.ts-128-  test('a row whose outcome already changed is skipped untouched', async () => {
hub/test\heal-sweep.test.ts-129-    const { deps, rec } = mk([row('a'), row('b')], {
hub/test\heal-sweep.test.ts-130-      reread: async (id) => ({ outcome: id === 'a' ? 'dispatched_after_spawn' : 'autospawn_launched' }),
hub/test\heal-sweep.test.ts-131-    })
hub/test\heal-sweep.test.ts:132:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 1, failed: 0 })
hub/test\heal-sweep.test.ts-133-    expect(rec.terminal.map((t) => t[0])).toEqual(['b'])
hub/test\heal-sweep.test.ts-134-    expect(rec.released.length).toBe(1)
hub/test\heal-sweep.test.ts-135-  })
hub/test\heal-sweep.test.ts-136-
hub/test\heal-sweep.test.ts-137-  test('QC r2: a source-terminalization failure still releases the slot but does NOT close the row (retryable); other rows continue', async () => {
hub/test\heal-sweep.test.ts-138-    const { deps, rec } = mk([row('a'), row('b'), row('c')])
hub/test\heal-sweep.test.ts-139-    const base = deps.makeSink
hub/test\heal-sweep.test.ts-140-    deps.makeSink = (e, ctx) => {
hub/test\heal-sweep.test.ts-141-      if (ctx.eventId === 'b') throw new Error('sink exploded')
hub/test\heal-sweep.test.ts-142-      return base(e, ctx)
hub/test\heal-sweep.test.ts-143-    }
hub/test\heal-sweep.test.ts:144:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 2, skipped: 0, failed: 1 })
hub/test\heal-sweep.test.ts-145-    expect(rec.terminal.map((t) => t[0])).toEqual(['a', 'c'])
hub/test\heal-sweep.test.ts-146-    expect(rec.released.map((r) => r[2])).toEqual(['a', 'b', 'c']) // b's slot is freed regardless
hub/test\heal-sweep.test.ts-147-    // b is never written terminal and gets no notification; its recoverable outcome is re-stamped
hub/test\heal-sweep.test.ts-148-    expect(rec.outcomes).toEqual([
hub/test\heal-sweep.test.ts-149-      ['a', 'failed:spawn_timeout'],
hub/test\heal-sweep.test.ts-150-      ['b', 'autospawn_launched'],
hub/test\heal-sweep.test.ts-151-      ['c', 'failed:spawn_timeout'],
hub/test\heal-sweep.test.ts-152-    ])
--
hub/test\heal-sweep.test.ts-154-  })
hub/test\heal-sweep.test.ts-155-
hub/test\heal-sweep.test.ts-156-  test('QC r2: a release failure terminalizes the source but does NOT close the row (the slot is still held), no notification', async () => {
hub/test\heal-sweep.test.ts-157-    const { deps, rec } = mk([row('a'), row('b')], {
hub/test\heal-sweep.test.ts-158-      release: async (_u, _r, e) => {
hub/test\heal-sweep.test.ts-159-        if (e === 'a') throw new Error('db down')
hub/test\heal-sweep.test.ts-160-      },
hub/test\heal-sweep.test.ts-161-    })
hub/test\heal-sweep.test.ts:162:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 0, failed: 1 })
hub/test\heal-sweep.test.ts-163-    expect(rec.terminal.map((t) => t[0])).toEqual(['a', 'b']) // source obligation is independent
hub/test\heal-sweep.test.ts-164-    expect(rec.outcomes).toEqual([
hub/test\heal-sweep.test.ts-165-      ['a', 'autospawn_launched'], // recoverable outcome kept, never failed:spawn_timeout
hub/test\heal-sweep.test.ts-166-      ['b', 'failed:spawn_timeout'],
hub/test\heal-sweep.test.ts-167-    ])
hub/test\heal-sweep.test.ts-168-    expect(rec.sends.length).toBe(1) // only b notified
hub/test\heal-sweep.test.ts-169-  })
hub/test\heal-sweep.test.ts-170-
hub/test\heal-sweep.test.ts-171-  test('QC r2: a retry after the failure closes the row once both obligations are confirmed', async () => {
hub/test\heal-sweep.test.ts-172-    let failRelease = true
hub/test\heal-sweep.test.ts-173-    const { deps, rec } = mk([row('a')], {
hub/test\heal-sweep.test.ts-174-      release: async () => {
hub/test\heal-sweep.test.ts-175-        if (failRelease) throw new Error('db down')
hub/test\heal-sweep.test.ts-176-      },
hub/test\heal-sweep.test.ts-177-    })
hub/test\heal-sweep.test.ts:178:    expect((await sweepStaleHealLaunches(deps)).failed).toBe(1)
hub/test\heal-sweep.test.ts-179-    failRelease = false
hub/test\heal-sweep.test.ts:180:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 0, failed: 0 })
hub/test\heal-sweep.test.ts-181-    expect(rec.outcomes.at(-1)).toEqual(['a', 'failed:spawn_timeout'])
hub/test\heal-sweep.test.ts-182-    expect(rec.sends.length).toBe(1)
hub/test\heal-sweep.test.ts-183-  })
hub/test\heal-sweep.test.ts-184-
hub/test\heal-sweep.test.ts-185-  test('QC r2: a scheduled_task row is closed with the claim only - the scheduler default email already owned the notification', async () => {
hub/test\heal-sweep.test.ts-186-    const claims: string[] = []
hub/test\heal-sweep.test.ts-187-    const { deps, rec } = mk([row('s', { source: 'scheduled_task' })], {
hub/test\heal-sweep.test.ts-188-      notify: { claim: async (id) => (claims.push(id), true), resolveOwnerEmail: async () => 'o@x.com', send: async (m) => (rec.sends.push(m), true) },
hub/test\heal-sweep.test.ts-189-    })
hub/test\heal-sweep.test.ts:190:    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
hub/test\heal-sweep.test.ts-191-    expect(rec.outcomes).toEqual([['s', 'failed:spawn_timeout']])
hub/test\heal-sweep.test.ts-192-    expect(claims).toEqual(['s'])
hub/test\heal-sweep.test.ts-193-    expect(rec.sends).toEqual([])
hub/test\heal-sweep.test.ts-194-  })
hub/test\heal-sweep.test.ts-195-
hub/test\heal-sweep.test.ts-196-  test('autospawn_starting rows (crash between claim and launched) are swept and their reservation released', async () => {
hub/test\heal-sweep.test.ts-197-    const { deps, rec } = mk([row('a', { outcome: OUTCOME_AUTOSPAWN_STARTING })])
hub/test\heal-sweep.test.ts:198:    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
hub/test\heal-sweep.test.ts-199-    expect(rec.released).toEqual([['u1', 'github://acme/web', 'a']])
hub/test\heal-sweep.test.ts-200-    expect(rec.outcomes).toEqual([['a', 'failed:spawn_timeout']])
hub/test\heal-sweep.test.ts-201-  })
hub/test\heal-sweep.test.ts-202-
hub/test\heal-sweep.test.ts-203-  test('error_capture rows are rebuilt with recovery_ctx and the bound session id, so the sink can be constructed', async () => {
hub/test\heal-sweep.test.ts-204-    const seen: any[] = []
hub/test\heal-sweep.test.ts-205-    const { deps, rec } = mk(
hub/test\heal-sweep.test.ts-206-      [
--
hub/test\heal-sweep.test.ts-226-            finalizeTerminal: async (o) => {
hub/test\heal-sweep.test.ts-227-              rec.terminal.push([ctx.eventId as string, o])
hub/test\heal-sweep.test.ts-228-            },
hub/test\heal-sweep.test.ts-229-            onParkExpire: async () => {},
hub/test\heal-sweep.test.ts-230-          }
hub/test\heal-sweep.test.ts-231-        },
hub/test\heal-sweep.test.ts-232-      },
hub/test\heal-sweep.test.ts-233-    )
hub/test\heal-sweep.test.ts:234:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 0, failed: 0 })
hub/test\heal-sweep.test.ts-235-    expect(seen[0].bound_session_id).toBe('s-bound')
hub/test\heal-sweep.test.ts-236-    expect(seen[0].ctx).toEqual({ error_id: 'err1', project_id: 'p1' })
hub/test\heal-sweep.test.ts-237-    expect(rec.terminal).toEqual([['e1', { kind: 'failed', reason: 'heal_spawn_timeout' }]])
hub/test\heal-sweep.test.ts-238-    expect(rec.released).toEqual([['u1', 'github://acme/web', 'e1']])
hub/test\heal-sweep.test.ts-239-  })
hub/test\heal-sweep.test.ts-240-
hub/test\heal-sweep.test.ts-241-  test('a thrown list query is swallowed', async () => {
hub/test\heal-sweep.test.ts-242-    const { deps } = mk([], {
hub/test\heal-sweep.test.ts-243-      list: async () => {
hub/test\heal-sweep.test.ts-244-        throw new Error('db down')
hub/test\heal-sweep.test.ts-245-      },
hub/test\heal-sweep.test.ts-246-    })
hub/test\heal-sweep.test.ts:247:    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 0, skipped: 0, failed: 0 })
hub/test\heal-sweep.test.ts-248-  })
hub/test\heal-sweep.test.ts-249-
hub/test\heal-sweep.test.ts-250-  test('a row with no repo ident is still terminalized, with no release', async () => {
hub/test\heal-sweep.test.ts-251-    const { deps, rec } = mk([row('a', { repo_ident: null })])
hub/test\heal-sweep.test.ts:252:    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
hub/test\heal-sweep.test.ts-253-    expect(rec.released.length).toBe(0)
hub/test\heal-sweep.test.ts-254-  })
hub/test\heal-sweep.test.ts-255-
hub/test\heal-sweep.test.ts-256-  test('parked rows are covered too', async () => {
hub/test\heal-sweep.test.ts-257-    const { deps } = mk([row('a', { outcome: 'autospawn_parked' })])
hub/test\heal-sweep.test.ts:258:    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
hub/test\heal-sweep.test.ts-259-  })
hub/test\heal-sweep.test.ts-260-
hub/test\heal-sweep.test.ts-261-  test('bounded at 50 rows per boot', async () => {
hub/test\heal-sweep.test.ts-262-    const many = Array.from({ length: 70 }, (_, i) => row(`r${i}`))
hub/test\heal-sweep.test.ts-263-    const { deps, rec } = mk(many)
hub/test\heal-sweep.test.ts-264-    expect(SWEEP_BATCH).toBe(50)
hub/test\heal-sweep.test.ts:265:    expect((await sweepStaleHealLaunches(deps)).swept).toBe(50)
hub/test\heal-sweep.test.ts-266-    expect(rec.terminal.length).toBe(50)
hub/test\heal-sweep.test.ts-267-  })
hub/test\heal-sweep.test.ts-268-})
hub/test\heal-sweep.test.ts-269-
hub/test\heal-sweep.test.ts-270-describe('follow-up sweep at the deadline (SC4: no heal run stays pending past deadline + margin)', () => {
hub/test\heal-sweep.test.ts-271-  /** A fake clock + a DAL-faithful list(): rows older than the guard, at the CURRENT fake time. */
hub/test\heal-sweep.test.ts-272-  function clockDb(rows: HealEventRow[], bootAt: number) {
hub/test\heal-sweep.test.ts-273-    let now = bootAt
--
hub/test\heal-sweep.test.ts-289-  }
hub/test\heal-sweep.test.ts-290-
hub/test\heal-sweep.test.ts-291-  test('a row stranded 20s before boot (younger than the 50s guard) is missed at boot and swept by the one follow-up', async () => {
hub/test\heal-sweep.test.ts-292-    const boot = 1_000_000
hub/test\heal-sweep.test.ts-293-    const stranded = row('quick', { updated_at: new Date(boot - 20_000) })
hub/test\heal-sweep.test.ts-294-    const { deps, timers, swept, advance } = clockDb([stranded], boot)
hub/test\heal-sweep.test.ts-295-
hub/test\heal-sweep.test.ts-296-    await bootSweepHealLaunches(deps)
hub/test\heal-sweep.test.ts:297:    expect(swept).toEqual([]) // boot sweep: row is only 20s old
hub/test\heal-sweep.test.ts-298-    expect(timers.length).toBe(1) // exactly ONE follow-up, not an interval
hub/test\heal-sweep.test.ts-299-
hub/test\heal-sweep.test.ts-300-    expect(timers[0]!.ms).toBe(followUpDelayMs())
hub/test\heal-sweep.test.ts-301-    expect(timers[0]!.ms).toBeGreaterThan(2 * 25_000) // strictly past the staleness guard
hub/test\heal-sweep.test.ts-302-    advance(timers[0]!.ms)
hub/test\heal-sweep.test.ts-303-    timers[0]!.fn()
hub/test\heal-sweep.test.ts-304-    await new Promise((r) => setTimeout(r, 10))
hub/test\heal-sweep.test.ts-305-    expect(swept).toEqual(['quick'])
--
hub/test\heal-sweep.test.ts-315-    process.env.REMO_HEAL_UNIFIED = '0'
hub/test\heal-sweep.test.ts-316-    const { deps, timers } = clockDb([row('a')], 0)
hub/test\heal-sweep.test.ts-317-    await bootSweepHealLaunches(deps)
hub/test\heal-sweep.test.ts-318-    expect(timers.length).toBe(0)
hub/test\heal-sweep.test.ts-319-  })
hub/test\heal-sweep.test.ts-320-})
hub/test\heal-sweep.test.ts-321-
hub/test\heal-sweep.test.ts-322-describe('flag OFF (behavioural)', () => {
hub/test\heal-sweep.test.ts:323:  test('with the heal flag OFF the sweep reads nothing and touches nothing', async () => {
hub/test\heal-sweep.test.ts-324-    for (const v of [undefined, '', '0', 'false', 'maybe']) {
hub/test\heal-sweep.test.ts-325-      if (v === undefined) delete process.env.REMO_HEAL_UNIFIED
hub/test\heal-sweep.test.ts-326-      else process.env.REMO_HEAL_UNIFIED = v
hub/test\heal-sweep.test.ts-327-      const { deps, rec } = mk([row('a')])
hub/test\heal-sweep.test.ts:328:      expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 0, skipped: 0, failed: 0 })
hub/test\heal-sweep.test.ts-329-      expect(rec.listCalls).toBe(0)
hub/test\heal-sweep.test.ts-330-      expect(rec.terminal.length).toBe(0)
hub/test\heal-sweep.test.ts-331-      expect(rec.released.length).toBe(0)
hub/test\heal-sweep.test.ts-332-    }
hub/test\heal-sweep.test.ts-333-  })
hub/test\heal-sweep.test.ts-334-})
hub/test\heal-sweep.test.ts-335-
hub/test\heal-sweep.test.ts-336-describe('boot wiring pin (source text)', () => {
--
hub/test\heal-sweep.test.ts-340-    const at = src.indexOf('bootSweepHealLaunches')
hub/test\heal-sweep.test.ts-341-    expect(at).toBeGreaterThan(-1)
hub/test\heal-sweep.test.ts-342-    const guard = src.lastIndexOf('if (healUnifiedEnabled())', at)
hub/test\heal-sweep.test.ts-343-    expect(guard).toBeGreaterThan(-1)
hub/test\heal-sweep.test.ts-344-    expect(at - guard).toBeLessThan(300)
hub/test\heal-sweep.test.ts-345-  })
hub/test\heal-sweep.test.ts-346-
hub/test\heal-sweep.test.ts-347-  test('the sweep module is imported lazily (never eagerly), and there is no interval timer for it', () => {
hub/test\heal-sweep.test.ts:348:    expect(/^import[^\n]*heal\/sweep/m.test(src)).toBe(false)
hub/test\heal-sweep.test.ts:349:    expect(src).toContain("import('./heal/sweep.ts')")
hub/test\heal-sweep.test.ts-350-    expect(/setInterval[^\n]*[Hh]eal/.test(src)).toBe(false)
hub/test\heal-sweep.test.ts-351-  })
hub/test\heal-sweep.test.ts-352-})

 succeeded in 928ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/db/heal-events-dal.ts-86-  id: string
hub/src/db/heal-events-dal.ts-87-  user_id: string
hub/src/db/heal-events-dal.ts-88-  source: string
hub/src/db/heal-events-dal.ts-89-  repo_ident: string | null
hub/src/db/heal-events-dal.ts-90-  dedupe_key: string
hub/src/db/heal-events-dal.ts-91-  window_bucket: string | number
hub/src/db/heal-events-dal.ts:92:  trigger_run_id: string | null
hub/src/db/heal-events-dal.ts-93-  dispatch_run_id: string | null
hub/src/db/heal-events-dal.ts-94-  metadata_run_id: string | null
hub/src/db/heal-events-dal.ts-95-  session_id: string | null
hub/src/db/heal-events-dal.ts-96-  outcome: string | null
hub/src/db/heal-events-dal.ts-97-  notification_claimed_at: string | Date | null
hub/src/db/heal-events-dal.ts-98-  recovery_ctx?: Record<string, unknown> | null
--
hub/src/db/heal-events-dal.ts-149-        hashtext(${'heal:' + args.userId + ':' + args.source + ':' + args.dedupeKey})::bigint
hub/src/db/heal-events-dal.ts-150-      )
hub/src/db/heal-events-dal.ts-151-    `
hub/src/db/heal-events-dal.ts-152-    if (args.triggerRunId) {
hub/src/db/heal-events-dal.ts-153-      const seen = await tx`
hub/src/db/heal-events-dal.ts-154-        SELECT 1 AS one FROM heal_events
hub/src/db/heal-events-dal.ts:155:        WHERE source = ${args.source} AND trigger_run_id = ${args.triggerRunId}
hub/src/db/heal-events-dal.ts-156-        LIMIT 1
hub/src/db/heal-events-dal.ts-157-      `
hub/src/db/heal-events-dal.ts-158-      if (seen.length > 0) return { ok: false, reason: 'duplicate' }
hub/src/db/heal-events-dal.ts-159-    }
hub/src/db/heal-events-dal.ts-160-    // (b) REAL elapsed window, not just the bucket.
hub/src/db/heal-events-dal.ts-161-    const inWindow = await tx`
--
hub/src/db/heal-events-dal.ts-198-      `
hub/src/db/heal-events-dal.ts-199-      if (Number(rc[0]?.n ?? 0) >= args.maxPerRepoHour) preOutcome = REPO_RATE_BOUND_OUTCOME
hub/src/db/heal-events-dal.ts-200-    }
hub/src/db/heal-events-dal.ts-201-
hub/src/db/heal-events-dal.ts-202-    // (d) INSERT; the unique indexes are the backstop - an empty return means duplicate.
hub/src/db/heal-events-dal.ts-203-    const inserted = await tx`
hub/src/db/heal-events-dal.ts:204:      INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, outcome, recovery_ctx, owner_email, created_at, updated_at)
hub/src/db/heal-events-dal.ts-205-      VALUES (${args.userId}, ${args.source}, ${args.repoIdent ?? null}, ${args.dedupeKey}, ${bucket},
hub/src/db/heal-events-dal.ts-206-              ${args.triggerRunId ?? null}, ${preOutcome}, ${args.recoveryCtx ? JSON.stringify(args.recoveryCtx) : null}::jsonb,
hub/src/db/heal-events-dal.ts-207-              ${args.ownerEmail ? JSON.stringify(args.ownerEmail) : null}::jsonb, ${createdAt}, ${createdAt})
hub/src/db/heal-events-dal.ts-208-      ON CONFLICT DO NOTHING
hub/src/db/heal-events-dal.ts-209-      RETURNING id
hub/src/db/heal-events-dal.ts-210-    `
--
hub/src/db/heal-events-dal.ts-266-      UNION ALL
hub/src/db/heal-events-dal.ts-267-      SELECT r.triggered_by_run_id, c.depth + 1
hub/src/db/heal-events-dal.ts-268-      FROM chain c JOIN scheduled_task_runs r ON r.id = c.id
hub/src/db/heal-events-dal.ts-269-      WHERE r.triggered_by_run_id IS NOT NULL AND c.depth < 5
hub/src/db/heal-events-dal.ts-270-    )
hub/src/db/heal-events-dal.ts-271-    SELECT 1 AS one FROM heal_events h
hub/src/db/heal-events-dal.ts:272:    WHERE h.trigger_run_id IN (SELECT id FROM chain)
hub/src/db/heal-events-dal.ts-273-       OR h.dispatch_run_id IN (SELECT id FROM chain)
hub/src/db/heal-events-dal.ts-274-       OR h.metadata_run_id IN (SELECT id FROM chain)
hub/src/db/heal-events-dal.ts-275-    LIMIT 1
hub/src/db/heal-events-dal.ts-276-  `
hub/src/db/heal-events-dal.ts-277-  return rows.length > 0
hub/src/db/heal-events-dal.ts-278-}
--
hub/src/db/heal-events-dal.ts-327-}
hub/src/db/heal-events-dal.ts-328-
hub/src/db/heal-events-dal.ts-329-/** True when this run's heal event carries an undelivered-or-delivered obligation (a row exists). */
hub/src/db/heal-events-dal.ts-330-export async function hasOwnerEmailObligation(runId: string, exec: HealExec = sql): Promise<boolean> {
hub/src/db/heal-events-dal.ts-331-  const rows = await exec`
hub/src/db/heal-events-dal.ts-332-    SELECT 1 AS one FROM heal_events
hub/src/db/heal-events-dal.ts:333:    WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} AND owner_email IS NOT NULL
hub/src/db/heal-events-dal.ts-334-    LIMIT 1
hub/src/db/heal-events-dal.ts-335-  `
hub/src/db/heal-events-dal.ts-336-  return rows.length > 0
hub/src/db/heal-events-dal.ts-337-}
hub/src/db/heal-events-dal.ts-338-
hub/src/db/heal-events-dal.ts-339-/** Lease CAS by event id. Yields the payload to the ONE caller allowed to send, else null. */
--
hub/src/db/heal-events-dal.ts-357-  runId: string,
hub/src/db/heal-events-dal.ts-358-  leaseMs: number = OWNER_EMAIL_LEASE_MS,
hub/src/db/heal-events-dal.ts-359-  exec: HealExec = sql,
hub/src/db/heal-events-dal.ts-360-  nowMs: number = Date.now(),
hub/src/db/heal-events-dal.ts-361-): Promise<OwnerEmailClaim | null> {
hub/src/db/heal-events-dal.ts-362-  const found = await exec`
hub/src/db/heal-events-dal.ts:363:    SELECT id FROM heal_events WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} LIMIT 1
hub/src/db/heal-events-dal.ts-364-  `
hub/src/db/heal-events-dal.ts-365-  if (found.length === 0) return null
hub/src/db/heal-events-dal.ts-366-  return claimOwnerEmailDelivery(found[0].id as string, leaseMs, exec, nowMs)
hub/src/db/heal-events-dal.ts-367-}
hub/src/db/heal-events-dal.ts-368-
hub/src/db/heal-events-dal.ts-369-/** Terminal flag. Idempotent. */
--
hub/src/db/schema.sql-1663-ALTER TABLE routine_run_log ADD COLUMN IF NOT EXISTS inject_token TEXT;
hub/src/db/schema.sql-1664-
hub/src/db/schema.sql-1665--- PTYCAP-07 self-heal event ledger. One row per heal claim; the atomic claim
hub/src/db/schema.sql-1666--- (tx advisory lock + real time-window check) lives in heal-events-dal.ts, the
hub/src/db/schema.sql-1667--- unique indexes below are only the backstop. No FK on the run id columns: runs
hub/src/db/schema.sql-1668--- are reaped independently and a heal row must outlive them. Additive DDL only.
hub/src/db/schema.sql:1669:CREATE TABLE IF NOT EXISTS heal_events (
hub/src/db/schema.sql-1670-  id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
hub/src/db/schema.sql-1671-  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
hub/src/db/schema.sql-1672-  source                  TEXT NOT NULL,
hub/src/db/schema.sql-1673-  repo_ident              TEXT,
hub/src/db/schema.sql-1674-  dedupe_key              TEXT NOT NULL,
hub/src/db/schema.sql-1675-  window_bucket           BIGINT NOT NULL,
hub/src/db/schema.sql:1676:  trigger_run_id          TEXT,
hub/src/db/schema.sql-1677-  dispatch_run_id         TEXT,
hub/src/db/schema.sql-1678-  metadata_run_id         TEXT,
hub/src/db/schema.sql-1679-  session_id              TEXT,
hub/src/db/schema.sql-1680-  outcome                 TEXT,
hub/src/db/schema.sql-1681-  notification_claimed_at TIMESTAMPTZ,
hub/src/db/schema.sql-1682-  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
hub/src/db/schema.sql-1683-  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
hub/src/db/schema.sql-1684-);
hub/src/db/schema.sql-1685--- PTYCAP-07 QC r1: minimal validated source context (e.g. error_id/project_id) so the stale-launch
hub/src/db/schema.sql-1686--- sweep can rebuild the per-event sink. Additive, nullable, never backfilled.
hub/src/db/schema.sql:1687:ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS recovery_ctx JSONB;
hub/src/db/schema.sql-1688--- PTYCAP-07 repair: durable default owner-email obligation (scheduled_task only), written in the
hub/src/db/schema.sql-1689--- claim transaction; delivered once via a lease CAS, terminal flag owner_email_delivered_at.
hub/src/db/schema.sql-1690--- Additive, nullable, never backfilled.
hub/src/db/schema.sql:1691:ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email JSONB;
hub/src/db/schema.sql:1692:ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email_claimed_at TIMESTAMPTZ;
hub/src/db/schema.sql:1693:ALTER TABLE heal_events ADD COLUMN IF NOT EXISTS owner_email_delivered_at TIMESTAMPTZ;
hub/src/db/schema.sql-1694-CREATE INDEX IF NOT EXISTS idx_heal_events_owner_email_pending
hub/src/db/schema.sql-1695-  ON heal_events(created_at) WHERE owner_email IS NOT NULL AND owner_email_delivered_at IS NULL;
hub/src/db/schema.sql-1696-CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_events_bucket
hub/src/db/schema.sql-1697-  ON heal_events(user_id, source, dedupe_key, window_bucket);
hub/src/db/schema.sql-1698--- A run can trigger at most one heal event, ever.
hub/src/db/schema.sql:1699:CREATE UNIQUE INDEX IF NOT EXISTS idx_heal_events_trigger
hub/src/db/schema.sql:1700:  ON heal_events(source, trigger_run_id) WHERE trigger_run_id IS NOT NULL;
hub/src/db/schema.sql-1701-CREATE INDEX IF NOT EXISTS idx_heal_events_user_key_created
hub/src/db/schema.sql-1702-  ON heal_events(user_id, dedupe_key, created_at DESC);
hub/src/db/schema.sql-1703-CREATE INDEX IF NOT EXISTS idx_heal_events_dispatch_run
hub/src/db/schema.sql-1704-  ON heal_events(dispatch_run_id);
hub/src/db/schema.sql-1705-CREATE INDEX IF NOT EXISTS idx_heal_events_metadata_run
hub/src/db/schema.sql-1706-  ON heal_events(metadata_run_id);

 succeeded in 945ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/db/heal-events-dal.ts-1-/**
hub/src/db/heal-events-dal.ts-2- * PTYCAP-07 heal-events DAL: the self-heal event ledger (heal_events).
hub/src/db/heal-events-dal.ts-3- *
hub/src/db/heal-events-dal.ts:4: * - claimHealEvent is ATOMIC: one transaction takes a tx-scoped advisory lock on
hub/src/db/heal-events-dal.ts-5- *   (user, source, dedupe_key), checks the REAL elapsed window (a bucket boundary
hub/src/db/heal-events-dal.ts-6- *   cannot split a storm - the flaw in claimDeployFailure's prev-bucket SELECT),
hub/src/db/heal-events-dal.ts-7- *   enforces the per-user hourly claim cap, then INSERTs. The unique indexes in
hub/src/db/heal-events-dal.ts-8- *   schema.sql are only the backstop. Any throw propagates: callers fail closed.
hub/src/db/heal-events-dal.ts-9- * - The per-repository hourly and per-task daily ceilings are enforced INSIDE the claim
hub/src/db/heal-events-dal.ts-10- *   transaction, after the per-user advisory lock: every claim of one user is serialized from
hub/src/db/heal-events-dal.ts-11- *   that lock to commit, so the count and the INSERT are atomic with respect to each other even
hub/src/db/heal-events-dal.ts-12- *   for distinct dedupe keys (QC r1: they were check-then-insert in the router/source).
--
hub/src/db/heal-events-dal.ts-33-
hub/src/db/heal-events-dal.ts-34-export function windowBucket(nowMs: number, windowMs: number): number {
hub/src/db/heal-events-dal.ts-35-  if (!Number.isFinite(windowMs) || windowMs <= 0) {
hub/src/db/heal-events-dal.ts-36-    throw new RangeError(`heal window must be a positive finite number of ms, got ${windowMs}`)
hub/src/db/heal-events-dal.ts-37-  }
hub/src/db/heal-events-dal.ts-38-  return Math.floor(nowMs / windowMs)
hub/src/db/heal-events-dal.ts-39-}
hub/src/db/heal-events-dal.ts-40-
hub/src/db/heal-events-dal.ts:41:export interface ClaimHealArgs {
hub/src/db/heal-events-dal.ts-42-  userId: string
hub/src/db/heal-events-dal.ts-43-  source: string
hub/src/db/heal-events-dal.ts-44-  dedupeKey: string
hub/src/db/heal-events-dal.ts-45-  repoIdent?: string | null
hub/src/db/heal-events-dal.ts-46-  triggerRunId?: string | null
hub/src/db/heal-events-dal.ts-47-  windowMs: number
hub/src/db/heal-events-dal.ts-48-  maxClaimsPerUserHour: number
hub/src/db/heal-events-dal.ts-49-  retentionHours: number
--
hub/src/db/heal-events-dal.ts-91-  window_bucket: string | number
hub/src/db/heal-events-dal.ts-92-  trigger_run_id: string | null
hub/src/db/heal-events-dal.ts-93-  dispatch_run_id: string | null
hub/src/db/heal-events-dal.ts-94-  metadata_run_id: string | null
hub/src/db/heal-events-dal.ts-95-  session_id: string | null
hub/src/db/heal-events-dal.ts-96-  outcome: string | null
hub/src/db/heal-events-dal.ts-97-  notification_claimed_at: string | Date | null
hub/src/db/heal-events-dal.ts-98-  recovery_ctx?: Record<string, unknown> | null
hub/src/db/heal-events-dal.ts:99:  owner_email?: OwnerEmailPayload | null
hub/src/db/heal-events-dal.ts:100:  owner_email_claimed_at?: string | Date | null
hub/src/db/heal-events-dal.ts:101:  owner_email_delivered_at?: string | Date | null
hub/src/db/heal-events-dal.ts-102-  created_at: string | Date
hub/src/db/heal-events-dal.ts-103-  updated_at: string | Date
hub/src/db/heal-events-dal.ts-104-}
hub/src/db/heal-events-dal.ts-105-
hub/src/db/heal-events-dal.ts-106-/** Delete at most 100 rows older than max(retentionHours, 24h). Never younger than 24h. */
hub/src/db/heal-events-dal.ts-107-export async function pruneHealEvents(
hub/src/db/heal-events-dal.ts-108-  retentionHours: number,
hub/src/db/heal-events-dal.ts-109-  exec: HealExec = sql,
--
hub/src/db/heal-events-dal.ts-119-}
hub/src/db/heal-events-dal.ts-120-
hub/src/db/heal-events-dal.ts-121-/** The task id of a `task:<id>:<signature>` dedupe key, else null. */
hub/src/db/heal-events-dal.ts-122-function taskIdOf(dedupeKey: string): string | null {
hub/src/db/heal-events-dal.ts-123-  const m = /^task:([^:]+):/.exec(dedupeKey)
hub/src/db/heal-events-dal.ts-124-  return m ? m[1]! : null
hub/src/db/heal-events-dal.ts-125-}
hub/src/db/heal-events-dal.ts-126-
hub/src/db/heal-events-dal.ts:127:export async function claimHealEvent(args: ClaimHealArgs, exec: HealExec = sql): Promise<ClaimHealResult> {
hub/src/db/heal-events-dal.ts-128-  const now = args.nowMs ?? Date.now()
hub/src/db/heal-events-dal.ts-129-  const bucket = windowBucket(now, args.windowMs) // throws RangeError on a bad window
hub/src/db/heal-events-dal.ts-130-  if (!Number.isFinite(args.maxClaimsPerUserHour) || args.maxClaimsPerUserHour <= 0) {
hub/src/db/heal-events-dal.ts-131-    throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
hub/src/db/heal-events-dal.ts-132-  }
hub/src/db/heal-events-dal.ts-133-
hub/src/db/heal-events-dal.ts-134-  // Opportunistic bounded reap, outside the lock. A reap failure must not block a claim.
hub/src/db/heal-events-dal.ts-135-  try {
--
hub/src/db/heal-events-dal.ts-196-          AND (outcome IS NULL OR outcome IN ('dispatched_live', 'dispatched_after_spawn',
hub/src/db/heal-events-dal.ts-197-                                              'autospawn_starting', 'autospawn_launched', 'autospawn_parked'))
hub/src/db/heal-events-dal.ts-198-      `
hub/src/db/heal-events-dal.ts-199-      if (Number(rc[0]?.n ?? 0) >= args.maxPerRepoHour) preOutcome = REPO_RATE_BOUND_OUTCOME
hub/src/db/heal-events-dal.ts-200-    }
hub/src/db/heal-events-dal.ts-201-
hub/src/db/heal-events-dal.ts-202-    // (d) INSERT; the unique indexes are the backstop - an empty return means duplicate.
hub/src/db/heal-events-dal.ts-203-    const inserted = await tx`
hub/src/db/heal-events-dal.ts:204:      INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, outcome, recovery_ctx, owner_email, created_at, updated_at)
hub/src/db/heal-events-dal.ts-205-      VALUES (${args.userId}, ${args.source}, ${args.repoIdent ?? null}, ${args.dedupeKey}, ${bucket},
hub/src/db/heal-events-dal.ts-206-              ${args.triggerRunId ?? null}, ${preOutcome}, ${args.recoveryCtx ? JSON.stringify(args.recoveryCtx) : null}::jsonb,
hub/src/db/heal-events-dal.ts-207-              ${args.ownerEmail ? JSON.stringify(args.ownerEmail) : null}::jsonb, ${createdAt}, ${createdAt})
hub/src/db/heal-events-dal.ts-208-      ON CONFLICT DO NOTHING
hub/src/db/heal-events-dal.ts-209-      RETURNING id
hub/src/db/heal-events-dal.ts-210-    `
hub/src/db/heal-events-dal.ts-211-    if (inserted.length === 0) return { ok: false, reason: 'duplicate' }
hub/src/db/heal-events-dal.ts-212-    return preOutcome
--
hub/src/db/heal-events-dal.ts-308-    WHERE outcome IN ('autospawn_starting', 'autospawn_launched', 'autospawn_parked') AND updated_at < ${cutoff}
hub/src/db/heal-events-dal.ts-309-    ORDER BY updated_at
hub/src/db/heal-events-dal.ts-310-    LIMIT 50
hub/src/db/heal-events-dal.ts-311-  `
hub/src/db/heal-events-dal.ts-312-  return rows as HealEventRow[]
hub/src/db/heal-events-dal.ts-313-}
hub/src/db/heal-events-dal.ts-314-
hub/src/db/heal-events-dal.ts-315-// --- Owner-email outbox (PTYCAP-07 repair round) ---------------------------------------------
hub/src/db/heal-events-dal.ts:316:// The obligation (owner_email) is written in the claim transaction. Delivery is a LEASE CAS:
hub/src/db/heal-events-dal.ts:317:// owner_email_claimed_at is stamped by the one caller that may send (a stale lease, i.e. a crash
hub/src/db/heal-events-dal.ts:318:// mid-send, can be re-taken), owner_email_delivered_at is the terminal flag stamped after the send.
hub/src/db/heal-events-dal.ts-319-// At-least-once across a crash in the narrow send->mark window, never zero, never concurrent.
hub/src/db/heal-events-dal.ts-320-
hub/src/db/heal-events-dal.ts-321-export const OWNER_EMAIL_LEASE_MS = 5 * 60_000
hub/src/db/heal-events-dal.ts-322-
hub/src/db/heal-events-dal.ts-323-export interface OwnerEmailClaim {
hub/src/db/heal-events-dal.ts-324-  id: string
hub/src/db/heal-events-dal.ts-325-  user_id: string
hub/src/db/heal-events-dal.ts:326:  owner_email: OwnerEmailPayload
hub/src/db/heal-events-dal.ts-327-}
hub/src/db/heal-events-dal.ts-328-
hub/src/db/heal-events-dal.ts-329-/** True when this run's heal event carries an undelivered-or-delivered obligation (a row exists). */
hub/src/db/heal-events-dal.ts-330-export async function hasOwnerEmailObligation(runId: string, exec: HealExec = sql): Promise<boolean> {
hub/src/db/heal-events-dal.ts-331-  const rows = await exec`
hub/src/db/heal-events-dal.ts-332-    SELECT 1 AS one FROM heal_events
hub/src/db/heal-events-dal.ts:333:    WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} AND owner_email IS NOT NULL
hub/src/db/heal-events-dal.ts-334-    LIMIT 1
hub/src/db/heal-events-dal.ts-335-  `
hub/src/db/heal-events-dal.ts-336-  return rows.length > 0
hub/src/db/heal-events-dal.ts-337-}
hub/src/db/heal-events-dal.ts-338-
hub/src/db/heal-events-dal.ts-339-/** Lease CAS by event id. Yields the payload to the ONE caller allowed to send, else null. */
hub/src/db/heal-events-dal.ts-340-export async function claimOwnerEmailDelivery(
hub/src/db/heal-events-dal.ts-341-  id: string,
hub/src/db/heal-events-dal.ts-342-  leaseMs: number = OWNER_EMAIL_LEASE_MS,
hub/src/db/heal-events-dal.ts-343-  exec: HealExec = sql,
hub/src/db/heal-events-dal.ts-344-  nowMs: number = Date.now(),
hub/src/db/heal-events-dal.ts-345-): Promise<OwnerEmailClaim | null> {
hub/src/db/heal-events-dal.ts-346-  const staleBefore = new Date(nowMs - leaseMs)
hub/src/db/heal-events-dal.ts-347-  const rows = await exec`
hub/src/db/heal-events-dal.ts:348:    UPDATE heal_events SET owner_email_claimed_at = ${new Date(nowMs)}
hub/src/db/heal-events-dal.ts:349:    WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
hub/src/db/heal-events-dal.ts:350:      AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${staleBefore})
hub/src/db/heal-events-dal.ts:351:    RETURNING id, user_id, owner_email
hub/src/db/heal-events-dal.ts-352-  `
hub/src/db/heal-events-dal.ts-353-  return rows.length > 0 ? (rows[0] as OwnerEmailClaim) : null
hub/src/db/heal-events-dal.ts-354-}
hub/src/db/heal-events-dal.ts-355-
hub/src/db/heal-events-dal.ts-356-export async function claimOwnerEmailDeliveryByRun(
hub/src/db/heal-events-dal.ts-357-  runId: string,
hub/src/db/heal-events-dal.ts-358-  leaseMs: number = OWNER_EMAIL_LEASE_MS,
hub/src/db/heal-events-dal.ts-359-  exec: HealExec = sql,
--
hub/src/db/heal-events-dal.ts-364-  `
hub/src/db/heal-events-dal.ts-365-  if (found.length === 0) return null
hub/src/db/heal-events-dal.ts-366-  return claimOwnerEmailDelivery(found[0].id as string, leaseMs, exec, nowMs)
hub/src/db/heal-events-dal.ts-367-}
hub/src/db/heal-events-dal.ts-368-
hub/src/db/heal-events-dal.ts-369-/** Terminal flag. Idempotent. */
hub/src/db/heal-events-dal.ts-370-export async function markOwnerEmailDelivered(id: string, exec: HealExec = sql): Promise<void> {
hub/src/db/heal-events-dal.ts-371-  await exec`
hub/src/db/heal-events-dal.ts:372:    UPDATE heal_events SET owner_email_delivered_at = now(), updated_at = now()
hub/src/db/heal-events-dal.ts:373:    WHERE id = ${id} AND owner_email_delivered_at IS NULL
hub/src/db/heal-events-dal.ts-374-  `
hub/src/db/heal-events-dal.ts-375-}
hub/src/db/heal-events-dal.ts-376-
hub/src/db/heal-events-dal.ts-377-/** Failed send: drop the lease so the next sweep retries without waiting out the lease. */
hub/src/db/heal-events-dal.ts-378-export async function releaseOwnerEmailClaim(id: string, exec: HealExec = sql): Promise<void> {
hub/src/db/heal-events-dal.ts-379-  await exec`
hub/src/db/heal-events-dal.ts:380:    UPDATE heal_events SET owner_email_claimed_at = NULL
hub/src/db/heal-events-dal.ts:381:    WHERE id = ${id} AND owner_email_delivered_at IS NULL
hub/src/db/heal-events-dal.ts-382-  `
hub/src/db/heal-events-dal.ts-383-}
hub/src/db/heal-events-dal.ts-384-
hub/src/db/heal-events-dal.ts-385-/** Best-effort: add the heal outcome reason to a still-undelivered obligation. */
hub/src/db/heal-events-dal.ts-386-export async function appendOwnerEmailReason(id: string, reason: string, exec: HealExec = sql): Promise<void> {
hub/src/db/heal-events-dal.ts-387-  const line = `Self-heal outcome: ${reason}`.replace(/[^ -~]/g, '?').slice(0, 200)
hub/src/db/heal-events-dal.ts-388-  await exec`
hub/src/db/heal-events-dal.ts:389:    UPDATE heal_events SET owner_email = jsonb_set(
hub/src/db/heal-events-dal.ts:390:      jsonb_set(owner_email, '{text}', to_jsonb((owner_email->>'text') || E'
hub/src/db/heal-events-dal.ts-391-' || ${line}::text)),
hub/src/db/heal-events-dal.ts:392:      '{html}', to_jsonb((owner_email->>'html') || '<p>' || replace(replace(${line}::text, '&', '&amp;'), '<', '&lt;') || '</p>'))
hub/src/db/heal-events-dal.ts:393:    WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
hub/src/db/heal-events-dal.ts-394-  `
hub/src/db/heal-events-dal.ts-395-}
hub/src/db/heal-events-dal.ts-396-
hub/src/db/heal-events-dal.ts-397-/** Undelivered obligations older than the guard whose lease is free or stale. Bounded. */
hub/src/db/heal-events-dal.ts-398-export async function listPendingOwnerEmails(
hub/src/db/heal-events-dal.ts-399-  olderThanMs: number,
hub/src/db/heal-events-dal.ts-400-  exec: HealExec = sql,
hub/src/db/heal-events-dal.ts-401-  nowMs: number = Date.now(),
hub/src/db/heal-events-dal.ts-402-  leaseMs: number = OWNER_EMAIL_LEASE_MS,
hub/src/db/heal-events-dal.ts-403-): Promise<OwnerEmailClaim[]> {
hub/src/db/heal-events-dal.ts-404-  const rows = await exec`
hub/src/db/heal-events-dal.ts:405:    SELECT id, user_id, owner_email FROM heal_events
hub/src/db/heal-events-dal.ts:406:    WHERE owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
hub/src/db/heal-events-dal.ts-407-      AND created_at < ${new Date(nowMs - olderThanMs)}
hub/src/db/heal-events-dal.ts:408:      AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${new Date(nowMs - leaseMs)})
hub/src/db/heal-events-dal.ts-409-    ORDER BY created_at
hub/src/db/heal-events-dal.ts-410-    LIMIT 50
hub/src/db/heal-events-dal.ts-411-  `
hub/src/db/heal-events-dal.ts-412-  return rows as OwnerEmailClaim[]
hub/src/db/heal-events-dal.ts-413-}
--
hub/src/heal\notify.ts-102-    return { claimed, sent: ok === true };
hub/src/heal\notify.ts-103-  } catch (err: any) {
hub/src/heal\notify.ts-104-    log(`notify failed for event ${eventId}: ${err?.message ?? err}; not retried`);
hub/src/heal\notify.ts-105-    return { claimed, sent: false };
hub/src/heal\notify.ts-106-  }
hub/src/heal\notify.ts-107-}
hub/src/heal\notify.ts-108-
hub/src/heal\notify.ts-109-/** Returns true only when the single send attempt reported success. */
hub/src/heal\notify.ts:110:export async function notifyOnce(
hub/src/heal\notify.ts-111-  eventId: string,
hub/src/heal\notify.ts-112-  event: NotifyEvent,
hub/src/heal\notify.ts-113-  reason: string,
hub/src/heal\notify.ts-114-  deps: NotifyDeps = REAL_NOTIFY_DEPS,
hub/src/heal\notify.ts-115-): Promise<boolean> {
hub/src/heal\notify.ts-116-  return (await notifyOnceDetailed(eventId, event, reason, deps)).sent;
hub/src/heal\notify.ts-117-}
--
hub/src/heal\owner-email.ts-1-// hub/src/heal/owner-email.ts
hub/src/heal\owner-email.ts-2-//
hub/src/heal\owner-email.ts-3-// PTYCAP-07 repair round: delivery of the persisted default owner-email obligation (outbox).
hub/src/heal\owner-email.ts:4:// The obligation is written with the heal claim (heal-events-dal claimHealEvent). Two deliverers,
hub/src/heal\owner-email.ts-5-// one lease CAS between them: the scheduler hook right after the heal hook returns, and the heal
hub/src/heal\owner-email.ts-6-// sweep for anything a crash left undelivered. A send that reports failure drops the lease so the
hub/src/heal\owner-email.ts-7-// next sweep retries; a hub crash mid-send is retried after the lease expires. Never throws.
hub/src/heal\owner-email.ts-8-
hub/src/heal\owner-email.ts-9-import type { OwnerEmailClaim } from '../db/heal-events-dal.ts';
hub/src/heal\owner-email.ts-10-
hub/src/heal\owner-email.ts-11-export interface OwnerEmailDeps {
hub/src/heal\owner-email.ts-12-  hasObligation(runId: string): Promise<boolean>;
--
hub/src/heal\owner-email.ts-41-async function sendClaimed(c: OwnerEmailClaim, deps: OwnerEmailDeps): Promise<boolean> {
hub/src/heal\owner-email.ts-42-  try {
hub/src/heal\owner-email.ts-43-    const to = await deps.resolveOwnerEmail(c.user_id);
hub/src/heal\owner-email.ts-44-    if (!to) {
hub/src/heal\owner-email.ts-45-      log(`no owner address for event ${c.id}; closing without a send`);
hub/src/heal\owner-email.ts-46-      await deps.markDelivered(c.id);
hub/src/heal\owner-email.ts-47-      return false;
hub/src/heal\owner-email.ts-48-    }
hub/src/heal\owner-email.ts:49:    const ok = await deps.send({ to, subject: c.owner_email.subject, text: c.owner_email.text, html: c.owner_email.html });
hub/src/heal\owner-email.ts-50-    if (!ok) {
hub/src/heal\owner-email.ts-51-      log(`send reported failure for event ${c.id}; left for the sweep`);
hub/src/heal\owner-email.ts-52-      await deps.release(c.id).catch(() => {});
hub/src/heal\owner-email.ts-53-      return false;
hub/src/heal\owner-email.ts-54-    }
hub/src/heal\owner-email.ts-55-    await deps.markDelivered(c.id); // a failure here means a re-send after the lease, never a loss
hub/src/heal\owner-email.ts-56-    return true;
hub/src/heal\owner-email.ts-57-  } catch (err: any) {
--
hub/src/heal\route.ts-36-  parseHealEvent,
hub/src/heal\route.ts-37-  outcomeToString,
hub/src/heal\route.ts-38-  recoveryCtxFor,
hub/src/heal\route.ts-39-  OUTCOME_AUTOSPAWN_STARTING,
hub/src/heal\route.ts-40-  type HealEvent,
hub/src/heal\route.ts-41-  type HealOutcome,
hub/src/heal\route.ts-42-} from './types.ts';
hub/src/heal\route.ts-43-import type { HealSink, HealTerminalOutcome, SinkFactory } from './sinks/types.ts';
hub/src/heal\route.ts:44:import type { ClaimHealArgs, ClaimHealResult, HealOutcomeExtra } from '../db/heal-events-dal.ts';
hub/src/heal\route.ts-45-import { notifyOnceDetailed, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';
hub/src/heal\route.ts-46-
hub/src/heal\route.ts-47-export { REAL_AUTOSPAWN, type AutospawnDeps };
hub/src/heal\route.ts-48-
hub/src/heal\route.ts-49-const HEAL_ACTOR = 'self-heal';
hub/src/heal\route.ts-50-
hub/src/heal\route.ts-51-export interface HealDeps {
hub/src/heal\route.ts-52-  now(): number;
hub/src/heal\route.ts-53-  resolve(event: HealEvent): Promise<HealTarget>;
hub/src/heal\route.ts:54:  claim(args: ClaimHealArgs): Promise<ClaimHealResult>;
hub/src/heal\route.ts-55-  setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
hub/src/heal\route.ts-56-  isHealGenerated(runId: string): Promise<boolean>;
hub/src/heal\route.ts-57-  makeSink: SinkFactory;
hub/src/heal\route.ts-58-  dispatch(req: DispatchRequest, deps: PipelineDeps): Promise<DispatchOutcome>;
hub/src/heal\route.ts-59-  isChannelOnline(sessionId: string): boolean;
hub/src/heal\route.ts-60-  /** Session runner type at DISPATCH time (the PTY denial must hold here, not only at resolve time). */
hub/src/heal\route.ts-61-  runnerTypeOf(sessionId: string, userId: string): Promise<string>;
hub/src/heal\route.ts-62-  /** Owner-notification seam (07-06). Defaults to the real claim + email sender. */
--
hub/src/heal\route.ts-69-
hub/src/heal\route.ts-70-const REAL_APPEND_REASON = async (eventId: string, reason: string): Promise<void> =>
hub/src/heal\route.ts-71-  (await import('../db/heal-events-dal.ts')).appendOwnerEmailReason(eventId, reason);
hub/src/heal\route.ts-72-
hub/src/heal\route.ts-73-/** Real collaborators. DB-touching ones are lazy so importing this module never loads the DB. */
hub/src/heal\route.ts-74-export const REAL_DEPS: HealDeps = {
hub/src/heal\route.ts-75-  now: () => Date.now(),
hub/src/heal\route.ts-76-  resolve: (event) => resolveHealTarget(event),
hub/src/heal\route.ts:77:  claim: async (args) => (await import('../db/heal-events-dal.ts')).claimHealEvent(args),
hub/src/heal\route.ts-78-  setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
hub/src/heal\route.ts-79-  isHealGenerated: async (runId) => (await import('../db/heal-events-dal.ts')).isHealGenerated(runId),
hub/src/heal\route.ts-80-  // Plan 07-07 creates the sinks index; resolved at call time so this module has no hard edge to it.
hub/src/heal\route.ts-81-  makeSink: async (event, ctx) => {
hub/src/heal\route.ts-82-    const spec = './sinks/index.ts';
hub/src/heal\route.ts-83-    const mod = await import(spec);
hub/src/heal\route.ts-84-    return (mod.makeHealSink as SinkFactory)(event, ctx);
hub/src/heal\route.ts-85-  },
--
hub/src/heal\route.ts-160-  return 'reason' in o ? o.reason : o.kind;
hub/src/heal\route.ts-161-}
hub/src/heal\route.ts-162-
hub/src/heal\route.ts-163-/**
hub/src/heal\route.ts-164- * The single finalization point for non-dispatch outcomes that have a ledger row: persist, terminalize
hub/src/heal\route.ts-165- * through the sink, THEN notify the owner once (a crash between the writes still dedupes). A
hub/src/heal\route.ts-166- * notification failure never changes the outcome and never throws.
hub/src/heal\route.ts-167- */
hub/src/heal\route.ts:168:async function finalizeNonLive(
hub/src/heal\route.ts-169-  deps: HealDeps,
hub/src/heal\route.ts-170-  event: HealEvent,
hub/src/heal\route.ts-171-  eventId: string,
hub/src/heal\route.ts-172-  sink: HealSink | null,
hub/src/heal\route.ts-173-  outcome: HealOutcome,
hub/src/heal\route.ts-174-  extra: HealOutcomeExtra = {},
hub/src/heal\route.ts-175-  sinkOutcome?: HealTerminalOutcome,
hub/src/heal\route.ts-176-  notify = true,
hub/src/heal\route.ts-177-): Promise<HealOutcome> {
hub/src/heal\route.ts-178-  await persist(deps, eventId, outcome, extra);
hub/src/heal\route.ts-179-  await terminalize(sink, sinkOutcome ?? (outcome as HealTerminalOutcome));
hub/src/heal\route.ts-180-  // Outbox (repair round): a scheduled_task event carrying a persisted owner-email obligation is
hub/src/heal\route.ts-181-  // notified by THAT obligation (scheduler sends it, the sweep redelivers it after a crash). Heal
hub/src/heal\route.ts-182-  // adds its outcome to the obligation and never sends a second, ownerless email.
hub/src/heal\route.ts:183:  if (event.source === 'scheduled_task' && event.owner_email) {
hub/src/heal\route.ts-184-    try {
hub/src/heal\route.ts-185-      await (deps.appendOwnerEmailReason ?? REAL_APPEND_REASON)(eventId, outcomeReason(outcome));
hub/src/heal\route.ts-186-    } catch (err) {
hub/src/heal\route.ts-187-      log(`owner email reason append failed id=${eventId}: ${errMsg(err)}`);
hub/src/heal\route.ts-188-    }
hub/src/heal\route.ts-189-    notify = false;
hub/src/heal\route.ts-190-  }
hub/src/heal\route.ts-191-  if (!notify) {
--
hub/src/heal\route.ts-296-    if (timer != null) a.clearTimer(timer);
hub/src/heal\route.ts-297-    timer = null;
hub/src/heal\route.ts-298-  };
hub/src/heal\route.ts-299-  const expire = async (ledgerReason: string, sinkReason: string) => {
hub/src/heal\route.ts-300-    if (settled) return;
hub/src/heal\route.ts-301-    settled = true;
hub/src/heal\route.ts-302-    disarm();
hub/src/heal\route.ts-303-    if (!(await release())) return; // outcome stays autospawn_launched/parked: the sweep retries
hub/src/heal\route.ts:304:    await finalizeNonLive(
hub/src/heal\route.ts-305-      deps,
hub/src/heal\route.ts-306-      event,
hub/src/heal\route.ts-307-      eventId,
hub/src/heal\route.ts-308-      sink,
hub/src/heal\route.ts-309-      { kind: 'failed', reason: ledgerReason },
hub/src/heal\route.ts-310-      extra,
hub/src/heal\route.ts-311-      { kind: 'failed', reason: sinkReason },
hub/src/heal\route.ts-312-      asyncNotify,
--
hub/src/heal\route.ts-321-          dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
hub/src/heal\route.ts-322-        });
hub/src/heal\route.ts-323-      } catch (err) {
hub/src/heal\route.ts-324-        log(`setOutcome failed id=${eventId}: ${errMsg(err)}`); // the turn was delivered; never fail it
hub/src/heal\route.ts-325-      }
hub/src/heal\route.ts-326-      return null;
hub/src/heal\route.ts-327-    }
hub/src/heal\route.ts-328-    if (!(await release())) return deferToSweep('release after post-spawn refusal');
hub/src/heal\route.ts:329:    return finalizeNonLive(deps, event, eventId, sink, mapAfterSpawn(result), extra, undefined, notify);
hub/src/heal\route.ts-330-  };
hub/src/heal\route.ts-331-
hub/src/heal\route.ts-332-  const pdeps: PipelineDeps = buildPipelineDeps(sink, deps, {
hub/src/heal\route.ts-333-    // The parked turn can be minutes stale: it re-enters dispatch() and is fully re-gated. A replay
hub/src/heal\route.ts-334-    // after the deadline (settled) delivers nothing.
hub/src/heal\route.ts-335-    replay: async (r) => {
hub/src/heal\route.ts-336-      if (settled) return;
hub/src/heal\route.ts-337-      settled = true;
hub/src/heal\route.ts-338-      disarm();
hub/src/heal\route.ts-339-      try {
hub/src/heal\route.ts-340-        await afterDispatch(await deps.dispatch(r ?? req, pdeps), asyncNotify);
hub/src/heal\route.ts-341-      } catch (err) {
hub/src/heal\route.ts-342-        log(`replay failed id=${eventId}: ${errMsg(err)}`);
hub/src/heal\route.ts-343-        if (!(await release())) return;
hub/src/heal\route.ts:344:        await finalizeNonLive(
hub/src/heal\route.ts-345-          deps, event, eventId, sink, { kind: 'failed', reason: `heal_replay_error: ${errMsg(err)}` }, extra, undefined, asyncNotify,
hub/src/heal\route.ts-346-        );
hub/src/heal\route.ts-347-      }
hub/src/heal\route.ts-348-    },
hub/src/heal\route.ts-349-    onParkExpire: () => expire('grace_expired', 'heal_grace_expired'),
hub/src/heal\route.ts-350-  });
hub/src/heal\route.ts-351-
hub/src/heal\route.ts-352-  // Recoverable BEFORE any reservation or spawn: a crash between the lifetime reservation and the
--
hub/src/heal\route.ts-393-  switch (launched.kind) {
hub/src/heal\route.ts-394-    case 'refused': {
hub/src/heal\route.ts-395-      const outcome: HealOutcome =
hub/src/heal\route.ts-396-        launched.reason === 'disabled'
hub/src/heal\route.ts-397-          ? { kind: 'no_routable_session', reason: 'autospawn_not_armed', notified: false }
hub/src/heal\route.ts-398-          : launched.reason === 'not_allowlisted' || launched.reason === 'supervisor_offline'
hub/src/heal\route.ts-399-            ? { kind: 'no_routable_session', reason: launched.reason, notified: false }
hub/src/heal\route.ts-400-            : { kind: 'refused', reason: launched.reason };
hub/src/heal\route.ts:401:      return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
hub/src/heal\route.ts-402-    }
hub/src/heal\route.ts-403-    case 'failed':
hub/src/heal\route.ts:404:      return finalizeNonLive(deps, event, eventId, sink, { kind: 'failed', reason: launched.reason }, extra);
hub/src/heal\route.ts-405-    case 'in_flight':
hub/src/heal\route.ts-406-      kind = 'autospawn_parked';
hub/src/heal\route.ts-407-      break;
hub/src/heal\route.ts-408-    case 'launched':
hub/src/heal\route.ts-409-      kind = 'autospawn_launched';
hub/src/heal\route.ts-410-      break;
hub/src/heal\route.ts-411-  }
hub/src/heal\route.ts-412-
--
hub/src/heal\route.ts-491-      windowMs: healDedupeWindowMs(),
hub/src/heal\route.ts-492-      maxClaimsPerUserHour: healMaxClaimsPerUserHour(),
hub/src/heal\route.ts-493-      retentionHours: healRetentionHours(),
hub/src/heal\route.ts-494-      // Atomic ceilings (QC r1): counted and inserted in the claim transaction. The repo bound is
hub/src/heal\route.ts-495-      // only meaningful for a routable target (a `none` target dispatches nothing).
hub/src/heal\route.ts-496-      ...(target.kind !== 'none' ? { maxPerRepoHour: healMaxPerRepoHour() } : {}),
hub/src/heal\route.ts-497-      ...(event.source === 'scheduled_task' ? { maxPerTaskDay: healMaxPerTaskDay() } : {}),
hub/src/heal\route.ts-498-      recoveryCtx: recoveryCtxFor(event),
hub/src/heal\route.ts:499:      ...(event.source === 'scheduled_task' && event.owner_email ? { ownerEmail: event.owner_email } : {}),
hub/src/heal\route.ts-500-      nowMs: deps.now(),
hub/src/heal\route.ts-501-    });
hub/src/heal\route.ts-502-    if (!claim.ok) {
hub/src/heal\route.ts-503-      // A dropped duplicate / capped event must never leave its run pending (D-05).
hub/src/heal\route.ts-504-      const outcome: HealTerminalOutcome =
hub/src/heal\route.ts-505-        claim.reason === 'duplicate' ? { kind: 'deduped' } : { kind: 'refused', reason: claim.reason };
hub/src/heal\route.ts-506-      await terminalize(await sinkFor(null), outcome);
hub/src/heal\route.ts-507-      return outcome;
hub/src/heal\route.ts-508-    }
hub/src/heal\route.ts-509-    eventId = claim.id;
hub/src/heal\route.ts-510-    const sink = await sinkFor(eventId);
hub/src/heal\route.ts-511-
hub/src/heal\route.ts-512-    if (target.kind === 'none') {
hub/src/heal\route.ts-513-      const outcome: HealOutcome = { kind: 'no_routable_session', reason: target.reason, notified: false };
hub/src/heal\route.ts:514:      return finalizeNonLive(deps, event, eventId, sink, outcome, { repoIdent, sessionId: null });
hub/src/heal\route.ts-515-    }
hub/src/heal\route.ts-516-
hub/src/heal\route.ts-517-    // Per-repo hourly bound (AM-F4-4): a fresh session cannot be seen by the session-keyed rate gate.
hub/src/heal\route.ts:518:    // Decided atomically by the claim (claimHealEvent); the row is already refused:repo_rate_bound.
hub/src/heal\route.ts-519-    if (claim.repoRateBound) {
hub/src/heal\route.ts-520-      const outcome: HealOutcome = { kind: 'refused', reason: 'repo_rate_bound' };
hub/src/heal\route.ts:521:      return finalizeNonLive(deps, event, eventId, sink, outcome, {
hub/src/heal\route.ts-522-        repoIdent: target.repoIdent,
hub/src/heal\route.ts-523-        sessionId: target.sessionId,
hub/src/heal\route.ts-524-      });
hub/src/heal\route.ts-525-    }
hub/src/heal\route.ts-526-
hub/src/heal\route.ts-527-    // SH-04: an offline candidate goes through the governed autospawn branch, never a live dispatch.
hub/src/heal\route.ts-528-    if (target.kind === 'offline_candidate') return await autospawnHeal(deps, event, target, eventId, sink);
hub/src/heal\route.ts-529-
--
hub/src/heal\route.ts-553-      sessionId: target.sessionId,
hub/src/heal\route.ts-554-      repoIdent: target.repoIdent,
hub/src/heal\route.ts-555-      dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
hub/src/heal\route.ts-556-    };
hub/src/heal\route.ts-557-    if (outcome.kind === 'dispatched_live') {
hub/src/heal\route.ts-558-      await persist(deps, eventId, outcome, extra);
hub/src/heal\route.ts-559-      return outcome;
hub/src/heal\route.ts-560-    }
hub/src/heal\route.ts:561:    return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
hub/src/heal\route.ts-562-  } catch (err) {
hub/src/heal\route.ts-563-    // D-06: any throw terminalizes as failed. There is NO dispatch-anyway branch.
hub/src/heal\route.ts-564-    const outcome: HealOutcome = { kind: 'failed', reason: `heal_route_error: ${errMsg(err)}` };
hub/src/heal\route.ts-565-    log(`route error: ${errMsg(err)}`);
hub/src/heal\route.ts-566-    try {
hub/src/heal\route.ts-567-      const sink = await deps.makeSink(event, { eventId });
hub/src/heal\route.ts-568-      // A ledger row exists: finalize + notify once. Without one there is nothing to claim ownership on.
hub/src/heal\route.ts:569:      if (eventId) return await finalizeNonLive(deps, event, eventId, sink, outcome);
hub/src/heal\route.ts-570-      await terminalize(sink, outcome);
hub/src/heal\route.ts-571-    } catch (sinkErr) {
hub/src/heal\route.ts-572-      log(`no sink to terminalize route error: ${errMsg(sinkErr)}`);
hub/src/heal\route.ts-573-      await persist(deps, eventId, outcome);
hub/src/heal\route.ts-574-    }
hub/src/heal\route.ts-575-    return outcome;
hub/src/heal\route.ts-576-  }
hub/src/heal\route.ts-577-}
--
hub/src/heal\types.ts-38-
hub/src/heal\types.ts-39-const scheduledTask = z
hub/src/heal\types.ts-40-  .object({
hub/src/heal\types.ts-41-    ...common,
hub/src/heal\types.ts-42-    source: z.literal('scheduled_task'),
hub/src/heal\types.ts-43-    dedupe_key: z.string().startsWith('task:'),
hub/src/heal\types.ts-44-    bound_session_id: nonEmpty,
hub/src/heal\types.ts-45-    /** Pending default owner email, persisted with the claim (outbox). Absent = heal sends its own. */
hub/src/heal\types.ts:46:    owner_email: z.object({ subject: nonEmpty, text: nonEmpty, html: nonEmpty }).optional(),
hub/src/heal\types.ts-47-    ctx: z.object({ task_id: nonEmpty, task_name: z.string(), error_signature: z.string() }),
hub/src/heal\types.ts-48-  })
hub/src/heal\types.ts-49-  .strict();
hub/src/heal\types.ts-50-
hub/src/heal\types.ts-51-const errorCapture = z
hub/src/heal\types.ts-52-  .object({
hub/src/heal\types.ts-53-    ...common,
hub/src/heal\types.ts-54-    source: z.literal('error_capture'),
--
hub/src/heal\sweep.ts-131-        continue;
hub/src/heal\sweep.ts-132-      }
hub/src/heal\sweep.ts-133-      await deps.setOutcome(row.id, 'failed:spawn_timeout', {});
hub/src/heal\sweep.ts-134-      if (row.source === 'scheduled_task') {
hub/src/heal\sweep.ts-135-        // The scheduler default email is the owner notification for a scheduled-task event once its
hub/src/heal\sweep.ts-136-        // launch outcome was returned; the sweep takes the claim only and never sends a second one.
hub/src/heal\sweep.ts-137-        await (deps.notify ?? REAL_NOTIFY_DEPS).claim(row.id).catch(() => false);
hub/src/heal\sweep.ts-138-      } else {
hub/src/heal\sweep.ts:139:        await notifyOnce(row.id, event, 'spawn_timeout', deps.notify ?? REAL_NOTIFY_DEPS);
hub/src/heal\sweep.ts-140-      }
hub/src/heal\sweep.ts-141-      result.swept++;
hub/src/heal\sweep.ts-142-    } catch (err: any) {
hub/src/heal\sweep.ts-143-      result.failed++;
hub/src/heal\sweep.ts-144-      log(`row ${row.id} failed (left for the next boot): ${err?.message ?? err}`);
hub/src/heal\sweep.ts-145-    }
hub/src/heal\sweep.ts-146-  }
hub/src/heal\sweep.ts-147-  if (result.swept || result.failed) log(`boot sweep: ${JSON.stringify(result)}`);
--
hub/src/heal\sources\scheduled-task.ts-135-    user_id: task.user_id,
hub/src/heal\sources\scheduled-task.ts-136-    repo_ident: repoIdent,
hub/src/heal\sources\scheduled-task.ts-137-    prompt,
hub/src/heal\sources\scheduled-task.ts-138-    stored_content: `[task failed: ${name}]\n\n${prompt}`,
hub/src/heal\sources\scheduled-task.ts-139-    metadata_run_id: null,
hub/src/heal\sources\scheduled-task.ts-140-    trigger_run_id: runId,
hub/src/heal\sources\scheduled-task.ts-141-    dedupe_key: `task:${task.id}:${signature}`,
hub/src/heal\sources\scheduled-task.ts-142-    bound_session_id: task.session_id,
hub/src/heal\sources\scheduled-task.ts:143:    ...(ownerEmail ? { owner_email: ownerEmail } : {}),
hub/src/heal\sources\scheduled-task.ts-144-    notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`.slice(0, 500),
hub/src/heal\sources\scheduled-task.ts-145-    ctx: { task_id: task.id, task_name: name, error_signature: normalized },
hub/src/heal\sources\scheduled-task.ts-146-  });
hub/src/heal\sources\scheduled-task.ts-147-  if ('notifyClaimed' in outcome && outcome.notifyClaimed === true) return true;
hub/src/heal\sources\scheduled-task.ts-148-  return 'notified' in outcome && outcome.notified === true;
hub/src/heal\sources\scheduled-task.ts-149-}

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/scheduler/post-run/dispatcher.ts'; "'$l=Get-Content $p; for($i=60;$i -le 390;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/heal/route.ts'; "'$l=Get-Content $p; for($i=140;$i -le 590;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/heal/sweep.ts'; "'$l=Get-Content $p; for($i=0;$i -lt $l.Length;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; rg -n "startHealSweep|scheduleHeal|sweepStaleHealLaunches" hub/src --glob '"'"'!heal/sweep.ts'"'" in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 521ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  141:       sessionInjectRateGate,
  142:       automationLifetimeCounterGate,
  143:     ],
  144:     store: sink,
  145:     isOnline: (req) => deps.isChannelOnline(req.sessionId),
  146:     // A live-path heal turn carries per-event payload that would be stale later: it is never replayed.
  147:     // The autospawn branch supplies its own hooks (replay re-enters dispatch, expiry releases).
  148:     replay: hooks?.replay ?? (async (req) => sink.onParkExpire(req)),
  149:     onParkExpire: hooks?.onParkExpire ?? ((req) => sink.onParkExpire(req)),
  150:     send: (req) => sink.send(req),
  151:   };
  152: }
  153: 
  154: function errMsg(err: unknown): string {
  155:   return (err as any)?.message ?? String(err);
  156: }
  157: 
  158: /** Owner-visible reason for a non-dispatch outcome. */
  159: function outcomeReason(o: HealOutcome): string {
  160:   return 'reason' in o ? o.reason : o.kind;
  161: }
  162: 
  163: /**
  164:  * The single finalization point for non-dispatch outcomes that have a ledger row: persist, terminalize
  165:  * through the sink, THEN notify the owner once (a crash between the writes still dedupes). A
  166:  * notification failure never changes the outcome and never throws.
  167:  */
  168: async function finalizeNonLive(
  169:   deps: HealDeps,
  170:   event: HealEvent,
  171:   eventId: string,
  172:   sink: HealSink | null,
  173:   outcome: HealOutcome,
  174:   extra: HealOutcomeExtra = {},
  175:   sinkOutcome?: HealTerminalOutcome,
  176:   notify = true,
  177: ): Promise<HealOutcome> {
  178:   await persist(deps, eventId, outcome, extra);
  179:   await terminalize(sink, sinkOutcome ?? (outcome as HealTerminalOutcome));
  180:   // Outbox (repair round): a scheduled_task event carrying a persisted owner-email obligation is
  181:   // notified by THAT obligation (scheduler sends it, the sweep redelivers it after a crash). Heal
  182:   // adds its outcome to the obligation and never sends a second, ownerless email.
  183:   if (event.source === 'scheduled_task' && event.owner_email) {
  184:     try {
  185:       await (deps.appendOwnerEmailReason ?? REAL_APPEND_REASON)(eventId, outcomeReason(outcome));
  186:     } catch (err) {
  187:       log(`owner email reason append failed id=${eventId}: ${errMsg(err)}`);
  188:     }
  189:     notify = false;
  190:   }
  191:   if (!notify) {
  192:     // The owner notification for this event was already settled elsewhere (the scheduler default
  193:     // email, selected when the launch outcome was returned). Take the claim only, never send.
  194:     try {
  195:       await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
  196:     } catch (err) {
  197:       log(`notification slot claim failed id=${eventId}: ${errMsg(err)}`);
  198:     }
  199:     return outcome;
  200:   }
  201:   const n = await notifyOnceDetailed(eventId, event, outcomeReason(outcome), deps.notify ?? REAL_NOTIFY_DEPS);
  202:   // Ownership (claimed) is reported for EVERY non-live outcome, independent of delivery (sent).
  203:   if (outcome.kind === 'no_routable_session') return { ...outcome, notified: n.sent, notifyClaimed: n.claimed };
  204:   if (outcome.kind === 'refused' || outcome.kind === 'failed') return { ...outcome, notifyClaimed: n.claimed };
  205:   return outcome;
  206: }
  207: 
  208: /** Heal-generated provenance of either run id. Throws on a probe error (caller fails closed). */
  209: async function isHealDerived(event: HealEvent, deps: HealDeps): Promise<boolean> {
  210:   for (const runId of [event.trigger_run_id, event.metadata_run_id]) {
  211:     if (runId && (await deps.isHealGenerated(runId))) return true;
  212:   }
  213:   return false;
  214: }
  215: 
  216: /** The dispatch request for a resolved target. The ONLY place the lifetime key is attached (AM-F4-3). */
  217: function buildRequest(event: HealEvent, target: { sessionId: string; repoIdent: string }, eventId: string): DispatchRequest {
  218:   return {
  219:     userId: event.user_id,
  220:     sessionId: target.sessionId,
  221:     token: `heal:${eventId}`,
  222:     prompt: withScopeContract(asciiPunctuation(event.prompt)),
  223:     images: event.images,
  224:     counterKey: buildHealKey(event.user_id, target.repoIdent),
  225:   };
  226: }
  227: 
  228: /**
  229:  * Stamp the lifetime reservation for a heal event released. The only exported place that names
  230:  * the lifetime key, so the boot sweep can free a reservation stranded by a restart.
  231:  */
  232: export async function releaseHealReservation(
  233:   userId: string,
  234:   repoIdent: string,
  235:   eventId: string,
  236:   autospawn: Pick<AutospawnDeps, 'release'> = REAL_AUTOSPAWN,
  237: ): Promise<void> {
  238:   await autospawn.release({ counterKey: buildHealKey(userId, repoIdent), token: `heal:${eventId}` });
  239: }
  240: 
  241: /** Map a pipeline outcome for a request delivered after a spawn into a non-live outcome. */
  242: function mapAfterSpawn(result: DispatchOutcome): HealOutcome {
  243:   switch (result.kind) {
  244:     case 'dropped_busy':
  245:       return { kind: 'refused', reason: 'session_busy' };
  246:     case 'skipped':
  247:       return { kind: 'refused', reason: result.reason };
  248:     case 'failed':
  249:       return { kind: 'failed', reason: result.reason };
  250:     default:
  251:       return { kind: 'failed', reason: 'reconnect_not_online' };
  252:   }
  253: }
  254: 
  255: /**
  256:  * SH-04: heal an OFFLINE candidate through the shared governed adapter. Gates, the atomic lifetime
  257:  * reservation and the ledger row all run BEFORE the spawn. After a launch the request is parked
  258:  * through the single dispatch pipeline; ONE deadline timer bounds the wait, and the reservation is
  259:  * released on every failure path. Process-local state only: the boot sweep covers a restart.
  260:  */
  261: async function autospawnHeal(
  262:   deps: HealDeps,
  263:   event: HealEvent,
  264:   target: { sessionId: string; repoIdent: string },
  265:   eventId: string,
  266:   sink: HealSink,
  267: ): Promise<HealOutcome> {
  268:   const a = deps.autospawn ?? REAL_AUTOSPAWN;
  269:   const req = buildRequest(event, target, eventId);
  270:   const extra = { sessionId: target.sessionId, repoIdent: target.repoIdent };
  271:   // The release is STRICT (QC r2): a failed release must leave the event in a state the boot sweep
  272:   // retries (autospawn_starting / launched / parked), never a terminal outcome that hides the slot.
  273:   let releaseFailed = false;
  274:   const release = async (): Promise<boolean> => {
  275:     try {
  276:       await releaseHealReservation(event.user_id, target.repoIdent, eventId, a);
  277:       return true;
  278:     } catch (err) {
  279:       releaseFailed = true;
  280:       log(`reservation release failed id=${eventId} (left for the sweep): ${errMsg(err)}`);
  281:       return false;
  282:     }
  283:   };
  284:   /** Release could not be confirmed: keep the recoverable outcome; the sweep terminalizes + notifies. */
  285:   const deferToSweep = (why: string): HealOutcome => {
  286:     log(`heal event ${eventId} left for the sweep: ${why}`);
  287:     return { kind: 'failed', reason: 'heal_release_pending' };
  288:   };
  289:   // The scheduler default email is the owner notification for a scheduled-task event once the launch
  290:   // outcome has been returned, so every ASYNC finalizer (deadline, replay) must not send a second.
  291:   const asyncNotify = event.source !== 'scheduled_task';
  292: 
  293:   let settled = false;
  294:   let timer: unknown = null;
  295:   const disarm = () => {
  296:     if (timer != null) a.clearTimer(timer);
  297:     timer = null;
  298:   };
  299:   const expire = async (ledgerReason: string, sinkReason: string) => {
  300:     if (settled) return;
  301:     settled = true;
  302:     disarm();
  303:     if (!(await release())) return; // outcome stays autospawn_launched/parked: the sweep retries
  304:     await finalizeNonLive(
  305:       deps,
  306:       event,
  307:       eventId,
  308:       sink,
  309:       { kind: 'failed', reason: ledgerReason },
  310:       extra,
  311:       { kind: 'failed', reason: sinkReason },
  312:       asyncNotify,
  313:     );
  314:   };
  315:   /** Outcome of a request that was actually dispatched after the spawn; null = delivered. */
  316:   const afterDispatch = async (result: DispatchOutcome, notify = true): Promise<HealOutcome | null> => {
  317:     if (result.kind === 'dispatched' || result.kind === 'queued') {
  318:       try {
  319:         await deps.setOutcome(eventId, 'dispatched_after_spawn', {
  320:           ...extra,
  321:           dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
  322:         });
  323:       } catch (err) {
  324:         log(`setOutcome failed id=${eventId}: ${errMsg(err)}`); // the turn was delivered; never fail it
  325:       }
  326:       return null;
  327:     }
  328:     if (!(await release())) return deferToSweep('release after post-spawn refusal');
  329:     return finalizeNonLive(deps, event, eventId, sink, mapAfterSpawn(result), extra, undefined, notify);
  330:   };
  331: 
  332:   const pdeps: PipelineDeps = buildPipelineDeps(sink, deps, {
  333:     // The parked turn can be minutes stale: it re-enters dispatch() and is fully re-gated. A replay
  334:     // after the deadline (settled) delivers nothing.
  335:     replay: async (r) => {
  336:       if (settled) return;
  337:       settled = true;
  338:       disarm();
  339:       try {
  340:         await afterDispatch(await deps.dispatch(r ?? req, pdeps), asyncNotify);
  341:       } catch (err) {
  342:         log(`replay failed id=${eventId}: ${errMsg(err)}`);
  343:         if (!(await release())) return;
  344:         await finalizeNonLive(
  345:           deps, event, eventId, sink, { kind: 'failed', reason: `heal_replay_error: ${errMsg(err)}` }, extra, undefined, asyncNotify,
  346:         );
  347:       }
  348:     },
  349:     onParkExpire: () => expire('grace_expired', 'heal_grace_expired'),
  350:   });
  351: 
  352:   // Recoverable BEFORE any reservation or spawn: a crash between the lifetime reservation and the
  353:   // 'launched' outcome would otherwise leave a NULL-outcome row the sweep never selects, stranding
  354:   // the reservation forever. Deliberately NOT swallowed: if the ledger cannot record the intent,
  355:   // nothing is reserved or spawned (the outer handler terminalizes as failed).
  356:   await deps.setOutcome(eventId, OUTCOME_AUTOSPAWN_STARTING, extra);
  357: 
  358:   const launched = await governedLaunch(
  359:     {
  360:       userId: event.user_id,
  361:       sessionId: target.sessionId,
  362:       repoIdent: target.repoIdent,
  363:       tz: await a.tzForUser(event.user_id),
  364:       armed: a.armed(),
  365:       ledger: {
  366:         repoKey: target.repoIdent,
  367:         command: AUTOSPAWN_LAUNCH_COMMAND,
  368:         rationale: () => `self-heal event ${eventId}`,
  369:       },
  370:       preLaunch: {
  371:         checkGates: () => a.checkGates(req, pdeps.gates),
  372:         reserve: () =>
  373:           a.reserve({
  374:             userId: event.user_id,
  375:             sessionId: target.sessionId,
  376:             token: req.token,
  377:             counterKey: req.counterKey as string,
  378:             actor: HEAL_ACTOR,
  379:             enforceRate: true,
  380:           }),
  381:         release,
  382:       },
  383:     },
  384:     a,
  385:   );
  386: 
  387:   let kind: 'autospawn_launched' | 'autospawn_parked';
  388:   // A refusal / failure after the reservation was taken unwinds through release(); if that release
  389:   // did not land, the slot is still held: do not write a terminal outcome over the recoverable row.
  390:   if ((launched.kind === 'refused' || launched.kind === 'failed') && releaseFailed) {
  391:     return deferToSweep(`launch ${launched.kind}: ${launched.reason}`);
  392:   }
  393:   switch (launched.kind) {
  394:     case 'refused': {
  395:       const outcome: HealOutcome =
  396:         launched.reason === 'disabled'
  397:           ? { kind: 'no_routable_session', reason: 'autospawn_not_armed', notified: false }
  398:           : launched.reason === 'not_allowlisted' || launched.reason === 'supervisor_offline'
  399:             ? { kind: 'no_routable_session', reason: launched.reason, notified: false }
  400:             : { kind: 'refused', reason: launched.reason };
  401:       return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
  402:     }
  403:     case 'failed':
  404:       return finalizeNonLive(deps, event, eventId, sink, { kind: 'failed', reason: launched.reason }, extra);
  405:     case 'in_flight':
  406:       kind = 'autospawn_parked';
  407:       break;
  408:     case 'launched':
  409:       kind = 'autospawn_launched';
  410:       break;
  411:   }
  412: 
  413:   // Launched (or already in flight): the ledger outcome first so a crash is recoverable by the
  414:   // boot sweep, then ONE deadline timer, then park through the single pipeline.
  415:   await persist(deps, eventId, { kind }, extra);
  416:   if (event.source === 'scheduled_task') {
  417:     // The scheduler's default failure email goes out NOW (the heal returns un-claimed). Take the
  418:     // notification claim on its behalf, with no send, so a later spawn_timeout / grace_expired /
  419:     // boot-sweep notice for this same event loses the claim: one owner notification per event.
  420:     // Determinism if this claim cannot be persisted (QC r2): the default email is STILL the sole
  421:     // owner, because every later heal finalizer for a scheduled_task event (deadline, replay, the
  422:     // boot sweep) is claim-only and never sends. A failed claim here cannot produce a second email.
  423:     try {
  424:       await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
  425:     } catch (err) {
  426:       log(`scheduler notification slot claim failed id=${eventId}: ${errMsg(err)}`);
  427:     }
  428:   }
  429:   timer = a.setTimer(() => void expire('spawn_timeout', 'heal_spawn_timeout'), healSpawnTimeoutMs());
  430:   let result: DispatchOutcome;
  431:   try {
  432:     result = await deps.dispatch(req, pdeps);
  433:   } catch (err) {
  434:     settled = true;
  435:     disarm();
  436:     if (!(await release())) return deferToSweep(`dispatch threw: ${errMsg(err)}`);
  437:     throw err; // D-06: the outer handler terminalizes as failed and notifies once
  438:   }
  439:   if (result.kind === 'parked_offline') return { kind };
  440:   settled = true;
  441:   disarm();
  442:   return (await afterDispatch(result)) ?? { kind };
  443: }
  444: 
  445: export async function routeHeal(input: unknown, deps: HealDeps = REAL_DEPS): Promise<HealOutcome> {
  446:   let event: HealEvent;
  447:   try {
  448:     event = parseHealEvent(input);
  449:   } catch (err) {
  450:     const outcome: HealOutcome = { kind: 'failed', reason: 'invalid_event' };
  451:     try {
  452:       await terminalize(await deps.makeSink(input as HealEvent, { eventId: null }), outcome);
  453:     } catch (sinkErr) {
  454:       log(`invalid event and no sink: ${errMsg(sinkErr)}`);
  455:     }
  456:     log(`invalid event: ${errMsg(err)}`);
  457:     return outcome;
  458:   }
  459: 
  460:   if (!healUnifiedEnabled()) return { kind: 'refused', reason: 'heal_disabled' };
  461: 
  462:   let eventId: string | null = null;
  463:   try {
  464:     const sinkFor = (id: string | null) => deps.makeSink(event, { eventId: id });
  465: 
  466:     // Recursion guard (AM-F5-3): BEFORE any claim, fail closed.
  467:     let derived: boolean;
  468:     try {
  469:       derived = await isHealDerived(event, deps);
  470:     } catch (err) {
  471:       log(`provenance probe failed (fail closed): ${errMsg(err)}`);
  472:       await terminalize(await sinkFor(null), { kind: 'failed', reason: 'heal_guard_error' });
  473:       return { kind: 'refused', reason: 'heal_guard_error' };
  474:     }
  475:     if (derived) {
  476:       const outcome: HealOutcome = { kind: 'refused', reason: 'heal_provenance' };
  477:       await terminalize(await sinkFor(null), outcome);
  478:       return outcome;
  479:     }
  480: 
  481:     const target = await deps.resolve(event);
  482:     const repoIdent =
  483:       target.kind !== 'none' ? target.repoIdent : isCanonicalRepoIdent(event.repo_ident) ? event.repo_ident : null;
  484: 
  485:     const claim = await deps.claim({
  486:       userId: event.user_id,
  487:       source: event.source,
  488:       dedupeKey: event.dedupe_key,
  489:       repoIdent,
  490:       triggerRunId: event.trigger_run_id,
  491:       windowMs: healDedupeWindowMs(),
  492:       maxClaimsPerUserHour: healMaxClaimsPerUserHour(),
  493:       retentionHours: healRetentionHours(),
  494:       // Atomic ceilings (QC r1): counted and inserted in the claim transaction. The repo bound is
  495:       // only meaningful for a routable target (a `none` target dispatches nothing).
  496:       ...(target.kind !== 'none' ? { maxPerRepoHour: healMaxPerRepoHour() } : {}),
  497:       ...(event.source === 'scheduled_task' ? { maxPerTaskDay: healMaxPerTaskDay() } : {}),
  498:       recoveryCtx: recoveryCtxFor(event),
  499:       ...(event.source === 'scheduled_task' && event.owner_email ? { ownerEmail: event.owner_email } : {}),
  500:       nowMs: deps.now(),
  501:     });
  502:     if (!claim.ok) {
  503:       // A dropped duplicate / capped event must never leave its run pending (D-05).
  504:       const outcome: HealTerminalOutcome =
  505:         claim.reason === 'duplicate' ? { kind: 'deduped' } : { kind: 'refused', reason: claim.reason };
  506:       await terminalize(await sinkFor(null), outcome);
  507:       return outcome;
  508:     }
  509:     eventId = claim.id;
  510:     const sink = await sinkFor(eventId);
  511: 
  512:     if (target.kind === 'none') {
  513:       const outcome: HealOutcome = { kind: 'no_routable_session', reason: target.reason, notified: false };
  514:       return finalizeNonLive(deps, event, eventId, sink, outcome, { repoIdent, sessionId: null });
  515:     }
  516: 
  517:     // Per-repo hourly bound (AM-F4-4): a fresh session cannot be seen by the session-keyed rate gate.
  518:     // Decided atomically by the claim (claimHealEvent); the row is already refused:repo_rate_bound.
  519:     if (claim.repoRateBound) {
  520:       const outcome: HealOutcome = { kind: 'refused', reason: 'repo_rate_bound' };
  521:       return finalizeNonLive(deps, event, eventId, sink, outcome, {
  522:         repoIdent: target.repoIdent,
  523:         sessionId: target.sessionId,
  524:       });
  525:     }
  526: 
  527:     // SH-04: an offline candidate goes through the governed autospawn branch, never a live dispatch.
  528:     if (target.kind === 'offline_candidate') return await autospawnHeal(deps, event, target, eventId, sink);
  529: 
  530:     const req = buildRequest(event, target, eventId);
  531:     const result = await deps.dispatch(req, buildPipelineDeps(sink, deps));
  532: 
  533:     let outcome: HealOutcome;
  534:     switch (result.kind) {
  535:       case 'dispatched':
  536:       case 'queued':
  537:         outcome = { kind: 'dispatched_live' };
  538:         break;
  539:       case 'dropped_busy':
  540:         outcome = { kind: 'refused', reason: 'session_busy' };
  541:         break;
  542:       case 'skipped':
  543:         outcome = { kind: 'refused', reason: result.reason };
  544:         break;
  545:       case 'failed':
  546:         outcome = { kind: 'failed', reason: result.reason };
  547:         break;
  548:       case 'parked_offline':
  549:         outcome = { kind: 'no_routable_session', reason: 'target_went_offline', notified: false };
  550:         break;
  551:     }
  552:     const extra = {
  553:       sessionId: target.sessionId,
  554:       repoIdent: target.repoIdent,
  555:       dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
  556:     };
  557:     if (outcome.kind === 'dispatched_live') {
  558:       await persist(deps, eventId, outcome, extra);
  559:       return outcome;
  560:     }
  561:     return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
  562:   } catch (err) {
  563:     // D-06: any throw terminalizes as failed. There is NO dispatch-anyway branch.
  564:     const outcome: HealOutcome = { kind: 'failed', reason: `heal_route_error: ${errMsg(err)}` };
  565:     log(`route error: ${errMsg(err)}`);
  566:     try {
  567:       const sink = await deps.makeSink(event, { eventId });
  568:       // A ledger row exists: finalize + notify once. Without one there is nothing to claim ownership on.
  569:       if (eventId) return await finalizeNonLive(deps, event, eventId, sink, outcome);
  570:       await terminalize(sink, outcome);
  571:     } catch (sinkErr) {
  572:       log(`no sink to terminalize route error: ${errMsg(sinkErr)}`);
  573:       await persist(deps, eventId, outcome);
  574:     }
  575:     return outcome;
  576:   }
  577: }
  578: 
  579: 
  580: 
  581: 
  582: 
  583: 
  584: 
  585: 
  586: 
  587: 
  588: 
  589: 
  590: 
  591: 

 succeeded in 538ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
    1: // hub/src/heal/sweep.ts
    2: //
    3: // PTYCAP-07-06 (SC4, T-07-21, T-07-24): sweep for heal launches stranded by a hub restart. The
    4: // spawn deadline timer in route.ts is process-local, so a restart inside the spawn window would
    5: // leave the event's metadata run pending until the 6h reaper. Event driven, no interval timer: one
    6: // sweep at boot plus ONE follow-up at the spawn deadline (QC r1: a row stranded by a quick restart
    7: // is younger than the staleness guard at boot, and would otherwise wait for the next boot). Every
    8: // row stranded at or before boot is older than the guard by the follow-up, so no heal run can stay
    9: // pending past deadline + the follow-up margin. Flag-gated by the caller AND re-checked here,
   10: // best-effort per row, bounded, idempotent through the sink.
   11: 
   12: import { healUnifiedEnabled, healSpawnTimeoutMs } from './config.ts';
   13: import { OUTCOME_AUTOSPAWN_STARTING } from './types.ts';
   14: import { sweepOwnerEmails, REAL_OWNER_EMAIL_DEPS, type OwnerEmailDeps } from './owner-email.ts';
   15: import { notifyOnce, REAL_NOTIFY_DEPS, type NotifyDeps } from './notify.ts';
   16: import type { HealEvent } from './types.ts';
   17: import type { HealOutcomeExtra, HealEventRow } from '../db/heal-events-dal.ts';
   18: import type { SinkFactory } from './sinks/types.ts';
   19: 
   20: /** Hard bound per boot, matching listStaleLaunchingHealEvents' LIMIT. */
   21: export const SWEEP_BATCH = 50;
   22: 
   23: /** Starting = claimed and about to reserve/launch (a crash there strands the lifetime slot). */
   24: const STRANDED = new Set([OUTCOME_AUTOSPAWN_STARTING, 'autospawn_launched', 'autospawn_parked']);
   25: 
   26: /** Slack after the staleness guard before the one follow-up sweep fires. */
   27: export const FOLLOW_UP_MARGIN_MS = 1000;
   28: 
   29: export interface SweepDeps {
   30:   list(olderThanMs: number): Promise<HealEventRow[]>;
   31:   reread(id: string): Promise<{ outcome: string | null } | null>;
   32:   setOutcome(id: string, outcome: string, extra: HealOutcomeExtra): Promise<void>;
   33:   makeSink: SinkFactory;
   34:   release(userId: string, repoIdent: string, eventId: string): Promise<void>;
   35:   notify?: NotifyDeps;
   36:   /** Owner-email outbox collaborators (defaults to the real DAL + email sender). */
   37:   ownerEmails?: OwnerEmailDeps;
   38:   /** One-shot timer for the follow-up sweep (unref'd in the real binding). */
   39:   setTimer?(fn: () => void, ms: number): unknown;
   40: }
   41: 
   42: /** Real collaborators: lazy imports, so a flag-OFF boot loads nothing of this. */
   43: export const REAL_SWEEP_DEPS: SweepDeps = {
   44:   ownerEmails: REAL_OWNER_EMAIL_DEPS,
   45:   list: async (olderThanMs) => (await import('../db/heal-events-dal.ts')).listStaleLaunchingHealEvents(olderThanMs),
   46:   reread: async (id) => (await import('../db/heal-events-dal.ts')).getHealEvent(id),
   47:   setOutcome: async (id, outcome, extra) => (await import('../db/heal-events-dal.ts')).setHealOutcome(id, outcome, extra),
   48:   makeSink: async (event, ctx) => {
   49:     const spec = './sinks/index.ts';
   50:     const mod = await import(spec);
   51:     return (mod.makeHealSink as SinkFactory)(event, ctx);
   52:   },
   53:   release: async (userId, repoIdent, eventId) =>
   54:     (await import('./route.ts')).releaseHealReservation(userId, repoIdent, eventId),
   55: };
   56: 
   57: function log(msg: string): void {
   58:   console.error(`[heal.sweep] ${msg}`);
   59: }
   60: 
   61: /**
   62:  * The ledger row carries identity, run ids, the bound session id and (for error_capture) the
   63:  * minimal recovery_ctx; that is all a sink needs to terminalize.
   64:  */
   65: function eventFromRow(row: HealEventRow): HealEvent {
   66:   return {
   67:     ...(row.session_id ? { bound_session_id: row.session_id } : {}),
   68:     source: row.source,
   69:     user_id: row.user_id,
   70:     repo_ident: row.repo_ident,
   71:     dedupe_key: row.dedupe_key,
   72:     metadata_run_id: row.metadata_run_id,
   73:     trigger_run_id: row.trigger_run_id,
   74:     prompt: '',
   75:     stored_content: '',
   76:     ctx: row.recovery_ctx ?? {},
   77:   } as unknown as HealEvent;
   78: }
   79: 
   80: export interface SweepResult {
   81:   swept: number;
   82:   skipped: number;
   83:   failed: number;
   84: }
   85: 
   86: async function sweepStrandedLaunches(deps: SweepDeps): Promise<SweepResult> {
   87:   const result: SweepResult = { swept: 0, skipped: 0, failed: 0 };
   88:   if (!healUnifiedEnabled()) return result; // flag OFF: nothing is read, nothing is touched
   89: 
   90:   let rows: HealEventRow[];
   91:   try {
   92:     rows = (await deps.list(2 * healSpawnTimeoutMs())).slice(0, SWEEP_BATCH);
   93:   } catch (err: any) {
   94:     log(`list failed: ${err?.message ?? err}`);
   95:     return result;
   96:   }
   97: 
   98:   for (const row of rows) {
   99:     try {
  100:       const fresh = await deps.reread(row.id);
  101:       if (!fresh || !fresh.outcome || !STRANDED.has(fresh.outcome)) {
  102:         result.skipped++; // another writer already moved it on
  103:         continue;
  104:       }
  105:       const event = eventFromRow(row);
  106:       // Two independent obligations: terminalize the SOURCE run and release the RESERVATION. Both are
  107:       // always attempted (a permanent source failure must not strand the slot, a failed release must
  108:       // not strand the source run). The ledger row is closed ONLY when both are confirmed (QC r2): any
  109:       // failure leaves it selectable for the next sweep with its recoverable outcome intact.
  110:       let sinkError: string | null = null;
  111:       try {
  112:         const sink = await deps.makeSink(event, { eventId: row.id });
  113:         await sink.finalizeTerminal({ kind: 'failed', reason: 'heal_spawn_timeout' });
  114:       } catch (err: any) {
  115:         sinkError = err?.message ?? String(err);
  116:       }
  117:       let releaseError: string | null = null;
  118:       if (row.repo_ident) {
  119:         try {
  120:           await deps.release(row.user_id, row.repo_ident, row.id); // strict + idempotent
  121:         } catch (err: any) {
  122:           releaseError = err?.message ?? String(err);
  123:         }
  124:       }
  125:       if (sinkError || releaseError) {
  126:         result.failed++;
  127:         log(`row ${row.id} kept for retry (source run: ${sinkError ?? 'ok'}; release: ${releaseError ?? 'ok'})`);
  128:         // Same outcome, fresh updated_at: a permanently failing row goes to the back of the queue
  129:         // instead of starving the rest of the bounded batch.
  130:         await deps.setOutcome(row.id, fresh.outcome, {}).catch(() => {});
  131:         continue;
  132:       }
  133:       await deps.setOutcome(row.id, 'failed:spawn_timeout', {});
  134:       if (row.source === 'scheduled_task') {
  135:         // The scheduler default email is the owner notification for a scheduled-task event once its
  136:         // launch outcome was returned; the sweep takes the claim only and never sends a second one.
  137:         await (deps.notify ?? REAL_NOTIFY_DEPS).claim(row.id).catch(() => false);
  138:       } else {
  139:         await notifyOnce(row.id, event, 'spawn_timeout', deps.notify ?? REAL_NOTIFY_DEPS);
  140:       }
  141:       result.swept++;
  142:     } catch (err: any) {
  143:       result.failed++;
  144:       log(`row ${row.id} failed (left for the next boot): ${err?.message ?? err}`);
  145:     }
  146:   }
  147:   if (result.swept || result.failed) log(`boot sweep: ${JSON.stringify(result)}`);
  148:   return result;
  149: }
  150: 
  151: /**
  152:  * Stranded launches first (a terminalized scheduled_task event's obligation is then due), then the
  153:  * owner-email outbox: every default failure email a crash left undelivered is sent exactly once
  154:  * (lease CAS). Flag OFF: nothing is read or touched.
  155:  */
  156: export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
  157:   if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
  158:   const result = await sweepStrandedLaunches(deps);
  159:   if (!deps.ownerEmails) return result; // injected-deps callers opt in explicitly
  160:   try {
  161:     const sent = await sweepOwnerEmails(2 * healSpawnTimeoutMs(), deps.ownerEmails);
  162:     if (sent) log(`owner email outbox: ${sent} redelivered`);
  163:   } catch (err: any) {
  164:     log(`owner email outbox sweep failed: ${err?.message ?? err}`);
  165:   }
  166:   return result;
  167: }
  168: 
  169: /**
  170:  * Boot entry: sweep now, then ONE follow-up at the spawn deadline plus the staleness guard so a row
  171:  * stranded by a quick restart (younger than the guard at boot) is swept as soon as it ages in.
  172:  * True no-op when the heal flag is OFF (nothing read, no timer armed).
  173:  */
  174: export async function bootSweepHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
  175:   if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
  176:   const first = await sweepStaleHealLaunches(deps);
  177:   const arm = deps.setTimer ?? defaultSetTimer;
  178:   arm(() => {
  179:     void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));
  180:   }, followUpDelayMs());
  181:   return first;
  182: }
  183: 
  184: /** Strictly past the staleness guard (2x spawn timeout) so every boot-stranded row qualifies. */
  185: export function followUpDelayMs(): number {
  186:   return 2 * healSpawnTimeoutMs() + FOLLOW_UP_MARGIN_MS;
  187: }
  188: 
  189: function defaultSetTimer(fn: () => void, ms: number): unknown {
  190:   const handle = setTimeout(fn, ms);
  191:   (handle as { unref?: () => void })?.unref?.();
  192:   return handle;
  193: }
hub/src\heal\sweep.ts:156:export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
hub/src\heal\sweep.ts:176:  const first = await sweepStaleHealLaunches(deps);
hub/src\heal\sweep.ts:179:    void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));

 succeeded in 610ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
   61:  * are machine-created anchors the owner never scheduled, never sees in the tasks UI,  234:  * without being dropped. low/medium findings get NO owner email  360:   // auto-dev P4: qc_review routing. A bare `qc` root or an explicit `qc_review`
  361:   // step emits a `<<FINDINGS>>` block; we chain `qc_fix` ONLY when ≥1 actionable
  362:   // finding survives the 24h verified-finding idempotency filter, and SUPPRESS
  363:   // the generic `chain_task` fan-out so we never double-fire. Zero findings →
  364:   // finalize clean (no chain). qc_verify NEVER chains qc_review (loop-safety).
  365:   const isQcReview =
  366:     (args.task.task_type === 'qc' || args.task.task_type === 'qc_review') &&
  367:     args.status === 'success'
  368:   let qcHandled = false
  369:   if (isQcReview) {
  370:     qcHandled = await routeQcReviewDecision(args, actions)
  371:   }
  372: 
  373:   // auto-dev P4: when a qc_verify run finalizes success (tests green + PR
  374:   // opened), record the originating review's findings as fixed-and-verified so
  375:   // the 24h idempotency guard suppresses them on the next review tick. Walks up
  376:   // the trigger chain to the qc_review snippet. Best-effort; never blocks.
  377:   if (args.task.task_type === 'qc_verify' && args.status === 'success') {
  378:     await recordQcVerifiedFindings(args)
  379:   }
  380: 
  381:   const chainSuppressed = controllerHandled || qcHandled
  382: 
  383:   for (const action of actions) {
  384:     // Suppress generic chain_task for a controller / qc_review run — its routing
  385:     // already fired (or intentionally skipped, e.g. `propose` / zero findings).
  386:     if (chainSuppressed && action.type === 'chain_task') continue
  387:     if (!conditionMatches(action, args)) continue
  388:     const delay = (action.delay_seconds ?? 0) * 1000
  389:     if (delay > 0) {
  390:       const timer = setTimeout(() => {
  391:         pendingTimers.delete(timer)

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n \"bootSweepHealLaunches|sweepStaleHealLaunches\" hub/src --glob '*.ts'" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/heal/route.ts'; "'$l=Get-Content $p; foreach($a in @(@(163,230),@(280,445))){ for($i=$a[0]-1;$i -le $a[1]-1;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] } }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/scheduler/post-run/dispatcher.ts'; "'$l=Get-Content $p; for($i=380;$i -le 460;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; $p='"'hub/src/scheduler/dispatcher.ts'; "'$l=Get-Content $p; for($i=760;$i -le 895;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n \"function executeEmail|export async function executeEmail|sendEmail\\(\" hub/src/scheduler/post-run hub/src/lib/email.ts; Get-Content hub/src/scheduler/post-run/email.ts; Get-Content hub/src/lib/email.ts" in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 540ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  163: /**
  164:  * The single finalization point for non-dispatch outcomes that have a ledger row: persist, terminalize
  165:  * through the sink, THEN notify the owner once (a crash between the writes still dedupes). A
  166:  * notification failure never changes the outcome and never throws.
  167:  */
  168: async function finalizeNonLive(
  169:   deps: HealDeps,
  170:   event: HealEvent,
  171:   eventId: string,
  172:   sink: HealSink | null,
  173:   outcome: HealOutcome,
  174:   extra: HealOutcomeExtra = {},
  175:   sinkOutcome?: HealTerminalOutcome,
  176:   notify = true,
  177: ): Promise<HealOutcome> {
  178:   await persist(deps, eventId, outcome, extra);
  179:   await terminalize(sink, sinkOutcome ?? (outcome as HealTerminalOutcome));
  180:   // Outbox (repair round): a scheduled_task event carrying a persisted owner-email obligation is
  181:   // notified by THAT obligation (scheduler sends it, the sweep redelivers it after a crash). Heal
  182:   // adds its outcome to the obligation and never sends a second, ownerless email.
  183:   if (event.source === 'scheduled_task' && event.owner_email) {
  184:     try {
  185:       await (deps.appendOwnerEmailReason ?? REAL_APPEND_REASON)(eventId, outcomeReason(outcome));
  186:     } catch (err) {
  187:       log(`owner email reason append failed id=${eventId}: ${errMsg(err)}`);
  188:     }
  189:     notify = false;
  190:   }
  191:   if (!notify) {
  192:     // The owner notification for this event was already settled elsewhere (the scheduler default
  193:     // email, selected when the launch outcome was returned). Take the claim only, never send.
  194:     try {
  195:       await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
  196:     } catch (err) {
  197:       log(`notification slot claim failed id=${eventId}: ${errMsg(err)}`);
  198:     }
  199:     return outcome;
  200:   }
  201:   const n = await notifyOnceDetailed(eventId, event, outcomeReason(outcome), deps.notify ?? REAL_NOTIFY_DEPS);
  202:   // Ownership (claimed) is reported for EVERY non-live outcome, independent of delivery (sent).
  203:   if (outcome.kind === 'no_routable_session') return { ...outcome, notified: n.sent, notifyClaimed: n.claimed };
  204:   if (outcome.kind === 'refused' || outcome.kind === 'failed') return { ...outcome, notifyClaimed: n.claimed };
  205:   return outcome;
  206: }
  207: 
  208: /** Heal-generated provenance of either run id. Throws on a probe error (caller fails closed). */
  209: async function isHealDerived(event: HealEvent, deps: HealDeps): Promise<boolean> {
  210:   for (const runId of [event.trigger_run_id, event.metadata_run_id]) {
  211:     if (runId && (await deps.isHealGenerated(runId))) return true;
  212:   }
  213:   return false;
  214: }
  215: 
  216: /** The dispatch request for a resolved target. The ONLY place the lifetime key is attached (AM-F4-3). */
  217: function buildRequest(event: HealEvent, target: { sessionId: string; repoIdent: string }, eventId: string): DispatchRequest {
  218:   return {
  219:     userId: event.user_id,
  220:     sessionId: target.sessionId,
  221:     token: `heal:${eventId}`,
  222:     prompt: withScopeContract(asciiPunctuation(event.prompt)),
  223:     images: event.images,
  224:     counterKey: buildHealKey(event.user_id, target.repoIdent),
  225:   };
  226: }
  227: 
  228: /**
  229:  * Stamp the lifetime reservation for a heal event released. The only exported place that names
  230:  * the lifetime key, so the boot sweep can free a reservation stranded by a restart.
  280:       log(`reservation release failed id=${eventId} (left for the sweep): ${errMsg(err)}`);
  281:       return false;
  282:     }
  283:   };
  284:   /** Release could not be confirmed: keep the recoverable outcome; the sweep terminalizes + notifies. */
  285:   const deferToSweep = (why: string): HealOutcome => {
  286:     log(`heal event ${eventId} left for the sweep: ${why}`);
  287:     return { kind: 'failed', reason: 'heal_release_pending' };
  288:   };
  289:   // The scheduler default email is the owner notification for a scheduled-task event once the launch
  290:   // outcome has been returned, so every ASYNC finalizer (deadline, replay) must not send a second.
  291:   const asyncNotify = event.source !== 'scheduled_task';
  292: 
  293:   let settled = false;
  294:   let timer: unknown = null;
  295:   const disarm = () => {
  296:     if (timer != null) a.clearTimer(timer);
  297:     timer = null;
  298:   };
  299:   const expire = async (ledgerReason: string, sinkReason: string) => {
  300:     if (settled) return;
  301:     settled = true;
  302:     disarm();
  303:     if (!(await release())) return; // outcome stays autospawn_launched/parked: the sweep retries
  304:     await finalizeNonLive(
  305:       deps,
  306:       event,
  307:       eventId,
  308:       sink,
  309:       { kind: 'failed', reason: ledgerReason },
  310:       extra,
  311:       { kind: 'failed', reason: sinkReason },
  312:       asyncNotify,
  313:     );
  314:   };
  315:   /** Outcome of a request that was actually dispatched after the spawn; null = delivered. */
  316:   const afterDispatch = async (result: DispatchOutcome, notify = true): Promise<HealOutcome | null> => {
  317:     if (result.kind === 'dispatched' || result.kind === 'queued') {
  318:       try {
  319:         await deps.setOutcome(eventId, 'dispatched_after_spawn', {
  320:           ...extra,
  321:           dispatchRunId: result.kind === 'dispatched' ? result.runId : null,
  322:         });
  323:       } catch (err) {
  324:         log(`setOutcome failed id=${eventId}: ${errMsg(err)}`); // the turn was delivered; never fail it
  325:       }
  326:       return null;
  327:     }
  328:     if (!(await release())) return deferToSweep('release after post-spawn refusal');
  329:     return finalizeNonLive(deps, event, eventId, sink, mapAfterSpawn(result), extra, undefined, notify);
  330:   };
  331: 
  332:   const pdeps: PipelineDeps = buildPipelineDeps(sink, deps, {
  333:     // The parked turn can be minutes stale: it re-enters dispatch() and is fully re-gated. A replay
  334:     // after the deadline (settled) delivers nothing.
  335:     replay: async (r) => {
  336:       if (settled) return;
  337:       settled = true;
  338:       disarm();
  339:       try {
  340:         await afterDispatch(await deps.dispatch(r ?? req, pdeps), asyncNotify);
  341:       } catch (err) {
  342:         log(`replay failed id=${eventId}: ${errMsg(err)}`);
  343:         if (!(await release())) return;
  344:         await finalizeNonLive(
  345:           deps, event, eventId, sink, { kind: 'failed', reason: `heal_replay_error: ${errMsg(err)}` }, extra, undefined, asyncNotify,
  346:         );
  347:       }
  348:     },
  349:     onParkExpire: () => expire('grace_expired', 'heal_grace_expired'),
  350:   });
  351: 
  352:   // Recoverable BEFORE any reservation or spawn: a crash between the lifetime reservation and the
  353:   // 'launched' outcome would otherwise leave a NULL-outcome row the sweep never selects, stranding
  354:   // the reservation forever. Deliberately NOT swallowed: if the ledger cannot record the intent,
  355:   // nothing is reserved or spawned (the outer handler terminalizes as failed).
  356:   await deps.setOutcome(eventId, OUTCOME_AUTOSPAWN_STARTING, extra);
  357: 
  358:   const launched = await governedLaunch(
  359:     {
  360:       userId: event.user_id,
  361:       sessionId: target.sessionId,
  362:       repoIdent: target.repoIdent,
  363:       tz: await a.tzForUser(event.user_id),
  364:       armed: a.armed(),
  365:       ledger: {
  366:         repoKey: target.repoIdent,
  367:         command: AUTOSPAWN_LAUNCH_COMMAND,
  368:         rationale: () => `self-heal event ${eventId}`,
  369:       },
  370:       preLaunch: {
  371:         checkGates: () => a.checkGates(req, pdeps.gates),
  372:         reserve: () =>
  373:           a.reserve({
  374:             userId: event.user_id,
  375:             sessionId: target.sessionId,
  376:             token: req.token,
  377:             counterKey: req.counterKey as string,
  378:             actor: HEAL_ACTOR,
  379:             enforceRate: true,
  380:           }),
  381:         release,
  382:       },
  383:     },
  384:     a,
  385:   );
  386: 
  387:   let kind: 'autospawn_launched' | 'autospawn_parked';
  388:   // A refusal / failure after the reservation was taken unwinds through release(); if that release
  389:   // did not land, the slot is still held: do not write a terminal outcome over the recoverable row.
  390:   if ((launched.kind === 'refused' || launched.kind === 'failed') && releaseFailed) {
  391:     return deferToSweep(`launch ${launched.kind}: ${launched.reason}`);
  392:   }
  393:   switch (launched.kind) {
  394:     case 'refused': {
  395:       const outcome: HealOutcome =
  396:         launched.reason === 'disabled'
  397:           ? { kind: 'no_routable_session', reason: 'autospawn_not_armed', notified: false }
  398:           : launched.reason === 'not_allowlisted' || launched.reason === 'supervisor_offline'
  399:             ? { kind: 'no_routable_session', reason: launched.reason, notified: false }
  400:             : { kind: 'refused', reason: launched.reason };
  401:       return finalizeNonLive(deps, event, eventId, sink, outcome, extra);
  402:     }
  403:     case 'failed':
  404:       return finalizeNonLive(deps, event, eventId, sink, { kind: 'failed', reason: launched.reason }, extra);
  405:     case 'in_flight':
  406:       kind = 'autospawn_parked';
  407:       break;
  408:     case 'launched':
  409:       kind = 'autospawn_launched';
  410:       break;
  411:   }
  412: 
  413:   // Launched (or already in flight): the ledger outcome first so a crash is recoverable by the
  414:   // boot sweep, then ONE deadline timer, then park through the single pipeline.
  415:   await persist(deps, eventId, { kind }, extra);
  416:   if (event.source === 'scheduled_task') {
  417:     // The scheduler's default failure email goes out NOW (the heal returns un-claimed). Take the
  418:     // notification claim on its behalf, with no send, so a later spawn_timeout / grace_expired /
  419:     // boot-sweep notice for this same event loses the claim: one owner notification per event.
  420:     // Determinism if this claim cannot be persisted (QC r2): the default email is STILL the sole
  421:     // owner, because every later heal finalizer for a scheduled_task event (deadline, replay, the
  422:     // boot sweep) is claim-only and never sends. A failed claim here cannot produce a second email.
  423:     try {
  424:       await (deps.notify ?? REAL_NOTIFY_DEPS).claim(eventId);
  425:     } catch (err) {
  426:       log(`scheduler notification slot claim failed id=${eventId}: ${errMsg(err)}`);
  427:     }
  428:   }
  429:   timer = a.setTimer(() => void expire('spawn_timeout', 'heal_spawn_timeout'), healSpawnTimeoutMs());
  430:   let result: DispatchOutcome;
  431:   try {
  432:     result = await deps.dispatch(req, pdeps);
  433:   } catch (err) {
  434:     settled = true;
  435:     disarm();
  436:     if (!(await release())) return deferToSweep(`dispatch threw: ${errMsg(err)}`);
  437:     throw err; // D-06: the outer handler terminalizes as failed and notifies once
  438:   }
  439:   if (result.kind === 'parked_offline') return { kind };
  440:   settled = true;
  441:   disarm();
  442:   return (await afterDispatch(result)) ?? { kind };
  443: }
  444: 
  445: export async function routeHeal(input: unknown, deps: HealDeps = REAL_DEPS): Promise<HealOutcome> {

 succeeded in 542ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src\index.ts:821:        .then((m) => m.bootSweepHealLaunches())
hub/src\heal\sweep.ts:156:export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
hub/src\heal\sweep.ts:174:export async function bootSweepHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
hub/src\heal\sweep.ts:176:  const first = await sweepStaleHealLaunches(deps);
hub/src\heal\sweep.ts:179:    void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));

 succeeded in 554ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  381:   const chainSuppressed = controllerHandled || qcHandled
  382: 
  383:   for (const action of actions) {
  384:     // Suppress generic chain_task for a controller / qc_review run — its routing
  385:     // already fired (or intentionally skipped, e.g. `propose` / zero findings).
  386:     if (chainSuppressed && action.type === 'chain_task') continue
  387:     if (!conditionMatches(action, args)) continue
  388:     const delay = (action.delay_seconds ?? 0) * 1000
  389:     if (delay > 0) {
  390:       const timer = setTimeout(() => {
  391:         pendingTimers.delete(timer)
  392:         void executeAction(action, args, ctx)
  393:       }, delay)
  394:       pendingTimers.add(timer)
  395:     } else {
  396:       void executeAction(action, args, ctx)
  397:     }
  398:   }
  399: }
  400: 
  401: /**
  402:  * auto-dev P2 — controller decision router.
  403:  *
  404:  * Parses the run's `<<DECISION>>` block and chains the single workflow step the
  405:  * action selects, by matching the decision's target step kind against the
  406:  * child task_type of the task's existing `chain_task` edges. `propose` chains
  407:  * nothing (human-in-the-loop; surfaced to chat in P3). A missing/malformed block
  408:  * falls back to `continue` so a bare dev still resumes.
  409:  *
  410:  * Returns true to signal the caller to SUPPRESS the generic `chain_task` loop
  411:  * for this run (controller owns the chain decision).
  412:  */
  413: export async function routeControllerDecision(
  414:   args: FireCtxArgs,
  415:   actions: PostRunAction[],
  416: ): Promise<boolean> {
  417:   const parsed = parseControllerDecision(args.output_snippet ?? '')
  418:   const decision = parsed.ok ? parsed.value : parsed.fallback
  419:   const nextStep = nextStepForAction(decision.action)
  420: 
  421:   if (nextStep === null) {
  422:     // propose → no chain (human-in-the-loop). P3: surface the roadmap to chat
  423:     // (email + Telegram) + persist a pending-proposal for HITL reply capture.
  424:     // NEVER auto-builds — a human reply → payload.notes → next-tick `plan`.
  425:     console.log(
  426:       `[post-run.controller] task=${args.task.id} action=propose no_chain reason="${decision.reason}"`,
  427:     )
  428:     try {
  429:       await surfaceProposal({ task: args.task, decision, runId: args.runId })
  430:     } catch (err: any) {
  431:       console.error(`[post-run.controller] surfaceProposal failed task=${args.task.id}:`, err?.message)
  432:     }
  433:     return true
  434:   }
  435: 
  436:   // Resolve which chain_task edge points at the selected step kind.
  437:   const chainEdges = actions.filter((a) => a.type === 'chain_task' && a.config?.task_id)
  438:   let matched: PostRunAction | null = null
  439:   for (const edge of chainEdges) {
  440:     const child = await getTaskById(edge.config.task_id)
  441:     if (child && child.task_type === nextStep) {
  442:       matched = edge
  443:       break
  444:     }
  445:   }
  446: 
  447:   if (!matched) {
  448:     // No wired step for this action (e.g. a bare `dev` row with no workflow
  449:     // chain configured). Nothing to chain — safe no-op, do not invent rows.
  450:     console.log(
  451:       `[post-run.controller] task=${args.task.id} action=${decision.action} ` +
  452:         `no_chain_edge_for=${nextStep}`,
  453:     )
  454:     return true
  455:   }
  456: 
  457:   console.log(
  458:     `[post-run.controller] task=${args.task.id} action=${decision.action} chain=${nextStep} child=${matched.config.task_id}`,
  459:   )
  460:   await executeChain(matched, {
  461:     parentRunId: args.runId,
  761:     ? fields.duration_ms
  762:     : ctx ? finishedAt.getTime() - ctx.startedAt : null
  763: 
  764:   // An explicit `fields.cost_usd` (none of today's callers pass one) always
  765:   // wins; otherwise fall back to what `accrueRunCost` accumulated from this
  766:   // run's own `usage_event`s while in flight. `> 0` guard: a supervisor/coolify/
  767:   // teab run with no CLI turn never accrues anything and stays correctly NULL
  768:   // rather than a misleading `0`.
  769:   const costUsd = fields.cost_usd ?? (ctx && ctx.costUsd > 0 ? ctx.costUsd : null)
  770: 
  771:   const updated = await updateRunStatus(runId, {
  772:     status,
  773:     error: error ?? null,
  774:     cost_usd: costUsd,
  775:     duration_ms: dur,
  776:     output_snippet: fields.output_snippet ?? null,
  777:     finished_at: finishedAt,
  778:   }, { onlyIfActive: fields.only_if_active === true })
  779: 
  780:   // Lost the claim race — another finalizer already took this run to a terminal
  781:   // state. Do NOT broadcast or re-fire post-run actions.
  782:   if (fields.only_if_active === true && !updated) {
  783:     inFlightByRun.delete(runId); syncQueueDepthGauge()
  784:     return
  785:   }
  786: 
  787:   if (ctx) {
  788:     // Round-2 migration: the per-session queue slot is released by the shared
  789:     // pipeline (`dispatch.onSessionReply` → `queue.markFinished` on its own
  790:     // queue) when the agent reply lands. The scheduler no longer owns a queue
  791:     // slot here, so there is nothing to release on this side.
  792:     inFlightByRun.delete(runId); syncQueueDepthGauge()
  793:   }
  794: 
  795:   broadcastScheduledRun(updated?.user_id ?? ctx?.userId ?? '', {
  796:     type: 'scheduled_run_finished',
  797:     run_id: runId,
  798:     task_id: ctx?.taskId ?? updated?.task_id ?? null,
  799:     status,
  800:     error: error ?? null,
  801:     cost_usd: costUsd,
  802:     duration_ms: dur,
  803:     output_snippet: fields.output_snippet ?? null,
  804:   })
  805: 
  806:   const task = ctx?.taskId
  807:     ? await getTaskById(ctx.taskId)
  808:     : updated?.task_id ? await getTaskById(updated.task_id) : null
  809:   if (task) {
  810:     // PTYCAP-07-08 (AM-F5-2): heal hook BETWEEN the terminal UPDATE and post-run processing.
  811:     // Inert (returns false, imports nothing) unless the run failed AND REMO_HEAL_UNIFIED is ON.
  812:     const healOwnsNotification = status === 'failed'
  813:       ? await healFailedRunHook(task, runId, error ?? null)
  814:       : false
  815:     await onRunFinalized(task, runId, status, error ?? null, {
  816:       cost_usd: costUsd,
  817:       duration_ms: dur,
  818:       output_snippet: fields.output_snippet ?? null,
  819:       parentFireId: ctx?.parentFireId ?? null,
  820:       chainDepth: ctx?.chainDepth ?? 0,
  821:       ...(healOwnsNotification ? { suppressDefaultFailureEmail: true } : {}),
  822:     })
  823:   }
  824: }
  825: 
  826: /**
  827:  * Never throws into finalizeRun. Resolves true only when the heal path claimed and sent the one
  828:  * owner notification; any error resolves false so the normal failure email proceeds.
  829:  */
  830: async function healFailedRunHook(
  831:   task: ScheduledTask,
  832:   runId: string,
  833:   error: string | null,
  834: ): Promise<boolean> {
  835:   try {
  836:     const { healUnifiedEnabled } = await import('../heal/config.ts')
  837:     if (!healUnifiedEnabled()) return false
  838:     const { healFailedScheduledRun } = await import('../heal/sources/scheduled-task.ts')
  839:     // Outbox: when the default failure email applies, it is persisted with the heal claim and sent
  840:     // from here, so a crash between the claim and the send cannot lose it (the sweep redelivers).
  841:     const { defaultFailureEmailApplies } = await import('./post-run/dispatcher.ts')
  842:     const persistOwnerEmail = await defaultFailureEmailApplies(task).catch(() => false)
  843:     const healOwns = await healFailedScheduledRun({ runId, status: 'failed', error, task, persistOwnerEmail })
  844:     if (persistOwnerEmail) {
  845:       const { deliverOwnerEmailForRun } = await import('../heal/owner-email.ts')
  846:       if (await deliverOwnerEmailForRun(runId)) return true
  847:     }
  848:     return healOwns
  849:   } catch (err: any) {
  850:     log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
  851:     return false
  852:   }
  853: }
  854: 
  855: interface PostRunPayload {
  856:   cost_usd: number | null
  857:   duration_ms: number | null
  858:   output_snippet: string | null
  859:   parentFireId?: string | null
  860:   chainDepth: number
  861:   /** PTYCAP-07-08: the heal path already notified the owner of this failure. */
  862:   suppressDefaultFailureEmail?: boolean
  863: }
  864: 
  865: async function onRunFinalized(
  866:   task: ScheduledTask,
  867:   runId: string,
  868:   status: RunStatus,
  869:   error: string | null,
  870:   extra: PostRunPayload = { cost_usd: null, duration_ms: null, output_snippet: null, chainDepth: 0 },
  871: ): Promise<void> {
  872:   try {
  873:     const { afterRun } = await import('./post-run/dispatcher.ts')
  874:     await afterRun({
  875:       task,
  876:       runId,
  877:       status,
  878:       error,
  879:       cost_usd: extra.cost_usd,
  880:       duration_ms: extra.duration_ms,
  881:       output_snippet: extra.output_snippet,
  882:       parentFireId: extra.parentFireId ?? null,
  883:       chainDepth: extra.chainDepth,
  884:       ...(extra.suppressDefaultFailureEmail ? { suppressDefaultFailureEmail: true } : {}),
  885:     })
  886:   } catch (err: any) {
  887:     log.error('scheduler.dispatcher.post_run_failed', { task_id: task.id, run_id: runId, error: err?.message })
  888:   }
  889: }
  890: 
  891: export async function cancelRun(runId: string, userId: string): Promise<boolean> {
  892:   const ctx = inFlightByRun.get(runId)
  893:   if (ctx && ctx.userId !== userId) return false
  894:   if (ctx?.target?.agentSocket) {
  895:     try { ctx.target.agentSocket.send(JSON.stringify({ type: 'cancel', run_id: runId })) } catch {}
  896:   }

 succeeded in 609ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/lib/email.ts:13:export async function sendEmail(input: SendEmailInput): Promise<boolean> {
hub/src/scheduler/post-run\email.ts:19:export async function executeEmail(action: PostRunAction, ctx: EmailCtx): Promise<void> {
/**
 * Email post-run action (W2/T8.6).
 *
 * Uses emails4agents per global CLAUDE.md mandate (rule #7) — never
 * SES/SendGrid/Postmark/Mailgun/Resend without explicit user request.
 *
 *   E4A_API_KEY     — required
 *   E4A_BASE_URL    — defaults to https://api.emails4agents.com
 *   E4A_INBOX_ID    — required
 *
 * Failures are log-only — they never fail the parent run.
 */
import type { PostRunAction } from './schema.ts'
import { render } from './template.ts'
import { getUserById } from '../../db/dal.ts'

interface EmailCtx { userId: string; templateVars: Record<string, unknown> }

export async function executeEmail(action: PostRunAction, ctx: EmailCtx): Promise<void> {
  if (action.type !== 'notify_email') return
  const apiKey = process.env.E4A_API_KEY
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com'
  const inboxId = process.env.E4A_INBOX_ID

  let to = action.config.to
  if (!to) {
    const user = await getUserById(ctx.userId)
    to = user?.email
  }
  if (!to) { console.warn('[post-run.email] no recipient resolved, skipping'); return }
  if (!apiKey || !inboxId) {
    console.warn(`[post-run.email] E4A env not configured; would have emailed ${to}`)
    return
  }

  const subject = render(action.config.subject, ctx.templateVars)
  const html = render(action.config.body, ctx.templateVars, { html: true })
  const text = render(action.config.body, ctx.templateVars)

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ from_inbox_id: inboxId, to, subject, html, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[post-run.email] send failed ${res.status}: ${body.slice(0, 200)}`)
    }
  } catch (err: any) {
    console.error('[post-run.email] threw', err?.message)
  }
}
// Minimal emails4agents sender (global rule #7). Pulled out of post-run/email.ts
// because Phase 07-C needs it from auth too. Returns true on 2xx, false otherwise
// (never throws — magic-link path tolerates email outages, see request-link
// always-200 enumeration policy).

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  const apiKey = process.env.E4A_API_KEY;
  const baseUrl = process.env.E4A_BASE_URL || 'https://api.emails4agents.com';
  const inboxId = process.env.E4A_INBOX_ID;
  if (!apiKey || !inboxId) {
    console.warn(`[email] E4A env not configured; would have emailed ${input.to} subject=${JSON.stringify(input.subject)}`);
    return false;
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ from_inbox_id: inboxId, to: input.to, subject: input.subject, html: input.html, text: input.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[email] send failed ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[email] threw', err?.message);
    return false;
  }
}

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n -C 12 \"aggregatorReport|fireWithContext\\(|onAggregate|finalizeAggregate|parentFireId\" hub/src/scheduler/post-run/aggregator.ts hub/src/scheduler/post-run/dispatcher.ts hub/src/scheduler/dispatcher.ts hub/src/scheduler" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n "email_summary|parent_fire_id|parentFireId|target_kind" hub/src/db/scheduled-tasks-dal.ts hub/src/scheduler/dispatcher.ts hub/src/scheduler/post-run/aggregator.ts | Select-Object -First 250' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/index.ts'; "'$l=Get-Content $p; for($i=790;$i -le 835;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; rg -n "healSpawnTimeoutMs|REMO_HEAL_SPAWN|SPAWN_TIMEOUT" hub/src/heal/config.ts hub/test' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git diff HEAD''^ HEAD --check; bun test hub/test/heal-owner-email-outbox.test.ts' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 697ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/scheduler/post-run/dispatcher.ts-19-import { getTaskById } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-20-import { parseControllerDecision, nextStepForAction } from '../controller-schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-21-import { parseQcFindings, findingHash } from '../qc-schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-22-import { isTerminalSummary } from '../summary-line.ts'
hub/src/scheduler/post-run/dispatcher.ts-23-import { hasVerifiedFinding, recordVerifiedFinding } from '../../db/dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-24-import { findQcReviewSnippetForRun, getRun } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-25-import { executeEmail } from './email.ts'
hub/src/scheduler/post-run/dispatcher.ts-26-import { executeTelegram } from './telegram.ts'
hub/src/scheduler/post-run/dispatcher.ts-27-import { executeWebPush } from './webpush.ts'
hub/src/scheduler/post-run/dispatcher.ts-28-import { executeWebhook } from './webhook.ts'
hub/src/scheduler/post-run/dispatcher.ts-29-import { executeGithubIssue } from './github-issue.ts'
hub/src/scheduler/post-run/dispatcher.ts-30-import { executeDeployVerify } from './deploy-verify.ts'
hub/src/scheduler/post-run/dispatcher.ts:31:import { report as aggregatorReport } from './aggregator.ts'
hub/src/scheduler/post-run/dispatcher.ts-32-import { surfaceProposal } from './propose-notify.ts'
hub/src/scheduler/post-run/dispatcher.ts-33-import { reportSelfErrorToAgentautofix, reportTriageFindingToAgentautofix, scrub } from '../../agentautofix/reporter.ts'
hub/src/scheduler/post-run/dispatcher.ts-34-import { INTERNAL_TRIAGE_TASK_NAME, claimTriageFindingForward } from '../../db/dal.ts'
hub/src/scheduler/post-run/dispatcher.ts-35-import { parseTriageOutput, type TriageResult } from '../triage-schema.ts'
hub/src/scheduler/post-run/dispatcher.ts-36-
hub/src/scheduler/post-run/dispatcher.ts-37-const MAX_CHAIN_DEPTH = 5
hub/src/scheduler/post-run/dispatcher.ts-38-const RUN_URL_PREFIX = process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'
hub/src/scheduler/post-run/dispatcher.ts-39-
hub/src/scheduler/post-run/dispatcher.ts-40-const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
hub/src/scheduler/post-run/dispatcher.ts-41-
hub/src/scheduler/post-run/dispatcher.ts-42-/**
hub/src/scheduler/post-run/dispatcher.ts-43- * feat/scheduled-default-email-summary — synthesize a default run-summary email.
--
hub/src/scheduler/post-run/dispatcher.ts-151-  for (const t of pendingTimers) clearTimeout(t)
hub/src/scheduler/post-run/dispatcher.ts-152-  pendingTimers.clear()
hub/src/scheduler/post-run/dispatcher.ts-153-}
hub/src/scheduler/post-run/dispatcher.ts-154-
hub/src/scheduler/post-run/dispatcher.ts-155-interface AfterRunArgs {
hub/src/scheduler/post-run/dispatcher.ts-156-  task: ScheduledTask
hub/src/scheduler/post-run/dispatcher.ts-157-  runId: string
hub/src/scheduler/post-run/dispatcher.ts-158-  status: RunStatus
hub/src/scheduler/post-run/dispatcher.ts-159-  error: string | null
hub/src/scheduler/post-run/dispatcher.ts-160-  cost_usd: number | null
hub/src/scheduler/post-run/dispatcher.ts-161-  duration_ms: number | null
hub/src/scheduler/post-run/dispatcher.ts-162-  output_snippet: string | null
hub/src/scheduler/post-run/dispatcher.ts:163:  parentFireId: string | null
hub/src/scheduler/post-run/dispatcher.ts-164-  chainDepth: number
hub/src/scheduler/post-run/dispatcher.ts-165-  /** PTYCAP-07-08: set only when the heal path owns the failure notification. */
hub/src/scheduler/post-run/dispatcher.ts-166-  suppressDefaultFailureEmail?: boolean
hub/src/scheduler/post-run/dispatcher.ts-167-}
hub/src/scheduler/post-run/dispatcher.ts-168-
hub/src/scheduler/post-run/dispatcher.ts-169-export async function afterRun(args: AfterRunArgs): Promise<void> {
hub/src/scheduler/post-run/dispatcher.ts:170:  if (args.parentFireId) {
hub/src/scheduler/post-run/dispatcher.ts:171:    await aggregatorReport(
hub/src/scheduler/post-run/dispatcher.ts:172:      args.parentFireId,
hub/src/scheduler/post-run/dispatcher.ts-173-      args.task,
hub/src/scheduler/post-run/dispatcher.ts-174-      { status: args.status, error: args.error },
hub/src/scheduler/post-run/dispatcher.ts-175-      {
hub/src/scheduler/post-run/dispatcher.ts-176-        cost_usd: args.cost_usd,
hub/src/scheduler/post-run/dispatcher.ts-177-        duration_ms: args.duration_ms,
hub/src/scheduler/post-run/dispatcher.ts-178-        output_snippet: args.output_snippet,
hub/src/scheduler/post-run/dispatcher.ts-179-      },
hub/src/scheduler/post-run/dispatcher.ts-180-    )
hub/src/scheduler/post-run/dispatcher.ts-181-    return
hub/src/scheduler/post-run/dispatcher.ts-182-  }
hub/src/scheduler/post-run/dispatcher.ts:183:  await fireWithContext(args)
hub/src/scheduler/post-run/dispatcher.ts-184-}
hub/src/scheduler/post-run/dispatcher.ts-185-
hub/src/scheduler/post-run/dispatcher.ts-186-interface FireCtxArgs extends AfterRunArgs {
hub/src/scheduler/post-run/dispatcher.ts-187-  aggregate?: { total: number; successes: number; failures: number }
hub/src/scheduler/post-run/dispatcher.ts-188-}
hub/src/scheduler/post-run/dispatcher.ts-189-
hub/src/scheduler/post-run/dispatcher.ts-190-/**
hub/src/scheduler/post-run/dispatcher.ts-191- * Resolve the REAL Coolify `deployment_uuid` a `__internal_triage` run was
hub/src/scheduler/post-run/dispatcher.ts-192- * dispatched for. The webhook (api/coolify-webhook.ts) dispatches triage with
hub/src/scheduler/post-run/dispatcher.ts-193- * `triggeredByRunId` = the deployment metadata run, which `insertDeploymentRun`
hub/src/scheduler/post-run/dispatcher.ts-194- * stamps with `deployment_uuid`; the triage run row itself normally carries none.
hub/src/scheduler/post-run/dispatcher.ts-195- * (The per-event `payloadOverride` lives only on the in-memory task and is gone
--
hub/src/scheduler/post-run/dispatcher.ts-299-    } as PostRunAction,
hub/src/scheduler/post-run/dispatcher.ts-300-    { userId: args.task.user_id, templateVars: {} },
hub/src/scheduler/post-run/dispatcher.ts-301-  )
hub/src/scheduler/post-run/dispatcher.ts-302-}
hub/src/scheduler/post-run/dispatcher.ts-303-
hub/src/scheduler/post-run/dispatcher.ts-304-/** True when the default failure email would be built for a failed root run of this task. */
hub/src/scheduler/post-run/dispatcher.ts-305-export async function defaultFailureEmailApplies(task: ScheduledTask): Promise<boolean> {
hub/src/scheduler/post-run/dispatcher.ts-306-  const parsed = validatePostRunActions(await listActionsForTask(task.id))
hub/src/scheduler/post-run/dispatcher.ts-307-  if (!parsed.ok) return false // fireWithContext returns before any action when the set is invalid
hub/src/scheduler/post-run/dispatcher.ts-308-  return buildDefaultEmailActions(task, 0, parsed.value, { status: 'failed', output_snippet: null }).length > 0
hub/src/scheduler/post-run/dispatcher.ts-309-}
hub/src/scheduler/post-run/dispatcher.ts-310-
hub/src/scheduler/post-run/dispatcher.ts:311:export async function fireWithContext(args: FireCtxArgs): Promise<void> {
hub/src/scheduler/post-run/dispatcher.ts-312-  // Awaited (errors contained) so the AAF forward + fallback email finish inside the
hub/src/scheduler/post-run/dispatcher.ts-313-  // post-run lifecycle instead of being orphaned when the caller releases.
hub/src/scheduler/post-run/dispatcher.ts-314-  await handleInternalTriageRun(args).catch((err: any) => {
hub/src/scheduler/post-run/dispatcher.ts-315-    console.error('[post-run.dispatcher] internal triage handling failed', err?.message ?? err)
hub/src/scheduler/post-run/dispatcher.ts-316-  })
hub/src/scheduler/post-run/dispatcher.ts-317-  const actionsRaw = await listActionsForTask(args.task.id)
hub/src/scheduler/post-run/dispatcher.ts-318-  const parsed = validatePostRunActions(actionsRaw)
hub/src/scheduler/post-run/dispatcher.ts-319-  if (!parsed.ok) {
hub/src/scheduler/post-run/dispatcher.ts-320-    console.warn(
hub/src/scheduler/post-run/dispatcher.ts-321-      `[post-run.dispatcher] task=${args.task.id} actions invalid: ${parsed.errors.join('; ')}`,
hub/src/scheduler/post-run/dispatcher.ts-322-    )
hub/src/scheduler/post-run/dispatcher.ts-323-    return
--
hub/src/scheduler/post-run/aggregator.ts-25-  userId: string
hub/src/scheduler/post-run/aggregator.ts-26-  expected: number
hub/src/scheduler/post-run/aggregator.ts-27-  results: ChildResult[]
hub/src/scheduler/post-run/aggregator.ts-28-  createdAt: number
hub/src/scheduler/post-run/aggregator.ts-29-  fired: boolean
hub/src/scheduler/post-run/aggregator.ts-30-}
hub/src/scheduler/post-run/aggregator.ts-31-
hub/src/scheduler/post-run/aggregator.ts-32-const buckets = new Map<string, Bucket>()
hub/src/scheduler/post-run/aggregator.ts-33-const BUCKET_TIMEOUT_MS = 5 * 60 * 1000
hub/src/scheduler/post-run/aggregator.ts-34-const SWEEP_INTERVAL_MS = 30_000
hub/src/scheduler/post-run/aggregator.ts-35-
hub/src/scheduler/post-run/aggregator.ts-36-export function register(
hub/src/scheduler/post-run/aggregator.ts:37:  parentFireId: string, taskId: string, userId: string, expected: number,
hub/src/scheduler/post-run/aggregator.ts-38-): void {
hub/src/scheduler/post-run/aggregator.ts:39:  buckets.set(parentFireId, {
hub/src/scheduler/post-run/aggregator.ts-40-    taskId, userId, expected, results: [], createdAt: Date.now(), fired: false,
hub/src/scheduler/post-run/aggregator.ts-41-  })
hub/src/scheduler/post-run/aggregator.ts-42-}
hub/src/scheduler/post-run/aggregator.ts-43-
hub/src/scheduler/post-run/aggregator.ts-44-export async function report(
hub/src/scheduler/post-run/aggregator.ts:45:  parentFireId: string,
hub/src/scheduler/post-run/aggregator.ts-46-  task: ScheduledTask,
hub/src/scheduler/post-run/aggregator.ts-47-  result: ChildResult,
hub/src/scheduler/post-run/aggregator.ts-48-  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
hub/src/scheduler/post-run/aggregator.ts-49-): Promise<void> {
hub/src/scheduler/post-run/aggregator.ts:50:  const b = buckets.get(parentFireId)
hub/src/scheduler/post-run/aggregator.ts-51-  if (!b || b.fired) return
hub/src/scheduler/post-run/aggregator.ts-52-  b.results.push(result)
hub/src/scheduler/post-run/aggregator.ts-53-  if (b.results.length >= b.expected) {
hub/src/scheduler/post-run/aggregator.ts:54:    await fireAggregate(parentFireId, b, task, extra)
hub/src/scheduler/post-run/aggregator.ts-55-  }
hub/src/scheduler/post-run/aggregator.ts-56-}
hub/src/scheduler/post-run/aggregator.ts-57-
hub/src/scheduler/post-run/aggregator.ts-58-function aggregateStatus(results: ChildResult[]): RunStatus {
hub/src/scheduler/post-run/aggregator.ts-59-  if (results.length === 0) return 'failed'
hub/src/scheduler/post-run/aggregator.ts-60-  const successes = results.filter((r) => r.status === 'success').length
hub/src/scheduler/post-run/aggregator.ts-61-  if (successes === results.length) return 'success'
hub/src/scheduler/post-run/aggregator.ts-62-  return 'failed'
hub/src/scheduler/post-run/aggregator.ts-63-}
hub/src/scheduler/post-run/aggregator.ts-64-
hub/src/scheduler/post-run/aggregator.ts-65-async function fireAggregate(
hub/src/scheduler/post-run/aggregator.ts:66:  parentFireId: string, b: Bucket, task: ScheduledTask,
hub/src/scheduler/post-run/aggregator.ts-67-  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
hub/src/scheduler/post-run/aggregator.ts-68-): Promise<void> {
hub/src/scheduler/post-run/aggregator.ts-69-  b.fired = true
hub/src/scheduler/post-run/aggregator.ts:70:  buckets.delete(parentFireId)
hub/src/scheduler/post-run/aggregator.ts-71-  const status = aggregateStatus(b.results)
hub/src/scheduler/post-run/aggregator.ts-72-  const successes = b.results.filter((r) => r.status === 'success').length
hub/src/scheduler/post-run/aggregator.ts-73-  const failures = b.results.filter((r) => r.status === 'failed').length
hub/src/scheduler/post-run/aggregator.ts-74-  try {
hub/src/scheduler/post-run/aggregator.ts-75-    const { fireWithContext } = await import('./dispatcher.ts')
hub/src/scheduler/post-run/aggregator.ts:76:    await fireWithContext({
hub/src/scheduler/post-run/aggregator.ts-77-      task,
hub/src/scheduler/post-run/aggregator.ts:78:      runId: parentFireId,
hub/src/scheduler/post-run/aggregator.ts-79-      status,
hub/src/scheduler/post-run/aggregator.ts-80-      error: failures > 0 ? `aggregate: ${failures}/${b.results.length} children failed` : null,
hub/src/scheduler/post-run/aggregator.ts-81-      cost_usd: extra.cost_usd,
hub/src/scheduler/post-run/aggregator.ts-82-      duration_ms: extra.duration_ms,
hub/src/scheduler/post-run/aggregator.ts-83-      output_snippet: extra.output_snippet,
hub/src/scheduler/post-run/aggregator.ts:84:      parentFireId: null,
hub/src/scheduler/post-run/aggregator.ts-85-      chainDepth: 0,
hub/src/scheduler/post-run/aggregator.ts-86-      aggregate: { total: b.results.length, successes, failures },
hub/src/scheduler/post-run/aggregator.ts-87-    })
hub/src/scheduler/post-run/aggregator.ts-88-  } catch (err: any) {
hub/src/scheduler/post-run/aggregator.ts-89-    console.error(`[aggregator] fire failed task=${task.id}: ${err?.message}`)
hub/src/scheduler/post-run/aggregator.ts-90-  }
hub/src/scheduler/post-run/aggregator.ts-91-}
hub/src/scheduler/post-run/aggregator.ts-92-
hub/src/scheduler/post-run/aggregator.ts-93-setInterval(async () => {
hub/src/scheduler/post-run/aggregator.ts-94-  const now = Date.now()
hub/src/scheduler/post-run/aggregator.ts-95-  for (const [pid, b] of buckets) {
hub/src/scheduler/post-run/aggregator.ts-96-    if (b.fired) continue
--
hub/src/scheduler/dispatcher.ts-28-import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget.ts'
hub/src/scheduler/dispatcher.ts-29-import { checkUserThreshold } from '../usage/threshold.ts'
hub/src/scheduler/dispatcher.ts-30-import { log } from '../observability/logger'
hub/src/scheduler/dispatcher.ts-31-
hub/src/scheduler/dispatcher.ts-32-const MAX_CHAIN_DEPTH = 5
hub/src/scheduler/dispatcher.ts-33-
hub/src/scheduler/dispatcher.ts-34-interface RunContext {
hub/src/scheduler/dispatcher.ts-35-  runId: string
hub/src/scheduler/dispatcher.ts-36-  taskId: string
hub/src/scheduler/dispatcher.ts-37-  userId: string
hub/src/scheduler/dispatcher.ts-38-  target: ResolvedTarget
hub/src/scheduler/dispatcher.ts-39-  startedAt: number
hub/src/scheduler/dispatcher.ts:40:  parentFireId?: string | null
hub/src/scheduler/dispatcher.ts-41-  chainDepth: number
hub/src/scheduler/dispatcher.ts-42-  triggeredByRunId?: string | null
hub/src/scheduler/dispatcher.ts-43-  /** Manual ("run now") dispatch — the agent sender fails fast on offline. */
hub/src/scheduler/dispatcher.ts-44-  isManual?: boolean
hub/src/scheduler/dispatcher.ts-45-  /** True only when THIS fire won claimOnceTask; senders re-arm a halted once-task only then. */
hub/src/scheduler/dispatcher.ts-46-  onceClaimed?: boolean
hub/src/scheduler/dispatcher.ts-47-  /**
hub/src/scheduler/dispatcher.ts-48-   * Per-run cost accrual (fix/run-cost-attribution). `scheduled_task_runs
hub/src/scheduler/dispatcher.ts-49-   * .cost_usd` was NULL on 100% of rows — no caller of `finalizeRun` ever
hub/src/scheduler/dispatcher.ts-50-   * supplied it. Session-targeted runs (`target.sessionId` set) DO incur LLM
hub/src/scheduler/dispatcher.ts-51-   * cost, reported by the supervisor as `usage_event` messages on the SAME
hub/src/scheduler/dispatcher.ts-52-   * agent socket while the run is in flight (`ws/agent.ts` records them into
--
hub/src/scheduler/dispatcher.ts-341-      status: 'pending',
hub/src/scheduler/dispatcher.ts-342-      scheduled_for: now,
hub/src/scheduler/dispatcher.ts-343-      target_kind: 'session',
hub/src/scheduler/dispatcher.ts-344-      target_id: null,
hub/src/scheduler/dispatcher.ts-345-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-346-    })
hub/src/scheduler/dispatcher.ts-347-    const ctx: NewRunContext = {
hub/src/scheduler/dispatcher.ts-348-      runId: run.id,
hub/src/scheduler/dispatcher.ts-349-      taskId: task.id,
hub/src/scheduler/dispatcher.ts-350-      userId,
hub/src/scheduler/dispatcher.ts-351-      target: { kind: 'session', sessionId: null, online: true },
hub/src/scheduler/dispatcher.ts-352-      startedAt: now.getTime(),
hub/src/scheduler/dispatcher.ts:353:      parentFireId: null,
hub/src/scheduler/dispatcher.ts-354-      chainDepth: opts.chainDepth,
hub/src/scheduler/dispatcher.ts-355-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-356-    }
hub/src/scheduler/dispatcher.ts-357-    trackRun(ctx)
hub/src/scheduler/dispatcher.ts-358-    broadcastScheduledRun(userId, {
hub/src/scheduler/dispatcher.ts-359-      type: 'scheduled_run_started',
hub/src/scheduler/dispatcher.ts-360-      run_id: run.id,
hub/src/scheduler/dispatcher.ts-361-      task_id: task.id,
hub/src/scheduler/dispatcher.ts-362-      scheduled_for: now.toISOString(),
hub/src/scheduler/dispatcher.ts-363-      target_kind: 'session',
hub/src/scheduler/dispatcher.ts-364-      target_id: null,
hub/src/scheduler/dispatcher.ts-365-    })
--
hub/src/scheduler/dispatcher.ts-390-      status: 'pending',
hub/src/scheduler/dispatcher.ts-391-      scheduled_for: now,
hub/src/scheduler/dispatcher.ts-392-      target_kind: 'supervisor',
hub/src/scheduler/dispatcher.ts-393-      target_id: null,
hub/src/scheduler/dispatcher.ts-394-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-395-    })
hub/src/scheduler/dispatcher.ts-396-    const ctx: NewRunContext = {
hub/src/scheduler/dispatcher.ts-397-      runId: run.id,
hub/src/scheduler/dispatcher.ts-398-      taskId: task.id,
hub/src/scheduler/dispatcher.ts-399-      userId,
hub/src/scheduler/dispatcher.ts-400-      target: { kind: 'supervisor', online: true },
hub/src/scheduler/dispatcher.ts-401-      startedAt: now.getTime(),
hub/src/scheduler/dispatcher.ts:402:      parentFireId: null,
hub/src/scheduler/dispatcher.ts-403-      chainDepth: opts.chainDepth,
hub/src/scheduler/dispatcher.ts-404-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-405-      isManual,
hub/src/scheduler/dispatcher.ts-406-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler/dispatcher.ts-407-    }
hub/src/scheduler/dispatcher.ts-408-    trackRun(ctx)
hub/src/scheduler/dispatcher.ts-409-    broadcastScheduledRun(userId, {
hub/src/scheduler/dispatcher.ts-410-      type: 'scheduled_run_started',
hub/src/scheduler/dispatcher.ts-411-      run_id: run.id,
hub/src/scheduler/dispatcher.ts-412-      task_id: task.id,
hub/src/scheduler/dispatcher.ts-413-      scheduled_for: now.toISOString(),
hub/src/scheduler/dispatcher.ts-414-      target_kind: 'supervisor',
--
hub/src/scheduler/dispatcher.ts-444-      scheduled_for: now,
hub/src/scheduler/dispatcher.ts-445-      target_kind: 'session',
hub/src/scheduler/dispatcher.ts-446-      target_id: (task.payload?.work_session_id as string) ?? null,
hub/src/scheduler/dispatcher.ts-447-      session_id: (task.payload?.work_session_id as string) ?? null,
hub/src/scheduler/dispatcher.ts-448-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-449-    })
hub/src/scheduler/dispatcher.ts-450-    const ctx: NewRunContext = {
hub/src/scheduler/dispatcher.ts-451-      runId: run.id,
hub/src/scheduler/dispatcher.ts-452-      taskId: task.id,
hub/src/scheduler/dispatcher.ts-453-      userId,
hub/src/scheduler/dispatcher.ts-454-      target: { kind: 'session', sessionId: (task.payload?.work_session_id as string) ?? null, online: true },
hub/src/scheduler/dispatcher.ts-455-      startedAt: now.getTime(),
hub/src/scheduler/dispatcher.ts:456:      parentFireId: null,
hub/src/scheduler/dispatcher.ts-457-      chainDepth: opts.chainDepth,
hub/src/scheduler/dispatcher.ts-458-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-459-      isManual,
hub/src/scheduler/dispatcher.ts-460-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler/dispatcher.ts-461-    }
hub/src/scheduler/dispatcher.ts-462-    trackRun(ctx)
hub/src/scheduler/dispatcher.ts-463-    broadcastScheduledRun(userId, {
hub/src/scheduler/dispatcher.ts-464-      type: 'scheduled_run_started',
hub/src/scheduler/dispatcher.ts-465-      run_id: run.id,
hub/src/scheduler/dispatcher.ts-466-      task_id: task.id,
hub/src/scheduler/dispatcher.ts-467-      scheduled_for: now.toISOString(),
hub/src/scheduler/dispatcher.ts-468-      target_kind: 'session',
--
hub/src/scheduler/dispatcher.ts-497-    broadcastScheduledRun(userId, {
hub/src/scheduler/dispatcher.ts-498-      type: 'scheduled_run_finished',
hub/src/scheduler/dispatcher.ts-499-      run_id: run.id, task_id: task.id, status: 'failed',
hub/src/scheduler/dispatcher.ts-500-      error: isManual ? 'target_offline' : 'no_targets',
hub/src/scheduler/dispatcher.ts-501-    })
hub/src/scheduler/dispatcher.ts-502-    void onRunFinalized(task, run.id, 'failed', isManual ? 'target_offline' : 'no_targets')
hub/src/scheduler/dispatcher.ts-503-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler/dispatcher.ts-504-    runIds.push(run.id)
hub/src/scheduler/dispatcher.ts-505-    return { runIds }
hub/src/scheduler/dispatcher.ts-506-  }
hub/src/scheduler/dispatcher.ts-507-
hub/src/scheduler/dispatcher.ts-508-  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
hub/src/scheduler/dispatcher.ts:509:  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null
hub/src/scheduler/dispatcher.ts-510-
hub/src/scheduler/dispatcher.ts-511-  if (isFanOut) {
hub/src/scheduler/dispatcher.ts-512-    try {
hub/src/scheduler/dispatcher.ts-513-      const { register: aggRegister } = await import('./post-run/aggregator.ts')
hub/src/scheduler/dispatcher.ts:514:      aggRegister(parentFireId!, task.id, userId, targets.length)
hub/src/scheduler/dispatcher.ts-515-    } catch (err: any) {
hub/src/scheduler/dispatcher.ts-516-      log.error('scheduler.dispatcher.aggregator_register_failed', { task_id: task.id, error: err?.message })
hub/src/scheduler/dispatcher.ts-517-    }
hub/src/scheduler/dispatcher.ts-518-  }
hub/src/scheduler/dispatcher.ts-519-
hub/src/scheduler/dispatcher.ts-520-  for (const target of targets) {
hub/src/scheduler/dispatcher.ts-521-    const run = await insertRunV2({
hub/src/scheduler/dispatcher.ts-522-      task_id: task.id,
hub/src/scheduler/dispatcher.ts-523-      user_id: userId,
hub/src/scheduler/dispatcher.ts-524-      status: 'pending',
hub/src/scheduler/dispatcher.ts-525-      scheduled_for: now,
hub/src/scheduler/dispatcher.ts-526-      target_kind: target.kind,
hub/src/scheduler/dispatcher.ts-527-      target_id: target.sessionId ?? target.supervisorId ?? null,
hub/src/scheduler/dispatcher.ts-528-      session_id: target.sessionId ?? null,
hub/src/scheduler/dispatcher.ts-529-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-530-    })
hub/src/scheduler/dispatcher.ts-531-
hub/src/scheduler/dispatcher.ts-532-    const ctx: NewRunContext = {
hub/src/scheduler/dispatcher.ts-533-      runId: run.id,
hub/src/scheduler/dispatcher.ts-534-      taskId: task.id,
hub/src/scheduler/dispatcher.ts-535-      userId,
hub/src/scheduler/dispatcher.ts-536-      target,
hub/src/scheduler/dispatcher.ts-537-      startedAt: now.getTime(),
hub/src/scheduler/dispatcher.ts:538:      parentFireId,
hub/src/scheduler/dispatcher.ts-539-      chainDepth: opts.chainDepth,
hub/src/scheduler/dispatcher.ts-540-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler/dispatcher.ts-541-      isManual,
hub/src/scheduler/dispatcher.ts-542-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler/dispatcher.ts-543-    }
hub/src/scheduler/dispatcher.ts-544-    trackRun(ctx)
hub/src/scheduler/dispatcher.ts-545-    runIds.push(run.id)
hub/src/scheduler/dispatcher.ts-546-
hub/src/scheduler/dispatcher.ts-547-    broadcastScheduledRun(userId, {
hub/src/scheduler/dispatcher.ts-548-      type: 'scheduled_run_started',
hub/src/scheduler/dispatcher.ts-549-      run_id: run.id,
hub/src/scheduler/dispatcher.ts-550-      task_id: task.id,
--
hub/src/scheduler/dispatcher.ts-807-    ? await getTaskById(ctx.taskId)
hub/src/scheduler/dispatcher.ts-808-    : updated?.task_id ? await getTaskById(updated.task_id) : null
hub/src/scheduler/dispatcher.ts-809-  if (task) {
hub/src/scheduler/dispatcher.ts-810-    // PTYCAP-07-08 (AM-F5-2): heal hook BETWEEN the terminal UPDATE and post-run processing.
hub/src/scheduler/dispatcher.ts-811-    // Inert (returns false, imports nothing) unless the run failed AND REMO_HEAL_UNIFIED is ON.
hub/src/scheduler/dispatcher.ts-812-    const healOwnsNotification = status === 'failed'
hub/src/scheduler/dispatcher.ts-813-      ? await healFailedRunHook(task, runId, error ?? null)
hub/src/scheduler/dispatcher.ts-814-      : false
hub/src/scheduler/dispatcher.ts-815-    await onRunFinalized(task, runId, status, error ?? null, {
hub/src/scheduler/dispatcher.ts-816-      cost_usd: costUsd,
hub/src/scheduler/dispatcher.ts-817-      duration_ms: dur,
hub/src/scheduler/dispatcher.ts-818-      output_snippet: fields.output_snippet ?? null,
hub/src/scheduler/dispatcher.ts:819:      parentFireId: ctx?.parentFireId ?? null,
hub/src/scheduler/dispatcher.ts-820-      chainDepth: ctx?.chainDepth ?? 0,
hub/src/scheduler/dispatcher.ts-821-      ...(healOwnsNotification ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler/dispatcher.ts-822-    })
hub/src/scheduler/dispatcher.ts-823-  }
hub/src/scheduler/dispatcher.ts-824-}
hub/src/scheduler/dispatcher.ts-825-
hub/src/scheduler/dispatcher.ts-826-/**
hub/src/scheduler/dispatcher.ts-827- * Never throws into finalizeRun. Resolves true only when the heal path claimed and sent the one
hub/src/scheduler/dispatcher.ts-828- * owner notification; any error resolves false so the normal failure email proceeds.
hub/src/scheduler/dispatcher.ts-829- */
hub/src/scheduler/dispatcher.ts-830-async function healFailedRunHook(
hub/src/scheduler/dispatcher.ts-831-  task: ScheduledTask,
--
hub/src/scheduler/dispatcher.ts-847-    }
hub/src/scheduler/dispatcher.ts-848-    return healOwns
hub/src/scheduler/dispatcher.ts-849-  } catch (err: any) {
hub/src/scheduler/dispatcher.ts-850-    log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler/dispatcher.ts-851-    return false
hub/src/scheduler/dispatcher.ts-852-  }
hub/src/scheduler/dispatcher.ts-853-}
hub/src/scheduler/dispatcher.ts-854-
hub/src/scheduler/dispatcher.ts-855-interface PostRunPayload {
hub/src/scheduler/dispatcher.ts-856-  cost_usd: number | null
hub/src/scheduler/dispatcher.ts-857-  duration_ms: number | null
hub/src/scheduler/dispatcher.ts-858-  output_snippet: string | null
hub/src/scheduler/dispatcher.ts:859:  parentFireId?: string | null
hub/src/scheduler/dispatcher.ts-860-  chainDepth: number
hub/src/scheduler/dispatcher.ts-861-  /** PTYCAP-07-08: the heal path already notified the owner of this failure. */
hub/src/scheduler/dispatcher.ts-862-  suppressDefaultFailureEmail?: boolean
hub/src/scheduler/dispatcher.ts-863-}
hub/src/scheduler/dispatcher.ts-864-
hub/src/scheduler/dispatcher.ts-865-async function onRunFinalized(
hub/src/scheduler/dispatcher.ts-866-  task: ScheduledTask,
hub/src/scheduler/dispatcher.ts-867-  runId: string,
hub/src/scheduler/dispatcher.ts-868-  status: RunStatus,
hub/src/scheduler/dispatcher.ts-869-  error: string | null,
hub/src/scheduler/dispatcher.ts-870-  extra: PostRunPayload = { cost_usd: null, duration_ms: null, output_snippet: null, chainDepth: 0 },
hub/src/scheduler/dispatcher.ts-871-): Promise<void> {
hub/src/scheduler/dispatcher.ts-872-  try {
hub/src/scheduler/dispatcher.ts-873-    const { afterRun } = await import('./post-run/dispatcher.ts')
hub/src/scheduler/dispatcher.ts-874-    await afterRun({
hub/src/scheduler/dispatcher.ts-875-      task,
hub/src/scheduler/dispatcher.ts-876-      runId,
hub/src/scheduler/dispatcher.ts-877-      status,
hub/src/scheduler/dispatcher.ts-878-      error,
hub/src/scheduler/dispatcher.ts-879-      cost_usd: extra.cost_usd,
hub/src/scheduler/dispatcher.ts-880-      duration_ms: extra.duration_ms,
hub/src/scheduler/dispatcher.ts-881-      output_snippet: extra.output_snippet,
hub/src/scheduler/dispatcher.ts:882:      parentFireId: extra.parentFireId ?? null,
hub/src/scheduler/dispatcher.ts-883-      chainDepth: extra.chainDepth,
hub/src/scheduler/dispatcher.ts-884-      ...(extra.suppressDefaultFailureEmail ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler/dispatcher.ts-885-    })
hub/src/scheduler/dispatcher.ts-886-  } catch (err: any) {
hub/src/scheduler/dispatcher.ts-887-    log.error('scheduler.dispatcher.post_run_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler/dispatcher.ts-888-  }
hub/src/scheduler/dispatcher.ts-889-}
hub/src/scheduler/dispatcher.ts-890-
hub/src/scheduler/dispatcher.ts-891-export async function cancelRun(runId: string, userId: string): Promise<boolean> {
hub/src/scheduler/dispatcher.ts-892-  const ctx = inFlightByRun.get(runId)
hub/src/scheduler/dispatcher.ts-893-  if (ctx && ctx.userId !== userId) return false
hub/src/scheduler/dispatcher.ts-894-  if (ctx?.target?.agentSocket) {
--
hub/src/scheduler\dispatcher.ts-28-import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget.ts'
hub/src/scheduler\dispatcher.ts-29-import { checkUserThreshold } from '../usage/threshold.ts'
hub/src/scheduler\dispatcher.ts-30-import { log } from '../observability/logger'
hub/src/scheduler\dispatcher.ts-31-
hub/src/scheduler\dispatcher.ts-32-const MAX_CHAIN_DEPTH = 5
hub/src/scheduler\dispatcher.ts-33-
hub/src/scheduler\dispatcher.ts-34-interface RunContext {
hub/src/scheduler\dispatcher.ts-35-  runId: string
hub/src/scheduler\dispatcher.ts-36-  taskId: string
hub/src/scheduler\dispatcher.ts-37-  userId: string
hub/src/scheduler\dispatcher.ts-38-  target: ResolvedTarget
hub/src/scheduler\dispatcher.ts-39-  startedAt: number
hub/src/scheduler\dispatcher.ts:40:  parentFireId?: string | null
hub/src/scheduler\dispatcher.ts-41-  chainDepth: number
hub/src/scheduler\dispatcher.ts-42-  triggeredByRunId?: string | null
hub/src/scheduler\dispatcher.ts-43-  /** Manual ("run now") dispatch — the agent sender fails fast on offline. */
hub/src/scheduler\dispatcher.ts-44-  isManual?: boolean
hub/src/scheduler\dispatcher.ts-45-  /** True only when THIS fire won claimOnceTask; senders re-arm a halted once-task only then. */
hub/src/scheduler\dispatcher.ts-46-  onceClaimed?: boolean
hub/src/scheduler\dispatcher.ts-47-  /**
hub/src/scheduler\dispatcher.ts-48-   * Per-run cost accrual (fix/run-cost-attribution). `scheduled_task_runs
hub/src/scheduler\dispatcher.ts-49-   * .cost_usd` was NULL on 100% of rows — no caller of `finalizeRun` ever
hub/src/scheduler\dispatcher.ts-50-   * supplied it. Session-targeted runs (`target.sessionId` set) DO incur LLM
hub/src/scheduler\dispatcher.ts-51-   * cost, reported by the supervisor as `usage_event` messages on the SAME
hub/src/scheduler\dispatcher.ts-52-   * agent socket while the run is in flight (`ws/agent.ts` records them into
--
hub/src/scheduler\dispatcher.ts-341-      status: 'pending',
hub/src/scheduler\dispatcher.ts-342-      scheduled_for: now,
hub/src/scheduler\dispatcher.ts-343-      target_kind: 'session',
hub/src/scheduler\dispatcher.ts-344-      target_id: null,
hub/src/scheduler\dispatcher.ts-345-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-346-    })
hub/src/scheduler\dispatcher.ts-347-    const ctx: NewRunContext = {
hub/src/scheduler\dispatcher.ts-348-      runId: run.id,
hub/src/scheduler\dispatcher.ts-349-      taskId: task.id,
hub/src/scheduler\dispatcher.ts-350-      userId,
hub/src/scheduler\dispatcher.ts-351-      target: { kind: 'session', sessionId: null, online: true },
hub/src/scheduler\dispatcher.ts-352-      startedAt: now.getTime(),
hub/src/scheduler\dispatcher.ts:353:      parentFireId: null,
hub/src/scheduler\dispatcher.ts-354-      chainDepth: opts.chainDepth,
hub/src/scheduler\dispatcher.ts-355-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-356-    }
hub/src/scheduler\dispatcher.ts-357-    trackRun(ctx)
hub/src/scheduler\dispatcher.ts-358-    broadcastScheduledRun(userId, {
hub/src/scheduler\dispatcher.ts-359-      type: 'scheduled_run_started',
hub/src/scheduler\dispatcher.ts-360-      run_id: run.id,
hub/src/scheduler\dispatcher.ts-361-      task_id: task.id,
hub/src/scheduler\dispatcher.ts-362-      scheduled_for: now.toISOString(),
hub/src/scheduler\dispatcher.ts-363-      target_kind: 'session',
hub/src/scheduler\dispatcher.ts-364-      target_id: null,
hub/src/scheduler\dispatcher.ts-365-    })
--
hub/src/scheduler\dispatcher.ts-390-      status: 'pending',
hub/src/scheduler\dispatcher.ts-391-      scheduled_for: now,
hub/src/scheduler\dispatcher.ts-392-      target_kind: 'supervisor',
hub/src/scheduler\dispatcher.ts-393-      target_id: null,
hub/src/scheduler\dispatcher.ts-394-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-395-    })
hub/src/scheduler\dispatcher.ts-396-    const ctx: NewRunContext = {
hub/src/scheduler\dispatcher.ts-397-      runId: run.id,
hub/src/scheduler\dispatcher.ts-398-      taskId: task.id,
hub/src/scheduler\dispatcher.ts-399-      userId,
hub/src/scheduler\dispatcher.ts-400-      target: { kind: 'supervisor', online: true },
hub/src/scheduler\dispatcher.ts-401-      startedAt: now.getTime(),
hub/src/scheduler\dispatcher.ts:402:      parentFireId: null,
hub/src/scheduler\dispatcher.ts-403-      chainDepth: opts.chainDepth,
hub/src/scheduler\dispatcher.ts-404-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-405-      isManual,
hub/src/scheduler\dispatcher.ts-406-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler\dispatcher.ts-407-    }
hub/src/scheduler\dispatcher.ts-408-    trackRun(ctx)
hub/src/scheduler\dispatcher.ts-409-    broadcastScheduledRun(userId, {
hub/src/scheduler\dispatcher.ts-410-      type: 'scheduled_run_started',
hub/src/scheduler\dispatcher.ts-411-      run_id: run.id,
hub/src/scheduler\dispatcher.ts-412-      task_id: task.id,
hub/src/scheduler\dispatcher.ts-413-      scheduled_for: now.toISOString(),
hub/src/scheduler\dispatcher.ts-414-      target_kind: 'supervisor',
--
hub/src/scheduler\dispatcher.ts-444-      scheduled_for: now,
hub/src/scheduler\dispatcher.ts-445-      target_kind: 'session',
hub/src/scheduler\dispatcher.ts-446-      target_id: (task.payload?.work_session_id as string) ?? null,
hub/src/scheduler\dispatcher.ts-447-      session_id: (task.payload?.work_session_id as string) ?? null,
hub/src/scheduler\dispatcher.ts-448-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-449-    })
hub/src/scheduler\dispatcher.ts-450-    const ctx: NewRunContext = {
hub/src/scheduler\dispatcher.ts-451-      runId: run.id,
hub/src/scheduler\dispatcher.ts-452-      taskId: task.id,
hub/src/scheduler\dispatcher.ts-453-      userId,
hub/src/scheduler\dispatcher.ts-454-      target: { kind: 'session', sessionId: (task.payload?.work_session_id as string) ?? null, online: true },
hub/src/scheduler\dispatcher.ts-455-      startedAt: now.getTime(),
hub/src/scheduler\dispatcher.ts:456:      parentFireId: null,
hub/src/scheduler\dispatcher.ts-457-      chainDepth: opts.chainDepth,
hub/src/scheduler\dispatcher.ts-458-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-459-      isManual,
hub/src/scheduler\dispatcher.ts-460-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler\dispatcher.ts-461-    }
hub/src/scheduler\dispatcher.ts-462-    trackRun(ctx)
hub/src/scheduler\dispatcher.ts-463-    broadcastScheduledRun(userId, {
hub/src/scheduler\dispatcher.ts-464-      type: 'scheduled_run_started',
hub/src/scheduler\dispatcher.ts-465-      run_id: run.id,
hub/src/scheduler\dispatcher.ts-466-      task_id: task.id,
hub/src/scheduler\dispatcher.ts-467-      scheduled_for: now.toISOString(),
hub/src/scheduler\dispatcher.ts-468-      target_kind: 'session',
--
hub/src/scheduler\dispatcher.ts-497-    broadcastScheduledRun(userId, {
hub/src/scheduler\dispatcher.ts-498-      type: 'scheduled_run_finished',
hub/src/scheduler\dispatcher.ts-499-      run_id: run.id, task_id: task.id, status: 'failed',
hub/src/scheduler\dispatcher.ts-500-      error: isManual ? 'target_offline' : 'no_targets',
hub/src/scheduler\dispatcher.ts-501-    })
hub/src/scheduler\dispatcher.ts-502-    void onRunFinalized(task, run.id, 'failed', isManual ? 'target_offline' : 'no_targets')
hub/src/scheduler\dispatcher.ts-503-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler\dispatcher.ts-504-    runIds.push(run.id)
hub/src/scheduler\dispatcher.ts-505-    return { runIds }
hub/src/scheduler\dispatcher.ts-506-  }
hub/src/scheduler\dispatcher.ts-507-
hub/src/scheduler\dispatcher.ts-508-  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
hub/src/scheduler\dispatcher.ts:509:  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null
hub/src/scheduler\dispatcher.ts-510-
hub/src/scheduler\dispatcher.ts-511-  if (isFanOut) {
hub/src/scheduler\dispatcher.ts-512-    try {
hub/src/scheduler\dispatcher.ts-513-      const { register: aggRegister } = await import('./post-run/aggregator.ts')
hub/src/scheduler\dispatcher.ts:514:      aggRegister(parentFireId!, task.id, userId, targets.length)
hub/src/scheduler\dispatcher.ts-515-    } catch (err: any) {
hub/src/scheduler\dispatcher.ts-516-      log.error('scheduler.dispatcher.aggregator_register_failed', { task_id: task.id, error: err?.message })
hub/src/scheduler\dispatcher.ts-517-    }
hub/src/scheduler\dispatcher.ts-518-  }
hub/src/scheduler\dispatcher.ts-519-
hub/src/scheduler\dispatcher.ts-520-  for (const target of targets) {
hub/src/scheduler\dispatcher.ts-521-    const run = await insertRunV2({
hub/src/scheduler\dispatcher.ts-522-      task_id: task.id,
hub/src/scheduler\dispatcher.ts-523-      user_id: userId,
hub/src/scheduler\dispatcher.ts-524-      status: 'pending',
hub/src/scheduler\dispatcher.ts-525-      scheduled_for: now,
hub/src/scheduler\dispatcher.ts-526-      target_kind: target.kind,
hub/src/scheduler\dispatcher.ts-527-      target_id: target.sessionId ?? target.supervisorId ?? null,
hub/src/scheduler\dispatcher.ts-528-      session_id: target.sessionId ?? null,
hub/src/scheduler\dispatcher.ts-529-      triggered_by_run_id: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-530-    })
hub/src/scheduler\dispatcher.ts-531-
hub/src/scheduler\dispatcher.ts-532-    const ctx: NewRunContext = {
hub/src/scheduler\dispatcher.ts-533-      runId: run.id,
hub/src/scheduler\dispatcher.ts-534-      taskId: task.id,
hub/src/scheduler\dispatcher.ts-535-      userId,
hub/src/scheduler\dispatcher.ts-536-      target,
hub/src/scheduler\dispatcher.ts-537-      startedAt: now.getTime(),
hub/src/scheduler\dispatcher.ts:538:      parentFireId,
hub/src/scheduler\dispatcher.ts-539-      chainDepth: opts.chainDepth,
hub/src/scheduler\dispatcher.ts-540-      triggeredByRunId: opts.triggeredByRunId ?? null,
hub/src/scheduler\dispatcher.ts-541-      isManual,
hub/src/scheduler\dispatcher.ts-542-      onceClaimed: opts.onceClaimed === true,
hub/src/scheduler\dispatcher.ts-543-    }
hub/src/scheduler\dispatcher.ts-544-    trackRun(ctx)
hub/src/scheduler\dispatcher.ts-545-    runIds.push(run.id)
hub/src/scheduler\dispatcher.ts-546-
hub/src/scheduler\dispatcher.ts-547-    broadcastScheduledRun(userId, {
hub/src/scheduler\dispatcher.ts-548-      type: 'scheduled_run_started',
hub/src/scheduler\dispatcher.ts-549-      run_id: run.id,
hub/src/scheduler\dispatcher.ts-550-      task_id: task.id,
--
hub/src/scheduler\dispatcher.ts-807-    ? await getTaskById(ctx.taskId)
hub/src/scheduler\dispatcher.ts-808-    : updated?.task_id ? await getTaskById(updated.task_id) : null
hub/src/scheduler\dispatcher.ts-809-  if (task) {
hub/src/scheduler\dispatcher.ts-810-    // PTYCAP-07-08 (AM-F5-2): heal hook BETWEEN the terminal UPDATE and post-run processing.
hub/src/scheduler\dispatcher.ts-811-    // Inert (returns false, imports nothing) unless the run failed AND REMO_HEAL_UNIFIED is ON.
hub/src/scheduler\dispatcher.ts-812-    const healOwnsNotification = status === 'failed'
hub/src/scheduler\dispatcher.ts-813-      ? await healFailedRunHook(task, runId, error ?? null)
hub/src/scheduler\dispatcher.ts-814-      : false
hub/src/scheduler\dispatcher.ts-815-    await onRunFinalized(task, runId, status, error ?? null, {
hub/src/scheduler\dispatcher.ts-816-      cost_usd: costUsd,
hub/src/scheduler\dispatcher.ts-817-      duration_ms: dur,
hub/src/scheduler\dispatcher.ts-818-      output_snippet: fields.output_snippet ?? null,
hub/src/scheduler\dispatcher.ts:819:      parentFireId: ctx?.parentFireId ?? null,
hub/src/scheduler\dispatcher.ts-820-      chainDepth: ctx?.chainDepth ?? 0,
hub/src/scheduler\dispatcher.ts-821-      ...(healOwnsNotification ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler\dispatcher.ts-822-    })
hub/src/scheduler\dispatcher.ts-823-  }
hub/src/scheduler\dispatcher.ts-824-}
hub/src/scheduler\dispatcher.ts-825-
hub/src/scheduler\dispatcher.ts-826-/**
hub/src/scheduler\dispatcher.ts-827- * Never throws into finalizeRun. Resolves true only when the heal path claimed and sent the one
hub/src/scheduler\dispatcher.ts-828- * owner notification; any error resolves false so the normal failure email proceeds.
hub/src/scheduler\dispatcher.ts-829- */
hub/src/scheduler\dispatcher.ts-830-async function healFailedRunHook(
hub/src/scheduler\dispatcher.ts-831-  task: ScheduledTask,
--
hub/src/scheduler\dispatcher.ts-847-    }
hub/src/scheduler\dispatcher.ts-848-    return healOwns
hub/src/scheduler\dispatcher.ts-849-  } catch (err: any) {
hub/src/scheduler\dispatcher.ts-850-    log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler\dispatcher.ts-851-    return false
hub/src/scheduler\dispatcher.ts-852-  }
hub/src/scheduler\dispatcher.ts-853-}
hub/src/scheduler\dispatcher.ts-854-
hub/src/scheduler\dispatcher.ts-855-interface PostRunPayload {
hub/src/scheduler\dispatcher.ts-856-  cost_usd: number | null
hub/src/scheduler\dispatcher.ts-857-  duration_ms: number | null
hub/src/scheduler\dispatcher.ts-858-  output_snippet: string | null
hub/src/scheduler\dispatcher.ts:859:  parentFireId?: string | null
hub/src/scheduler\dispatcher.ts-860-  chainDepth: number
hub/src/scheduler\dispatcher.ts-861-  /** PTYCAP-07-08: the heal path already notified the owner of this failure. */
hub/src/scheduler\dispatcher.ts-862-  suppressDefaultFailureEmail?: boolean
hub/src/scheduler\dispatcher.ts-863-}
hub/src/scheduler\dispatcher.ts-864-
hub/src/scheduler\dispatcher.ts-865-async function onRunFinalized(
hub/src/scheduler\dispatcher.ts-866-  task: ScheduledTask,
hub/src/scheduler\dispatcher.ts-867-  runId: string,
hub/src/scheduler\dispatcher.ts-868-  status: RunStatus,
hub/src/scheduler\dispatcher.ts-869-  error: string | null,
hub/src/scheduler\dispatcher.ts-870-  extra: PostRunPayload = { cost_usd: null, duration_ms: null, output_snippet: null, chainDepth: 0 },
hub/src/scheduler\dispatcher.ts-871-): Promise<void> {
hub/src/scheduler\dispatcher.ts-872-  try {
hub/src/scheduler\dispatcher.ts-873-    const { afterRun } = await import('./post-run/dispatcher.ts')
hub/src/scheduler\dispatcher.ts-874-    await afterRun({
hub/src/scheduler\dispatcher.ts-875-      task,
hub/src/scheduler\dispatcher.ts-876-      runId,
hub/src/scheduler\dispatcher.ts-877-      status,
hub/src/scheduler\dispatcher.ts-878-      error,
hub/src/scheduler\dispatcher.ts-879-      cost_usd: extra.cost_usd,
hub/src/scheduler\dispatcher.ts-880-      duration_ms: extra.duration_ms,
hub/src/scheduler\dispatcher.ts-881-      output_snippet: extra.output_snippet,
hub/src/scheduler\dispatcher.ts:882:      parentFireId: extra.parentFireId ?? null,
hub/src/scheduler\dispatcher.ts-883-      chainDepth: extra.chainDepth,
hub/src/scheduler\dispatcher.ts-884-      ...(extra.suppressDefaultFailureEmail ? { suppressDefaultFailureEmail: true } : {}),
hub/src/scheduler\dispatcher.ts-885-    })
hub/src/scheduler\dispatcher.ts-886-  } catch (err: any) {
hub/src/scheduler\dispatcher.ts-887-    log.error('scheduler.dispatcher.post_run_failed', { task_id: task.id, run_id: runId, error: err?.message })
hub/src/scheduler\dispatcher.ts-888-  }
hub/src/scheduler\dispatcher.ts-889-}
hub/src/scheduler\dispatcher.ts-890-
hub/src/scheduler\dispatcher.ts-891-export async function cancelRun(runId: string, userId: string): Promise<boolean> {
hub/src/scheduler\dispatcher.ts-892-  const ctx = inFlightByRun.get(runId)
hub/src/scheduler\dispatcher.ts-893-  if (ctx && ctx.userId !== userId) return false
hub/src/scheduler\dispatcher.ts-894-  if (ctx?.target?.agentSocket) {
--
hub/src/scheduler\post-run\dispatcher.ts-19-import { getTaskById } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler\post-run\dispatcher.ts-20-import { parseControllerDecision, nextStepForAction } from '../controller-schema.ts'
hub/src/scheduler\post-run\dispatcher.ts-21-import { parseQcFindings, findingHash } from '../qc-schema.ts'
hub/src/scheduler\post-run\dispatcher.ts-22-import { isTerminalSummary } from '../summary-line.ts'
hub/src/scheduler\post-run\dispatcher.ts-23-import { hasVerifiedFinding, recordVerifiedFinding } from '../../db/dal.ts'
hub/src/scheduler\post-run\dispatcher.ts-24-import { findQcReviewSnippetForRun, getRun } from '../../db/scheduled-tasks-dal.ts'
hub/src/scheduler\post-run\dispatcher.ts-25-import { executeEmail } from './email.ts'
hub/src/scheduler\post-run\dispatcher.ts-26-import { executeTelegram } from './telegram.ts'
hub/src/scheduler\post-run\dispatcher.ts-27-import { executeWebPush } from './webpush.ts'
hub/src/scheduler\post-run\dispatcher.ts-28-import { executeWebhook } from './webhook.ts'
hub/src/scheduler\post-run\dispatcher.ts-29-import { executeGithubIssue } from './github-issue.ts'
hub/src/scheduler\post-run\dispatcher.ts-30-import { executeDeployVerify } from './deploy-verify.ts'
hub/src/scheduler\post-run\dispatcher.ts:31:import { report as aggregatorReport } from './aggregator.ts'
hub/src/scheduler\post-run\dispatcher.ts-32-import { surfaceProposal } from './propose-notify.ts'
hub/src/scheduler\post-run\dispatcher.ts-33-import { reportSelfErrorToAgentautofix, reportTriageFindingToAgentautofix, scrub } from '../../agentautofix/reporter.ts'
hub/src/scheduler\post-run\dispatcher.ts-34-import { INTERNAL_TRIAGE_TASK_NAME, claimTriageFindingForward } from '../../db/dal.ts'
hub/src/scheduler\post-run\dispatcher.ts-35-import { parseTriageOutput, type TriageResult } from '../triage-schema.ts'
hub/src/scheduler\post-run\dispatcher.ts-36-
hub/src/scheduler\post-run\dispatcher.ts-37-const MAX_CHAIN_DEPTH = 5
hub/src/scheduler\post-run\dispatcher.ts-38-const RUN_URL_PREFIX = process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'
hub/src/scheduler\post-run\dispatcher.ts-39-
hub/src/scheduler\post-run\dispatcher.ts-40-const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
hub/src/scheduler\post-run\dispatcher.ts-41-
hub/src/scheduler\post-run\dispatcher.ts-42-/**
hub/src/scheduler\post-run\dispatcher.ts-43- * feat/scheduled-default-email-summary — synthesize a default run-summary email.
--
hub/src/scheduler\post-run\dispatcher.ts-151-  for (const t of pendingTimers) clearTimeout(t)
hub/src/scheduler\post-run\dispatcher.ts-152-  pendingTimers.clear()
hub/src/scheduler\post-run\dispatcher.ts-153-}
hub/src/scheduler\post-run\dispatcher.ts-154-
hub/src/scheduler\post-run\dispatcher.ts-155-interface AfterRunArgs {
hub/src/scheduler\post-run\dispatcher.ts-156-  task: ScheduledTask
hub/src/scheduler\post-run\dispatcher.ts-157-  runId: string
hub/src/scheduler\post-run\dispatcher.ts-158-  status: RunStatus
hub/src/scheduler\post-run\dispatcher.ts-159-  error: string | null
hub/src/scheduler\post-run\dispatcher.ts-160-  cost_usd: number | null
hub/src/scheduler\post-run\dispatcher.ts-161-  duration_ms: number | null
hub/src/scheduler\post-run\dispatcher.ts-162-  output_snippet: string | null
hub/src/scheduler\post-run\dispatcher.ts:163:  parentFireId: string | null
hub/src/scheduler\post-run\dispatcher.ts-164-  chainDepth: number
hub/src/scheduler\post-run\dispatcher.ts-165-  /** PTYCAP-07-08: set only when the heal path owns the failure notification. */
hub/src/scheduler\post-run\dispatcher.ts-166-  suppressDefaultFailureEmail?: boolean
hub/src/scheduler\post-run\dispatcher.ts-167-}
hub/src/scheduler\post-run\dispatcher.ts-168-
hub/src/scheduler\post-run\dispatcher.ts-169-export async function afterRun(args: AfterRunArgs): Promise<void> {
hub/src/scheduler\post-run\dispatcher.ts:170:  if (args.parentFireId) {
hub/src/scheduler\post-run\dispatcher.ts:171:    await aggregatorReport(
hub/src/scheduler\post-run\dispatcher.ts:172:      args.parentFireId,
hub/src/scheduler\post-run\dispatcher.ts-173-      args.task,
hub/src/scheduler\post-run\dispatcher.ts-174-      { status: args.status, error: args.error },
hub/src/scheduler\post-run\dispatcher.ts-175-      {
hub/src/scheduler\post-run\dispatcher.ts-176-        cost_usd: args.cost_usd,
hub/src/scheduler\post-run\dispatcher.ts-177-        duration_ms: args.duration_ms,
hub/src/scheduler\post-run\dispatcher.ts-178-        output_snippet: args.output_snippet,
hub/src/scheduler\post-run\dispatcher.ts-179-      },
hub/src/scheduler\post-run\dispatcher.ts-180-    )
hub/src/scheduler\post-run\dispatcher.ts-181-    return
hub/src/scheduler\post-run\dispatcher.ts-182-  }
hub/src/scheduler\post-run\dispatcher.ts:183:  await fireWithContext(args)
hub/src/scheduler\post-run\dispatcher.ts-184-}
hub/src/scheduler\post-run\dispatcher.ts-185-
hub/src/scheduler\post-run\dispatcher.ts-186-interface FireCtxArgs extends AfterRunArgs {
hub/src/scheduler\post-run\dispatcher.ts-187-  aggregate?: { total: number; successes: number; failures: number }
hub/src/scheduler\post-run\dispatcher.ts-188-}
hub/src/scheduler\post-run\dispatcher.ts-189-
hub/src/scheduler\post-run\dispatcher.ts-190-/**
hub/src/scheduler\post-run\dispatcher.ts-191- * Resolve the REAL Coolify `deployment_uuid` a `__internal_triage` run was
hub/src/scheduler\post-run\dispatcher.ts-192- * dispatched for. The webhook (api/coolify-webhook.ts) dispatches triage with
hub/src/scheduler\post-run\dispatcher.ts-193- * `triggeredByRunId` = the deployment metadata run, which `insertDeploymentRun`
hub/src/scheduler\post-run\dispatcher.ts-194- * stamps with `deployment_uuid`; the triage run row itself normally carries none.
hub/src/scheduler\post-run\dispatcher.ts-195- * (The per-event `payloadOverride` lives only on the in-memory task and is gone
--
hub/src/scheduler\post-run\dispatcher.ts-299-    } as PostRunAction,
hub/src/scheduler\post-run\dispatcher.ts-300-    { userId: args.task.user_id, templateVars: {} },
hub/src/scheduler\post-run\dispatcher.ts-301-  )
hub/src/scheduler\post-run\dispatcher.ts-302-}
hub/src/scheduler\post-run\dispatcher.ts-303-
hub/src/scheduler\post-run\dispatcher.ts-304-/** True when the default failure email would be built for a failed root run of this task. */
hub/src/scheduler\post-run\dispatcher.ts-305-export async function defaultFailureEmailApplies(task: ScheduledTask): Promise<boolean> {
hub/src/scheduler\post-run\dispatcher.ts-306-  const parsed = validatePostRunActions(await listActionsForTask(task.id))
hub/src/scheduler\post-run\dispatcher.ts-307-  if (!parsed.ok) return false // fireWithContext returns before any action when the set is invalid
hub/src/scheduler\post-run\dispatcher.ts-308-  return buildDefaultEmailActions(task, 0, parsed.value, { status: 'failed', output_snippet: null }).length > 0
hub/src/scheduler\post-run\dispatcher.ts-309-}
hub/src/scheduler\post-run\dispatcher.ts-310-
hub/src/scheduler\post-run\dispatcher.ts:311:export async function fireWithContext(args: FireCtxArgs): Promise<void> {
hub/src/scheduler\post-run\dispatcher.ts-312-  // Awaited (errors contained) so the AAF forward + fallback email finish inside the
hub/src/scheduler\post-run\dispatcher.ts-313-  // post-run lifecycle instead of being orphaned when the caller releases.
hub/src/scheduler\post-run\dispatcher.ts-314-  await handleInternalTriageRun(args).catch((err: any) => {
hub/src/scheduler\post-run\dispatcher.ts-315-    console.error('[post-run.dispatcher] internal triage handling failed', err?.message ?? err)
hub/src/scheduler\post-run\dispatcher.ts-316-  })
hub/src/scheduler\post-run\dispatcher.ts-317-  const actionsRaw = await listActionsForTask(args.task.id)
hub/src/scheduler\post-run\dispatcher.ts-318-  const parsed = validatePostRunActions(actionsRaw)
hub/src/scheduler\post-run\dispatcher.ts-319-  if (!parsed.ok) {
hub/src/scheduler\post-run\dispatcher.ts-320-    console.warn(
hub/src/scheduler\post-run\dispatcher.ts-321-      `[post-run.dispatcher] task=${args.task.id} actions invalid: ${parsed.errors.join('; ')}`,
hub/src/scheduler\post-run\dispatcher.ts-322-    )
hub/src/scheduler\post-run\dispatcher.ts-323-    return
--
hub/src/scheduler\post-run\aggregator.ts-25-  userId: string
hub/src/scheduler\post-run\aggregator.ts-26-  expected: number
hub/src/scheduler\post-run\aggregator.ts-27-  results: ChildResult[]
hub/src/scheduler\post-run\aggregator.ts-28-  createdAt: number
hub/src/scheduler\post-run\aggregator.ts-29-  fired: boolean
hub/src/scheduler\post-run\aggregator.ts-30-}
hub/src/scheduler\post-run\aggregator.ts-31-
hub/src/scheduler\post-run\aggregator.ts-32-const buckets = new Map<string, Bucket>()
hub/src/scheduler\post-run\aggregator.ts-33-const BUCKET_TIMEOUT_MS = 5 * 60 * 1000
hub/src/scheduler\post-run\aggregator.ts-34-const SWEEP_INTERVAL_MS = 30_000
hub/src/scheduler\post-run\aggregator.ts-35-
hub/src/scheduler\post-run\aggregator.ts-36-export function register(
hub/src/scheduler\post-run\aggregator.ts:37:  parentFireId: string, taskId: string, userId: string, expected: number,
hub/src/scheduler\post-run\aggregator.ts-38-): void {
hub/src/scheduler\post-run\aggregator.ts:39:  buckets.set(parentFireId, {
hub/src/scheduler\post-run\aggregator.ts-40-    taskId, userId, expected, results: [], createdAt: Date.now(), fired: false,
hub/src/scheduler\post-run\aggregator.ts-41-  })
hub/src/scheduler\post-run\aggregator.ts-42-}
hub/src/scheduler\post-run\aggregator.ts-43-
hub/src/scheduler\post-run\aggregator.ts-44-export async function report(
hub/src/scheduler\post-run\aggregator.ts:45:  parentFireId: string,
hub/src/scheduler\post-run\aggregator.ts-46-  task: ScheduledTask,
hub/src/scheduler\post-run\aggregator.ts-47-  result: ChildResult,
hub/src/scheduler\post-run\aggregator.ts-48-  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
hub/src/scheduler\post-run\aggregator.ts-49-): Promise<void> {
hub/src/scheduler\post-run\aggregator.ts:50:  const b = buckets.get(parentFireId)
hub/src/scheduler\post-run\aggregator.ts-51-  if (!b || b.fired) return
hub/src/scheduler\post-run\aggregator.ts-52-  b.results.push(result)
hub/src/scheduler\post-run\aggregator.ts-53-  if (b.results.length >= b.expected) {
hub/src/scheduler\post-run\aggregator.ts:54:    await fireAggregate(parentFireId, b, task, extra)
hub/src/scheduler\post-run\aggregator.ts-55-  }
hub/src/scheduler\post-run\aggregator.ts-56-}
hub/src/scheduler\post-run\aggregator.ts-57-
hub/src/scheduler\post-run\aggregator.ts-58-function aggregateStatus(results: ChildResult[]): RunStatus {
hub/src/scheduler\post-run\aggregator.ts-59-  if (results.length === 0) return 'failed'
hub/src/scheduler\post-run\aggregator.ts-60-  const successes = results.filter((r) => r.status === 'success').length
hub/src/scheduler\post-run\aggregator.ts-61-  if (successes === results.length) return 'success'
hub/src/scheduler\post-run\aggregator.ts-62-  return 'failed'
hub/src/scheduler\post-run\aggregator.ts-63-}
hub/src/scheduler\post-run\aggregator.ts-64-
hub/src/scheduler\post-run\aggregator.ts-65-async function fireAggregate(
hub/src/scheduler\post-run\aggregator.ts:66:  parentFireId: string, b: Bucket, task: ScheduledTask,
hub/src/scheduler\post-run\aggregator.ts-67-  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
hub/src/scheduler\post-run\aggregator.ts-68-): Promise<void> {
hub/src/scheduler\post-run\aggregator.ts-69-  b.fired = true
hub/src/scheduler\post-run\aggregator.ts:70:  buckets.delete(parentFireId)
hub/src/scheduler\post-run\aggregator.ts-71-  const status = aggregateStatus(b.results)
hub/src/scheduler\post-run\aggregator.ts-72-  const successes = b.results.filter((r) => r.status === 'success').length
hub/src/scheduler\post-run\aggregator.ts-73-  const failures = b.results.filter((r) => r.status === 'failed').length
hub/src/scheduler\post-run\aggregator.ts-74-  try {
hub/src/scheduler\post-run\aggregator.ts-75-    const { fireWithContext } = await import('./dispatcher.ts')
hub/src/scheduler\post-run\aggregator.ts:76:    await fireWithContext({
hub/src/scheduler\post-run\aggregator.ts-77-      task,
hub/src/scheduler\post-run\aggregator.ts:78:      runId: parentFireId,
hub/src/scheduler\post-run\aggregator.ts-79-      status,
hub/src/scheduler\post-run\aggregator.ts-80-      error: failures > 0 ? `aggregate: ${failures}/${b.results.length} children failed` : null,
hub/src/scheduler\post-run\aggregator.ts-81-      cost_usd: extra.cost_usd,
hub/src/scheduler\post-run\aggregator.ts-82-      duration_ms: extra.duration_ms,
hub/src/scheduler\post-run\aggregator.ts-83-      output_snippet: extra.output_snippet,
hub/src/scheduler\post-run\aggregator.ts:84:      parentFireId: null,
hub/src/scheduler\post-run\aggregator.ts-85-      chainDepth: 0,
hub/src/scheduler\post-run\aggregator.ts-86-      aggregate: { total: b.results.length, successes, failures },
hub/src/scheduler\post-run\aggregator.ts-87-    })
hub/src/scheduler\post-run\aggregator.ts-88-  } catch (err: any) {
hub/src/scheduler\post-run\aggregator.ts-89-    console.error(`[aggregator] fire failed task=${task.id}: ${err?.message}`)
hub/src/scheduler\post-run\aggregator.ts-90-  }
hub/src/scheduler\post-run\aggregator.ts-91-}
hub/src/scheduler\post-run\aggregator.ts-92-
hub/src/scheduler\post-run\aggregator.ts-93-setInterval(async () => {
hub/src/scheduler\post-run\aggregator.ts-94-  const now = Date.now()
hub/src/scheduler\post-run\aggregator.ts-95-  for (const [pid, b] of buckets) {
hub/src/scheduler\post-run\aggregator.ts-96-    if (b.fired) continue

 succeeded in 708ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/db/scheduled-tasks-dal.ts:59:  target_kind: TargetKind
hub/src/db/scheduled-tasks-dal.ts:92:  email_summary: boolean
hub/src/db/scheduled-tasks-dal.ts:112:  target_kind: TargetKind | null
hub/src/db/scheduled-tasks-dal.ts:216:    email_summary: row.email_summary !== false,
hub/src/db/scheduled-tasks-dal.ts:222:// (task_type/target_kind/target_id/payload/cron_expr/timezone/catchup_policy/
hub/src/db/scheduled-tasks-dal.ts:224:// scheduled_for/finished_at/target_kind/target_id/cost_usd/duration_ms/
hub/src/db/scheduled-tasks-dal.ts:263:  target_kind: TargetKind
hub/src/db/scheduled-tasks-dal.ts:276:  // id for `target_kind = 'session'`.
hub/src/db/scheduled-tasks-dal.ts:285:  email_summary?: boolean
hub/src/db/scheduled-tasks-dal.ts:296:      task_type, target_kind, target_id, payload, cron_expr, timezone,
hub/src/db/scheduled-tasks-dal.ts:299:      teab_repo_ident, teab_last_status, email_summary,
hub/src/db/scheduled-tasks-dal.ts:305:      ${input.task_type}, ${input.target_kind}, ${input.target_id ?? null},
hub/src/db/scheduled-tasks-dal.ts:313:      ${input.email_summary ?? true},
hub/src/db/scheduled-tasks-dal.ts:328:    target_kind: TargetKind
hub/src/db/scheduled-tasks-dal.ts:342:    email_summary: boolean
hub/src/db/scheduled-tasks-dal.ts:351:  if (fields.target_kind !== undefined) sets.push(sql`target_kind = ${fields.target_kind}`)
hub/src/db/scheduled-tasks-dal.ts:373:  if (fields.email_summary !== undefined) sets.push(sql`email_summary = ${fields.email_summary}`)
hub/src/db/scheduled-tasks-dal.ts:500:  target_kind: TargetKind
hub/src/db/scheduled-tasks-dal.ts:519:      scheduled_for, target_kind, target_id, triggered_by_run_id,
hub/src/db/scheduled-tasks-dal.ts:524:      ${input.scheduled_for}, ${input.target_kind}, ${input.target_id ?? null},
hub/src/db/scheduled-tasks-dal.ts:666:    target_kind: targetKind,
hub/src/scheduler/post-run/aggregator.ts:4: * For tasks with target_kind in ('all_agents','all_supervisors'), the
hub/src/scheduler/post-run/aggregator.ts:37:  parentFireId: string, taskId: string, userId: string, expected: number,
hub/src/scheduler/post-run/aggregator.ts:39:  buckets.set(parentFireId, {
hub/src/scheduler/post-run/aggregator.ts:45:  parentFireId: string,
hub/src/scheduler/post-run/aggregator.ts:50:  const b = buckets.get(parentFireId)
hub/src/scheduler/post-run/aggregator.ts:54:    await fireAggregate(parentFireId, b, task, extra)
hub/src/scheduler/post-run/aggregator.ts:66:  parentFireId: string, b: Bucket, task: ScheduledTask,
hub/src/scheduler/post-run/aggregator.ts:70:  buckets.delete(parentFireId)
hub/src/scheduler/post-run/aggregator.ts:78:      runId: parentFireId,
hub/src/scheduler/post-run/aggregator.ts:84:      parentFireId: null,
hub/src/scheduler/dispatcher.ts:40:  parentFireId?: string | null
hub/src/scheduler/dispatcher.ts:106:  if (task.target_kind === 'session' && task.target_id) return task.target_id
hub/src/scheduler/dispatcher.ts:211:      target_kind: task.target_kind,
hub/src/scheduler/dispatcher.ts:267:      target_kind: task.target_kind,
hub/src/scheduler/dispatcher.ts:298:      target_kind: task.target_kind,
hub/src/scheduler/dispatcher.ts:319:      target_kind: task.target_kind,
hub/src/scheduler/dispatcher.ts:335:  // of resolveTargets. They have no fixed target_kind/target_id; the sender
hub/src/scheduler/dispatcher.ts:343:      target_kind: 'session',
hub/src/scheduler/dispatcher.ts:353:      parentFireId: null,
hub/src/scheduler/dispatcher.ts:363:      target_kind: 'session',
hub/src/scheduler/dispatcher.ts:392:      target_kind: 'supervisor',
hub/src/scheduler/dispatcher.ts:402:      parentFireId: null,
hub/src/scheduler/dispatcher.ts:414:      target_kind: 'supervisor',
hub/src/scheduler/dispatcher.ts:445:      target_kind: 'session',
hub/src/scheduler/dispatcher.ts:456:      parentFireId: null,
hub/src/scheduler/dispatcher.ts:468:      target_kind: 'session',
hub/src/scheduler/dispatcher.ts:492:      target_kind: task.target_kind,
hub/src/scheduler/dispatcher.ts:508:  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
hub/src/scheduler/dispatcher.ts:509:  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null
hub/src/scheduler/dispatcher.ts:514:      aggRegister(parentFireId!, task.id, userId, targets.length)
hub/src/scheduler/dispatcher.ts:526:      target_kind: target.kind,
hub/src/scheduler/dispatcher.ts:538:      parentFireId,
hub/src/scheduler/dispatcher.ts:552:      target_kind: target.kind,
hub/src/scheduler/dispatcher.ts:819:      parentFireId: ctx?.parentFireId ?? null,
hub/src/scheduler/dispatcher.ts:859:  parentFireId?: string | null
hub/src/scheduler/dispatcher.ts:882:      parentFireId: extra.parentFireId ?? null,

 succeeded in 753ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  791:     // repo came back `session_busy`.
  792:     startHookReaper()
  793:     // Milestone ASK — periodic sweep that finalizes `session_asks` stuck
  794:     // queued/dispatched past REMO_ASK_MAX_MS (default 15min) as `timeout`, so an
  795:     // external caller never polls a dead ask forever. Conditional finalize, so a
  796:     // late reply can't be double-finalized. No-op when REMO_ASK_REAPER_DISABLED.
  797:     startAskReaperSweep()
  798:     // Milestone WORK — finalizes `work_runs` stuck queued/dispatched past
  799:     // REMO_WORK_MAX_MS (default 45min) as `timeout`. Conditional finalize, so a late
  800:     // reply can't be double-finalized. No-op when REMO_WORK_REAPER_DISABLED.
  801:     startWorkReaperSweep()
  802:     // fix/stop-the-bleed — LIVENESS-scoped backstop (NOT an absolute-age force-close;
  803:     // an age-only reaper would close live long-running builds). Closes an OPEN
  804:     // session_runs row only when its supervisor has pushed inventory and the row's
  805:     // session is absent from that live set, and the row is older than
  806:     // REMO_SESSION_RUN_MAX_MS (default 24h — a grace inside the liveness predicate,
  807:     // not a lifetime cap). Leaked open runs eat the supervisor concurrency cap and
  808:     // wedge every launch with `at_capacity`. No-op when REMO_SESSION_RUN_REAPER_DISABLED.
  809:     startStaleRunReaperSweep()
  810:     // Milestone once — DURABLE tick source of truth for one-time tasks. Fires any
  811:     // `schedule_kind='once'` row that is due (run_at<=now) and still enabled, so an
  812:     // immediate/one-time task dispatches even if the registry's setTimeout(0)
  813:     // latency-optimization is lost (restart / thrown fire / swallowed register).
  814:     // claimOnceTask keeps it exactly-once. No-op when REMO_ONCE_SWEEP_DISABLED.
  815:     startOnceDueSweep()
  816:     // PTYCAP-07-06 — boot-time sweep: terminalizes heal autospawn launches stranded by a
  817:     // restart (the spawn-deadline timer is process-local) so the 6h reaper is never their
  818:     // backstop. Event-driven (once at boot plus one follow-up at the deadline, no interval); flag-OFF boot loads nothing of it.
  819:     if (healUnifiedEnabled()) {
  820:       void import('./heal/sweep.ts')
  821:         .then((m) => m.bootSweepHealLaunches())
  822:         .catch((err) => console.error('[startup] heal boot sweep failed:', err?.message ?? err))
  823:     }
  824:     console.log('[startup] reset sessions/messages/runs; scheduler ready')
  825:   })
  826:   .catch((err) => {
  827:     console.error('[startup] migration/init error:', err.message)
  828:   })
  829: 
  830: // Graceful shutdown — pause cron jobs and clear pending post-run timers.
  831: function gracefulShutdown(signal: string) {
  832:   console.log(`[shutdown] received ${signal}, pausing schedulers`)
  833:   try { schedRegistry.pauseAll() } catch {}
  834:   try { clearPostRunTimers() } catch {}
  835:   try { stopRoutineQueueWorker() } catch {}
  836:   try { stopDueOrchestratorTick() } catch {}
hub/src/heal/config.ts:27:export function healSpawnTimeoutMs(): number {
hub/src/heal/config.ts:28:  return positiveKnob('REMO_HEAL_SPAWN_TIMEOUT_MS', 25_000);
hub/test\heal-config.test.ts:10:  healSpawnTimeoutMs,
hub/test\heal-config.test.ts:20:  'REMO_HEAL_SPAWN_TIMEOUT_MS',
hub/test\heal-config.test.ts:70:    ['spawn timeout', healSpawnTimeoutMs, 'REMO_HEAL_SPAWN_TIMEOUT_MS', 25000],
hub/test\heal-route-autospawn.test.ts:31:  timeout: process.env.REMO_HEAL_SPAWN_TIMEOUT_MS,
hub/test\heal-route-autospawn.test.ts:35:  delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
hub/test\heal-route-autospawn.test.ts:42:    ['REMO_HEAL_SPAWN_TIMEOUT_MS', saved.timeout],
hub/test\heal-route-autospawn.test.ts:306:  test('the spawn deadline follows REMO_HEAL_SPAWN_TIMEOUT_MS', async () => {
hub/test\heal-route-autospawn.test.ts:307:    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '1234'
hub/test\heal-sweep.test.ts:20:const savedTimeout = process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
hub/test\heal-sweep.test.ts:23:  delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
hub/test\heal-sweep.test.ts:28:  if (savedTimeout === undefined) delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
hub/test\heal-sweep.test.ts:29:  else process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = savedTimeout
hub/test\heal-sweep.test.ts:123:    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '1000'
hub/test\heal-sweep.test.ts:309:  test('the delay tracks REMO_HEAL_SPAWN_TIMEOUT_MS', () => {
hub/test\heal-sweep.test.ts:310:    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '4000'

 exited 1 in 889ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
bun test v1.3.14 (0d9b296a)

hub\test\heal-owner-email-outbox.test.ts:

# Unhandled error between tests
-------------------------------
error: EPERM reading "C:\Users\artic\GitHub\remo-code-ptycap07\hub\test\heal-owner-email-outbox.test.ts"
-------------------------------

error: Cannot read file "C:\Users\artic\GitHub\remo-code-ptycap07\": EPERM

error: Cannot read file "C:\Users\artic\GitHub\remo-code-ptycap07\hub": EPERM

error: Cannot read file "C:\Users\artic\GitHub\remo-code-ptycap07\hub\tsconfig.json": EPERM

 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [104.00ms]

codex
Two high-risk paths are now confirmed: fan-out runs can get both a child outbox email and the existing aggregate email, and retry coverage is only boot-time plus one follow-up. I’m validating whether either is neutralized elsewhere before issuing the verdict.
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n \"defaultFailureEmailApplies|deliverOwnerEmailForRun|sweepOwnerEmails|owner_email\" hub/test --glob '*.test.ts'" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'Get-Content hub/src/scheduler/post-run/aggregator.ts; $p='"'hub/src/scheduler/dispatcher.ts'; "'$l=Get-Content $p; for($i=495;$i -le 560;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/heal/owner-email.ts'; "'$l=Get-Content $p; for($i=0;$i -lt $l.Length;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; $p='"'hub/src/db/heal-events-dal.ts'; "'$l=Get-Content $p; for($i=320;$i -le 420;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git show HEAD''^:hub/src/scheduler/dispatcher.ts | Select-String -Pattern "healFailedRunHook" -Context 0,25; git show HEAD''^:hub/src/heal/sweep.ts | Select-String -Pattern "bootSweepHealLaunches|sweepStaleHealLaunches" -Context 3,15' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 515ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
/**
 * Fan-out aggregator (W2/T8.7).
 *
 * For tasks with target_kind in ('all_agents','all_supervisors'), the
 * dispatcher inserts N child runs (one per resolved target). We don't want
 * to fire post-run actions per child (notification spam). Instead, this
 * aggregator collects child outcomes for a single parent fire and fires
 * post-run actions ONCE with an aggregate status.
 *
 * Aggregate status mapping:
 *   - all children success → success
 *   - mixed                → failed (template vars include partial counts)
 *   - all failed           → failed
 *
 * Timeout: 5 minutes per bucket. After timeout we fire with whatever we
 * have. Buckets are in-memory only — restart drops pending aggregates
 * (documented limitation).
 */
import type { ScheduledTask, RunStatus } from '../../db/scheduled-tasks-dal.ts'

interface ChildResult { status: RunStatus; error: string | null }

interface Bucket {
  taskId: string
  userId: string
  expected: number
  results: ChildResult[]
  createdAt: number
  fired: boolean
}

const buckets = new Map<string, Bucket>()
const BUCKET_TIMEOUT_MS = 5 * 60 * 1000
const SWEEP_INTERVAL_MS = 30_000

export function register(
  parentFireId: string, taskId: string, userId: string, expected: number,
): void {
  buckets.set(parentFireId, {
    taskId, userId, expected, results: [], createdAt: Date.now(), fired: false,
  })
}

export async function report(
  parentFireId: string,
  task: ScheduledTask,
  result: ChildResult,
  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
): Promise<void> {
  const b = buckets.get(parentFireId)
  if (!b || b.fired) return
  b.results.push(result)
  if (b.results.length >= b.expected) {
    await fireAggregate(parentFireId, b, task, extra)
  }
}

function aggregateStatus(results: ChildResult[]): RunStatus {
  if (results.length === 0) return 'failed'
  const successes = results.filter((r) => r.status === 'success').length
  if (successes === results.length) return 'success'
  return 'failed'
}

async function fireAggregate(
  parentFireId: string, b: Bucket, task: ScheduledTask,
  extra: { cost_usd: number | null; duration_ms: number | null; output_snippet: string | null },
): Promise<void> {
  b.fired = true
  buckets.delete(parentFireId)
  const status = aggregateStatus(b.results)
  const successes = b.results.filter((r) => r.status === 'success').length
  const failures = b.results.filter((r) => r.status === 'failed').length
  try {
    const { fireWithContext } = await import('./dispatcher.ts')
    await fireWithContext({
      task,
      runId: parentFireId,
      status,
      error: failures > 0 ? `aggregate: ${failures}/${b.results.length} children failed` : null,
      cost_usd: extra.cost_usd,
      duration_ms: extra.duration_ms,
      output_snippet: extra.output_snippet,
      parentFireId: null,
      chainDepth: 0,
      aggregate: { total: b.results.length, successes, failures },
    })
  } catch (err: any) {
    console.error(`[aggregator] fire failed task=${task.id}: ${err?.message}`)
  }
}

setInterval(async () => {
  const now = Date.now()
  for (const [pid, b] of buckets) {
    if (b.fired) continue
    if (now - b.createdAt < BUCKET_TIMEOUT_MS) continue
    try {
      const { getTaskById } = await import('../../db/scheduled-tasks-dal.ts')
      const task = await getTaskById(b.taskId)
      if (!task) { buckets.delete(pid); continue }
      await fireAggregate(pid, b, task, { cost_usd: null, duration_ms: null, output_snippet: null })
    } catch (err: any) {
      console.error(`[aggregator] sweep fire failed task=${b.taskId}: ${err?.message}`)
      buckets.delete(pid)
    }
  }
}, SWEEP_INTERVAL_MS)
  496:     })
  497:     broadcastScheduledRun(userId, {
  498:       type: 'scheduled_run_finished',
  499:       run_id: run.id, task_id: task.id, status: 'failed',
  500:       error: isManual ? 'target_offline' : 'no_targets',
  501:     })
  502:     void onRunFinalized(task, run.id, 'failed', isManual ? 'target_offline' : 'no_targets')
  503:     if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
  504:     runIds.push(run.id)
  505:     return { runIds }
  506:   }
  507: 
  508:   const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
  509:   const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null
  510: 
  511:   if (isFanOut) {
  512:     try {
  513:       const { register: aggRegister } = await import('./post-run/aggregator.ts')
  514:       aggRegister(parentFireId!, task.id, userId, targets.length)
  515:     } catch (err: any) {
  516:       log.error('scheduler.dispatcher.aggregator_register_failed', { task_id: task.id, error: err?.message })
  517:     }
  518:   }
  519: 
  520:   for (const target of targets) {
  521:     const run = await insertRunV2({
  522:       task_id: task.id,
  523:       user_id: userId,
  524:       status: 'pending',
  525:       scheduled_for: now,
  526:       target_kind: target.kind,
  527:       target_id: target.sessionId ?? target.supervisorId ?? null,
  528:       session_id: target.sessionId ?? null,
  529:       triggered_by_run_id: opts.triggeredByRunId ?? null,
  530:     })
  531: 
  532:     const ctx: NewRunContext = {
  533:       runId: run.id,
  534:       taskId: task.id,
  535:       userId,
  536:       target,
  537:       startedAt: now.getTime(),
  538:       parentFireId,
  539:       chainDepth: opts.chainDepth,
  540:       triggeredByRunId: opts.triggeredByRunId ?? null,
  541:       isManual,
  542:       onceClaimed: opts.onceClaimed === true,
  543:     }
  544:     trackRun(ctx)
  545:     runIds.push(run.id)
  546: 
  547:     broadcastScheduledRun(userId, {
  548:       type: 'scheduled_run_started',
  549:       run_id: run.id,
  550:       task_id: task.id,
  551:       scheduled_for: now.toISOString(),
  552:       target_kind: target.kind,
  553:       target_id: target.sessionId ?? target.supervisorId ?? null,
  554:     })
  555: 
  556:     // Round-2 migration: SESSION-targeted runs (session / all_agents) no longer
  557:     // pre-check offline here — the agent sender routes online-check → per-session
  558:     // queue → grace park → send through the shared `dispatch()` pipeline, which
  559:     // parks offline targets in the shared grace buffer (keyed by sessionId,
  560:     // drained on agent reconnect) and fails manual runs fast. So fall through to
  561:     // routeToSender for online AND offline session targets.

 succeeded in 520ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
    1: // hub/src/heal/owner-email.ts
    2: //
    3: // PTYCAP-07 repair round: delivery of the persisted default owner-email obligation (outbox).
    4: // The obligation is written with the heal claim (heal-events-dal claimHealEvent). Two deliverers,
    5: // one lease CAS between them: the scheduler hook right after the heal hook returns, and the heal
    6: // sweep for anything a crash left undelivered. A send that reports failure drops the lease so the
    7: // next sweep retries; a hub crash mid-send is retried after the lease expires. Never throws.
    8: 
    9: import type { OwnerEmailClaim } from '../db/heal-events-dal.ts';
   10: 
   11: export interface OwnerEmailDeps {
   12:   hasObligation(runId: string): Promise<boolean>;
   13:   claimByRun(runId: string): Promise<OwnerEmailClaim | null>;
   14:   list(olderThanMs: number): Promise<OwnerEmailClaim[]>;
   15:   claim(id: string): Promise<OwnerEmailClaim | null>;
   16:   markDelivered(id: string): Promise<void>;
   17:   release(id: string): Promise<void>;
   18:   resolveOwnerEmail(userId: string): Promise<string | null>;
   19:   send(msg: { to: string; subject: string; html: string; text: string }): Promise<boolean>;
   20: }
   21: 
   22: export const REAL_OWNER_EMAIL_DEPS: OwnerEmailDeps = {
   23:   hasObligation: async (runId) => (await import('../db/heal-events-dal.ts')).hasOwnerEmailObligation(runId),
   24:   claimByRun: async (runId) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDeliveryByRun(runId),
   25:   list: async (ms) => (await import('../db/heal-events-dal.ts')).listPendingOwnerEmails(ms),
   26:   claim: async (id) => (await import('../db/heal-events-dal.ts')).claimOwnerEmailDelivery(id),
   27:   markDelivered: async (id) => (await import('../db/heal-events-dal.ts')).markOwnerEmailDelivered(id),
   28:   release: async (id) => (await import('../db/heal-events-dal.ts')).releaseOwnerEmailClaim(id),
   29:   resolveOwnerEmail: async (userId) => {
   30:     const { getUserById } = await import('../db/dal.ts');
   31:     return ((await getUserById(userId)) as { email?: string } | null)?.email ?? null;
   32:   },
   33:   send: async (msg) => (await import('../lib/email.ts')).sendEmail(msg),
   34: };
   35: 
   36: function log(msg: string): void {
   37:   console.error(`[heal.owner-email] ${msg}`);
   38: }
   39: 
   40: /** Sends a CLAIMED obligation. True when delivered. */
   41: async function sendClaimed(c: OwnerEmailClaim, deps: OwnerEmailDeps): Promise<boolean> {
   42:   try {
   43:     const to = await deps.resolveOwnerEmail(c.user_id);
   44:     if (!to) {
   45:       log(`no owner address for event ${c.id}; closing without a send`);
   46:       await deps.markDelivered(c.id);
   47:       return false;
   48:     }
   49:     const ok = await deps.send({ to, subject: c.owner_email.subject, text: c.owner_email.text, html: c.owner_email.html });
   50:     if (!ok) {
   51:       log(`send reported failure for event ${c.id}; left for the sweep`);
   52:       await deps.release(c.id).catch(() => {});
   53:       return false;
   54:     }
   55:     await deps.markDelivered(c.id); // a failure here means a re-send after the lease, never a loss
   56:     return true;
   57:   } catch (err: any) {
   58:     log(`delivery failed for event ${c.id}: ${err?.message ?? err}; left for the sweep`);
   59:     await deps.release(c.id).catch(() => {});
   60:     return false;
   61:   }
   62: }
   63: 
   64: /**
   65:  * Scheduler path. Resolves true when the run's heal event carries an owner-email obligation (the
   66:  * obligation, not the default post-run email, is now the owner notification), whether the send
   67:  * happened here, was already done, or is left for the sweep. False = no obligation, so the caller
   68:  * keeps the legacy default email. Never throws.
   69:  */
   70: export async function deliverOwnerEmailForRun(runId: string, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<boolean> {
   71:   try {
   72:     if (!(await deps.hasObligation(runId))) return false;
   73:   } catch (err: any) {
   74:     log(`obligation probe failed run=${runId}: ${err?.message ?? err}`);
   75:     return false;
   76:   }
   77:   try {
   78:     const claimed = await deps.claimByRun(runId);
   79:     if (claimed) await sendClaimed(claimed, deps);
   80:   } catch (err: any) {
   81:     log(`claim failed run=${runId} (left for the sweep): ${err?.message ?? err}`);
   82:   }
   83:   return true;
   84: }
   85: 
   86: /** Sweep path: redeliver every obligation a crash left undelivered. Returns the number sent. */
   87: export async function sweepOwnerEmails(olderThanMs: number, deps: OwnerEmailDeps = REAL_OWNER_EMAIL_DEPS): Promise<number> {
   88:   let sent = 0;
   89:   let rows: OwnerEmailClaim[];
   90:   try {
   91:     rows = await deps.list(olderThanMs);
   92:   } catch (err: any) {
   93:     log(`list failed: ${err?.message ?? err}`);
   94:     return 0;
   95:   }
   96:   for (const r of rows) {
   97:     try {
   98:       const c = await deps.claim(r.id);
   99:       if (c && (await sendClaimed(c, deps))) sent++;
  100:     } catch (err: any) {
  101:       log(`sweep claim failed for ${r.id}: ${err?.message ?? err}`);
  102:     }
  103:   }
  104:   return sent;
  105: }
  321: export const OWNER_EMAIL_LEASE_MS = 5 * 60_000
  322: 
  323: export interface OwnerEmailClaim {
  324:   id: string
  325:   user_id: string
  326:   owner_email: OwnerEmailPayload
  327: }
  328: 
  329: /** True when this run's heal event carries an undelivered-or-delivered obligation (a row exists). */
  330: export async function hasOwnerEmailObligation(runId: string, exec: HealExec = sql): Promise<boolean> {
  331:   const rows = await exec`
  332:     SELECT 1 AS one FROM heal_events
  333:     WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} AND owner_email IS NOT NULL
  334:     LIMIT 1
  335:   `
  336:   return rows.length > 0
  337: }
  338: 
  339: /** Lease CAS by event id. Yields the payload to the ONE caller allowed to send, else null. */
  340: export async function claimOwnerEmailDelivery(
  341:   id: string,
  342:   leaseMs: number = OWNER_EMAIL_LEASE_MS,
  343:   exec: HealExec = sql,
  344:   nowMs: number = Date.now(),
  345: ): Promise<OwnerEmailClaim | null> {
  346:   const staleBefore = new Date(nowMs - leaseMs)
  347:   const rows = await exec`
  348:     UPDATE heal_events SET owner_email_claimed_at = ${new Date(nowMs)}
  349:     WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
  350:       AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${staleBefore})
  351:     RETURNING id, user_id, owner_email
  352:   `
  353:   return rows.length > 0 ? (rows[0] as OwnerEmailClaim) : null
  354: }
  355: 
  356: export async function claimOwnerEmailDeliveryByRun(
  357:   runId: string,
  358:   leaseMs: number = OWNER_EMAIL_LEASE_MS,
  359:   exec: HealExec = sql,
  360:   nowMs: number = Date.now(),
  361: ): Promise<OwnerEmailClaim | null> {
  362:   const found = await exec`
  363:     SELECT id FROM heal_events WHERE source = 'scheduled_task' AND trigger_run_id = ${runId} LIMIT 1
  364:   `
  365:   if (found.length === 0) return null
  366:   return claimOwnerEmailDelivery(found[0].id as string, leaseMs, exec, nowMs)
  367: }
  368: 
  369: /** Terminal flag. Idempotent. */
  370: export async function markOwnerEmailDelivered(id: string, exec: HealExec = sql): Promise<void> {
  371:   await exec`
  372:     UPDATE heal_events SET owner_email_delivered_at = now(), updated_at = now()
  373:     WHERE id = ${id} AND owner_email_delivered_at IS NULL
  374:   `
  375: }
  376: 
  377: /** Failed send: drop the lease so the next sweep retries without waiting out the lease. */
  378: export async function releaseOwnerEmailClaim(id: string, exec: HealExec = sql): Promise<void> {
  379:   await exec`
  380:     UPDATE heal_events SET owner_email_claimed_at = NULL
  381:     WHERE id = ${id} AND owner_email_delivered_at IS NULL
  382:   `
  383: }
  384: 
  385: /** Best-effort: add the heal outcome reason to a still-undelivered obligation. */
  386: export async function appendOwnerEmailReason(id: string, reason: string, exec: HealExec = sql): Promise<void> {
  387:   const line = `Self-heal outcome: ${reason}`.replace(/[^ -~]/g, '?').slice(0, 200)
  388:   await exec`
  389:     UPDATE heal_events SET owner_email = jsonb_set(
  390:       jsonb_set(owner_email, '{text}', to_jsonb((owner_email->>'text') || E'
  391: ' || ${line}::text)),
  392:       '{html}', to_jsonb((owner_email->>'html') || '<p>' || replace(replace(${line}::text, '&', '&amp;'), '<', '&lt;') || '</p>'))
  393:     WHERE id = ${id} AND owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
  394:   `
  395: }
  396: 
  397: /** Undelivered obligations older than the guard whose lease is free or stale. Bounded. */
  398: export async function listPendingOwnerEmails(
  399:   olderThanMs: number,
  400:   exec: HealExec = sql,
  401:   nowMs: number = Date.now(),
  402:   leaseMs: number = OWNER_EMAIL_LEASE_MS,
  403: ): Promise<OwnerEmailClaim[]> {
  404:   const rows = await exec`
  405:     SELECT id, user_id, owner_email FROM heal_events
  406:     WHERE owner_email IS NOT NULL AND owner_email_delivered_at IS NULL
  407:       AND created_at < ${new Date(nowMs - olderThanMs)}
  408:       AND (owner_email_claimed_at IS NULL OR owner_email_claimed_at < ${new Date(nowMs - leaseMs)})
  409:     ORDER BY created_at
  410:     LIMIT 50
  411:   `
  412:   return rows as OwnerEmailClaim[]
  413: }
  414: 
  415: 
  416: 
  417: 
  418: 
  419: 
  420: 
  421: 

 succeeded in 640ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/test\heal-owner-email-outbox.test.ts:12:import { deliverOwnerEmailForRun, sweepOwnerEmails, type OwnerEmailDeps } from '../src/heal/owner-email.ts'
hub/test\heal-owner-email-outbox.test.ts:32:  owner_email: { subject: string; text: string; html: string }
hub/test\heal-owner-email-outbox.test.ts:51:    list: async () => rows.filter((r) => !r.delivered && (r.claimed_at == null || r.claimed_at < clock - LEASE)).map((r) => ({ id: r.id, user_id: r.user_id, owner_email: r.owner_email })),
hub/test\heal-owner-email-outbox.test.ts:72:    return { id: r.id, user_id: r.user_id, owner_email: r.owner_email }
hub/test\heal-owner-email-outbox.test.ts:80:      rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
hub/test\heal-owner-email-outbox.test.ts:112:    expect(w.rows[0]!.owner_email.subject).toMatch(/\[heal\]/)
hub/test\heal-owner-email-outbox.test.ts:113:    expect(w.rows[0]!.owner_email.text).toContain('run1')
hub/test\heal-owner-email-outbox.test.ts:121:    expect(w.rows[0]!.owner_email).toBeUndefined()
hub/test\heal-owner-email-outbox.test.ts:128:    await fail(w, 'run1') // claim + obligation persisted, then the hub "crashes": no deliverOwnerEmailForRun
hub/test\heal-owner-email-outbox.test.ts:130:    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
hub/test\heal-owner-email-outbox.test.ts:132:    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(0)
hub/test\heal-owner-email-outbox.test.ts:157:    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true)
hub/test\heal-owner-email-outbox.test.ts:161:    expect(await sweepOwnerEmails(60_000, w.outbox)).toBe(1)
hub/test\heal-owner-email-outbox.test.ts:169:    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
hub/test\heal-owner-email-outbox.test.ts:171:    expect(await sweepOwnerEmails(0, w.outbox)).toBe(1)
hub/test\heal-owner-email-outbox.test.ts:180:    expect(await deliverOwnerEmailForRun('run1', w.outbox)).toBe(true) // true => suppressDefaultFailureEmail
hub/test\heal-owner-email-outbox.test.ts:183:    expect(await sweepOwnerEmails(0, w.outbox)).toBe(0)
hub/test\heal-owner-email-outbox.test.ts:192:    await Promise.all([deliverOwnerEmailForRun('run1', w.outbox), sweepOwnerEmails(0, w.outbox)])
hub/test\heal-owner-email-outbox.test.ts:198:    expect(await deliverOwnerEmailForRun('nope', w.outbox)).toBe(false)
hub/test\heal-owner-email-outbox.test.ts:209:    expect(await deliverOwnerEmailForRun('run2', w.outbox)).toBe(true)
hub/test\heal-owner-email-outbox.test.ts:221:      w.rows.push({ id, user_id: args.userId, trigger_run_id: args.triggerRunId as string, owner_email: args.ownerEmail as any, claimed_at: null, delivered: false })
hub/test\heal-owner-email-outbox.test.ts:247:  test('claimHealEvent INSERT writes owner_email in the same transaction', async () => {
hub/test\heal-owner-email-outbox.test.ts:259:    expect(ins.text).toContain('owner_email')
hub/test\heal-owner-email-outbox.test.ts:267:    expect(t).toMatch(/UPDATE heal_events SET owner_email_claimed_at/)
hub/test\heal-owner-email-outbox.test.ts:268:    expect(t).toMatch(/owner_email_delivered_at IS NULL/)
hub/test\heal-owner-email-outbox.test.ts:269:    expect(t).toMatch(/owner_email_claimed_at IS NULL OR owner_email_claimed_at </)
hub/test\heal-owner-email-outbox.test.ts:276:    expect(calls[0]!.text).toMatch(/owner_email IS NOT NULL AND owner_email_delivered_at IS NULL/)

 succeeded in 649ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.

>       ? await healFailedRunHook(task, runId, error ?? null)
        : false
      await onRunFinalized(task, runId, status, error ?? null, {
        cost_usd: costUsd,
        duration_ms: dur,
        output_snippet: fields.output_snippet ?? null,
        parentFireId: ctx?.parentFireId ?? null,
        chainDepth: ctx?.chainDepth ?? 0,
        ...(healOwnsNotification ? { suppressDefaultFailureEmail: true } : {}),
      })
    }
  }
  
  /**
   * Never throws into finalizeRun. Resolves true only when the heal path claimed and sent the one
   * owner notification; any error resolves false so the normal failure email proceeds.
   */
> async function healFailedRunHook(
    task: ScheduledTask,
    runId: string,
    error: string | null,
  ): Promise<boolean> {
    try {
      const { healUnifiedEnabled } = await import('../heal/config.ts')
      if (!healUnifiedEnabled()) return false
      const { healFailedScheduledRun } = await import('../heal/sources/scheduled-task.ts')
      return await healFailedScheduledRun({ runId, status: 'failed', error, task })
    } catch (err: any) {
      log.error('scheduler.dispatcher.heal_hook_failed', { task_id: task.id, run_id: runId, error: err?.message })
      return false
    }
  }
  
  interface PostRunPayload {
    cost_usd: number | null
    duration_ms: number | null
    output_snippet: string | null
    parentFireId?: string | null
    chainDepth: number
    /** PTYCAP-07-08: the heal path already notified the owner of this failure. */
    suppressDefaultFailureEmail?: boolean
  }
  
    failed: number;
  }
  
> export async function sweepStaleHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
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
   * stranded by a quick restart (younger than the guard at boot) is swept as soon as it ages in.
   * True no-op when the heal flag is OFF (nothing read, no timer armed).
   */
> export async function bootSweepHealLaunches(deps: SweepDeps = REAL_SWEEP_DEPS): Promise<SweepResult> {
    if (!healUnifiedEnabled()) return { swept: 0, skipped: 0, failed: 0 };
>   const first = await sweepStaleHealLaunches(deps);
    const arm = deps.setTimer ?? defaultSetTimer;
    arm(() => {
>     void sweepStaleHealLaunches(deps).catch((err) => log(`follow-up sweep failed: ${err?.message ?? err}`));
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


exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n -C 4 \"finalizeRun\\(\" hub/src/scheduler/dispatcher.ts hub/src/scheduler --glob '*.ts' | Select-Object -First 250" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/heal/sources/scheduled-task.ts'; "'$l=Get-Content $p; for($i=0;$i -lt $l.Length;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/db/heal-events-dal.ts'; "'$l=Get-Content $p; for($i=125;$i -le 220;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; $p='"'hub/src/heal/notify.ts'; "'$l=Get-Content $p; for($i=0;$i -lt [Math]::Min($l.Length,260);$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status --short; git diff HEAD''^ HEAD --check; git show --name-status --format= HEAD' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 579ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
    1: // hub/src/heal/sources/scheduled-task.ts
    2: //
    3: // PTYCAP-07-08 (SH-01, SH-02, SH-07, D-05, D-11, AM-F5-1..AM-F5-4): the scheduled-task failure
    4: // source. A source that did not exist before: a failed non-internal, repo-bound task run becomes
    5: // a HealEvent for routeHeal.
    6: //
    7: // Every guard here fails CLOSED (an error means no event and no notification suppression):
    8: //   AM-F5-1  only a real failed transition: status failed and not a reaper-finalized run
    9: //            (error run_timeout - the reaper's sole marker). `only_if_active` is a CAS used by
   10: //            real senders too (work, TEAB, agent), so it is NOT a reaper marker; the caller only
   11: //            reaches here after WINNING that claim.
   12: //   AM-F5-3  recursion is impossible: internal tasks (flag OR __internal_ name) and any run in
   13: //            the ledger's heal ancestry never produce an event
   14: //   AM-F5-4  per-task daily ceiling
   15: // The caller (finalizeRun) never lets this throw into the run lifecycle.
   16: 
   17: import { createHash } from 'node:crypto';
   18: import { fenceUntrusted } from '../../dispatch/untrusted.ts';
   19: import { healMaxPerTaskDay } from '../config.ts';
   20: import { isInternalScheduledTask } from '../internal-task.ts';
   21: import { canonicalRepoIdent, type RepoIdentSession } from '../repo-ident.ts';
   22: import type { HealOutcome } from '../types.ts';
   23: import { buildNotification } from '../notify.ts';
   24: 
   25: export interface HealableTask {
   26:   id: string;
   27:   name?: string | null;
   28:   user_id: string;
   29:   session_id?: string | null;
   30:   is_internal?: boolean | null;
   31: }
   32: 
   33: export interface FailedRunInput {
   34:   runId: string;
   35:   status: string;
   36:   error: string | null | undefined;
   37:   task: HealableTask;
   38:   /**
   39:    * True when the scheduler's default failure email applies to this run. The pending email is then
   40:    * persisted with the heal claim (outbox) so it survives a crash before the scheduler sends it.
   41:    */
   42:   persistOwnerEmail?: boolean;
   43: }
   44: 
   45: export interface ScheduledSourceDeps {
   46:   /** Throws on a probe error: the caller fails closed. */
   47:   isHealGenerated(runId: string): Promise<boolean>;
   48:   getSession(sessionId: string, userId: string): Promise<(RepoIdentSession & { runner_type?: string | null }) | null>;
   49:   countTaskClaimsToday(userId: string, taskId: string): Promise<number>;
   50:   routeHeal(event: unknown): Promise<HealOutcome>;
   51: }
   52: 
   53: /** Real collaborators: lazy imports so importing this module never loads the DB or the route. */
   54: export const REAL_SCHEDULED_SOURCE_DEPS: ScheduledSourceDeps = {
   55:   isHealGenerated: async (runId) => (await import('../../db/heal-events-dal.ts')).isHealGenerated(runId),
   56:   getSession: async (sessionId, userId) => {
   57:     const { getSession } = await import('../../db/dal.ts');
   58:     return (await getSession(sessionId, userId)) as (RepoIdentSession & { runner_type?: string | null }) | null;
   59:   },
   60:   countTaskClaimsToday: async (userId, taskId) => (await import('../../db/heal-events-dal.ts')).countTaskClaimsToday(userId, taskId),
   61:   routeHeal: async (event) => (await import('../route.ts')).routeHeal(event),
   62: };
   63: 
   64: /** Lowercased, uuid/hex/digit runs collapsed, whitespace squeezed, trimmed to 200 chars. */
   65: export function normalizeError(error: string | null | undefined): string {
   66:   return (error ?? '')
   67:     .toLowerCase()
   68:     .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
   69:     .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
   70:     .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
   71:     .replace(/\d+/g, '<n>')
   72:     .replace(/\s+/g, ' ')
   73:     .trim()
   74:     .slice(0, 200);
   75: }
   76: 
   77: function oneLine(s: string | null | undefined, max: number): string {
   78:   return (s ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
   79: }
   80: 
   81: /**
   82:  * Heal a failed scheduled-task run. Resolves true ONLY when the heal path WON the owner
   83:  * notification claim for this event (the caller then suppresses the default failure email), whether
   84:  * or not that one send succeeded; every other result, including every error, resolves false so the
   85:  * normal failure email proceeds. Exactly one owner notification per heal event.
   86:  */
   87: export async function healFailedScheduledRun(
   88:   input: FailedRunInput,
   89:   deps: ScheduledSourceDeps = REAL_SCHEDULED_SOURCE_DEPS,
   90: ): Promise<boolean> {
   91:   const { runId, status, error, task } = input;
   92:   if (status !== 'failed') return false;
   93:   if ((error ?? '').startsWith('run_timeout')) return false;
   94:   if (isInternalScheduledTask(task)) return false;
   95:   if (!task.session_id) return false;
   96: 
   97:   try {
   98:     if (await deps.isHealGenerated(runId)) return false;
   99:   } catch {
  100:     return false; // fail closed
  101:   }
  102: 
  103:   const session = await deps.getSession(task.session_id, task.user_id);
  104:   if (!session) return false;
  105:   const repoIdent = canonicalRepoIdent(session);
  106:   if (!repoIdent) return false;
  107: 
  108:   if ((await deps.countTaskClaimsToday(task.user_id, task.id)) >= healMaxPerTaskDay()) return false;
  109: 
  110:   const normalized = normalizeError(error);
  111:   const signature = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  112:   const name = oneLine(task.name, 120);
  113:   const prompt = [
  114:     'A scheduled task run failed. Investigate the root cause in this repository and propose a fix as a pull request only.',
  115:     'Do not push to main, merge or deploy.',
  116:     '',
  117:     fenceUntrusted('untrusted_task_failure', [`Task: ${name}`, `Run: ${runId}`, `Error: ${error ?? '(none)'}`].join('\n'), 4000),
  118:   ].join('\n');
  119: 
  120:   const ownerEmail = input.persistOwnerEmail
  121:     ? buildNotification(
  122:         {
  123:           user_id: task.user_id,
  124:           source: 'scheduled_task',
  125:           dedupe_key: `task:${task.id}`,
  126:           repo_ident: repoIdent,
  127:           notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`,
  128:         },
  129:         'scheduled task failed',
  130:       )
  131:     : null;
  132: 
  133:   const outcome = await deps.routeHeal({
  134:     source: 'scheduled_task',
  135:     user_id: task.user_id,
  136:     repo_ident: repoIdent,
  137:     prompt,
  138:     stored_content: `[task failed: ${name}]\n\n${prompt}`,
  139:     metadata_run_id: null,
  140:     trigger_run_id: runId,
  141:     dedupe_key: `task:${task.id}:${signature}`,
  142:     bound_session_id: task.session_id,
  143:     ...(ownerEmail ? { owner_email: ownerEmail } : {}),
  144:     notify_summary: `Task "${name}" run ${runId} failed: ${oneLine(error, 300)}`.slice(0, 500),
  145:     ctx: { task_id: task.id, task_name: name, error_signature: normalized },
  146:   });
  147:   if ('notifyClaimed' in outcome && outcome.notifyClaimed === true) return true;
  148:   return 'notified' in outcome && outcome.notified === true;
  149: }

 succeeded in 598ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/scheduler/dispatcher.ts-366-    try {
hub/src/scheduler/dispatcher.ts-367-      const { sendTriage } = await import('./senders/triage.ts')
hub/src/scheduler/dispatcher.ts-368-      void sendTriage(task, ctx, (task.payload ?? {}) as any).catch((err: any) => {
hub/src/scheduler/dispatcher.ts-369-        log.error('scheduler.dispatcher.triage_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler/dispatcher.ts:370:        void finalizeRun(run.id, 'failed', err?.message || 'triage_threw')
hub/src/scheduler/dispatcher.ts-371-      })
hub/src/scheduler/dispatcher.ts-372-    } catch (err: any) {
hub/src/scheduler/dispatcher.ts:373:      void finalizeRun(run.id, 'failed', err?.message || 'triage_import_failed')
hub/src/scheduler/dispatcher.ts-374-    }
hub/src/scheduler/dispatcher.ts-375-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler/dispatcher.ts-376-    runIds.push(run.id)
hub/src/scheduler/dispatcher.ts-377-    return { runIds }
--
hub/src/scheduler/dispatcher.ts-417-    try {
hub/src/scheduler/dispatcher.ts-418-      const { sendTeabTask } = await import('./senders/teab.ts')
hub/src/scheduler/dispatcher.ts-419-      void sendTeabTask(task, ctx).catch((err: any) => {
hub/src/scheduler/dispatcher.ts-420-        log.error('scheduler.dispatcher.teab_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler/dispatcher.ts:421:        void finalizeRun(run.id, 'failed', err?.message || 'teab_threw')
hub/src/scheduler/dispatcher.ts-422-      })
hub/src/scheduler/dispatcher.ts-423-    } catch (err: any) {
hub/src/scheduler/dispatcher.ts:424:      void finalizeRun(run.id, 'failed', err?.message || 'teab_import_failed')
hub/src/scheduler/dispatcher.ts-425-    }
hub/src/scheduler/dispatcher.ts-426-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler/dispatcher.ts-427-    runIds.push(run.id)
hub/src/scheduler/dispatcher.ts-428-    return { runIds }
--
hub/src/scheduler/dispatcher.ts-471-    try {
hub/src/scheduler/dispatcher.ts-472-      const { sendWorkTask } = await import('./senders/work.ts')
hub/src/scheduler/dispatcher.ts-473-      void sendWorkTask(task, ctx).catch((err: any) => {
hub/src/scheduler/dispatcher.ts-474-        log.error('scheduler.dispatcher.work_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler/dispatcher.ts:475:        void finalizeRun(run.id, 'failed', err?.message || 'work_threw')
hub/src/scheduler/dispatcher.ts-476-      })
hub/src/scheduler/dispatcher.ts-477-    } catch (err: any) {
hub/src/scheduler/dispatcher.ts:478:      void finalizeRun(run.id, 'failed', err?.message || 'work_import_failed')
hub/src/scheduler/dispatcher.ts-479-    }
hub/src/scheduler/dispatcher.ts-480-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler/dispatcher.ts-481-    runIds.push(run.id)
hub/src/scheduler/dispatcher.ts-482-    return { runIds }
--
hub/src/scheduler/dispatcher.ts-662-    }
hub/src/scheduler/dispatcher.ts-663-
hub/src/scheduler/dispatcher.ts-664-    void routeToSender(task, ctx).catch((err) => {
hub/src/scheduler/dispatcher.ts-665-      log.error('scheduler.dispatcher.sender_failed', { task_id: task.id, run_id: run.id, error: err?.message ?? String(err) })
hub/src/scheduler/dispatcher.ts:666:      void finalizeRun(run.id, 'failed', err?.message || 'sender_threw')
hub/src/scheduler/dispatcher.ts-667-    })
hub/src/scheduler/dispatcher.ts-668-  }
hub/src/scheduler/dispatcher.ts-669-
hub/src/scheduler/dispatcher.ts-670-  if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
--
hub/src/scheduler/dispatcher.ts-692-  // it here skipped every normal log_check/dev task — never do that.
hub/src/scheduler/dispatcher.ts-693-  if (task.task_type === 'orchestrator') {
hub/src/scheduler/dispatcher.ts-694-    const { isOrchestratorEnabled } = await import('../orchestrator/controller.ts')
hub/src/scheduler/dispatcher.ts-695-    const reason = isOrchestratorEnabled() ? 'orchestrator_due_tick_owned' : 'orchestrator_disabled'
hub/src/scheduler/dispatcher.ts:696:    await finalizeRun(ctx.runId, 'skipped', reason)
hub/src/scheduler/dispatcher.ts-697-    return
hub/src/scheduler/dispatcher.ts-698-  }
hub/src/scheduler/dispatcher.ts-699-  switch (task.task_type) {
hub/src/scheduler/dispatcher.ts-700-    // Phase 11: user-pickable workflow roots + chained step kinds route to
--
hub/src/scheduler/dispatcher.ts-736-    }
hub/src/scheduler/dispatcher.ts-737-  }
hub/src/scheduler/dispatcher.ts-738-}
hub/src/scheduler/dispatcher.ts-739-
hub/src/scheduler/dispatcher.ts:740:export async function finalizeRun(
hub/src/scheduler/dispatcher.ts-741-  runId: string,
hub/src/scheduler/dispatcher.ts-742-  status: RunStatus,
hub/src/scheduler/dispatcher.ts-743-  error?: string | null,
hub/src/scheduler/dispatcher.ts-744-  fields: {
--
hub/src/scheduler/dispatcher.ts-896-  }
hub/src/scheduler/dispatcher.ts-897-  if (ctx?.target?.supervisorSocket) {
hub/src/scheduler/dispatcher.ts-898-    try { ctx.target.supervisorSocket.send(JSON.stringify({ type: 'run_cancel', run_id: runId })) } catch {}
hub/src/scheduler/dispatcher.ts-899-  }
hub/src/scheduler/dispatcher.ts:900:  await finalizeRun(runId, 'cancelled', 'cancelled_by_user')
hub/src/scheduler/dispatcher.ts-901-  return true
hub/src/scheduler/dispatcher.ts-902-}
--
hub/src/scheduler\dispatcher.ts-366-    try {
hub/src/scheduler\dispatcher.ts-367-      const { sendTriage } = await import('./senders/triage.ts')
hub/src/scheduler\dispatcher.ts-368-      void sendTriage(task, ctx, (task.payload ?? {}) as any).catch((err: any) => {
hub/src/scheduler\dispatcher.ts-369-        log.error('scheduler.dispatcher.triage_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler\dispatcher.ts:370:        void finalizeRun(run.id, 'failed', err?.message || 'triage_threw')
hub/src/scheduler\dispatcher.ts-371-      })
hub/src/scheduler\dispatcher.ts-372-    } catch (err: any) {
hub/src/scheduler\dispatcher.ts:373:      void finalizeRun(run.id, 'failed', err?.message || 'triage_import_failed')
hub/src/scheduler\dispatcher.ts-374-    }
hub/src/scheduler\dispatcher.ts-375-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler\dispatcher.ts-376-    runIds.push(run.id)
hub/src/scheduler\dispatcher.ts-377-    return { runIds }
--
hub/src/scheduler\dispatcher.ts-417-    try {
hub/src/scheduler\dispatcher.ts-418-      const { sendTeabTask } = await import('./senders/teab.ts')
hub/src/scheduler\dispatcher.ts-419-      void sendTeabTask(task, ctx).catch((err: any) => {
hub/src/scheduler\dispatcher.ts-420-        log.error('scheduler.dispatcher.teab_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler\dispatcher.ts:421:        void finalizeRun(run.id, 'failed', err?.message || 'teab_threw')
hub/src/scheduler\dispatcher.ts-422-      })
hub/src/scheduler\dispatcher.ts-423-    } catch (err: any) {
hub/src/scheduler\dispatcher.ts:424:      void finalizeRun(run.id, 'failed', err?.message || 'teab_import_failed')
hub/src/scheduler\dispatcher.ts-425-    }
hub/src/scheduler\dispatcher.ts-426-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler\dispatcher.ts-427-    runIds.push(run.id)
hub/src/scheduler\dispatcher.ts-428-    return { runIds }
--
hub/src/scheduler\dispatcher.ts-471-    try {
hub/src/scheduler\dispatcher.ts-472-      const { sendWorkTask } = await import('./senders/work.ts')
hub/src/scheduler\dispatcher.ts-473-      void sendWorkTask(task, ctx).catch((err: any) => {
hub/src/scheduler\dispatcher.ts-474-        log.error('scheduler.dispatcher.work_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
hub/src/scheduler\dispatcher.ts:475:        void finalizeRun(run.id, 'failed', err?.message || 'work_threw')
hub/src/scheduler\dispatcher.ts-476-      })
hub/src/scheduler\dispatcher.ts-477-    } catch (err: any) {
hub/src/scheduler\dispatcher.ts:478:      void finalizeRun(run.id, 'failed', err?.message || 'work_import_failed')
hub/src/scheduler\dispatcher.ts-479-    }
hub/src/scheduler\dispatcher.ts-480-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src/scheduler\dispatcher.ts-481-    runIds.push(run.id)
hub/src/scheduler\dispatcher.ts-482-    return { runIds }
--
hub/src/scheduler\dispatcher.ts-662-    }
hub/src/scheduler\dispatcher.ts-663-
hub/src/scheduler\dispatcher.ts-664-    void routeToSender(task, ctx).catch((err) => {
hub/src/scheduler\dispatcher.ts-665-      log.error('scheduler.dispatcher.sender_failed', { task_id: task.id, run_id: run.id, error: err?.message ?? String(err) })
hub/src/scheduler\dispatcher.ts:666:      void finalizeRun(run.id, 'failed', err?.message || 'sender_threw')
hub/src/scheduler\dispatcher.ts-667-    })
hub/src/scheduler\dispatcher.ts-668-  }
hub/src/scheduler\dispatcher.ts-669-
hub/src/scheduler\dispatcher.ts-670-  if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
--
hub/src/scheduler\dispatcher.ts-692-  // it here skipped every normal log_check/dev task — never do that.
hub/src/scheduler\dispatcher.ts-693-  if (task.task_type === 'orchestrator') {
hub/src/scheduler\dispatcher.ts-694-    const { isOrchestratorEnabled } = await import('../orchestrator/controller.ts')
hub/src/scheduler\dispatcher.ts-695-    const reason = isOrchestratorEnabled() ? 'orchestrator_due_tick_owned' : 'orchestrator_disabled'
hub/src/scheduler\dispatcher.ts:696:    await finalizeRun(ctx.runId, 'skipped', reason)
hub/src/scheduler\dispatcher.ts-697-    return
hub/src/scheduler\dispatcher.ts-698-  }
hub/src/scheduler\dispatcher.ts-699-  switch (task.task_type) {
hub/src/scheduler\dispatcher.ts-700-    // Phase 11: user-pickable workflow roots + chained step kinds route to
--
hub/src/scheduler\dispatcher.ts-736-    }
hub/src/scheduler\dispatcher.ts-737-  }
hub/src/scheduler\dispatcher.ts-738-}
hub/src/scheduler\dispatcher.ts-739-
hub/src/scheduler\dispatcher.ts:740:export async function finalizeRun(
hub/src/scheduler\dispatcher.ts-741-  runId: string,
hub/src/scheduler\dispatcher.ts-742-  status: RunStatus,
hub/src/scheduler\dispatcher.ts-743-  error?: string | null,
hub/src/scheduler\dispatcher.ts-744-  fields: {
--
hub/src/scheduler\dispatcher.ts-896-  }
hub/src/scheduler\dispatcher.ts-897-  if (ctx?.target?.supervisorSocket) {
hub/src/scheduler\dispatcher.ts-898-    try { ctx.target.supervisorSocket.send(JSON.stringify({ type: 'run_cancel', run_id: runId })) } catch {}
hub/src/scheduler\dispatcher.ts-899-  }
hub/src/scheduler\dispatcher.ts:900:  await finalizeRun(runId, 'cancelled', 'cancelled_by_user')
hub/src/scheduler\dispatcher.ts-901-  return true
hub/src/scheduler\dispatcher.ts-902-}
--
hub/src/scheduler\run-reaper.ts-129-    const age = now - run.started_at_ms
hub/src/scheduler\run-reaper.ts-130-    const ceiling = reapCeilingMs(run.task_type)
hub/src/scheduler\run-reaper.ts-131-    if (!(age >= ceiling)) continue
hub/src/scheduler\run-reaper.ts-132-    try {
hub/src/scheduler\run-reaper.ts:133:      await d.finalizeRun(run.id, 'failed', 'run_timeout', { only_if_active: true })
hub/src/scheduler\run-reaper.ts-134-      reaped.push(run.id)
hub/src/scheduler\run-reaper.ts-135-      try {
hub/src/scheduler\run-reaper.ts-136-        await d.releaseSlot(run.id)
hub/src/scheduler\run-reaper.ts-137-      } catch (err: any) {
--
hub/src/scheduler\senders\agent.ts-18- * `dispatch.onSessionReply(sessionId, content)`, which fires `RunStore.onFinalize`
hub/src/scheduler\senders\agent.ts-19- * for the in-flight scheduled run and promotes/re-dispatches any queued run
hub/src/scheduler\senders\agent.ts-20- * through the full gate list again (so a user who crossed the cap while queued
hub/src/scheduler\senders\agent.ts-21- * is skipped — IR-2). `onFinalize` carries the exact legacy
hub/src/scheduler\senders\agent.ts:22: * `onAssistantMessage` behaviour: `finalizeRun(success, …)` which triggers the
hub/src/scheduler\senders\agent.ts-23- * post-run action pipeline (chain/email/telegram/webhook/github-issue).
hub/src/scheduler\senders\agent.ts-24- *
hub/src/scheduler\senders\agent.ts-25- * Scope: ONLY the session send→queue→grace→finalize path moved. Cron, fan-out,
hub/src/scheduler\senders\agent.ts-26- * cost-cap audit rows, target resolution, supervisor/coolify senders, triage
--
hub/src/scheduler\senders\agent.ts-269- * existing run via `finalizeRun`.
hub/src/scheduler\senders\agent.ts-270- */
hub/src/scheduler\senders\agent.ts-271-export async function sendAgentTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
hub/src/scheduler\senders\agent.ts-272-  const sessionId = ctx.target.sessionId
hub/src/scheduler\senders\agent.ts:273:  if (!sessionId) { await finalizeRun(ctx.runId, 'failed', 'no_session_id'); return }
hub/src/scheduler\senders\agent.ts-274-
hub/src/scheduler\senders\agent.ts-275-  const content = buildContent(task)
hub/src/scheduler\senders\agent.ts:276:  if (!content) { await finalizeRun(ctx.runId, 'failed', 'empty_content'); return }
hub/src/scheduler\senders\agent.ts-277-
hub/src/scheduler\senders\agent.ts-278-  // Phase 11: build + persist the runtime context snapshot, then prepend the
hub/src/scheduler\senders\agent.ts-279-  // `## RUNTIME CONTEXT` block to the SENT message only. The STORED content
hub/src/scheduler\senders\agent.ts-280-  // (chat history) and the snapshot column never carry the Summary directive;
--
hub/src/scheduler\senders\agent.ts-308-    const attempt = await maybeLaunchOfflineSession({ userId: ctx.userId, sessionId })
hub/src/scheduler\senders\agent.ts-309-    if (typeof attempt === 'object') {
hub/src/scheduler\senders\agent.ts-310-      // Definitive non-launchable reason (at_capacity / ambiguous / …). Skip the
hub/src/scheduler\senders\agent.ts-311-      // run with that specific reason — informative, not a bare target_offline.
hub/src/scheduler\senders\agent.ts:312:      await finalizeRun(ctx.runId, 'skipped', attempt.skip)
hub/src/scheduler\senders\agent.ts-313-      return
hub/src/scheduler\senders\agent.ts-314-    }
hub/src/scheduler\senders\agent.ts-315-    if (attempt === 'launch_pending') {
hub/src/scheduler\senders\agent.ts-316-      // A launch for this session is already in flight (one grace entry per
hub/src/scheduler\senders\agent.ts-317-      // session). Skip this fire to avoid a duplicate session.start and a second
hub/src/scheduler\senders\agent.ts-318-      // parked replay — the earlier parked run delivers once the session is up.
hub/src/scheduler\senders\agent.ts:319:      await finalizeRun(ctx.runId, 'skipped', 'launch_pending')
hub/src/scheduler\senders\agent.ts-320-      return
hub/src/scheduler\senders\agent.ts-321-    }
hub/src/scheduler\senders\agent.ts-322-    if (attempt === 'park' && ctx.isManual) {
hub/src/scheduler\senders\agent.ts-323-      // Host offline + manual run: keep immediate UI feedback (fail fast) rather
hub/src/scheduler\senders\agent.ts-324-      // than leaving a pending row to expire — legacy parity.
hub/src/scheduler\senders\agent.ts:325:      await finalizeRun(ctx.runId, 'failed', 'target_offline')
hub/src/scheduler\senders\agent.ts-326-      return
hub/src/scheduler\senders\agent.ts-327-    }
hub/src/scheduler\senders\agent.ts-328-    // attempt === 'launched'  → fall through to dispatch(); it parks the run in
hub/src/scheduler\senders\agent.ts-329-    //                           grace, drained when the launched session connects.
--
hub/src/scheduler\senders\agent.ts-341-    // cost-cap re-check on promotion) or 'session_busy' (queue drop). Map onto
hub/src/scheduler\senders\agent.ts-342-    // the existing run via finalizeRun so post-run / history stay consistent.
hub/src/scheduler\senders\agent.ts-343-    async markSkipped(token, reason) {
hub/src/scheduler\senders\agent.ts-344-      const status = reason.startsWith('quota_threshold_reached') ? 'skipped_quota' : 'skipped'
hub/src/scheduler\senders\agent.ts:345:      await finalizeRun(token, status, reason)
hub/src/scheduler\senders\agent.ts-346-      clearActive(sessionId, token)
hub/src/scheduler\senders\agent.ts-347-    },
hub/src/scheduler\senders\agent.ts-348-    // The exact legacy `onAssistantMessage` body: finalize the run as success
hub/src/scheduler\senders\agent.ts-349-    // with the reply snippet. `finalizeRun` fires the post-run action pipeline.
--
hub/src/scheduler\senders\agent.ts-353-      // `only_if_active`: a reply can land AFTER the stale-run reaper already
hub/src/scheduler\senders\agent.ts-354-      // finalized this run as run_timeout (> REMO_RUN_MAX_MS). The claim guard
hub/src/scheduler\senders\agent.ts-355-      // makes the late write a no-op instead of clobbering the row and re-firing
hub/src/scheduler\senders\agent.ts-356-      // the post-run chain a second time.
hub/src/scheduler\senders\agent.ts:357:      await finalizeRun(token, 'success', null, {
hub/src/scheduler\senders\agent.ts-358-        duration_ms: duration, output_snippet: snippet, only_if_active: true,
hub/src/scheduler\senders\agent.ts-359-      })
hub/src/scheduler\senders\agent.ts-360-      removeRunContext(token)
hub/src/scheduler\senders\agent.ts-361-      clearActive(sessionId, token)
hub/src/scheduler\senders\agent.ts-362-    },
hub/src/scheduler\senders\agent.ts-363-    async markFailed(token, errMsg) {
hub/src/scheduler\senders\agent.ts:364:      await finalizeRun(token, 'failed', `agent_send_failed: ${errMsg}`)
hub/src/scheduler\senders\agent.ts-365-      clearActive(sessionId, token)
hub/src/scheduler\senders\agent.ts-366-    },
hub/src/scheduler\senders\agent.ts-367-  }
hub/src/scheduler\senders\agent.ts-368-
--
hub/src/scheduler\senders\agent.ts-398-      await sendAgentTask(task, ctx)
hub/src/scheduler\senders\agent.ts-399-    },
hub/src/scheduler\senders\agent.ts-400-    // Grace TTL lapse → legacy expire-mark (skipped/target_offline).
hub/src/scheduler\senders\agent.ts-401-    onParkExpire: async () => {
hub/src/scheduler\senders\agent.ts:402:      await finalizeRun(ctx.runId, 'skipped', 'target_offline')
hub/src/scheduler\senders\agent.ts-403-      clearActive(sessionId, ctx.runId)
hub/src/scheduler\senders\agent.ts-404-    },
hub/src/scheduler\senders\agent.ts-405-    // Ship the user_message: persist chat history, broadcast it, forward on the
hub/src/scheduler\senders\agent.ts-406-    // agent socket WITH the runtime block + Summary directive (sent string only).
--
hub/src/scheduler\senders\coolify.ts-52-
hub/src/scheduler\senders\coolify.ts-53-export async function sendLogCheck(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
hub/src/scheduler\senders\coolify.ts-54-  const token = process.env.COOLIFY_TOKEN

 succeeded in 598ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  126: 
  127: export async function claimHealEvent(args: ClaimHealArgs, exec: HealExec = sql): Promise<ClaimHealResult> {
  128:   const now = args.nowMs ?? Date.now()
  129:   const bucket = windowBucket(now, args.windowMs) // throws RangeError on a bad window
  130:   if (!Number.isFinite(args.maxClaimsPerUserHour) || args.maxClaimsPerUserHour <= 0) {
  131:     throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
  132:   }
  133: 
  134:   // Opportunistic bounded reap, outside the lock. A reap failure must not block a claim.
  135:   try {
  136:     await pruneHealEvents(args.retentionHours, exec, now)
  137:   } catch (err: any) {
  138:     console.warn(`[heal-events] opportunistic prune failed: ${err?.message ?? err}`)
  139:   }
  140: 
  141:   const windowStart = new Date(now - args.windowMs)
  142:   const hourStart = new Date(now - HOUR_MS)
  143:   const createdAt = new Date(now)
  144: 
  145:   return exec.begin(async (tx: HealExec): Promise<ClaimHealResult> => {
  146:     // (a) per-(user, source, key) lock FIRST, then (c) per-user lock: fixed order, no deadlock.
  147:     await tx`
  148:       SELECT pg_advisory_xact_lock(
  149:         hashtext(${'heal:' + args.userId + ':' + args.source + ':' + args.dedupeKey})::bigint
  150:       )
  151:     `
  152:     if (args.triggerRunId) {
  153:       const seen = await tx`
  154:         SELECT 1 AS one FROM heal_events
  155:         WHERE source = ${args.source} AND trigger_run_id = ${args.triggerRunId}
  156:         LIMIT 1
  157:       `
  158:       if (seen.length > 0) return { ok: false, reason: 'duplicate' }
  159:     }
  160:     // (b) REAL elapsed window, not just the bucket.
  161:     const inWindow = await tx`
  162:       SELECT 1 AS one FROM heal_events
  163:       WHERE user_id = ${args.userId} AND source = ${args.source} AND dedupe_key = ${args.dedupeKey}
  164:         AND created_at > ${windowStart}
  165:       LIMIT 1
  166:     `
  167:     if (inWindow.length > 0) return { ok: false, reason: 'duplicate' }
  168: 
  169:     await tx`SELECT pg_advisory_xact_lock(hashtext(${'heal-user:' + args.userId})::bigint)`
  170:     const counted = await tx`
  171:       SELECT count(*)::text AS n FROM heal_events
  172:       WHERE user_id = ${args.userId} AND created_at > ${hourStart}
  173:     `
  174:     if (Number(counted[0]?.n ?? 0) >= args.maxClaimsPerUserHour) return { ok: false, reason: 'user_claim_cap' }
  175: 
  176:     // (c2) per-task daily ceiling, counted under the per-user lock taken above.
  177:     const taskId = args.maxPerTaskDay != null ? taskIdOf(args.dedupeKey) : null
  178:     if (taskId) {
  179:       const tc = await tx`
  180:         SELECT count(*)::text AS n FROM heal_events
  181:         WHERE user_id = ${args.userId} AND starts_with(dedupe_key, ${'task:' + taskId + ':'})
  182:           AND created_at > ${new Date(now - 24 * HOUR_MS)}
  183:       `
  184:       if (Number(tc[0]?.n ?? 0) >= (args.maxPerTaskDay as number)) return { ok: false, reason: 'task_day_cap' }
  185:     }
  186: 
  187:     // (c3) per-repository hourly ceiling, same lock. In-flight rows (NULL outcome) count, so
  188:     // concurrent claims on distinct dedupe keys see each other. At the ceiling the row is still
  189:     // recorded, already refused, so the router terminalizes and notifies exactly as before.
  190:     let preOutcome: string | null = null
  191:     if (args.maxPerRepoHour != null && args.repoIdent) {
  192:       const rc = await tx`
  193:         SELECT count(*)::text AS n FROM heal_events
  194:         WHERE user_id = ${args.userId} AND repo_ident = ${args.repoIdent}
  195:           AND created_at > ${hourStart}
  196:           AND (outcome IS NULL OR outcome IN ('dispatched_live', 'dispatched_after_spawn',
  197:                                               'autospawn_starting', 'autospawn_launched', 'autospawn_parked'))
  198:       `
  199:       if (Number(rc[0]?.n ?? 0) >= args.maxPerRepoHour) preOutcome = REPO_RATE_BOUND_OUTCOME
  200:     }
  201: 
  202:     // (d) INSERT; the unique indexes are the backstop - an empty return means duplicate.
  203:     const inserted = await tx`
  204:       INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, outcome, recovery_ctx, owner_email, created_at, updated_at)
  205:       VALUES (${args.userId}, ${args.source}, ${args.repoIdent ?? null}, ${args.dedupeKey}, ${bucket},
  206:               ${args.triggerRunId ?? null}, ${preOutcome}, ${args.recoveryCtx ? JSON.stringify(args.recoveryCtx) : null}::jsonb,
  207:               ${args.ownerEmail ? JSON.stringify(args.ownerEmail) : null}::jsonb, ${createdAt}, ${createdAt})
  208:       ON CONFLICT DO NOTHING
  209:       RETURNING id
  210:     `
  211:     if (inserted.length === 0) return { ok: false, reason: 'duplicate' }
  212:     return preOutcome
  213:       ? { ok: true, id: inserted[0].id as string, repoRateBound: true }
  214:       : { ok: true, id: inserted[0].id as string }
  215:   })
  216: }
  217: 
  218: /** True exactly once per id: the caller that wins owns the single send attempt. */
  219: export async function claimHealNotification(id: string, exec: HealExec = sql): Promise<boolean> {
  220:   const rows = await exec`
  221:     UPDATE heal_events SET notification_claimed_at = now(), updated_at = now()
    1: // hub/src/heal/notify.ts
    2: //
    3: // PTYCAP-07-06 (SH-05, D-05, AM-F3-2, T-07-22/T-07-23): the single owner notification for an
    4: // un-routable, refused or failed heal event.
    5: //
    6: // Guarantee: exactly ONE SEND ATTEMPT per ledger row, NOT exactly-once delivery. Ownership is a
    7: // conditional UPDATE on the ledger row (claimHealNotification): the caller that wins the claim
    8: // makes one send attempt through the injected seam; a lost claim sends nothing; a send that
    9: // returns false or throws is logged and NEVER retried (the claim stays set - no outbox). It
   10: // never throws: a notification failure must not change a routing outcome.
   11: 
   12: import { asciiPunctuation } from './prompt.ts';
   13: 
   14: export interface NotifyEvent {
   15:   user_id: string;
   16:   source: string;
   17:   dedupe_key: string;
   18:   repo_ident: string | null;
   19:   notify_summary?: string;
   20: }
   21: 
   22: export interface NotifyDeps {
   23:   /** True exactly once per event id (conditional UPDATE on the ledger row). */
   24:   claim(eventId: string): Promise<boolean>;
   25:   /** The owner address, or null when none resolves. */
   26:   resolveOwnerEmail(userId: string): Promise<string | null>;
   27:   send(msg: { to: string; subject: string; html: string; text: string }): Promise<boolean>;
   28: }
   29: 
   30: /** Real seam: lazy imports so importing this module never loads the DB. */
   31: export const REAL_NOTIFY_DEPS: NotifyDeps = {
   32:   claim: async (id) => (await import('../db/heal-events-dal.ts')).claimHealNotification(id),
   33:   resolveOwnerEmail: async (userId) => {
   34:     const { getUserById } = await import('../db/dal.ts');
   35:     const user = (await getUserById(userId)) as { email?: string } | null;
   36:     return user?.email ?? null;
   37:   },
   38:   send: async (msg) => (await import('../lib/email.ts')).sendEmail(msg),
   39: };
   40: 
   41: function log(msg: string): void {
   42:   console.error(`[heal.notify] ${msg}`);
   43: }
   44: 
   45: /** ASCII-only, single-line, length-capped. Untrusted text never reaches the body unbounded. */
   46: function clean(text: string, max: number): string {
   47:   return asciiPunctuation(text)
   48:     .replace(/[\r\n\t]+/g, ' ')
   49:     .replace(/[^\x20-\x7E]/g, '?')
   50:     .slice(0, max);
   51: }
   52: 
   53: function escapeHtml(s: string): string {
   54:   return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
   55: }
   56: 
   57: export function buildNotification(event: NotifyEvent, reason: string): { subject: string; text: string; html: string } {
   58:   const repo = event.repo_ident ? clean(event.repo_ident, 200) : 'unknown repo';
   59:   const why = clean(reason, 200);
   60:   const lines = [
   61:     `Self-heal could not act on a failure for ${repo}.`,
   62:     `Reason: ${why}`,
   63:     `Source: ${clean(event.source, 40)}`,
   64:     `Dedupe key: ${clean(event.dedupe_key, 200)}`,
   65:   ];
   66:   if (event.notify_summary) lines.push(`Summary: ${clean(event.notify_summary, 500)}`);
   67:   return {
   68:     subject: `[heal] ${repo}: ${why}`.slice(0, 300),
   69:     text: lines.join('\n'),
   70:     html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
   71:   };
   72: }
   73: 
   74: /**
   75:  * Ownership vs delivery are separate facts. `claimed` = this caller won the conditional-UPDATE
   76:  * ownership claim (so no other path may notify for this event); `sent` = the single send attempt
   77:  * reported success. A claimed-but-unsent notification is still OWNED: the caller must not fall
   78:  * back to another notifier (the scheduler default email), or the owner gets two.
   79:  */
   80: export interface NotifyResult {
   81:   claimed: boolean;
   82:   sent: boolean;
   83: }
   84: 
   85: export async function notifyOnceDetailed(
   86:   eventId: string,
   87:   event: NotifyEvent,
   88:   reason: string,
   89:   deps: NotifyDeps = REAL_NOTIFY_DEPS,
   90: ): Promise<NotifyResult> {
   91:   let claimed = false;
   92:   try {
   93:     if (!(await deps.claim(eventId))) return { claimed: false, sent: false }; // lost claim: someone else owns the attempt
   94:     claimed = true;
   95:     const to = await deps.resolveOwnerEmail(event.user_id);
   96:     if (!to) {
   97:       log(`no owner address for event ${eventId}; not sent`);
   98:       return { claimed, sent: false };
   99:     }
  100:     const ok = await deps.send({ to, ...buildNotification(event, reason) });
  101:     if (!ok) log(`send reported failure for event ${eventId}; not retried`);
  102:     return { claimed, sent: ok === true };
  103:   } catch (err: any) {
  104:     log(`notify failed for event ${eventId}: ${err?.message ?? err}; not retried`);
  105:     return { claimed, sent: false };
  106:   }
  107: }
  108: 
  109: /** Returns true only when the single send attempt reported success. */
  110: export async function notifyOnce(
  111:   eventId: string,
  112:   event: NotifyEvent,
  113:   reason: string,
  114:   deps: NotifyDeps = REAL_NOTIFY_DEPS,
  115: ): Promise<boolean> {
  116:   return (await notifyOnceDetailed(eventId, event, reason, deps)).sent;
  117: }

 succeeded in 763ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
M	hub/src/db/heal-events-dal.ts
M	hub/src/db/schema.sql
A	hub/src/heal/owner-email.ts
M	hub/src/heal/route.ts
M	hub/src/heal/sources/scheduled-task.ts
M	hub/src/heal/sweep.ts
M	hub/src/heal/types.ts
M	hub/src/scheduler/dispatcher.ts
M	hub/src/scheduler/post-run/dispatcher.ts
A	hub/test/heal-owner-email-outbox.test.ts

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 5 "target_kind.*all_agents|all_agents.*session_id|session_id.*target_kind" hub/src web/src hub/test | Select-Object -First 250' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/scheduler/targets.ts'; if(Test-Path "'$p){Get-Content $p}; rg -n "resolveTargets" hub/src/scheduler' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/db/scheduled-tasks-dal.ts'; "'$l=Get-Content $p; for($i=35;$i -le 105;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; for($i=190;$i -le 220;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; rg -n "session_id" hub/src/db/scheduled-tasks-dal.ts | Select-Object -First 80' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 462ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
   36:   | 'running' // legacy alias, still accepted by the CHECK constraint
   37:   | 'success'
   38:   | 'failed'
   39:   | 'skipped'
   40:   | 'skipped_quota'
   41:   | 'cancelled'
   42: 
   43: export interface ScheduledTask {
   44:   id: string
   45:   user_id: string
   46:   session_id: string | null
   47:   name: string
   48:   cron_expression: string
   49:   prompt: string
   50:   enabled: boolean
   51:   last_run_at: string | null
   52:   next_run_at: string | null
   53:   on_complete: OnCompleteAction
   54:   created_at: string
   55:   updated_at: string
   56:   // New shape — present on rows created by the new dispatcher; may be NULL/default
   57:   // on legacy rows during the transition window.
   58:   task_type: TaskType
   59:   target_kind: TargetKind
   60:   target_id: string | null
   61:   payload: Record<string, any>
   62:   cron_expr: string | null
   63:   timezone: string
   64:   catchup_policy: CatchupPolicy
   65:   max_concurrent: number
   66:   last_fire_at: string | null
   67:   next_fire_at: string | null
   68:   post_run_actions: PostRunAction[]
   69:   // Auto-name parts. `name_prefix` is the server-computed locked portion
   70:   // (e.g. "Continue Dev on finedesignz/kh-hub every 4h"); `name_suffix` is
   71:   // the user's optional free-form note. The legacy `name` column stays
   72:   // authoritative for back-compat — DAL writes keep all three in sync.
   73:   name_prefix: string | null
   74:   name_suffix: string | null
   75:   // Simpler-cron picker: structured rules. NULL on legacy rows (UI falls
   76:   // back to deriving a single rule from `cron_expr`). Array of
   77:   // `{interval, unit, start_at}`.
   78:   schedule_rules: any[] | null
   79:   // Milestone TEAB (additive, nullable on every non-TEAB row). `teab_repo_ident`
   80:   // is the target repo for `teab run --repo <X>`; `teab_last_status` mirrors the
   81:   // most recent supervisor `teab_status` poll result.
   82:   teab_repo_ident: string | null
   83:   teab_last_status: string | null
   84:   // Milestone once. `schedule_kind='once'` fires a single time at `run_at`
   85:   // (no cron rule evaluated) then self-finalizes; 'cron' (default) is the
   86:   // recurring path. `run_at` is NULL on every cron row.
   87:   schedule_kind: ScheduleKind
   88:   run_at: string | null
   89:   // Default-on run-summary email. When true (the default), every ROOT run of
   90:   // this task emails the owner a summary unless a custom notify_email action is
   91:   // already configured. Set false to opt out. See post-run/dispatcher.ts.
   92:   email_summary: boolean
   93:   // PTYCAP-07: durable internal-task marker (see hub/src/heal/internal-task.ts).
   94:   is_internal?: boolean
   95:   // Derived from latest finalized run via LATERAL JOIN in listTasksForUser/getTask.
   96:   last_run_cost_usd?: number | null
   97:   last_run_duration_ms?: number | null
   98: }
   99: 
  100: export interface ScheduledTaskRun {
  101:   id: string
  102:   task_id: string
  103:   user_id: string
  104:   session_id: string | null
  105:   started_at: string
  106:   completed_at: string | null
  191:   const schedule_rules =
  192:     row.schedule_rules == null
  193:       ? null
  194:       : typeof row.schedule_rules === 'string'
  195:         ? JSON.parse(row.schedule_rules)
  196:         : row.schedule_rules
  197:   // node-postgres returns NUMERIC as string; coerce when present. EXTRACT(EPOCH ...)
  198:   // comes back as a number (double precision) but normalize defensively.
  199:   const last_run_cost_usd =
  200:     row.last_run_cost_usd === null || row.last_run_cost_usd === undefined
  201:       ? null
  202:       : Number(row.last_run_cost_usd)
  203:   const last_run_duration_ms =
  204:     row.last_run_duration_ms === null || row.last_run_duration_ms === undefined
  205:       ? null
  206:       : Number(row.last_run_duration_ms)
  207:   return {
  208:     ...row,
  209:     on_complete,
  210:     payload,
  211:     post_run_actions,
  212:     schedule_rules,
  213:     last_run_cost_usd,
  214:     last_run_duration_ms,
  215:     // NULL/undefined ⇒ true; only an explicit false opts out.
  216:     email_summary: row.email_summary !== false,
  217:   }
  218: }
  219: 
  220: // ── V2 API (architect-approved scheduled-tasks phase) ────────────────────────
  221: // Operates on the extended columns added in the Wave 1 migration
46:  session_id: string | null
104:  session_id: string | null
274:  // Legacy `scheduled_tasks` columns kept for backward compat. session_id is
277:  session_id: string | null
295:      user_id, session_id, name, cron_expression, prompt, enabled,
302:      ${input.user_id}, ${input.session_id}, ${input.name},
502:  session_id?: string | null
518:      task_id, user_id, session_id, status, error,
522:      ${input.task_id}, ${input.user_id}, ${input.session_id ?? null},

 succeeded in 464ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
/**
 * Target resolver (W2/T7).
 *
 * Given a task + userId, returns the list of dispatch targets with their
 * socket handles (if online). The dispatcher uses these to pick a sender
 * and either ship immediately or hold for grace.
 */
import type { ServerWebSocket } from 'bun'
import type { ScheduledTask, TargetKind } from '../db/scheduled-tasks-dal.ts'
import { sql } from '../db/postgres.ts'
import { getChannel } from '../ws/registry.ts'
import {
  getSupervisor,
  listOnlineSupervisorIdsForUser,
} from '../ws/supervisor-registry.ts'

export interface ResolvedTarget {
  kind: TargetKind
  sessionId?: string | null
  supervisorId?: string | null
  agentSocket?: ServerWebSocket<any> | null
  supervisorSocket?: ServerWebSocket<any> | null
  online: boolean
}

export async function resolveTargets(
  task: ScheduledTask,
  userId: string,
): Promise<ResolvedTarget[]> {
  const kind = task.target_kind
  switch (kind) {
    case 'session': {
      const sid = task.target_id || task.session_id
      if (!sid) return []
      const ch = getChannel(sid)
      return [{
        kind: 'session',
        sessionId: sid,
        agentSocket: ch?.ws ?? null,
        online: !!ch,
      }]
    }
    case 'supervisor': {
      const sup = task.target_id
      if (!sup) return []
      const entry = getSupervisor(sup)
      return [{
        kind: 'supervisor',
        supervisorId: sup,
        supervisorSocket: entry?.ws ?? null,
        online: !!entry,
      }]
    }
    case 'all_agents': {
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM sessions WHERE user_id = ${userId} AND deleted_at IS NULL
      `
      const out: ResolvedTarget[] = []
      for (const r of rows) {
        const ch = getChannel(r.id)
        if (ch) {
          out.push({
            kind: 'all_agents',
            sessionId: r.id,
            agentSocket: ch.ws,
            online: true,
          })
        }
      }
      return out
    }
    case 'all_supervisors': {
      const ids = listOnlineSupervisorIdsForUser(userId)
      return ids
        .map((id) => {
          const entry = getSupervisor(id)
          if (!entry) return null
          return {
            kind: 'all_supervisors' as TargetKind,
            supervisorId: id,
            supervisorSocket: entry.ws,
            online: true,
          }
        })
        .filter((x): x is ResolvedTarget => x !== null)
    }
    default:
      return []
  }
}
hub/src/scheduler\dispatcher.ts:25:import { resolveTargets, type ResolvedTarget } from './targets.ts'
hub/src/scheduler\dispatcher.ts:335:  // of resolveTargets. They have no fixed target_kind/target_id; the sender
hub/src/scheduler\dispatcher.ts:382:  // session/supervisor target via resolveTargets (mirroring the triage branch
hub/src/scheduler\dispatcher.ts:433:  // stream-json session pinned in payload) rather than via resolveTargets. It
hub/src/scheduler\dispatcher.ts:485:  const targets = await resolveTargets(task, userId)
hub/src/scheduler\targets.ts:26:export async function resolveTargets(
hub/src/scheduler\senders\triage.ts:30: * Bypasses `resolveTargets`: triage tasks have no fixed target_kind/target_id

 succeeded in 474ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src\ws\protocol.ts-85-export const ScheduledRunStarted = z.object({
hub/src\ws\protocol.ts-86-  type: z.literal('scheduled_run_started'),
hub/src\ws\protocol.ts-87-  run_id: z.string().min(1),
hub/src\ws\protocol.ts-88-  task_id: z.string().min(1),
hub/src\ws\protocol.ts-89-  scheduled_for: z.string().optional(),
hub/src\ws\protocol.ts:90:  target_kind: z.enum(['session', 'supervisor', 'all_agents', 'all_supervisors']).optional(),
hub/src\ws\protocol.ts-91-  target_id: z.string().nullable().optional(),
hub/src\ws\protocol.ts-92-})
hub/src\ws\protocol.ts-93-
hub/src\ws\protocol.ts-94-export const ScheduledRunProgress = z.object({
hub/src\ws\protocol.ts-95-  type: z.literal('scheduled_run_progress'),
--
hub/src\db\schema.sql-226-    'work',
hub/src\db\schema.sql-227-    -- Internal: synthesized by Coolify webhook
hub/src\db\schema.sql-228-    'triage'
hub/src\db\schema.sql-229-  ));
hub/src\db\schema.sql-230-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS target_kind TEXT NOT NULL DEFAULT 'session'
hub/src\db\schema.sql:231:  CHECK (target_kind IN ('session','supervisor','all_agents','all_supervisors'));
hub/src\db\schema.sql-232-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS target_id TEXT;
hub/src\db\schema.sql-233-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
hub/src\db\schema.sql-234-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS cron_expr TEXT;
hub/src\db\schema.sql-235-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
hub/src\db\schema.sql-236-ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS catchup_policy TEXT NOT NULL DEFAULT 'skip'
--
hub/src\db\dal.ts-1677-  git_repository: string | null;
hub/src\db\dal.ts-1678-  commit_sha: string | null;
hub/src\db\dal.ts-1679-}): Promise<{ id: string }> {
hub/src\db\dal.ts-1680-  const rows = await sql<{ id: string }[]>`
hub/src\db\dal.ts-1681-    INSERT INTO scheduled_task_runs (
hub/src\db\dal.ts:1682:      task_id, user_id, session_id, status, target_kind, target_id,
hub/src\db\dal.ts-1683-      deployment_uuid, application_uuid, git_repository, commit_sha,
hub/src\db\dal.ts-1684-      started_at, finished_at, completed_at
hub/src\db\dal.ts-1685-    ) VALUES (
hub/src\db\dal.ts-1686-      ${input.task_id}, ${input.user_id}, NULL, ${input.status}, NULL, NULL,
hub/src\db\dal.ts-1687-      ${input.deployment_uuid}, ${input.application_uuid}, ${input.git_repository}, ${input.commit_sha},
--
hub/test\e2e\automation-controls-checks.ts-221-      JOIN sessions s ON s.id = l.session_id
hub/test\e2e\automation-controls-checks.ts-222-      WHERE l.counter_key = ${K1} AND l.kind = 'inject'`
hub/test\e2e\automation-controls-checks.ts-223-    expect(Number(ledgerJoin[0].n)).toBe(6)
hub/test\e2e\automation-controls-checks.ts-224-    const taskSession = await newSession()
hub/test\e2e\automation-controls-checks.ts-225-    const task = await sql<{ id: string }[]>`
hub/test\e2e\automation-controls-checks.ts:226:      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type, target_kind, target_id, timezone)
hub/test\e2e\automation-controls-checks.ts-227-      VALUES (${userId}, ${taskSession}, ${P}, '0 * * * *', 'go', 'orchestrator', 'session', ${taskSession}, 'UTC')
hub/test\e2e\automation-controls-checks.ts-228-      RETURNING id`
hub/test\e2e\automation-controls-checks.ts-229-    const taskKey = `task:${task[0].id}`
hub/test\e2e\automation-controls-checks.ts-230-    extraCounterKeys.push(taskKey)
hub/test\e2e\automation-controls-checks.ts-231-    expect(await C.resolveOrchestratorCounterKey({ userId, sessionId: taskSession })).toBe(taskKey)
--
hub/test\e2e\schema-double-apply.e2e.test.ts-272-    expect(row.task_type).toBe('work')
hub/test\e2e\schema-double-apply.e2e.test.ts-273-    expect(row.run_at).not.toBeNull()
hub/test\e2e\schema-double-apply.e2e.test.ts-274-
hub/test\e2e\schema-double-apply.e2e.test.ts-275-    // Every pre-existing row defaults to schedule_kind='cron' / run_at NULL (no backfill).
hub/test\e2e\schema-double-apply.e2e.test.ts-276-    const [legacy] = await sql<{ id: string }[]>`
hub/test\e2e\schema-double-apply.e2e.test.ts:277:      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type, target_kind, target_id, timezone)
hub/test\e2e\schema-double-apply.e2e.test.ts-278-      VALUES (${user.id}, ${sess.id}, 'Cron dev', '0 * * * *', 'go', 'dev', 'session', ${sess.id}, 'UTC')
hub/test\e2e\schema-double-apply.e2e.test.ts-279-      RETURNING id
hub/test\e2e\schema-double-apply.e2e.test.ts-280-    `
hub/test\e2e\schema-double-apply.e2e.test.ts-281-    const [legacyRow] = await sql<{ schedule_kind: string; run_at: string | null }[]>`
hub/test\e2e\schema-double-apply.e2e.test.ts-282-      SELECT schedule_kind, run_at FROM scheduled_tasks WHERE id = ${legacy.id}
--
hub/test\e2e\schema-double-apply.e2e.test.ts-286-
hub/test\e2e\schema-double-apply.e2e.test.ts-287-    // The CHECK constraint bites: an out-of-domain schedule_kind is rejected.
hub/test\e2e\schema-double-apply.e2e.test.ts-288-    let bad = false
hub/test\e2e\schema-double-apply.e2e.test.ts-289-    try {
hub/test\e2e\schema-double-apply.e2e.test.ts-290-      await sql`
hub/test\e2e\schema-double-apply.e2e.test.ts:291:        INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, target_kind, timezone, schedule_kind)
hub/test\e2e\schema-double-apply.e2e.test.ts-292-        VALUES (${user.id}, ${sess.id}, 'bad', '@once', '', 'session', 'UTC', 'weekly')
hub/test\e2e\schema-double-apply.e2e.test.ts-293-      `
hub/test\e2e\schema-double-apply.e2e.test.ts-294-    } catch { bad = true }
hub/test\e2e\schema-double-apply.e2e.test.ts-295-    expect(bad).toBe(true)
hub/test\e2e\schema-double-apply.e2e.test.ts-296-  }, 45_000)
--
hub/test\scheduled-task-prompt-sync.test.ts-70-
hub/test\scheduled-task-prompt-sync.test.ts-71-afterAll(() => mock.restore())
hub/test\scheduled-task-prompt-sync.test.ts-72-
hub/test\scheduled-task-prompt-sync.test.ts-73-const baseCreate = {
hub/test\scheduled-task-prompt-sync.test.ts-74-  task_type: 'dev',
hub/test\scheduled-task-prompt-sync.test.ts:75:  target_kind: 'all_agents',
hub/test\scheduled-task-prompt-sync.test.ts-76-  cron_expr: '0 * * * *',
hub/test\scheduled-task-prompt-sync.test.ts-77-  timezone: 'UTC',
hub/test\scheduled-task-prompt-sync.test.ts-78-}
hub/test\scheduled-task-prompt-sync.test.ts-79-
hub/test\scheduled-task-prompt-sync.test.ts-80-describe('CREATE persists prompt to BOTH column and payload', () => {
--
hub/test\scheduled-task-prompt-sync.test.ts-105-
hub/test\scheduled-task-prompt-sync.test.ts-106-describe('PATCH persists prompt to BOTH column and payload', () => {
hub/test\scheduled-task-prompt-sync.test.ts-107-  test('editing payload.prompt writes the column too', async () => {
hub/test\scheduled-task-prompt-sync.test.ts-108-    existingRow = {
hub/test\scheduled-task-prompt-sync.test.ts-109-      id: 't1', user_id: 'u1', name: 'x', task_type: 'dev',
hub/test\scheduled-task-prompt-sync.test.ts:110:      target_kind: 'all_agents', target_id: null, payload: { prompt: 'old' },
hub/test\scheduled-task-prompt-sync.test.ts-111-      cron_expr: '0 * * * *', timezone: 'UTC', post_run_actions: [],
hub/test\scheduled-task-prompt-sync.test.ts-112-      name_suffix: null,
hub/test\scheduled-task-prompt-sync.test.ts-113-    }
hub/test\scheduled-task-prompt-sync.test.ts-114-    updateArg = null
hub/test\scheduled-task-prompt-sync.test.ts-115-    const res = await app.request('/api/scheduled-tasks/t1', {
--
hub/test\scheduled-task-prompt-sync.test.ts-123-  })
hub/test\scheduled-task-prompt-sync.test.ts-124-
hub/test\scheduled-task-prompt-sync.test.ts-125-  test('top-level prompt patch mirrors into payload', async () => {
hub/test\scheduled-task-prompt-sync.test.ts-126-    existingRow = {
hub/test\scheduled-task-prompt-sync.test.ts-127-      id: 't1', user_id: 'u1', name: 'x', task_type: 'dev',
hub/test\scheduled-task-prompt-sync.test.ts:128:      target_kind: 'all_agents', target_id: null, payload: {},
hub/test\scheduled-task-prompt-sync.test.ts-129-      cron_expr: '0 * * * *', timezone: 'UTC', post_run_actions: [],
hub/test\scheduled-task-prompt-sync.test.ts-130-      name_suffix: null,
hub/test\scheduled-task-prompt-sync.test.ts-131-    }
hub/test\scheduled-task-prompt-sync.test.ts-132-    updateArg = null
hub/test\scheduled-task-prompt-sync.test.ts-133-    const res = await app.request('/api/scheduled-tasks/t1', {
--
hub/src\scheduler\post-run\aggregator.ts-1-/**
hub/src\scheduler\post-run\aggregator.ts-2- * Fan-out aggregator (W2/T8.7).
hub/src\scheduler\post-run\aggregator.ts-3- *
hub/src\scheduler\post-run\aggregator.ts:4: * For tasks with target_kind in ('all_agents','all_supervisors'), the
hub/src\scheduler\post-run\aggregator.ts-5- * dispatcher inserts N child runs (one per resolved target). We don't want
hub/src\scheduler\post-run\aggregator.ts-6- * to fire post-run actions per child (notification spam). Instead, this
hub/src\scheduler\post-run\aggregator.ts-7- * aggregator collects child outcomes for a single parent fire and fires
hub/src\scheduler\post-run\aggregator.ts-8- * post-run actions ONCE with an aggregate status.
hub/src\scheduler\post-run\aggregator.ts-9- *
--
hub/src\scheduler\dispatcher.ts-503-    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
hub/src\scheduler\dispatcher.ts-504-    runIds.push(run.id)
hub/src\scheduler\dispatcher.ts-505-    return { runIds }
hub/src\scheduler\dispatcher.ts-506-  }
hub/src\scheduler\dispatcher.ts-507-
hub/src\scheduler\dispatcher.ts:508:  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
hub/src\scheduler\dispatcher.ts-509-  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null
hub/src\scheduler\dispatcher.ts-510-
hub/src\scheduler\dispatcher.ts-511-  if (isFanOut) {
hub/src\scheduler\dispatcher.ts-512-    try {
hub/src\scheduler\dispatcher.ts-513-      const { register: aggRegister } = await import('./post-run/aggregator.ts')
--
hub/test\scheduled-tasks.e2e.test.ts-24-  test('POST /api/scheduled-tasks → run lands in history → DELETE removes it', async () => {
hub/test\scheduled-tasks.e2e.test.ts-25-    // TODO(W5+): wire test DB + JWT helper, then implement:
hub/test\scheduled-tasks.e2e.test.ts-26-    //   1. Boot hub against REMO_E2E_DB_URL with a unique JWT_SECRET.
hub/test\scheduled-tasks.e2e.test.ts-27-    //   2. Seed a user row + API key + JWT for that user.
hub/test\scheduled-tasks.e2e.test.ts-28-    //   3. POST /api/scheduled-tasks { name: 'e2e', task_type: 'prompt',
hub/test\scheduled-tasks.e2e.test.ts:29:    //        target_kind: 'all_agents', cron_expr: '* * * * *',
hub/test\scheduled-tasks.e2e.test.ts-30-    //        timezone: 'UTC', payload: { prompt: 'noop' } }
hub/test\scheduled-tasks.e2e.test.ts-31-    //      → expect 200, body has id, next_3_runs.length === 3
hub/test\scheduled-tasks.e2e.test.ts-32-    //   4. Wait <=70s for the next minute boundary OR mock croner clock.
hub/test\scheduled-tasks.e2e.test.ts-33-    //   5. GET /api/scheduled-task-runs?task_id=<id>
hub/test\scheduled-tasks.e2e.test.ts-34-    //      → at least one run row, status in ['pending','failed','skipped']
--
hub/test\scheduler.test.ts-518-  })
hub/test\scheduler.test.ts-519-
hub/test\scheduler.test.ts-520-  test('fan-out kinds render readable target labels', () => {
hub/test\scheduler.test.ts-521-    expect(
hub/test\scheduler.test.ts-522-      computeTaskAutoName(
hub/test\scheduler.test.ts:523:        { task_type: 'dev', target_kind: 'all_agents', cron_expr: '0 * * * *' },
hub/test\scheduler.test.ts-524-        ctx,
hub/test\scheduler.test.ts-525-      ),
hub/test\scheduler.test.ts-526-    ).toBe('Dev on all agents hourly')
hub/test\scheduler.test.ts-527-    expect(
hub/test\scheduler.test.ts-528-      computeTaskAutoName(

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n -C 8 \"createTask\\(|createScheduledTask|session_id:\" hub/src/api/scheduled-tasks.ts hub/src/db/scheduled-tasks-dal.ts | Select-Object -First 260" in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/db/scheduled-tasks-dal.ts'; "'$l=Get-Content $p; for($i=250;$i -le 325;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; $p='"'hub/src/api/scheduled-tasks.ts'; "'$l=Get-Content $p; for($i=110;$i -le 280;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 458ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/db/scheduled-tasks-dal.ts-38-  | 'failed'
hub/src/db/scheduled-tasks-dal.ts-39-  | 'skipped'
hub/src/db/scheduled-tasks-dal.ts-40-  | 'skipped_quota'
hub/src/db/scheduled-tasks-dal.ts-41-  | 'cancelled'
hub/src/db/scheduled-tasks-dal.ts-42-
hub/src/db/scheduled-tasks-dal.ts-43-export interface ScheduledTask {
hub/src/db/scheduled-tasks-dal.ts-44-  id: string
hub/src/db/scheduled-tasks-dal.ts-45-  user_id: string
hub/src/db/scheduled-tasks-dal.ts:46:  session_id: string | null
hub/src/db/scheduled-tasks-dal.ts-47-  name: string
hub/src/db/scheduled-tasks-dal.ts-48-  cron_expression: string
hub/src/db/scheduled-tasks-dal.ts-49-  prompt: string
hub/src/db/scheduled-tasks-dal.ts-50-  enabled: boolean
hub/src/db/scheduled-tasks-dal.ts-51-  last_run_at: string | null
hub/src/db/scheduled-tasks-dal.ts-52-  next_run_at: string | null
hub/src/db/scheduled-tasks-dal.ts-53-  on_complete: OnCompleteAction
hub/src/db/scheduled-tasks-dal.ts-54-  created_at: string
--
hub/src/db/scheduled-tasks-dal.ts-96-  last_run_cost_usd?: number | null
hub/src/db/scheduled-tasks-dal.ts-97-  last_run_duration_ms?: number | null
hub/src/db/scheduled-tasks-dal.ts-98-}
hub/src/db/scheduled-tasks-dal.ts-99-
hub/src/db/scheduled-tasks-dal.ts-100-export interface ScheduledTaskRun {
hub/src/db/scheduled-tasks-dal.ts-101-  id: string
hub/src/db/scheduled-tasks-dal.ts-102-  task_id: string
hub/src/db/scheduled-tasks-dal.ts-103-  user_id: string
hub/src/db/scheduled-tasks-dal.ts:104:  session_id: string | null
hub/src/db/scheduled-tasks-dal.ts-105-  started_at: string
hub/src/db/scheduled-tasks-dal.ts-106-  completed_at: string | null
hub/src/db/scheduled-tasks-dal.ts-107-  status: RunStatus
hub/src/db/scheduled-tasks-dal.ts-108-  error: string | null
hub/src/db/scheduled-tasks-dal.ts-109-  // New columns (nullable on legacy rows)
hub/src/db/scheduled-tasks-dal.ts-110-  scheduled_for: string | null
hub/src/db/scheduled-tasks-dal.ts-111-  finished_at: string | null
hub/src/db/scheduled-tasks-dal.ts-112-  target_kind: TargetKind | null
--
hub/src/db/scheduled-tasks-dal.ts-269-  timezone: string
hub/src/db/scheduled-tasks-dal.ts-270-  catchup_policy?: CatchupPolicy
hub/src/db/scheduled-tasks-dal.ts-271-  max_concurrent?: number
hub/src/db/scheduled-tasks-dal.ts-272-  enabled?: boolean
hub/src/db/scheduled-tasks-dal.ts-273-  post_run_actions?: PostRunAction[]
hub/src/db/scheduled-tasks-dal.ts-274-  // Legacy `scheduled_tasks` columns kept for backward compat. session_id is
hub/src/db/scheduled-tasks-dal.ts-275-  // NULL for fan-out kinds (all_agents/all_supervisors) and the target session
hub/src/db/scheduled-tasks-dal.ts-276-  // id for `target_kind = 'session'`.
hub/src/db/scheduled-tasks-dal.ts:277:  session_id: string | null
hub/src/db/scheduled-tasks-dal.ts-278-  cron_expression?: string
hub/src/db/scheduled-tasks-dal.ts-279-  prompt?: string
hub/src/db/scheduled-tasks-dal.ts-280-  name_prefix?: string | null
hub/src/db/scheduled-tasks-dal.ts-281-  name_suffix?: string | null
hub/src/db/scheduled-tasks-dal.ts-282-  schedule_rules?: any[] | null
hub/src/db/scheduled-tasks-dal.ts-283-  teab_repo_ident?: string | null
hub/src/db/scheduled-tasks-dal.ts-284-  teab_last_status?: string | null
hub/src/db/scheduled-tasks-dal.ts-285-  email_summary?: boolean
--
hub/src/api/scheduled-tasks.ts-355-      target_id: data.target_id ?? null,
hub/src/api/scheduled-tasks.ts-356-      payload: oncePayload,
hub/src/api/scheduled-tasks.ts-357-      cron_expr: '@once',
hub/src/api/scheduled-tasks.ts-358-      timezone: data.timezone,
hub/src/api/scheduled-tasks.ts-359-      catchup_policy: data.catchup_policy ?? 'skip',
hub/src/api/scheduled-tasks.ts-360-      max_concurrent: data.max_concurrent ?? 1,
hub/src/api/scheduled-tasks.ts-361-      enabled: data.enabled ?? true,
hub/src/api/scheduled-tasks.ts-362-      post_run_actions: onceActions,
hub/src/api/scheduled-tasks.ts:363:      session_id: sessionId,
hub/src/api/scheduled-tasks.ts-364-      cron_expression: '@once',
hub/src/api/scheduled-tasks.ts-365-      prompt: oncePrompt,
hub/src/api/scheduled-tasks.ts-366-      name_prefix: built.prefix || null,
hub/src/api/scheduled-tasks.ts-367-      name_suffix: built.suffix || null,
hub/src/api/scheduled-tasks.ts-368-      schedule_rules: null,
hub/src/api/scheduled-tasks.ts-369-      teab_repo_ident: data.teab_repo_ident ?? null,
hub/src/api/scheduled-tasks.ts-370-      email_summary: data.email_summary,
hub/src/api/scheduled-tasks.ts-371-      schedule_kind: 'once',
--
hub/src/api/scheduled-tasks.ts-446-    target_id: data.target_id ?? null,
hub/src/api/scheduled-tasks.ts-447-    payload: createPayload,
hub/src/api/scheduled-tasks.ts-448-    cron_expr: effectiveCron,
hub/src/api/scheduled-tasks.ts-449-    timezone: data.timezone,
hub/src/api/scheduled-tasks.ts-450-    catchup_policy: data.catchup_policy ?? 'skip',
hub/src/api/scheduled-tasks.ts-451-    max_concurrent: data.max_concurrent ?? 1,
hub/src/api/scheduled-tasks.ts-452-    enabled: data.enabled ?? true,
hub/src/api/scheduled-tasks.ts-453-    post_run_actions: v.actions,
hub/src/api/scheduled-tasks.ts:454:    session_id: sessionId,
hub/src/api/scheduled-tasks.ts-455-    cron_expression: effectiveCron,
hub/src/api/scheduled-tasks.ts-456-    prompt: createPrompt,
hub/src/api/scheduled-tasks.ts-457-    name_prefix: built.prefix || null,
hub/src/api/scheduled-tasks.ts-458-    name_suffix: built.suffix || null,
hub/src/api/scheduled-tasks.ts-459-    schedule_rules: data.schedule_rules ?? null,
hub/src/api/scheduled-tasks.ts-460-    teab_repo_ident: data.teab_repo_ident ?? null,
hub/src/api/scheduled-tasks.ts-461-    email_summary: data.email_summary,
hub/src/api/scheduled-tasks.ts-462-  })

 succeeded in 480ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  251:        AND run_at IS NOT NULL
  252:        AND run_at <= ${now}
  253:      ORDER BY run_at ASC
  254:      LIMIT ${limit}
  255:   `
  256:   return rows.map((r) => r.id)
  257: }
  258: 
  259: export async function createTaskV2(input: {
  260:   user_id: string
  261:   name: string
  262:   task_type: TaskType
  263:   target_kind: TargetKind
  264:   target_id?: string | null
  265:   payload?: Record<string, any>
  266:   // Optional: 'once' tasks carry no cron. When absent a '@once' sentinel is
  267:   // written to the NOT NULL `cron_expression` column and `cron_expr` stays NULL.
  268:   cron_expr?: string
  269:   timezone: string
  270:   catchup_policy?: CatchupPolicy
  271:   max_concurrent?: number
  272:   enabled?: boolean
  273:   post_run_actions?: PostRunAction[]
  274:   // Legacy `scheduled_tasks` columns kept for backward compat. session_id is
  275:   // NULL for fan-out kinds (all_agents/all_supervisors) and the target session
  276:   // id for `target_kind = 'session'`.
  277:   session_id: string | null
  278:   cron_expression?: string
  279:   prompt?: string
  280:   name_prefix?: string | null
  281:   name_suffix?: string | null
  282:   schedule_rules?: any[] | null
  283:   teab_repo_ident?: string | null
  284:   teab_last_status?: string | null
  285:   email_summary?: boolean
  286:   // Milestone once. Omitted ⇒ 'cron' / NULL run_at (unchanged behavior).
  287:   schedule_kind?: ScheduleKind
  288:   run_at?: Date | string | null
  289: }): Promise<ScheduledTask> {
  290:   // A one-time row carries no cron; `cron_expression` is NOT NULL in the legacy
  291:   // schema, so persist a sentinel ('@once') when the caller has no cron string.
  292:   const cronExpression = input.cron_expression ?? input.cron_expr ?? '@once'
  293:   const rows = await sql<ScheduledTask[]>`
  294:     INSERT INTO scheduled_tasks (
  295:       user_id, session_id, name, cron_expression, prompt, enabled,
  296:       task_type, target_kind, target_id, payload, cron_expr, timezone,
  297:       catchup_policy, max_concurrent, post_run_actions,
  298:       name_prefix, name_suffix, schedule_rules,
  299:       teab_repo_ident, teab_last_status, email_summary,
  300:       schedule_kind, run_at
  301:     ) VALUES (
  302:       ${input.user_id}, ${input.session_id}, ${input.name},
  303:       ${cronExpression}, ${input.prompt ?? ''},
  304:       ${input.enabled ?? true},
  305:       ${input.task_type}, ${input.target_kind}, ${input.target_id ?? null},
  306:       ${sql.json((input.payload ?? {}) as any)}, ${input.cron_expr ?? null},
  307:       ${input.timezone}, ${input.catchup_policy ?? 'skip'},
  308:       ${input.max_concurrent ?? 1},
  309:       ${sql.json((input.post_run_actions ?? []) as any)},
  310:       ${input.name_prefix ?? null}, ${input.name_suffix ?? null},
  311:       ${input.schedule_rules ? sql.json(input.schedule_rules as any) : null},
  312:       ${input.teab_repo_ident ?? null}, ${input.teab_last_status ?? null},
  313:       ${input.email_summary ?? true},
  314:       ${input.schedule_kind ?? 'cron'}, ${input.run_at ?? null}
  315:     )
  316:     RETURNING *
  317:   `
  318:   return normalize(rows[0])
  319: }
  320: 
  321: export async function updateTaskV2(
  322:   id: string,
  323:   userId: string,
  324:   fields: Partial<{
  325:     name: string
  326:     enabled: boolean
  111:   // Default-on run-summary email opt-out. Omitted ⇒ true (owner gets a summary
  112:   // per root run). Set false to suppress. See docs/scheduled-tasks.md.
  113:   email_summary: z.boolean().optional(),
  114: })
  115: 
  116: const PatchSchema = CreateSchema.partial()
  117: 
  118: // ── Helpers ───────────────────────────────────────────────────────────────────
  119: 
  120: function withNext3<T extends ScheduledTask>(task: T) {
  121:   if (!task.enabled) return { ...task, next_3_runs: [] as string[] }
  122:   // Milestone once: a one-time task's only "next run" is its run_at (no cron).
  123:   if (task.schedule_kind === 'once') {
  124:     const ms = task.run_at ? Date.parse(task.run_at) : NaN
  125:     const next = Number.isFinite(ms) && ms > Date.now() ? [new Date(ms).toISOString()] : []
  126:     return { ...task, next_3_runs: next }
  127:   }
  128:   const tz = task.timezone || 'UTC'
  129:   const rules = Array.isArray(task.schedule_rules) ? (task.schedule_rules as ScheduleRule[]) : []
  130:   if (rules.length > 0) {
  131:     const merged: number[] = []
  132:     for (const r of rules) {
  133:       try {
  134:         const expr = ruleToCron(r, tz)
  135:         const startMs = Date.parse(r.start_at)
  136:         const from = Number.isFinite(startMs) && startMs > Date.now() ? new Date(startMs) : new Date()
  137:         for (const d of nextRuns(expr, tz, 3, from)) merged.push(d.getTime())
  138:       } catch {}
  139:     }
  140:     merged.sort((a, b) => a - b)
  141:     const top = Array.from(new Set(merged)).slice(0, 3).map(ms => new Date(ms).toISOString())
  142:     return { ...task, next_3_runs: top }
  143:   }
  144:   const expr = task.cron_expr || task.cron_expression
  145:   if (!expr) return { ...task, next_3_runs: [] as string[] }
  146:   const runs = nextRuns(expr, tz, 3).map((d) => d.toISOString())
  147:   return { ...task, next_3_runs: runs }
  148: }
  149: 
  150: function targetIdRequired(kind: string): boolean {
  151:   return kind === 'session' || kind === 'supervisor'
  152: }
  153: 
  154: /**
  155:  * Resolve the effective cron_expr to persist + register. Priority:
  156:  *  - explicit `cron_expr` from the body (legacy clients)
  157:  *  - rule[0] of `schedule_rules` converted to cron
  158:  *  - existing row's cron_expr (PATCH path)
  159:  *
  160:  * Returns null if neither is available.
  161:  */
  162: function resolveCronExpr(
  163:   body: { cron_expr?: string; schedule_rules?: ScheduleRule[] },
  164:   tz: string,
  165: ): string | null {
  166:   if (body.cron_expr) return body.cron_expr
  167:   if (body.schedule_rules && body.schedule_rules.length > 0) {
  168:     return ruleToCron(body.schedule_rules[0], tz)
  169:   }
  170:   return null
  171: }
  172: 
  173: interface ValidateOptions {
  174:   cron_expr?: string
  175:   timezone?: string
  176:   target_kind?: string
  177:   target_id?: string | null | undefined
  178:   post_run_actions?: unknown
  179: }
  180: 
  181: function validateInputs(input: ValidateOptions):
  182:   | { ok: true; actions: PostRunAction[] }
  183:   | { ok: false; status: 400; body: Record<string, unknown> } {
  184:   if (input.cron_expr !== undefined) {
  185:     const v = validateCron(input.cron_expr)
  186:     if (!v.ok) return { ok: false, status: 400, body: { error: 'invalid_cron', detail: v.error } }
  187:   }
  188:   if (input.timezone !== undefined) {
  189:     if (!isValidTimezone(input.timezone)) {
  190:       return { ok: false, status: 400, body: { error: 'invalid_timezone' } }
  191:     }
  192:   }
  193:   if (input.target_kind !== undefined) {
  194:     if (targetIdRequired(input.target_kind) && !input.target_id) {
  195:       return {
  196:         ok: false,
  197:         status: 400,
  198:         body: { error: 'target_id_required', detail: `target_id required for kind=${input.target_kind}` },
  199:       }
  200:     }
  201:   }
  202:   let actions: PostRunAction[] = []
  203:   if (input.post_run_actions !== undefined) {
  204:     const r = validatePostRunActions(input.post_run_actions)
  205:     if (!r.ok) {
  206:       return { ok: false, status: 400, body: { error: 'invalid_post_run_actions', detail: r.errors } }
  207:     }
  208:     actions = r.value
  209:   }
  210:   return { ok: true, actions }
  211: }
  212: 
  213: /**
  214:  * Build the user's full task graph (including the proposed task) and run
  215:  * cycle detection. `selfTaskId` is the id being edited/created; for create
  216:  * we pass a sentinel "__new__" that won't collide with real UUIDs.
  217:  */
  218: async function detectCyclesForUser(
  219:   userId: string,
  220:   selfTaskId: string,
  221:   selfActions: PostRunAction[],
  222: ): Promise<{ ok: true } | { ok: false; cycle: string[] }> {
  223:   const all = await listTasksForUser(userId)
  224:   const graph = all
  225:     .filter((t) => t.id !== selfTaskId)
  226:     .map((t) => ({ id: t.id, actions: (t.post_run_actions ?? []) as PostRunAction[] }))
  227:   graph.push({ id: selfTaskId, actions: selfActions })
  228:   return detectChainCycles(graph)
  229: }
  230: 
  231: /**
  232:  * Resolve the user's sessions + supervisors and compose the locked prefix
  233:  * + final name. The server's prefix is authoritative on persist — the
  234:  * client renders a preview but never gets to override the value stored on
  235:  * `scheduled_tasks.name`.
  236:  *
  237:  * `legacyName` is the optional back-compat `name` body field; when no
  238:  * suffix was provided but a legacy name was, we use the legacy value as
  239:  * the suffix so users editing old rows don't lose their custom names.
  240:  */
  241: async function buildNameForUser(
  242:   userId: string,
  243:   input: {
  244:     task_type: TaskType
  245:     target_kind: TargetKind
  246:     target_id: string | null
  247:     payload: Record<string, any>
  248:     cron_expr: string
  249:   },
  250:   suffix: string | null | undefined,
  251:   legacyName: string | null | undefined,
  252: ): Promise<{ prefix: string; suffix: string; name: string }> {
  253:   const [sessions, supervisors] = await Promise.all([
  254:     listSessions(userId),
  255:     listSupervisorsForUser(userId),
  256:   ])
  257:   const ctx = {
  258:     sessions: (sessions as any[]).map((s) => ({
  259:       id: s.id,
  260:       name: s.name,
  261:       project_dir: s.project_dir,
  262:     })),
  263:     supervisors: (supervisors as any[]).map((s) => ({
  264:       id: s.id,
  265:       hostname: s.hostname,
  266:     })),
  267:   }
  268:   let effectiveSuffix = (suffix ?? '').trim()
  269:   if (!effectiveSuffix && legacyName) {
  270:     // Strip the prefix from legacyName if it starts with it; otherwise treat
  271:     // the whole legacy name as a custom suffix.
  272:     const probe = buildTaskName(input, '', ctx)
  273:     const raw = legacyName.trim()
  274:     if (probe.prefix && raw.toLowerCase().startsWith(probe.prefix.toLowerCase())) {
  275:       effectiveSuffix = raw.slice(probe.prefix.length).replace(/^\s*[—\-:]+\s*/, '').trim()
  276:     } else {
  277:       effectiveSuffix = raw
  278:     }
  279:   }
  280:   const built = buildTaskName(input, effectiveSuffix, ctx)
  281:   // Fallback: if the prefix couldn't be computed (missing target etc.) but

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/db/scheduled-tasks-dal.ts'; "'$l=Get-Content $p; for($i=321;$i -le 385;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/api/scheduled-tasks.ts'; "'$l=Get-Content $p; for($i=320;$i -le 470;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; for($i=500;$i -le 690;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 688ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  322:   id: string,
  323:   userId: string,
  324:   fields: Partial<{
  325:     name: string
  326:     enabled: boolean
  327:     task_type: TaskType
  328:     target_kind: TargetKind
  329:     target_id: string | null
  330:     payload: Record<string, any>
  331:     prompt: string
  332:     cron_expr: string
  333:     timezone: string
  334:     catchup_policy: CatchupPolicy
  335:     max_concurrent: number
  336:     post_run_actions: PostRunAction[]
  337:     name_prefix: string | null
  338:     name_suffix: string | null
  339:     schedule_rules: any[] | null
  340:     teab_repo_ident: string | null
  341:     teab_last_status: string | null
  342:     email_summary: boolean
  343:   }>,
  344: ): Promise<ScheduledTask | null> {
  345:   const sets: any[] = []
  346:   if (fields.name !== undefined) sets.push(sql`name = ${fields.name}`)
  347:   if (fields.name_prefix !== undefined) sets.push(sql`name_prefix = ${fields.name_prefix}`)
  348:   if (fields.name_suffix !== undefined) sets.push(sql`name_suffix = ${fields.name_suffix}`)
  349:   if (fields.enabled !== undefined) sets.push(sql`enabled = ${fields.enabled}`)
  350:   if (fields.task_type !== undefined) sets.push(sql`task_type = ${fields.task_type}`)
  351:   if (fields.target_kind !== undefined) sets.push(sql`target_kind = ${fields.target_kind}`)
  352:   if (fields.target_id !== undefined) sets.push(sql`target_id = ${fields.target_id}`)
  353:   if (fields.payload !== undefined) sets.push(sql`payload = ${sql.json(fields.payload as any)}`)
  354:   // The `prompt` column is authoritative; the dispatcher's sender prefers
  355:   // `payload.prompt || prompt`, so the API mirrors the column into
  356:   // `payload.prompt` on every write to keep the two in sync (see PATCH handler).
  357:   if (fields.prompt !== undefined) sets.push(sql`prompt = ${fields.prompt}`)
  358:   if (fields.cron_expr !== undefined) {
  359:     sets.push(sql`cron_expr = ${fields.cron_expr}`)
  360:     sets.push(sql`cron_expression = ${fields.cron_expr}`)
  361:   }
  362:   if (fields.timezone !== undefined) sets.push(sql`timezone = ${fields.timezone}`)
  363:   if (fields.catchup_policy !== undefined) sets.push(sql`catchup_policy = ${fields.catchup_policy}`)
  364:   if (fields.max_concurrent !== undefined) sets.push(sql`max_concurrent = ${fields.max_concurrent}`)
  365:   if (fields.post_run_actions !== undefined) {
  366:     sets.push(sql`post_run_actions = ${sql.json(fields.post_run_actions as any)}`)
  367:   }
  368:   if (fields.schedule_rules !== undefined) {
  369:     sets.push(sql`schedule_rules = ${fields.schedule_rules ? sql.json(fields.schedule_rules as any) : null}`)
  370:   }
  371:   if (fields.teab_repo_ident !== undefined) sets.push(sql`teab_repo_ident = ${fields.teab_repo_ident}`)
  372:   if (fields.teab_last_status !== undefined) sets.push(sql`teab_last_status = ${fields.teab_last_status}`)
  373:   if (fields.email_summary !== undefined) sets.push(sql`email_summary = ${fields.email_summary}`)
  374:   if (sets.length === 0) return getTask(id, userId)
  375:   sets.push(sql`updated_at = now()`)
  376: 
  377:   let q = sql`UPDATE scheduled_tasks SET `
  378:   for (let i = 0; i < sets.length; i++) {
  379:     q = i === 0 ? sql`${q}${sets[i]}` : sql`${q}, ${sets[i]}`
  380:   }
  381:   const rows = await sql<ScheduledTask[]>`${q} WHERE id = ${id} AND user_id = ${userId} RETURNING *`
  382:   return rows[0] ? normalize(rows[0]) : null
  383: }
  384: 
  385: /**
  386:  * Count the total run rows recorded for a task. Used by the scheduler's

 succeeded in 783ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  321:     if (!Number.isFinite(runAtMs)) {
  322:       return c.json({ error: 'run_at_required', detail: 'schedule_kind=once requires a valid ISO run_at' }, 400)
  323:     }
  324:     if (!isValidTimezone(data.timezone)) return c.json({ error: 'invalid_timezone' }, 400)
  325:     if (targetIdRequired(data.target_kind) && !data.target_id) {
  326:       return c.json({ error: 'target_id_required', detail: `target_id required for kind=${data.target_kind}` }, 400)
  327:     }
  328:     let onceActions: PostRunAction[] = []
  329:     if (data.post_run_actions !== undefined) {
  330:       const r = validatePostRunActions(data.post_run_actions)
  331:       if (!r.ok) return c.json({ error: 'invalid_post_run_actions', detail: r.errors }, 400)
  332:       onceActions = r.value
  333:     }
  334:     const cyc = await detectCyclesForUser(userId, '__new__', onceActions)
  335:     if (!cyc.ok) return c.json({ error: 'chain_cycle', path: cyc.cycle }, 400)
  336: 
  337:     const sessionId = data.target_kind === 'session' && data.target_id ? data.target_id : null
  338:     const oncePrompt =
  339:       typeof data.payload?.prompt === 'string' ? data.payload.prompt
  340:       : typeof data.prompt === 'string' ? data.prompt : ''
  341:     const oncePayload = oncePrompt !== '' ? { ...(data.payload ?? {}), prompt: oncePrompt } : (data.payload ?? {})
  342:     const built = await buildNameForUser(userId, {
  343:       task_type: data.task_type,
  344:       target_kind: data.target_kind,
  345:       target_id: data.target_id ?? null,
  346:       payload: oncePayload,
  347:       cron_expr: '@once',
  348:     }, data.name_suffix, data.name)
  349: 
  350:     const task = await createTaskV2({
  351:       user_id: userId,
  352:       name: built.name,
  353:       task_type: data.task_type,
  354:       target_kind: data.target_kind,
  355:       target_id: data.target_id ?? null,
  356:       payload: oncePayload,
  357:       cron_expr: '@once',
  358:       timezone: data.timezone,
  359:       catchup_policy: data.catchup_policy ?? 'skip',
  360:       max_concurrent: data.max_concurrent ?? 1,
  361:       enabled: data.enabled ?? true,
  362:       post_run_actions: onceActions,
  363:       session_id: sessionId,
  364:       cron_expression: '@once',
  365:       prompt: oncePrompt,
  366:       name_prefix: built.prefix || null,
  367:       name_suffix: built.suffix || null,
  368:       schedule_rules: null,
  369:       teab_repo_ident: data.teab_repo_ident ?? null,
  370:       email_summary: data.email_summary,
  371:       schedule_kind: 'once',
  372:       run_at: new Date(runAtMs),
  373:     })
  374:     registry.register(task)
  375:     return c.json(withNext3(task), 201)
  376:   }
  377: 
  378:   // Require either cron_expr or schedule_rules. Derive cron_expr from rule[0]
  379:   // when only schedule_rules was sent. The legacy column stays populated.
  380:   if (!data.cron_expr && (!data.schedule_rules || data.schedule_rules.length === 0)) {
  381:     return c.json({ error: 'schedule_required', detail: 'cron_expr or schedule_rules is required' }, 400)
  382:   }
  383:   if (data.schedule_rules) {
  384:     const rv = validateRules(data.schedule_rules)
  385:     if (!rv.ok) return c.json({ error: 'invalid_schedule_rules', detail: rv.error }, 400)
  386:     // Resolve `for:{count,unit}` → absolute `until` so storage carries a single
  387:     // bound (see normalizeRuleForStorage). Mutates the local copy only.
  388:     data.schedule_rules = normalizeRulesForStorage(data.schedule_rules as ScheduleRule[]) as any
  389:   }
  390:   const effectiveCron = resolveCronExpr(
  391:     { cron_expr: data.cron_expr, schedule_rules: data.schedule_rules as ScheduleRule[] | undefined },
  392:     data.timezone,
  393:   )
  394:   if (!effectiveCron) {
  395:     return c.json({ error: 'schedule_required' }, 400)
  396:   }
  397: 
  398:   const v = validateInputs({
  399:     cron_expr: effectiveCron,
  400:     timezone: data.timezone,
  401:     target_kind: data.target_kind,
  402:     target_id: data.target_id,
  403:     post_run_actions: data.post_run_actions,
  404:   })
  405:   if (!v.ok) return c.json(v.body, v.status)
  406: 
  407:   // Cycle detection across the user's task graph + the proposed actions.
  408:   const cyc = await detectCyclesForUser(userId, '__new__', v.actions)
  409:   if (!cyc.ok) return c.json({ error: 'chain_cycle', path: cyc.cycle }, 400)
  410: 
  411:   // Session-typed tasks pin `session_id` to the target session; fan-out
  412:   // kinds (all_agents/all_supervisors) leave it NULL.
  413:   const sessionId =
  414:     data.target_kind === 'session' && data.target_id ? data.target_id : null
  415: 
  416:   // Single source of truth: the `prompt` column. Mirror it into
  417:   // `payload.prompt` (and vice-versa) so create round-trips for the editor,
  418:   // which reads `payload.prompt` first and falls back to the column.
  419:   const createPrompt =
  420:     typeof data.payload?.prompt === 'string'
  421:       ? data.payload.prompt
  422:       : typeof data.prompt === 'string'
  423:         ? data.prompt
  424:         : ''
  425:   const createPayload =
  426:     createPrompt !== ''
  427:       ? { ...(data.payload ?? {}), prompt: createPrompt }
  428:       : (data.payload ?? {})
  429: 
  430:   // Build the locked auto-name prefix server-side from current sessions +
  431:   // supervisors. The client also computes a prefix for live preview, but the
  432:   // server's value is authoritative on persist.
  433:   const built = await buildNameForUser(userId, {
  434:     task_type: data.task_type,
  435:     target_kind: data.target_kind,
  436:     target_id: data.target_id ?? null,
  437:     payload: createPayload,
  438:     cron_expr: effectiveCron,
  439:   }, data.name_suffix, data.name)
  440: 
  441:   const task = await createTaskV2({
  442:     user_id: userId,
  443:     name: built.name,
  444:     task_type: data.task_type,
  445:     target_kind: data.target_kind,
  446:     target_id: data.target_id ?? null,
  447:     payload: createPayload,
  448:     cron_expr: effectiveCron,
  449:     timezone: data.timezone,
  450:     catchup_policy: data.catchup_policy ?? 'skip',
  451:     max_concurrent: data.max_concurrent ?? 1,
  452:     enabled: data.enabled ?? true,
  453:     post_run_actions: v.actions,
  454:     session_id: sessionId,
  455:     cron_expression: effectiveCron,
  456:     prompt: createPrompt,
  457:     name_prefix: built.prefix || null,
  458:     name_suffix: built.suffix || null,
  459:     schedule_rules: data.schedule_rules ?? null,
  460:     teab_repo_ident: data.teab_repo_ident ?? null,
  461:     email_summary: data.email_summary,
  462:   })
  463: 
  464:   registry.register(task)
  465:   return c.json(withNext3(task), 201)
  466: })
  467: 
  468: scheduledTasks.patch('/:id', async (c) => {
  469:   const userId = c.get('userId') as string
  470:   const id = c.req.param('id')
  471:   const existing = await getTask(id, userId)
  501:   }
  502:   // Only re-validate targeting when the patch actually changes it. A pure
  503:   // non-targeting PATCH (e.g. `{ enabled }`) must NOT 400 on a pre-existing
  504:   // task that legitimately has a null target_id (e.g. internal system tasks
  505:   // with target_kind='session' / target_id=null routed at dispatch time).
  506:   const touchesTargeting =
  507:     data.target_kind !== undefined || data.target_id !== undefined
  508: 
  509:   const v = validateInputs({
  510:     // Validate the (possibly derived) effective cron when rules changed too.
  511:     cron_expr: data.cron_expr ?? derivedFromRules ?? undefined,
  512:     timezone: data.timezone,
  513:     // Only enforce target_kind/target_id pairing when targeting is touched.
  514:     target_kind: touchesTargeting ? effective.target_kind : undefined,
  515:     target_id: effective.target_id ?? null,
  516:     post_run_actions: data.post_run_actions,
  517:   })
  518:   if (!v.ok) return c.json(v.body, v.status)
  519: 
  520:   // For the target-pairing check we want it gated on the effective kind —
  521:   // but only when the patch actually changes targeting.
  522:   if (touchesTargeting && targetIdRequired(effective.target_kind) && !effective.target_id) {
  523:     return c.json(
  524:       { error: 'target_id_required', detail: `target_id required for kind=${effective.target_kind}` },
  525:       400,
  526:     )  638:   658: 
  659: 
  660: 
  661: 
  662: 
  663: 
  664: 
  665: 
  666: 
  667: 
  668: 
  669: 
  670: 
  671: 
  672: 
  673: 
  674: 
  675: 
  676: 
  677: 
  678: 
  679: 
  680: 
  681: 
  682: 
  683: 
  684: 
  685: 
  686: 
  687: 
  688: 
  689: 
  690: 
  691: 

exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 6 "healRetentionHours|REMO_HEAL_RETENTION" hub/src/heal/config.ts docs hub/test | Select-Object -First 160' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'rg -n -C 5 "clearPendingTimers|shutdown|stop.*sweep" hub/src/index.ts hub/src/heal/sweep.ts | Select-Object -First 200' in C:\Users\artic\GitHub\remo-code-ptycap07
exec
"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'hub/src/db/heal-events-dal.ts'; "'$l=Get-Content $p; for($i=100;$i -le 130;$i++){ '"'{0,5}: {1}' -f ("'$i+1),$l[$i] }; rg -n -C 5 "pruneHealEvents" hub/src/db/heal-events-dal.ts hub/src' in C:\Users\artic\GitHub\remo-code-ptycap07
 succeeded in 493ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/index.ts-49-import { runMigrations } from './db/migrate'
hub/src/index.ts-50-import { markOrphanedRunsInterrupted } from './db/scheduled-tasks-dal.ts'
hub/src/index.ts-51-// V2 scheduler.
hub/src/index.ts-52-import * as schedRegistry from './scheduler/registry.ts'
hub/src/index.ts-53-import * as schedCatchup from './scheduler/catchup.ts'
hub/src/index.ts:54:import { clearPendingTimers as clearPostRunTimers } from './scheduler/post-run/dispatcher.ts'
hub/src/index.ts-55-import { getGraceBuffer as getDispatchGraceBuffer } from './dispatch/grace.ts'
hub/src/index.ts-56-import { startHookReaper } from './dispatch/pipeline.ts'
hub/src/index.ts-57-import { startRevanoteCallbackWorker } from './revanote/callback.ts'
hub/src/index.ts-58-import { startTelegramBridge } from './telegram/bridge.ts'
hub/src/index.ts-59-import { startRoutineQueueWorker, stopRoutineQueueWorker } from './orchestrator/queue.ts'
--
hub/src/index.ts-63-import { startRevanoteQuietWatch, stopRevanoteQuietWatch } from './revanote/quiet-watch.ts'
hub/src/index.ts-64-import { startRunReaperSweep, stopRunReaperSweep } from './scheduler/run-reaper.ts'
hub/src/index.ts-65-import { startAskReaperSweep, stopAskReaperSweep } from './ask/reaper.ts'
hub/src/index.ts-66-import { startWorkReaperSweep, stopWorkReaperSweep } from './work/reaper.ts'
hub/src/index.ts-67-import { startStaleRunReaperSweep, stopStaleRunReaperSweep } from './sessions/stale-run-reaper.ts'
hub/src/index.ts:68:import { startOnceDueSweep, stopOnceDueSweep } from './scheduler/once-due-sweep.ts'
hub/src/index.ts-69-import { healUnifiedEnabled } from './heal/config.ts'
hub/src/index.ts-70-import { assertTokenCapConfig } from './dispatch/gates.ts'
hub/src/index.ts-71-import { assertAutomationControlsEnv, assertAutomationControlsTables } from './dispatch/automation-controls.ts'
hub/src/index.ts-72-import { registerTokenCapAlarm } from './observability/token-cap-alarm.ts'
hub/src/index.ts-73-import { apiKeyMiddleware } from './auth/api-key-middleware'
--
hub/src/index.ts-825-  })
hub/src/index.ts-826-  .catch((err) => {
hub/src/index.ts-827-    console.error('[startup] migration/init error:', err.message)
hub/src/index.ts-828-  })
hub/src/index.ts-829-
hub/src/index.ts:830:// Graceful shutdown — pause cron jobs and clear pending post-run timers.
hub/src/index.ts-831-function gracefulShutdown(signal: string) {
hub/src/index.ts:832:  console.log(`[shutdown] received ${signal}, pausing schedulers`)
hub/src/index.ts-833-  try { schedRegistry.pauseAll() } catch {}
hub/src/index.ts-834-  try { clearPostRunTimers() } catch {}
hub/src/index.ts-835-  try { stopRoutineQueueWorker() } catch {}
hub/src/index.ts-836-  try { stopDueOrchestratorTick() } catch {}
hub/src/index.ts-837-  try { stopGhostReaperSweep() } catch {}

 succeeded in 501ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
  101:   owner_email_delivered_at?: string | Date | null
  102:   created_at: string | Date
  103:   updated_at: string | Date
  104: }
  105: 
  106: /** Delete at most 100 rows older than max(retentionHours, 24h). Never younger than 24h. */
  107: export async function pruneHealEvents(
  108:   retentionHours: number,
  109:   exec: HealExec = sql,
  110:   nowMs: number = Date.now(),
  111: ): Promise<void> {
  112:   const hours = Number.isFinite(retentionHours) ? Math.max(retentionHours, MIN_RETENTION_HOURS) : MIN_RETENTION_HOURS
  113:   const cutoff = new Date(nowMs - hours * HOUR_MS)
  114:   await exec`
  115:     DELETE FROM heal_events WHERE id IN (
  116:       SELECT id FROM heal_events WHERE created_at < ${cutoff} ORDER BY created_at LIMIT 100
  117:     )
  118:   `
  119: }
  120: 
  121: /** The task id of a `task:<id>:<signature>` dedupe key, else null. */
  122: function taskIdOf(dedupeKey: string): string | null {
  123:   const m = /^task:([^:]+):/.exec(dedupeKey)
  124:   return m ? m[1]! : null
  125: }
  126: 
  127: export async function claimHealEvent(args: ClaimHealArgs, exec: HealExec = sql): Promise<ClaimHealResult> {
  128:   const now = args.nowMs ?? Date.now()
  129:   const bucket = windowBucket(now, args.windowMs) // throws RangeError on a bad window
  130:   if (!Number.isFinite(args.maxClaimsPerUserHour) || args.maxClaimsPerUserHour <= 0) {
  131:     throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
hub/src/db/heal-events-dal.ts-102-  created_at: string | Date
hub/src/db/heal-events-dal.ts-103-  updated_at: string | Date
hub/src/db/heal-events-dal.ts-104-}
hub/src/db/heal-events-dal.ts-105-
hub/src/db/heal-events-dal.ts-106-/** Delete at most 100 rows older than max(retentionHours, 24h). Never younger than 24h. */
hub/src/db/heal-events-dal.ts:107:export async function pruneHealEvents(
hub/src/db/heal-events-dal.ts-108-  retentionHours: number,
hub/src/db/heal-events-dal.ts-109-  exec: HealExec = sql,
hub/src/db/heal-events-dal.ts-110-  nowMs: number = Date.now(),
hub/src/db/heal-events-dal.ts-111-): Promise<void> {
hub/src/db/heal-events-dal.ts-112-  const hours = Number.isFinite(retentionHours) ? Math.max(retentionHours, MIN_RETENTION_HOURS) : MIN_RETENTION_HOURS
--
hub/src/db/heal-events-dal.ts-131-    throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
hub/src/db/heal-events-dal.ts-132-  }
hub/src/db/heal-events-dal.ts-133-
hub/src/db/heal-events-dal.ts-134-  // Opportunistic bounded reap, outside the lock. A reap failure must not block a claim.
hub/src/db/heal-events-dal.ts-135-  try {
hub/src/db/heal-events-dal.ts:136:    await pruneHealEvents(args.retentionHours, exec, now)
hub/src/db/heal-events-dal.ts-137-  } catch (err: any) {
hub/src/db/heal-events-dal.ts-138-    console.warn(`[heal-events] opportunistic prune failed: ${err?.message ?? err}`)
hub/src/db/heal-events-dal.ts-139-  }
hub/src/db/heal-events-dal.ts-140-
hub/src/db/heal-events-dal.ts-141-  const windowStart = new Date(now - args.windowMs)
--
hub/src\db\heal-events-dal.ts-102-  created_at: string | Date
hub/src\db\heal-events-dal.ts-103-  updated_at: string | Date
hub/src\db\heal-events-dal.ts-104-}
hub/src\db\heal-events-dal.ts-105-
hub/src\db\heal-events-dal.ts-106-/** Delete at most 100 rows older than max(retentionHours, 24h). Never younger than 24h. */
hub/src\db\heal-events-dal.ts:107:export async function pruneHealEvents(
hub/src\db\heal-events-dal.ts-108-  retentionHours: number,
hub/src\db\heal-events-dal.ts-109-  exec: HealExec = sql,
hub/src\db\heal-events-dal.ts-110-  nowMs: number = Date.now(),
hub/src\db\heal-events-dal.ts-111-): Promise<void> {
hub/src\db\heal-events-dal.ts-112-  const hours = Number.isFinite(retentionHours) ? Math.max(retentionHours, MIN_RETENTION_HOURS) : MIN_RETENTION_HOURS
--
hub/src\db\heal-events-dal.ts-131-    throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
hub/src\db\heal-events-dal.ts-132-  }
hub/src\db\heal-events-dal.ts-133-
hub/src\db\heal-events-dal.ts-134-  // Opportunistic bounded reap, outside the lock. A reap failure must not block a claim.
hub/src\db\heal-events-dal.ts-135-  try {
hub/src\db\heal-events-dal.ts:136:    await pruneHealEvents(args.retentionHours, exec, now)
hub/src\db\heal-events-dal.ts-137-  } catch (err: any) {
hub/src\db\heal-events-dal.ts-138-    console.warn(`[heal-events] opportunistic prune failed: ${err?.message ?? err}`)
hub/src\db\heal-events-dal.ts-139-  }
hub/src\db\heal-events-dal.ts-140-
hub/src\db\heal-events-dal.ts-141-  const windowStart = new Date(now - args.windowMs)

 succeeded in 518ms:
PSReadLine v2.2+ detected - enabling prediction features
Error configuring PSReadLine: The predictive suggestion feature cannot be enabled because the console output doesn't support virtual terminal processing or it's redirected.
hub/src/heal/config.ts-38-
hub/src/heal/config.ts-39-export function healMaxPerTaskDay(): number {
hub/src/heal/config.ts-40-  return positiveKnob('REMO_HEAL_MAX_PER_TASK_DAY', 3);
hub/src/heal/config.ts-41-}
hub/src/heal/config.ts-42-
hub/src/heal/config.ts-43-/** Retention floors at 24h (AM-F3-3): a shorter window would drop dedupe state early. */
hub/src/heal/config.ts:44:export function healRetentionHours(): number {
hub/src/heal/config.ts:45:  return Math.max(24, positiveKnob('REMO_HEAL_RETENTION_HOURS', 48));
hub/src/heal/config.ts-46-}
hub/src/heal/config.ts-47-
hub/src/heal/config.ts-48-/**
hub/src/heal/config.ts-49- * Heal autospawn is armed only when the heal flag AND the autospawn flag are ON. Heal has its
hub/src/heal/config.ts-50- * own flag (AM-F1-1): it deliberately does not depend on the orchestrator live-path gate.
hub/src/heal/config.ts-51- */
--
docs\orchestrator-autospawn-runbook.md-123-
docs\orchestrator-autospawn-runbook.md-124-Flip order (OWNER decision, after Steps 1-3 above):
docs\orchestrator-autospawn-runbook.md-125-
docs\orchestrator-autospawn-runbook.md-126-1. Set `REMO_ORCHESTRATOR_AUTOSPAWN=1` (Step 4) if it is not already on.
docs\orchestrator-autospawn-runbook.md-127-2. Set `REMO_HEAL_UNIFIED=1` on the hub app and redeploy. Optional knobs: `REMO_HEAL_DEDUPE_WINDOW_MS`,
docs\orchestrator-autospawn-runbook.md-128-   `REMO_HEAL_SPAWN_TIMEOUT_MS`, `REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR`, `REMO_HEAL_MAX_PER_REPO_HOUR`,
docs\orchestrator-autospawn-runbook.md:129:   `REMO_HEAL_MAX_PER_TASK_DAY`, `REMO_HEAL_RETENTION_HOURS` (defaults in `docs/self-heal-routing.md`;
docs\orchestrator-autospawn-runbook.md-130-   a bad value falls back to the default, it never disables a bound).
docs\orchestrator-autospawn-runbook.md-131-3. Add the first repo to the allowlist only when you want an offline-session heal for it (Step 1).
docs\orchestrator-autospawn-runbook.md-132-
docs\orchestrator-autospawn-runbook.md-133-Verify:
docs\orchestrator-autospawn-runbook.md-134-
docs\orchestrator-autospawn-runbook.md-135-```sql
--
hub/test\heal-config.test.ts-8-  healAutospawnArmed,
hub/test\heal-config.test.ts-9-  healDedupeWindowMs,
hub/test\heal-config.test.ts-10-  healSpawnTimeoutMs,
hub/test\heal-config.test.ts-11-  healMaxClaimsPerUserHour,
hub/test\heal-config.test.ts-12-  healMaxPerRepoHour,
hub/test\heal-config.test.ts-13-  healMaxPerTaskDay,
hub/test\heal-config.test.ts:14:  healRetentionHours,
hub/test\heal-config.test.ts-15-} from '../src/heal/config.ts'
hub/test\heal-config.test.ts-16-
hub/test\heal-config.test.ts-17-const ENV_KEYS = [
hub/test\heal-config.test.ts-18-  'REMO_HEAL_UNIFIED',
hub/test\heal-config.test.ts-19-  'REMO_HEAL_DEDUPE_WINDOW_MS',
hub/test\heal-config.test.ts-20-  'REMO_HEAL_SPAWN_TIMEOUT_MS',
hub/test\heal-config.test.ts-21-  'REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR',
hub/test\heal-config.test.ts-22-  'REMO_HEAL_MAX_PER_REPO_HOUR',
hub/test\heal-config.test.ts-23-  'REMO_HEAL_MAX_PER_TASK_DAY',
hub/test\heal-config.test.ts:24:  'REMO_HEAL_RETENTION_HOURS',
hub/test\heal-config.test.ts-25-  'REMO_ORCHESTRATOR_AUTOSPAWN',
hub/test\heal-config.test.ts-26-  'REMO_ORCHESTRATOR_ENABLED',
hub/test\heal-config.test.ts-27-]
hub/test\heal-config.test.ts-28-let saved: Record<string, string | undefined> = {}
hub/test\heal-config.test.ts-29-
hub/test\heal-config.test.ts-30-beforeEach(() => {
--
hub/test\heal-config.test.ts-68-  const cases: Array<[string, () => number, string, number]> = [
hub/test\heal-config.test.ts-69-    ['dedupe window', healDedupeWindowMs, 'REMO_HEAL_DEDUPE_WINDOW_MS', 900000],
hub/test\heal-config.test.ts-70-    ['spawn timeout', healSpawnTimeoutMs, 'REMO_HEAL_SPAWN_TIMEOUT_MS', 25000],
hub/test\heal-config.test.ts-71-    ['claims per user hour', healMaxClaimsPerUserHour, 'REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR', 30],
hub/test\heal-config.test.ts-72-    ['per repo hour', healMaxPerRepoHour, 'REMO_HEAL_MAX_PER_REPO_HOUR', 4],
hub/test\heal-config.test.ts-73-    ['per task day', healMaxPerTaskDay, 'REMO_HEAL_MAX_PER_TASK_DAY', 3],
hub/test\heal-config.test.ts:74:    ['retention hours', healRetentionHours, 'REMO_HEAL_RETENTION_HOURS', 48],
hub/test\heal-config.test.ts-75-  ]
hub/test\heal-config.test.ts-76-  for (const [name, fn, env, def] of cases) {
hub/test\heal-config.test.ts-77-    test(`${name}: default ${def}`, () => {
hub/test\heal-config.test.ts-78-      expect(fn()).toBe(def)
hub/test\heal-config.test.ts-79-    })
hub/test\heal-config.test.ts-80-    test(`${name}: "0", "-5", NaN, abc, Infinity, empty all yield the default`, () => {
--
hub/test\heal-config.test.ts-88-    process.env.REMO_HEAL_DEDUPE_WINDOW_MS = '60000'
hub/test\heal-config.test.ts-89-    expect(healDedupeWindowMs()).toBe(60000)
hub/test\heal-config.test.ts-90-    process.env.REMO_HEAL_MAX_PER_REPO_HOUR = '9'
hub/test\heal-config.test.ts-91-    expect(healMaxPerRepoHour()).toBe(9)
hub/test\heal-config.test.ts-92-  })
hub/test\heal-config.test.ts-93-  test('retention never drops below 24h', () => {
hub/test\heal-config.test.ts:94:    process.env.REMO_HEAL_RETENTION_HOURS = '6'
hub/test\heal-config.test.ts:95:    expect(healRetentionHours()).toBe(24)
hub/test\heal-config.test.ts:96:    process.env.REMO_HEAL_RETENTION_HOURS = '72'
hub/test\heal-config.test.ts:97:    expect(healRetentionHours()).toBe(72)
hub/test\heal-config.test.ts-98-  })
hub/test\heal-config.test.ts-99-})
hub/test\heal-config.test.ts-100-
hub/test\heal-config.test.ts-101-describe('healAutospawnArmed', () => {
hub/test\heal-config.test.ts-102-  test('true with heal ON + autospawn ON and REMO_ORCHESTRATOR_ENABLED unset', () => {
hub/test\heal-config.test.ts-103-    process.env.REMO_HEAL_UNIFIED = '1'
--
docs\self-heal-routing.md-125-(`error_id`/`project_id` for error_capture; nothing else).
docs\self-heal-routing.md-126-
docs\self-heal-routing.md-127-Columns of note: `outcome`, `repo_ident`, `session_id`, `trigger_run_id` (the run that failed) vs
docs\self-heal-routing.md-128-`dispatch_run_id` (the run the heal created), `notification_claimed_at`, `updated_at`. Every
docs\self-heal-routing.md-129-heal-generated run is traceable to a heal event, which is what the recursion guard checks.
docs\self-heal-routing.md-130-A row written before routing with a NULL outcome still dedupes (a crash mid-route fails closed on
docs\self-heal-routing.md:131:duplicates). Retention is at least 24h (`REMO_HEAL_RETENTION_HOURS`, floor 24), pruned
docs\self-heal-routing.md-132-opportunistically by a bounded DELETE in the DAL before a claim; a prune failure is logged and
docs\self-heal-routing.md-133-never blocks a claim. The Coolify `coolify_deploy_idempotency` table is untouched and used only on
docs\self-heal-routing.md-134-the flag-OFF path.
docs\self-heal-routing.md-135-
docs\self-heal-routing.md-136-## 6. Notification guarantee
docs\self-heal-routing.md-137-
--
docs\self-heal-routing.md-187-| `REMO_HEAL_UNIFIED` | OFF | master flag; only `1`, `true`, `yes`, `on` (case-insensitive, trimmed) turn it ON |
docs\self-heal-routing.md-188-| `REMO_HEAL_DEDUPE_WINDOW_MS` | 900000 | dedupe window per `(user, source, dedupe_key)` |
docs\self-heal-routing.md-189-| `REMO_HEAL_SPAWN_TIMEOUT_MS` | 25000 | deadline for a launched session to connect |
docs\self-heal-routing.md-190-| `REMO_HEAL_MAX_CLAIMS_PER_USER_HOUR` | 30 | per-user cap on new claims per hour |
docs\self-heal-routing.md-191-| `REMO_HEAL_MAX_PER_REPO_HOUR` | 4 | per-repo hourly dispatch bound |
docs\self-heal-routing.md-192-| `REMO_HEAL_MAX_PER_TASK_DAY` | 3 | per-scheduled-task daily heal ceiling |
docs\self-heal-routing.md:193:| `REMO_HEAL_RETENTION_HOURS` | 48 | ledger retention, floor 24 |
docs\self-heal-routing.md-194-
docs\self-heal-routing.md-195-Arming for the autospawn branch needs the heal flag AND `REMO_ORCHESTRATOR_AUTOSPAWN`
docs\self-heal-routing.md-196-(`healAutospawnArmed`). It does NOT depend on `REMO_ORCHESTRATOR_ENABLED`. The allowlist
docs\self-heal-routing.md-197-(`orchestrator_autospawn_allowlist`) is shared with the orchestrator and EMPTY by default, so a
docs\self-heal-routing.md-198-default configuration spawns nothing: live dispatch and fail-fast still work, autospawn is a
docs\self-heal-routing.md-199-no-op. Arming is an owner action; steps are in `orchestrator-autospawn-runbook.md`.

codex
- MAJOR — Failed sends are not reliably retried. [`owner-email.ts:50`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/owner-email.ts:50) releases the lease after failure, but [`owner-email.ts:83`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/owner-email.ts:83) still suppresses the legacy email. The sweep runs only at boot and once more ([`sweep.ts:174`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/sweep.ts:174)), with each pass limited to 50 rows ([`heal-events-dal.ts:404`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:404)). Failures occurring after that follow-up—or a backlog over 100—receive no retry until another restart. Worse, pruning deletes old rows without excluding undelivered obligations ([`heal-events-dal.ts:114`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:114)), making the notification loss permanent.

- MAJOR — An obligation-probe error can produce duplicate emails. [`owner-email.ts:71`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/heal/owner-email.ts:71) returns `false` when the probe throws, causing the scheduler to retain the legacy default email path ([`dispatcher.ts:844`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/scheduler/dispatcher.ts:844)). The already-persisted obligation remains pending and is later selected by the sweep ([`heal-events-dal.ts:404`](C:/Users/artic/GitHub/remo-code-ptycap07/hub/src/db/heal-events-dal.ts:404)), sending a second email.

FINAL VERDICT: CONTENT-BLOCK
