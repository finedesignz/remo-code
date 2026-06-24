/**
 * Tracks sessions currently BLOCKED on a pending interactive prompt
 * (permission_request or user_question) awaiting a user decision.
 *
 * Why: a Telegram-driven session is not a persistent WS subscriber, so when the
 * agent asks a question and waits, the idle-teardown timer (subscriber count → 0)
 * would kill the session before the user can answer. We mark a session pending on
 * prompt emit and clear it on response / assistant_message / status:idle, then
 * exempt pending sessions from idle teardown (a second exemption alongside the
 * orchestrator).
 *
 * Single-process hub → a module-level Set keyed by sessionId is sufficient. A
 * session may have multiple concurrent prompts; we count requestIds so the
 * session stays pending until ALL open prompts resolve.
 */

/** sessionId → set of open requestIds (permission or question). */
const pendingBySession = new Map<string, Set<string>>();

/** Mark a prompt (requestId) open for a session. Idempotent per requestId. */
export function markPromptPending(sessionId: string, requestId: string): void {
  let set = pendingBySession.get(sessionId);
  if (!set) {
    set = new Set();
    pendingBySession.set(sessionId, set);
  }
  set.add(requestId);
}

/** Clear a single resolved prompt. Removes the session when no prompts remain. */
export function clearPromptPending(sessionId: string, requestId: string): void {
  const set = pendingBySession.get(sessionId);
  if (!set) return;
  set.delete(requestId);
  if (set.size === 0) pendingBySession.delete(sessionId);
}

/** Clear ALL pending prompts for a session (turn finalized / session gone). */
export function clearAllPromptsPending(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

/** True when the session is waiting on at least one user decision. */
export function hasPendingPrompt(sessionId: string): boolean {
  const set = pendingBySession.get(sessionId);
  return !!set && set.size > 0;
}

/** Test-only — wipe state. */
export function _resetPendingPromptsTrackerForTests(): void {
  pendingBySession.clear();
}
