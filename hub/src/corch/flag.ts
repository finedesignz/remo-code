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

/** Boot refusal: CORCH and the old orchestrator must never both be enabled (CORCH-R1.3). */
export function assertCorchConfig(): void {
  if (truthy(process.env.REMO_CORCH_ENABLED) && truthy(process.env.REMO_ORCHESTRATOR_ENABLED)) {
    throw new Error(
      'REMO_CORCH_ENABLED and REMO_ORCHESTRATOR_ENABLED are both set: the central orchestrator and the ' +
        'old auto-dev orchestrator are mutually exclusive. Unset one of them.',
    )
  }
}
