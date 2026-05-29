/**
 * Webhook auth-gate deep module (Phase 2 of the hub-deepening refactor, C2).
 *
 * One function — `runIntake(c, cfg)` — owns the public-webhook *authentication
 * & audit* pipeline that coolify / sentry / revanote / telegram each repeat
 * inline today:
 *
 *   read raw body BEFORE any JSON parse
 *     → resolve the expected secret (per-user or global)
 *     → constant-time compare the presented credential
 *     → optional HMAC over `${ts}.${rawBody}` (timing-safe)
 *     → optional 5-min skew check
 *     → optional per-owner IP allowlist
 *     → audit the hit (per policy: every-hit, or success-only)
 *     → uniform NON-LEAKY error on any failure
 *
 * The per-webhook *business bodies* (payload Zod schema, dispatch, dedupe,
 * EVENT_ALIAS normalization, photo fetch, …) stay in their route files. Only
 * the auth/audit envelope is captured here, as CONFIG — the differences between
 * the four webhooks are *data*, not *code paths*:
 *
 *   - sentry   : credential is a header (`X-Sentry-Auth` / `?sentry_key=`)
 *                resolved via DB lookup; NO HMAC; NO audit row on auth-fail.
 *   - telegram : single GLOBAL secret; 503 when unset (caller's concern);
 *                NO audit row on auth-fail (table-fill DoS guard).
 *   - coolify  : per-user URL-token; optional IP allowlist; audits every hit.
 *                (Legacy HMAC-header route is a second IntakeConfig.)
 *   - revanote : per-user URL-token + optional `X-Revuu-Signature` HMAC
 *                (enforced WHEN PRESENT); audits every hit.
 *
 * SECURITY INVARIANTS (CLAUDE.md, Invariant-Risk Register IR-3..IR-6):
 *   IR-3  Raw body is read ONCE, before any parse; HMAC is computed over those
 *         exact bytes. A body that parses-equal but byte-differs MUST fail HMAC.
 *   IR-4  All secret/signature comparisons go through `timingSafeEqual`. The
 *         only short-circuit is the standard unequal-length guard (which leaks
 *         only length, never content) — never `===`, never a value-dependent
 *         early return.
 *   IR-5  Audit rows are preview-only (≤500 chars) and NEVER contain the
 *         presented (bad) token/secret. The 100/user cap lives in the DAL.
 *   IR-6  `audit.onAuthFail === false` writes NOTHING on auth failure
 *         (sentry / telegram) — a hostile flood of bad-secret requests must not
 *         fill the audit table.
 *
 * The error returned on ANY auth failure is uniform (`{ error: 'unauthorized' }`,
 * 401) so an attacker cannot distinguish "no such user" from "wrong token" from
 * "bad signature" from "stale timestamp". Callers that need a distinct status
 * for a *non-auth* gate (e.g. coolify's 403 IP rejection, telegram's 503
 * feature-gate) handle that themselves; this module's job is the credential
 * gate, and it speaks one 401 for every credential failure.
 */
import type { Context } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_SKEW_SECONDS = 300
const PREVIEW_MAX = 500

/**
 * Constant-time string compare. Returns false for unequal-length inputs
 * WITHOUT throwing (the length guard leaks only length, which is acceptable —
 * see IR-4). Defined ONCE here; replaces the three copy-pasted
 * `constantTimeEqualStr` functions in coolify / revanote / telegram.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

/**
 * Verify an `sha256=<hex>` HMAC signature over `${ts}.${rawBody}`, computed
 * with `secret`. Constant-time compared. `ts` is the empty string for webhooks
 * that sign the raw body alone (revanote signs `rawBody`, coolify legacy signs
 * `${ts}.${rawBody}`) — callers pass `ts=''` to sign the body only.
 *
 * Computed over the EXACT `rawBody` bytes the caller read before parsing
 * (IR-3). `verifyHmacSig` never parses.
 */
export function verifyHmacSig(secret: string, ts: string, rawBody: string, sig: string): boolean {
  const signedPayload = ts === '' ? rawBody : `${ts}.${rawBody}`
  const expected = 'sha256=' + createHmac('sha256', secret).update(signedPayload).digest('hex')
  return constantTimeEqual(sig, expected)
}

/** One audit row. `record` is the subsystem DAL writer (already capped 100/user). */
export interface AuditRow {
  /** owner the request claimed (URL `:user_id`); null for global-secret webhooks. */
  ownerId: string | null
  sourceIp: string | null
  /** stable status label, e.g. 'auth_failed' | 'hmac_failed' | 'success'. */
  status: string
  /** machine-readable cause, never the presented token. */
  reason: string | null
  /** raw body preview — the module slices to ≤500 chars before handing it over. */
  rawBodyPreview: string | null
}

export interface IntakeConfig {
  /** where the credential comes from (documentation/intent; resolveSecret does the work). */
  credentialSource: 'url-token' | 'url-secret' | 'header'

  /**
   * Resolve the credential the caller PRESENTED and the SECRET we expect, for
   * this request. `presented` is the raw credential the client sent (URL token,
   * URL secret, or header value). `secret` is the expected value (per-user from
   * the DB, or the global config secret). `ownerId` is the user the request
   * claimed (for the audit row + IP allowlist + the success return); null for
   * global-secret webhooks (telegram).
   *
   * If `secret` is null the gate fails closed (webhook not configured), but the
   * compare still runs against a fixed dummy so timing reveals nothing about
   * whether the user/secret exists.
   */
  resolveSecret(c: Context): Promise<{ ownerId: string | null; presented: string; secret: string | null }>

  /** Whether to verify an HMAC signature in addition to the credential compare. */
  verifyHmac: boolean
  /** Header carrying the signature, e.g. 'x-coolify-signature' | 'x-revuu-signature'. */
  hmacHeader?: string
  /**
   * When true, HMAC is enforced ONLY if the header is present (revanote:
   * accept-and-pass when absent, reject when present-but-bad). When false/unset,
   * HMAC is REQUIRED whenever `verifyHmac` is true (coolify legacy: missing
   * header is an auth failure).
   */
  hmacRequiredWhenPresent?: boolean
  /**
   * Header carrying the HMAC timestamp (coolify legacy: 'x-coolify-timestamp').
   * When set, the signed payload is `${ts}.${rawBody}` and the timestamp is
   * skew-checked. When unset, the signature is over `rawBody` alone (revanote).
   */
  hmacTimestampHeader?: string

  /** 5-min skew window for the HMAC timestamp header. Default 300; 0 disables. */
  skewSeconds?: number

  /** Per-owner IP allowlist (coolify only). Returns [] = allow-all. */
  ipAllowlist?: (ownerId: string | null) => Promise<string[]>

  /**
   * Audit policy. `record` is the subsystem DAL writer (already capped
   * 100/user). `onAuthFail` controls whether an auth FAILURE writes a row:
   *   - coolify / revanote → true  (users want to see "wrong token" hits).
   *   - sentry / telegram  → false (table-fill DoS guard, IR-6).
   * A SUCCESS is never audited here — the caller's body owns the success row
   * (it carries the run_id / annotation_id, which this module doesn't have).
   */
  audit?: {
    record(row: AuditRow): Promise<void>
    onAuthFail: boolean
  }
}

export type IntakeResult =
  | { ok: true; ownerId: string | null; rawBody: string }
  | { ok: false; status: 401 | 403 | 503; body: object }

/** Fixed dummy compared against when no secret is configured — keeps timing flat. */
const DUMMY_SECRET = '00000000-0000-0000-0000-000000000000'

/** Uniform credential-failure result. Never reveals which check failed. */
const UNAUTHORIZED: IntakeResult = { ok: false, status: 401, body: { error: 'unauthorized' } }

/**
 * Run the full webhook auth gate. Reads the raw body, verifies the credential
 * (and optional HMAC + skew + IP allowlist), audits per policy, and returns
 * either `{ ok: true, ownerId, rawBody }` for the caller to Zod-parse + dispatch,
 * or a uniform non-leaky failure.
 *
 * IMPORTANT: `runIntake` reads the body via `c.req.text()`. Hono caches the
 * parsed body, so the caller can `JSON.parse(result.rawBody)` directly — and
 * MUST use `result.rawBody`, not re-read `c.req.text()`, to preserve the
 * raw-body-before-parse contract (IR-3).
 */
export async function runIntake(c: Context, cfg: IntakeConfig): Promise<IntakeResult> {
  // (1) Read the raw body ONCE, before any parse (IR-3).
  const rawBody = await c.req.text()
  const preview = rawBody.slice(0, PREVIEW_MAX)

  const sourceIp = sourceIpFromContext(c)

  // Helper that respects the audit-on-auth-fail policy (IR-5/IR-6).
  const auditFail = async (status: string, reason: string, ownerId: string | null) => {
    if (cfg.audit && cfg.audit.onAuthFail) {
      try {
        await cfg.audit.record({ ownerId, sourceIp, status, reason, rawBodyPreview: preview })
      } catch (err: any) {
        console.warn('[webhook-intake] audit log failed:', err?.message)
      }
    }
  }

  // (2) Resolve presented credential + expected secret + owner.
  const { ownerId, presented, secret } = await cfg.resolveSecret(c)

  // (3) Constant-time credential compare. Compare against a fixed dummy when no
  // secret is configured so timing reveals neither "no such user" nor "no
  // secret set" (IR-4).
  const expectedSecret = secret ?? DUMMY_SECRET
  const credentialOk = constantTimeEqual(presented, expectedSecret)
  if (!secret || !credentialOk) {
    await auditFail('auth_failed', secret ? 'token_mismatch' : 'webhook_not_configured', ownerId)
    return UNAUTHORIZED
  }

  // (4) Optional HMAC layer.
  if (cfg.verifyHmac) {
    const sigHeader = cfg.hmacHeader ? c.req.header(cfg.hmacHeader) : undefined

    if (!sigHeader) {
      // Missing header: a failure UNLESS hmacRequiredWhenPresent (revanote
      // accepts unsigned, rejects bad-signed).
      if (!cfg.hmacRequiredWhenPresent) {
        await auditFail('auth_failed', 'missing_signature', ownerId)
        return UNAUTHORIZED
      }
      // else: header absent + optional-when-present → skip HMAC, continue.
    } else {
      // Resolve timestamp (when this webhook signs `${ts}.${rawBody}`).
      let ts = ''
      if (cfg.hmacTimestampHeader) {
        const tsHeader = c.req.header(cfg.hmacTimestampHeader)
        if (!tsHeader) {
          await auditFail('auth_failed', 'missing_signature', ownerId)
          return UNAUTHORIZED
        }
        const tsNum = Number(tsHeader)
        if (!Number.isFinite(tsNum)) {
          await auditFail('auth_failed', 'bad_timestamp', ownerId)
          return UNAUTHORIZED
        }
        // Skew check (IR: 5-min window).
        const skew = cfg.skewSeconds ?? DEFAULT_SKEW_SECONDS
        if (skew > 0) {
          const nowSec = Math.floor(Date.now() / 1000)
          if (Math.abs(nowSec - tsNum) > skew) {
            await auditFail('auth_failed', 'stale_timestamp', ownerId)
            return UNAUTHORIZED
          }
        }
        ts = tsHeader
      }

      if (!verifyHmacSig(secret, ts, rawBody, sigHeader)) {
        await auditFail('hmac_failed', 'bad_signature', ownerId)
        return UNAUTHORIZED
      }
    }
  }

  // (5) Optional IP allowlist (coolify). Distinct 403 status — this is an
  // authorization gate after a VALID credential, not a credential failure, so
  // the non-leaky-uniform-401 rule doesn't apply (the caller proved identity).
  if (cfg.ipAllowlist) {
    const allowedIps = await cfg.ipAllowlist(ownerId)
    if (allowedIps.length > 0 && !ipAllowed(sourceIp, allowedIps)) {
      // Audited as a distinct status so the UI can show "blocked IP" hits.
      if (cfg.audit && cfg.audit.onAuthFail) {
        try {
          await cfg.audit.record({
            ownerId,
            sourceIp,
            status: 'ip_rejected',
            reason: 'source_ip_not_in_allowlist',
            rawBodyPreview: preview,
          })
        } catch (err: any) {
          console.warn('[webhook-intake] audit log failed:', err?.message)
        }
      }
      return { ok: false, status: 403, body: { error: 'ip_not_allowed' } }
    }
  }

  // Authenticated. Caller owns body validate + dispatch + the SUCCESS audit row.
  return { ok: true, ownerId, rawBody }
}

// ── IP source extraction ─────────────────────────────────────────────────────
// Re-exported through the existing cidr helper so the module is the single
// auth surface but doesn't duplicate the parsing.
import { ipAllowed, sourceIpFromHeaders } from '../lib/cidr.ts'

function sourceIpFromContext(c: Context): string | null {
  return sourceIpFromHeaders({ get: (n: string) => c.req.header(n) ?? null })
}
