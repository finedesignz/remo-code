/**
 * auto-dev P3 — propose-to-chat roadmap surfacing.
 *
 * When the dev controller decides `action=propose` (no plan AND no clear goal),
 * the post-run router calls `surfaceProposal`. We turn the controller's roadmap
 * into a CLEAR, actionable chat prompt — header + numbered features + a reply
 * instruction — and push it to the user via the existing post-run notify
 * senders (email + Telegram). We also persist a `pending_proposal` record on the
 * task so a later human reply (HITL, telegram-webhook) can be matched back and
 * written into `payload.notes`.
 *
 * `propose` NEVER auto-builds. This is the ONLY path: roadmap → chat → user
 * reply → `payload.notes` → next-tick controller chooses `plan`.
 *
 * Throttle / dedupe: reuse the `notifications_sent` table (same pattern as
 * `error-capture/notify.ts`). One propose-notify per
 * (`propose_roadmap`, task + roadmap-hash) within `PROPOSE_TTL_SECONDS`, so a
 * routine that keeps ticking `propose` with the same roadmap notifies once.
 *
 * Best-effort throughout: a failed send / DB write is log-only and never fails
 * the parent run.
 */
import { createHash } from 'node:crypto'
import { sql } from '../../db/postgres.ts'
import {
  setPendingProposal,
  findPendingProposalTasksForUser,
  captureProposalNotes,
} from '../../db/scheduled-tasks-dal.ts'
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import type { ControllerDecision } from '../controller-schema.ts'
import { executeEmail } from './email.ts'
import { executeTelegram } from './telegram.ts'

/** One propose-notify per (task, roadmap) per 6h. A stable roadmap → one ping. */
export const PROPOSE_TTL_SECONDS = 6 * 60 * 60

/**
 * Split a controller roadmap into discrete feature items. The controller
 * template emits `" | "`-separated items on one line (so the line-based decision
 * parser captures the whole roadmap); tolerate newline-separated too.
 */
export function parseRoadmapItems(roadmap: string): string[] {
  return roadmap
    .split(/\s*\|\s*|\n/)
    .map((s) => s.trim().replace(/^[-*\d.)\s]+/, '').trim())
    .filter((s) => s.length > 0)
}

/** Stable hash of the roadmap text — the dedupe key component. */
function roadmapHash(roadmap: string): string {
  return createHash('sha256').update(roadmap.trim()).digest('hex').slice(0, 16)
}

/**
 * Format the actionable chat message. Plain text (works for both Telegram and
 * the email text/HTML body via the existing renderer). Numbered so a reply like
 * "1, 3" selects items.
 */
export function formatProposalMessage(taskName: string, items: string[]): string {
  const numbered = items.map((it, i) => `${i + 1}. ${it}`).join('\n')
  return (
    `Routine "${taskName}" has no plan or goal and proposes:\n\n` +
    `${numbered}\n\n` +
    `Reply with the number(s) or text to approve — I'll plan it next run.`
  )
}

/**
 * Throttle gate over `notifications_sent`. Returns true when a send is allowed
 * (and records the attempt), false when suppressed within the TTL. Mirrors the
 * error-capture throttle: record BEFORE sending so a transient send failure
 * can't cause a retry storm on the next identical propose tick.
 */
async function throttleAllow(dedupeKey: string, ttlSeconds: number): Promise<boolean> {
  try {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM notifications_sent
      WHERE kind = 'propose_roadmap'
        AND dedupe_key = ${dedupeKey}
        AND sent_at > now() - (${ttlSeconds} || ' seconds')::interval
      LIMIT 1
    `
    if (existing.length > 0) return false
  } catch (err: any) {
    // Better to risk a duplicate than to drop the proposal — fall through.
    console.error('[propose-notify] throttle check failed:', err?.message)
  }
  try {
    await sql`
      INSERT INTO notifications_sent (kind, dedupe_key) VALUES ('propose_roadmap', ${dedupeKey})
    `
  } catch (err: any) {
    console.error('[propose-notify] throttle insert failed:', err?.message)
  }
  return true
}

/**
 * HITL reply resolution. Given a pending proposal and a free-form reply, decide
 * which roadmap text the user approved.
 *
 *   - Pure number selection ("1", "1,3", "1 and 2") → the named items, joined.
 *   - Anything else → the verbatim reply (the user typed a custom goal).
 *
 * Returns the notes string to write into `payload.notes`, or null when the reply
 * is empty. Number tokens out of range are ignored; if numbers were given but
 * none resolved, falls back to the verbatim reply.
 */
export function resolveApprovalNotes(items: string[], reply: string): string | null {
  const text = (reply ?? '').trim()
  if (!text) return null

  const sel = parsePureSelection(items, text)
  if (sel) return sel
  return text
}

/**
 * Return the joined item text iff `reply` is JUST a number selection ("1",
 * "1,3", "1 and 2") that resolves to ≥1 in-range item; else null. Used by the
 * inbound auto-capture path to AVOID hijacking unrelated chat — only an
 * unambiguous numeric selection is auto-consumed as an approval.
 */
export function parsePureSelection(items: string[], reply: string): string | null {
  const text = (reply ?? '').trim()
  if (!text) return null
  if (!/^[\d\s,&]*(and\b[\s\d,&]*)*$/i.test(text)) return null
  const nums = (text.match(/\d+/g) ?? []).map((n) => parseInt(n, 10))
  const chosen = nums.filter((n) => n >= 1 && n <= items.length).map((n) => items[n - 1]!)
  return chosen.length > 0 ? chosen.join('; ') : null
}

/**
 * HITL capture entry point — called from inbound chat (Telegram webhook; a web
 * chat path can call the same). If the user has a pending proposal and `reply`
 * approves it, write the chosen item(s) into that routine's `payload.notes`,
 * clear the pending proposal, and return a confirmation. Returns null when there
 * is no pending proposal to capture against (caller proceeds normally — the
 * message is a regular chat message, not an approval).
 *
 * Matching: a user typically has exactly one pending proposal. With several, we
 * pick the most recent (findPendingProposalTasksForUser orders by proposed_at
 * DESC). Keeping it simple avoids a per-message ambiguity prompt; a stale
 * proposal still clears on the next propose tick or on capture.
 */
export async function captureApprovalReply(
  userId: string,
  reply: string,
  opts: { requireSelection?: boolean } = {},
): Promise<{ taskId: string; taskName: string; notes: string } | null> {
  const text = (reply ?? '').trim()
  if (!text) return null

  let pending: Awaited<ReturnType<typeof findPendingProposalTasksForUser>>
  try {
    pending = await findPendingProposalTasksForUser(userId)
  } catch (err: any) {
    console.error('[propose-notify] pending lookup failed:', err?.message)
    return null
  }
  if (pending.length === 0) return null

  const target = pending[0]!
  // `requireSelection` (inbound chat auto-capture) only consumes an unambiguous
  // numeric selection, so unrelated chat is never hijacked as an approval.
  const notes = opts.requireSelection
    ? parsePureSelection(target.proposal.items, text)
    : resolveApprovalNotes(target.proposal.items, text)
  if (!notes) return null

  try {
    const ok = await captureProposalNotes(target.id, userId, notes)
    if (!ok) return null
  } catch (err: any) {
    console.error(`[propose-notify] captureProposalNotes failed task=${target.id}:`, err?.message)
    return null
  }

  console.log(`[propose-notify] captured approval into payload.notes task=${target.id}`)
  return { taskId: target.id, taskName: target.name, notes }
}

export interface SurfaceProposalArgs {
  task: ScheduledTask
  decision: ControllerDecision
  runId: string
}

/**
 * Surface a `propose` roadmap to chat (email + Telegram) and persist the
 * pending-proposal record for HITL reply capture. Idempotent within the TTL.
 *
 * Returns the formatted message text (for logging/tests), or null when there is
 * no roadmap to surface or the notify was throttled.
 */
export async function surfaceProposal(args: SurfaceProposalArgs): Promise<string | null> {
  const roadmap = args.decision.roadmap?.trim()
  if (!roadmap) {
    console.log(`[propose-notify] task=${args.task.id} propose with empty roadmap; nothing to surface`)
    return null
  }

  const items = parseRoadmapItems(roadmap)
  if (items.length === 0) return null

  const dedupeKey = `${args.task.id}:${roadmapHash(roadmap)}`
  const allowed = await throttleAllow(dedupeKey, PROPOSE_TTL_SECONDS)
  if (!allowed) {
    console.log(`[propose-notify] task=${args.task.id} propose suppressed (throttle) key=${dedupeKey}`)
    return null
  }

  // Persist the pending proposal so a human reply can be matched back to this
  // routine and written into payload.notes (HITL). Best-effort.
  try {
    await setPendingProposal(args.task.id, {
      roadmap,
      items,
      run_id: args.runId,
      proposed_at: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error(`[propose-notify] setPendingProposal failed task=${args.task.id}:`, err?.message)
  }

  const message = formatProposalMessage(args.task.name, items)

  // Reuse the existing post-run senders. We synthesize in-memory notify actions
  // (NOT persisted) so the formatting + recipient resolution lives in one place.
  // Both are log-only on failure and never throw upstream.
  const userId = args.task.user_id
  const templateVars = { proposal: message }

  await executeEmail(
    {
      type: 'notify_email',
      on: 'success',
      config: {
        // `to` undefined → executeEmail resolves the account email.
        subject: `[remo-code] "${args.task.name}" proposes a roadmap`,
        body: '{{proposal}}',
      },
    } as any,
    { userId, templateVars },
  )

  await executeTelegram(
    { type: 'notify_telegram', on: 'success', config: { body: '{{proposal}}' } } as any,
    { userId, templateVars },
  )

  console.log(`[propose-notify] task=${args.task.id} surfaced roadmap (${items.length} items)`)
  return message
}
