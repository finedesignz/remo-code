// hub/src/corch/flag.ts
//
// CORCH-01 (CORCH-R1.2, R1.3): the central-orchestrator flag and knobs. Read at call time, default
// OFF. Never imports orchestrator code: the mutual-exclusion check reads REMO_ORCHESTRATOR_ENABLED
// through the same private parser.

function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function corchEnabled(): boolean {
  return truthy(process.env.REMO_CORCH_ENABLED)
}

/** Lease before a run with no positive liveness knowledge is reclaimed / stalled (default 2min). */
export function corchLeaseMs(): number {
  return positiveInt(process.env.REMO_CORCH_LEASE_MS, 120000)
}

/** The reconciler's single interval (default 1min). */
export function corchReconcileIntervalMs(): number {
  return positiveInt(process.env.REMO_CORCH_RECONCILE_INTERVAL_MS, 60000)
}

/**
 * CORCH-02 (LD-Q7): the eligibility ceiling on max(5h, 7d) utilization, percent. Default 55 when unset.
 * A set value that is non-numeric, <= 0 or > 100 THROWS: a typo must never silently become a default.
 */
export function corchQuotaCeilingPct(): number {
  const raw = process.env.REMO_CORCH_QUOTA_CEILING_PCT
  if (raw === undefined || raw.trim() === '') return 55
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new Error('REMO_CORCH_QUOTA_CEILING_PCT must be a number greater than 0 and at most 100 (got an invalid value)')
  }
  return n
}

/** Boot refusal: CORCH and the old orchestrator must never both be enabled (CORCH-R1.3). */
export function assertCorchConfig(): void {
  if (truthy(process.env.REMO_CORCH_ENABLED) && truthy(process.env.REMO_ORCHESTRATOR_ENABLED)) {
    throw new Error(
      'REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED are both set: the central orchestrator and the ' +
        'old auto-dev orchestrator are mutually exclusive. Unset one of them.',
    )
  }
  // CORCH-02: a bad ceiling refuses boot only when CORCH is on (flag OFF is a true no-op).
  if (corchEnabled()) corchQuotaCeilingPct()
}
