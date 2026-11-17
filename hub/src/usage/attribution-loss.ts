// hub/src/usage/attribution-loss.ts
// PTYCAP-05 QC round 1 (codex #4): in-process record of "a usage_event for this session was
// received but could NOT be persisted".
//
// The proof's hard token budget sums token_usage. A persist failure used to be logged and dropped
// (ws/agent.ts usage_event handler), so after a transient DB error the budget silently
// under-counted. The handler now marks the session here; sumSessionTokensSince reports
// `attributionLost` for any window the loss falls inside, and both proof consumers (budget gate,
// tick evaluator) terminalize as budget_attribution_lost (fail closed).
//
// Deliberately NOT an outbox: the proof is fail-closed, so detecting the loss is enough. Scope
// limit (documented in the runbook): this is process memory, so a hub restart forgets it; a
// usage_event that never reaches a handler at all (hub down) is not observable here.

const MAX_ENTRIES = 1000;

/** sessionId -> epoch ms of the most recent failed persist. Insertion order = eviction order. */
const lostAt = new Map<string, number>();

export function markUsageAttributionLost(sessionId: string | null | undefined, at: number = Date.now()): void {
  if (!sessionId) return;
  lostAt.delete(sessionId); // re-insert so the newest loss is the youngest entry
  lostAt.set(sessionId, at);
  while (lostAt.size > MAX_ENTRIES) {
    const oldest = lostAt.keys().next().value;
    if (oldest === undefined) break;
    lostAt.delete(oldest);
  }
}

/** True when a persist failed for this session at or after `since`. An unparseable `since` fails closed. */
export function usageAttributionLostSince(sessionId: string, since: Date | string): boolean {
  const at = lostAt.get(sessionId);
  if (at === undefined) return false;
  const from = since instanceof Date ? since.getTime() : Date.parse(since);
  return Number.isFinite(from) ? at >= from : true;
}

export function usageAttributionLostSize(): number {
  return lostAt.size;
}

export function resetUsageAttributionLoss(): void {
  lostAt.clear();
}
