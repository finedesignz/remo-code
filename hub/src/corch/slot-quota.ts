// hub/src/corch/slot-quota.ts
//
// CORCH-14: the built-in quota source. A slot supervisor reads its own account's usage windows and reports them
// over /ws/agent (`slot_quota_report`); this stores the reading in corch_quota_accounts with account_id = slot,
// the same row shape and store function the external publisher (POST /api/quota/snapshot) writes. Stored whether
// or not REMO_CORCH_ENABLED is on; eligibility rules are unchanged (quota-eligibility.ts).
//
// Trust: the frame is accepted only when the reporting connection registered that exact account_slot in its
// hello, and user_id is the connection's verified key owner. A supervisor can therefore only ever write its own
// account's row. The frame carries percentages and instants, never a credential.

import type { SupervisorSlotQuotaReportT } from '../ws/agent-protocol.ts'
import type { QuotaAccountInput } from './quota-store.ts'

/** Same bound as the HTTP ingest: a reading dated further ahead would pin the row ahead of every later one. */
const MAX_FUTURE_SKEW_MS = 120_000

export interface SlotQuotaDeps {
  upsertSnapshot: (userId: string, accounts: QuotaAccountInput[]) => Promise<number>
  /** Called once after a stored reading (queue view push + one dispatch evaluation when CORCH is on). */
  evaluate: (userId: string) => Promise<void>
  now: () => Date
}

export type SlotQuotaOutcome = 'stored' | 'slot_mismatch' | 'future_dated'

export async function handleSlotQuotaReport(
  deps: SlotQuotaDeps,
  a: { userId: string; registeredSlot: string | null | undefined; msg: SupervisorSlotQuotaReportT },
): Promise<SlotQuotaOutcome> {
  if (!a.registeredSlot || a.registeredSlot !== a.msg.account_slot) return 'slot_mismatch'
  if (Date.parse(a.msg.fetched_at) > deps.now().getTime() + MAX_FUTURE_SKEW_MS) return 'future_dated'
  await deps.upsertSnapshot(a.userId, [
    {
      account_id: a.msg.account_slot,
      slot: a.msg.account_slot,
      five_h_pct: a.msg.five_h_pct,
      seven_d_pct: a.msg.seven_d_pct,
      resets_5h: a.msg.resets_5h,
      resets_7d: a.msg.resets_7d,
      fetched_at: a.msg.fetched_at,
      // A direct reading of the account's own rate-limit windows: the only source the eligibility rules accept.
      source: 'live',
      enabled: true,
      blocked: false,
    },
  ])
  await deps.evaluate(a.userId).catch(() => {})
  return 'stored'
}
