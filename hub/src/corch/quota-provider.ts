// hub/src/corch/quota-provider.ts
//
// CORCH-01 (LD-11): the quota seam. CORCH-02 supplies the real provider; until then the default
// refuses, so no work item can launch (CORCH-R1.13). No account selection in this phase: the gate
// ignores account_slot / supervisor_id on success.

export type QuotaSnapshot = { ok: true; account_slot: string | null; supervisor_id: string | null } | { ok: false; reason: string }

export interface QuotaProvider {
  snapshotFor(a: { userId: string; projectId: string; workItemId: string }): Promise<QuotaSnapshot>
}

export const DEFAULT_QUOTA_PROVIDER: QuotaProvider = {
  snapshotFor: async () => ({ ok: false, reason: 'quota_no_snapshot' }),
}
