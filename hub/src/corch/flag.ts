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

/**
 * CORCH-04 (CORCH-R1.14, R1.16): the gsd-console source configuration, read at call time. The token is read
 * from the environment ONLY to build one Authorization header; it is never logged, stored or returned.
 *  - off:      CORCH off, or neither variable set (no connection, nothing to report)
 *  - partial:  exactly one of the two set (a misconfiguration: no connection, one notification)
 *  - on:       both set
 */
export type GsdcConfig =
  | { state: 'off' }
  | { state: 'partial'; signature: 'token_unset' | 'url_unset' }
  | { state: 'on'; baseUrl: string; token: string }

export function gsdcConfig(): GsdcConfig {
  if (!corchEnabled()) return { state: 'off' }
  const url = (process.env.REMO_CORCH_GSDC_URL ?? '').trim()
  const token = (process.env.REMO_CORCH_GSDC_TOKEN ?? '').trim()
  if (!url && !token) return { state: 'off' }
  if (!token) return { state: 'partial', signature: 'token_unset' }
  if (!url) return { state: 'partial', signature: 'url_unset' }
  return { state: 'on', baseUrl: url.replace(/\/+$/, ''), token }
}

/**
 * CORCH-08 (CORCH-R5.5): the shared secret the AAF event outbox signs with. Unset/blank => the receiver answers 503
 * and records nothing. Read at call time. Never logged or returned.
 */
export function aafEventSecret(): string | null {
  const v = (process.env.REMO_CORCH_AAF_EVENT_SECRET ?? '').trim()
  return v === '' ? null : v
}

/**
 * CORCH-08 (CORCH-R5.7): the AAF provision endpoint configuration, read at call time.
 *  - off:      REMO_CORCH_AAF_URL or REMO_CORCH_AAF_TOKEN unset (no call is made; the project stays aaf_unprovisioned)
 *  - partial:  URL and token set but REMO_CORCH_AAF_INSTALLATION_ID missing/invalid, or the URL unusable
 *  - on:       a usable https (or loopback http) base URL, a token and the AAF GitHub installation id
 * The token is read only to build one Authorization header.
 */
export type AafProvisionConfig =
  | { state: 'off' }
  | { state: 'partial'; signature: 'installation_unset' | 'bad_url' }
  | { state: 'on'; baseUrl: string; token: string; installationId: number }

export function aafProvisionConfig(): AafProvisionConfig {
  const url = (process.env.REMO_CORCH_AAF_URL ?? '').trim()
  const token = (process.env.REMO_CORCH_AAF_TOKEN ?? '').trim()
  if (!url || !token) return { state: 'off' }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { state: 'partial', signature: 'bad_url' }
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) return { state: 'partial', signature: 'bad_url' }
  const inst = Number((process.env.REMO_CORCH_AAF_INSTALLATION_ID ?? '').trim())
  if (!Number.isSafeInteger(inst) || inst <= 0) return { state: 'partial', signature: 'installation_unset' }
  return { state: 'on', baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, token, installationId: inst }
}
