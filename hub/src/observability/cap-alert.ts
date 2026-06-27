// hub/src/observability/cap-alert.ts
// Phase OBSRV-05: Cap-Approach Alerting.
//
// Evaluates daily token and cost accumulation against configured caps and fires
// a single informational notify.ts fan-out when either crosses the threshold
// percentage. Throttled: fires at most once per cap per UTC calendar day per user.
// Fail-open: never throws; an internal error is swallowed and the cycle continues.

import { fanOutNotify, type NotifyDeps } from '../orchestrator/notify.ts';

// ---------------------------------------------------------------------------
// Per-day per-cap throttle (in-memory; process restart resets to safe default —
// the worst case is one duplicate alert after a restart, which is acceptable).
// Keys: `${userId}:token:${utcDate}` | `${userId}:cost:${utcDate}`
// ---------------------------------------------------------------------------
const alertedToday = new Set<string>();

/** Reset throttle state — exported for test cleanup only. */
export function _resetCapAlertStateForTests(): void {
  alertedToday.clear();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Threshold % (0–100) at which an alert fires. Reads env at call-time. */
function configuredAlertPct(): number {
  const raw = process.env.REMO_ORCHESTRATOR_CAP_ALERT_PCT;
  if (!raw) return 80;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 80;
}

// ---------------------------------------------------------------------------
// Injectable seam (for tests)
// ---------------------------------------------------------------------------

export interface CapAlertDeps {
  fanOut: typeof fanOutNotify;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CapAlertParams {
  userId: string;
  sessionId: string;
  tokenStatus: { tokens: number; cap: number };
  costStatus: { spent: number; cap: number };
}

/**
 * Evaluate whether daily accumulation has crossed the configured alert threshold
 * for either the token cap or the cost cap, and fan-out an `info` notify if so.
 *
 * Never throws. Uses an in-memory per-day dedup set to fire at most once per
 * cap per user per UTC calendar day.
 */
export async function evaluateCapAlert(
  params: CapAlertParams,
  deps?: CapAlertDeps,
): Promise<void> {
  try {
    const { userId, sessionId, tokenStatus, costStatus } = params;
    const fan = deps?.fanOut ?? fanOutNotify;
    const pct = configuredAlertPct();
    const utcDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const alerts: Array<{ key: string; detail: string }> = [];

    // Token cap check
    if (tokenStatus.cap > 0) {
      const tokenPct = (tokenStatus.tokens / tokenStatus.cap) * 100;
      const tokenKey = `${userId}:token:${utcDate}`;
      if (tokenPct >= pct && !alertedToday.has(tokenKey)) {
        alerts.push({
          key: tokenKey,
          detail: `Daily token usage at ${tokenPct.toFixed(1)}% of ${tokenStatus.cap.toLocaleString()}-token cap (${tokenStatus.tokens.toLocaleString()} used)`,
        });
      }
    }

    // Cost cap check
    if (costStatus.cap > 0) {
      const costPct = (costStatus.spent / costStatus.cap) * 100;
      const costKey = `${userId}:cost:${utcDate}`;
      if (costPct >= pct && !alertedToday.has(costKey)) {
        alerts.push({
          key: costKey,
          detail: `Daily cost at ${costPct.toFixed(1)}% of $${costStatus.cap.toFixed(2)} cap ($${costStatus.spent.toFixed(4)} spent)`,
        });
      }
    }

    for (const alert of alerts) {
      // Mark as alerted BEFORE calling fanOut so a throw in fanOut doesn't retry.
      alertedToday.add(alert.key);
      await fan({
        userId,
        sessionId,
        event: 'info',
        level: 'warning',
        detail: alert.detail,
        channels: ['inapp', 'telegram'],
      });
    }
  } catch {
    /* fail-open — alert errors must never break a cycle */
  }
}
