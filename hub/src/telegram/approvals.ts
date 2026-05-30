/**
 * Telegram inline-approval registry.
 *
 * When a runner raises a `permission_request`, the Telegram bridge sends an
 * inline keyboard (Approve / Deny) and records the prompt context here keyed by
 * the runner's `request_id`. The webhook's callback_query handler looks the
 * entry up when the user taps a button, then forwards a `permission_response`
 * onto the session's agent socket.
 *
 * Why an in-memory map instead of encoding context in callback_data: Telegram
 * caps callback_data at 64 bytes — too small for a session UUID + request UUID
 * + user binding. The map binds requestId → {sessionId, userId, ...} so:
 *   - callback_data stays tiny (`pa:<requestId>` / `pd:<requestId>`),
 *   - the entry's `userId` enforces authorization (a foreign chat tapping a
 *     stale/guessed requestId finds no entry, or one bound to another user).
 *
 * Entries are pruned on a TTL (the runner's prompt won't wait forever) and
 * removed once resolved. Single-process hub → a module-level Map is fine; a
 * future multi-instance hub would move this to Redis (same shape).
 */

export interface PendingPrompt {
  sessionId: string;
  userId: string;
  chatId: number | string;
  /** The Telegram message_id of the prompt, so we can edit it after a decision. */
  messageId: number;
  toolName: string;
  createdAtMs: number;
}

/** Permission prompts expire after 10 minutes (matches typical runner waits). */
export const PROMPT_TTL_MS = 10 * 60 * 1000;

const pending = new Map<string, PendingPrompt>();

function prune(now: number): void {
  for (const [id, p] of pending) {
    if (now - p.createdAtMs > PROMPT_TTL_MS) pending.delete(id);
  }
}

/** Record a pending prompt keyed by requestId. Prunes stale entries first. */
export function rememberPendingPrompt(requestId: string, p: PendingPrompt): void {
  prune(Date.now());
  pending.set(requestId, p);
}

/** Look up + REMOVE a pending prompt (resolved exactly once). */
export function takePendingPrompt(requestId: string): PendingPrompt | null {
  const p = pending.get(requestId);
  if (!p) return null;
  pending.delete(requestId);
  if (Date.now() - p.createdAtMs > PROMPT_TTL_MS) return null;
  return p;
}

/** Test-only — clear the registry. */
export function _resetPendingPromptsForTests(): void {
  pending.clear();
}

// ── callback_data encoding (≤64 bytes) ──────────────────────────────────────
// "pa:<requestId>" — approve, "pd:<requestId>" — deny.

const APPROVE_PREFIX = "pa:";
const DENY_PREFIX = "pd:";

export function permissionCallbackData(requestId: string, decision: "approve" | "deny"): string {
  return (decision === "approve" ? APPROVE_PREFIX : DENY_PREFIX) + requestId;
}

export type PermissionCallback = { requestId: string; approved: boolean };

/** Parse a permission callback_data string, or null if it isn't one. */
export function parsePermissionCallback(data: string | undefined | null): PermissionCallback | null {
  if (!data) return null;
  if (data.length > 64) return null; // Telegram hard limit; defensive.
  if (data.startsWith(APPROVE_PREFIX)) {
    const id = data.slice(APPROVE_PREFIX.length);
    if (id.length === 0 || id.length > 60) return null;
    return { requestId: id, approved: true };
  }
  if (data.startsWith(DENY_PREFIX)) {
    const id = data.slice(DENY_PREFIX.length);
    if (id.length === 0 || id.length > 60) return null;
    return { requestId: id, approved: false };
  }
  return null;
}
